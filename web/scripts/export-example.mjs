// §30 示例项目【导出】:把本地一个项目打包成 bundle(子图行 + 引用到的音频字节),供 import-example.mjs 导入线上。
// 只读本地 DB + 本地 storage,不改任何东西。设计见 PRODUCT.md §30、走法对齐 src/lib/forkProject.ts。
//
// 用法(在 web/ 目录跑):
//   node scripts/export-example.mjs <projectId> [输出目录]
//   例:node scripts/export-example.mjs cmqleehfh000xxy6pb9njt5hg ./out/example-bundle
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const db = new PrismaClient();

// storage 根 = web/storage(脚本在 web/scripts/,与 src/lib/storage.ts 的 ROOT 一致),不依赖 cwd。
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_ROOT = path.join(SCRIPT_DIR, '..', 'storage');
const storageAbs = (rel) => path.join(STORAGE_ROOT, rel);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const projectId = process.argv[2];
const outDir = path.resolve(process.argv[3] || './example-bundle');
if (!projectId) {
  console.error('用法: node scripts/export-example.mjs <projectId> [输出目录]');
  process.exit(1);
}

// 加载给定 soundId 集合 + 其 parent 祖先,返回【父在前、子在后】(对齐 forkProject.loadSoundsWithParents)。
async function loadSoundsWithParents(rootIds) {
  const byId = new Map();
  let frontier = [...new Set(rootIds)];
  while (frontier.length) {
    const rows = await db.sound.findMany({ where: { id: { in: frontier } } });
    const next = [];
    for (const r of rows) {
      if (byId.has(r.id)) continue;
      byId.set(r.id, r);
      if (r.parentSoundId && !byId.has(r.parentSoundId)) next.push(r.parentSoundId);
    }
    frontier = [...new Set(next)];
  }
  const all = [...byId.values()];
  const emitted = new Set();
  const ordered = [];
  while (ordered.length < all.length) {
    let progressed = false;
    for (const r of all) {
      if (emitted.has(r.id)) continue;
      const parentReady = !r.parentSoundId || !byId.has(r.parentSoundId) || emitted.has(r.parentSoundId);
      if (parentReady) { ordered.push(r); emitted.add(r.id); progressed = true; }
    }
    if (!progressed) { for (const r of all) if (!emitted.has(r.id)) ordered.push(r); break; }
  }
  return ordered;
}

