# hhgen — jazzhiphop loop 素材库 (v1)

把整曲拆成分轨、再按小节切成带元数据的 loop 库。后面"自动做 beat"的工具直接吃这个库。

```
ingest  ->  separate  ->  analyze  ->  slice
登记       Demucs 分轨   BPM/下拍/调   按下拍网格切 loop
```

所有状态落在 `data/library.db`（SQLite），**每一步只处理上一状态的曲子，可随时中断续跑**。

## 安装（Apple Silicon / Python 3.12）

```bash
conda create -n hhgen python=3.11 -y   # 3.12 也行；新建独立环境最稳
conda activate hhgen
pip install -r requirements.txt
# ffmpeg 需在 PATH 里（你已经有了：brew install ffmpeg）
```

## 跑通流程

**先拿 5 首验证整条链**，确认 loop 听感 OK 再上全量：

```bash
python -m hhgen.cli ingest   ~/music/jazzhiphop
python -m hhgen.cli separate --limit 5
python -m hhgen.cli analyze  --limit 5
python -m hhgen.cli slice    --limit 5
python -m hhgen.cli status
```

确认没问题后跑全量（去掉 `--limit`，分轨 1000 首建议挂机过夜）：

```bash
python -m hhgen.cli separate
python -m hhgen.cli analyze
python -m hhgen.cli slice
```

## 产物

- `data/stems/<track_id>/` — 4 条分轨 (drums/bass/other/vocals)
- `data/loops/<track_id>/` — 切好的 loop，文件名 `<stem>_<bars>bar_<idx>.wav`
- `data/library.db` — 每个 loop 的 BPM / key / scale / 小节数 / RMS / 来源曲

查库示例：
```sql
SELECT stem_type, n_bars, bpm, key, scale, path
FROM loops WHERE stem_type='other' AND n_bars=4
ORDER BY bpm;
```

## 关键参数（`hhgen/config.py`）

| 参数 | 说明 |
|---|---|
| `DEMUCS_MODEL` | `htdemucs`(4 轨) / `htdemucs_6s`(加钢琴+吉他) |
| `DEMUCS_DEVICE` | `mps`（Apple GPU）/ `cpu` |
| `LOOP_BARS` | 切哪些长度，默认 `[4, 8]` |
| `RMS_SILENCE_THRESH` | 静音丢弃阈值 |

## 已知边界 / 后续可升级

- 拍点/下拍用 librosa + 4/4 假设，BPM 偶尔会翻倍/减半；后续可换 madmom/allin1（需另装环境）提升精度。
- 调性用 Krumhansl-Schmuckler，转调多的曲子只取全局主调。
- v1 没做时间拉伸，存的是真实 BPM，对齐留给下游生成工具。
- 想要"找相似 loop"：后续给每个 loop 加 CLAP embedding 做向量检索。
