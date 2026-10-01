// Trade: Hyperliquid spot markets, book and trades (live from the public
// API), and the private order form.
//
// An order is a Veil DvP order. The keeper crosses it against other Veil
// orders first; whatever is left goes to Hyperliquid through the omnibus,
// and fills come back into the order's private receive note.

import {
  $,
  connect,
  ensureRegistered,
  privateBalance,
  refresh,
  refreshAccount,
  requireDeployed,
  requireKyc,
  requireSession,
  run,
  S,
  sendOpening,
  toast,
} from "../app";
import { PriceChart } from "../chart";
import { INTERVALS, isInterval, type Interval } from "../chartData";
import { deployment, twinOf, type TwinConfig } from "../config";
import { ago, compactUsd, escapeHtml, hex, pct, price, units } from "../format";
import { priceProblem, sizeProblem, type Market } from "../market";
import { MIN_NOTIONAL_USDC, draftOrder, type Draft, type FormInput, type OrderKind } from "../orders";
import { postOrder } from "../veil";
import { renderAccountPanel, updateAccountPanel } from "./portfolio";

const form: FormInput = { side: "buy", kind: "limit", size: "", price: "", slippage: 0.01 };
let search = "";
let formCoin: string | null = null;

const COIN_KEY = "hyperveil:coin";
const INTERVAL_KEY = "hyperveil:interval";

let chart: PriceChart | null = null;
let interval: Interval = savedInterval();

function savedInterval(): Interval {
  try {
    const v = localStorage.getItem(INTERVAL_KEY);
    if (isInterval(v)) return v;
  } catch {
    /* ignore */
  }
  return "15m";
}

export function selectedMarket(): Market | undefined {
  return S.markets.find((m) => m.coin === S.coin);
}

/** Both sides have a twin: the pair can be traded privately. */
export function tradable(m: Market): { base: TwinConfig; quote: TwinConfig } | null {
  if (!S.deployed) return null;
  const base = twinOf(m.base.index);
  const quote = twinOf(m.quote.index);
  return base && quote ? { base, quote } : null;
}

/** Tradable pairs first, then the busiest view-only ones. */
function listed(): Market[] {
  const byVolume = (a: Market, b: Market) => (b.dayNtlVlm ?? 0) - (a.dayNtlVlm ?? 0);
  const t = S.markets.filter((m) => tradable(m)).sort(byVolume);
  const rest = S.markets.filter((m) => !tradable(m) && m.mid).sort(byVolume).slice(0, 60);
  const all = [...t, ...rest];
  const q = search.trim().toUpperCase();
  return q ? all.filter((m) => m.label.toUpperCase().includes(q)) : all;
}

export function pickDefaultMarket(): void {
  if (S.coin && S.markets.some((m) => m.coin === S.coin)) return;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(COIN_KEY);
  } catch {
    /* ignore */
  }
  const list = listed();
  S.coin =
    (saved && S.markets.some((m) => m.coin === saved) ? saved : null) ??
    list.find((m) => tradable(m))?.coin ??
    S.markets.find((m) => m.label === "HYPE/USDC")?.coin ??
    list[0]?.coin ??
    null;
}

const change = (m: Market): number => (m.mid && m.prevDayPx ? Number(m.mid) / Number(m.prevDayPx) - 1 : NaN);

// ── Skeleton ────────────────────────────────────────────────────────────────
//
// Hyperliquid's layout: the market bar across the top, the chart with the
// order book beside it, the account panel underneath, and the order form down
// the right-hand side.

type BookTab = "book" | "trades";
let bookTab: BookTab = "book";
let pickerOpen = false;