async function main() {
  // 1) Project 壳。
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) { console.error(`找不到项目: ${projectId}`); process.exit(1); }

  // 2) Session→Instrument→Clip 树 + PadClip(对齐 forkProject 的 include / orderBy)。
  const sessions = await db.studioSession.findMany({
    where: { projectId },
    include: { instruments: { orderBy: { slot: 'asc' }, include: { clips: { orderBy: { orderIndex: 'asc' } } } } },
    orderBy: { index: 'asc' },
  });
  const pads = await db.padClip.findMany({ where: { projectId } });

  // 3) 收集被引用的 soundId → 连 parent 链加载。
  const refSounds = new Set();
  for (const s of sessions) for (const i of s.instruments) for (const c of i.clips) if (c.soundId) refSounds.add(c.soundId);
  for (const p of pads) if (p.sourceSoundId) refSounds.add(p.sourceSoundId);
  const sounds = await loadSoundsWithParents([...refSounds]);

  // 4) 收集全部被引用的 assetId(sound/clip/pad 的 assetId + collage 乐器 bakedAssetId)。
  const refAssets = new Set();
  for (const s of sounds) refAssets.add(s.assetId);
  for (const s of sessions) for (const i of s.instruments) {
    if (i.bakedAssetId) refAssets.add(i.bakedAssetId);
    for (const c of i.clips) refAssets.add(c.assetId);
  }
  for (const p of pads) refAssets.add(p.assetId);
  const assets = await db.asset.findMany({ where: { id: { in: [...refAssets] } } });

  // 5) 落 bundle:行写 bundle.json,音频字节按内容哈希写 audio/<sha>.mp3。
  mkdirSync(path.join(outDir, 'audio'), { recursive: true });
  const missing = [];
  const assetMeta = [];
  for (const a of assets) {
    const abs = storageAbs(a.path);
    if (!existsSync(abs)) { missing.push(a.path); continue; }
    const buf = readFileSync(abs);
    const hash = sha256(buf); // 内容哈希:dedup 键 + bundle 文件名,免去对 a.sha256 为 null 的依赖。
    const file = `${hash}.mp3`;
    writeFileSync(path.join(outDir, 'audio', file), buf);
    assetMeta.push({ id: a.id, kind: a.kind, contentType: a.contentType, bytes: buf.byteLength, sha256: hash, sourceUrl: a.sourceUrl ?? null, file });
  }
  if (missing.length) {
    console.error(`✗ 有 ${missing.length} 个 Asset 的音频文件在本地 storage 缺失,导出中止(否则线上播放会 404):`);
    for (const m of missing) console.error('   - ' + m);
    process.exit(1);
  }

  const bundle = {
    formatVersion: 1,
    exportedProjectId: project.id,
    project: {
      name: project.name,
      masterBpm: project.masterBpm,
      masterKey: project.masterKey,
      quantize: project.quantize,
      beatsPerBar: project.beatsPerBar,
      genPrefs: project.genPrefs ?? null,
      gridPrefs: project.gridPrefs ?? null,
      fx: project.fx ?? null,
      loopSong: project.loopSong,
      playMode: project.playMode,
      showAutomation: project.showAutomation,
      songLayoutVersion: project.songLayoutVersion ?? 1,
      songLanes: project.songLanes ?? null, // §37 命名 track
    },
    sounds: sounds.map((s) => ({
      id: s.id, name: s.name, mode: s.mode, sourceBpm: s.sourceBpm, musicalKey: s.musicalKey,
      durationSec: s.durationSec, sampleRate: s.sampleRate, channels: s.channels,
      analysis: s.analysis ?? null, warp: s.warp ?? null,
      parentSoundId: s.parentSoundId, stemKind: s.stemKind, stemStatus: s.stemStatus,
      assetId: s.assetId, tags: s.tags,
    })),
    sessions: sessions.map((s) => ({
      name: s.name, index: s.index, songLane: s.songLane ?? 0, songStartBar: s.songStartBar ?? 0,
      songAnchorIndex: s.songAnchorId ? (sessions.find((x) => x.id === s.songAnchorId)?.index ?? null) : null, // §37 sub 锚定:存锚 session 的 index(稳定),导入按 index→新 id 重映射(不能存旧 id)
      songOffsetBar: s.songOffsetBar ?? 0, repeats: s.repeats, color: s.color, xyAuto: s.xyAuto ?? null,
      instruments: s.instruments.map((i) => ({
        slot: i.slot, type: i.type, label: i.label, color: i.color, icon: i.icon, enabled: i.enabled,
        gainDb: i.gainDb, pan: i.pan, eqLowDb: i.eqLowDb, eqMidDb: i.eqMidDb, eqHighDb: i.eqHighDb,
        collageBars: i.collageBars, stepsPerBar: i.stepsPerBar, loopStartStep: i.loopStartStep,
        bakedAssetId: i.bakedAssetId, sends: i.sends ?? null, extra: i.extra ?? null,
        clips: i.clips.map((c) => ({
          soundId: c.soundId, assetId: c.assetId, startSample: c.startSample, endSample: c.endSample,
          bars: c.bars, timeMul: c.timeMul, semitones: c.semitones,
          fadeOutBars: c.fadeOutBars, fadeSilenceBars: c.fadeSilenceBars,
          gainDb: c.gainDb, pan: c.pan, eqLowDb: c.eqLowDb, eqMidDb: c.eqMidDb, eqHighDb: c.eqHighDb,
          startStep: c.startStep, orderIndex: c.orderIndex,
        })),
      })),
    })),
    pads: pads.map((p) => ({
      bank: p.bank, padIndex: p.padIndex, sourceSoundId: p.sourceSoundId, assetId: p.assetId,
      warp: p.warp, label: p.label, gainDb: p.gainDb,
    })),
    assets: assetMeta,
  };
  writeFileSync(path.join(outDir, 'bundle.json'), JSON.stringify(bundle, null, 2));

  const instCount = sessions.reduce((n, s) => n + s.instruments.length, 0);
  const clipCount = sessions.reduce((n, s) => n + s.instruments.reduce((m, i) => m + i.clips.length, 0), 0);
  console.log(`✓ 导出完成 → ${outDir}`);
  console.log(`  project="${project.name}"  sessions=${sessions.length}  instruments=${instCount}  clips=${clipCount}  pads=${pads.length}`);
  console.log(`  sounds=${sounds.length}  assets=${assetMeta.length}(音频文件已落 audio/)`);
  console.log(`  下一步:把整个 ${path.basename(outDir)}/ 传到线上,跑 import-example.mjs。`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
