'use client';
// 左列:Suno 生成(控件)+ 素材库(两级卡片:一级=全混变体,二级=分离出的乐器轨,凹陷一层、可折叠)。
import { useState, Fragment } from 'react';
import type { GenView, LoopView } from '@/contracts/studioViews';
import { SunoStatus, type SunoConnState } from '@/studio/ui/SunoStatus';
import { PromptAssist } from '@/studio/ui/PromptAssist';
import { TransportIcon, SparkleIcon } from '@/studio/ui/glyphs';

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
  onUpload?: (files: FileList) => void;  // §27 本地样本上传(wav/mp3)
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
  kick: 'Kick', snare: 'Snare', toms: 'Toms', cymbals: 'Cymbals', hihat: 'Hats', // §29 鼓二段拆
};
const GEN_STATUS: Record<string, string> = { generating: 'Generating…', streaming: 'Rendering…', uploading: 'Uploading…', detecting: 'Detecting…', chopping: 'Chopping…', complete: 'Done', failed: 'Failed' };
// ② 生成阶段条:Suno 私有接口阶段 → 生成 → 渲染 →(长素材 §33)切块 → 到达(变体流式入库)。
const GEN_PHASES: { key: string; label: string }[] = [{ key: 'generating', label: 'Generate' }, { key: 'streaming', label: 'Render' }, { key: 'complete', label: 'Done' }];
const GEN_ORDER: Record<string, number> = { generating: 0, streaming: 1, complete: 2 };
const GEN_PHASES_CHOP: { key: string; label: string }[] = [{ key: 'generating', label: 'Generate' }, { key: 'streaming', label: 'Render' }, { key: 'chopping', label: 'Chop' }, { key: 'complete', label: 'Done' }];
const GEN_ORDER_CHOP: Record<string, number> = { generating: 0, streaming: 1, chopping: 2, complete: 3 };
// §27 上传阶段条(平行于生成):上传 → 检测 →(长素材 §33)切块 → 到达。
const UPLOAD_PHASES: { key: string; label: string }[] = [{ key: 'uploading', label: 'Upload' }, { key: 'detecting', label: 'Detect' }, { key: 'complete', label: 'Done' }];
const UPLOAD_ORDER: Record<string, number> = { uploading: 0, detecting: 1, complete: 2 };
const UPLOAD_PHASES_CHOP: { key: string; label: string }[] = [{ key: 'uploading', label: 'Upload' }, { key: 'detecting', label: 'Detect' }, { key: 'chopping', label: 'Chop' }, { key: 'complete', label: 'Done' }];
const UPLOAD_ORDER_CHOP: Record<string, number> = { uploading: 0, detecting: 1, chopping: 2, complete: 3 };
const fmtBars = (b: number) => (Number.isInteger(b) ? `${b}` : b.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
const fmtDur = (s: number) => (s >= 10 ? Math.round(s) + 's' : s.toFixed(1) + 's');
// 生成块头部参数行:模式 · 生成BPM · 调 · Loop(advanced 无 loop 概念)。
function genParams(g: GenView): string {
  if (g.source === 'upload' && (g.status === 'uploading' || g.status === 'detecting')) return 'Detecting tempo + key…';
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
  const [assistOpen, setAssistOpen] = useState(false); // §35 AI 提示词助手浮层开关
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

  // 一条素材(歌/块)的 stem 通栏块:真 stem(stemKind 非空)才进,块(sliceIndex)不算。drums 可再拆 kit(§29)。
  const renderStems = (host: LoopView) => {
    const stems = (host.stems ?? []).filter((k) => k.stemKind != null);
    if (!stems.length) return null;
    const open = !collapsed[host.id];
    const sepBusy = host.stemStatus === 'separating';
    return (
      <div className="stemblk">
        <div className="stemblk-h" onClick={() => toggle(host.id)}>
          <span className="cv">{open ? '▾' : '▸'}</span>
          <span className="lbl">Stems</span>
          <span className="cnt">{stems.length} stems{open ? '' : ' · collapsed'}</span>
          <button className="re" disabled={sepBusy || p.stemServiceUp === false} title={p.stemServiceUp === false ? 'Separation service not running' : 'Re-separate'} onClick={(e) => { e.stopPropagation(); p.onSeparate(host.id); }}>↻</button>
        </div>
        {open && stems.map((st) => {
          const isDrums = st.stemKind === 'drums'; // §29:只有 drums 能再拆 kit
          const kit = (st.stems ?? []).filter((k) => k.stemKind != null);
          const hasKit = kit.length > 0;
          const kitSep = st.stemStatus === 'separating';
          const canKit = isDrums && !hasKit && !kitSep && st.stemStatus !== 'failed'; // 结构可分;服务是否在跑由按钮 disabled 控制
          return (
            <Fragment key={st.id}>
              <div className={'srow' + (canKit ? ' can-sep' : '') + (p.selectedLoopId === st.id ? ' vsel' : '')} style={{ ['--c']: st.color } as React.CSSProperties} {...drag(st.id)} onClick={() => p.onSelect(st.id)} title="Stem · drag to track / pad">
                <button className={'pl' + (p.warmingId === st.id || (p.selectedLoopId === st.id && p.previewing) ? ' on' : '')} title="Preview" onClick={(e) => { e.stopPropagation(); p.onAudition(st.id); }}>{playInner(st.id)}</button>
                <span className="sdot" />
                <span className="sname">{STEM_LABEL[st.stemKind ?? ''] ?? st.stemKind}</span>
                {canKit && <button className="vsep sm" disabled={p.stemServiceUp === false} title={p.stemServiceUp === false ? 'Separation service not running — start stem-service' : 'Split drum kit (kick / snare / toms / cymbals)'} onClick={(e) => { e.stopPropagation(); p.onSeparate(st.id); }}>Split kit</button>}
                {hasKit && <button className="re" disabled={kitSep || p.stemServiceUp === false} title={p.stemServiceUp === false ? 'Separation service not running' : 'Re-split kit'} onClick={(e) => { e.stopPropagation(); p.onSeparate(st.id); }}>↻</button>}
              </div>
              {kitSep && (<div className="srow-busy" aria-busy="true"><span className="sg-spin sm" aria-hidden="true" /><span>Splitting kit · local Demucs</span></div>)}
              {!kitSep && st.stemStatus === 'failed' && !hasKit && (<div className="srow-note" title="Tap to retry" onClick={(e) => { e.stopPropagation(); p.onSeparate(st.id); }}>Kit split failed · tap to retry</div>)}
              {hasKit && kit.map((k) => (
                <div key={k.id} className={'srow srow-sub' + (p.selectedLoopId === k.id ? ' vsel' : '')} style={{ ['--c']: k.color } as React.CSSProperties} {...drag(k.id)} onClick={() => p.onSelect(k.id)} title="Drum piece · drag to track / pad">
                  <button className={'pl' + (p.warmingId === k.id || (p.selectedLoopId === k.id && p.previewing) ? ' on' : '')} title="Preview" onClick={(e) => { e.stopPropagation(); p.onAudition(k.id); }}>{playInner(k.id)}</button>
                  <span className="sdot" />
                  <span className="sname">{STEM_LABEL[k.stemKind ?? ''] ?? k.stemKind}</span>
                </div>
              ))}
            </Fragment>
          );
        })}
      </div>
    );
  };

  // §33 块通栏块:长素材切出的整小节块,挂在歌下面(复用 stemblk/srow 语汇)。每块可拖/选/试听/再分 stem。
  const renderBlocks = (host: LoopView, blocks: LoopView[]) => {
    const open = !collapsed[host.id];
    return (
      <div className="stemblk">
        <div className="stemblk-h" onClick={() => toggle(host.id)}>
          <span className="cv">{open ? '▾' : '▸'}</span>
          <span className="lbl">Blocks</span>
          <span className="cnt">{blocks.length} blocks{open ? '' : ' · collapsed'}</span>
        </div>
        {open && blocks.map((bk) => {
          const bSep = bk.stemStatus === 'separating';
          const bStems = (bk.stems ?? []).filter((k) => k.stemKind != null);
          const bHasStems = bStems.length > 0;
          const bSepReady = !bSep && !bHasStems && bk.stemStatus !== 'failed'; // 结构可分;服务是否在跑由按钮 disabled 控制
          const label = bk.sectionLabel || `Block ${(bk.sliceIndex ?? 0) + 1}`;
          return (
            <Fragment key={bk.id}>
              <div className={'srow' + (bSepReady ? ' can-sep' : '') + (p.selectedLoopId === bk.id ? ' vsel' : '')} style={{ ['--c']: bk.color } as React.CSSProperties} {...drag(bk.id)} onClick={() => p.onSelect(bk.id)} title="Block · click to edit · drag to track / pad">
                <button className={'pl' + (p.warmingId === bk.id || (p.selectedLoopId === bk.id && p.previewing) ? ' on' : '')} title="Preview" onClick={(e) => { e.stopPropagation(); p.onAudition(bk.id); }}>{playInner(bk.id)}</button>
                <span className="sdot" />
                <span className="sname">{label}</span>
                <span className="vmeta">{fmtBars(bk.bars)} bar</span>
                {bSepReady && <button className="vsep sm" disabled={p.stemServiceUp === false} title={p.stemServiceUp === false ? 'Separation service not running — start stem-service' : 'Separate stems (local Demucs)'} onClick={(e) => { e.stopPropagation(); p.onSeparate(bk.id); }}>Separate</button>}
              </div>
              {bSep && (<div className="srow-busy" aria-busy="true"><span className="sg-spin sm" aria-hidden="true" /><span>Separating · local Demucs</span></div>)}
              {!bSep && bk.stemStatus === 'failed' && !bHasStems && (<div className="srow-note" title="Tap to retry" onClick={(e) => { e.stopPropagation(); p.onSeparate(bk.id); }}>Separation failed · tap to retry</div>)}
              {bHasStems && renderStems(bk)}
            </Fragment>
          );
        })}
      </div>
    );
  };

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
          <div className="gen-ta-wrap">
            <textarea
              className="gen-ta"
              rows={3}
              value={p.genPrompt}
              onChange={(e) => p.onGenPrompt(e.target.value)}
              placeholder={p.genMode === 'advanced' ? 'Describe the style / song (full instrumental)' : 'Describe the loop to generate (any style)'}
            />
            <button type="button" className={'gen-ai' + (assistOpen ? ' on' : '')} onClick={() => setAssistOpen((v) => !v)} title="Write a Suno prompt from plain language (AI)" aria-label="AI prompt assist"><SparkleIcon /></button>
            {assistOpen && (
              <PromptAssist
                mode={p.genMode}
                bpm={p.genBpm}
                musicalKey={p.genKey}
                onApply={p.onGenPrompt}
                onClose={() => setAssistOpen(false)}
              />
            )}
          </div>
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
        <div className="br-h">
          <span className="sec-l">Library</span>
          <span className="n">{gens.length}</span>
          {p.onUpload && (
            <label className="up-btn" title="Upload your own wav / mp3 — we'll detect tempo + key">
              <input type="file" accept=".wav,.mp3,audio/wav,audio/mpeg" multiple hidden onChange={(e) => { if (e.target.files?.length) p.onUpload!(e.target.files); e.target.value = ''; }} />
              <span className="up-ic" aria-hidden="true">⬆</span> Upload
            </label>
          )}
        </div>
        <div className="lib-list">
          {gens.map((g) => {
            const isUp = g.source === 'upload';
            const busy = g.status === 'generating' || g.status === 'streaming' || g.status === 'uploading' || g.status === 'detecting' || g.status === 'chopping';
            // §33:Song(advanced)或正在切块 → 阶段条多一段 Chop。
            const willChop = g.mode === 'advanced' || g.status === 'chopping';
            const phases = isUp ? (willChop ? UPLOAD_PHASES_CHOP : UPLOAD_PHASES) : (willChop ? GEN_PHASES_CHOP : GEN_PHASES);
            const order = isUp ? (willChop ? UPLOAD_ORDER_CHOP : UPLOAD_ORDER) : (willChop ? GEN_ORDER_CHOP : GEN_ORDER);
            return (
              <div key={g.id} className={'gencard' + (isUp ? ' up' : '')}>
                <div className="gc-head">
                  <div className="gc-top">
                    <span className={'gdot ' + g.status} title={GEN_STATUS[g.status]} />
                    {isUp && <span className="up-tag" title="Uploaded sample" aria-hidden="true">⬆</span>}
                    <span className="gc-prompt" title={g.prompt}>{g.prompt}</span>
                  </div>
                  <div className="gc-params">{genParams(g)}</div>
                </div>

                {busy && (
                  <div className="gen-busy" aria-busy="true">
                    <div className="gstep">
                      {phases.map((ph, i) => {
                        const cur = order[g.status] ?? 0;
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
                      <span>{
                        g.status === 'uploading' ? 'Uploading file…'
                          : g.status === 'detecting' ? 'Detecting tempo + key…'
                          : g.status === 'chopping' ? 'Chopping into blocks…'
                          : g.sounds.length > 0 ? `${g.sounds.length}/2 variants in` : 'Generating 2 variants…'
                      }</span>
                      {p.onCancelGen && <button className="gb-btn danger gcancel" onClick={() => p.onCancelGen!(g.id)} title={isUp ? 'Cancel & discard this upload' : 'Cancel & discard this generation'}>Cancel</button>}
                    </div>
                  </div>
                )}
                {g.status === 'failed' && (
                  <div className="gb-fail">
                    <div className="gb-err" title={g.error}>{g.error || 'Generation failed'}</div>
                    {(p.onRetryGen || p.onDeleteGen) && (
                      <div className="gb-acts">
                        {p.onRetryGen && !isUp && <button className="gb-btn" onClick={() => p.onRetryGen!(g.id)}>↻ Retry</button>}
                        {p.onDeleteGen && <button className="gb-btn danger" onClick={() => p.onDeleteGen!(g.id)}>Delete</button>}
                      </div>
                    )}
                  </div>
                )}

                {g.sounds.map((s, i) => {
                  const kids = s.stems ?? [];
                  // §33 子 sound 两类:块(sliceIndex 非空,挂歌下)vs 乐器 stem(stemKind 非空)。
                  const blocks = kids.filter((k) => k.sliceIndex != null).sort((a, b) => (a.sliceIndex ?? 0) - (b.sliceIndex ?? 0));
                  const stems = kids.filter((k) => k.sliceIndex == null && k.stemKind != null);
                  const separating = s.stemStatus === 'separating';
                  const hasBlocks = blocks.length > 0;
                  const hasStems = stems.length > 0;
                  // 「结构上可分」(无 stem/块、不在分、未失败)与「服务在跑」拆开:服务没跑时按钮照样渲染、只灰掉,不再整个消失。
                  const sepReady = !separating && !hasStems && !hasBlocks && s.stemStatus !== 'failed';
                  const serviceDown = p.stemServiceUp === false;
                  return (
                    <div key={s.id} className="vcard">
                      {/* 变体行(主角) */}
                      <div
                        className={'vrow' + (sepReady ? ' can-sep' : '') + (p.selectedLoopId === s.id ? ' vsel' : '')}
                        {...drag(s.id)}
                        onClick={() => p.onSelect(s.id)}
                        title="Click to edit (Del to delete) · drag to track / pad"
                      >
                        <button className={'pl' + (p.warmingId === s.id || (p.selectedLoopId === s.id && p.previewing) ? ' on' : '')} title="Preview" onClick={(e) => { e.stopPropagation(); p.onAudition(s.id); }}>{playInner(s.id)}</button>
                        <MiniWave peaks={p.peaks?.[s.id]} className="vwave" />
                        <span className="vname">#{i + 1}</span>
                        <span className="vmeta">{fmtDur(s.durationSec)} · {fmtBars(s.bars)} bar</span>
                        {sepReady && <button className="vsep" disabled={serviceDown} title={serviceDown ? 'Separation service not running — start stem-service' : 'Separate stems (local Demucs)'} onClick={(e) => { e.stopPropagation(); p.onSeparate(s.id); }}>Separate</button>}
                      </div>

                      {separating && (
                        <div className="vc-sepbusy" aria-busy="true">
                          <div className="vc-sepbusy-h"><span className="sg-spin sm" aria-hidden="true" /><span>Separating · local Demucs ≈2× realtime</span></div>
                          <div className="gb-bar"><i /></div>
                        </div>
                      )}
                      {!separating && s.stemStatus === 'failed' && !hasStems && !hasBlocks && (
                        <div className="vc-note err" title="Tap to retry" onClick={(e) => { e.stopPropagation(); p.onSeparate(s.id); }}>Separation failed · tap to retry</div>
                      )}

                      {/* §33 块组(挂歌下)/ 否则乐器分离组 */}
                      {hasBlocks ? renderBlocks(s, blocks) : renderStems(s)}
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
