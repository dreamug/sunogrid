// localhost ISOLATED:桥接本地 app(window.postMessage)↔ background(chrome.runtime)。
// app 发 {source:'APP_SUNO', id, cmd, args};收 {source:'APP_SUNO_RES', id, ...}。无需 app 知道插件 ID。
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.source !== 'APP_SUNO') return;
  try { chrome.runtime.sendMessage({ type: 'suno-cmd', id: d.id, cmd: d.cmd, args: d.args }); } catch (_) {}
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'suno-res') return;
  window.postMessage({ source: 'APP_SUNO_RES', id: msg.id, ok: msg.ok, data: msg.data, error: msg.error }, '*');
});

// 宣告插件在位(app 可据此判断)
window.postMessage({ source: 'APP_SUNO_READY' }, '*');
console.log('%c[suno-bridge] localhost bridge active', 'color:#0a0;font-weight:bold');
