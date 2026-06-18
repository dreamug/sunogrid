"""命令行入口。

典型用法（建议先用 --limit 跑通 5 首再上全量）:
    python -m hhgen.cli init
    python -m hhgen.cli ingest  ~/music/jazzhiphop
    python -m hhgen.cli separate --limit 5
    python -m hhgen.cli analyze --limit 5
    python -m hhgen.cli slice    --limit 5
    python -m hhgen.cli status
    # 跑通后整条链一把梭（去掉 --limit）:
    python -m hhgen.cli run-all ~/music/jazzhiphop
"""

from __future__ import annotations

import typer

from . import analyze as _analyze
from . import db
from . import ingest as _ingest
from . import separate as _separate
from . import slicer as _slicer

app = typer.Typer(add_completion=False, help="jazzhiphop loop 素材库构建工具")


@app.command()
def init():
    """初始化数据库和目录。"""
    db.init_db()
    typer.echo("✓ 库已初始化")


@app.command()
def ingest(input_dir: str):
    """登记输入目录下的音频文件（去重）。"""
    db.init_db()
    added, skipped = _ingest.ingest(input_dir)
    typer.echo(f"✓ 新增 {added}，跳过重复 {skipped}")


@app.command()
def separate(limit: int = typer.Option(None, help="只处理前 N 首")):
    """分轨（Demucs，最重的一步）。"""
    n = _separate.separate_all(limit)
    typer.echo(f"✓ 分轨完成 {n} 首")


@app.command()
def analyze(limit: int = typer.Option(None, help="只处理前 N 首")):
    """估 BPM / 下拍 / 调性。"""
    n = _analyze.analyze_all(limit)
    typer.echo(f"✓ 分析完成 {n} 首")


@app.command()
def slice(limit: int = typer.Option(None, help="只处理前 N 首")):
    """按下拍网格切 loop。"""
    n = _slicer.slice_all(limit)
    typer.echo(f"✓ 共切出 {n} 个 loop")


@app.command("run-all")
def run_all(input_dir: str, limit: int = typer.Option(None, help="只处理前 N 首")):
    """一把梭跑完整条链路。"""
    db.init_db()
    a, s = _ingest.ingest(input_dir)
    typer.echo(f"ingest: 新增 {a}，跳过 {s}")
    _separate.separate_all(limit)
    _analyze.analyze_all(limit)
    n = _slicer.slice_all(limit)
    typer.echo(f"✓ done，共 {n} 个 loop")


@app.command()
def status():
    """看进度概览。"""
    with db.connect() as conn:
        st = db.stats(conn)
    typer.echo(f"曲目总数: {st['tracks']}")
    typer.echo(f"loop 总数: {st['loops']}")
    typer.echo("各阶段:")
    for k, v in st["by_status"].items():
        typer.echo(f"  {k:10s} {v}")


if __name__ == "__main__":
    app()
