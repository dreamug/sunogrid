// §38 项目导入/导出:把一个项目的依赖子图 + 引用到的音频字节序列化成一个自包含 zip,并能把这样一个
// zip 原地【覆盖】回某个项目。算法对齐 §30(scripts/export-example.mjs / import-example.mjs)+ src/lib/forkProject.ts:
// 子图收集、loadSoundsWithParents 的 stem 父→子拓扑序、Asset 按 sha256 去重、id 重映射(sound/asset/§37 anchor 按 index)。
// 设计见 PRODUCT.md §38。与 §30 的差别:归当前用户、isExample 恒 false、落地语义=覆盖现有项目(非新建)、打包成单文件 zip。
import { Prisma } from '@prisma/client';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { db } from './db';
import { putAudioAsset, readStorage, sha256 } from './storage';

export const BUNDLE_FORMAT_VERSION = 1;

export interface BundleAsset {
  id: string;
  kind: string;
  contentType: string;
  bytes: number;
  sha256: string;
  sourceUrl: string | null;
  file: string; // zip 内 audio/ 下的文件名(= <sha256>.mp3)
}

export interface ProjectBundle {
  formatVersion: number;
  exportedProjectId: string;
  project: Record<string, unknown>;
  sounds: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  pads: Array<Record<string, unknown>>;
  assets: BundleAsset[];
}

// 可空 JSON:null → undefined(跳过,列用默认 null),绕开 Prisma 的 DbNull/JsonNull 噪音(同 forkProject.json)。
const J = (v: unknown): Prisma.InputJsonValue | undefined => (v == null ? undefined : (v as Prisma.InputJsonValue));

