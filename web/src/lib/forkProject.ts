// §25 示例项目:把一份示例母版深克隆成「目标用户拥有的、可编辑副本」(写时复制 fork-on-open)。
//
// ⚠️ 命门(见 PRODUCT §25):fork 是【跨用户】的。Sound 是用户级库(Sound.userId),Clip.soundId 指它。
//    §23 的 cloneInstrument 故意【共享 soundId】—— 同用户同项目内成立,但跨用户会让副本指着母版主人的库:
//    库视图看不到、autosave 把"非己 soundId"归 null、§16 undo 的 warp 口径全断。
//    所以这里【连库一起克隆】:把工程引用到的 Sound(连 stem parent 链)复制进副本所有者的库(新 id),
//    建 母版soundId→新soundId 映射,重写所有 Clip/PadClip 的 soundId。
//    Asset(sha256)/ WarpRender(签名)是全局共享 → 不复制,assetId/bakedAssetId 直接沿用(collage 不必重 bake)。
import { Prisma } from '@prisma/client';
import { db } from './db';

// 可空 JSON 列拷贝:null → 跳过(列默认 null),否则原样塞回。绕开 Prisma 的 DbNull/JsonNull 噪音。
const json = (v: Prisma.JsonValue | null | undefined): Prisma.InputJsonValue | undefined =>
  v == null ? undefined : (v as Prisma.InputJsonValue);

type ForkResult = { id: string; resumed: boolean };

/**
 * 找回或克隆「userId 对 exampleId 的副本」。幂等:已有副本直接返回(resume),否则深克隆。
 * 调用前应确保 exampleId 确实是 isExample 母版;owner 自己开自己的母版不该走这里(直接编母版)。
 */
