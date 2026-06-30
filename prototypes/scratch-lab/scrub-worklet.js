// scrub-worklet.js v2 —— 按 Mixxx/Serato 的真实搓盘模型重写。
// 核心:不是"指针速度=音频速度",而是"指针绝对位置 → alpha-beta(g-h)滤波 → 平滑速度"。
// 这正是数字 turntable 手感的来源(Mixxx engine.scratchEnable 的 alpha/beta)。
//
// 三种驱动 mode:
//   'filter' 实时手势:给 targetPhase(绝对位置),滤波器吐带惯性的 vel(唱盘质量感)
//   'direct' 技巧序列器:直接给 vel(理想曲线),带轻 slew 去咔哒
//   'free'   松手:vel 经 friction 滑回 freeRate(0=停 / 1=马达原速,= 滑垫回拉)
//
// 读样本:Catmull-Rom 三次插值 + 快搓时沿读头轨迹自适应超采样(抗锯齿)。
//
// port 消息:
//   {type:'load', channels, sampleRate}
//   {type:'target', phase}      → filter 模式,设目标绝对位置(src 采样,可不 wrap)
//   {type:'release'}            → free 模式
//   {type:'vel', value}         → direct 模式(序列器)
//   {type:'free', rate}         → 设 freeRate(0/1)
//   {type:'tune', alpha,beta,friction,directSlew}
// 回发:{type:'pos', phase, vel, len}  ~60fps

class ScrubProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'gate', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' }];
  }

  constructor() {
    super();
    this.ch = [];
    this.len = 0;
    this.srcRate = 48000;

    this.phase = 0;          // 读头(src 采样,内部不 wrap,读取时再 modulo)
    this.vel = 0;            // src采样 / 输出采样,1≈原速
    this.targetPhase = 0;    // filter 模式目标位置
    this.freeRate = 0;       // free 模式趋近的速度(0 停 / 1 马达)
    this.mode = 'free';

    // 手感参数(可调)
    this.alpha = 0.20;       // g-h 滤波位置增益(Mixxx 建议 ~1/8)
    this.beta = 0.20 / 32;   // 速度增益 ≈ alpha/32
    this.friction = 0.06;    // 松手滑垫回拉(每 block 趋近,越小越"滑")
    this.directSlew = 0.10;  // direct 模式 vel 平滑(每 block)

    this.posDiv = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      switch (m.type) {
        case 'load':
          this.ch = m.channels; this.len = m.channels[0] ? m.channels[0].length : 0;
          this.srcRate = m.sampleRate || 48000;
          this.phase = 0; this.targetPhase = 0; this.vel = 0; this.mode = 'free'; this.freeRate = 0;
          break;
        case 'target':
          // 抓盘瞬间:把内部 phase 折回 0..len,与 UI 上送的种子位置对齐(否则残差=k*len 巨跳)
          if (this.mode !== 'filter' && this.len) this.phase = ((this.phase % this.len) + this.len) % this.len;
          this.mode = 'filter'; this.targetPhase = m.phase; break;
        case 'release': this.mode = 'free'; break;
        case 'jump': if (this.len) this.phase = m.value * this.len; break;  // cue 跳位(0..1)
        case 'play':  // 让盘走(原子):落到 cue 并以马达速正向播 —— 一条消息,免两消息竞争
          if (this.len) this.phase = m.cue * this.len;
          this.freeRate = m.rate != null ? m.rate : 1;
          this.mode = 'free';
          break;
        case 'vel': this.mode = 'direct'; this.vTarget = m.value; break;
        case 'scratch':
          // 位置驱动(技巧/撮盘序列器):给绝对目标位置,读头精确跟随。
          // 进入瞬间把内部 phase 折回 0..len,与序列器送的 [0,len) 目标同域(否则残差=k*len 巨跳)。
          if (this.mode !== 'scratch' && this.len) this.phase = ((this.phase % this.len) + this.len) % this.len;
          this.mode = 'scratch'; this.targetPhase = m.phase; break;
        case 'free': this.freeRate = m.rate; if (this.mode !== 'filter') this.mode = 'free'; break;
        case 'tune':
          if (m.alpha != null) { this.alpha = m.alpha; this.beta = m.beta != null ? m.beta : m.alpha / 32; }
          if (m.friction != null) this.friction = m.friction;
          if (m.directSlew != null) this.directSlew = m.directSlew;
          break;
      }
    };
    this.vTarget = 0;
  }

  // Catmull-Rom 在浮点位置 p 取一个声道
  read1(c, p) {
    const n = c.length; if (n === 0) return 0;
    const i = Math.floor(p), f = p - i;
    const a = c[((i-1)%n+n)%n], b = c[((i)%n+n)%n], cc = c[((i+1)%n+n)%n], d = c[((i+2)%n+n)%n];
    return b + 0.5*f*(cc-a + f*(2*a-5*b+4*cc-d + f*(3*(b-cc)+d-a)));
  }

  process(_in, outputs, params) {
    const out = outputs[0];
    if (!this.len || out.length === 0) return true;
    const gate = params.gate;
    const ratio = this.srcRate / sampleRate;
    const frames = out[0].length;
    const stereo = this.ch.length > 1;

    // --- 控制层:每 block 更新一次 vel(按 mode) ---
    if (this.mode === 'filter') {
      // alpha-beta(g-h)滤波:用目标位置反推平滑速度 + 位置修正
      const dt = frames;                                   // 以输出采样为时间单位
      const predicted = this.phase + this.vel * dt;        // 预测(vel*dt = 推进的 src 采样)
      const residual = this.targetPhase - predicted;       // 残差(src 采样)
      this._nudge = this.alpha * residual;                 // 位置修正,跨 block 均摊(防咔哒)
      this.vel = this.vel + (this.beta * residual) / dt;   // 速度修正(惯性来源)
    } else if (this.mode === 'scratch') {
      // 位置一阶跟随:本 block 朝 targetPhase 趋近一部分(不一次到位)。
      // 这样两次目标更新之间读头仍在匀速移动,velocity 连续 → 无锯齿/停顿。
      // 声音即来自这个位置变化率,所以「行程多远」直接决定音高/咬字,零漂移、限定在范围内。
      this.vel = (this.targetPhase - this.phase) / (frames * ratio) * 0.6;
      this._nudge = 0;
    } else if (this.mode === 'direct') {
      this.vel += (this.vTarget - this.vel) * this.directSlew; // 序列器:轻平滑
      this._nudge = 0;
    } else { // free:滑垫把转速带回 freeRate
      this.vel += (this.freeRate - this.vel) * this.friction;
      this._nudge = 0;
      if (Math.abs(this.vel - this.freeRate) < 1e-4) this.vel = this.freeRate;
    }
    const nudgePer = (this._nudge || 0) / frames;

    // --- 音频层:逐采样推进 + 读样本 ---
    // step = 每采样实际位移(速度推进 + alpha 位置修正)。两者都要进读头,
    // 否则靠 nudge 驱动的运动会漏掉超采样抗锯齿、且读头跳变不插值 → 锯齿。
    const step = this.vel * ratio + nudgePer;
    const M = Math.min(4, Math.max(1, Math.round(Math.abs(step))));  // 与速度匹配的超采样数
    const c0 = this.ch[0], c1 = stereo ? this.ch[1] : null;
    for (let s = 0; s < frames; s++) {
      const g = gate.length > 1 ? gate[s] : gate[0];
      let l = 0, r = 0;
      for (let k = 0; k < M; k++) {
        const pp = this.phase + step * (k / M);            // 沿本采样轨迹平均 = 抗锯齿
        l += this.read1(c0, pp);
        if (c1) r += this.read1(c1, pp);
      }
      l /= M; r = c1 ? r / M : l;
      out[0][s] = l * g;
      if (out.length > 1) out[1][s] = r * g;
      this.phase += step;
    }

    // 防 float 漂移:把 phase/targetPhase 同步回基(保持残差不变)
    if (this.phase > this.len * 64 || this.phase < -this.len * 64) {
      const k = Math.floor(this.phase / this.len) * this.len;
      this.phase -= k; this.targetPhase -= k;
    }

    this.posDiv += frames;
    if (this.posDiv >= 700) {
      this.posDiv = 0;
      this.port.postMessage({ type: 'pos', phase: ((this.phase % this.len) + this.len) % this.len, vel: this.vel, len: this.len, mode: this.mode, target: this.targetPhase });
    }
    return true;
  }
}

registerProcessor('scrub-processor', ScrubProcessor);
