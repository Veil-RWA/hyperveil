// Portfolio: private balances (decrypted on this device), orders with their
// Veil / Hyperliquid state, and deposits. Order records live in this browser;
// their state is read from the chain.

import { FUND_ORDER } from "veil-sdk";
import {
  $,
  connect,
  ensureIdentity,
  ensureRegistered,
  refresh,
  refreshAccount,
  requireFeeBalance,
  requireSession,
  run,
  S,
  sendCancel,
  sendOpening,
  toast,
  txLink,
  withHeadroom,
} from "../app";
import {
  DEPOSIT_CREDITED,
  DEPOSIT_QUARANTINED,
  DEPOSIT_SENT,
  ORDER_CANCELLED,
  ORDER_FILLED,
  ORDER_OPEN,
  ROUTE_OPEN,
  currentRoute,
  depositOf,
  orderCredit,
  poolOrder,
  quoteRouting,
  venueRoute,
  type DepositRecord,
  type PoolOrder,
  type RouteRecord,
} from "../chain";
import { cctpLabel, cctpStage, type CctpStage } from "../cctp";
import { deployment, usdcTwin } from "../config";
import { ago, escapeHtml, units } from "../format";
import { MIN_NOTIONAL_USDC } from "../orders";
import type { StoredOrder } from "../store";
import { cancelOrder, payFee } from "../veil";

interface OrderView {
  stored: StoredOrder;
  pool?: PoolOrder;
  routed: boolean;
  route: RouteRecord | null;
  credit?: bigint;
}

let orderViews: OrderView[] | null = null;
let depositViews: Array<{
  id: string; amount: string; at: number; tx?: string; rec?: DepositRecord; cctp?: CctpStage;
}> | null = null;
let loading = false;

export function renderPortfolio(root: HTMLElement): void {
  root.innerHTML = `
    <div class="page-head fade-up">
      <div class="kicker">Portfolio</div>
      <h1 class="text-gradient">Only you can see this.</h1>
      <p>Balances and orders are decrypted in this browser with your Veil key. On-chain they are commitments; on Hyperliquid they are the omnibus's.</p>
    </div>
    <div class="stack">
      <section class="panel card" id="pf-balances"></section>
      <section class="panel card" id="pf-orders"></section>
      <section class="panel card" id="pf-deposits"></section>
    </div>`;
  orderViews = null;
  depositViews = null;
  updatePortfolio();
  void load();
}

export function updatePortfolio(): void {
  if (!document.getElementById("pf-balances")) return;
  drawBalances();
  drawOrders();
  drawDeposits();
}

async function load(): Promise<void> {
  if (loading || !S.session || !S.store || !S.deployed) return;
  loading = true;
  try {
    orderViews = await Promise.all(
      S.store.orders.map(async (stored): Promise<OrderView> => {
        const id = BigInt(stored.orderId);
        const [pool, vr, route, credit] = await Promise.all([
          poolOrder(id).catch(() => undefined),
          venueRoute(id).catch(() => ({ routed: false })),
          currentRoute(id).catch(() => null),
          orderCredit(id).catch(() => undefined),
        ]);
        return { stored, pool, routed: vr.routed, route, credit };
      }),
    );
    depositViews = await Promise.all(
      S.store.deposits.map(async (dep) => {
        const rec = await depositOf(BigInt(dep.depositId)).catch(() => undefined);
        // Where Circle has got to — asked only while the deposit is still in
        // flight. Once the twin is credited the USDC has long since landed.
        const pending = !rec || rec.status === DEPOSIT_SENT;
        return {
          id: dep.depositId,
          amount: dep.amountUsdc6,
          at: dep.createdAt,
          tx: dep.txHash,
          rec,
          cctp: pending && dep.txHash ? await cctpStage(dep.txHash) : undefined,
        };
      }),
    );
  } finally {
    loading = false;
  }
  updatePortfolio();
}

/** Called by the app's poll. */
export function pollPortfolio(): void {
  void load();
}

// ── Balances ────────────────────────────────────────────────────────────────

