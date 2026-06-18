"""阶段 2 — 分析：对整首混音估 BPM / 拍点 / 下拍 / 调性。

全用 librosa，纯 python、Mac 上零安装摩擦。jazzhiphop 基本都是 4/4，
所以下拍用"把拍子按 4 分组、选 onset 能量最强的相位"来估，实践很稳。
分析在混音上做（信号最全），拍点时间随后映射到各 stem 的采样位置即可。
"""

from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np

from . import config, db

PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler 调性模板
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def estimate_key(y: np.ndarray, sr: int) -> tuple[str, str]:
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    best = (-2.0, 0, "major")
    for i in range(12):
        rotated = np.roll(chroma, -i)
        for prof, mode in ((_MAJOR, "major"), (_MINOR, "minor")):
            corr = float(np.corrcoef(rotated, prof)[0, 1])
            if corr > best[0]:
                best = (corr, i, mode)
    return PITCHES[best[1]], best[2]


def estimate_grid(y: np.ndarray, sr: int) -> tuple[float, np.ndarray]:
    """返回 (bpm, downbeat_times)。"""
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)

    if len(beat_frames) < 4:
        return float(np.atleast_1d(tempo)[0]), beat_times

    # 在 4 个相位里选 onset 能量之和最大的当下拍相位
    frames = np.clip(beat_frames, 0, len(onset_env) - 1)
    strengths = onset_env[frames]
    phase = max(range(4), key=lambda p: strengths[p::4].sum())
    downbeats = beat_times[phase::4]
    return float(np.atleast_1d(tempo)[0]), downbeats


def analyze_one(conn, row) -> None:
    # 直接读原混音；mono 给分析用就够
    y, sr = librosa.load(row["src_path"], sr=config.SAMPLE_RATE, mono=True)
    bpm, downbeats = estimate_grid(y, sr)
    key, scale = estimate_key(y, sr)
    db.set_analysis(conn, row["id"], round(bpm, 2), key, scale, [round(t, 4) for t in downbeats])


def analyze_all(limit: int | None = None) -> int:
    with db.connect() as conn:
        todo = db.tracks_by_status(conn, "separated")
    if limit:
        todo = todo[:limit]

    done = 0
    for i, row in enumerate(todo, 1):
        print(f"[analyze {i}/{len(todo)}] {row['filename']}")
        try:
            with db.connect() as conn:
                analyze_one(conn, row)
            done += 1
        except Exception as e:  # noqa: BLE001
            print(f"  !! 失败: {e}")
            with db.connect() as conn:
                db.set_status(conn, row["id"], "error", str(e))
    return done
