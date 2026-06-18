"""阶段 0 — 入库：遍历输入目录，去重，记录基本信息。

不在这里转码：Demucs 自己能解 mp3/m4a 等，librosa 分析也能直接读原文件。
只登记到库里，把状态设为 'ingested'。
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from . import config, db


def _fingerprint(path: Path) -> str:
    """轻量内容指纹：文件大小 + 前 1MB 的 md5。够做去重 ID，不必读整个大文件。"""
    h = hashlib.md5()
    h.update(str(path.stat().st_size).encode())
    with path.open("rb") as f:
        h.update(f.read(1024 * 1024))
    return h.hexdigest()[:16]


def _duration(path: Path) -> float:
    """用 ffprobe 取时长（秒）。失败返回 0。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, check=True,
        )
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def iter_audio_files(root: Path):
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.suffix.lower() in config.SUPPORTED_EXTS:
            yield p


def ingest(input_dir: str) -> tuple[int, int]:
    """返回 (新增, 跳过去重)。"""
    root = Path(input_dir).expanduser().resolve()
    if not root.exists():
        raise FileNotFoundError(root)

    added = skipped = 0
    with db.connect() as conn:
        for path in iter_audio_files(root):
            tid = _fingerprint(path)
            if db.upsert_track(conn, tid, str(path), path.name, _duration(path)):
                added += 1
            else:
                skipped += 1
    return added, skipped
