# 乐器分离 sidecar:本地起一次,常驻热模型(htdemucs_6s),给 Node 后端调。
# 仿 suno-bridge 的"独立进程"模式,但这个纯本地、无反爬、确定性。
# 流程:Node 把源音频的绝对路径 + 输出目录发来 → 这里 ffmpeg 解码成 44.1k 立体声
#       → demucs 分 6 轨(drums/bass/other/vocals/guitar/piano)→ 各写一个 WAV → 回路径。
# 走 ffmpeg+soundfile 自己做 IO,绕开 torchaudio 后端的脆弱性;mp3/wav 都吃。
import os
import subprocess
import tempfile

import numpy as np
import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model
from fastapi import FastAPI
from pydantic import BaseModel

MODEL_NAME = os.environ.get("STEM_MODEL", "htdemucs_6s")
DEVICE = (
    "mps" if torch.backends.mps.is_available()
    else "cuda" if torch.cuda.is_available()
    else "cpu"
)

print(f"[stem] loading {MODEL_NAME} on {DEVICE} …", flush=True)
MODEL = get_model(MODEL_NAME)
MODEL.to(DEVICE)
MODEL.eval()
SR = MODEL.samplerate            # 44100
SOURCES = list(MODEL.sources)    # ['drums','bass','other','vocals','guitar','piano']
print(f"[stem] ready. sr={SR} sources={SOURCES}", flush=True)

app = FastAPI()


class SeparateReq(BaseModel):
    inputPath: str      # 源音频绝对路径(mp3/wav 皆可)
    outDir: str         # 输出目录(这里负责建)


def load_audio(path: str) -> np.ndarray:
    """ffmpeg → 44.1k 立体声 f32,返回 (channels, samples)。"""
    tmp = tempfile.mktemp(suffix=".wav")
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", path,
             "-ar", str(SR), "-ac", "2", "-f", "wav", tmp],
            check=True,
        )
        data, _ = sf.read(tmp, dtype="float32", always_2d=True)  # (samples, ch)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return data.T  # (ch, samples)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "device": DEVICE, "sources": SOURCES, "sampleRate": SR}


@app.post("/separate")
def separate(req: SeparateReq):
    wav = torch.tensor(load_audio(req.inputPath), dtype=torch.float32)  # (2, N)
    # demucs CLI 式标准化:整段按标量均值/方差归一,分完再还原。
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    norm = (wav - mean) / std
    with torch.no_grad():
        est = apply_model(
            MODEL, norm[None], device=DEVICE,
            shifts=0, split=True, overlap=0.25, progress=False,
        )[0]                       # (S, 2, N)
    est = est * std + mean

    os.makedirs(req.outDir, exist_ok=True)
    stems = []
    for i, name in enumerate(SOURCES):
        arr = est[i].cpu().numpy().T  # (N, 2)
        p = os.path.join(req.outDir, f"{name}.wav")
        sf.write(p, arr, SR, subtype="PCM_16")
        # 报告能量,后端据此跳过近静音 stem(如这首没吉他时的 guitar 轨)
        peak = float(np.max(np.abs(arr))) if arr.size else 0.0
        rms = float(np.sqrt(np.mean(arr ** 2))) if arr.size else 0.0
        stems.append({"kind": name, "path": p, "peak": peak, "rms": rms})
    return {"stems": stems, "sampleRate": SR, "model": MODEL_NAME}
