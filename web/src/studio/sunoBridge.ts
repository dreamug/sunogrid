'use client';
// app 侧 Suno 桥接客户端:通过 window.postMessage 跟插件(localhost 注入的 bridge.js)通信。
// 不需要知道插件 ID;插件不在/未登录会超时报错。
let idc = 0;

function call<T = unknown>(cmd: string, args: Record<string, unknown>, timeoutMs = 90000): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = 'app' + idc++;
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.source !== 'APP_SUNO_RES' || d.id !== id) return;
      cleanup();
      if (d.ok) resolve(d.data as T);
      else reject(new Error(d.error || 'failed'));
    };
    const to = setTimeout(() => { cleanup(); reject(new Error('桥接超时:插件没响应(装了吗?suno.com 开着并登录吗?)')); }, timeoutMs);
    const cleanup = () => { clearTimeout(to); window.removeEventListener('message', onMsg); };
    window.addEventListener('message', onMsg);
    window.postMessage({ source: 'APP_SUNO', id, cmd, args }, '*');
  });
}

export interface BridgeClip {
  id: string;
  status: string;
  audio_url?: string;
  duration?: number;
}

// web 现状:走插件 postMessage(下面这套一字不改)。
const webBridge = {
  status: () => call<{ hasAuth: boolean; hasTemplate: boolean }>('status', {}, 8000),
  generate: (args: { prompt: string; mode?: 'sound' | 'advanced'; loop?: boolean; bpm?: number; key?: string }) =>
    call<{ batchId: string; clipIds: string[] }>('generate', args, 120000),
  poll: (clipIds: string[]) => call<BridgeClip[]>('poll', { clipIds }, 15000),
  download: (url: string) => call<{ b64: string; contentType: string }>('download', { url }),
};

// §19 桌面化:Electron 的 preload 注入 window.sunogrid.bridge(内嵌 suno.com 驱动)。
// 有它 → 走 IPC 桥;否则(web)→ 走上面的插件 postMessage。调用方(studioGens/StudioApp)无感。
// ⚠ 铁律:web 上 window.sunogrid 为 undefined → sunoBridge === webBridge,行为与改动前完全一致。
const desktopBridge =
  typeof window !== 'undefined'
    ? (window as unknown as { sunogrid?: { bridge?: typeof webBridge } }).sunogrid?.bridge
    : undefined;

export const sunoBridge: typeof webBridge = desktopBridge ?? webBridge;

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
