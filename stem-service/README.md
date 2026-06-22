# stem-service — 本地乐器分离 sidecar

Demucs (`htdemucs_6s`) 跑在本机,把一段音频分成 6 轨:
**drums / bass / other / vocals / guitar / piano**。
和 `suno-bridge` 一样是独立进程;但这个纯本地、离线、不耗 credit、确定性。

**鼓二段拆(§29,可选)**:装上 drumsep checkpoint 后,drums 轨可再拆成
**kick / snare / toms / cymbals**(`/separate` 带 `model:'drums'`)。没装则该功能禁用,全混分离照常。

## 一次性安装
```bash
python3 -m venv .venv
.venv/bin/pip install "numpy<2" torch torchaudio "demucs==4.0.1" soundfile fastapi "uvicorn[standard]"
```
首次分离时会自动下载 `htdemucs_6s` 权重(~数百 MB)到 torch 缓存。需要系统有 `ffmpeg`。

### 鼓二段拆模型(drumsep,可选)
专训鼓模型是个 Demucs `.th` checkpoint,放到 `stem-service/models/drumsep.th`(或用 `DRUM_CKPT` 环境变量指别处):
```bash
mkdir -p models
# 下载 drumsep checkpoint(Demucs 格式 .th)到 models/drumsep.th
# 来源:https://github.com/inagoy/drumsep  (单文件 .th,~数十 MB)
```
启动时 sidecar 自动 `load_model` 它;模型内部源标签是西语 `['bombo','redoblante','platillos','toms']`,
sidecar 归一化成 `kick/snare/cymbals/toms`(platillos=钹/overheads,非踩镲)。
> torch 2.6+ 默认 `weights_only=True` 会拒这个老 checkpoint;sidecar 已用 `weights_only=False` 读(可信本地文件)。
**没装也不影响**:`DRUM=None`,全混 6 轨分离照常,只是 `model:'drums'` 会返回 400「未安装」。

## 启动
```bash
./run.sh            # 127.0.0.1:8008,常驻热模型
```
健康检查:`curl http://127.0.0.1:8008/health`

## 接口
- `GET  /health` → `{ok, model, device, sources[], sampleRate, drum:{available, sources[]}}`
- `POST /separate` `{inputPath, outDir, model?}` → `{stems:[{kind,path,peak,rms}], sampleRate, model}`
  - `model`:`'full'`(默认,全混 6 轨)| `'drums'`(鼓二段拆,需装 drumsep,否则 400)。
  - 入参是**绝对路径**(sidecar 与 Node 后端同机共享文件系统),回的也是路径,避免大 payload。

Node 后端通过 `STEM_SERVICE_URL`(默认 `http://127.0.0.1:8008`)调用;`web/src/lib/stems.ts`。
设备:Apple Silicon 走 `mps`,否则 `cuda`/`cpu` 自动降级。
