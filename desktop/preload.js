// preload —— §19 适配层的唯一收口。
// 在 contextIsolation 下往渲染进程注入最小、typed 的 `window.sunogrid`。
//   - 它的存在即平台判定:共享核心里 `isDesktop = !!window.sunogrid`。
//   - bridge.*:签名与 web 侧 sunoBridge 对齐 → 调用方(sunoBridge.ts shim)无感。
//     走 ipcRenderer.invoke('suno:*') → 主进程在隐藏 suno 窗口里驱动 window.__sunoDrive。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sunogrid', {
  platform: 'desktop',
  version: '0.1.0',

  // Suno 桥(C 案):桌面用内嵌 suno.com 驱动,替代 Chrome 插件。
  bridge: {
    status: () => ipcRenderer.invoke('suno:status'),
    generate: (args) => ipcRenderer.invoke('suno:generate', args),
    poll: (clipIds) => ipcRenderer.invoke('suno:poll', clipIds),
    download: (url) => ipcRenderer.invoke('suno:download', url),
  },

  // 露出 Suno 登录窗(供 UI 的「连接 Suno」按钮调;无则用菜单 Suno → 登录)。
  showSunoLogin: () => ipcRenderer.invoke('suno:show-login'),

  // 文本输入弹窗(Electron 无原生 prompt;web 仍走 window.prompt)。见 web/src/ui/promptText.ts。
  promptText: (message, def) => ipcRenderer.invoke('ui:prompt', { message, def }),

  // Phase 3 —— 本地素材入库(读本地文件 → 传云端 storage)。
  ingest: {
    pickFiles: () => Promise.reject(new Error('desktop: 该能力尚未实现(Phase 3)')),
    pickFolder: () => Promise.reject(new Error('desktop: 该能力尚未实现(Phase 3)')),
  },
});

// 桌面专属:往页面注入一个常驻「Suno」浮标按钮(打开 Suno 窗口 / 解验证码用)。
// 纯 preload DOM 注入 → 不碰任何 web 代码;web 上没有 window.sunogrid,也就没有这个按钮。
// 编辑器页(/projects/[id])有顶栏内的「Suno」按钮(见 StudioApp.tsx)→ 浮标隐藏,免重复/挡控件。
// 其它页(如列表页 /projects)→ 浮标显示在左下角(用户确认 OK)。
function positionSunoButton(btn) {
  const isEditor = /^\/projects\/[^/]+/.test(location.pathname);
  if (isEditor) {
    btn.style.display = 'none';
  } else {
    Object.assign(btn.style, { display: '', left: '12px', bottom: '12px', top: 'auto', right: 'auto' });
  }
}

function injectSunoButton() {
  if (!document.body) return null;
  let btn = document.getElementById('__sg_suno_btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = '__sg_suno_btn';
    btn.textContent = '🎵 Suno';
    btn.title = '打开 Suno 窗口(登录 / 解验证码)';
    Object.assign(btn.style, {
      position: 'fixed',
      zIndex: '2147483647',
      padding: '6px 12px',
      borderRadius: '999px',
      border: '1px solid rgba(255,255,255,.18)',
      background: 'rgba(20,20,26,.92)',
      color: '#e8e8ea',
      font: '12px -apple-system, system-ui, sans-serif',
      cursor: 'pointer',
      boxShadow: '0 2px 10px rgba(0,0,0,.45)',
    });
    btn.addEventListener('click', () => ipcRenderer.invoke('suno:show-login'));
    document.body.appendChild(btn);
  }
  positionSunoButton(btn);
  return btn;
}

// preload 在 isolated world,patch 不到页面 main world 的 history → 用轮询跟随 SPA 路由变化,
// 顺便在被偶发移除时补回。轮询很轻(只读 pathname,变了才动样式)。
let __sgLastPath = null;
function sunoButtonTick() {
  injectSunoButton();
  if (location.pathname !== __sgLastPath) {
    __sgLastPath = location.pathname;
    const btn = document.getElementById('__sg_suno_btn');
    if (btn) positionSunoButton(btn);
  }
}
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', sunoButtonTick);
} else {
  sunoButtonTick();
}
setInterval(sunoButtonTick, 500);
