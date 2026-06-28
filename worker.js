/**
 * 株式ポートフォリオ管理アプリ — Yahoo Finance 中継プロキシ (Cloudflare Worker)
 *
 * 役割:
 *   - ブラウザから直接叩くと CORS / crumb 認証で弾かれる Yahoo Finance を中継する
 *   - cookie -> crumb を取得してキャッシュし、quoteSummary / search / chart を代理取得
 *   - CORS ヘッダを付けて JSON を返す
 *
 * エンドポイント:
 *   GET /api/search?q=トヨタ          社名/ティッカー検索
 *   GET /api/quote?symbol=7203.T      財務一式を正規化して返す
 *
 * デプロイ: Cloudflare ダッシュボード > Workers & Pages > Create Worker に
 *           このファイルの中身を丸ごと貼り付けて Deploy するだけ。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// crumb と cookie はワーカーのメモリにキャッシュ（毎回取りに行かない）
let CACHE = { cookie: null, crumb: null, ts: 0 };
const CRUMB_TTL = 1000 * 60 * 30; // 30分

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/search") {
        return json(await search(url.searchParams.get("q") || ""));
      }
      if (url.pathname === "/api/quote") {
        return json(await quote(url.searchParams.get("symbol") || ""));
      }
      if (url.pathname === "/" || url.pathname === "/api") {
        return json({ ok: true, endpoints: ["/api/search?q=", "/api/quote?symbol="] });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

// ---- Yahoo 認証 (cookie + crumb) ----
async function ensureCrumb(force = false) {
  const fresh = CACHE.crumb && Date.now() - CACHE.ts < CRUMB_TTL;
  if (fresh && !force) return CACHE;

  // 1) cookie を取得
  const c = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": UA },
    redirect: "manual",
  });
  let cookie = c.headers.get("set-cookie") || "";
  cookie = cookie.split(",").map((s) => s.split(";")[0]).join("; ");

  // 2) crumb を取得
  const r = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: cookie },
  });
  const crumb = (await r.text()).trim();
  if (!crumb || crumb.includes("<")) throw new Error("crumb 取得失敗");

  CACHE = { cookie, crumb, ts: Date.now() };
  return CACHE;
}

async function yfetch(buildUrl) {
  let { cookie, crumb } = await ensureCrumb();
  let res = await fetch(buildUrl(crumb), {
    headers: { "User-Agent": UA, Cookie: cookie },
  });
  // crumb 失効時は1回だけ取り直して再試行
  if (res.status === 401) {
    ({ cookie, crumb } = await ensureCrumb(true));
    res = await fetch(buildUrl(crumb), {
      headers: { "User-Agent": UA, Cookie: cookie },
    });
  }
  if (!res.ok) throw new Error("Yahoo " + res.status);
  return res.json();
}

// ---- /api/search ----
// Yahoo検索はASCIIのみ対応（日本語クエリは 400 Invalid Search Query）。
// そのため数字コードは .T(日本)/.HK(香港) 候補を chart で実在確認して補完する。
async function search(q) {
  q = (q || "").trim();
  if (!q) return { quotes: [] };

  const out = [];
  const seen = new Set();
  const add = (sym, name, exch) => {
    if (!sym || seen.has(sym)) return;
    seen.add(sym);
    out.push({ symbol: sym, name: name || sym, exchange: exch || "" });
  };

  const isAscii = /^[\x20-\x7E]+$/.test(q);
  const isCode = /^\d{1,5}$/.test(q);

  // 1) Yahoo検索（ASCII: 英語名 / ローマ字 / ティッカー）
  if (isAscii) {
    try {
      const u =
        "https://query2.finance.yahoo.com/v1/finance/search?q=" +
        encodeURIComponent(q) +
        "&quotesCount=10&newsCount=0&enableFuzzyQuery=false";
      const d = await (await fetch(u, { headers: { "User-Agent": UA } })).json();
      for (const x of d.quotes || []) {
        if (x.quoteType === "EQUITY" && x.symbol)
          add(x.symbol, x.longname || x.shortname, x.exchDisp || x.exchange);
      }
    } catch (_) {}
  }

  // 2) 数字コード → 日本(.T)/香港(.HK) 候補を chart で実在確認
  if (isCode) {
    const cands = [q + ".T", q.padStart(4, "0") + ".HK"];
    if (q.length !== 4) cands.push(q + ".HK");
    const metas = await Promise.all(cands.map(probeChart));
    for (const m of metas) {
      if (m) add(m.symbol, m.longName || m.shortName, m.fullExchangeName || m.exchangeName);
    }
  }

  // 日本語社名など、検索手段が無いケースをフロントに伝える
  return { quotes: out, hint: out.length === 0 && !isAscii ? "code-or-romaji" : null };
}

// chart で銘柄の実在確認（認証不要・社名も meta から取れる）
async function probeChart(symbol) {
  try {
    const u =
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?interval=1d&range=1d";
    const r = await fetch(u, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.chart?.result?.[0]?.meta || null;
  } catch (_) {
    return null;
  }
}

// ---- /api/quote ----
const MODULES = [
  "price",
  "summaryDetail",
  "defaultKeyStatistics",
  "financialData",
  "earningsTrend",
  "calendarEvents",
  "incomeStatementHistory",
].join(",");

async function quote(symbol) {
  if (!symbol.trim()) throw new Error("symbol が空です");
  const d = await yfetch(
    (crumb) =>
      "https://query2.finance.yahoo.com/v10/finance/quoteSummary/" +
      encodeURIComponent(symbol) +
      "?modules=" +
      MODULES +
      "&crumb=" +
      encodeURIComponent(crumb)
  );
  const res = d?.quoteSummary?.result?.[0];
  if (!res) throw new Error("データなし: " + symbol);
  return normalize(symbol, res);
}

const num = (x) => (x && typeof x.raw === "number" ? x.raw : null);
const dateOf = (x) =>
  x && typeof x.raw === "number"
    ? new Date(x.raw * 1000).toISOString().slice(0, 10)
    : null;

function normalize(symbol, r) {
  const price = r.price || {};
  const sd = r.summaryDetail || {};
  const ks = r.defaultKeyStatistics || {};
  const fd = r.financialData || {};
  const cal = r.calendarEvents || {};

  // 最新決算（年次）
  const incs = r.incomeStatementHistory?.incomeStatementHistory || [];
  const latest = incs[0]
    ? {
        period: dateOf(incs[0].endDate),
        revenue: num(incs[0].totalRevenue),
        netIncome: num(incs[0].netIncome),
      }
    : { period: null, revenue: null, netIncome: null };

  // 次期予想（アナリスト予想／会社ガイダンスではない点に注意）
  // "0y" = 次に発表される会計年度（=「次の期末」）。無ければ "+1y" にフォールバック。
  const trends = r.earningsTrend?.trend || [];
  const t = trends.find((x) => x.period === "0y") || trends.find((x) => x.period === "+1y");
  const shares = num(ks.sharesOutstanding);
  const fcRevenue = t ? num(t.revenueEstimate?.avg) : null;
  const fcEps = t ? num(t.earningsEstimate?.avg) : null;
  const forecast = {
    period: t?.endDate || null,
    revenue: fcRevenue,
    netIncome: fcEps != null && shares != null ? Math.round(fcEps * shares) : null,
    source: "analyst",
  };

  // 予想ROE ≒ 予想EPS / BPS（直接値が無いため近似）
  const forwardEps = num(ks.forwardEps);
  const bps = num(ks.bookValue);
  const forwardROE =
    forwardEps != null && bps && bps !== 0 ? forwardEps / bps : null;

  // 次回決算発表日（レンジで返る場合は先頭）
  let nextEarnings = null;
  const ed = cal.earnings?.earningsDate;
  if (Array.isArray(ed) && ed.length) nextEarnings = dateOf(ed[0]);

  return {
    symbol,
    name: price.longName || price.shortName || symbol,
    exchange: price.fullExchangeName || price.exchangeName || "",
    currency: price.currency || "",
    price: num(price.regularMarketPrice),
    latest,
    forecast,
    trailingPE: num(sd.trailingPE),
    forwardPE: num(sd.forwardPE),
    trailingEPS: num(ks.trailingEps),
    forwardEPS: forwardEps,
    pbr: num(ks.priceToBook),
    roe: num(fd.returnOnEquity),
    forwardROE,
    nextEarnings,
    updatedAt: Date.now(),
  };
}