export function renderTrade(root: HTMLElement): void {
  root.innerHTML = `
    <div class="trade fade-up">
      <div class="mkt-bar panel" id="mk-head"></div>
      <div class="mk-pop panel" id="mk-pop" hidden>
        <input class="field" id="mk-search" placeholder="Search markets" autocomplete="off" value="${escapeHtml(search)}" />
        <div class="mk-table" id="mk-list"></div>
      </div>
      <div class="chart panel">
        <div class="chart-bar">
          <div class="intervals" id="chart-intervals">${INTERVALS.map(
            (i) => `<button data-interval="${i}" class="${i === interval ? "is-active" : ""}">${i}</button>`,
          ).join("")}</div>
          <span class="chip">Hyperliquid</span>
        </div>
        <div class="chart-canvas" id="chart">
          <div class="chart-legend num" id="chart-legend"></div>
          <div class="chart-empty" id="chart-empty" hidden>No trades in this range yet.</div>
        </div>
      </div>
      <div class="book-panel panel">
        <div class="ptabs" id="book-tabs">
          <button data-bt="book">Order Book</button>
          <button data-bt="trades">Trades</button>
          <span class="chip" id="book-age">Hyperliquid</span>
        </div>
        <div class="rows num" id="book"></div>
        <div class="rows num" id="trades"></div>
      </div>
      <aside class="form panel" id="order-form"></aside>
      <section class="acct panel" id="acct"></section>
    </div>`;
  $<HTMLInputElement>("mk-search").addEventListener("input", (e) => {
    search = (e.target as HTMLInputElement).value;
    updateMarketList();
  });
  document.querySelectorAll<HTMLButtonElement>("#book-tabs [data-bt]").forEach((b) =>
    b.addEventListener("click", () => {
      bookTab = b.dataset.bt as BookTab;
      paintBookTabs();
    }),
  );
  paintBookTabs();
  pickerOpen = false;
  mountChart();
  renderAccountPanel($("acct"));
  formCoin = null;
  updateTrade();
}

/** Leaving the trade page: close the chart and its websocket. */
export function closeTrade(): void {
  chart?.destroy();
  chart = null;
}

/** Redraws the live parts; leaves the form's inputs alone. */
export function updateTrade(): void {
  if (!document.getElementById("mk-head")) return;
  updateHead();
  if (pickerOpen) updateMarketList();
  updateChart();
  updateBook();
  updateTrades();
  updateAges();
  updateAccountPanel();
  if (formCoin !== S.coin) renderForm();
  else updateSummary();
}

// ── Market picker (Hyperliquid's coin dropdown) ─────────────────────────────

function setPicker(open: boolean): void {
  pickerOpen = open;
  const pop = document.getElementById("mk-pop");
  if (!pop) return;
  pop.hidden = !open;
  document.getElementById("mk-pick")?.classList.toggle("is-open", open);
  if (open) {
    updateMarketList();
    const input = document.getElementById("mk-search") as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }
}

// One listener for the page's lifetime: a click outside the picker, or
// Escape, closes it.
document.addEventListener("click", (e) => {
  if (!pickerOpen) return;
  const t = e.target as Node;
  if (document.getElementById("mk-pop")?.contains(t) || document.getElementById("mk-pick")?.contains(t)) return;
  setPicker(false);
});
document.addEventListener("keydown", (e) => {
  if (pickerOpen && e.key === "Escape") setPicker(false);
});

function updateMarketList(): void {
  const el = document.getElementById("mk-list");
  if (!el) return;
  const rows = listed();
  if (!rows.length) {
    el.innerHTML = `<div class="empty">${S.markets.length ? "No match." : "Loading markets…"}</div>`;
    return;
  }
  el.innerHTML = `
    <div class="mk-row mk-head"><span>Market</span><span class="r">Last price</span><span class="r">24h change</span><span class="r">Volume</span><span></span></div>
    ${rows
      .map((m) => {
        const c = change(m);
        return `<button class="mk-row ${m.coin === S.coin ? "is-active" : ""}" data-coin="${escapeHtml(m.coin)}">
          <span class="pair">${escapeHtml(m.label)}</span>
          <span class="r num">${price(m.mid)}</span>
          <span class="r num ${c >= 0 ? "buy" : "sell"}">${pct(c)}</span>
          <span class="r num">${compactUsd(m.dayNtlVlm ?? NaN)}</span>
          <span class="r">${tradable(m) ? `<span class="chip chip-gold">Private</span>` : `<span class="faint">View only</span>`}</span>
        </button>`;
      })
      .join("")}`;
  el.querySelectorAll<HTMLButtonElement>(".mk-row[data-coin]").forEach((b) =>
    b.addEventListener("click", () => {
      S.coin = b.dataset.coin!;
      S.book = null;
      S.trades = [];
      try {
        localStorage.setItem(COIN_KEY, S.coin);
      } catch {
        /* ignore */
      }
      setPicker(false);
      refresh();
    }),
  );
}