function drawBalances(): void {
  const el = $("pf-balances");
  const head = `<div class="section-title"><h2>Private balances</h2>${
    S.identity ? `<button class="btn btn-ghost btn-sm" id="pf-refresh">Refresh</button>` : ""
  }</div>`;
  if (!S.session) {
    el.innerHTML = `${head}<div class="gate"><p>Connect the Starknet wallet you trade with.</p><button class="btn btn-gold" id="pf-connect">Connect wallet</button></div>`;
    $("pf-connect").addEventListener("click", () => void connect());
    return;
  }
  if (!S.identity) {
    el.innerHTML = `${head}<div class="gate"><p>Sign once to derive your Veil key. It stays on this device and only reads your notes.</p><button class="btn btn-gold" id="pf-unlock">Unlock balances</button></div>`;
    $("pf-unlock").addEventListener("click", () => void unlockBalances());
    return;
  }
  const d = deployment().starknet;
  const twins = d.twins;
  const bal = (addr: string) => (S.notes ?? []).filter((n) => n.token === BigInt(addr)).reduce((t, n) => t + n.amount, 0n);
  const strk20 = S.strk20;
  el.innerHTML = `${head}
    <div class="balances">
      <div class="panel balance"><div class="sym">USDC · in Veil</div><div class="amt num">${
        S.notes ? units(bal(d.usdc), 6, 2) : "…"
      }</div></div>
      ${twins
        .map(
          (t) => `<div class="panel balance"><div class="sym">${escapeHtml(t.symbol)} · on Hyperliquid</div><div class="amt num">${
            S.notes ? units(bal(t.address), t.decimals, 6) : "…"
          }</div></div>`,
        )
        .join("")}
      <div class="panel balance"><div class="sym">STRK · in Veil (fees)</div><div class="amt num">${
        S.notes ? units(bal(d.strk), 18, 4) : "…"
      }</div></div>
      <div class="panel balance"><div class="sym">USDC · STRK20</div><div class="amt num">${
        strk20 ? units(strk20.get(BigInt(d.usdc)) ?? 0n, 6, 2) : "—"
      }</div></div>
      <div class="panel balance"><div class="sym">STRK · STRK20</div><div class="amt num">${
        strk20 ? units(strk20.get(BigInt(d.strk)) ?? 0n, 18, 4) : "—"
      }</div></div>
    </div>
    ${strk20 ? "" : `<div class="hint">Your wallet did not report STRK20 balances (only the "from STRK20" route needs them).</div>`}`;
  $("pf-refresh")?.addEventListener("click", () => {
    void refreshAccount();
    void load();
  });
}

async function unlockBalances(): Promise<void> {
  try {
    await ensureIdentity();
    refresh();
    await refreshAccount();
  } catch (e) {
    toast((e as Error).message, "bad");
  }
}

// ── Orders ──────────────────────────────────────────────────────────────────

interface Status {
  label: string;
  tone: "good" | "gold" | "bad" | "";
  filled: number;
  actions: Array<"cancel" | "request-cancel" | "reclaim" | "opening" | "fund">;
}

function statusOf(v: OrderView): Status {
  const o = v.pool;
  const s = v.stored;
  const actions: Status["actions"] = [];
  if (!o || o.makerCommitment === 0n) return { label: "Not found on-chain", tone: "bad", filled: 0, actions };
  const filled = o.wantAmount ? Number((o.received * 10_000n) / o.wantAmount) / 100 : 0;
  const expired = o.expiry * 1000 < Date.now();
  if (!s.openingSent && o.status === ORDER_OPEN) actions.push("opening");
  if (o.status === ORDER_CANCELLED) return { label: "Cancelled", tone: "", filled, actions: [] };
  if (o.status === ORDER_FILLED) {
    if (!v.routed && o.escrowRemaining > 0n) actions.push("reclaim");
    return { label: v.routed ? "Filled · settling" : "Filled", tone: "good", filled, actions };
  }
  if (v.routed) {
    const pulling = s.cancelRequested || v.route?.cancelRequested;
    if (!pulling) actions.push("request-cancel");
    const onBook = v.route?.status === ROUTE_OPEN;
    return {
      label: pulling ? "Pulling back from Hyperliquid" : onBook ? "On Hyperliquid" : "Settling from Hyperliquid",
      tone: "gold",
      filled,
      actions,
    };
  }
  actions.push("cancel");
  const notional = Number(s.size) * Number(s.price);
  if (notional >= MIN_NOTIONAL_USDC && v.credit !== undefined && v.credit === 0n) actions.push("fund");
  const label = s.cancelRequested ? "Back from Hyperliquid · cancel to finish" : expired ? "Expired · resting in Veil" : "Resting in Veil";
  return { label, tone: "", filled, actions };
}

