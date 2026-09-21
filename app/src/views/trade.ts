// Trade: Hyperliquid spot markets, book and trades (live from the public
// API), and the private order form.
//
// An order is a Veil DvP order. The keeper crosses it against other Veil
// orders first; whatever is left goes to Hyperliquid through the omnibus,
// and fills come back into the order's private receive note.

import { FUND_ORDER } from "veil-sdk";
import {
  $,
  connect,
  ensureRegistered,
  privateBalance,
  refresh,
  refreshAccount,
  requireDeployed,
  requireFeeBalance,
  requireKyc,
  requireSession,
  run,
  S,
  sendOpening,
  toast,
  withHeadroom,
} from "../app";
import { quoteRouting } from "../chain";
import { deployment, twinOf, type TwinConfig } from "../config";
import { ago, compactUsd, escapeHtml, hex, pct, price, units } from "../format";
import { priceProblem, sizeProblem, type Market } from "../market";
import { MIN_NOTIONAL_USDC, draftOrder, type Draft, type FormInput, type OrderKind } from "../orders";
import { payFee, postOrder } from "../veil";

const form: FormInput = { side: "buy", kind: "limit", size: "", price: "", slippage: 0.01 };
let search = "";
let formCoin: string | null = null;

const COIN_KEY = "hyperveil:coin";

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

export function renderTrade(root: HTMLElement): void {
  root.innerHTML = `
    <div class="trade fade-up">
      <aside class="markets panel">
        <input class="field" id="mk-search" placeholder="Search markets" autocomplete="off" value="${escapeHtml(search)}" />
        <div class="market-list" id="mk-list"></div>
      </aside>
      <section class="center">
        <div class="market-head panel" id="mk-head"></div>
        <div class="book-trades">
          <div class="book panel">
            <div class="section-title"><h2>Order book</h2><span class="chip" id="book-age">Hyperliquid</span></div>
            <div class="rows num" id="book"></div>
          </div>
          <div class="trades panel">
            <div class="section-title"><h2>Recent trades</h2><span class="chip" id="trades-age">Hyperliquid</span></div>
            <div class="rows num" id="trades"></div>
          </div>
        </div>
      </section>
      <aside class="form panel" id="order-form"></aside>
    </div>`;
  $<HTMLInputElement>("mk-search").addEventListener("input", (e) => {
    search = (e.target as HTMLInputElement).value;
    updateMarketList();
  });
  formCoin = null;
  updateTrade();
}

/** Redraws the live parts; leaves the form's inputs alone. */
export function updateTrade(): void {
  if (!document.getElementById("mk-list")) return;
  updateMarketList();
  updateHead();
  updateBook();
  updateTrades();
  updateAges();
  if (formCoin !== S.coin) renderForm();
  else updateSummary();
}

function updateMarketList(): void {
  const el = $("mk-list");
  const rows = listed();
  if (!rows.length) {
    el.innerHTML = `<div class="empty">${S.markets.length ? "No match." : "Loading markets…"}</div>`;
    return;
  }
  el.innerHTML = rows
    .map((m) => {
      const c = change(m);
      const priv = tradable(m);
      return `<button class="market-row ${m.coin === S.coin ? "is-active" : ""}" data-coin="${escapeHtml(m.coin)}">
        <span class="pair">${escapeHtml(m.label)}</span>
        <span class="px num">${price(m.mid)}</span>
        <span class="sub">${priv ? `<span class="chip chip-gold" style="padding:.05rem .45rem">Private</span>` : "View only"}</span>
        <span class="chg num ${c >= 0 ? "buy" : "sell"}">${pct(c)}</span>
      </button>`;
    })
    .join("");
  el.querySelectorAll<HTMLButtonElement>(".market-row").forEach((b) =>
    b.addEventListener("click", () => {
      S.coin = b.dataset.coin!;
      S.book = null;
      S.trades = [];
      try {
        localStorage.setItem(COIN_KEY, S.coin);
      } catch {
        /* ignore */
      }
      refresh();
    }),
  );
}

