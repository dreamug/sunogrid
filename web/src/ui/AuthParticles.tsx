'use client';
// 认证页背景:漂浮微尘(Drift)。暖白微粒缓慢上浮 + 轻微横摆,少量陶土色点缀,呼应主题强调色。
// 极克制:密度随面积、上限封顶,纯 canvas;尊重 prefers-reduced-motion(降级为静态星点,不动)。
import { useEffect, useRef } from 'react';

export function AuthParticles() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0, raf = 0, last = 0;

    type Mote = { x: number; y: number; r: number; a: number; vy: number; sp: number; ph: number; acc: boolean };
    let motes: Mote[] = [];
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);

    const seed = () => {
      const n = Math.round(Math.max(18, Math.min(56, (W * H) / 14000))); // 密度随面积,18~56 封顶
      motes = [];
      for (let i = 0; i < n; i++) {
        motes.push({
          x: rnd(0, W), y: rnd(0, H), r: rnd(0.6, 2.3), a: rnd(0.05, 0.34),
          vy: rnd(5, 15), sp: rnd(0.3, 0.9), ph: rnd(0, 6.2832), acc: Math.random() < 0.14,
        });
      }
    };

    const draw = (t: number, dt: number) => {
      ctx.clearRect(0, 0, W, H);
      for (const m of motes) {
        if (!reduce) {
          m.y -= m.vy * dt;                              // 缓慢上浮
          m.x += Math.sin(t / 1000 * m.sp + m.ph) * 0.18; // 轻微横摆
          if (m.y < -6) { m.y = H + 6; m.x = rnd(0, W); } // 出顶回底
        }
        ctx.beginPath();
        ctx.fillStyle = m.acc ? `rgba(194,114,79,${m.a * 0.9})` : `rgba(236,233,227,${m.a})`;
        ctx.arc(m.x, m.y, m.r, 0, 6.2832);
        ctx.fill();
      }
    };

    const frame = (t: number) => {
      const dt = last ? Math.min((t - last) / 1000, 0.05) : 0.016;
      last = t;
      draw(t, dt);
      raf = requestAnimationFrame(frame);
    };

    const resize = () => {
      W = cv.clientWidth; H = cv.clientHeight;
      if (!W || !H) return;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
      if (reduce) draw(0, 0); // 静态星点画一帧即可
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    if (!reduce) raf = requestAnimationFrame(frame);

    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return <canvas ref={ref} className="auth-particles" aria-hidden="true" />;
}
