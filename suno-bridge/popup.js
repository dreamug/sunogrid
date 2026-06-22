const $ = (id) => document.getElementById(id);

// ===== Bridge 连接:把 bridge.js 动态注册到用户授权的 app 域名 =====
// 内建(写死在 manifest)= sunogrid.com + localhost,零点击;其它自托管域名 → 这里点 Connect 授权后动态注册(持久,刷新不掉)。
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

// ===== Sniffer(legacy 调试:旧驱动抓请求模板用,新驱动已不需要;background 无 handler 时静默)=====
let LOG = [];
function hasAuth(e) {
  const h = e.reqHeaders || {};
  return Object.keys(h).some((k) => k.toLowerCase() === 'authorization');
}
function filtered() {
  const q = $('filter').value.trim().toLowerCase();
  const onlyAuth = $('onlyauth').checked;
  return LOG.filter((e) => {
    if (q && !(e.url || '').toLowerCase().includes(q)) return false;
    if (onlyAuth && !hasAuth(e)) return false;
    return true;
  });
}
function render() {
  const items = filtered();
  $('count').textContent = `${items.length} / ${LOG.length}`;
  const list = $('list');
  list.innerHTML = '';
  items.slice().reverse().forEach((e) => {
    const div = document.createElement('div');
    div.className = 'item';
    const sClass = 's' + String(e.status || '')[0];
    const path = (() => { try { return new URL(e.url).pathname; } catch { return e.url; } })();
    div.innerHTML =
      `<span class="m">${e.method}</span> ` +
      `<span class="${sClass}">${e.status ?? 'ERR'}</span> ` +
      (hasAuth(e) ? `<span class="auth">🔑</span> ` : '') +
      `<span class="u">${path}</span>`;
    div.title = '点击复制这一条的完整 JSON';
    div.onclick = () => navigator.clipboard.writeText(JSON.stringify(e, null, 2));
    list.appendChild(div);
  });
}
function load() {
  chrome.runtime.sendMessage({ kind: 'get' }, (resp) => {
    if (chrome.runtime.lastError) return; // 新版 background 不再记录请求模板,无接收方 → 静默
    LOG = (resp && resp.log) || [];
    render();
  });
}
$('filter').oninput = render;
$('onlyauth').onchange = render;
$('dl').onclick = () => {
  const data = JSON.stringify(filtered(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'suno-capture.json';
  a.click();
};
$('clear').onclick = () => {
  chrome.runtime.sendMessage({ kind: 'clear' }, () => { if (chrome.runtime.lastError) return; LOG = []; render(); });
};

renderBridge();
load();
