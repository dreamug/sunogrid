'use client';
// 左列:Suno 生成(控件)+ 素材库(两级卡片:一级=全混变体,二级=分离出的乐器轨,凹陷一层、可折叠)。
import { useState } from 'react';
import type { GenView } from '../useLoopMachine';

interface Props {
  gens: GenView[];
  selectedLoopId: string | null;
  previewing: boolean;
  masterBpm: number;
  genPrompt: string;
  genMode: 'sound' | 'advanced';
  genLoop: boolean;
  genBpm: number;
  genKey: string;
  onGenPrompt: (s: string) => void;
  onGenMode: (m: 'sound' | 'advanced') => void;
  onGenLoop: (b: boolean) => void;
  onGenBpm: (n: number) => void;
  onGenKey: (k: string) => void;
  onGenerate: () => void;
  onSelect: (id: string) => void;
  onAudition: (id: string) => void;
  onDragSound?: (id: string) => void;  // 拖一条素材开始(studio 用:轨内占位块按真实长度画/判重叠)
  onAssignNext: (id: string) => void;
  onSeparate: (id: string) => void;
  onRetryGen?: (id: string) => void;   // 失败重试(studio 提供;loop 机不传则不显示)
  onDeleteGen?: (id: string) => void;  // 删除整组生成
  onDeleteSound?: (id: string) => void; // 软删单条素材/分轨
  stemServiceUp: boolean | null;
}