function drawOrders(): void {
  const el = $("pf-orders");
  const head = `<div class="section-title"><h2>Orders</h2><span class="chip">${S.store?.orders.length ?? 0}</span></div>`;
  if (!S.store || !S.store.orders.length) {
    el.innerHTML = `${head}<div class="empty">No orders from this browser yet.</div>`;
    return;
  }
  const views = orderViews ?? S.store.orders.map((stored) => ({ stored, routed: false, route: null }) as OrderView);
  el.innerHTML = `${head}
    <div class="table-wrap"><table>
      <thead><tr><th>Market</th><th>Side</th><th>Type</th><th class="r">Price</th><th class="r">Size</th><th class="r">Filled</th><th>Status</th><th>Placed</th><th></th></tr></thead>
      <tbody>${views
        .map((v) => {
          const st = orderViews ? statusOf(v) : { label: "Loading…", tone: "", filled: 0, actions: [] as Status["actions"] };
          const s = v.stored;
          const btn = (a: Status["actions"][number], text: string) =>
            `<button class="btn btn-ghost btn-sm" data-act="${a}" data-order="${s.orderId}" ${S.busy ? "disabled" : ""}>${text}</button>`;
          const acts = st.actions
            .map((a) =>
              a === "cancel" ? btn(a, "Cancel") :
              a === "request-cancel" ? btn(a, "Cancel") :
              a === "reclaim" ? btn(a, "Reclaim leftover") :
              a === "opening" ? btn(a, "Send to keeper") :
              btn(a, "Prepay route fee"),
            )
            .join(" ");
          return `<tr>
            <td>${escapeHtml(s.market)}</td>
            <td class="${s.side === "buy" ? "buy" : "sell"}">${s.side === "buy" ? "Buy" : "Sell"}</td>
            <td class="muted">${s.kind === "market" ? "Market" : s.kind === "post" ? "Post only" : "Limit"}</td>
            <td class="r num">${escapeHtml(s.price)}</td>
            <td class="r num">${escapeHtml(s.size)}</td>
            <td class="r num">${st.filled.toFixed(st.filled % 1 ? 2 : 0)}%</td>
            <td>${st.label ? `<span class="chip ${st.tone ? `chip-${st.tone}` : ""}">${escapeHtml(st.label)}</span>` : ""}</td>
            <td class="faint">${s.postTx ? `<a href="${txLink(s.postTx)}" target="_blank" rel="noreferrer">${ago(s.createdAt)}</a>` : ago(s.createdAt)}</td>
            <td class="r">${acts}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table></div>`;
  el.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) =>
    b.addEventListener("click", () => void act(b.dataset.act as Status["actions"][number], b.dataset.order!)),
  );
}

async function act(action: Status["actions"][number], orderId: string): Promise<void> {
  const store = S.store;
  const o = store?.orders.find((x) => x.orderId === orderId);
  if (!store || !o) return;
  const titles = {
    cancel: "Cancel order",
    "request-cancel": "Pull order back from Hyperliquid",
    reclaim: "Reclaim leftover escrow",
    opening: "Send order to keeper",
    fund: "Prepay route fee",
  } as const;
  const ok = await run(titles[action], async (a) => {
    const session = requireSession();
    if (action === "opening") {
      await sendOpening(o);
      store.updateOrder(orderId, { openingSent: true });
      return;
    }
    if (action === "request-cancel") {
      await sendCancel(o);
      store.updateOrder(orderId, { cancelRequested: true });
      return "The keeper cancels it on Hyperliquid; once released, cancel again here to take back the rest.";
    }
    if (action === "fund") {
      const d = deployment();
      const budget = withHeadroom(await quoteRouting(BigInt(orderId), o.asset, BigInt(d.fees.returnValue)));
      const id = await ensureRegistered(a);
      a.line(`Paying ${units(budget, 18, 4)} STRK from your private balance`);
      requireFeeBalance(budget);
      await payFee(session, id, FUND_ORDER, BigInt(orderId), budget, a);
      store.updateOrder(orderId, { feeFunded: budget.toString() });
      return;
    }
    // cancel / reclaim: a proven cancel_order returns the escrow to a private note.
    const id = await ensureRegistered(a);
    a.line("Proving the cancel (sign the authorization in your wallet)");
    await cancelOrder(session, id, BigInt(orderId), BigInt(o.order.makerSalt), a);
    store.updateOrder(orderId, { closed: true });
    return "Escrow returned to your private balance.";
  });
  if (ok) {
    void refreshAccount();
    void load();
  }
}

// ── Deposits ────────────────────────────────────────────────────────────────

function drawDeposits(): void {
  const el = $("pf-deposits");
  const head = `<div class="section-title"><h2>Deposits</h2></div>`;
  // Before the first read finishes, the browser's own record is all there is.
  const rows: NonNullable<typeof depositViews> = depositViews
    ?? (S.store?.deposits ?? []).map((dep) => ({
      id: dep.depositId, amount: dep.amountUsdc6, at: dep.createdAt, tx: dep.txHash,
    }));
  if (!rows.length) {
    el.innerHTML = `${head}<div class="empty">No deposits from this browser yet.</div>`;
    return;
  }
  const usdcDecimals = usdcTwin()?.decimals ?? 8;
  el.innerHTML = `${head}
    <div class="table-wrap"><table>
      <thead><tr><th class="r">Amount</th><th>Status</th><th class="r">Credited</th><th>Sent</th></tr></thead>
      <tbody>${rows
        .map((r) => {
          const st = r.rec?.status;
          // Three things have to happen and each can be the slow one: Circle
          // attests the burn, the keeper carries it to HyperEVM, and the
          // omnibus credits the twin back on Starknet. Saying only "crossing"
          // for all of it leaves a user watching a spinner with no idea which.
          const label = st === DEPOSIT_CREDITED ? "In your balance"
            : st === DEPOSIT_QUARANTINED ? "Held · retry pending"
            : st ? cctpLabel(r.cctp ?? "unknown")
            : "…";
          const tone = st === DEPOSIT_CREDITED ? "chip-good"
            : st === DEPOSIT_QUARANTINED ? "chip-bad"
            : "chip-gold";
          const detail = st === DEPOSIT_SENT
            ? r.cctp === "attested"
              ? "Circle has signed it; the keeper delivers it on Hyperliquid, then credits your note."
              : "Circle attests the burn before the USDC exists on Hyperliquid — about 20 seconds on a fast transfer, hours on a standard one."
            : st === DEPOSIT_QUARANTINED
              ? "The pool refused the credit. Anyone can retry it; nothing is lost."
              : "";
          return `<tr>
            <td class="r num">${units(BigInt(r.amount), 6, 2)} USDC</td>
            <td><span class="chip ${tone}"${detail ? ` title="${escapeHtml(detail)}"` : ""}>${label}</span>${
              st === DEPOSIT_SENT ? `<div class="hint">${escapeHtml(detail)}</div>` : ""
            }</td>
            <td class="r num">${r.rec && r.rec.credited ? `${units(r.rec.credited, usdcDecimals, 2)} USDC` : "—"}</td>
            <td class="faint">${r.tx ? `<a href="${txLink(r.tx)}" target="_blank" rel="noreferrer">${ago(r.at)}</a>` : ago(r.at)}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table></div>`;
}
