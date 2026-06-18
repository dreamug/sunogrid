"""阶段 3 — 切 loop：按下拍网格把每条 stem 切成 N 小节的无缝循环。

下拍时间 -> 采样位置 (round(t*sr))，因为 stem 与原曲时间对齐、采样率都是 44100。
非重叠切（step = n_bars），丢掉接近静音的片段，存真实 BPM（不做时间拉伸）。
"""

from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import soundfile as sf

from . import config, db


def _rms(x: np.ndarray) -> float:
    if x.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(x))))


def slice_one(conn, row) -> int:
    downbeats = db.get_downbeats(row)
    if len(downbeats) < min(config.LOOP_BARS) + 1:
        return 0  # 下拍太少，切不出 loop

    sr = config.SAMPLE_RATE
    db_samples = [int(round(t * sr)) for t in downbeats]

    out_root = config.LOOPS_DIR / row["id"]
    if out_root.exists():
        shutil.rmtree(out_root)          # 重切：清掉旧文件
    out_root.mkdir(parents=True, exist_ok=True)
    db.delete_loops_for(conn, row["id"])  # 和旧记录

    n_loops = 0
    for stem in db.stems_for(conn, row["id"]):
        stem_type = stem["stem_type"]
        audio, file_sr = sf.read(stem["path"], always_2d=True)  # (n, ch), float64
        if file_sr != sr:
            # Demucs 默认就是 44100；真不一致就跳过，避免错位
            print(f"  ! {stem_type} 采样率 {file_sr} != {sr}，跳过")
            continue

        for n_bars in config.LOOP_BARS:
            # 非重叠：i 步进 n_bars
            for idx, i in enumerate(range(0, len(db_samples) - n_bars, n_bars)):
                s, e = db_samples[i], db_samples[i + n_bars]
                clip = audio[s:e]
                r = _rms(clip)
                if r < config.RMS_SILENCE_THRESH:
                    continue  # 静音段丢弃

                fname = f"{stem_type}_{n_bars}bar_{idx:03d}.wav"
                fpath = out_root / fname
                sf.write(fpath, clip, sr, subtype="PCM_16")

                harmonic = stem_type in config.HARMONIC_STEMS
                db.add_loop(
                    conn,
                    track_id=row["id"],
                    stem_type=stem_type,
                    path=str(fpath),
                    start_sample=s,
                    end_sample=e,
                    n_bars=n_bars,
                    bpm=row["bpm"],
                    key=row["key"] if harmonic else None,
                    scale=row["scale"] if harmonic else None,
                    rms=round(r, 5),
                )
                n_loops += 1

    db.set_status(conn, row["id"], "sliced")
    return n_loops


def slice_all(limit: int | None = None) -> int:
    with db.connect() as conn:
        todo = db.tracks_by_status(conn, "analyzed")
    if limit:
        todo = todo[:limit]

    total = 0
    for i, row in enumerate(todo, 1):
        print(f"[slice {i}/{len(todo)}] {row['filename']}")
        try:
            with db.connect() as conn:
                n = slice_one(conn, row)
            total += n
            print(f"  -> {n} loops")
        except Exception as e:  # noqa: BLE001
            print(f"  !! 失败: {e}")
            with db.connect() as conn:
                db.set_status(conn, row["id"], "error", str(e))
    return total
