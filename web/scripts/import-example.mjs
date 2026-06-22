// §30 示例项目【导入】:把 export-example.mjs 产出的 bundle 导入【线上】,成为归属站长的示例母版(isExample=true)。
// 线上直连 prod DB(读 web/.env 的 DATABASE_URL)+ 写 prod web/storage。设计见 PRODUCT.md §30、写法对齐 src/lib/forkProject.ts。
//
// ⚠️ 导入前先把站长账号提成 SUPER_ADMIN:node scripts/promote-admin.mjs <username>
// 用法(在 web/ 目录跑):
//   node scripts/import-example.mjs <bundle目录> <站长username>
//   例:node scripts/import-example.mjs ./example-bundle alice
import { PrismaClient, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const db = new PrismaClient();

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_ROOT = path.join(SCRIPT_DIR, '..', 'storage');
const storageAbs = (rel) => path.join(STORAGE_ROOT, rel);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// 可空 JSON:null → undefined(跳过,列默认 null),绕开 Prisma 的 DbNull/JsonNull 噪音(同 forkProject.json)。
const J = (v) => (v == null ? undefined : v);

const bundleDir = path.resolve(process.argv[2] || '');
const username = process.argv[3];
if (!process.argv[2] || !username) {
  console.error('用法: node scripts/import-example.mjs <bundle目录> <站长username>');
  process.exit(1);
}

async function main() {
  const bundlePath = path.join(bundleDir, 'bundle.json');
  if (!existsSync(bundlePath)) { console.error(`找不到 bundle.json: ${bundlePath}`); process.exit(1); }
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));

  const user = await db.user.findUnique({ where: { username } });
  if (!user) { console.error(`找不到用户: ${username}`); process.exit(1); }
  if (user.role !== 'SUPER_ADMIN') {
    console.warn(`⚠ 用户 "${username}" 不是 SUPER_ADMIN —— 母版能建,但他在 UI 里看不到 ★Example 开关。`);
    console.warn(`  先跑:node scripts/promote-admin.mjs ${username}`);
  }
  const userId = user.id;

  // 1) Asset 按内容 sha256 去重落地(等价 storage.putAudioAsset)。事务【外】先做:重 IO + 全局共享行,失败也只是无害孤儿。
  const assetMap = new Map(); // 老 assetId → 线上 assetId
  let reused = 0, written = 0;
  for (const a of bundle.assets) {
    const file = path.join(bundleDir, 'audio', a.file);
    if (!existsSync(file)) { console.error(`✗ bundle 缺音频文件: audio/${a.file}`); process.exit(1); }
    const buf = readFileSync(file);
    const hash = sha256(buf);
    const existing = await db.asset.findUnique({ where: { sha256: hash } });
    if (existing) { assetMap.set(a.id, existing.id); reused++; continue; }
    const rel = path.posix.join('audio', `${hash}.mp3`); // 内容寻址,同 putAudioAsset
    mkdirSync(path.dirname(storageAbs(rel)), { recursive: true });
    writeFileSync(storageAbs(rel), buf);
    const created = await db.asset.create({
      data: { kind: a.kind, path: rel, contentType: a.contentType, bytes: buf.byteLength, sha256: hash, sourceUrl: a.sourceUrl ?? undefined },
      select: { id: true },
    });
    assetMap.set(a.id, created.id);
    written++;
  }
  const mapAsset = (old) => {
    const v = old == null ? null : assetMap.get(old);
    if (old != null && v == null) throw new Error(`assetId 未在 bundle.assets 中: ${old}`);
    return v;
  };

  // 2) 事务:建 Project(归属站长 + isExample)→ Sounds(父→子)→ Session 树 → PadClip。
  const newProjectId = await db.$transaction(async (tx) => {
    const proj = await tx.project.create({
      data: {
        userId,
        name: bundle.project.name,
        masterBpm: bundle.project.masterBpm,
        masterKey: bundle.project.masterKey,
        quantize: bundle.project.quantize,
        beatsPerBar: bundle.project.beatsPerBar,
        genPrefs: J(bundle.project.genPrefs),
        gridPrefs: J(bundle.project.gridPrefs),
        fx: J(bundle.project.fx),
        loopSong: bundle.project.loopSong,
        playMode: bundle.project.playMode,
        showAutomation: bundle.project.showAutomation,
        isExample: true,          // §25 母版标记
        forkedFromExampleId: null, // 母版自身不回链
      },
      select: { id: true },
    });
    const pid = proj.id;

    // Sounds:bundle.sounds 已是父在前序;genId=null(不带母版生成历史),userId=站长,originProjectId=新母版。
    const soundMap = new Map();
    for (const s of bundle.sounds) {
      const created = await tx.sound.create({
        data: {
          userId, originProjectId: pid, genId: null,
          name: s.name, mode: s.mode, sourceBpm: s.sourceBpm, musicalKey: s.musicalKey,
          durationSec: s.durationSec, sampleRate: s.sampleRate, channels: s.channels,
          analysis: J(s.analysis), warp: J(s.warp),
          parentSoundId: s.parentSoundId ? soundMap.get(s.parentSoundId) ?? null : null,
          stemKind: s.stemKind, stemStatus: s.stemStatus,
          assetId: mapAsset(s.assetId),
          tags: s.tags, trashed: false,
        },
        select: { id: true },
      });
      soundMap.set(s.id, created.id);
    }
    const mapSound = (old) => (old ? soundMap.get(old) ?? null : null);

    // Session 树:嵌套 create 自动生成新 id + 接 FK。
    for (const s of bundle.sessions) {
      await tx.studioSession.create({
        data: {
          projectId: pid, name: s.name, index: s.index, repeats: s.repeats, color: s.color, xyAuto: J(s.xyAuto),
          instruments: {
            create: s.instruments.map((i) => ({
              slot: i.slot, type: i.type, label: i.label, color: i.color, icon: i.icon, enabled: i.enabled,
              gainDb: i.gainDb, pan: i.pan, eqLowDb: i.eqLowDb, eqMidDb: i.eqMidDb, eqHighDb: i.eqHighDb,
              collageBars: i.collageBars, stepsPerBar: i.stepsPerBar, loopStartStep: i.loopStartStep,
              bakedAssetId: mapAsset(i.bakedAssetId), sends: J(i.sends), extra: J(i.extra),
              clips: {
                create: i.clips.map((c) => ({
                  soundId: mapSound(c.soundId), assetId: mapAsset(c.assetId),
                  startSample: c.startSample, endSample: c.endSample, bars: c.bars,
                  timeMul: c.timeMul, semitones: c.semitones,
                  fadeOutBars: c.fadeOutBars, fadeSilenceBars: c.fadeSilenceBars,
                  gainDb: c.gainDb, pan: c.pan, eqLowDb: c.eqLowDb, eqMidDb: c.eqMidDb, eqHighDb: c.eqHighDb,
                  startStep: c.startStep, orderIndex: c.orderIndex,
                })),
              },
            })),
          },
        },
      });
    }

    // PadClip(warp 是非空 JSON,原样塞回)。
    for (const p of bundle.pads) {
      await tx.padClip.create({
        data: {
          projectId: pid, bank: p.bank, padIndex: p.padIndex,
          sourceSoundId: mapSound(p.sourceSoundId), assetId: mapAsset(p.assetId),
          warp: p.warp, label: p.label, gainDb: p.gainDb,
        },
      });
    }
    return pid;
  }, { timeout: 30000 });

  console.log(`✓ 导入完成。新示例母版 id = ${newProjectId}(owner=${username}, isExample=true)`);
  console.log(`  assets:复用 ${reused} / 新写 ${written};sounds=${bundle.sounds.length};sessions=${bundle.sessions.length};pads=${bundle.pads.length}`);
  console.log(`  站长登录后在「我的项目」可见该母版;其他用户进入即 fork 出可编辑副本。`);
  console.log(`  ⚠ 重复跑本脚本会再建一份新母版(不去重),多余的请在 UI 删。`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
