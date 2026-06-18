"""SQLite 访问层。库就是唯一事实来源，文件丢了也能从这里重建索引。

状态机 (tracks.status):
  ingested -> separated -> analyzed -> sliced
每一步只处理上一状态的曲子，天然可断点续跑。
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks (
    id            TEXT PRIMARY KEY,   -- 内容指纹，去重用
    src_path      TEXT NOT NULL,
    filename      TEXT NOT NULL,
    duration      REAL,
    status        TEXT NOT NULL DEFAULT 'ingested',
    bpm           REAL,
    key           TEXT,               -- e.g. "A"
    scale         TEXT,               -- "major" / "minor"
    downbeats     TEXT,               -- JSON: 下拍时间数组(秒)
    error         TEXT,               -- 最近一次失败信息
    added_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stems (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id  TEXT NOT NULL REFERENCES tracks(id),
    stem_type TEXT NOT NULL,
    path      TEXT NOT NULL,
    UNIQUE(track_id, stem_type)
);

CREATE TABLE IF NOT EXISTS loops (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id     TEXT NOT NULL REFERENCES tracks(id),
    stem_type    TEXT NOT NULL,
    path         TEXT NOT NULL,
    start_sample INTEGER,
    end_sample   INTEGER,
    n_bars       INTEGER,
    bpm          REAL,
    key          TEXT,
    scale        TEXT,
    rms          REAL,
    created_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tracks_status ON tracks(status);
CREATE INDEX IF NOT EXISTS idx_loops_lookup  ON loops(stem_type, n_bars, bpm, key);
"""


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    config.ensure_dirs()
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)


# ---------- tracks ----------

def upsert_track(conn, track_id: str, src_path: str, filename: str, duration: float) -> bool:
    """新曲子返回 True，已存在(去重命中)返回 False。"""
    cur = conn.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,))
    if cur.fetchone():
        return False
    conn.execute(
        "INSERT INTO tracks (id, src_path, filename, duration) VALUES (?,?,?,?)",
        (track_id, src_path, filename, duration),
    )
    return True


def set_status(conn, track_id: str, status: str, error: Optional[str] = None) -> None:
    conn.execute(
        "UPDATE tracks SET status = ?, error = ? WHERE id = ?",
        (status, error, track_id),
    )


def set_analysis(conn, track_id: str, bpm: float, key: str, scale: str, downbeats) -> None:
    conn.execute(
        "UPDATE tracks SET bpm=?, key=?, scale=?, downbeats=?, status='analyzed', error=NULL WHERE id=?",
        (bpm, key, scale, json.dumps(list(downbeats)), track_id),
    )


def tracks_by_status(conn, status: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM tracks WHERE status = ? ORDER BY added_at", (status,)
    ).fetchall()


def get_downbeats(row: sqlite3.Row) -> list[float]:
    return json.loads(row["downbeats"]) if row["downbeats"] else []


# ---------- stems / loops ----------

def add_stem(conn, track_id: str, stem_type: str, path: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO stems (track_id, stem_type, path) VALUES (?,?,?)",
        (track_id, stem_type, path),
    )


def stems_for(conn, track_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM stems WHERE track_id = ?", (track_id,)
    ).fetchall()


def add_loop(conn, **kw) -> None:
    cols = ",".join(kw.keys())
    qs = ",".join("?" for _ in kw)
    conn.execute(f"INSERT INTO loops ({cols}) VALUES ({qs})", tuple(kw.values()))


def delete_loops_for(conn, track_id: str) -> None:
    """重切前清掉旧 loop 记录（文件由调用方处理）。"""
    conn.execute("DELETE FROM loops WHERE track_id = ?", (track_id,))


# ---------- 概览 ----------

def stats(conn) -> dict:
    out = {"by_status": {}}
    for r in conn.execute("SELECT status, COUNT(*) c FROM tracks GROUP BY status"):
        out["by_status"][r["status"]] = r["c"]
    out["tracks"] = conn.execute("SELECT COUNT(*) c FROM tracks").fetchone()["c"]
    out["loops"] = conn.execute("SELECT COUNT(*) c FROM loops").fetchone()["c"]
    return out
