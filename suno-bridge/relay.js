// suno.com ISOLATED:桥接 background(chrome.runtime)↔ 页面 MAIN world 的驱动(window.postMessage)。
// 驱动改为"驱动 Suno UI 生成",不再需要请求模板,故不再持久化/回灌模板。
const CMD = '__SUNO_DRIVE__';
const RES = '__SUNO_DRIVE_RES__';

// 加载即向 background 注册:我是 suno 驱动标签
try { chrome.runtime.sendMessage({ type: 'relay-hello' }); } catch (_) {}

// background → 驱动:执行命令
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'suno-cmd') return;
  window.postMessage({ source: CMD, id: msg.id, cmd: msg.cmd, args: msg.args }, '*');
});

// 驱动 → background:结果
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.source !== RES) return;
  try { chrome.runtime.sendMessage({ type: 'suno-res', id: d.id, ok: d.ok, data: d.data, error: d.error }); } catch (_) {}
});
