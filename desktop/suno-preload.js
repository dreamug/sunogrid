// 桌面版 Suno 驱动 —— 由 suno-bridge/interceptor.js 收口而来(C 案,见 PRODUCT.md §19)。
// 跑法:挂在隐藏 suno.com 窗口的 preload 上,且该窗口 contextIsolation:false →
//   本脚本与页面共享 MAIN world、且在页面脚本之前执行(document_start),
//   于是能在 Suno 反爬包装 fetch 之前抢先 patch、并访问 window.Clerk / DOM。
// 与插件版的区别:不再用 postMessage/relay/background 三段转发;主进程直接
//   executeJavaScript 调 window.__sunoDrive.*(见 main.js)。逻辑本体一字未改。
(() => {
  const API = 'https://studio-api-prod.suno.com';
  const nativeFetch = window.fetch; // 在反爬包装之前捕获的原生 fetch

  let template = null;
  let pendingGen = null;
  const feedCache = new Map();

  // patch fetch(在反爬包装层之下):观察 generate / feed 的请求与响应
  window.fetch = function (input, init) {
    let url = '';
    try { url = input instanceof Request ? input.url : String(input); } catch (_) {}
    const p = nativeFetch.apply(this, arguments);
    if (/studio-api-prod\.suno\.com/.test(url)) {
      if (/\/api\/generate\/v2-web/.test(url)) {
        try {
          const body = init && init.body != null ? String(init.body) : null;
          if (body) template = JSON.parse(body);
        } catch (_) {}
        p.then(async (r) => {
          let j = null;
          try { j = await r.clone().json(); } catch (_) {}
          if (!pendingGen) return;
          const pg = pendingGen; pendingGen = null;
          if (r.status === 200 && j && j.clips) pg.resolve({ batchId: j.id, clipIds: j.clips.map((c) => c.id) });
          else pg.reject(new Error('generate ' + r.status + ': ' + JSON.stringify(j).slice(0, 200)));
        }).catch(() => {});
      } else if (/\/api\/feed\/v3/.test(url)) {
        p.then(async (r) => {
          try {
            const j = await r.clone().json();
            const arr = Array.isArray(j) ? j : (j.clips || []);
            for (const c of arr) if (c && c.id) feedCache.set(c.id, { id: c.id, status: c.status, audio_url: c.audio_url, duration: c.metadata && c.metadata.duration });
          } catch (_) {}
        }).catch(() => {});
      }
    }
    return p;
  };

  // --- DOM 驱动 ---
  function setReactValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const visEl = (el) => !!el && el.offsetParent !== null && el.getClientRects().length > 0;
  const btnByText = (txt) => {
    const t = txt.toLowerCase();
    const all = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim().toLowerCase() === t);
    return all.find(visEl) || all[0];
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const fire = (el) => {
    if (!el) return;
    for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const E = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new E(type, { bubbles: true, cancelable: true, view: window }));
    }
  };

  function keyToText(key) {
    const m = String(key || '').trim().match(/^([A-G]#?)(m)?$/);
    if (!m) return '';
    return m[1] + (m[2] ? ' minor' : ' major');
  }

  async function setSoundKey(key) {
    const m = String(key || '').trim().match(/^([A-G]#?)(m)?$/);
    if (!m) return;
    const note = m[1];
    const mode = m[2] ? 'Minor' : 'Major';
    const open = [...document.querySelectorAll('button')].find((b) => visEl(b) && /^(Any|[A-G]#?\s?(min|maj)?)$/.test((b.textContent || '').trim()));
    if (!open) return;
    fire(open); await wait(320);
    const inPop = (el) => !!el.closest('[data-radix-popper-content-wrapper],[role="dialog"],[data-state="open"]');
    const tap = (label) => { const b = [...document.querySelectorAll('button')].find((x) => visEl(x) && inPop(x) && (x.textContent || '').trim() === label); if (b) fire(b); };
    tap(note); await wait(160);
    tap(mode); await wait(160);
    tap('Apply'); await wait(260);
  }

  async function clickCreateWhenReady() {
    let btn = null;
    for (let i = 0; i < 25; i++) {
      btn = btnByText('Create');
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') break;
      await wait(100);
    }
    if (!btn) throw new Error('找不到 Create 按钮');
    fire(btn);
  }

  async function uiGenerate({ mode = 'sound', prompt, loop = true, bpm, key } = {}) {
    if (!window.Clerk || !window.Clerk.session) throw new Error('未登录 suno.com');
    const tabBtn = btnByText(mode === 'advanced' ? 'Advanced' : 'Sounds');
    if (tabBtn) fire(tabBtn);
    await wait(800);

    const run = new Promise((resolve, reject) => {
      const to = setTimeout(() => { if (pendingGen) { pendingGen = null; reject(new Error('生成超时:UI 未发出请求或被反爬拦截')); } }, 30000);
      pendingGen = { resolve: (v) => { clearTimeout(to); resolve(v); }, reject: (e) => { clearTimeout(to); reject(e); } };
    });

    try {
      if (mode === 'advanced') {
        let styleTa = null;
        for (const sel of ['[aria-label^="Add style:"]', '[aria-label="Personalize style prompt to match your taste"]', '[aria-label="Clear styles"]', '[aria-label="Refresh recommended styles"]']) {
          const a = document.querySelector(sel);
          if (!a) continue;
          let p = a;
          for (let i = 0; i < 8 && p; i++) { p = p.parentElement; const ta = p && p.querySelector('textarea'); if (ta && visEl(ta)) { styleTa = ta; break; } }
          if (styleTa) break;
        }
        if (!styleTa) throw new Error('找不到 Advanced 风格框:请把 suno.com 切到 Create → Advanced');
        const style = [prompt, bpm ? bpm + ' BPM' : '', keyToText(key), 'instrumental'].filter(Boolean).join(', ');
        setReactValue(styleTa, style);
        await wait(180);
        const lyrics = document.querySelector('textarea[placeholder^="[Verse]"]');
        if (visEl(lyrics)) { const instr = btnByText('Instrumental'); if (instr) { fire(instr); await wait(220); } }
        await clickCreateWhenReady();
      } else {
        const ta = document.querySelector('textarea[placeholder="Describe the sound you want"]');
        if (!ta || !visEl(ta)) throw new Error('找不到 Sound 输入框:请把 suno.com 切到 Create → Sounds');
        setReactValue(ta, prompt);
        const typeBtn = btnByText(loop ? 'Loop' : 'One-Shot'); if (typeBtn) fire(typeBtn);
        if (bpm) { const b = document.querySelector('input[type="number"][placeholder="Auto"]'); if (b) setReactValue(b, String(bpm)); }
        await setSoundKey(key);
        await wait(120);
        await clickCreateWhenReady();
      }
    } catch (e) {
      pendingGen = null;
      throw e;
    }
    return run;
  }

  async function poll(clipIds) {
    clipIds = clipIds || [];
    const missing = clipIds.filter((id) => { const c = feedCache.get(id); return !c || c.status !== 'complete'; });
    if (missing.length) {
      try {
        const t = window.Clerk && window.Clerk.session ? await window.Clerk.session.getToken() : null;
        const r = await window.fetch(API + '/api/feed/v3', {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, t ? { authorization: 'Bearer ' + t } : {}),
          body: JSON.stringify({ filters: { ids: { presence: 'True', clipIds } }, limit: clipIds.length }),
          credentials: 'include',
        });
        if (r.ok) {
          const j = await r.json();
          const arr = Array.isArray(j) ? j : (j.clips || []);
          for (const c of arr) if (c && c.id) feedCache.set(c.id, { id: c.id, status: c.status, audio_url: c.audio_url, duration: c.metadata && c.metadata.duration });
        }
      } catch (_) {}
    }
    return clipIds.map((id) => feedCache.get(id) || { id, status: 'pending' });
  }

  function toB64(buf) {
    const u = new Uint8Array(buf);
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u.length; i += CHUNK) s += String.fromCharCode.apply(null, u.subarray(i, i + CHUNK));
    return btoa(s);
  }
  async function download(url) {
    const r = await nativeFetch(url);
    if (!r.ok) throw new Error('download ' + r.status);
    return { b64: toB64(await r.arrayBuffer()), contentType: r.headers.get('content-type') || 'audio/mpeg' };
  }

  const status = () => ({
    hasAuth: !!(window.Clerk && window.Clerk.session),
    hasUI: !!document.querySelector('textarea[placeholder="Describe the sound you want"]'),
    hasTemplate: !!template,
  });

  // 主进程通过 executeJavaScript 直接调这几个(C 案:无需页面内命令转发)。
  window.__sunoDrive = { generate: uiGenerate, poll, download, status };
  console.log('%c[sunogrid-desktop] Suno driver active', 'color:#0a0;font-weight:bold');
})();
