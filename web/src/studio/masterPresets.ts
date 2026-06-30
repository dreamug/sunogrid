// §42.5 缩混预设 —— 每个 = 一份完整 MasterConfig 字面量(起点不是模式,套上后可继续手调)。
// 套预设 = onFx({...fx, master: preset.config}) + 一次 pushHistory(自动落库 + 进 undo,白拿,见 §42.7)。
// ⚠ targetLufs 已存但「响度对齐自动 trim」尚未实现(需真 LUFS / BS.1770,留 v2 末步);现在切预设会改响度,手动调主音量。
import type { MasterConfig } from '@/contracts';
import { DEFAULT_MASTER } from '@/contracts';

export interface MasterPreset { name: string; hint: string; config: MasterConfig; }

const B = DEFAULT_MASTER;

export const MASTER_PRESETS: MasterPreset[] = [
  {
    name: 'Boom-Bap Glue', hint: '2:1 慢胶水 + 磁带 + 微宽',
    config: {
      on: true,
      eq: { on: true, low: 1, mid: -0.5, high: 1 },
      comp: { ...B.comp, on: true, threshold: -20, ratio: 2, attack: 30, release: 220, autoRelease: true, knee: 6, makeup: 1.5, scHpf: 80, mix: 0.7, lookahead: 3 },
      sat: { on: true, drive: 0.32, character: 'tape', mix: 0.5 },
      width: { on: true, width: 1.06, monoBelowHz: 110, air: 1 },
      limiter: { ...B.limiter, on: false },
    },
  },
  {
    name: 'Lofi Tape', hint: '重饱和 + 高频滚降 + 窄高端',
    config: {
      on: true,
      eq: { on: true, low: 0.5, mid: 0, high: -2.5 },
      comp: { ...B.comp, on: true, threshold: -18, ratio: 2.5, attack: 25, release: 180, autoRelease: true, makeup: 1, scHpf: 70, mix: 0.6 },
      sat: { on: true, drive: 0.55, character: 'tube', mix: 0.7 },
      width: { on: true, width: 0.9, monoBelowHz: 120, air: -1 },
      limiter: { ...B.limiter, on: false },
    },
  },
  {
    name: 'Trap Loud', hint: '狠压 + 真峰限幅推响 + 低端收紧 + hats 宽',
    config: {
      on: true,
      eq: { on: true, low: 1.5, mid: -1, high: 1.5 },
      comp: { ...B.comp, on: true, threshold: -24, ratio: 3, attack: 15, release: 150, autoRelease: true, makeup: 3, scHpf: 90, mix: 0.85 },
      sat: { on: true, drive: 0.4, character: 'soft', mix: 0.4 },
      width: { on: true, width: 1.15, monoBelowHz: 130, air: 1.5 },
      limiter: { on: true, gainDb: 7, ceilingDb: -1, targetLufs: -9, release: 120 },
    },
  },
  {
    name: 'Clean', hint: '几乎不压,只真峰限到天花板 + 一点 air',
    config: {
      on: true,
      eq: { on: false, low: 0, mid: 0, high: 0 },
      comp: { ...B.comp, on: false },
      sat: { on: false, drive: 0.3, character: 'tape', mix: 1 },
      width: { on: true, width: 1.0, monoBelowHz: 0, air: 1 },
      limiter: { on: true, gainDb: 2, ceilingDb: -1, targetLufs: null, release: 200 },
    },
  },
  {
    name: 'Club Wide', hint: '高频加宽 + <120 mono + 有冲击压缩',
    config: {
      on: true,
      eq: { on: true, low: 1, mid: 0, high: 1 },
      comp: { ...B.comp, on: true, threshold: -20, ratio: 2, attack: 35, release: 250, autoRelease: true, makeup: 1.5, scHpf: 100, mix: 0.5 },
      sat: { on: true, drive: 0.25, character: 'tape', mix: 0.35 },
      width: { on: true, width: 1.35, monoBelowHz: 120, air: 2 },
      limiter: { on: true, gainDb: 4, ceilingDb: -1, targetLufs: null, release: 180 },
    },
  },
  {
    name: 'Streaming −14', hint: '真峰限幅 → 目标 −14 LUFS(响度对齐待真 LUFS)',
    config: {
      on: true,
      eq: { on: false, low: 0, mid: 0, high: 0 },
      comp: { ...B.comp, on: true, threshold: -20, ratio: 2, attack: 30, release: 200, autoRelease: true, makeup: 1, scHpf: 80, mix: 0.5 },
      sat: { on: false, drive: 0.3, character: 'tape', mix: 1 },
      width: { on: true, width: 1.0, monoBelowHz: 0, air: 0.5 },
      limiter: { on: true, gainDb: 4, ceilingDb: -1, targetLufs: -14, release: 200 },
    },
  },
];
