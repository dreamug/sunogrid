const $ = (id) => document.getElementById(id);

// 版本号(从 manifest 读,显示在标题旁)
try { $('ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) {}

// ===== suno.com 连接/登录状态 =====
// 探测链:popup → background(popup-probe)→ 路由到在听的 suno 标签 → interceptor.status() → 回传。
// 绿 = 有登录会话即可生成;红 = 没 suno 标签 / 标签未就绪(刚装/刚重载,需刷新该标签)/ 没登录;灰闪 = 检测中。
async function sunoTabs() {
  try { return await chrome.tabs.query({ url: ['https://suno.com/*', 'https://*.suno.com/*'] }); }
  catch { return []; }
}
function probeBg(timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'timeout' }); } }, timeoutMs);
    try {
      chrome.runtime.sendMessage({ type: 'popup-probe' }, (res) => {
        if (done) return; done = true; clearTimeout(to);
        if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
        resolve(res || { ok: false });
      });
    } catch (e) { clearTimeout(to); resolve({ ok: false, error: String(e) }); }
  });
}
function setSuno(state, title, detail, showOpen) {
  $('su-led').className = 'led ' + state;       // ok | err | checking
  $('su-title').textContent = title;
  $('su-detail').textContent = detail;
  $('su-open').style.display = showOpen ? '' : 'none';
}
async function probeSuno() {
  setSuno('checking', 'Checking…', 'Talking to your suno.com tab…', false);
  const tabs = await sunoTabs();
  if (!tabs.length) {
    setSuno('err', 'No suno.com tab open', 'Open suno.com and log in, then re-check.', true);
    return;
  }
  const res = await probeBg();
  if (!res || !res.ok) {
    // 有 suno 标签但驱动不应答 = 内容脚本未注入(插件刚装/刚重载,而标签是更早开的)→ 刷新该标签
    setSuno('err', 'suno.com tab not ready', 'A suno.com tab is open but the bridge isn’t active in it yet. Reload that tab, then re-check.', false);
    return;
  }
  const d = res.data || {};
  if (d.hasAuth) {
    setSuno('ok', 'Connected & logged in', d.hasUI ? 'Ready to generate from the app.' : 'Logged in. Open Create on suno.com so generation can run.', false);
  } else {
    setSuno('err', 'Not logged in', 'A suno.com tab is open but you’re not logged in. Log in to suno.com, then re-check.', false);
  }
}
$('su-recheck').onclick = probeSuno;
$('su-open').onclick = async () => { try { await chrome.tabs.create({ url: 'https://suno.com/create' }); window.close(); } catch (_) {} };

// ===== App sites bridge:把 bridge.js 动态注册到用户授权的 app 域名 =====
// 内建(写死在 manifest)= sunogrid.com + localhost,零点击;其它自托管域名 → 点 Connect 授权后动态注册(持久,刷新不掉)。
const DYN_PREFIX = 'dyn-bridge-';

function patternOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null; // 跳过 chrome:// 等
    return `${u.protocol}//${u.hostname}/*`; // 去端口 → 合法 match pattern(localhost:3007 → http://localhost/*)
  } catch { return null; }
}
function isBuiltin(pattern) {
  try {
    const host = new URL(pattern.replace('/*', '/')).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === 'sunogrid.com' || host.endsWith('.sunogrid.com');
  } catch { return false; }
}
function idFor(pattern) { return DYN_PREFIX + pattern.replace(/[^a-z0-9]/gi, '_'); }
async function activeTab() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t; }
async function dynScripts() {
  try { return (await chrome.scripting.getRegisteredContentScripts()).filter((s) => s.id.startsWith(DYN_PREFIX)); }
  catch { return []; }
}

async function connect(pattern) {
  // 必须在用户手势内同步发起 permissions.request(本函数由点击直接调用,request 是首个调用,手势保留)
  const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
  if (!granted) return;
  const script = { id: idFor(pattern), matches: [pattern], js: ['bridge.js'], runAt: 'document_start', world: 'ISOLATED' };
  try { await chrome.scripting.registerContentScripts([script]); }
  catch { try { await chrome.scripting.updateContentScripts([script]); } catch (_) {} }
  const t = await activeTab(); if (t && t.id) chrome.tabs.reload(t.id); // 重载当前页 → bridge.js 立即注入
  renderBridge();
}
async function disconnect(pattern) {
  try { await chrome.scripting.unregisterContentScripts({ ids: [idFor(pattern)] }); } catch (_) {}
  await chrome.permissions.remove({ origins: [pattern] }).catch(() => {});
  renderBridge();
}

async function renderBridge() {
  const t = await activeTab();
  const pat = t ? patternOf(t.url) : null;
  const connected = new Set((await dynScripts()).flatMap((s) => s.matches || []));

  const cur = $('bx-cur');
  cur.innerHTML = '';
  const org = document.createElement('span');
  org.className = 'bx-org';
  org.textContent = pat || '— open your app tab to connect it —';
  cur.appendChild(org);
  if (pat) {
    if (isBuiltin(pat)) {
      const s = document.createElement('span'); s.className = 'bx-builtin'; s.textContent = 'built in ✓'; cur.appendChild(s);
    } else if (connected.has(pat)) {
      const s = document.createElement('span'); s.className = 'bx-state'; s.textContent = 'connected ✓'; cur.appendChild(s);
      const b = document.createElement('button'); b.textContent = 'Disconnect'; b.onclick = () => disconnect(pat); cur.appendChild(b);
    } else {
      const b = document.createElement('button'); b.textContent = 'Connect'; b.onclick = () => connect(pat); cur.appendChild(b);
    }
  }

  const list = $('bx-list'); list.innerHTML = '';
  for (const p of connected) {
    const row = document.createElement('div'); row.className = 'bx-item';
    const o = document.createElement('span'); o.className = 'o'; o.textContent = p;
    const b = document.createElement('button'); b.textContent = 'Disconnect'; b.onclick = () => disconnect(p);
    row.appendChild(o); row.appendChild(b); list.appendChild(row);
  }
}

renderBridge();
probeSuno();