function updateHead(): void {
  const m = selectedMarket();
  const el = $("mk-head");
  if (!m) {
    el.innerHTML = `<div class="muted">Loading Hyperliquid spot markets…</div>`;
    return;
  }
  const c = change(m);
  el.innerHTML = `
    <div>
      <div class="kicker">Hyperliquid spot</div>
      <h1>${escapeHtml(m.label)}</h1>
    </div>
    <div class="stat"><div class="k">Mid price</div><div class="v big num">${price(m.mid)}</div></div>
    <div class="stat"><div class="k">24h change</div><div class="v num ${c >= 0 ? "buy" : "sell"}">${pct(c)}</div></div>
    <div class="stat"><div class="k">24h volume</div><div class="v num">${compactUsd(m.dayNtlVlm ?? NaN)}</div></div>
    <div class="stat" style="margin-left:auto">${
      tradable(m)
        ? `<span class="chip chip-gold"><span class="dot"></span>Private trading</span>`
        : `<span class="chip">View only</span>`
    }</div>`;
}

/** "live · 2s ago", so a market that has not traded for an hour still shows
 *  that the page is reading it now. */
function freshness(): string {
  if (S.marketAt === null) return "Hyperliquid";
  const secs = Math.max(0, Math.round((Date.now() - S.marketAt) / 1000));
  return `live · ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`} ago`;
}

function updateAges(): void {
  const book = document.getElementById("book-age");
  const trades = document.getElementById("trades-age");
  if (book) book.textContent = freshness();
  if (!trades) return;
  // The tape's own age: on a quiet testnet the last trade can be hours old,
  // which is the market, not the page.
  const last = S.trades[0];
  trades.textContent = last ? `last trade ${ago(last.time)}` : freshness();
}

function updateBook(): void {
  const el = $("book");
  const m = selectedMarket();
  const b = S.book;
  if (!m || !b) {
    el.innerHTML = `<div class="empty">Loading…</div>`;
    return;
  }
  const depth = 9;
  const cum = (levels: { sz: string }[]) => {
    let t = 0;
    return levels.map((l) => (t += Number(l.sz)));
  };
  const asks = b.asks.slice(0, depth);
  const bids = b.bids.slice(0, depth);
  const ca = cum(asks);
  const cb = cum(bids);
  const max = Math.max(ca[ca.length - 1] ?? 0, cb[cb.length - 1] ?? 0) || 1;
  const row = (side: "ask" | "bid", l: { px: string; sz: string }, total: number) =>
    `<div class="row ${side}"><span class="${side === "ask" ? "sell" : "buy"}">${price(l.px)}</span><span>${Number(l.sz).toLocaleString("en-US", { maximumFractionDigits: m.base.szDecimals })}</span><span>${total.toLocaleString("en-US", { maximumFractionDigits: m.base.szDecimals })}</span><i class="bar" style="width:${((total / max) * 100).toFixed(1)}%"></i></div>`;
  const bestAsk = Number(asks[0]?.px);
  const bestBid = Number(bids[0]?.px);
  const spread = bestAsk && bestBid ? bestAsk - bestBid : NaN;
  el.innerHTML = `
    <div class="row head"><span>Price (${escapeHtml(m.quote.name)})</span><span>Size (${escapeHtml(m.base.name)})</span><span>Total</span></div>
    ${asks.map((l, i) => row("ask", l, ca[i])).reverse().join("")}
    <div class="spread">Spread ${Number.isFinite(spread) ? `${price(spread)} · ${((spread / bestAsk) * 100).toFixed(3)}%` : "—"}</div>
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
    `<div class="row head"><span>Price</span><span>Size</span><span>Time</span></div>` +
    S.trades
      .slice(0, 19)
      .map(
        (t) =>
          `<div class="row"><span class="${t.side === "B" ? "buy" : "sell"}">${price(t.px)}</span><span>${Number(t.sz).toLocaleString("en-US", { maximumFractionDigits: m.base.szDecimals })}</span><span class="faint">${new Date(t.time).toLocaleTimeString()}</span></div>`,
      )
      .join("");
}

// ── Order form ──────────────────────────────────────────────────────────────

