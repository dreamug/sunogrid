// §43 一次性迁移:把存量偏移量从「各自旧采样率域」统一搬到 CANONICAL_SR(48000)域。
// 见 PRODUCT.md §43.3。默认 dry-run(只打印决策);加 --apply 才写库(先备份)。
//   node --env-file=.env scripts/migrate-sr-domain.mjs          # dry-run
//   node --env-file=.env scripts/migrate-sr-domain.mjs --apply  # 写库(自动备份到 scripts/.sr-migration-backup.json)
//
// 域恢复:用「公式」rawSR = (end-start)*sourceBpm/(bars*4*60) —— 它直接量出"让该区间 = bars 个 sourceBpm 小节"的采样率,
// 即偏移量被创作时的采样率(与资产文件原生 SR 无关:gen/upload 在设备 SR 下分析,文件却可能是别的 SR)。
// 只在 rawSR 干净吸附到标准率(±4%)时才动;拉伸过的 clip 公式失真 → 退回其 Sound 种子的域;再不行 → 跳过(保守,不误伤已是 48k 的数据)。
import { PrismaClient } from '@prisma/client';
import { writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const CANON = 48000;
const STD = [44100, 48000];
const APPLY = process.argv.includes('--apply');
const db = new PrismaClient();
const here = path.dirname(fileURLToPath(import.meta.url));

const rawSR = (start, end, bars, bpm) => (bars > 0 && bpm > 0 && Number.isFinite(start) && Number.isFinite(end)) ? ((end - start) * bpm) / (bars * 4 * 60) : null;
function snapClean(raw) { // 吸附到最近标准率;±4% 内才算"干净"(44.1k/48k 相距 8.8%,±4% 不会跨类)
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return { sr: null };
  let best = STD[0]; for (const r of STD) if (Math.abs(r - raw) < Math.abs(best - raw)) best = r;
  return { sr: Math.abs(best - raw) / best <= 0.04 ? best : null, raw };
}
const R = (n, f) => Math.round(n * f);
const scaleWarp = (w, f) => ({ ...w, startSample: R(w.startSample, f), endSample: R(w.endSample, f), ...(Array.isArray(w.warpPts) ? { warpPts: w.warpPts.map((p) => ({ ...p, src: R(p.src, f) })) } : {}) });
const scaleAnalysis = (a, f) => ({ ...a, startSample: R(a.startSample, f), endSample: R(a.endSample, f), ...(Array.isArray(a.onsets) ? { onsets: a.onsets.map((o) => R(o, f)) } : {}) });

const sounds = await db.sound.findMany({ select: { id: true, assetId: true, sourceBpm: true, warp: true, analysis: true, name: true } });
const bpmBySound = new Map(sounds.map((s) => [s.id, s.sourceBpm]));

// 每个 Sound 种子的域(公式)
const soundDomain = new Map();
for (const s of sounds) {
  const w = s.warp || {};
  if (typeof w.startSample !== 'number' || typeof w.endSample !== 'number' || typeof w.bars !== 'number') { soundDomain.set(s.id, { sr: null, reason: 'no-warp' }); continue; }
  const { sr, raw } = snapClean(rawSR(w.startSample, w.endSample, w.bars, s.sourceBpm));
  soundDomain.set(s.id, { sr, raw, reason: sr ? 'formula' : 'unclean' });
}

const soundOps = [], clipOps = [], skips = [];
const tally = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const soundByDomain = new Map(), clipByDomain = new Map();

for (const s of sounds) {
  const d = soundDomain.get(s.id);
  if (!d.sr) { if (d.reason === 'unclean') skips.push({ t: 'sound', id: s.id, name: s.name?.slice(0, 24), raw: Math.round(d.raw ?? 0), bpm: s.sourceBpm }); continue; }
  tally(soundByDomain, d.sr);
  if (d.sr === CANON) continue; // 已是 48k 域 → 不动
  const f = CANON / d.sr;
  soundOps.push({ id: s.id, domain: d.sr, factor: f, warp: scaleWarp(s.warp, f), analysis: s.analysis ? scaleAnalysis(s.analysis, f) : null, _orig: { warp: s.warp, analysis: s.analysis } });
}

const clips = await db.clip.findMany({ select: { id: true, soundId: true, startSample: true, endSample: true, bars: true, warpPts: true } });
for (const c of clips) {
  const bpm = bpmBySound.get(c.soundId);
  let domain = null, via = null;
  const fm = snapClean(rawSR(c.startSample, c.endSample, c.bars, bpm));
  if (fm.sr) { domain = fm.sr; via = 'formula'; }
  else { const sd = soundDomain.get(c.soundId); if (sd?.sr) { domain = sd.sr; via = 'sound-seed'; } } // 拉伸 clip 公式失真 → 退回种子域
  if (!domain) { skips.push({ t: 'clip', id: c.id, soundId: c.soundId, raw: Math.round(fm.raw ?? 0), bpm }); continue; }
  tally(clipByDomain, domain);
  if (domain === CANON) continue;
  const f = CANON / domain;
  const warpPts = Array.isArray(c.warpPts) && c.warpPts.length ? c.warpPts.map((p) => ({ ...p, src: R(p.src, f) })) : c.warpPts;
  clipOps.push({ id: c.id, domain, via, factor: f, startSample: R(c.startSample, f), endSample: R(c.endSample, f), warpPts, _orig: { startSample: c.startSample, endSample: c.endSample, warpPts: c.warpPts } });
}

console.log('=== §43 SR-domain migration (%s) ===', APPLY ? 'APPLY' : 'DRY-RUN');
console.log('sounds: total %d | seed-domain dist %o | to scale (non-48k) %d', sounds.length, Object.fromEntries(soundByDomain), soundOps.length);
console.log('clips:  total %d | domain dist %o | to scale (non-48k) %d', clips.length, Object.fromEntries(clipByDomain), clipOps.length);
console.log('skipped (unclean, left untouched): %d  (sounds %d / clips %d)', skips.length, skips.filter((x) => x.t === 'sound').length, skips.filter((x) => x.t === 'clip').length);
console.log('\nsound scales (sample):'); soundOps.slice(0, 8).forEach((o) => console.log('  %s dom=%d x%s  warp.end %d->%d', o.id.slice(-6), o.domain, o.factor.toFixed(4), o._orig.warp.endSample, o.warp.endSample));
console.log('clip scales (sample):'); clipOps.slice(0, 8).forEach((o) => console.log('  %s dom=%d via=%s  end %d->%d', o.id.slice(-6), o.domain, o.via, o._orig.startSample !== undefined ? o._orig.endSample : '?', o.endSample));
if (skips.length) { console.log('skips (sample):'); skips.slice(0, 12).forEach((x) => console.log('  %o', x)); }

if (!APPLY) { console.log('\n(dry-run) 未写库。确认无误后加 --apply。'); await db.$disconnect(); process.exit(0); }

// —— APPLY:先备份,再写 ——
const backup = { at: new Date().toISOString(), sounds: soundOps.map((o) => ({ id: o.id, ...o._orig })), clips: clipOps.map((o) => ({ id: o.id, ...o._orig })) };
const backupPath = path.join(here, '.sr-migration-backup.json');
await writeFile(backupPath, JSON.stringify(backup, null, 2));
console.log('\nbackup → %s (%d sounds, %d clips)', backupPath, backup.sounds.length, backup.clips.length);

let ns = 0, nc = 0;
for (const o of soundOps) { await db.sound.update({ where: { id: o.id }, data: { warp: o.warp, ...(o.analysis ? { analysis: o.analysis } : {}) } }); ns++; }
for (const o of clipOps) { await db.clip.update({ where: { id: o.id }, data: { startSample: o.startSample, endSample: o.endSample, ...(o.warpPts !== undefined ? { warpPts: o.warpPts } : {}) } }); nc++; }
console.log('APPLIED: %d sounds, %d clips scaled to 48k domain.', ns, nc);
await db.$disconnect();
