'use client';
// §31 音频输出设备选择:列输出设备 + 监听插拔 + 一次性授权拿设备名(label)+ 加载时应用已存偏好。
// 设备偏好存 localStorage(机器本地环境偏好,deviceId 跨机器加盐无意义),不入库、不进 undo(§31.5)。
import { useCallback, useEffect, useState } from 'react';

export interface AudioOutput { deviceId: string; label: string; note?: string }
export const OUTPUT_KEY = 'sunogrid.outputDevice';
const SYS_DEFAULT: AudioOutput = { deviceId: 'default', label: 'System default' };

/** setSinkId 是否可用(Chrome/Edge 110+;Safari/Firefox 无)。静态特性检测,不需要 context 实例(§31.1)。 */
export const outputSwitchSupported = (): boolean =>
  typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

/** 加载时把已存的设备偏好应用到引擎(§31.5):校验设备仍在列表才应用;设备没了(拔掉/跨机器陈旧)→ 清偏好回落默认。 */
export async function applySavedOutput(eng: { setOutputDevice(id: string): Promise<void> }): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
  let id: string | null = null;
  try { id = localStorage.getItem(OUTPUT_KEY); } catch { /* localStorage 不可用 */ }
  if (!id || id === 'default') return;
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    if (outs.some((d) => d.deviceId === id)) await eng.setOutputDevice(id);
    else { try { localStorage.removeItem(OUTPUT_KEY); } catch { /* */ } }
  } catch { /* enumerate/setSinkId 失败:静默走系统默认 */ }
}

export function useAudioOutputs() {
  const [devices, setDevices] = useState<AudioOutput[]>([SYS_DEFAULT]);
  const [hasLabels, setHasLabels] = useState(false);

  const refresh = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
      setHasLabels(outs.some((d) => d.label)); // 未授权时 label 全空 → 提示用户解锁名称
      // 系统默认那条当前指向谁(Chrome 给 'Default - <名>',中文系统给 '默认 - <名>')→ 标注到 System default 行
      const def = outs.find((d) => d.deviceId === 'default');
      const note = def?.label?.replace(/^(?:Default|默认)\s*[-–—]\s*/i, '').trim() || undefined;
      const real = outs
        .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications') // 去掉伪条目,自己插一条 System default
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Speaker ${i + 1}` }));
      setDevices([{ ...SYS_DEFAULT, note }, ...real]);
    } catch { /* 失败保底:只留 System default */ }
  }, []);

  useEffect(() => {
    refresh();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    md.addEventListener('devicechange', refresh); // 插拔声卡/耳机 → 自动刷新列表
    return () => md.removeEventListener('devicechange', refresh);
  }, [refresh]);

  const requestLabels = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop()); // 只为拿一次授权解锁 label,立即释放麦克风
      await refresh();
    } catch { /* 用户拒授权:保持占位名 */ }
  }, [refresh]);

  return { devices, hasLabels, requestLabels };
}
