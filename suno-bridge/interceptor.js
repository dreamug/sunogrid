// 跑在页面 MAIN world:驱动 Suno 自己的 UI 去生成(反爬只认真实 UI 流程,重放/重构 API 必被 token_validation_failed 拦),
// 再被动观察 fetch:从 generate 响应拿 clip ids、从 feed 响应缓存状态。token/反爬令牌全由 Suno 自己处理,我们不碰。
// 读接口(feed 轮询)用页面"包装后的" window.fetch(会带上反爬签名);写接口(generate)只能驱动 UI。
// 命令通过 window.postMessage 收发(给 ISOLATED relay 转发)。前提:suno.com 停在 Create → Sounds 页且已登录。
(() => {
  const API = 'https://studio-api-prod.suno.com';
  const CMD = '__SUNO_DRIVE__';
  const RES = '__SUNO_DRIVE_RES__';
  const nativeFetch = window.fetch; // document_start 捕获的原生 fetch(在反爬包装之前)

  let template = null;             // 仍捕获 generate 请求体(诊断用)
  let pendingGen = null;           // { resolve, reject } —— 等 UI 触发的 generate 响应
  const feedCache = new Map();     // clipId -> { id, status, audio_url, duration }

  // patch fetch(本 patch 在反爬包装层之下):观察 generate / feed 的请求与响应
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
    return all.find(visEl) || all[0]; // 两套表单都在 DOM 里,优先可见的那套
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 关键:radix 的 tab / Key 钢琴弹窗 等组件监听 pointerdown,不响应单纯的 .click()。
  // 必须发完整 pointer 序列(含 pointerdown)才驱动得了。普通按钮也吃这个,所以统一用 fire()。
  const fire = (el) => {
    if (!el) return;
    for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const E = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new E(type, { bubbles: true, cancelable: true, view: window }));
    }
  };

  // 调号码 → Advanced 风格词用的自然语言。'Am'→'A minor','C'→'C major';空=''。
  function keyToText(key) {
    const m = String(key || '').trim().match(/^([A-G]#?)(m)?$/);
    if (!m) return '';
    return m[1] + (m[2] ? ' minor' : ' major');
  }

  // 驱动 Sound 的 Key 钢琴弹窗(用 fire 才行):开 → 点音名 → 点 Major/Minor → Apply。key 如 'Am'/'C'/'F#m';空=Any(不动)
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

  // mode: 'sound'(短 loop/采样) | 'advanced'(整首纯器乐,进库后裁 loop)
  async function uiGenerate({ mode = 'sound', prompt, loop = true, bpm, key }) {
    if (!window.Clerk || !window.Clerk.session) throw new Error('未登录 suno.com');
    const tabBtn = btnByText(mode === 'advanced' ? 'Advanced' : 'Sounds');
    if (tabBtn) fire(tabBtn); // fire 才切得动 tab(.click 不发 pointerdown,切不动)
    await wait(800);

    // 先挂上等响应的 promise(fetch patch 收到 generate 响应时 resolve)
    const run = new Promise((resolve, reject) => {
      const to = setTimeout(() => { if (pendingGen) { pendingGen = null; reject(new Error('生成超时:UI 未发出请求或被反爬拦截')); } }, 30000);
      pendingGen = { resolve: (v) => { clearTimeout(to); resolve(v); }, reject: (e) => { clearTimeout(to); reject(e); } };
    });

    try {
      if (mode === 'advanced') {
        // 风格框无 id/name,且 "Clear styles" 仅在有内容时才出现 → 用永远存在的 "Add style:" chip 往上找 textarea
        let styleTa = null;
        for (const sel of ['[aria-label^="Add style:"]', '[aria-label="Personalize style prompt to match your taste"]', '[aria-label="Clear styles"]', '[aria-label="Refresh recommended styles"]']) {
          const a = document.querySelector(sel);
          if (!a) continue;
          let p = a;
          for (let i = 0; i < 8 && p; i++) { p = p.parentElement; const ta = p && p.querySelector('textarea'); if (ta && visEl(ta)) { styleTa = ta; break; } }
          if (styleTa) break;
        }
        if (!styleTa) throw new Error('找不到 Advanced 风格框:请把 suno.com 切到 Create → Advanced');
        // Advanced 没 BPM/Key 字段 → 折进风格词;并要求 instrumental(无人声 loop 素材)
        const style = [prompt, bpm ? bpm + ' BPM' : '', keyToText(key), 'instrumental'].filter(Boolean).join(', ');
        setReactValue(styleTa, style);
        await wait(180);
        // 歌词框还可见 = 未开器乐 → 点 Instrumental(器乐模式会隐藏歌词框);class 读不出状态,用可见性当代理
        const lyrics = document.querySelector('textarea[placeholder^="[Verse]"]');
        if (visEl(lyrics)) { const instr = btnByText('Instrumental'); if (instr) { fire(instr); await wait(220); } }
        await clickCreateWhenReady();
      } else {
        const ta = document.querySelector('textarea[placeholder="Describe the sound you want"]');
        if (!ta || !visEl(ta)) throw new Error('找不到 Sound 输入框:请把 suno.com 切到 Create → Sounds');
        setReactValue(ta, prompt);
        const typeBtn = btnByText(loop ? 'Loop' : 'One-Shot'); if (typeBtn) fire(typeBtn);
        if (bpm) { const b = document.querySelector('input[type="number"][placeholder="Auto"]'); if (b) setReactValue(b, String(bpm)); }
        await setSoundKey(key); // 真实 Key 字段(fire 驱动钢琴弹窗,实测能设上 "A min")
        await wait(120);
        await clickCreateWhenReady();
      }
    } catch (e) {
      pendingGen = null;
      throw e;
    }
    return run;
  }

  // --- 轮询:优先用观察到的 feed 缓存(页面渲染时自己在轮询);缺的再用"包装后的" window.fetch 主动拉 ---
  async function poll(clipIds) {
    // 没到 complete 就主动重拉:streaming 的缓存不会自己变 complete(页面渲完后就不再轮询那条),
    // 不主动拉就会永远停在 streaming,而 app 只认 complete → 死等。
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

  // CDN 下载(无反爬),返回 base64
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

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== CMD) return;
    try {
      let data;
      if (d.cmd === 'generate') data = await uiGenerate(d.args || {});
      else if (d.cmd === 'poll') data = await poll((d.args || {}).clipIds || []);
      else if (d.cmd === 'download') data = await download((d.args || {}).url);
      else if (d.cmd === 'status') data = status();
      else throw new Error('unknown cmd ' + d.cmd);
      window.postMessage({ source: RES, id: d.id, ok: true, data }, '*');
    } catch (e) {
      window.postMessage({ source: RES, id: d.id, ok: false, error: String((e && e.message) || e) }, '*');
    }
  });

  window.__sunoDrive = { generate: uiGenerate, poll, status };
  console.log('%c[suno-bridge] UI driver active', 'color:#0a0;font-weight:bold');
})();
