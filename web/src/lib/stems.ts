// 乐器分离:调本地 Demucs sidecar(stem-service),把一个 Sound 分成 6 个 stem 子 Sound。
// stem 与源逐样本对齐(demucs 保长),解码到同一 AudioContext SR 后时间轴一致 →
//   子 stem 直接继承父的 analysis/warp(同 BPM/小节/loop 区)→ 拖到 pad 天然锁相同步。
import { readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { db } from './db';
import { putAudioAsset, storageAbs } from './storage';

const STEM_URL = process.env.STEM_SERVICE_URL || 'http://127.0.0.1:8008';

export interface StemHealth { ok: boolean; model: string; device: string; sources: string[]; sampleRate: number }

/** sidecar 是否在跑(给前端友好提示用)。 */
export async function stemServiceHealth(): Promise<StemHealth | null> {
  try {
    const r = await fetch(`${STEM_URL}/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok ? ((await r.json()) as StemHealth) : null;
  } catch {
    return null;
  }
}

/**
 * 分离一个 Sound → 建 stem 子 Sound(重分会先删旧 stem)。
 * 两层共用此函数(§29):
 *   - 顶层 Sound(无 parent)→ model='full' → 6 轨 drums/bass/other/vocals/guitar/piano。
 *   - drums 子轨(stemKind==='drums')→ model='drums' → kick/snare/toms/cymbals 四件孙轨。
 *   - 其它 stem → 拒绝(只有鼓能再拆)。
 */
export async function separateSound(soundId: string) {
  const parent = await db.sound.findUnique({ where: { id: soundId }, include: { asset: true } });
  if (!parent) throw new Error('sound not found');
  // 开一道窄缝:鼓轨能二段拆,其它 stem 不行。
  let model: 'full' | 'drums';
  if (!parent.parentSoundId) {
    model = 'full';
  } else if (parent.stemKind === 'drums') {
    model = 'drums';
  } else {
    throw new Error("Only the drums stem can be split further");
  }

  const health = await stemServiceHealth();
  if (!health) throw new Error('分离服务没在跑:到 stem-service/ 执行 ./run.sh');

  await db.sound.update({ where: { id: soundId }, data: { stemStatus: 'separating' } });
  const outDir = path.join(os.tmpdir(), 'hhgen-stems', soundId);
  try {
    await db.sound.deleteMany({ where: { parentSoundId: soundId } }); // 重分:清旧

    const res = await fetch(`${STEM_URL}/separate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputPath: storageAbs(parent.asset.path), outDir, model }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!res.ok) {
      // 透传 sidecar 的错误原因(如 drum 模型未安装),别只回个 HTTP 码
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ? `分离失败:${body.error}` : `分离失败 HTTP ${res.status}`);
    }
    const { stems } = (await res.json()) as { stems: { kind: string; path: string; peak: number; rms: number }[] };
    // 跳过近静音 stem(如这首没吉他时的 guitar 轨),不建无用 Sound/pad
    const SILENT_PEAK = 0.01;
    const keep = stems.filter((s) => s.peak >= SILENT_PEAK);

    const inherit = {
      userId: parent.userId, // stem 子 Sound 继承父的归属用户
      originProjectId: parent.originProjectId,
      genId: parent.genId,
      mode: parent.mode,
      sourceBpm: parent.sourceBpm,
      musicalKey: parent.musicalKey,
      durationSec: parent.durationSec,
      sampleRate: parent.sampleRate,
      channels: parent.channels,
      ...(parent.analysis != null ? { analysis: parent.analysis as object } : {}),
      ...(parent.warp != null ? { warp: parent.warp as object } : {}),
    };

    const children = [];
    for (const st of keep) {
      const buf = await readFile(st.path);
      const asset = await putAudioAsset(buf, { kind: 'stem', contentType: 'audio/wav' });
      children.push(
        await db.sound.create({
          data: {
            ...inherit,
            parentSoundId: parent.id,
            stemKind: st.kind,
            name: `${parent.name} · ${st.kind}`,
            assetId: asset.id,
          },
        }),
      );
    }
    await db.sound.update({ where: { id: soundId }, data: { stemStatus: 'done' } });
    return children;
  } catch (e) {
    await db.sound.update({ where: { id: soundId }, data: { stemStatus: 'failed' } });
    throw e;
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}