// ── Market bar ──────────────────────────────────────────────────────────────

function updateHead(): void {
  const m = selectedMarket();
  const el = $("mk-head");
  if (!m) {
    el.innerHTML = `<div class="muted">Loading Hyperliquid spot markets…</div>`;
    return;
  }
  const c = change(m);
  const diff = m.mid && m.prevDayPx ? Number(m.mid) - Number(m.prevDayPx) : NaN;
  el.innerHTML = `
    <button class="pair-btn ${pickerOpen ? "is-open" : ""}" id="mk-pick" title="Change market">
      <span class="pair-name">${escapeHtml(m.label)}</span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    ${tradable(m) ? `<span class="chip chip-gold"><span class="dot"></span>Private</span>` : `<span class="chip">View only</span>`}
    <div class="stat"><div class="k">Price</div><div class="v num">${price(m.mid)}</div></div>
    <div class="stat"><div class="k">24h Change</div><div class="v num ${c >= 0 ? "buy" : "sell"}">${
      Number.isFinite(diff) ? `${diff >= 0 ? "+" : ""}${price(diff)} / ${pct(c)}` : "—"
    }</div></div>
    <div class="stat"><div class="k">24h Volume</div><div class="v num">${compactUsd(m.dayNtlVlm ?? NaN)}</div></div>
    <div class="stat"><div class="k">Market</div><div class="v">Hyperliquid spot</div></div>`;
  $("mk-pick").addEventListener("click", () => setPicker(!pickerOpen));
}

// ── Chart ───────────────────────────────────────────────────────────────────

function mountChart(): void {
  closeTrade();
  chart = new PriceChart(
    $("chart"),
    deployment().hyperliquid.api,
    interval,
    (empty) => {
      const note = document.getElementById("chart-empty");
      if (note) note.hidden = !empty;
    },
    $("chart-legend"),
  );
  document.querySelectorAll<HTMLButtonElement>("#chart-intervals button").forEach((b) =>
    b.addEventListener("click", () => {
      const next = b.dataset.interval;
      if (!isInterval(next)) return;
      interval = next;
      try {
        localStorage.setItem(INTERVAL_KEY, next);
      } catch {
        /* ignore */
      }
      document
        .querySelectorAll<HTMLButtonElement>("#chart-intervals button")
        .forEach((x) => x.classList.toggle("is-active", x.dataset.interval === next));
      chart?.setInterval(next);
    }),
  );
}

function updateChart(): void {
  const m = selectedMarket();
  if (chart && m) chart.show(m.coin, m.label, m.base.szDecimals, Number(m.mid ?? 0));
}

// ── Order book / trades ─────────────────────────────────────────────────────

function paintBookTabs(): void {
  document.querySelectorAll<HTMLButtonElement>("#book-tabs [data-bt]").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.bt === bookTab),
  );
  const book = document.getElementById("book");
  const trades = document.getElementById("trades");
  if (book) book.hidden = bookTab !== "book";
  if (trades) trades.hidden = bookTab !== "trades";
  updateAges();
}

/** "live · 2s ago", so a market that has not traded for an hour still shows
 *  that the page is reading it now. */
