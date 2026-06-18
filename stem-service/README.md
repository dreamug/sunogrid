# stem-service — 本地乐器分离 sidecar

Demucs (`htdemucs_6s`) 跑在本机,把一段音频分成 6 轨:
**drums / bass / other / vocals / guitar / piano**。
和 `suno-bridge` 一样是独立进程;但这个纯本地、离线、不耗 credit、确定性。

## 一次性安装
```bash
python3 -m venv .venv
.venv/bin/pip install "numpy<2" torch torchaudio "demucs==4.0.1" soundfile fastapi "uvicorn[standard]"
```
首次分离时会自动下载 `htdemucs_6s` 权重(~数百 MB)到 torch 缓存。需要系统有 `ffmpeg`。

## 启动
```bash
./run.sh            # 127.0.0.1:8008,常驻热模型
```
健康检查:`curl http://127.0.0.1:8008/health`

## 接口
- `GET  /health` → `{ok, model, device, sources[], sampleRate}`
- `POST /separate` `{inputPath, outDir}` → `{stems:[{kind,path}], sampleRate, model}`
  - 入参是**绝对路径**(sidecar 与 Node 后端同机共享文件系统),回的也是路径,避免大 payload。

Node 后端通过 `STEM_SERVICE_URL`(默认 `http://127.0.0.1:8008`)调用;`web/src/lib/stems.ts`。
设备:Apple Silicon 走 `mps`,否则 `cuda`/`cpu` 自动降级。
