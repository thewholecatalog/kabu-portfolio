/* 株ポートフォリオ管理アプリ — フロント本体
 * - 銘柄リストと手動上書きは localStorage に保存（DB不要）
 * - 起動時に全銘柄を並列リフレッシュ
 * - プロキシ(Cloudflare Worker)経由で Yahoo Finance を取得
 */

const APP_VERSION = "v1.0.0";
const LS_KEY = "kabu.portfolio.v1"; // [{symbol, override:{...}}]
const LS_PROXY = "kabu.proxyUrl";
const LS_CACHE = "kabu.cache.v1"; // symbol -> normalized quote（最後の取得結果）

const $ = (id) => document.getElementById(id);

let portfolio = load(LS_KEY, []);
let cache = load(LS_CACHE, {});
let proxyUrl = localStorage.getItem(LS_PROXY) || "";
let editingSymbol = null;

function load(key, def) {
  try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
function savePortfolio() { save(LS_KEY, portfolio); }

// ---- プロキシ呼び出し ----
function api(path) {
  if (!proxyUrl) throw new Error("NO_PROXY");
  const base = proxyUrl.replace(/\/+$/, "");
  return base + path;
}
async function apiGet(path) {
  const res = await fetch(api(path));
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// ---- 検索 → 追加 ----
async function doSearch() {
  const q = $("searchInput").value.trim();
  if (!q) return;
  setStatus("検索中…");
  try {
    const { quotes } = await apiGet("/api/search?q=" + encodeURIComponent(q));
    renderSearchResults(quotes);
    setStatus(quotes.length ? "" : "該当なし");
  } catch (e) {
    handleErr(e);
  }
}

function renderSearchResults(quotes) {
  const ul = $("searchResults");
  ul.innerHTML = "";
  if (!quotes.length) { ul.classList.add("hidden"); return; }
  for (const q of quotes) {
    const already = portfolio.some((p) => p.symbol === q.symbol);
    const li = document.createElement("li");
    li.innerHTML = `<span><b>${esc(q.symbol)}</b> ${esc(q.name)}
      <small>${esc(q.exchange)}</small></span>`;
    const btn = document.createElement("button");
    btn.textContent = already ? "追加済" : "＋追加";
    btn.disabled = already;
    btn.onclick = () => addSymbol(q.symbol);
    li.appendChild(btn);
    ul.appendChild(li);
  }
  ul.classList.remove("hidden");
}

async function addSymbol(symbol) {
  if (portfolio.some((p) => p.symbol === symbol)) return;
  portfolio.push({ symbol, override: {} });
  savePortfolio();
  $("searchResults").classList.add("hidden");
  $("searchInput").value = "";
  render();
  await refreshOne(symbol);
}

function removeSymbol(symbol) {
  if (!confirm(symbol + " を削除しますか？")) return;
  portfolio = portfolio.filter((p) => p.symbol !== symbol);
  delete cache[symbol];
  savePortfolio();
  save(LS_CACHE, cache);
  render();
}

// ---- リフレッシュ ----
async function refreshOne(symbol) {
  const card = document.querySelector(`[data-sym="${cssEsc(symbol)}"]`);
  card?.classList.add("loading");
  try {
    const data = await apiGet("/api/quote?symbol=" + encodeURIComponent(symbol));
    cache[symbol] = data;
    save(LS_CACHE, cache);
  } catch (e) {
    if (e.message === "NO_PROXY") { handleErr(e); return; }
    cache[symbol] = { ...(cache[symbol] || { symbol }), _error: e.message };
  } finally {
    render();
  }
}

async function refreshAll() {
  if (!portfolio.length) return;
  if (!proxyUrl) { openSettings(); return; }
  setStatus("最新化中…");
  await Promise.all(portfolio.map((p) => refreshOne(p.symbol)));
  setStatus("更新: " + new Date().toLocaleString("ja-JP"));
}

// ---- 表示 ----
const COLS = [
  ["銘柄", (d, o) => `<b>${esc(d.name || d.symbol)}</b><small>${esc(d.symbol)}</small>`],
  ["市場", (d) => esc(d.exchange)],
  ["株価", (d) => money(d.price, d.currency)],
  ["最新売上", (d) => big(d.latest?.revenue, d.currency)],
  ["最新税後利益", (d) => big(d.latest?.netIncome, d.currency)],
  ["予想売上", (d, o) => big(pick(o.revenue, d.forecast?.revenue), d.currency) + fcTag(d, o, "revenue")],
  ["予想税後利益", (d, o) => big(pick(o.netIncome, d.forecast?.netIncome), d.currency) + fcTag(d, o, "netIncome")],
  ["実績PER", (d) => ratio(d.trailingPE)],
  ["実績ROE", (d) => pct(d.roe)],
  ["実績EPS", (d) => money(d.trailingEPS, d.currency)],
  ["実績PBR", (d) => ratio(d.pbr)],
  ["予想PER", (d) => ratio(d.forwardPE)],
  ["予想ROE", (d, o) => pct(pick(o.forwardROE != null ? o.forwardROE / 100 : null, d.forwardROE)) + (o.forwardROE != null ? mTag() : "")],
  ["次回決算", (d, o) => esc(pick(o.nextEarnings, d.nextEarnings) || "—") + (o.nextEarnings ? mTag() : "")],
];

function render() {
  const root = $("portfolio");
  root.innerHTML = "";
  $("empty").classList.toggle("hidden", portfolio.length > 0);

  // PC: テーブル / スマホ: カード（同じデータ、CSSで出し分け）
  const table = document.createElement("table");
  table.className = "pf-table";
  table.innerHTML =
    "<thead><tr>" +
    COLS.map((c) => `<th>${c[0]}</th>`).join("") +
    "<th></th></tr></thead>";
  const tbody = document.createElement("tbody");

  for (const p of portfolio) {
    const d = cache[p.symbol] || { symbol: p.symbol };
    const o = p.override || {};

    // テーブル行
    const tr = document.createElement("tr");
    tr.dataset.sym = p.symbol;
    if (d._error) tr.classList.add("row-error");
    tr.innerHTML =
      COLS.map((c) => `<td>${c[1](d, o)}</td>`).join("") +
      `<td class="rowact">
         <button data-act="edit">✎</button>
         <button data-act="del">🗑</button>
       </td>`;
    tr.querySelector('[data-act="edit"]').onclick = () => openEdit(p.symbol);
    tr.querySelector('[data-act="del"]').onclick = () => removeSymbol(p.symbol);
    tbody.appendChild(tr);

    // カード（スマホ）
    const card = document.createElement("div");
    card.className = "pf-card";
    card.dataset.sym = p.symbol;
    if (d._error) card.classList.add("row-error");
    card.innerHTML =
      `<div class="card-head">
         <div><b>${esc(d.name || p.symbol)}</b><small>${esc(p.symbol)} · ${esc(d.exchange || "")}</small></div>
         <div class="card-price">${money(d.price, d.currency)}</div>
       </div>` +
      (d._error ? `<div class="err">取得失敗: ${esc(d._error)}</div>` : "") +
      `<div class="card-grid">` +
      COLS.slice(3).map((c) => `<div><span>${c[0]}</span><b>${c[1](d, o)}</b></div>`).join("") +
      `</div>
       <div class="card-actions">
         <button data-act="edit">✎ 手動入力</button>
         <button data-act="del">🗑 削除</button>
       </div>`;
    card.querySelector('[data-act="edit"]').onclick = () => openEdit(p.symbol);
    card.querySelector('[data-act="del"]').onclick = () => removeSymbol(p.symbol);
    root.appendChild(card);
  }
  table.appendChild(tbody);
  root.appendChild(table);
}

// ---- 手動上書きモーダル ----
function openEdit(symbol) {
  editingSymbol = symbol;
  const p = portfolio.find((x) => x.symbol === symbol);
  const o = p.override || {};
  const d = cache[symbol] || {};
  $("editTitle").textContent = (d.name || symbol) + " — 手動入力";
  $("ovRevenue").value = o.revenue ?? "";
  $("ovNetIncome").value = o.netIncome ?? "";
  $("ovForwardROE").value = o.forwardROE ?? "";
  $("ovNextEarnings").value = o.nextEarnings ?? "";
  $("ovMemo").value = o.memo ?? "";
  $("editModal").classList.remove("hidden");
}
function saveEdit() {
  const p = portfolio.find((x) => x.symbol === editingSymbol);
  if (!p) return;
  const v = (id) => { const s = $(id).value.trim(); return s === "" ? undefined : s; };
  const n = (id) => { const s = v(id); return s === undefined ? undefined : Number(s); };
  p.override = {
    revenue: n("ovRevenue"),
    netIncome: n("ovNetIncome"),
    forwardROE: n("ovForwardROE"),
    nextEarnings: v("ovNextEarnings"),
    memo: v("ovMemo"),
  };
  savePortfolio();
  $("editModal").classList.add("hidden");
  render();
}

// ---- 設定 ----
function openSettings() {
  $("proxyInput").value = proxyUrl;
  $("versionLabel").textContent = APP_VERSION;
  $("settingsModal").classList.remove("hidden");
}
function saveSettings() {
  proxyUrl = $("proxyInput").value.trim();
  localStorage.setItem(LS_PROXY, proxyUrl);
  $("settingsModal").classList.add("hidden");
  refreshAll();
}

// ---- フォーマッタ ----
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }
function pick(a, b) { return a != null && a !== "" ? a : b; }
function mTag() { return ' <span class="tag manual">手動</span>'; }
function fcTag(d, o, key) {
  if (o[key] != null) return mTag();
  if (d.forecast?.source === "analyst" && d.forecast[key] != null)
    return ' <span class="tag est">予想</span>';
  return "";
}
function money(v, cur) {
  if (v == null) return "—";
  const sym = { JPY: "¥", USD: "$", HKD: "HK$" }[cur] || "";
  return sym + Number(v).toLocaleString("ja-JP", { maximumFractionDigits: 2 });
}
function big(v, cur) {
  if (v == null) return "—";
  const sym = { JPY: "¥", USD: "$", HKD: "HK$" }[cur] || "";
  const a = Math.abs(v);
  if (a >= 1e12) return sym + (v / 1e12).toFixed(2) + "兆";
  if (a >= 1e8) return sym + (v / 1e8).toFixed(2) + "億";
  if (a >= 1e6) return sym + (v / 1e6).toFixed(1) + "M";
  return sym + Number(v).toLocaleString("ja-JP");
}
function ratio(v) { return v == null ? "—" : Number(v).toFixed(2) + "倍"; }
function pct(v) { return v == null ? "—" : (Number(v) * 100).toFixed(1) + "%"; }

function setStatus(s) { $("status").textContent = s; }
function handleErr(e) {
  if (e.message === "NO_PROXY") { setStatus("プロキシ未設定。⚙️から Worker のURLを入れてください。"); openSettings(); }
  else setStatus("エラー: " + e.message);
}

// ---- イベント ----
$("searchBtn").onclick = doSearch;
$("searchInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
$("refreshBtn").onclick = refreshAll;
$("settingsBtn").onclick = openSettings;
$("saveSettings").onclick = saveSettings;
$("closeSettings").onclick = () => $("settingsModal").classList.add("hidden");
$("saveEdit").onclick = saveEdit;
$("closeEdit").onclick = () => $("editModal").classList.add("hidden");

// ---- 起動 ----
render();
if (!proxyUrl) openSettings();
else refreshAll();

// Service Worker 登録
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