function freshness(): string {
  if (S.marketAt === null) return "Hyperliquid";
  const secs = Math.max(0, Math.round((Date.now() - S.marketAt) / 1000));
  return `live · ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`} ago`;
}

function updateAges(): void {
  const chip = document.getElementById("book-age");
  if (!chip) return;
  if (bookTab === "book") {
    chip.textContent = freshness();
    return;
  }
  // The tape's own age: on a quiet testnet the last trade can be hours old,
  // which is the market, not the page.
  const last = S.trades[0];
  chip.textContent = last ? `last trade ${ago(last.time)}` : freshness();
}

function updateBook(): void {
  const el = $("book");
  const m = selectedMarket();
  const b = S.book;
  if (!m || !b) {
    el.innerHTML = `<div class="empty">Loading…</div>`;
    return;
  }
  const depth = 11;
  const cum = (levels: { sz: string }[]) => {
    let t = 0;
    return levels.map((l) => (t += Number(l.sz)));
  };
  const asks = b.asks.slice(0, depth);
  const bids = b.bids.slice(0, depth);
  const ca = cum(asks);
  const cb = cum(bids);
  const max = Math.max(ca[ca.length - 1] ?? 0, cb[cb.length - 1] ?? 0) || 1;
  const size = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: m.base.szDecimals });
  const row = (side: "ask" | "bid", l: { px: string; sz: string }, total: number) =>
    `<div class="row ${side}"><span class="${side === "ask" ? "sell" : "buy"}">${price(l.px)}</span><span>${size(Number(l.sz))}</span><span>${size(total)}</span><i class="bar" style="width:${((total / max) * 100).toFixed(1)}%"></i></div>`;
  const bestAsk = Number(asks[0]?.px);
  const bestBid = Number(bids[0]?.px);
  const spread = bestAsk && bestBid ? bestAsk - bestBid : NaN;
  el.innerHTML = `
    <div class="row head"><span>Price</span><span>Size (${escapeHtml(m.base.name)})</span><span>Total (${escapeHtml(m.base.name)})</span></div>
    ${asks.map((l, i) => row("ask", l, ca[i])).reverse().join("")}
    <div class="spread"><span>Spread</span><span>${Number.isFinite(spread) ? price(spread) : "—"}</span><span>${
      Number.isFinite(spread) ? `${((spread / bestAsk) * 100).toFixed(3)}%` : ""
    }</span></div>
    ${bids.map((l, i) => row("bid", l, cb[i])).join("")}`;
  el.querySelectorAll<HTMLElement>(".row:not(.head)").forEach((r) =>
    r.addEventListener("click", () => {
      if (form.kind === "market") return;
      form.price = r.querySelector("span")!.textContent!.replace(/,/g, "");
      const input = document.getElementById("f-price") as HTMLInputElement | null;
      if (input) input.value = form.price;
      updateSummary();
    }),
  );
}

function updateTrades(): void {
  const el = $("trades");
  const m = selectedMarket();
  if (!m || !S.trades.length) {
    el.innerHTML = `<div class="empty">${m ? "Loading…" : ""}</div>`;
    return;
  }
  el.innerHTML =
    `<div class="row head"><span>Price</span><span>Size (${escapeHtml(m.base.name)})</span><span>Time</span></div>` +
    S.trades
      .slice(0, 24)
      .map(
        (t) =>
          `<div class="row"><span class="${t.side === "B" ? "buy" : "sell"}">${price(t.px)}</span><span>${Number(t.sz).toLocaleString("en-US", { maximumFractionDigits: m.base.szDecimals })}</span><span class="faint">${new Date(t.time).toLocaleTimeString()}</span></div>`,
      )
      .join("");
}

// ── Order form ──────────────────────────────────────────────────────────────
//
// Hyperliquid's order: order type, side, what you can trade, price, size (or
// a share of your balance), the button, then the order's numbers.

function renderForm(): void {
  const el = $("order-form");
  const m = selectedMarket();
  formCoin = S.coin;
  if (!m) {
    el.innerHTML = `<div class="muted">Pick a market.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="kinds" id="f-kind">
      <button data-kind="market">Market</button>
      <button data-kind="limit">Limit</button>
      <button data-kind="post">Post only</button>
    </div>
    <div class="seg" id="f-side">
      <button data-side="buy">Buy</button>
      <button data-side="sell">Sell</button>
    </div>
    <div class="avail num" id="f-avail"></div>
    <div id="f-price-box"></div>
    <div class="field-wrap labelled">
      <span class="field-label">Size</span>
      <input class="field num" id="f-size" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${escapeHtml(form.size)}" />
      <span class="field-unit">${escapeHtml(m.base.name)}</span>
    </div>
    <div class="pct-row">
      <input type="range" id="f-pct" min="0" max="100" step="1" value="0" />
      <span class="pct-box num"><span id="f-pct-val">0</span>%</span>
    </div>
    <button class="btn btn-gold btn-block" id="f-submit"></button>
    <div class="hint" id="f-hint"></div>
    <div class="summary num" id="f-summary"></div>
    <div class="privacy"><span>◆</span><span>Your wallet never appears on Hyperliquid. Orders settle in Veil's private pool; Hyperliquid sees only the HyperVeil omnibus.</span></div>`;

  el.querySelectorAll<HTMLButtonElement>("#f-side button").forEach((b) =>
    b.addEventListener("click", () => {
      form.side = b.dataset.side as "buy" | "sell";
      paintToggles();
      setPct(0);
      updateSummary();
    }),
  );
  el.querySelectorAll<HTMLButtonElement>("#f-kind button").forEach((b) =>
    b.addEventListener("click", () => {
      form.kind = b.dataset.kind as OrderKind;
      paintToggles();
      renderPriceBox();
      updateSummary();
    }),
  );
  $<HTMLInputElement>("f-size").addEventListener("input", (e) => {
    form.size = (e.target as HTMLInputElement).value;
    setPct(0);
    updateSummary();
  });
  $<HTMLInputElement>("f-pct").addEventListener("input", (e) => {
    const p = Number((e.target as HTMLInputElement).value);
    setPct(p);
    const size = sizeForShare(p / 100);
    if (size === null) return;
    form.size = size;
    $<HTMLInputElement>("f-size").value = size;
    updateSummary();
  });
  $("f-submit").addEventListener("click", () => void onSubmit());
  paintToggles();
  renderPriceBox();
  updateSummary();
}

