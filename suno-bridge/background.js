// service worker:路由 localhost app ↔ suno.com 标签页驱动。
// 加固:driverTabId 存 storage.session(扛 SW 休眠);发送时若该标签没在听,遍历所有 suno 标签,发给第一个活着的 relay。
const pending = {};       // id -> appTabId(app 页发来的命令,结果回那个标签)
const pendingPopup = {};  // id -> sendResponse(popup 探测,结果回 popup)
let popupSeq = 0;

function setDriver(tabId) { if (tabId != null) chrome.storage.session.set({ driverTabId: tabId }); }
async function getDriver() { const { driverTabId } = await chrome.storage.session.get('driverTabId'); return driverTabId ?? null; }
async function allSunoTabs() {
  const tabs = await chrome.tabs.query({ url: ['https://suno.com/*', 'https://*.suno.com/*'] });
  return tabs.map((t) => t.id).filter((id) => id != null);
}

// 发给"真正在听的" suno 标签:优先已注册的,然后遍历所有 suno 标签,发给第一个不报错的
async function sendToDriver(msg) {
  const candidates = [];
  const d = await getDriver();
  if (d != null) candidates.push(d);
  for (const id of await allSunoTabs()) if (!candidates.includes(id)) candidates.push(id);
  for (const tabId of candidates) {
    try {
      await chrome.tabs.sendMessage(tabId, msg);
      setDriver(tabId);
      return true;
    } catch (_) { /* 这个标签没在听 relay,试下一个 */ }
  }
  return false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'relay-hello') {
    if (sender.tab) setDriver(sender.tab.id);
    return;
  }

  // popup → 探测 suno.com 状态:路由一条 status 给在听的驱动标签,异步把结果回给 popup。
  // 没有在听的 suno 标签 → 立即回 {ok:false};有 → interceptor.status() 经 relay 回到下面的 suno-res 分支。
  if (msg.type === 'popup-probe') {
    const id = 'pop' + (popupSeq++);
    pendingPopup[id] = sendResponse;
    sendToDriver({ type: 'suno-cmd', id, cmd: 'status', args: {} }).then((ok) => {
      if (!ok && pendingPopup[id]) { try { sendResponse({ ok: false, error: 'no-suno-tab' }); } catch (_) {} delete pendingPopup[id]; }
    });
    return true; // 异步 sendResponse:保持消息通道开着
  }

  if (msg.type === 'suno-cmd') {
    const appTabId = sender.tab && sender.tab.id;
    // 纵深防御:命令只接受来自页面标签(bridge.js 注入在 app 页);非标签来源直接丢弃。
    if (appTabId == null) return;
    pending[msg.id] = appTabId;
    sendToDriver({ type: 'suno-cmd', id: msg.id, cmd: msg.cmd, args: msg.args }).then((ok) => {
      if (!ok) {
        if (appTabId != null) chrome.tabs.sendMessage(appTabId, { type: 'suno-res', id: msg.id, ok: false, error: '找不到在听的 suno.com 标签页(刷新 suno.com 后重试)' }).catch(() => {});
        delete pending[msg.id];
      }
    });
  } else if (msg.type === 'suno-res') {
    // popup 探测的回程:直接 sendResponse,不经标签
    if (pendingPopup[msg.id]) {
      const reply = pendingPopup[msg.id]; delete pendingPopup[msg.id];
      try { reply({ ok: msg.ok, data: msg.data, error: msg.error }); } catch (_) {}
      return;
    }
    const appTabId = pending[msg.id];
    delete pending[msg.id];
    if (appTabId != null) chrome.tabs.sendMessage(appTabId, msg).catch(() => {});
  }
});
