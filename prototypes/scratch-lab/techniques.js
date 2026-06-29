// techniques.js v3 —— 按真实手法重调。位置驱动:lane(t,p) → {pos, g}
//   t      = 一个「手势周期」内的归一化时间 [0,1)(周期长度见 CYCLE,单位=拍)。
//   pos    = 读头相对撮点的位移,单位=行程。0=撮点,1=撮点+整段行程。
//   g      = 推子门 0..1。
// 序列器把 pos 映射成绝对位置=cue+pos*travel,夹进整体范围,再喂 worklet 的 scratch 模式。
//
// 教学要点(已对齐):
//   forward = 推出有声、回拉关门     tear = 推出后回拉切成两三段(顿挫)
//   chirp   = 每段「开头开门、末尾关门」→ 啾    transformer = 匀速转 + 推子均匀斩
//   flare   = 推子默认开,运动中瞬关 N 下     crab = 拇指压住、四指连拍(默认关、急促开 N 下,加速)
//   orbit   = 同一个 flare 在「推+拉」两个方向都做(绕圈)    hydroplane = 手指轻贴抖动 = 颤音
//
// 铁律:pos 在 t=0 与 t=1 要接得上(连续),否则乐句缝会"咻"地倒带咔哒。

const TAU = Math.PI * 2;
const sq = (x, hard = 12) => 0.5 + 0.5 * Math.tanh(Math.sin(x) * hard);   // 锐方波
const cosUpDown = (t) => 0.5 - 0.5 * Math.cos(t * TAU);                   // 0→1→0 平滑来回(推+拉)
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
// t(0..1)是否落在某些「窗口中心」附近(给推子 click 用)
const inWindows = (t, centers, halfW) => centers.some((c) => Math.abs(((t % 1) + 1) % 1 - c) < halfW);

// 每招的自然手势周期(拍)。序列器按它在一个 move 里重复手势 → 乐句感。
export const CYCLE = {
  baby: 1, forward: 1, tear: 1, chirp: 1, transformer: 2,
  flare: 1, crab: 1, orbit: 1, scribble: 0.5, hydroplane: 2,
};

export const TECHNIQUES = {
  // 推拉,推子全开。两个方向都听得到。
  baby: {
    label: 'Baby', hint: '推拉·推子全开',
    lane: (t, p) => ({ pos: cosUpDown(t) * (p.depth ?? 1), g: 1 }),
  },

  // 推出有声、回拉关门 → 只听正切,干脆
  forward: {
    label: 'Forward (Cut)', hint: '推出有声·回拉关门',
    lane: (t, p) => ({ pos: cosUpDown(t) * (p.depth ?? 1), g: t < 0.5 ? 1 : 0 }),
  },

  // 推出顺滑,回拉切成两段(中间一个微停)→ 把一下撕成三声
  tear: {
    label: 'Tear', hint: '推出·回拉撕成两段',
    lane: (t, p) => {
      const D = p.depth ?? 1; let pos;
      if (t < 0.45) pos = t / 0.45;                 // 0→1 推出
      else if (t < 0.60) pos = 1 - (t - 0.45) / 0.15 * 0.45; // 1→0.55 回拉·第一段
      else if (t < 0.70) pos = 0.55;                // 微停(tear 的顿挫)
      else if (t < 0.92) pos = 0.55 - (t - 0.70) / 0.22 * 0.55; // 0.55→0 回拉·第二段
      else pos = 0;                                  // 收尾停在撮点
      return { pos: pos * D, g: 1 };
    },
  },

  // 每段(推/拉)开头开门、末尾关门 → "啾"
  chirp: {
    label: 'Chirp', hint: '每段头开尾关·啾',
    lane: (t, p) => {
      const ph = (t % 0.5) / 0.5;                   // 段内相位(0..1)
      return { pos: cosUpDown(t) * (p.depth ?? 1), g: ph < 0.58 ? 1 : 0 };
    },
  },

  // 匀速来回(慢,跨 2 拍)+ 推子均匀斩 → wah-wah
  transformer: {
    label: 'Transformer', hint: '匀速转·推子均匀斩',
    lane: (t, p) => {
      const clicks = p.clicks ?? 6;
      return { pos: cosUpDown(t) * (p.depth ?? 1), g: sq(t * TAU * clicks, 14) };
    },
  },

  // 推子默认开,运动中瞬关 N 下(click)
  flare: {
    label: 'Flare', hint: '默认开·瞬关 N 下',
    lane: (t, p) => {
      const n = p.clicks ?? 2;
      const centers = Array.from({ length: n }, (_, i) => (i + 1) / (n + 1)); // 均匀分布
      return { pos: cosUpDown(t) * (p.depth ?? 1), g: inWindows(t, centers, 0.03) ? 0 : 1 };
    },
  },

  // 拇指压住=默认关,四指连拍=急促开 N 下(间距递减=加速),集中在推出段
  crab: {
    label: 'Crab', hint: '默认关·四指加速连拍',
    lane: (t, p) => {
      // 推出段 [0,0.5] 内 5 个加速开门;回拉段静默(干脆复位)
      const centers = [0.03, 0.15, 0.25, 0.33, 0.40];
      const open = t < 0.5 && inWindows(t, centers, 0.028);
      return { pos: cosUpDown(t) * (p.depth ?? 1), g: open ? 1 : 0 };
    },
  },

  // flare 在推+拉两个方向都做(对称瞬关)→ 绕圈连绵
  orbit: {
    label: 'Orbit', hint: 'flare 双向·绕圈',
    lane: (t, p) => {
      const n = p.clicks ?? 2;
      // 每半程各放 n 个瞬关
      const half = Array.from({ length: n }, (_, i) => (i + 1) / (n + 1) * 0.5);
      const centers = [...half, ...half.map((c) => c + 0.5)];
      return { pos: cosUpDown(t) * (p.depth ?? 1), g: inWindows(t, centers, 0.026) ? 0 : 1 };
    },
  },

  // 高频小振幅抖动(围绕撮点中段),推子全开
  scribble: {
    label: 'Scribble', hint: '高频小振幅·推子全开',
    lane: (t, p) => {
      const d = p.depth ?? 1, amp = 0.32 * d;
      return { pos: 0.4 * d + amp * Math.sin(t * TAU * (p.rate ?? 6)), g: 1 };
    },
  },

  // 慢来回 + 手指轻贴的颤动(振幅颤音)
  hydroplane: {
    label: 'Hydroplane', hint: '慢搓+颤音',
    lane: (t, p) => {
      const flutter = 0.55 + 0.45 * sq(t * TAU * (p.rate ?? 22), 4); // 快速颤动
      return { pos: cosUpDown(t) * (p.depth ?? 1), g: clamp01(flutter) };
    },
  },
};

export const TECH_KEYS = Object.keys(TECHNIQUES);