function setPct(p: number): void {
  const range = document.getElementById("f-pct") as HTMLInputElement | null;
  const val = document.getElementById("f-pct-val");
  if (range && Number(range.value) !== p) range.value = String(p);
  if (range) range.style.setProperty("--p", `${p}%`);
  if (val) val.textContent = String(p);
}

/** The size that spends `share` of the private balance on the paying side:
 *  USDC for a buy (at the limit price, or the mid for a market order), the
 *  base token for a sell. Rounded down to the market's lot size. */
function sizeForShare(share: number): string | null {
  const m = selectedMarket();
  const twins = m ? tradable(m) : null;
  if (!m || !twins) return null;
  const offer = form.side === "buy" ? twins.quote : twins.base;
  const bal = privateBalance(BigInt(offer.address));
  if (bal === undefined) return null;
  const held = Number(bal) / 10 ** offer.decimals;
  const px = Number(form.kind === "market" ? m.mid : form.price || m.mid);
  const base = form.side === "buy" ? (px > 0 ? (held * share) / px : 0) : held * share;
  const lot = 10 ** m.base.szDecimals;
  return (Math.floor(base * lot) / lot).toFixed(m.base.szDecimals);
}

function paintToggles(): void {
  document.querySelectorAll<HTMLButtonElement>("#f-side button").forEach((b) => {
    b.className = b.dataset.side === form.side ? (form.side === "buy" ? "on-buy" : "on-sell") : "";
  });
  document.querySelectorAll<HTMLButtonElement>("#f-kind button").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.kind === form.kind);
  });
}