export async function forkExampleProject(exampleId: string, userId: string): Promise<ForkResult> {
  // 1) 去重 / resume:每个用户对每个母版至多一份副本(@@unique([userId, forkedFromExampleId]) 兜底)。
  const existing = await db.project.findFirst({ where: { userId, forkedFromExampleId: exampleId }, select: { id: true } });
  if (existing) return { id: existing.id, resumed: true };

  const example = await db.project.findUnique({ where: { id: exampleId } });
  if (!example || !example.isExample) throw new Error('not an example project');

  // 2) 拉母版全图(Session→Instrument→Clip + PadClip)。
  //    这些读 + 下面的 srcSounds 都在事务【外】先做好(缩短事务、只把写关进事务):安全前提 = 母版是只读模板,
  //    fork 期间不会被改(isExample 母版无编辑入口);若将来允许编辑母版,需把这些读移进事务用 tx 重取。
  const sessions = await db.studioSession.findMany({
    where: { projectId: exampleId },
    include: { instruments: { orderBy: { slot: 'asc' }, include: { clips: { orderBy: { orderIndex: 'asc' } } } } },
    orderBy: { index: 'asc' },
  });
  const pads = await db.padClip.findMany({ where: { projectId: exampleId } });

  // 3) 收集被引用的 soundId,加载它们 + parent 链(stem 子声音要带父,父→子顺序克隆好接 parentSoundId)。
  const referenced = new Set<string>();
  for (const s of sessions) for (const i of s.instruments) for (const c of i.clips) if (c.soundId) referenced.add(c.soundId);
  for (const p of pads) if (p.sourceSoundId) referenced.add(p.sourceSoundId);
  const srcSounds = await loadSoundsWithParents([...referenced]);

  try {
    const proj = await db.$transaction(async (tx) => {
      // 3a) Project 壳:拷标量,标成自己的可编辑副本。
      const created = await tx.project.create({
        data: {
          userId,
          name: example.name,
          masterBpm: example.masterBpm,
          masterKey: example.masterKey,
          quantize: example.quantize,
          beatsPerBar: example.beatsPerBar,
          genPrefs: json(example.genPrefs),
          gridPrefs: json(example.gridPrefs),
          fx: json(example.fx),
          loopSong: example.loopSong,
          isExample: false,
          forkedFromExampleId: exampleId,
        },
        select: { id: true },
      });
      const newProjectId = created.id;

      // 3b) 克隆 Sound 进副本所有者的库(父→子顺序),建 老→新 id 映射。genId=null(不带母版生成历史)。
      const soundMap = new Map<string, string>();
      for (const src of srcSounds) {
        const s = await tx.sound.create({
          data: {
            userId,
            originProjectId: newProjectId,
            genId: null,
            name: src.name,
            mode: src.mode,
            sourceBpm: src.sourceBpm,
            musicalKey: src.musicalKey,
            durationSec: src.durationSec,
            sampleRate: src.sampleRate,
            channels: src.channels,
            analysis: json(src.analysis),
            warp: json(src.warp),
            parentSoundId: src.parentSoundId ? soundMap.get(src.parentSoundId) ?? null : null,
            stemKind: src.stemKind,
            stemStatus: src.stemStatus,
            assetId: src.assetId, // 全局共享字节,不复制
            tags: src.tags,
            trashed: false,
          },
          select: { id: true },
        });
        soundMap.set(src.id, s.id);
      }
      const mapSound = (old: string | null): string | null => (old ? soundMap.get(old) ?? null : null);

      // 3c) 克隆 Session 树(嵌套 create 自动生成新 id + 接好 FK)。
      for (const s of sessions) {
        await tx.studioSession.create({
          data: {
            projectId: newProjectId,
            name: s.name,
            index: s.index,
            repeats: s.repeats,
            color: s.color,
            instruments: {
              create: s.instruments.map((i) => ({
                slot: i.slot,
                type: i.type,
                label: i.label,
                color: i.color,
                icon: i.icon,
                enabled: i.enabled,
                gainDb: i.gainDb,
                pan: i.pan,
                eqLowDb: i.eqLowDb,
                eqMidDb: i.eqMidDb,
                eqHighDb: i.eqHighDb,
                collageBars: i.collageBars,
                stepsPerBar: i.stepsPerBar,
                loopStartStep: i.loopStartStep,
                bakedAssetId: i.bakedAssetId, // 全局 Asset,沿用
                sends: json(i.sends),
                extra: json(i.extra),
                clips: {
                  create: i.clips.map((c) => ({
                    soundId: mapSound(c.soundId),
                    assetId: c.assetId,
                    startSample: c.startSample,
                    endSample: c.endSample,
                    bars: c.bars,
                    timeMul: c.timeMul,
                    semitones: c.semitones,
                    fadeOutBars: c.fadeOutBars,
                    fadeSilenceBars: c.fadeSilenceBars,
                    gainDb: c.gainDb,
                    pan: c.pan,
                    eqLowDb: c.eqLowDb,
                    eqMidDb: c.eqMidDb,
                    eqHighDb: c.eqHighDb,
                    startStep: c.startStep,
                    orderIndex: c.orderIndex,
                  })),
                },
              })),
            },
          },
        });
      }

      // 3d) 克隆 PadClip(老 loop 机布局;sourceSoundId 走映射,assetId/warp 沿用)。
      for (const p of pads) {
        await tx.padClip.create({
          data: {
            projectId: newProjectId,
            bank: p.bank,
            padIndex: p.padIndex,
            sourceSoundId: mapSound(p.sourceSoundId),
            assetId: p.assetId,
            warp: p.warp as Prisma.InputJsonValue, // PadClip.warp 非空 JSON
            label: p.label,
            gainDb: p.gainDb,
          },
        });
      }

      return { id: newProjectId };
    }, { timeout: 20000 }); // 深克隆是多条顺序 create,放宽默认 5s 事务超时(大示例也稳)。
    return { id: proj.id, resumed: false };
  } catch (e) {
    // 并发双开(StrictMode/双击)撞 @@unique → 回查返回已建的那份。
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const dup = await db.project.findFirst({ where: { userId, forkedFromExampleId: exampleId }, select: { id: true } });
      if (dup) return { id: dup.id, resumed: true };
    }
    throw e;
  }
}

// 加载给定 soundId 集合 + 其 parent 祖先,返回【父在前、子在后】的顺序(好让 parentSoundId 映射可解析)。
async function loadSoundsWithParents(rootIds: string[]) {
  type Row = Awaited<ReturnType<typeof db.sound.findMany>>[number];
  const byId = new Map<string, Row>();
  let frontier = [...new Set(rootIds)];
  while (frontier.length) {
    const rows = await db.sound.findMany({ where: { id: { in: frontier } } });
    const nextIds: string[] = [];
    for (const r of rows) {
      if (byId.has(r.id)) continue;
      byId.set(r.id, r);
      if (r.parentSoundId && !byId.has(r.parentSoundId)) nextIds.push(r.parentSoundId);
    }
    frontier = [...new Set(nextIds)];
  }
  // 拓扑:父(parentSoundId 为 null 或不在集合内)先出,再出其子,直到清空。
  const all = [...byId.values()];
  const emitted = new Set<string>();
  const ordered: Row[] = [];
  while (ordered.length < all.length) {
    let progressed = false;
    for (const r of all) {
      if (emitted.has(r.id)) continue;
      const parentReady = !r.parentSoundId || !byId.has(r.parentSoundId) || emitted.has(r.parentSoundId);
      if (parentReady) {
        ordered.push(r);
        emitted.add(r.id);
        progressed = true;
      }
    }
    if (!progressed) {
      // 环(理论上不该有)→ 兜底把剩下的直接吐出,避免死循环。
      for (const r of all) if (!emitted.has(r.id)) ordered.push(r);
      break;
    }
  }
  return ordered;
}
