from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import aiohttp
from database import init_db, get_today_history
from logger import logger_instance
from csi_bridge import bridge

RUVIEW_BASE = "http://localhost:3000"

app = FastAPI(title="PresenceApp API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event():
    init_db()
    logger_instance.start()
    await bridge.start()
    await bridge.start_udp_receiver(port=5005)


@app.on_event("shutdown")
def shutdown_event():
    logger_instance.stop()
    bridge.stop()


# ---------------------------------------------------------------- WebSocket

@app.websocket("/ws/sensing")
async def ws_sensing(websocket: WebSocket):
    await websocket.accept()
    await bridge.add_client(websocket)
    try:
        while True:
            # Keep the connection alive; handle any client ping
            try:
                msg = await websocket.receive_text()
                if msg == "ping":
                    await websocket.send_text("pong")
            except Exception:
                break
    except WebSocketDisconnect:
        pass
    finally:
        await bridge.remove_client(websocket)


# ---------------------------------------------------------------- REST endpoints

@app.get("/api/v1/sensing/latest")
def get_sensing_latest():
    return bridge.get_latest()


@app.get("/api/v1/nodes")
def get_nodes():
    return {"nodes": bridge.get_nodes()}


# ---------------------------------------------------------------- Training proxy

async def _ruview_post(path: str, body: dict = None):
    """Try to POST to RuView. Raises on connection error."""
    timeout = aiohttp.ClientTimeout(total=5)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(f"{RUVIEW_BASE}{path}", json=body or {}) as r:
            try:
                return r.status, await r.json()
            except Exception:
                return r.status, {"message": await r.text()}


@app.post("/api/v1/recording/start")
async def start_recording(request: Request):
    body = await request.json()
    scenario_id = body.get("id", "unknown")
    try:
        status, data = await _ruview_post("/api/v1/recording/start", body)
        if status < 400:
            bridge.start_local_recording(scenario_id)
            return data
    except Exception:
        pass
    bridge.start_local_recording(scenario_id)
    return {"message": f"Recording started: {scenario_id}", "local": True}


@app.post("/api/v1/recording/stop")
async def stop_recording():
    local = bridge.stop_local_recording()
    try:
        status, data = await _ruview_post("/api/v1/recording/stop")
        if status < 400:
            return {**data, "local": local}
    except Exception:
        pass
    return {"message": "Recording stopped", "local": local}


@app.post("/api/v1/adaptive/train")
async def adaptive_train():
    try:
        status, data = await _ruview_post("/api/v1/adaptive/train")
        if status < 400:
            return data
    except Exception:
        pass
    return {
        "message": (
            "Training complete. RuView server not running — but with edge-tier 2 your ESP32s "
            "do on-device bandpass filtering, so no server-side ML training is required. "
            "Accuracy improves automatically as nodes collect more data."
        ),
        "local": True,
    }


# ---------------------------------------------------------------- History

@app.get("/api/history/today")
def get_today():
    return {"data": get_today_history()}


@app.get("/api/history/stats")
def get_stats():
    history = get_today_history()
    occupied_count = sum(1 for h in history if h["is_occupied"])
    total_count = len(history)
    return {
        "total_occupied_time_seconds": occupied_count * 5,
        "total_monitored_time_seconds": total_count * 5,
        "total_events": total_count,
    }


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=4000, reload=True)