function renderPriceBox(): void {
  const m = selectedMarket();
  const box = $("f-price-box");
  if (!m) return;
  if (form.kind === "market") {
    box.innerHTML = `
      <div class="slip-row"><span class="muted">Max slippage</span><div class="slip">${[0.005, 0.01, 0.02]
        .map((s) => `<button class="btn btn-ghost btn-sm ${form.slippage === s ? "is-active" : ""}" data-slip="${s}">${(s * 100).toFixed(1)}%</button>`)
        .join("")}</div></div>`;
    box.querySelectorAll<HTMLButtonElement>("[data-slip]").forEach((b) =>
      b.addEventListener("click", () => {
        form.slippage = Number(b.dataset.slip);
        renderPriceBox();
        updateSummary();
      }),
    );
    return;
  }
  box.innerHTML = `
    <div class="field-wrap labelled">
      <span class="field-label">Price (${escapeHtml(m.quote.name)})</span>
      <input class="field num" id="f-price" inputmode="decimal" placeholder="${escapeHtml(price(m.mid))}" autocomplete="off" value="${escapeHtml(form.price)}" />
      <button class="field-action" id="f-mid" type="button">Mid</button>
    </div>`;
  $<HTMLInputElement>("f-price").addEventListener("input", (e) => {
    form.price = (e.target as HTMLInputElement).value;
    updateSummary();
  });
  $("f-mid").addEventListener("click", () => {
    const mid = selectedMarket()?.mid;
    if (!mid) return;
    form.price = String(Number(mid));
    $<HTMLInputElement>("f-price").value = form.price;
    updateSummary();
  });
}

interface Check {
  draft?: Draft;
  twins?: { base: TwinConfig; quote: TwinConfig };
  problem?: string;
  warning?: string;
}

function check(): Check {
  const m = selectedMarket();
  if (!m) return { problem: "Pick a market." };
  const twins = tradable(m) ?? undefined;
  if (!form.size.trim()) return { twins };
  const sp = sizeProblem(form.size, m.base.szDecimals);
  if (sp) return { twins, problem: `Size: ${sp}.` };
  if (form.kind !== "market") {
    if (!form.price.trim()) return { twins };
    const pp = priceProblem(form.price, m.base.szDecimals);
    if (pp) return { twins, problem: `Price: ${pp}.` };
  }
  if (!twins) return { problem: undefined };
  let draft: Draft;
  try {
    draft = draftOrder(form, m, twins.base, twins.quote, deployment().fees.maxFeeBps);
  } catch (e) {
    return { twins, problem: (e as Error).message };
  }
  const bal = privateBalance(draft.terms.offerToken);
  if (bal !== undefined && bal < draft.terms.offerAmount) return { twins, draft, problem: "Not enough private balance." };
  const warning =
    draft.notional < MIN_NOTIONAL_USDC
      ? `Under ${MIN_NOTIONAL_USDC} USDC: can only be matched inside Veil, never on Hyperliquid.`
      : undefined;
  return { twins, draft, warning };
}

function updateSummary(): void {
  const m = selectedMarket();
  const sum = document.getElementById("f-summary");
  const btn = document.getElementById("f-submit") as HTMLButtonElement | null;
  const hint = document.getElementById("f-hint");
  const avail = document.getElementById("f-avail");
  if (!m || !sum || !btn || !hint) return;
  const c = check();
  const offerTwin = c.twins ? (form.side === "buy" ? c.twins.quote : c.twins.base) : undefined;
  const wantTwin = c.twins ? (form.side === "buy" ? c.twins.base : c.twins.quote) : undefined;
  const bal = offerTwin ? privateBalance(BigInt(offerTwin.address)) : undefined;
  const holding = c.twins ? privateBalance(BigInt(c.twins.base.address)) : undefined;

  if (avail) {
    const shown = (v: bigint | undefined, t: TwinConfig | undefined) =>
      !t || !S.session ? "—" : v === undefined ? "Unlock below" : `${units(v, t.decimals)} ${escapeHtml(t.symbol)}`;
    avail.innerHTML = `
      <div class="line"><span>Available to trade</span><span>${shown(bal, offerTwin)}</span></div>
      <div class="line"><span>Holding</span><span>${shown(holding, c.twins?.base)}</span></div>`;
  }

  const lines: string[] = [];
  if (c.draft && offerTwin && wantTwin) {
    lines.push(`<div class="line"><span>Order value</span><span>≈ ${c.draft.notional.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC</span></div>`);
    lines.push(`<div class="line"><span>Limit price</span><span>${price(c.draft.price)} ${escapeHtml(m.quote.name)}</span></div>`);
    lines.push(`<div class="line"><span>You pay at most</span><span>${units(c.draft.terms.offerAmount, offerTwin.decimals)} ${escapeHtml(offerTwin.symbol)}</span></div>`);
    lines.push(`<div class="line"><span>You receive at least</span><span>${units(c.draft.terms.wantAmount, wantTwin.decimals)} ${escapeHtml(wantTwin.symbol)}</span></div>`);
  } else {
    lines.push(`<div class="line"><span>Order value</span><span>—</span></div>`);
  }
  lines.push(`<div class="line"><span>Fees</span><span>Hyperliquid's, at most ${deployment().fees.maxFeeBps} bps</span></div>`);
  lines.push(`<div class="line"><span>Message fees</span><span>paid for you</span></div>`);
  sum.innerHTML = lines.join("");

  const base = m.base.name;
  let label = `${form.side === "buy" ? "Buy" : "Sell"} ${escapeHtml(base)} privately`;
  let disabled = false;
  if (!S.deployed) {
    label = "Opens when HyperVeil is deployed";
    disabled = true;
  } else if (!c.twins) {
    label = "Not available privately yet";
    disabled = true;
  } else if (!S.session) {
    label = "Connect wallet";
  } else if (S.allowlisting) {
    label = "Enabling this account…";
    disabled = true;
  } else if (S.kyc === false) {
    label = "Account not approved";
    disabled = true;
  } else if (!c.draft || c.problem) {
    disabled = true;
  }
  if (S.busy) disabled = true;
  btn.innerHTML = label;
  btn.disabled = disabled;
  btn.classList.toggle("is-sell", form.side === "sell");
  hint.innerHTML = c.problem
    ? `<span class="err">${escapeHtml(c.problem)}</span>`
    : c.warning
      ? `<span class="warn">${escapeHtml(c.warning)}</span>`
      : form.kind === "market"
        ? "Matched inside Veil first; the rest runs immediate-or-cancel on Hyperliquid."
        : form.kind === "post"
          ? "Rests on Hyperliquid as a maker order only; never takes."
          : "Rests until filled or cancelled. Fills settle privately.";
}

