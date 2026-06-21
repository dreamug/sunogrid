'use client';
// 左列:Suno 生成(控件)+ 素材库(两级卡片:一级=全混变体,二级=分离出的乐器轨,凹陷一层、可折叠)。
import { useState } from 'react';
import type { GenView } from '../useLoopMachine';
import { SunoStatus, type SunoConnState } from '@/studio/ui/SunoStatus';
import { TransportIcon } from '@/studio/ui/glyphs';

interface Props {
  gens: GenView[];
  selectedLoopId: string | null;
  previewing: boolean;
  warmingId?: string | null; // ⑥ 正在 build buffer 的 sound/stem id → ▶ 转圈(命中缓存不传)
  peaks?: Record<string, number[]>; // 库素材波形缩略图:sound/stem id → 峰值(StudioApp 懒解码;无则画基线)
  masterBpm: number;
  genPrompt: string;
  genMode: 'sound' | 'advanced';
  genLoop: boolean;
  genBpm: number;                 // 生成 BPM(持久化独立值;主 BPM 变会单向透传一次);见 §4.1
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
  onCancelGen?: (id: string) => void;  // 取消生成中的整组(随时干掉,不管落了几条变体)
  onDeleteGen?: (id: string) => void;  // 删除整组生成
  onDeleteSound?: (id: string) => void; // 软删单条素材/分轨
  stemServiceUp: boolean | null;
}

