import sqlite3
import os
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), 'data', 'history.db')

def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    # Table to store raw presence events
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS presence_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            is_occupied BOOLEAN NOT NULL,
            active_nodes INTEGER NOT NULL,
            motion_level REAL
        )
    ''')
    conn.commit()
    conn.close()

def log_presence(is_occupied, active_nodes, motion_level):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO presence_logs (timestamp, is_occupied, active_nodes, motion_level)
        VALUES (?, ?, ?, ?)
    ''', (datetime.now().isoformat(), is_occupied, active_nodes, motion_level))
    conn.commit()
    conn.close()

def get_today_history():
    conn = get_db()
    cursor = conn.cursor()
    today_prefix = datetime.now().strftime('%Y-%m-%d')
    cursor.execute('''
        SELECT timestamp, is_occupied, active_nodes, motion_level
        FROM presence_logs
        WHERE timestamp LIKE ?
        ORDER BY timestamp ASC
    ''', (today_prefix + '%',))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]
