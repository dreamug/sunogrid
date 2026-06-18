const $ = (id) => document.getElementById(id);
let LOG = [];

function hasAuth(e) {
  const h = e.reqHeaders || {};
  return Object.keys(h).some((k) => k.toLowerCase() === "authorization");
}

function filtered() {
  const q = $("filter").value.trim().toLowerCase();
  const onlyAuth = $("onlyauth").checked;
  return LOG.filter((e) => {
    if (q && !(e.url || "").toLowerCase().includes(q)) return false;
    if (onlyAuth && !hasAuth(e)) return false;
    return true;
  });
}

function render() {
  const items = filtered();
  $("count").textContent = `${items.length} / ${LOG.length}`;
  const list = $("list");
  list.innerHTML = "";
  // 最新的在上面
  items.slice().reverse().forEach((e) => {
    const div = document.createElement("div");
    div.className = "item";
    const sClass = "s" + String(e.status || "")[0];
    const path = (() => { try { return new URL(e.url).pathname; } catch { return e.url; } })();
    div.innerHTML =
      `<span class="m">${e.method}</span> ` +
      `<span class="${sClass}">${e.status ?? "ERR"}</span> ` +
      (hasAuth(e) ? `<span class="auth">🔑</span> ` : "") +
      `<span class="u">${path}</span>`;
    div.title = "点击复制这一条的完整 JSON";
    div.onclick = () => navigator.clipboard.writeText(JSON.stringify(e, null, 2));
    list.appendChild(div);
  });
}

function load() {
  chrome.runtime.sendMessage({ kind: "get" }, (resp) => {
    LOG = (resp && resp.log) || [];
    render();
  });
}

$("filter").oninput = render;
$("onlyauth").onchange = render;

$("dl").onclick = () => {
  const data = JSON.stringify(filtered(), null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "suno-capture.json";
  a.click();
};

$("clear").onclick = () => {
  chrome.runtime.sendMessage({ kind: "clear" }, () => { LOG = []; render(); });
};

load();
