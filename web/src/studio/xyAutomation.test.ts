// §26 纯逻辑单测(bar 域):`npx tsx src/studio/xyAutomation.test.ts`。无 DOM/引擎依赖。
import { sampleAuto, sampleXY, defaultAutomation, isActiveAuto, isStepAxis, sortPoints, NEUTRAL, normalizeXyAuto, volGain, isActiveVol, normalizeVolAuto, VOL_NEUTRAL } from './xyAutomation';

let fails = 0;
const eq = (name: string, got: number, exp: number, tol = 1e-9) => {
  if (Math.abs(got - exp) <= tol) console.log('ok  ', name);
  else { fails++; console.error('FAIL', name, '→ got', got, 'expected', exp); }
};
const truthy = (name: string, cond: boolean) => { if (cond) console.log('ok  ', name); else { fails++; console.error('FAIL', name); } };

// 线性插值 + 端点 hold(域=bar)
const lin = [{ bar: 0, v: 0 }, { bar: 8, v: 1 }];
eq('lin mid (bar4)', sampleAuto(lin, 4), 0.5);
eq('lin q (bar2)', sampleAuto(lin, 2), 0.25);
eq('hold before', sampleAuto(lin, -1), 0);
eq('hold after', sampleAuto(lin, 99), 1);

// 台阶(零阶保持)— 离散 X
const stp = [{ bar: 0, v: 0.1 }, { bar: 4, v: 0.9 }];
eq('step before bp', sampleAuto(stp, 3.9, true), 0.1);
eq('step at bp', sampleAuto(stp, 4, true), 0.9);
eq('step after', sampleAuto(stp, 6, true), 0.9);
eq('linear same data (bar2)', sampleAuto(stp, 2, false), 0.5);

// 边界
eq('empty → neutral', sampleAuto([], 3), 0.5);
eq('clamp hi', sampleAuto([{ bar: 0, v: 2 }, { bar: 4, v: 2 }], 2), 1);
eq('clamp lo', sampleAuto([{ bar: 0, v: -1 }, { bar: 4, v: -1 }], 2), 0);
eq('sorted mid', sampleAuto(sortPoints([{ bar: 8, v: 1 }, { bar: 0, v: 0 }]), 4), 0.5);

// repeat 非破坏:点在 bar 6/8,total 缩到 4 → 采样在 bar0..4 不受影响(端点 hold 到 bar4 的值)
const shaped = [{ bar: 0, v: .2 }, { bar: 4, v: .9 }, { bar: 6, v: .3 }, { bar: 8, v: .6 }];
eq('truncate-safe sample at bar3', sampleAuto(shaped, 3), .2 + (.9 - .2) * (3 / 4));
eq('beyond-range hold (bar4 value)', sampleAuto(shaped, 4), .9);

// 默认自动化 = 中性平直线,端点在 0 和 totalBars(§26.v3 无 on,且默认=未激活)
const d = defaultAutomation('filter', 8);
eq('default flat x (bar5)', sampleAuto(d.x, 5), NEUTRAL.filter.x);
eq('default end bar', d.x[d.x.length - 1].bar, 8);
truthy('default shape (首尾2点,无 on/program)', d.x.length === 2 && d.y.length === 2 && !('on' in d) && !('program' in d));

// §26.v3 isActiveAuto:默认平直线=未激活;离开中线 / 多出点 = 激活;空/退化=未激活
truthy('default inactive', !isActiveAuto('filter', d));
truthy('off-neutral active', isActiveAuto('filter', { x: [{ bar: 0, v: 0.5 }, { bar: 8, v: 0.9 }], y: [{ bar: 0, v: 0.5 }, { bar: 8, v: 0.5 }] }));
truthy('extra point active', isActiveAuto('filter', { x: [{ bar: 0, v: 0.5 }, { bar: 4, v: 0.5 }, { bar: 8, v: 0.5 }], y: [{ bar: 0, v: 0.5 }, { bar: 8, v: 0.5 }] }));
truthy('y-only active', isActiveAuto('delay', { x: [{ bar: 0, v: 0.5 }, { bar: 8, v: 0.5 }], y: [{ bar: 0, v: 0.5 }, { bar: 8, v: 0.9 }] }));
truthy('empty inactive', !isActiveAuto('filter', { x: [], y: [] }));

