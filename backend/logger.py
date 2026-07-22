import time
import threading
from database import log_presence
from csi_bridge import bridge

POLL_INTERVAL = 5


class PollingLogger:
    def __init__(self):
        self.running = False
        self.thread = None

    def start(self):
        if not self.running:
            self.running = True
            self.thread = threading.Thread(target=self._poll_loop, daemon=True)
            self.thread.start()

    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join()

    def _poll_loop(self):
        while self.running:
            try:
                state = bridge.get_latest()
                is_occupied = state.get("classification", {}).get("is_occupied", False)
                motion_level = state.get("classification", {}).get("motion_level", 0.0)
                nodes = bridge.get_nodes()
                active_nodes = sum(1 for n in nodes if n.get("status") == "active")
                log_presence(is_occupied, active_nodes, motion_level)
            except Exception as e:
                print(f"Logger poll error: {e}")
            time.sleep(POLL_INTERVAL)


logger_instance = PollingLogger()
