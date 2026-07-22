"""
CSI Bridge: Connects to RuView sensing server (port 3000), transforms data into a
consistent 'sensing_update' format, and broadcasts to frontend WebSocket clients.

Handles:
  - RuView v1 WebSocket (pose_data messages)
  - RuView v2 WebSocket (HA-style event messages)
  - REST polling fallback
  - RSSI-based position trilateration from multi-node data
"""
import asyncio
import json
import logging
import math
import time
from typing import Dict, List, Optional, Set

try:
    import aiohttp
    HAS_AIOHTTP = True
except ImportError:
    HAS_AIOHTTP = False

try:
    import websockets
    HAS_WEBSOCKETS = True
except ImportError:
    HAS_WEBSOCKETS = False

logger = logging.getLogger(__name__)

# Default physical positions of each node in the room (meters, X-Z plane).
# Edit these to match where your ESP32 nodes are actually mounted.
# Room is assumed to be roughly 10x10m; origin is center. X=left/right, Z=front/back.
NODE_POSITIONS: Dict[int, tuple] = {
    1: (-4.0, -4.0),   # node_id 1: left-back corner
    2: (4.0, -4.0),    # node_id 2: right-back corner
    3: (0.0, 4.0),     # node_id 3: front-center wall
}

# RSSI at 1 meter reference distance and path-loss exponent
TX_POWER_DBM = -40   # measured reference RSSI at 1 m for typical indoor ESP32
PATH_LOSS_N = 3.0    # indoor path-loss exponent (free-space=2, walled room≈3-4)


def rssi_to_distance(rssi: float) -> float:
    """Estimate distance in meters from RSSI using log-distance path loss model."""
    d = 10 ** ((TX_POWER_DBM - rssi) / (10 * PATH_LOSS_N))
    return max(0.3, min(12.0, d))


def trilaterate(distances: Dict[int, float]) -> list:
    """
    Estimate 2D room position [x, z] from per-node distances.
    Uses weighted centroid when <3 nodes; least-squares circle intersection otherwise.
    """
    known = [(NODE_POSITIONS[nid], d) for nid, d in distances.items() if nid in NODE_POSITIONS]
    if not known:
        return [0.0, 0.0]

    if len(known) == 1:
        (nx, nz), _ = known[0]
        return [nx * 0.5, nz * 0.5]

    # Two-circle intersection (pick point between the nodes)
    if len(known) == 2:
        (x1, z1), d1 = known[0]
        (x2, z2), d2 = known[1]
        dx, dz = x2 - x1, z2 - z1
        dist = math.sqrt(dx * dx + dz * dz) or 0.001
        a = (d1 * d1 - d2 * d2 + dist * dist) / (2 * dist)
        h_sq = max(0, d1 * d1 - a * a)
        h = math.sqrt(h_sq)
        mx, mz = x1 + a * dx / dist, z1 + a * dz / dist
        # Two intersection candidates — pick the one closer to center
        p1 = (mx + h * dz / dist, mz - h * dx / dist)
        p2 = (mx - h * dz / dist, mz + h * dx / dist)
        if p1[0] ** 2 + p1[1] ** 2 < p2[0] ** 2 + p2[1] ** 2:
            return [max(-4.5, min(4.5, p1[0])), max(-4.5, min(4.5, p1[1]))]
        return [max(-4.5, min(4.5, p2[0])), max(-4.5, min(4.5, p2[1]))]

    # 3+ nodes: weighted centroid (closer nodes get higher weight)
    total_w, wx, wz = 0.0, 0.0, 0.0
    for (nx, nz), d in known:
        w = 1.0 / max(d, 0.1)
        wx += nx * w
        wz += nz * w
        total_w += w
    return [max(-4.5, min(4.5, wx / total_w)), max(-4.5, min(4.5, wz / total_w))]


