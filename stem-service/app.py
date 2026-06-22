# 乐器分离 sidecar:本地起一次,常驻热模型,给 Node 后端调。
# 仿 suno-bridge 的"独立进程"模式,但这个纯本地、无反爬、确定性。
# 流程:Node 把源音频的绝对路径 + 输出目录 + model 发来 → 这里 ffmpeg 解码成 44.1k 立体声
#       → demucs apply_model → 各写一个 WAV → 回路径。
# 两个模型常驻(§29):
#   - 'full'(htdemucs_6s):全混 → 6 轨 drums/bass/other/vocals/guitar/piano。
#   - 'drums'(drumsep,可选):drums 轨 → kick/snare/toms/cymbals 四件(二段拆,只对鼓)。
# 走 ffmpeg+soundfile 自己做 IO,绕开 torchaudio 后端的脆弱性;mp3/wav 都吃。
import os
import subprocess
import tempfile

import numpy as np
import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model
from demucs.states import load_model
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

MODEL_NAME = os.environ.get("STEM_MODEL", "htdemucs_6s")
# drumsep checkpoint(单 .th,demucs.states.load_model 直读);默认放 stem-service/models/drumsep.th。
DRUM_CKPT = os.environ.get(
    "DRUM_CKPT", os.path.join(os.path.dirname(__file__), "models", "drumsep.th")
)
DEVICE = (
    "mps" if torch.backends.mps.is_available()
    else "cuda" if torch.cuda.is_available()
    else "cpu"
)

# drumsep 各 checkpoint 内部源标签不一(英/西混用)→ 归一化成英文 stemKind;未知 passthrough 小写。
# inagoy/drumsep 实测 sources = ['bombo','redoblante','platillos','toms'] → kick/snare/cymbals/toms。
DRUM_LABELS = {
    "kick": "kick", "bombo": "kick", "bass drum": "kick", "bassdrum": "kick", "bd": "kick",
    "snare": "snare", "redoblante": "snare", "caja": "snare", "sd": "snare",
    "toms": "toms", "tom": "toms", "tom-toms": "toms", "toms-toms": "toms",
    "cymbals": "cymbals", "cymbal": "cymbals", "platillos": "cymbals",  # 钹/overheads,非踩镲
    "hihat": "hihat", "hi-hat": "hihat", "hats": "hihat", "hh": "hihat",
}


def norm_drum(label: str) -> str:
    return DRUM_LABELS.get(label.strip().lower(), label.strip().lower())


print(f"[stem] loading {MODEL_NAME} on {DEVICE} …", flush=True)
MODEL = get_model(MODEL_NAME)
MODEL.to(DEVICE)
MODEL.eval()
SR = MODEL.samplerate            # 44100
SOURCES = list(MODEL.sources)    # ['drums','bass','other','vocals','guitar','piano']
print(f"[stem] ready. sr={SR} sources={SOURCES}", flush=True)

# 鼓模型可选:装了 drumsep checkpoint 才有;没装 → DRUM=None,全混分离照常工作。
DRUM = None
DRUM_SOURCES: list[str] = []
if os.path.exists(DRUM_CKPT):
    try:
        print(f"[stem] loading drum model {DRUM_CKPT} on {DEVICE} …", flush=True)
        # drumsep 的 .th 序列化了整个 HDemucs 对象(非纯权重)→ torch 2.6+ 默认 weights_only=True 会拒。
        # 自己以 weights_only=False 读 package(可信来源:本地下载的模型),再喂 load_model 的 dict 分支。
        pkg = torch.load(DRUM_CKPT, map_location="cpu", weights_only=False)
        DRUM = load_model(pkg)
        DRUM.to(DEVICE)
        DRUM.eval()
        DRUM_SOURCES = [norm_drum(s) for s in DRUM.sources]
        print(f"[stem] drum ready. sources={DRUM_SOURCES} (raw={list(DRUM.sources)})", flush=True)
    except Exception as e:  # noqa: BLE001 — 鼓模型坏不该拖垮整个 sidecar
        DRUM = None
        print(f"[stem] WARN drum model failed to load: {e}", flush=True)
else:
    print(f"[stem] drum model not installed ({DRUM_CKPT}); 'drums' split disabled. See README.", flush=True)

app = FastAPI()


class SeparateReq(BaseModel):
    inputPath: str           # 源音频绝对路径(mp3/wav 皆可)
    outDir: str              # 输出目录(这里负责建)
    model: str = "full"      # 'full'=全混 6 轨(默认,向后兼容) | 'drums'=鼓二段拆(§29)


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
    return {
        "ok": True, "model": MODEL_NAME, "device": DEVICE, "sources": SOURCES, "sampleRate": SR,
        "drum": {"available": DRUM is not None, "sources": DRUM_SOURCES},  # §29 鼓二段拆
    }


@app.post("/separate")
def separate(req: SeparateReq):
    # 选模型:'drums' 走专训鼓模型(可选,没装则 400),其余走全混。源标签按模型来(鼓走归一化)。
    if req.model == "drums":
        if DRUM is None:
            return JSONResponse(
                {"error": "drum model not installed; see stem-service/README"}, status_code=400
            )
        net, sources = DRUM, DRUM_SOURCES
    else:
        net, sources = MODEL, SOURCES

    wav = torch.tensor(load_audio(req.inputPath), dtype=torch.float32)  # (2, N)
    # demucs CLI 式标准化:整段按标量均值/方差归一,分完再还原。
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    norm = (wav - mean) / std
    with torch.no_grad():
        est = apply_model(
            net, norm[None], device=DEVICE,
            shifts=0, split=True, overlap=0.25, progress=False,
        )[0]                       # (S, 2, N)
    est = est * std + mean

    os.makedirs(req.outDir, exist_ok=True)
    stems = []
    for i, name in enumerate(sources):
        arr = est[i].cpu().numpy().T  # (N, 2)
        p = os.path.join(req.outDir, f"{name}.wav")
        sf.write(p, arr, SR, subtype="PCM_16")
        # 报告能量,后端据此跳过近静音 stem(如这首没吉他时的 guitar 轨 / 没 tom 的鼓)
        peak = float(np.max(np.abs(arr))) if arr.size else 0.0
        rms = float(np.sqrt(np.mean(arr ** 2))) if arr.size else 0.0
        stems.append({"kind": name, "path": p, "peak": peak, "rms": rms})
    return {"stems": stems, "sampleRate": SR, "model": req.model}
