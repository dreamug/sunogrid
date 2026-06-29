// routine.js v2 —— 自动撮盘的大脑(纯函数,确定性,可单测)。
// genRoutine(seed, style, intensity, bars, opts) → { moves:[{tech,beats,cue,params,accent}], lenBeats }
//   move = 一个招式原子:tech · beats(跨几拍,招式在其内按自然节奏重复)· cue(0..1)· params
//   'rest' = 留白(推子关、不出声)—— 撮盘的呼吸,和招式同等重要
// opts: { cues, lockTech, restBias }
//   lockTech = 锁定单技巧(技巧自动机用:整条只用这一招 + 留白)
//   restBias = 额外留白量 0..1
// seed 落库 → 可复现、可换一卷(对标 session-color-identity:别用下标当随机源)。

import { CYCLE } from './techniques.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// 风格 = 低/高强度技巧池 + 留白倾向
export const STYLES = {
  battle:   { label: 'Battle',      lo: ['baby', 'forward', 'chirp', 'tear'], hi: ['flare', 'crab', 'orbit', 'transformer'], rest: 0.22 },
  minimal:  { label: 'Minimal',     lo: ['baby', 'forward'],                  hi: ['chirp', 'transformer'],                  rest: 0.42 },
  chirpy:   { label: 'Chirp-heavy', lo: ['chirp', 'baby'],                    hi: ['chirp', 'flare', 'orbit'],               rest: 0.26 },
  scribble: { label: 'Scribble',    lo: ['scribble', 'baby', 'hydroplane'],   hi: ['scribble', 'crab', 'flare'],             rest: 0.20 },
};
export const STYLE_KEYS = Object.keys(STYLES);

// 从波形包络估 cue 切点(onset),取相互拉开的最强 N 个 → 0..1
export function detectCues(env, maxN = 2) {
  const N = env.length; if (N < 4) return [0];
  const flux = new Float32Array(N);
  for (let i = 1; i < N; i++) { const d = env[i] - env[i - 1]; flux[i] = d > 0 ? d : 0; }
  const order = [...flux.keys()].sort((a, b) => flux[b] - flux[a]);
  const chosen = []; const minGap = N * 0.12;
  for (const i of order) {
    if (flux[i] <= 0) break;
    if (chosen.every((c) => Math.abs(c - i) > minGap)) { chosen.push(i); if (chosen.length >= maxN) break; }
  }
  chosen.sort((a, b) => a - b);
  return chosen.length ? chosen.map((i) => i / N) : [0];
}

export function genRoutine(seed, style, intensity, bars, opts = {}) {
  const rng = mulberry32((seed >>> 0) || 1);
  const S = STYLES[style] || STYLES.battle;
  const beatsPerBar = 4;
  const totalBeats = Math.max(1, bars * beatsPerBar);
  const cues = (opts.cues && opts.cues.length) ? opts.cues : [0];
  const lock = opts.lockTech || null;
  const restBias = opts.restBias != null ? opts.restBias : 0;

  // 留白概率:风格底噪 +（强度略降密度）+ 用户留白偏置
  const restP = Math.min(0.85, S.rest * (1 - intensity * 0.35) + restBias * 0.7);
  // 招式跨几拍(乐句长度):越强越短促连段,越弱越长留韵
  const spanChoices = intensity > 0.66 ? [1, 2, 2, 3] : intensity > 0.33 ? [2, 2, 3, 4] : [2, 4, 4, 4];

  const moves = []; let acc = 0, cueIdx = 0, guard = 0, sinceRest = 0;
  while (acc < totalBeats - 1e-6 && guard++ < 4096) {
    const remain = totalBeats - acc;
    const onDown = Math.abs(acc % beatsPerBar) < 1e-6;
    // 连续演奏越久,越该喘口气(概率随时长递增)
    const fp = sinceRest >= 3 ? Math.min(0.92, 0.35 + (sinceRest - 2) * 0.22) : 0;
    const forceRest = rng() < fp;

    // 留白(撮盘的呼吸)
    if ((rng() < restP || forceRest) && remain > 0.5) {
      const d = Math.min(pick(rng, [1, 1, 2, 2, onDown ? 2 : 1]), remain);
      moves.push({ tech: 'rest', beats: d, cue: cues[cueIdx % cues.length], params: {}, accent: onDown });
      acc += d; sinceRest = 0; continue;
    }

    const hi = rng() < intensity;
    const tech = lock || pick(rng, hi ? S.hi : S.lo);
    const cb = CYCLE[tech] || 1;
    let span = pick(rng, spanChoices);
    span = Math.max(cb, Math.round(span / cb) * cb);     // 量化到自然周期的整数倍(乐句不切半招)
    const beats = Math.min(span, remain);

    const cue = cues[cueIdx % cues.length];
    if (rng() < (lock ? 0.3 : 0.45)) cueIdx++;           // 换 cue(Ahh/Fresh 交替)
    const params = {
      depth: +(0.7 + rng() * 0.5).toFixed(2),
      travelMul: +(0.55 + rng() * 0.9).toFixed(2),       // 咬字短促↔拉长
      clicks: 1 + Math.floor(rng() * (hi ? 5 : 3)),
      rate: 8 + Math.floor(rng() * 4),
    };
    moves.push({ tech, beats, cue, params, accent: onDown });
    acc += beats; sinceRest += beats;
  }
  return { moves, lenBeats: totalBeats, seed: (seed >>> 0) || 1, style, intensity, bars, lockTech: lock };
}