class NodeState:
    def __init__(self, node_id: int):
        self.node_id = node_id
        self.rssi: float = -100
        self.presence: bool = False
        self.breathing_rate: float = 0.0
        self.heart_rate: float = 0.0
        self.motion_energy: float = 0.0
        self.motion_present: bool = False     # CSI channel-disturbance gate (hysteresis)
        self.std_baseline: float = 0.0        # adaptive empty-room per-subcarrier-std floor
        self.person_count: int = 0
        self.presence_score: float = 0.0
        self.last_update: float = 0.0
        self.vitals_last_valid: float = 0.0   # time of last vitals packet (CSI defers while fresh)
        self.last_occupied_ts: float = 0.0    # last time occupancy evidence was seen

    @property
    def is_active(self) -> bool:
        return time.time() - self.last_update < 10.0

    @property
    def vitals_are_fresh(self) -> bool:
        return time.time() - self.vitals_last_valid < 10.0

    def to_dict(self) -> dict:
        return {
            "node_id": self.node_id,
            "id": self.node_id,
            "status": "active" if self.is_active else "inactive",
            "rssi": self.rssi,
            "presence": self.presence,
        }


class CSIBridge:
    def __init__(self):
        self.clients: Set = set()
        self.nodes: Dict[int, NodeState] = {}
        self.running = False
        self._latest: dict = self._empty_state()
        self._pos_ema: Dict[str, list] = {}
        self._smoothed_br: float = 0.0
        self._smoothed_hr: float = 0.0
        self._last_csi_broadcast: float = 0.0
        # Local recording state (used when RuView server is unavailable)
        self._recording_scenario: Optional[str] = None
        self._recording_snapshots: List[dict] = []
        _POS_ALPHA = 0.07

    def start_local_recording(self, scenario_id: str):
        self._recording_scenario = scenario_id
        self._recording_snapshots = []
        print(f"[RECORD] Local recording started: {scenario_id}")

    def stop_local_recording(self) -> dict:
        count = len(self._recording_snapshots)
        scenario = self._recording_scenario
        # Auto-tune presence threshold from empty-room baseline
        if scenario == "empty" and count > 0:
            brs = [s["breathing"] for s in self._recording_snapshots if s["breathing"] > 0]
            self._empty_room_br_mean = sum(brs) / len(brs) if brs else 0.0
            print(f"[RECORD] Empty-room baseline: {self._empty_room_br_mean:.2f} BPM breathing avg "
                  f"(should be ~0 if truly empty)")
        self._recording_scenario = None
        print(f"[RECORD] Stopped recording '{scenario}': {count} snapshots saved")
        return {"scenario": scenario, "snapshots": count}

    def _empty_state(self) -> dict:
        return {
            "type": "sensing_update",
            "persons": [],
            "vital_signs": {"breathing_rate": 0.0, "heart_rate": 0.0},
            "classification": {"motion_level": 0.0, "is_occupied": False},
            "nodes": [],
        }

    # ------------------------------------------------------------------ clients

    async def add_client(self, websocket) -> None:
        self.clients.add(websocket)
        try:
            await websocket.send_json(self._latest)
        except Exception:
            self.clients.discard(websocket)

    async def remove_client(self, websocket) -> None:
        self.clients.discard(websocket)

    async def _broadcast(self, message: dict) -> None:
        self._latest = message
        dead: Set = set()
        for ws in list(self.clients):
            try:
                await ws.send_json(message)
            except Exception:
                dead.add(ws)
        self.clients -= dead

    # ------------------------------------------- state getters (for REST endpoints)

    def get_latest(self) -> dict:
        return self._latest

    def get_nodes(self) -> list:
        return [n.to_dict() for n in self.nodes.values()]

    # ---------------------------------------------- sensing_update construction

    _POS_ALPHA = 0.15   # EMA alpha for position — 0.07 was ~2.7s lag at 5 Hz

    def _smooth_position(self, pid: str, raw: list) -> list:
        """Exponential moving average on position — absorbs RSSI noise."""
        if pid not in self._pos_ema:
            self._pos_ema[pid] = raw[:]
            return raw
        ema = self._pos_ema[pid]
        a = self._POS_ALPHA
        smoothed = [ema[i] * (1 - a) + raw[i] * a for i in range(3)]
        self._pos_ema[pid] = smoothed
        return smoothed

    @staticmethod
    def _valid_vitals(breathing: float, heart: float):
        """Drop values outside physiological range — returns (br, hr)."""
        br = round(breathing, 1) if 5.0 <= breathing <= 35.0 else 0.0
        hr = round(heart, 1)     if 35.0 <= heart <= 160.0   else 0.0
        return br, hr

    _VITALS_EMA = 0.25  # higher = faster response to new readings

    def _build_sensing_update(self) -> dict:
        active = {nid: n for nid, n in self.nodes.items() if n.is_active}
        is_present = any(n.presence for n in active.values())

        present_nodes = [n for n in active.values() if n.presence]
        if present_nodes:
            # Only include per-node vitals that are already physiologically plausible
            # before averaging — this excludes garbage readings from distant nodes.
            plausible_brs = [n.breathing_rate for n in present_nodes if 5  <= n.breathing_rate <= 35]
            plausible_hrs = [n.heart_rate     for n in present_nodes if 35 <= n.heart_rate     <= 160]
            raw_br = sum(plausible_brs) / len(plausible_brs) if plausible_brs else 0.0
            raw_hr = sum(plausible_hrs) / len(plausible_hrs) if plausible_hrs else 0.0
            motion = max(n.motion_energy  for n in present_nodes)
            confidence = sum(n.presence_score for n in present_nodes) / len(present_nodes)
        else:
            raw_br = raw_hr = motion = confidence = 0.0

        breathing, heart = self._valid_vitals(raw_br, raw_hr)

        # EMA smoothing: update when present + valid reading.
        # When present but one metric is temporarily invalid (brief noise spike),
        # HOLD the existing smoothed value rather than resetting to 0 — resetting
        # causes the EMA to ramp from zero on the next good packet, producing
        # the "wildly inaccurate" swings the user observed.
        # Only zero out when presence itself is lost (person left room).
        a = self._VITALS_EMA
        if is_present:
            if breathing > 0:
                if self._smoothed_br > 0:
                    self._smoothed_br = self._smoothed_br * (1 - a) + breathing * a
                else:
                    self._smoothed_br = breathing  # seed instantly on first valid reading
            # else: hold existing — transient dropout, person still present
            if heart > 0:
                if self._smoothed_hr > 0:
                    self._smoothed_hr = self._smoothed_hr * (1 - a) + heart * a
                else:
                    self._smoothed_hr = heart  # seed instantly
            # else: hold existing
        else:
            self._smoothed_br = 0.0
            self._smoothed_hr = 0.0

        breathing = round(self._smoothed_br, 1) if self._smoothed_br > 0 else 0.0
        heart     = round(self._smoothed_hr, 1) if self._smoothed_hr > 0 else 0.0

        persons = []
        if is_present:
            distances = {nid: rssi_to_distance(n.rssi) for nid, n in active.items()}
            raw_xz = trilaterate(distances)
            raw_pos = [raw_xz[0], 0.5, raw_xz[1]]
            pos = self._smooth_position("person_0", raw_pos)
            persons = [{
                "id": "person_0",
                "position": [round(pos[0], 3), 0.5, round(pos[2], 3)],
                "motion_score": round(motion, 3),
                "breathing_rate": breathing,
                "heart_rate": heart,
                "confidence": round(confidence, 2),
                "keypoints": [],
            }]
        else:
            # Reset EMA when room is empty so it starts fresh on re-entry
            self._pos_ema.pop("person_0", None)

        return {
            "type": "sensing_update",
            "persons": persons,
            "vital_signs": {"breathing_rate": breathing, "heart_rate": heart},
            "classification": {"motion_level": round(motion, 3), "is_occupied": is_present},
            "nodes": [n.to_dict() for n in active.values()],
        }

    # ----------------------------------------------- message parsers

    def _parse_pose_data(self, payload: dict) -> Optional[dict]:
        """Handle RuView v1 pose_data WebSocket messages."""
        data = payload.get("data", {})
        persons_raw = data.get("persons", [])

        breathing_rates, heart_rates = [], []
        persons = []
        for i, p in enumerate(persons_raw):
            br = p.get("vital_signs", {}).get("breathing_rate", 0)
            hr = p.get("vital_signs", {}).get("heart_rate", 0)
            if br > 0:
                breathing_rates.append(br)
            if hr > 0:
                heart_rates.append(hr)

            vx = p.get("activity", {}).get("velocity", {}).get("x", 0)
            vy = p.get("activity", {}).get("velocity", {}).get("y", 0)
            motion_score = math.sqrt(vx ** 2 + vy ** 2)

            persons.append({
                "id": p.get("person_id", p.get("track_id", f"person_{i}")),
                "position": self._extract_position_v1(p),
                "motion_score": motion_score,
                "breathing_rate": br,
                "heart_rate": hr,
                "confidence": p.get("confidence", 0.5),
                "keypoints": p.get("keypoints", []),
            })

        br_avg = sum(breathing_rates) / len(breathing_rates) if breathing_rates else 0
        hr_avg = sum(heart_rates) / len(heart_rates) if heart_rates else 0

        return {
            "type": "sensing_update",
            "persons": persons,
            "vital_signs": {"breathing_rate": br_avg, "heart_rate": hr_avg},
            "classification": {
                "motion_level": data.get("motion_level", 0),
                "is_occupied": len(persons) > 0,
            },
            "nodes": self.get_nodes(),
        }

    def _parse_ha_event(self, payload: dict) -> Optional[dict]:
        """Handle RuView v2 Home Assistant-style event messages."""
        event = payload.get("event", {})
        event_type = event.get("event_type", "")
        data = event.get("data", {})
        if event_type != "state_changed" or not data:
            return None

        entity_id = data.get("entity_id", "")
        new_state = data.get("new_state", {})
        if not new_state:
            return None

        state_str = new_state.get("state", "")
        current = dict(self._latest)

        def to_float(s):
            try:
                return float(s)
            except (ValueError, TypeError):
                return 0.0

        if any(k in entity_id for k in ("presence", "occupancy")):
            is_occ = state_str.lower() in ("on", "occupied", "true", "home", "1")
            current["classification"]["is_occupied"] = is_occ
            if not is_occ:
                current["persons"] = []
        elif "breathing" in entity_id:
            br = to_float(state_str)
            current["vital_signs"]["breathing_rate"] = br
            if current["persons"]:
                current["persons"][0]["breathing_rate"] = br
        elif "heart" in entity_id:
            hr = to_float(state_str)
            current["vital_signs"]["heart_rate"] = hr
            if current["persons"]:
                current["persons"][0]["heart_rate"] = hr
        elif "motion" in entity_id:
            ml = to_float(state_str)
            current["classification"]["motion_level"] = ml
            if current["persons"]:
                current["persons"][0]["motion_score"] = ml
            elif current["classification"]["is_occupied"]:
                current["persons"] = [{
                    "id": "person_0",
                    "position": [0, 0.5, 0],
                    "motion_score": ml,
                    "confidence": 0.5,
                    "breathing_rate": current["vital_signs"]["breathing_rate"],
                    "heart_rate": current["vital_signs"]["heart_rate"],
                    "keypoints": [],
                }]

        return current

    @staticmethod
    def _extract_position_v1(person: dict) -> list:
        """Extract [x, y, z] position from a v1 person dict."""
        pos = person.get("position", {})
        if pos:
            return [pos.get("x", 0), 0.5, pos.get("z", pos.get("y", 0))]

        kps = person.get("keypoints", [])
        if kps:
            lh = next((k for k in kps if k.get("name") == "left_hip"), None)
            rh = next((k for k in kps if k.get("name") == "right_hip"), None)
            if lh and rh:
                return [(lh["x"] + rh["x"]) / 2 * 8 - 4, 0.5, (lh["y"] + rh["y"]) / 2 * 8 - 4]
            visible = [k for k in kps if k.get("visible", True) and k.get("confidence", 1) > 0.3]
            if visible:
                ax = sum(k["x"] for k in visible) / len(visible)
                az = sum(k["y"] for k in visible) / len(visible)
                return [ax * 8 - 4, 0.5, az * 8 - 4]

        bb = person.get("bounding_box", {})
        if bb:
            return [
                (bb.get("x", 0) + bb.get("width", 0) / 2) * 8 - 4,
                0.5,
                (bb.get("y", 0) + bb.get("height", 0) / 2) * 8 - 4,
            ]

        return [0.0, 0.5, 0.0]

    # ----------------------------------------------------- async run loop

    async def start(self):
        self.running = True
        asyncio.create_task(self._run_loop())

    def stop(self):
        self.running = False

    async def _run_loop(self):
        while self.running:
            connected = False
            if HAS_WEBSOCKETS:
                try:
                    connected = await self._connect_ruview_ws()
                except Exception as e:
                    logger.debug(f"RuView WS error: {e}")

            if not connected and HAS_AIOHTTP:
                try:
                    await self._poll_ruview_rest()
                except Exception as e:
                    logger.debug(f"RuView REST poll error: {e}")

            await asyncio.sleep(3)

    async def _connect_ruview_ws(self) -> bool:
        """Connect to RuView WebSocket; return True if we successfully consumed messages."""
        urls_to_try = [
            "ws://localhost:3000/ws/sensing",
            "ws://localhost:3000/api/websocket",
        ]
        for url in urls_to_try:
            try:
                async with websockets.connect(url, open_timeout=2) as ws:
                    logger.info(f"Connected to RuView at {url}")
                    async for raw in ws:
                        try:
                            payload = json.loads(raw)
                            msg_type = payload.get("type", "")
                            result = None
                            if msg_type == "sensing_update":
                                result = payload
                            elif msg_type == "pose_data":
                                result = self._parse_pose_data(payload)
                            elif msg_type == "event":
                                result = self._parse_ha_event(payload)
                            if result:
                                await self._broadcast(result)
                        except Exception as e:
                            logger.debug(f"WS parse error: {e}")
                    return True
            except Exception:
                continue
        return False

    async def _poll_ruview_rest(self):
        """REST fallback: poll every second until WS is available."""
        sensing_urls = [
            "http://localhost:3000/api/v1/pose/latest",
            "http://localhost:3000/api/v1/sensing/latest",
            "http://localhost:3000/current",
        ]
        nodes_urls = [
            "http://localhost:3000/api/v1/nodes",
            "http://localhost:3000/api/v1/system/status",
        ]
        timeout = aiohttp.ClientTimeout(total=2)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            polls = 0
            while self.running and polls < 5:
                polls += 1
                for url in sensing_urls:
                    try:
                        async with session.get(url) as r:
                            if r.status == 200:
                                data = await r.json()
                                msg = self._transform_rest_response(data)
                                if msg:
                                    await self._broadcast(msg)
                                break
                    except Exception:
                        continue

                if polls == 1:
                    for url in nodes_urls:
                        try:
                            async with session.get(url) as r:
                                if r.status == 200:
                                    raw = await r.json()
                                    nodes = raw if isinstance(raw, list) else raw.get("nodes", [])
                                    # Merge into our node state
                                    for n in nodes:
                                        nid = n.get("node_id", n.get("id", 0))
                                        if nid not in self.nodes:
                                            self.nodes[nid] = NodeState(nid)
                                        self.nodes[nid].rssi = n.get("rssi", -80)
                                        self.nodes[nid].presence = n.get("status") == "active"
                                        self.nodes[nid].last_update = time.time()
                                    break
                        except Exception:
                            continue

                await asyncio.sleep(1)

    def _transform_rest_response(self, data: dict) -> Optional[dict]:
        """Transform a RuView REST response to sensing_update format."""
        persons = []
        br, hr, ml = 0.0, 0.0, 0.0

        if "persons" in data:
            for i, p in enumerate(data["persons"]):
                persons.append({
                    "id": p.get("person_id", f"person_{i}"),
                    "position": self._extract_position_v1(p),
                    "motion_score": 0.0,
                    "confidence": p.get("confidence", 0.5),
                    "breathing_rate": 0.0,
                    "heart_rate": 0.0,
                    "keypoints": p.get("keypoints", []),
                })
        elif "isOccupied" in data or "is_occupied" in data:
            is_occ = data.get("isOccupied", data.get("is_occupied", False))
            ml = data.get("motionLevel", data.get("motion_level", 0.0))
            br = data.get("breathingRate", data.get("breathing_rate", 0.0))
            hr = data.get("heartRate", data.get("heart_rate", 0.0))
            if is_occ:
                persons = [{
                    "id": "person_0",
                    "position": [0, 0.5, 0],
                    "motion_score": ml,
                    "confidence": 0.5,
                    "breathing_rate": br,
                    "heart_rate": hr,
                    "keypoints": [],
                }]
        else:
            return None

        return {
            "type": "sensing_update",
            "persons": persons,
            "vital_signs": {"breathing_rate": br, "heart_rate": hr},
            "classification": {"motion_level": ml, "is_occupied": len(persons) > 0},
            "nodes": self.get_nodes(),
        }

    # --------------------------------------------- direct UDP from firmware

    # Per-node ring buffers for raw CSI amplitude history (presence detection)
    _csi_buffers: Dict[int, list] = {}
    _CSI_BUFFER_SIZE = 60        # frames to keep (~3 s at 20 Hz)
    _PRESENCE_BASELINE_K = 2.0   # present when metric exceeds (node baseline × K)
    _PRESENCE_ABS_FLOOR = 0.12   # absolute minimum metric to call present (guards collapsed baseline)
    _PRESENCE_HYSTERESIS = 4     # consecutive frames to confirm a presence state change

    async def start_udp_receiver(self, port: int = 5005):
        """Listen for UDP packets from ESP32 firmware on the given port."""
        loop = asyncio.get_running_loop()

        class Protocol(asyncio.DatagramProtocol):
            def __init__(self, bridge):
                self.bridge = bridge

            def datagram_received(self, data, addr):
                loop.create_task(self.bridge._handle_udp(data, addr))

        try:
            await loop.create_datagram_endpoint(
                lambda: Protocol(self),
                local_addr=("0.0.0.0", port),
            )
            print(f"[CSI] UDP receiver listening on port {port}")
        except Exception as e:
            print(f"[CSI] Could not start UDP receiver on port {port}: {e}")

    async def _handle_udp(self, data: bytes, addr):
        """Parse a binary UDP packet from the ESP32 firmware (little-endian)."""
        import struct
        if len(data) < 4:
            return

        # ESP32 is little-endian — magic stored as 0xC5110001 LE = bytes 01 00 11 C5
        magic = struct.unpack_from("<I", data, 0)[0]

        MAGIC_CSI_FRAME = 0xC5110001   # raw CSI IQ data
        MAGIC_VITALS    = 0xC5110002   # processed vitals (edge-tier 2)
        MAGIC_FEATURE   = 0xC5110003   # feature vector (edge-tier 1+)

        if magic == MAGIC_CSI_FRAME:
            await self._handle_csi_frame(data, addr)
        elif magic == MAGIC_VITALS and len(data) >= 32:
            await self._handle_vitals_packet(data, addr)
        elif magic == MAGIC_FEATURE:
            await self._handle_feature_vector(data, addr)

    async def _handle_csi_frame(self, data: bytes, addr):
        """
        Raw CSI frame (magic 0xC5110001).
        Header: magic(4) node_id(1) antennas(1) subcarriers(2 LE)
                freq(4 LE) seq(4 LE) rssi(1 signed) noise(1) ppdu(2)  = 20 bytes
        Body:   IQ pairs as int8, 2 bytes per subcarrier per antenna
        """
        import struct
        if len(data) < 22:
            return
        try:
            node_id       = struct.unpack_from("B",  data,  4)[0]
            num_antennas  = struct.unpack_from("B",  data,  5)[0] or 1
            num_sub       = struct.unpack_from("<H", data,  6)[0]
            rssi          = struct.unpack_from("b",  data, 16)[0]   # signed dBm

            iq_bytes = data[20:]
            n_samples = min(len(iq_bytes) // 2, num_sub * num_antennas)

            # Per-subcarrier amplitude for THIS frame
            amps = []
            for i in range(n_samples):
                I = struct.unpack_from("b", iq_bytes, i * 2)[0]
                Q = struct.unpack_from("b", iq_bytes, i * 2 + 1)[0]
                amps.append(math.sqrt(I * I + Q * Q))

            if not amps:
                return

            # Normalize the frame by its own mean amplitude. ESP32 AGC rescales
            # the whole frame packet-to-packet for reasons unrelated to people;
            # dividing by the frame mean removes that gain noise and leaves the
            # SHAPE of the channel across subcarriers — which is what a body
            # perturbs. (The old code tracked the cross-subcarrier MEAN, which
            # averaged the signal away and measured only AGC noise.)
            fmean = sum(amps) / len(amps)
            if fmean <= 0:
                return
            norm = [a / fmean for a in amps]

            # Buffer normalized per-subcarrier vectors per node
            buf = self._csi_buffers.setdefault(node_id, [])
            buf.append(norm)
            if len(buf) > self._CSI_BUFFER_SIZE:
                buf.pop(0)

            if len(buf) < 10:
                return

            # Use only buffered frames matching the current subcarrier count so
            # channel hops / rate changes don't corrupt the per-subcarrier stats.
            L = len(norm)
            frames = [f for f in buf if len(f) == L]
            if len(frames) < 10:
                return

            # Per-subcarrier temporal std over the window, then take the 90th
            # percentile across subcarriers — the subcarriers that respond most
            # to motion/breathing. Empty room: all subcarriers stable -> low.
            m = len(frames)
            per_sc_std = []
            for k in range(L):
                col_mean = sum(frames[j][k] for j in range(m)) / m
                col_var = sum((frames[j][k] - col_mean) ** 2 for j in range(m)) / m
                per_sc_std.append(math.sqrt(col_var))
            per_sc_std.sort()
            metric = per_sc_std[int(0.9 * (L - 1))]

            if node_id not in self.nodes:
                self.nodes[node_id] = NodeState(node_id)
            n = self.nodes[node_id]

            # Per-node adaptive empty-room baseline. Falls FAST and rises SLOW so
            # it settles on each node's own quiet floor and isn't inflated by a
            # present person; after a person leaves it re-settles within ~1-2 s.
            if n.std_baseline <= 0:
                n.std_baseline = metric
            elif metric < n.std_baseline:
                n.std_baseline += 0.10 * (metric - n.std_baseline)   # fall fast
            else:
                n.std_baseline += 0.002 * (metric - n.std_baseline)  # rise slow

            # Present when the channel rises well above THIS node's floor AND
            # above an absolute minimum (backstop if the baseline collapses).
            thresh = max(n.std_baseline * self._PRESENCE_BASELINE_K, self._PRESENCE_ABS_FLOOR)
            is_present = metric > thresh
            motion_energy = min(metric / max(thresh, 1e-3), 3.0)

            n.rssi = float(rssi)
            n.motion_energy = motion_energy
            n.last_update = time.time()

            # Rate-limited diagnostic so we can see metric vs the adaptive floor.
            now_log = time.time()
            if now_log - getattr(self, '_last_presence_log', 0.0) >= 2.0:
                self._last_presence_log = now_log
                print(f"[CSI] node={node_id} sc={L} p90={metric:.4f} "
                      f"baseline={n.std_baseline:.4f} thresh={thresh:.4f} present={is_present}")

            # ALWAYS track whether the channel is disturbed (motion), with
            # hysteresis. This is the gate the vitals handler uses to clear
            # presence on an empty room — so it must update even while the
            # firmware is streaming vitals packets.
            if not hasattr(n, '_motion_streak'):
                n._motion_streak = 0
            if is_present == n.motion_present:
                n._motion_streak = 0
            else:
                n._motion_streak += 1
                if n._motion_streak >= self._PRESENCE_HYSTERESIS:
                    n.motion_present = is_present
                    n._motion_streak = 0

            # CSI motion is the SOLE source of presence. The firmware presence
            # flag and firmware vitals are unreliable here (proven: they read
            # the same whether the room is occupied or empty), so they do NOT
            # influence presence.
            n.presence = n.motion_present
            n.presence_score = (min(metric / (thresh * 2), 1.0)
                                if n.motion_present else 0.0)

            # Rate-limit CSI frame broadcasts to 5 Hz — vitals packets
            # broadcast immediately and are the authoritative source.
            now = time.time()
            if now - self._last_csi_broadcast >= 0.2:
                self._last_csi_broadcast = now
                msg = self._build_sensing_update()
                await self._broadcast(msg)

        except Exception as e:
            logger.debug(f"CSI frame parse error: {e}")

    async def _handle_vitals_packet(self, data: bytes, addr):
        """
        Processed vitals packet (magic 0xC5110002, 32 bytes).
        Actual firmware struct edge_vitals_pkt_t (edge_processing.h):
          [0-3]   magic            uint32 LE  = 0xC5110002
          [4]     node_id          uint8
          [5]     flags            uint8   bit0=presence, bit1=fall, bit2=motion
          [6-7]   breathing_rate   uint16 LE  = BPM × 100
          [8-11]  heartrate        uint32 LE  = BPM × 10000
          [12]    rssi             int8   (dBm)
          [13]    n_persons        uint8
          [14-15] reserved[2]
          [16-19] motion_energy    float32
          [20-23] presence_score   float32
          [24-27] timestamp_ms     uint32 LE
          [28-31] reserved2        uint32
        """
        import struct
        if len(data) < 24:
            return
        try:
            node_id       = struct.unpack_from("B",  data,  4)[0]
            flags         = struct.unpack_from("B",  data,  5)[0]
            breathing_raw = struct.unpack_from("<H", data,  6)[0]
            heart_raw     = struct.unpack_from("<I", data,  8)[0]
            rssi          = struct.unpack_from("b",  data, 12)[0]   # signed dBm

            breathing = breathing_raw / 100.0    # BPM
            heart     = heart_raw     / 10000.0  # BPM

            # Ensure node state exists before reading from it
            if node_id not in self.nodes:
                self.nodes[node_id] = NodeState(node_id)
            n = self.nodes[node_id]

            # Presence is owned ENTIRELY by the CSI motion detector — NOT here.
            # The firmware presence flag and these vitals are unreliable (they
            # read the same empty or occupied), so this handler only carries the
            # breathing/heart values forward for display while CSI says present.
            now = time.time()
            if self._recording_scenario:
                self._recording_snapshots.append({
                    "t": now, "scenario": self._recording_scenario,
                    "node_id": node_id, "breathing": breathing,
                    "heart": heart, "rssi": rssi,
                })
            n.rssi           = float(rssi)
            n.breathing_rate = breathing
            n.heart_rate     = heart
            n.last_update    = now

            msg = self._build_sensing_update()
            await self._broadcast(msg)
        except Exception as e:
            print(f"[VITALS] parse error: {e}")

    async def _handle_feature_vector(self, data: bytes, addr):
        """
        Feature vector packet (magic 0xC5110003, 48 bytes).
        Actual firmware struct edge_feature_pkt_t (edge_processing.h):
          [0-3]   magic          uint32 LE = 0xC5110003
          [4]     node_id        uint8
          [5]     reserved       uint8
          [6-7]   seq            uint16 LE
          [8-15]  timestamp_us   int64 LE
          [16-47] features[8]    float32 LE × 8  (all normalized 0.0-1.0)
        Feature dims:
          [0] presence_score  (raw score / 10, clamped 0-1)
          [1] motion_energy   (/ 10, clamped 0-1)
          [2] breathing_rate  (BPM / 30)
          [3] heart_rate      (BPM / 120)
          [4] phase_variance  (Welford mean over top-K subcarriers)
          [5] person_count    (n_persons / 4)
          [6] fall_detected   (0.0 or 1.0)
          [7] rssi_norm       ((rssi + 100) / 100)
        """
        import struct
        if len(data) < 48:
            return
        try:
            node_id  = struct.unpack_from("B", data, 4)[0]
            features = struct.unpack_from("<8f", data, 16)

            presence_score = features[0]
            motion_norm    = features[1]
            # features[2]=breathing/30, [3]=heart/120 — vitals owned by 0xC5110002
            # features[4]=phase_variance, [6]=fall_detected — not used here
            person_count   = int(round(features[5] * 4.0))
            rssi_norm      = features[7]   # (rssi + 100) / 100

            if node_id not in self.nodes:
                self.nodes[node_id] = NodeState(node_id)
            n = self.nodes[node_id]

            n.rssi           = rssi_norm * 100 - 100
            n.presence_score = presence_score
            n.motion_energy  = motion_norm
            n.person_count   = person_count
            # Breathing/heart are owned by the 0xC5110002 vitals packet (full
            # precision, sent at the same 1 Hz cadence). The feature vector's
            # quantised breathing_norm/heart_norm are redundant — don't set them.
            n.last_update    = time.time()

            msg = self._build_sensing_update()
            await self._broadcast(msg)
        except Exception as e:
            logger.debug(f"Feature vector parse error: {e}")


bridge = CSIBridge()