function renderForm(): void {
  const el = $("order-form");
  const m = selectedMarket();
  formCoin = S.coin;
  if (!m) {
    el.innerHTML = `<div class="muted">Pick a market.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="seg" id="f-side">
      <button data-side="buy">Buy</button>
      <button data-side="sell">Sell</button>
    </div>
    <div class="kinds" id="f-kind">
      <button data-kind="market">Market</button>
      <button data-kind="limit">Limit</button>
      <button data-kind="post">Post only</button>
    </div>
    <div id="f-price-box"></div>
    <label class="lbl" for="f-size">Size</label>
    <div class="field-wrap">
      <input class="field num" id="f-size" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${escapeHtml(form.size)}" />
      <span class="field-unit">${escapeHtml(m.base.name)}</span>
    </div>
    <div class="summary num" id="f-summary"></div>
    <button class="btn btn-gold btn-block" id="f-submit"></button>
    <div class="hint" id="f-hint"></div>
    <div class="privacy"><span>◆</span><span>Your wallet never appears on Hyperliquid. Orders settle in Veil's private pool; Hyperliquid sees only the HyperVeil omnibus.</span></div>`;

  el.querySelectorAll<HTMLButtonElement>("#f-side button").forEach((b) =>
    b.addEventListener("click", () => {
      form.side = b.dataset.side as "buy" | "sell";
      paintToggles();
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
    updateSummary();
  });
  $("f-submit").addEventListener("click", () => void onSubmit());
  paintToggles();
  renderPriceBox();
  updateSummary();
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
      <label class="lbl">Max slippage</label>
      <div class="slip">${[0.005, 0.01, 0.02]
        .map((s) => `<button class="btn btn-ghost btn-sm ${form.slippage === s ? "is-active" : ""}" data-slip="${s}">${(s * 100).toFixed(1)}%</button>`)
        .join("")}</div>`;
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
    <label class="lbl" for="f-price">Limit price</label>
    <div class="field-wrap">
      <input class="field num" id="f-price" inputmode="decimal" placeholder="${escapeHtml(price(m.mid))}" autocomplete="off" value="${escapeHtml(form.price)}" />
      <span class="field-unit">${escapeHtml(m.quote.name)}</span>
    </div>
    <div class="hint"><button class="btn btn-ghost btn-sm" id="f-mid">Use mid</button></div>`;
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
  if (!m || !sum || !btn || !hint) return;
  const c = check();
  const offerTwin = c.twins ? (form.side === "buy" ? c.twins.quote : c.twins.base) : undefined;
  const wantTwin = c.twins ? (form.side === "buy" ? c.twins.base : c.twins.quote) : undefined;
  const bal = offerTwin ? privateBalance(BigInt(offerTwin.address)) : undefined;
  const lines: string[] = [];
  if (c.draft && offerTwin && wantTwin) {
    lines.push(`<div class="line"><span>Limit price</span><span>${price(c.draft.price)} ${escapeHtml(m.quote.name)}</span></div>`);
    lines.push(`<div class="line"><span>You pay at most</span><span>${units(c.draft.terms.offerAmount, offerTwin.decimals)} ${escapeHtml(offerTwin.symbol)}</span></div>`);
    lines.push(`<div class="line"><span>You receive at least</span><span>${units(c.draft.terms.wantAmount, wantTwin.decimals)} ${escapeHtml(wantTwin.symbol)}</span></div>`);
    lines.push(`<div class="line"><span>Order value</span><span>≈ ${c.draft.notional.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC</span></div>`);
  } else {
    lines.push(`<div class="line"><span>Order value</span><span>—</span></div>`);
  }
  lines.push(
    `<div class="line"><span>Available (private)</span><span>${
      !offerTwin || !S.session ? "—" : bal === undefined ? "Unlock in Portfolio" : `${units(bal, offerTwin.decimals)} ${escapeHtml(offerTwin.symbol)}`
    }</span></div>`,
  );
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
    label = "Enabling this account\u2026";
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
    const d = deployment();
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
    a.line("Keeper has the order: crossing inside Veil first");

    if (draft.notional >= MIN_NOTIONAL_USDC) {
      const budget = withHeadroom(await quoteRouting(posted.orderId, m.asset, BigInt(d.fees.returnValue)));
      a.line(`Prepaying the Hyperliquid route fee from your private STRK (${units(budget, 18, 4)} STRK)`);
      requireFeeBalance(budget);
      await payFee(session, id, FUND_ORDER, posted.orderId, budget, a);
      store.updateOrder(orderId, { feeFunded: budget.toString() });
    }
    return "Order placed. Track it in Portfolio.";
  });
  if (ok) {
    toast("Order placed privately.", "good");
    void refreshAccount();
  }
}
