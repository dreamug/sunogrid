"""全局配置。所有路径相对 DATA_DIR，方便整体搬迁。"""

from __future__ import annotations

import os
from pathlib import Path

# 项目根 = 这个文件的上两级
ROOT = Path(__file__).resolve().parent.parent

# 工作目录（可用环境变量 HHGEN_DATA 覆盖）
DATA_DIR = Path(os.environ.get("HHGEN_DATA", ROOT / "data"))

STEMS_DIR = DATA_DIR / "stems"     # 分轨输出
LOOPS_DIR = DATA_DIR / "loops"     # 切好的 loop
DB_PATH = DATA_DIR / "library.db"  # 元数据库（唯一事实来源）

# ---- 音频常量 ----
SAMPLE_RATE = 44100                # Demucs 输出采样率，全程对齐到它
SUPPORTED_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".aif", ".aiff", ".ogg", ".wma"}

# ---- 分轨 ----
DEMUCS_MODEL = "htdemucs"          # 4 轨: drums/bass/other/vocals。想要钢琴+吉他换 "htdemucs_6s"
DEMUCS_DEVICE = "mps"              # Apple Silicon GPU；没有就 "cpu"
STEMS = ["drums", "bass", "other", "vocals"]

# ---- 切 loop ----
LOOP_BARS = [4, 8]                 # 每种长度都切；非重叠（step = n_bars）
RMS_SILENCE_THRESH = 0.004         # 低于此 RMS 视为静音，丢弃
# 哪些 stem 的 loop 需要标调性（鼓不需要）
HARMONIC_STEMS = {"bass", "other", "vocals"}


def ensure_dirs() -> None:
    for d in (DATA_DIR, STEMS_DIR, LOOPS_DIR):
        d.mkdir(parents=True, exist_ok=True)