// ── Placing an order ────────────────────────────────────────────────────────

async function onSubmit(): Promise<void> {
  if (!S.session) return connect();
  const m = selectedMarket();
  const c = check();
  if (!m || !c.draft || !c.twins || c.problem) return;
  const draft = c.draft;
  const ok = await run(`${form.side === "buy" ? "Buy" : "Sell"} ${m.base.name}`, async (a) => {
    requireDeployed();
    requireKyc();
    const session = requireSession();
    const id = await ensureRegistered(a);

    a.line("Proving the order (sign the authorization in your wallet)");
    const posted = await postOrder(session, id, draft.terms, draft.expiry, a);
    const orderId = hex(posted.orderId);
    const store = S.store!;
    store.addOrder({
      orderId,
      market: m.label,
      coin: m.coin,
      asset: m.asset,
      side: form.side,
      kind: form.kind,
      tif: draft.tif,
      price: draft.price,
      size: form.size.trim(),
      order: {
        maker: hex(posted.order.maker),
        makerSalt: hex(posted.order.makerSalt),
        offerToken: hex(posted.order.offerToken),
        offerAmount: posted.order.offerAmount.toString(),
        wantToken: hex(posted.order.wantToken),
        wantAmount: posted.order.wantAmount.toString(),
        expiry: posted.order.expiry.toString(),
        nonce: hex(posted.order.nonce),
      },
      makerRules: {
        fullRequired: posted.rules.fullRequired,
        capped: posted.rules.capped,
        locked: posted.rules.locked.toString(),
        minResidual: posted.rules.minResidual.toString(),
        residualStrict: posted.rules.residualStrict,
      },
      createdAt: Date.now(),
      postTx: posted.txHash,
    });
    a.line("Order escrowed in Veil");

    const stored = store.orders.find((o) => o.orderId === orderId)!;
    await sendOpening(stored);
    store.updateOrder(orderId, { openingSent: true });
    // The Hyperliquid route fee (STRK) is paid by the keeper, the paymaster:
    // nothing to prepay here.
    a.line("Keeper has the order: crossing inside Veil first");
    return "Order placed. Track it in Portfolio.";
  });
  if (ok) {
    toast("Order placed privately.", "good");
    void refreshAccount();
  }
}