// 加载给定 soundId 集合 + 其 parent 祖先,返回【父在前、子在后】(对齐 forkProject.loadSoundsWithParents)。
async function loadSoundsWithParents(rootIds: string[]) {
  type Row = Awaited<ReturnType<typeof db.sound.findMany>>[number];
  const byId = new Map<string, Row>();
  let frontier = [...new Set(rootIds)];
  while (frontier.length) {
    const rows = await db.sound.findMany({ where: { id: { in: frontier } } });
    const next: string[] = [];
    for (const r of rows) {
      if (byId.has(r.id)) continue;
      byId.set(r.id, r);
      if (r.parentSoundId && !byId.has(r.parentSoundId)) next.push(r.parentSoundId);
    }
    frontier = [...new Set(next)];
  }
  const all = [...byId.values()];
  const emitted = new Set<string>();
  const ordered: Row[] = [];
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

/** 读出一个项目的完整依赖子图 + 引用到的音频字节(只读,不改任何东西)。 */
export async function collectBundle(projectId: string): Promise<{ bundle: ProjectBundle; audio: Record<string, Uint8Array> }> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error(`project not found: ${projectId}`);

  const sessions = await db.studioSession.findMany({
    where: { projectId },
    include: { instruments: { orderBy: { slot: 'asc' }, include: { clips: { orderBy: { orderIndex: 'asc' } } } } },
    orderBy: { index: 'asc' },
  });
  const pads = await db.padClip.findMany({ where: { projectId } });

  const refSounds = new Set<string>();
  for (const s of sessions) for (const i of s.instruments) for (const c of i.clips) if (c.soundId) refSounds.add(c.soundId);
  for (const p of pads) if (p.sourceSoundId) refSounds.add(p.sourceSoundId);
  const sounds = await loadSoundsWithParents([...refSounds]);

  const refAssets = new Set<string>();
  for (const s of sounds) refAssets.add(s.assetId);
  for (const s of sessions) for (const i of s.instruments) {
    if (i.bakedAssetId) refAssets.add(i.bakedAssetId);
    for (const c of i.clips) refAssets.add(c.assetId);
  }
  for (const p of pads) refAssets.add(p.assetId);
  const assets = await db.asset.findMany({ where: { id: { in: [...refAssets] } } });

  const audio: Record<string, Uint8Array> = {};
  const assetMeta: BundleAsset[] = [];
  for (const a of assets) {
    let buf: Buffer;
    try { buf = await readStorage(a.path); }
    catch { throw new Error(`asset file missing in storage: ${a.path}`); }
    const hash = sha256(buf); // 内容哈希:文件名 + dedup 键。从字节算,不依赖 a.sha256(可空,见 §30 同款处理)。
    const file = `${hash}.mp3`;
    audio[file] = new Uint8Array(buf);
    assetMeta.push({ id: a.id, kind: a.kind, contentType: a.contentType, bytes: buf.byteLength, sha256: hash, sourceUrl: a.sourceUrl ?? null, file });
  }

  const bundle: ProjectBundle = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    exportedProjectId: project.id,
    project: {
      name: project.name, masterBpm: project.masterBpm, masterKey: project.masterKey,
      quantize: project.quantize, beatsPerBar: project.beatsPerBar,
      genPrefs: project.genPrefs ?? null, gridPrefs: project.gridPrefs ?? null, fx: project.fx ?? null,
      loopSong: project.loopSong, playMode: project.playMode, showAutomation: project.showAutomation,
      songLayoutVersion: project.songLayoutVersion ?? 1, songLanes: project.songLanes ?? null,
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
      // §37 sub 锚定:存锚 session 的 index(稳定),导入按 index→新 id 重映射(不能存旧 id)
      songAnchorIndex: s.songAnchorId ? (sessions.find((x) => x.id === s.songAnchorId)?.index ?? null) : null,
      songOffsetBar: s.songOffsetBar ?? 0, repeats: s.repeats, color: s.color, xyAuto: s.xyAuto ?? null,
      instruments: s.instruments.map((i) => ({
        slot: i.slot, type: i.type, label: i.label, color: i.color, icon: i.icon, enabled: i.enabled,
        gainDb: i.gainDb, pan: i.pan, eqLowDb: i.eqLowDb, eqMidDb: i.eqMidDb, eqHighDb: i.eqHighDb,
        collageBars: i.collageBars, stepsPerBar: i.stepsPerBar, loopStartStep: i.loopStartStep,
        bakedAssetId: i.bakedAssetId, sends: i.sends ?? null, extra: i.extra ?? null,
        clips: i.clips.map((c) => ({
          soundId: c.soundId, assetId: c.assetId, startSample: c.startSample, endSample: c.endSample,
          bars: c.bars, timeMul: c.timeMul, semitones: c.semitones, warpPts: c.warpPts ?? null, // §36 分段 warp
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

  return { bundle, audio };
}

/** bundle + 音频字节 → 单文件 zip(bundle.json + audio/<sha>.mp3)。 */
export function bundleToZip(bundle: ProjectBundle, audio: Record<string, Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = { 'bundle.json': strToU8(JSON.stringify(bundle)) };
  for (const [file, bytes] of Object.entries(audio)) files[`audio/${file}`] = bytes;
  return zipSync(files);
}

/** zip → bundle + 音频字节(校验格式)。 */
export function zipToBundle(zipBytes: Uint8Array): { bundle: ProjectBundle; audio: Record<string, Uint8Array> } {
  const unzipped = unzipSync(zipBytes);
  const raw = unzipped['bundle.json'];
  if (!raw) throw new Error('invalid bundle: bundle.json missing');
  let bundle: ProjectBundle;
  try { bundle = JSON.parse(strFromU8(raw)); }
  catch { throw new Error('invalid bundle: bundle.json is not valid JSON'); }
  if (bundle.formatVersion !== BUNDLE_FORMAT_VERSION) throw new Error(`unsupported bundle formatVersion: ${bundle.formatVersion}`);
  if (!bundle.project || !Array.isArray(bundle.sounds) || !Array.isArray(bundle.sessions) || !Array.isArray(bundle.pads) || !Array.isArray(bundle.assets)) {
    throw new Error('invalid bundle: missing required fields');
  }
  const audio: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(unzipped)) {
    if (name.startsWith('audio/')) audio[name.slice('audio/'.length)] = bytes;
  }
  return { bundle, audio };
}

/**
 * §38 覆盖导入:把 bundle 原地写回 projectId(归 userId 的项目),整个子图替换。
 * 调用方负责 owner 鉴权。Asset 落盘(去重)在事务外,行写在事务内(同 §30「读在外、写进事务」)。
 */
export async function overwriteProjectFromBundle(
  projectId: string,
  userId: string,
  bundle: ProjectBundle,
  audio: Record<string, Uint8Array>,
): Promise<void> {
  // 1) Asset 按 sha256 去重落地(复用 putAudioAsset 语义)。老 assetId → 线上 assetId。
  const assetMap = new Map<string, string>();
  for (const a of bundle.assets) {
    const bytes = audio[a.file];
    if (!bytes) throw new Error(`bundle missing audio file: audio/${a.file}`);
    const asset = await putAudioAsset(Buffer.from(bytes), {
      kind: (a.kind as 'source' | 'warped' | 'stem') ?? 'source',
      contentType: a.contentType,
      sourceUrl: a.sourceUrl ?? undefined,
    });
    assetMap.set(a.id, asset.id);
  }
  const mapAsset = (old: string | null | undefined): string => {
    const v = old == null ? null : assetMap.get(old);
    if (old != null && v == null) throw new Error(`assetId not in bundle.assets: ${old}`);
    if (v == null) throw new Error('clip/sound missing required assetId');
    return v;
  };
  const mapAssetOpt = (old: string | null | undefined): string | null => (old == null ? null : mapAsset(old));

  await db.$transaction(async (tx) => {
    // 2) 删旧子图(级联:删 session → instrument → clip;PadClip 单独删)。Project 行保留。
    await tx.studioSession.deleteMany({ where: { projectId } });
    await tx.padClip.deleteMany({ where: { projectId } });

    // Project 标量/JSON 列更新为 bundle 值(id/userId/isExample 不动)。
    const pj = bundle.project as Record<string, unknown>;
    await tx.project.update({
      where: { id: projectId },
      data: {
        name: pj.name as string, masterBpm: pj.masterBpm as number, masterKey: pj.masterKey as string | null,
        quantize: pj.quantize as string, beatsPerBar: pj.beatsPerBar as number,
        genPrefs: J(pj.genPrefs) ?? Prisma.DbNull, gridPrefs: J(pj.gridPrefs) ?? Prisma.DbNull, fx: J(pj.fx) ?? Prisma.DbNull,
        loopSong: pj.loopSong as boolean, playMode: pj.playMode as string, showAutomation: pj.showAutomation as boolean,
        songLayoutVersion: (pj.songLayoutVersion as number) ?? 1, songLanes: J(pj.songLanes) ?? Prisma.DbNull,
      },
    });

    // 3) 建新 Sounds(bundle.sounds 已父在前序);genId=null、userId=当前用户、originProjectId=本项目。
    const soundMap = new Map<string, string>();
    for (const sRaw of bundle.sounds) {
      const s = sRaw as Record<string, unknown>;
      const created = await tx.sound.create({
        data: {
          userId, originProjectId: projectId, genId: null,
          name: s.name as string, mode: s.mode as string, sourceBpm: s.sourceBpm as number, musicalKey: s.musicalKey as string | null,
          durationSec: s.durationSec as number, sampleRate: s.sampleRate as number, channels: s.channels as number,
          analysis: J(s.analysis) ?? Prisma.DbNull, warp: J(s.warp) ?? Prisma.DbNull,
          parentSoundId: s.parentSoundId ? soundMap.get(s.parentSoundId as string) ?? null : null,
          stemKind: s.stemKind as string | null, stemStatus: s.stemStatus as string | null,
          assetId: mapAsset(s.assetId as string),
          tags: (s.tags as string | null) ?? null, trashed: false,
        },
        select: { id: true },
      });
      soundMap.set(s.id as string, created.id);
    }
    const mapSound = (old: string | null | undefined): string | null => (old ? soundMap.get(old) ?? null : null);

    // 4) 重建 Session 树。§37:存 index→新 id,sub anchor 二遍按 index 重映射。
    const sessIdByIndex = new Map<number, string>();
    for (const sRaw of bundle.sessions) {
      const s = sRaw as Record<string, unknown>;
      const instruments = (s.instruments as Array<Record<string, unknown>>) ?? [];
      const createdSess = await tx.studioSession.create({
        data: {
          projectId, name: s.name as string, index: s.index as number,
          songLane: (s.songLane as number) ?? 0, songStartBar: (s.songStartBar as number) ?? 0,
          songOffsetBar: (s.songOffsetBar as number) ?? 0, repeats: s.repeats as number, color: s.color as string,
          xyAuto: J(s.xyAuto) ?? Prisma.DbNull,
          instruments: {
            create: instruments.map((iRaw) => {
              const i = iRaw as Record<string, unknown>;
              const clips = (i.clips as Array<Record<string, unknown>>) ?? [];
              return {
                slot: i.slot as number, type: i.type as string, label: i.label as string, color: i.color as string | null,
                icon: i.icon as string | null, enabled: i.enabled as boolean,
                gainDb: i.gainDb as number, pan: i.pan as number, eqLowDb: i.eqLowDb as number, eqMidDb: i.eqMidDb as number, eqHighDb: i.eqHighDb as number,
                collageBars: i.collageBars as number | null, stepsPerBar: i.stepsPerBar as number | null, loopStartStep: i.loopStartStep as number | null,
                bakedAssetId: mapAssetOpt(i.bakedAssetId as string | null), sends: J(i.sends) ?? Prisma.DbNull, extra: J(i.extra) ?? Prisma.DbNull,
                clips: {
                  create: clips.map((cRaw) => {
                    const c = cRaw as Record<string, unknown>;
                    return {
                      soundId: mapSound(c.soundId as string | null), assetId: mapAsset(c.assetId as string),
                      startSample: c.startSample as number, endSample: c.endSample as number, bars: c.bars as number,
                      timeMul: c.timeMul as number, semitones: c.semitones as number, warpPts: J(c.warpPts) ?? Prisma.DbNull, // §36 分段 warp
                      fadeOutBars: c.fadeOutBars as number, fadeSilenceBars: c.fadeSilenceBars as number,
                      gainDb: c.gainDb as number, pan: c.pan as number, eqLowDb: c.eqLowDb as number, eqMidDb: c.eqMidDb as number, eqHighDb: c.eqHighDb as number,
                      startStep: c.startStep as number | null, orderIndex: c.orderIndex as number,
                    };
                  }),
                },
              };
            }),
          },
        },
        select: { id: true },
      });
      sessIdByIndex.set(s.index as number, createdSess.id);
    }
    // §37 二遍:sub 的 songAnchorId 按 songAnchorIndex→新 id 重映射(锚失效则留 null → resnap 当孤儿)。
    for (const sRaw of bundle.sessions) {
      const s = sRaw as Record<string, unknown>;
      const anchorIdx = s.songAnchorIndex as number | null;
      if (anchorIdx == null) continue;
      const newId = sessIdByIndex.get(s.index as number), newAnchor = sessIdByIndex.get(anchorIdx);
      if (newId && newAnchor) await tx.studioSession.update({ where: { id: newId }, data: { songAnchorId: newAnchor } });
    }

    // 5) 重建 PadClip(warp 非空 JSON,原样塞回)。
    for (const pRaw of bundle.pads) {
      const p = pRaw as Record<string, unknown>;
      await tx.padClip.create({
        data: {
          projectId, bank: p.bank as number, padIndex: p.padIndex as number,
          sourceSoundId: mapSound(p.sourceSoundId as string | null), assetId: mapAsset(p.assetId as string),
          warp: p.warp as Prisma.InputJsonValue, label: p.label as string | null, gainDb: p.gainDb as number,
        },
      });
    }
  }, { timeout: 30000 });

  // 覆盖收尾:软删本项目【遗留的孤儿 Sound】—— originProjectId==本项目、但已无任何 clip/pad 引用的旧库行
  // (反复覆盖同一项目会累积上次导入的 Sound,见 §38.4)。事务外做、best-effort:失败只是留点孤儿,不影响导入正确性。
  await softDeleteOrphanSounds(projectId).catch(() => {});
}

/** 软删「originProjectId==projectId 且整个 stem 家族都无 clip/pad 引用」的 Sound。保护:被引用 Sound 的父/子链一律保留。 */
async function softDeleteOrphanSounds(projectId: string): Promise<number> {
  const candidates = await db.sound.findMany({
    where: { originProjectId: projectId, trashed: false },
    select: { id: true, parentSoundId: true },
  });
  if (!candidates.length) return 0;
  const ids = candidates.map((c) => c.id);
  const [clipRefs, padRefs] = await Promise.all([
    db.clip.findMany({ where: { soundId: { in: ids } }, select: { soundId: true } }),
    db.padClip.findMany({ where: { sourceSoundId: { in: ids } }, select: { sourceSoundId: true } }),
  ]);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const childrenOf = new Map<string, string[]>();
  for (const c of candidates) if (c.parentSoundId) (childrenOf.get(c.parentSoundId) ?? childrenOf.set(c.parentSoundId, []).get(c.parentSoundId)!).push(c.id);

  const keep = new Set<string>();
  for (const r of clipRefs) if (r.soundId) keep.add(r.soundId);
  for (const r of padRefs) if (r.sourceSoundId) keep.add(r.sourceSoundId);
  // 向上保父:被引用 stem 的父(源)不能删
  for (const id of [...keep]) { let cur = byId.get(id); while (cur?.parentSoundId && byId.has(cur.parentSoundId)) { keep.add(cur.parentSoundId); cur = byId.get(cur.parentSoundId); } }
  // 向下保子:被引用 Sound 的全部后代 stem 一并保留
  const stack = [...keep];
  while (stack.length) { const id = stack.pop()!; for (const ch of childrenOf.get(id) ?? []) if (!keep.has(ch)) { keep.add(ch); stack.push(ch); } }

  const toTrash = ids.filter((id) => !keep.has(id));
  if (toTrash.length) await db.sound.updateMany({ where: { id: { in: toTrash } }, data: { trashed: true } });
  return toTrash.length;
}
