"""阶段 1 — 分轨：调 Demucs 把每首曲子拆成 4 轨。

用子进程调 `python -m demucs` 最省心、最稳。输出落到
  STEMS_DIR/<track_id>/<model>/<basename>/<stem>.wav
分轨是整条链最重的一步（GPU 串行），所以一首一首跑、每首跑完就落库。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from . import config, db


def _run_demucs(src: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable, "-m", "demucs",
        "-n", config.DEMUCS_MODEL,
        "-d", config.DEMUCS_DEVICE,
        "-o", str(out_dir),
        str(src),
    ]
    # 让 demucs 的进度条直接透传到终端
    subprocess.run(cmd, check=True)


def _locate_stems(out_dir: Path) -> dict[str, Path]:
    """在 demucs 输出目录里找到 4 个 stem 文件。"""
    found = {}
    for stem in config.STEMS:
        hits = list(out_dir.rglob(f"{stem}.wav"))
        if hits:
            found[stem] = hits[0]
    return found


def separate_one(conn, row) -> None:
    src = Path(row["src_path"])
    out_dir = config.STEMS_DIR / row["id"]
    _run_demucs(src, out_dir)

    stems = _locate_stems(out_dir)
    missing = set(config.STEMS) - set(stems)
    if missing:
        raise RuntimeError(f"缺少分轨: {missing}（demucs 输出异常）")

    for stem_type, path in stems.items():
        db.add_stem(conn, row["id"], stem_type, str(path))
    db.set_status(conn, row["id"], "separated")


def separate_all(limit: int | None = None) -> int:
    """处理所有 status='ingested' 的曲子。返回成功数。"""
    done = 0
    with db.connect() as conn:
        todo = db.tracks_by_status(conn, "ingested")
    if limit:
        todo = todo[:limit]

    for i, row in enumerate(todo, 1):
        print(f"[separate {i}/{len(todo)}] {row['filename']}")
        try:
            # 每首单独开一个连接事务，跑完立即 commit，避免长事务
            with db.connect() as conn:
                separate_one(conn, row)
            done += 1
        except Exception as e:  # noqa: BLE001
            print(f"  !! 失败: {e}")
            with db.connect() as conn:
                db.set_status(conn, row["id"], "error", str(e))
    return done
