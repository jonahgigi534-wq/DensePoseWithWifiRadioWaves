import { useState, useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Simple 1D Kalman filter for smoothing noisy position values
// ---------------------------------------------------------------------------
class KalmanFilter {
  constructor(R = 2.0, Q = 0.05) {
    this.R = R; // measurement noise (higher = trust measurements less)
    this.Q = Q; // process noise  (higher = allow faster change)
    this.P = 1;
    this.x = null;
  }
  update(z) {
    if (this.x === null) { this.x = z; return z; }
    this.P += this.Q;
    const K = this.P / (this.P + this.R);
    this.x += K * (z - this.x);
    this.P = (1 - K) * this.P;
    return this.x;
  }
  reset() { this.x = null; this.P = 1; }
}

// Per-person position filters (3 axes)
const personFilters = {};
function getFilters(id) {
  if (!personFilters[id]) {
    personFilters[id] = [new KalmanFilter(), new KalmanFilter(), new KalmanFilter()];
  }
  return personFilters[id];
}

function smoothPerson(person) {
  const id = person.id ?? 'default';
  const [fx, fy, fz] = getFilters(id);
  const pos = person.position ?? [0, 0.5, 0];
  return {
    ...person,
    position: [fx.update(pos[0]), fy.update(pos[1] ?? 0.5), fz.update(pos[2])],
  };
}

// ---------------------------------------------------------------------------
// Parse whatever the bridge sends into a consistent shape
// ---------------------------------------------------------------------------
function parseSensingUpdate(payload) {
  // Already in our expected format
  if (payload.type === 'sensing_update') {
    const persons = (payload.persons || []).map(smoothPerson);
    return {
      isOccupied: persons.length > 0 || payload.classification?.is_occupied,
      motionLevel: payload.classification?.motion_level ?? 0,
      breathingRate: payload.vital_signs?.breathing_rate ?? 0,
      heartRate: payload.vital_signs?.heart_rate ?? 0,
      people: persons,
    };
  }

  // RuView v1 format: pose_data
  if (payload.type === 'pose_data') {
    const data = payload.data ?? {};
    const persons = (data.persons ?? []).map((p, i) => {
      const pos = extractPositionV1(p);
      return smoothPerson({
        id: p.person_id ?? p.track_id ?? `person_${i}`,
        position: pos,
        motion_score: computeMotion(p),
        breathing_rate: p.vital_signs?.breathing_rate ?? 0,
        heart_rate: p.vital_signs?.heart_rate ?? 0,
        confidence: p.confidence ?? 0.5,
        keypoints: p.keypoints ?? [],
      });
    });
    return {
      isOccupied: persons.length > 0,
      motionLevel: data.motion_level ?? 0,
      breathingRate: persons[0]?.breathing_rate ?? 0,
      heartRate: persons[0]?.heart_rate ?? 0,
      people: persons,
    };
  }

  return null;
}

function extractPositionV1(person) {
  if (person.position) {
    const { x = 0, y = 0, z } = person.position;
    return [x, 0.5, z ?? y];
  }
  const kps = person.keypoints ?? [];
  const lh = kps.find(k => k.name === 'left_hip');
  const rh = kps.find(k => k.name === 'right_hip');
  if (lh && rh) {
    return [(lh.x + rh.x) / 2 * 8 - 4, 0.5, (lh.y + rh.y) / 2 * 8 - 4];
  }
  const vis = kps.filter(k => (k.confidence ?? 1) > 0.3);
  if (vis.length > 0) {
    const ax = vis.reduce((s, k) => s + k.x, 0) / vis.length;
    const az = vis.reduce((s, k) => s + k.y, 0) / vis.length;
    return [ax * 8 - 4, 0.5, az * 8 - 4];
  }
  const bb = person.bounding_box;
  if (bb) {
    return [(bb.x + bb.width / 2) * 8 - 4, 0.5, (bb.y + bb.height / 2) * 8 - 4];
  }
  return [0, 0.5, 0];
}

function computeMotion(person) {
  const vel = person.activity?.velocity;
  if (vel) return Math.sqrt((vel.x ?? 0) ** 2 + (vel.y ?? 0) ** 2);
  return 0;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
const RECONNECT_MS = 3000;
const VITALS_HOLD_MS = 1000;   // 4000 → 1000: backend EMA already smooths; don't lag
const PRESENCE_HOLD_MS = 800;  // 2000 → 800: tighter — clears person faster on exit

export function useRuView() {
  const [data, setData] = useState({
    isOccupied: false,
    motionLevel: 0,
    breathingRate: 0,
    heartRate: 0,
    people: [],
    connected: false,
  });
  const [nodes, setNodes] = useState([]);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  // Last-known-good store so transient zeroes don't flash the UI
  const lkg = useRef({
    breathingRate: 0, breathingAt: 0,
    heartRate: 0,     heartAt: 0,
    people: [],       occupiedAt: 0,
  });

  useEffect(() => {
    let mounted = true;

    // Fetch node list
    const fetchNodes = () => {
      fetch('/api/v1/nodes')
        .then(r => r.json())
        .then(d => {
          if (!mounted) return;
          const arr = Array.isArray(d) ? d : (d.nodes ?? []);
          setNodes(arr.map(n => ({ ...n, id: n.node_id ?? n.id })));
        })
        .catch(() => {});
    };
    fetchNodes();
    const nodesInterval = setInterval(fetchNodes, 5000);

    // WebSocket (connects to our backend port 4000 via Vite proxy)
    function connect() {
      if (!mounted) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws/sensing`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mounted) return;
        setData(prev => ({ ...prev, connected: true }));
        // heartbeat
        ws._ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, 20000);
      };

      ws.onmessage = (event) => {
        if (!mounted) return;
        try {
          const payload = JSON.parse(event.data);
          const parsed = parseSensingUpdate(payload);
          if (!parsed) return;

          const now = Date.now();
          const g = lkg.current;

          // Update last-known-good store when we receive non-zero values
          if (parsed.breathingRate > 0) { g.breathingRate = parsed.breathingRate; g.breathingAt = now; }
          if (parsed.heartRate > 0)     { g.heartRate = parsed.heartRate;         g.heartAt = now; }
          if (parsed.isOccupied)        { g.people = parsed.people;               g.occupiedAt = now; }

          // Hold vitals on screen for VITALS_HOLD_MS after last good reading
          const breathingRate = parsed.breathingRate > 0 ? parsed.breathingRate
            : (now - g.breathingAt < VITALS_HOLD_MS ? g.breathingRate : 0);
          const heartRate = parsed.heartRate > 0 ? parsed.heartRate
            : (now - g.heartAt < VITALS_HOLD_MS ? g.heartRate : 0);

          // Hold presence for PRESENCE_HOLD_MS after last occupied frame
          const isOccupied = parsed.isOccupied || (now - g.occupiedAt < PRESENCE_HOLD_MS);
          const people = parsed.people.length > 0 ? parsed.people
            : (isOccupied && g.people.length > 0 ? g.people : []);

          setData(prev => ({ ...prev, ...parsed, breathingRate, heartRate, isOccupied, people }));
        } catch (e) {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        if (!mounted) return;
        clearInterval(ws._ping);
        setData(prev => ({ ...prev, connected: false }));
        reconnectTimer.current = setTimeout(connect, RECONNECT_MS);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      mounted = false;
      clearInterval(nodesInterval);
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        clearInterval(wsRef.current._ping);
        wsRef.current.close();
      }
    };
  }, []);

  return { data, nodes };
}