const STEM_LABEL: Record<string, string> = {
  drums: 'Drums', bass: 'Bass', other: 'Other', vocals: 'Vocals', guitar: 'Guitar', piano: 'Keys',
};
const GEN_STATUS: Record<string, string> = { generating: 'Generating…', streaming: 'Rendering…', complete: 'Done', failed: 'Failed' };
// ② 生成阶段条:Suno 私有接口阶段 → 生成 → 渲染 → 到达(变体流式入库)。
const GEN_PHASES: { key: string; label: string }[] = [{ key: 'generating', label: 'Generate' }, { key: 'streaming', label: 'Render' }, { key: 'complete', label: 'Done' }];
const GEN_ORDER: Record<string, number> = { generating: 0, streaming: 1, complete: 2 };
const fmtBars = (b: number) => (Number.isInteger(b) ? `${b}` : b.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
const fmtDur = (s: number) => (s >= 10 ? Math.round(s) + 's' : s.toFixed(1) + 's');
// 生成块头部参数行:模式 · 生成BPM · 调 · Loop(advanced 无 loop 概念)。
function genParams(g: GenView): string {
  const parts = [g.mode === 'advanced' ? 'Song' : 'Sound'];
  if (g.bpm) parts.push(g.bpm + ' BPM');
  parts.push(g.musicalKey || 'Any');
  if (g.mode !== 'advanced') parts.push(g.loop === false ? 'One-shot' : 'Loop');
  return parts.join(' · ');
}
// 迷你波形:复用 StudioApp 的 Wave 路径逻辑(镜像填充);peaks 未到时画一条静默基线。
function MiniWave({ peaks, className }: { peaks?: number[]; className: string }) {
  const pk = peaks && peaks.length >= 2 ? peaks : null;
  if (!pk) return <svg className={className + ' empty'} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M0 50 L100 50" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>;
  const n = pk.length, sx = 100 / (n - 1);
  const yT = (p: number) => (50 - Math.max(p, 0.04) * 46).toFixed(1);
  const yB = (p: number) => (50 + Math.max(p, 0.04) * 46).toFixed(1);
  let d = `M0 ${yT(pk[0])}`;
  for (let i = 1; i < n; i++) d += `L${(i * sx).toFixed(1)} ${yT(pk[i])}`;
  for (let i = n - 1; i >= 0; i--) d += `L${(i * sx).toFixed(1)} ${yB(pk[i])}`;
  return <svg className={className} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={d + 'Z'} fill="currentColor" /></svg>;
}

// 八度迷你键盘选 key(根音)+ 大/小调 → MusicalKey('C'…'B' / 加 'm')。'' = Any。深色版,几何见 .kbd(globals.css)。
const WHITE = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
// 黑键 left:几何与 .kbd 同步(键盘列定宽 154px / 白键 22px / 黑键 16px,居中在白键缝上),见 globals.css。
const BLACK: { r: string; left: number }[] = [
  { r: 'C#', left: 14 }, { r: 'D#', left: 36 }, { r: 'F#', left: 80 }, { r: 'G#', left: 102 }, { r: 'A#', left: 124 },
];
function KeyKeyboard({ value, onChange }: { value: string; onChange: (k: string) => void }) {
  const isMinor = value.endsWith('m');
  const root = isMinor ? value.slice(0, -1) : value; // '' = Any
  const suffix = isMinor ? 'm' : '';
  const pick = (r: string) => onChange(r === root ? '' : r + suffix);     // 选根音(保持大/小调);再点已选 = 清回 Any
  const setMinor = (min: boolean) => { if (root) onChange(root + (min ? 'm' : '')); }; // 无根音时不动
  const qLabel = (r: string) => r + (suffix ? ' Minor' : ' Major');
  return (
    <div className="gkey-tbl" title="Key: click a key to pick the root, then major/minor; click the selected key again to clear (= Any). Sound uses Suno's Key field; Song folds it into the style.">
      <div className="gk-side">
        <div className="gk-top">
          <span className="gk-l">Key</span>
          <span className="gk-cur">{value || 'Any'}</span>
        </div>
        <div className="gk-qual">
          <button type="button" className={root && !isMinor ? 'on' : ''} aria-pressed={!!root && !isMinor} title="Major" onClick={() => setMinor(false)}>Maj</button>
          <button type="button" className={isMinor ? 'on' : ''} aria-pressed={isMinor} title="Minor" onClick={() => setMinor(true)}>Min</button>
        </div>
      </div>
      <div className="kbd">
        <div className="wrow">
          {WHITE.map((r) => (
            <button type="button" key={r} className={'wk' + (root === r ? ' ksel' : '')} title={qLabel(r)} onClick={() => pick(r)}>{r}</button>
          ))}
        </div>
        {BLACK.map((b) => (
          <button type="button" key={b.r} className={'bk' + (root === b.r ? ' ksel' : '')} style={{ left: b.left }} title={qLabel(b.r)} onClick={() => pick(b.r)}>{root === b.r ? b.r : ''}</button>
        ))}
      </div>
    </div>
  );
}

export function LoopManager(p: Props) {
  // 变体全被软删后的 complete 空壳不再展示(避免无内容、无操作的孤卡)。
  const gens = p.gens.filter((g) => !(g.status === 'complete' && g.sounds.length === 0));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}); // 变体 id → 二级收起
  const [sunoState, setSunoState] = useState<SunoConnState>('checking'); // 连接灯 → 红灯时禁用生成
  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  // ▶ 三态:warm-up=转圈、在响=均衡条(点了停)、空闲=▶。
  const playInner = (id: string) => {
    if (p.warmingId === id) return <span className="sg-spin sm" aria-hidden="true" />;
    if (p.selectedLoopId === id && p.previewing) return <span className="sg-eq" aria-hidden="true"><span /><span /><span /></span>;
    return <TransportIcon size={11} />;
  };
  const drag = (id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'copy'; p.onDragSound?.(id); },
  });

  return (
    <>
      <section className="br-sec">
        <div className="gen-body">
          <div className="gen-top">
            <div className="seg gen-mode">
              <button className={p.genMode === 'sound' ? 'on' : ''} onClick={() => p.onGenMode('sound')} title="Short loop / sample (Suno Sounds)">Sound</button>
              <button className={p.genMode === 'advanced' ? 'on' : ''} onClick={() => p.onGenMode('advanced')} title="Full instrumental (Suno's song mode); trim a loop after it lands">Song</button>
            </div>
            <div className="gen-top-r">
              {p.genMode === 'sound' && (
                <button type="button" className={'gloop' + (p.genLoop ? ' on' : '')} aria-pressed={p.genLoop} title="Generate as a loop (otherwise a one-shot sample)" onClick={() => p.onGenLoop(!p.genLoop)}>Loop</button>
              )}
              <label className="gbpm" title="Generation BPM; syncs from master BPM once when it changes, editable after">
                <input type="number" min={40} max={220} value={p.genBpm} onChange={(e) => p.onGenBpm(Number(e.target.value))} />
              </label>
              <SunoStatus onState={setSunoState} />
            </div>
          </div>
          <textarea
            className="gen-ta"
            rows={3}
            value={p.genPrompt}
            onChange={(e) => p.onGenPrompt(e.target.value)}
            placeholder={p.genMode === 'advanced' ? 'Describe the style / song (full instrumental)' : 'Describe the loop to generate (any style)'}
          />
          <div className="gen-keyrow">
            <KeyKeyboard value={p.genKey} onChange={p.onGenKey} />
            <button
              className="gen-go"
              onClick={p.onGenerate}
              disabled={sunoState === 'problem'}
              title={sunoState === 'problem' ? 'Suno not connected — check the status light before generating' : 'Generate → library'}
            >GO</button>
          </div>
        </div>
      </section>

      <section className="br-sec" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="br-h"><span className="sec-l">Library</span><span className="n">{gens.length}</span></div>
        <div className="lib-list">
          {gens.length === 0 && <div className="muted small" style={{ padding: '6px 2px' }}>Nothing yet — hit Generate above</div>}
          {gens.map((g) => {
            const busy = g.status === 'generating' || g.status === 'streaming';
            return (
              <div key={g.id} className="gencard">
                <div className="gc-head">
                  <div className="gc-top">
                    <span className={'gdot ' + g.status} title={GEN_STATUS[g.status]} />
                    <span className="gc-prompt" title={g.prompt}>{g.prompt}</span>
                  </div>
                  <div className="gc-params">{genParams(g)}</div>
                </div>

                {busy && (
                  <div className="gen-busy" aria-busy="true">
                    <div className="gstep">
                      {GEN_PHASES.map((ph, i) => {
                        const cur = GEN_ORDER[g.status] ?? 0;
                        return (
                          <span key={ph.key} className="gstep-i">
                            {i > 0 && <i className="gsep">›</i>}
                            <span className={'gstep-b' + (cur > i ? ' done' : cur === i ? ' on' : '')}>{ph.label}</span>
                          </span>
                        );
                      })}
                    </div>
                    <div className="gb-bar"><i /></div>
                    <div className="gvar-row">
                      <span className="sg-spin sm" aria-hidden="true" />
                      <span>{g.sounds.length > 0 ? `${g.sounds.length}/2 variants in` : 'Generating 2 variants…'}</span>
                      {p.onCancelGen && <button className="gb-btn danger gcancel" onClick={() => p.onCancelGen!(g.id)} title="Cancel & discard this generation">Cancel</button>}
                    </div>
                  </div>
                )}
                {g.status === 'failed' && (
                  <div className="gb-fail">
                    <div className="gb-err" title={g.error}>{g.error || 'Generation failed'}</div>
                    {(p.onRetryGen || p.onDeleteGen) && (
                      <div className="gb-acts">
                        {p.onRetryGen && <button className="gb-btn" onClick={() => p.onRetryGen!(g.id)}>↻ Retry</button>}
                        {p.onDeleteGen && <button className="gb-btn danger" onClick={() => p.onDeleteGen!(g.id)}>Delete</button>}
                      </div>
                    )}
                  </div>
                )}

                {g.sounds.map((s, i) => {
                  const separating = s.stemStatus === 'separating';
                  const stems = s.stems ?? [];
                  const hasStems = stems.length > 0;
                  const open = !collapsed[s.id];
                  const canSep = !separating && !hasStems && s.stemStatus !== 'failed' && p.stemServiceUp !== false;
                  return (
                    <div key={s.id} className="vcard">
                      {/* 变体行(主角) */}
                      <div
                        className={'vrow' + (canSep ? ' can-sep' : '') + (p.selectedLoopId === s.id ? ' vsel' : '')}
                        {...drag(s.id)}
                        onClick={() => p.onSelect(s.id)}
                        title="Click to edit (Del to delete) · drag to track / pad"
                      >
                        <button className={'pl' + (p.warmingId === s.id || (p.selectedLoopId === s.id && p.previewing) ? ' on' : '')} title="Preview" onClick={(e) => { e.stopPropagation(); p.onAudition(s.id); }}>{playInner(s.id)}</button>
                        <MiniWave peaks={p.peaks?.[s.id]} className="vwave" />
                        <span className="vname">#{i + 1}</span>
                        <span className="vmeta">{fmtDur(s.durationSec)} · {fmtBars(s.bars)} bar</span>
                        {canSep && <button className="vsep" title="Separate stems (local Demucs)" onClick={(e) => { e.stopPropagation(); p.onSeparate(s.id); }}>Separate</button>}
                      </div>

                      {separating && (
                        <div className="vc-sepbusy" aria-busy="true">
                          <div className="vc-sepbusy-h"><span className="sg-spin sm" aria-hidden="true" /><span>Separating · local Demucs ≈2× realtime</span></div>
                          <div className="gb-bar"><i /></div>
                        </div>
                      )}
                      {!separating && s.stemStatus === 'failed' && !hasStems && (
                        <div className="vc-note err" title="Tap to retry" onClick={(e) => { e.stopPropagation(); p.onSeparate(s.id); }}>Separation failed · tap to retry</div>
                      )}

                      {/* 分轨 = 通栏块 */}
                      {hasStems && (
                        <div className="stemblk">
                          <div className="stemblk-h" onClick={() => toggle(s.id)}>
                            <span className="cv">{open ? '▾' : '▸'}</span>
                            <span className="lbl">Stems</span>
                            <span className="cnt">{stems.length} stems{open ? '' : ' · collapsed'}</span>
                            <button
                              className="re"
                              disabled={separating || p.stemServiceUp === false}
                              title={p.stemServiceUp === false ? 'Separation service not running' : 'Re-separate'}
                              onClick={(e) => { e.stopPropagation(); p.onSeparate(s.id); }}
                            >↻</button>
                          </div>
                          {open && stems.map((st) => (
                            <div
                              key={st.id}
                              className={'srow' + (p.selectedLoopId === st.id ? ' vsel' : '')}
                              style={{ ['--c']: st.color } as React.CSSProperties}
                              {...drag(st.id)}
                              onClick={() => p.onSelect(st.id)}
                              title="Stem · drag to track / pad"
                            >
                              <button className={'pl' + (p.warmingId === st.id || (p.selectedLoopId === st.id && p.previewing) ? ' on' : '')} title="Preview" onClick={(e) => { e.stopPropagation(); p.onAudition(st.id); }}>{playInner(st.id)}</button>
                              <span className="sdot" />
                              <span className="sname">{STEM_LABEL[st.stemKind ?? ''] ?? st.stemKind}</span>
                            </div>
                          ))}
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