const STEM_LABEL: Record<string, string> = {
  drums: '鼓', bass: '贝斯', other: '其他', vocals: '人声', guitar: '吉他', piano: '键盘',
};
const KEYS = ['C', 'Cm', 'C#', 'C#m', 'D', 'Dm', 'D#', 'D#m', 'E', 'Em', 'F', 'Fm', 'F#', 'F#m', 'G', 'Gm', 'G#', 'G#m', 'A', 'Am', 'A#', 'A#m', 'B', 'Bm'];
const GEN_STATUS: Record<string, string> = { generating: '生成中…', streaming: '渲染中…', complete: '完成', failed: '失败' };
const fmtBars = (b: number) => (Number.isInteger(b) ? `${b}` : b.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

export function LoopManager(p: Props) {
  // 变体全被软删后的 complete 空壳不再展示(避免无内容、无操作的孤卡)。
  const gens = p.gens.filter((g) => !(g.status === 'complete' && g.sounds.length === 0));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}); // 变体 id → 二级收起
  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  const playIcon = (id: string) => (p.selectedLoopId === id && p.previewing ? '⏸' : '▶');
  const drag = (id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'copy'; p.onDragSound?.(id); },
  });

  return (
    <>
      <section className="br-sec">
        <div className="br-h"><span className="sec-l">生成</span></div>
        <div className="gen-body">
          <div className="seg gen-mode">
            <button className={p.genMode === 'sound' ? 'on' : ''} onClick={() => p.onGenMode('sound')} title="短 loop / 采样(Suno Sounds)">Sound</button>
            <button className={p.genMode === 'advanced' ? 'on' : ''} onClick={() => p.onGenMode('advanced')} title="整首纯器乐(Suno Advanced),进库后裁 loop">Advanced</button>
          </div>
          <textarea
            className="gen-ta"
            rows={2}
            value={p.genPrompt}
            onChange={(e) => p.onGenPrompt(e.target.value)}
            placeholder={p.genMode === 'advanced' ? '描述风格/曲子(整首纯器乐)' : '描述要生成的 loop(任意风格)'}
          />
          <div className="gen-row">
            {p.genMode === 'sound' && (
              <label className="gchk" title="作为循环段生成(否则当一次性采样)">
                <input type="checkbox" checked={p.genLoop} onChange={(e) => p.onGenLoop(e.target.checked)} /> Loop
              </label>
            )}
            <label className="gbpm" title="生成速度 = 这条的原始 BPM">
              BPM<input type="number" min={40} max={220} value={p.genBpm} onChange={(e) => p.onGenBpm(Number(e.target.value))} />
            </label>
            <label className="gkey" title="调性:Sound 用 Suno 的 Key 字段(钢琴弹窗);Advanced 折进风格词">
              Key
              <select value={p.genKey} onChange={(e) => p.onGenKey(e.target.value)}>
                <option value="">Any</option>
                {KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
          </div>
          <button className="gen" onClick={p.onGenerate}>生成 → 进库</button>
          {p.genMode === 'advanced' && (
            <div className="muted small">Advanced:BPM/Key 折进风格词,生成整首纯器乐(较慢),进库后裁 loop 区。</div>
          )}
        </div>
      </section>

      <section className="br-sec" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="br-h"><span className="sec-l">素材库</span><span className="n">{gens.length}</span></div>
        <div className="lib-list">
          {gens.length === 0 && <div className="muted small" style={{ padding: '6px 2px' }}>还没有,点上面"生成"试试</div>}
          {gens.map((g) => {
            const busy = g.status === 'generating' || g.status === 'streaming';
            return (
              <div key={g.id} className="gengrp">
                <div className="gengrp-h">
                  <span className="gengrp-name" title={g.prompt}>{g.prompt}</span>
                  <span className={'gdot ' + g.status} title={GEN_STATUS[g.status]} />
                </div>
                {busy && <div className="gb-bar"><i /></div>}
                {g.status === 'failed' && (
                  <div className="gb-fail">
                    <div className="gb-err" title={g.error}>{g.error || '生成失败'}</div>
                    {(p.onRetryGen || p.onDeleteGen) && (
                      <div className="gb-acts">
                        {p.onRetryGen && <button className="gb-btn" onClick={() => p.onRetryGen!(g.id)}>↻ 重试</button>}
                        {p.onDeleteGen && <button className="gb-btn danger" onClick={() => p.onDeleteGen!(g.id)}>删除</button>}
                      </div>
                    )}
                  </div>
                )}

                {g.sounds.map((s) => {
                  const separating = s.stemStatus === 'separating';
                  const stems = s.stems ?? [];
                  const hasStems = stems.length > 0;
                  const open = !collapsed[s.id];
                  return (
                    <div key={s.id} className="vcard">
                      {/* 一级:全混变体 */}
                      <div
                        className={'vc-main' + (p.selectedLoopId === s.id ? ' vsel' : '')}
                        {...drag(s.id)}
                        onClick={() => p.onSelect(s.id)}
                        title="拖到 clip,或点「→pad」放空位;点选进编辑器"
                      >
                        <button className="pl" onClick={(e) => { e.stopPropagation(); p.onAudition(s.id); }}>{playIcon(s.id)}</button>
                        <div className="ci">
                          <div className="cn">{s.label}</div>
                          <div className="cm">≈{s.srcBpm} → {p.masterBpm} · {fmtBars(s.bars)} 小节{hasStems ? ' · 全混' : ''}</div>
                        </div>
                        <button className="topad" title="放到下一个空 pad" onClick={(e) => { e.stopPropagation(); p.onAssignNext(s.id); }}>→pad</button>
                        {p.onDeleteSound && <button className="vdel" title="删除这条素材(软删,可在库里恢复)" onClick={(e) => { e.stopPropagation(); p.onDeleteSound!(s.id); }}>×</button>}
                      </div>

                      {separating && <div className="vc-note">分离中…本地 Demucs(约 2× 实时)</div>}
                      {!separating && s.stemStatus === 'failed' && !hasStems && <div className="vc-note err">分离失败 · 点重试</div>}
                      {!separating && !hasStems && s.stemStatus !== 'failed' && (
                        <div className="vc-sep">
                          <button
                            className="sepbtn"
                            disabled={p.stemServiceUp === false}
                            title={p.stemServiceUp === false ? '分离服务未启动:stem-service/ 下 ./run.sh' : '分离乐器(本地 Demucs)'}
                            onClick={(e) => { e.stopPropagation(); p.onSeparate(s.id); }}
                          >✂ 分离</button>
                          <span className="vc-hintx">未分离</span>
                        </div>
                      )}

                      {/* 二级:分轨 */}
                      {hasStems && (
                        <div className="vc-tier">
                          <div className="vc-tier-h" onClick={() => toggle(s.id)}>
                            <span className="cv">{open ? '▾' : '▸'}</span>
                            <span className="lbl">分轨</span>
                            <span className="cnt">{stems.length} 轨{open ? '' : ' · 已收起'}</span>
                            <button
                              className="re"
                              disabled={separating || p.stemServiceUp === false}
                              title={p.stemServiceUp === false ? '分离服务未启动' : '重新分离'}
                              onClick={(e) => { e.stopPropagation(); p.onSeparate(s.id); }}
                            >↻</button>
                          </div>
                          {open && (
                            <div className="vc-stems">
                              {stems.map((st) => (
                                <div
                                  key={st.id}
                                  className={'vc-stem' + (p.selectedLoopId === st.id ? ' vsel' : '')}
                                  style={{ ['--c']: st.color } as React.CSSProperties}
                                  {...drag(st.id)}
                                  onClick={() => p.onSelect(st.id)}
                                  title="乐器轨,与源同步;拖到 clip 或点「→pad」"
                                >
                                  <span className="dot" />
                                  <span className="sn">{STEM_LABEL[st.stemKind ?? ''] ?? st.stemKind}</span>
                                  <button className="pl2" onClick={(e) => { e.stopPropagation(); p.onAudition(st.id); }}>{playIcon(st.id)}</button>
                                  <button className="topad2" title="放到下一个空 pad" onClick={(e) => { e.stopPropagation(); p.onAssignNext(st.id); }}>→pad</button>
                                  {p.onDeleteSound && <button className="vdel2" title="删除这条分轨(软删)" onClick={(e) => { e.stopPropagation(); p.onDeleteSound!(st.id); }}>×</button>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