// isStepAxis + sampleXY(program 入参;slicer x 台阶,y 线性)
truthy('step axes', isStepAxis('slicer', 'x') && isStepAxis('delay', 'x') && !isStepAxis('filter', 'x') && !isStepAxis('slicer', 'y'));
const sx = sampleXY('slicer', { x: [{ bar: 0, v: 0.1 }, { bar: 4, v: 0.9 }], y: [{ bar: 0, v: 0 }, { bar: 8, v: 1 }] }, 2);
eq('sampleXY step x (bar2)', sx.x, 0.1);
eq('sampleXY lin y (bar2)', sx.y, 0.25);

// §26.v3 normalizeXyAuto:老单形状/老 map(带 on)→ map 去 on;只留非平(激活);脏/空 → 丢
const mig = normalizeXyAuto({ program: 'filter', on: true, x: [{ bar: 0, v: 0.2 }], y: [{ bar: 0, v: 0 }] });
truthy('migrate old→map (去 on)', !!mig && !!mig.filter && mig.filter.x[0].v === 0.2 && !('on' in mig.filter) && !('program' in mig.filter));
const mp = normalizeXyAuto({ filter: { on: true, x: [{ bar: 0, v: 0.2 }, { bar: 4, v: 0.9 }], y: [] }, delay: { on: false, x: [], y: [] } });
truthy('keep active, drop flat/empty', !!mp && !!mp.filter && !mp.delay && !('on' in mp.filter)); // filter 非平=留;delay 空=丢
truthy('all-flat map → null', normalizeXyAuto({ filter: { x: [{ bar: 0, v: 0.5 }, { bar: 8, v: 0.5 }], y: [{ bar: 0, v: 0.5 }, { bar: 8, v: 0.5 }] } }) === null);
// v2 旧中性(x 平 0.5,y 平 0)= 老「插入未画」幽灵 → 迁移丢弃(否则 y=0≠新中线 0.5 被误判激活)
truthy('drop v2 old-neutral (y=0 flat)', normalizeXyAuto({ filter: { on: true, x: [{ bar: 0, v: 0.5 }, { bar: 8, v: 0.5 }], y: [{ bar: 0, v: 0 }, { bar: 8, v: 0 }] } }) === null);
truthy('keep old data drawn up from y=0', !!normalizeXyAuto({ delay: { on: true, x: [{ bar: 0, v: 0.5 }, { bar: 8, v: 0.5 }], y: [{ bar: 0, v: 0 }, { bar: 8, v: 0.9 }] } })?.delay);
truthy('dirty → null', normalizeXyAuto(null) === null && normalizeXyAuto({ foo: 1 }) === null);
const dp = normalizeXyAuto({ filter: { on: true, x: [{ bar: 0, v: 0.5 }, null, { bar: 'x', v: 1 }, { bar: 4, v: 0.9 }], y: [{}] } });
truthy('dirty points filtered', !!dp && !!dp.filter && dp.filter.x.length === 2 && dp.filter.y.length === 0 && sampleAuto(dp.filter.x, 2) === 0.7); // 坏点剔除,采样不崩

// §41 音量自动化:volGain 平方律 taper(中性=顶端 unity)+ isActiveVol/normalizeVolAuto(只留非平,平=null)
eq('volGain unity (v1)', volGain(1), 1);
eq('volGain silence (v0)', volGain(0), 0);
eq('volGain mid (v.5=-12dB)', volGain(0.5), 0.25);
eq('volGain clamp hi', volGain(2), 1);
eq('vol neutral const', VOL_NEUTRAL, 1);
truthy('vol flat-at-unity inactive', !isActiveVol([{ bar: 0, v: 1 }, { bar: 8, v: 1 }]));
truthy('vol off-unity active', isActiveVol([{ bar: 0, v: 1 }, { bar: 8, v: 0.3 }]));
truthy('vol extra-point active', isActiveVol([{ bar: 0, v: 1 }, { bar: 4, v: 1 }, { bar: 8, v: 1 }]));
truthy('vol empty inactive', !isActiveVol([]) && !isActiveVol(null));
truthy('normalizeVol keep active', normalizeVolAuto([{ bar: 0, v: 1 }, { bar: 8, v: 0.2 }])?.length === 2);
truthy('normalizeVol flat → null', normalizeVolAuto([{ bar: 0, v: 1 }, { bar: 8, v: 1 }]) === null);
truthy('normalizeVol dirty filtered', (() => { const r = normalizeVolAuto([{ bar: 0, v: 0.4 }, null, { bar: 'x', v: 1 }, { bar: 8, v: 1 }]); return !!r && r.length === 2 && sampleAuto(sortPoints(r), 4) === 0.4 + (1 - 0.4) * 0.5; })());

console.log(fails ? `\n${fails} TEST(S) FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
