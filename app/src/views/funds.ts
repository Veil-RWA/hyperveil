// Deposit and Withdraw.
//
// Both sides start from the user's balances INSIDE the Veil pool: real USDC
// (and the STRK that pays HyperVeil's message fees) live there as private
// notes. So each page has two parts.
//
// Deposit:  "Add USDC to Veil"       from the wallet, or from a STRK20 balance
//           "Send USDC to Hyperliquid"  a proven invoke: the entry helper burns
//           it by Circle CCTP to the omnibus, and the omnibus's CREDIT fills
//           the user's USDC-twin note. It becomes the balance that trades.
// Withdraw: "Bring USDC back"        a proven invoke: the gateway burns the
//           twin, the omnibus sends the USDC back by CCTP, and the exit vault
//           fills the private USDC note the exit named — nothing to claim.
//           "Take USDC out of Veil"  a proven withdrawal to any address.
//
// Every message fee is prepaid from the user's private STRK, through the fee
// adapter, and keyed to the note it pays for, so no public wallet is ever tied
// to a deposit or a withdrawal.

import { FUND_NOTE, INVOKE_CHANGE, strk20ToVeilActions, toUnits } from "veil-sdk";
import {
  $,
  connect,
  ensureIdentity,
  ensureRegistered,
  privateBalance,
  refreshAccount,
  requireDeployed,
  requireFeeBalance,
  requireKyc,
  requireSession,
  run,
  S,
  toast,
  txLink,
  withHeadroom,
} from "../app";
import {
  EXIT_DELIVERED,
  EXIT_FUNDED,
  EXIT_REGISTERED,
  depositId,
  depositOfNote,
  erc20Balance,
  exitIdFromTx,
  exitOf,
  exitOfNote,
  exitsFor,
  noteCredit,
  quoteDeposit,
  quoteExit,
  type ExitRecord,
} from "../chain";
import { fastTransferBps, feeOf } from "../cctp";
import { CIRCLE_FAUCET, deployment, hasTestnetFaucet, usdcTwin } from "../config";
import { ago, escapeHtml, hex, units } from "../format";
import { submit } from "../strk20";
import {
  createOpenNote,
  depositToHyperliquid,
  depositToVeil,
  exit,
  isEmptyOpenNote,
  noteValue,
  payFee,
  withdrawFromVeil,
} from "../veil";
import { approve } from "../wallet";

const HOW_IN = [
  ["Hold USDC in Veil", "From your wallet, or privately from your STRK20 balance."],
  ["Send it to Hyperliquid", "One proven transaction; Circle CCTP carries the USDC to the omnibus in about a minute."],
  ["It lands in your private note", "The same USDC, tradable on Hyperliquid's books, still only yours to see."],
];

const HOW_OUT = [
  ["Prove the withdrawal", "Your Hyperliquid USDC is burned; the omnibus sends the real USDC back."],
  ["It fills your private note", "Circle attests, the vault delivers it into Veil. Nothing to claim."],
  ["Take it out when you like", "Withdraw from Veil to any address, or keep it for the next trade."],
];

const steps = (rows: string[][]) =>
  `<ol class="steps">${rows.map(([b, t], i) => `<li><span class="n">${i + 1}</span><span><b>${b}.</b> ${t}</span></li>`).join("")}</ol>`;

let feeTimer: number | undefined;
// Typed amounts survive the redraws an account refresh causes.
let depositValue = "";
let withdrawValue = "";
let addValue = "";
let addSource: "wallet" | "strk20" = "wallet";
let addToken: "usdc" | "strk" = "usdc";
/** The connected wallet's balance of `addToken`, as last read. */
let walletHeld: bigint | undefined;
let outValue = "";
let exitRecords = new Map<string, ExitRecord>();

function gate(root: HTMLElement): boolean {
  if (S.session) return false;
  root.querySelectorAll<HTMLElement>(".form-slot").forEach((el) => {
    el.innerHTML = `<div class="gate"><p>Connect your Starknet wallet.</p><button class="btn btn-gold" id="fd-connect">Connect wallet</button></div>`;
  });
  $("fd-connect").addEventListener("click", () => void connect());
  return true;
}

/** The user's private balance of a pool token, formatted. */
function inVeil(token: string, decimals: number, places: number): string {
  const bal = privateBalance(BigInt(token));
  return bal === undefined ? "…" : units(bal, decimals, places);
}

// ── Add USDC (or STRK) to Veil ──────────────────────────────────────────────

function addPanel(): string {
  const d = deployment().starknet;
  const strk20 = S.strk20;
  const hasEntry = (() => {
    try {
      return BigInt(d.strk20Entry) !== 0n;
    } catch {
      return false;
    }
  })();
  const token = addToken === "usdc" ? { address: d.usdc, symbol: "USDC", decimals: 6, places: 2 } : { address: d.strk, symbol: "STRK", decimals: 18, places: 4 };
  return `
    <h2>Add to your Veil balance</h2>
    <div class="tabs sm">
      <button class="tab ${addToken === "usdc" ? "on" : ""}" data-add-token="usdc">USDC</button>
      <button class="tab ${addToken === "strk" ? "on" : ""}" data-add-token="strk">STRK (fees)</button>
    </div>
    <div class="tabs sm">
      <button class="tab ${addSource === "wallet" ? "on" : ""}" data-add-source="wallet">From wallet</button>
      <button class="tab ${addSource === "strk20" ? "on" : ""}" data-add-source="strk20" ${hasEntry ? "" : "disabled"}>From STRK20</button>
    </div>
    <label class="lbl" for="ad-amount">Amount</label>
    <div class="field-wrap"><input class="field num" id="ad-amount" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${escapeHtml(addValue)}" /><span class="field-unit">${token.symbol}</span></div>
    <div class="summary num">
      <div class="line"><span>${addSource === "wallet" ? "In your wallet" : "In STRK20"}</span><span id="ad-avail">${
        addSource === "strk20"
          ? strk20
            ? `${units(strk20.get(BigInt(token.address)) ?? 0n, token.decimals, token.places)} ${token.symbol}`
            : "—"
          : "…"
      }</span></div>
      <div class="line"><span>In Veil now</span><span>${inVeil(token.address, token.decimals, token.places)} ${token.symbol}</span></div>
    </div>
    <button class="btn btn-gold btn-block" id="ad-go" ${S.busy || !S.deployed ? "disabled" : ""}>Add ${token.symbol} to Veil</button>
    ${addToken === "usdc" && hasTestnetFaucet()
      ? `<a class="btn btn-ghost btn-block" id="ad-claim" style="margin-top:.5rem" href="${CIRCLE_FAUCET}" target="_blank" rel="noopener noreferrer">Claim USDC faucet</a>
         <div class="hint">No USDC yet? Circle's faucet gives 20 USDC every 2 hours on Starknet Sepolia.</div>`
      : ""}
    <div class="hint">${
      addSource === "wallet"
        ? "Two steps: an approval in your wallet, then a proven deposit. The amount and your address are public at this step, as with any deposit."
        : "One STRK20 transaction: it withdraws to the HyperVeil entry, which fills a private note in Veil."
    }</div>`;
}

function wireAddPanel(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("[data-add-token]").forEach((b) =>
    b.addEventListener("click", () => {
      addToken = b.dataset.addToken as "usdc" | "strk";
      walletHeld = undefined;
      renderDeposit(root.closest<HTMLElement>("#view") ?? root);
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-add-source]").forEach((b) =>
    b.addEventListener("click", () => {
      addSource = b.dataset.addSource as "wallet" | "strk20";
      walletHeld = undefined;
      renderDeposit(root.closest<HTMLElement>("#view") ?? root);
    }),
  );
  const input = document.getElementById("ad-amount") as HTMLInputElement | null;
  input?.addEventListener("input", () => (addValue = input.value));
  document.getElementById("ad-avail")?.addEventListener("click", () => {
    if (walletHeld === undefined || addSource !== "wallet" || !input) return;
    const token = addPanelToken();
    input.value = units(walletHeld, token.decimals, token.places).replace(/,/g, "");
    addValue = input.value;
  });
  document.getElementById("ad-go")?.addEventListener("click", () => void addToVeil(input?.value ?? ""));
  if (addSource === "wallet" && S.session) void walletBalance();
}

/** What the connected wallet holds of the token the panel is on. */
function addPanelToken(): { address: string; decimals: number; places: number; symbol: string } {
  const d = deployment().starknet;
  return addToken === "usdc"
    ? { address: d.usdc, decimals: 6, places: 2, symbol: "USDC" }
    : { address: d.strk, decimals: 18, places: 4, symbol: "STRK" };
}

/**
 * Fills in "In your wallet". It touches one element and nothing else, so it
 * can run on every account poll — a re-render would be skipped while the user
 * is typing in the amount field, which is exactly when they are looking at
 * this number.
 */
export async function walletBalance(): Promise<void> {
  const el = document.getElementById("ad-avail");
  const session = S.session;
  if (!el || !session || addSource !== "wallet") return;
  const token = addPanelToken();
  // One retry: a single RPC hiccup used to leave a dash on the screen for as
  // long as the page stayed open.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const balance = await erc20Balance(token.address, session.address);
      walletHeld = balance;
      el.textContent = `${units(balance, token.decimals, token.places)} ${token.symbol}`;
      el.classList.add("link");
      el.title = "Use all of it";
      return;
    } catch (e) {
      console.warn("wallet balance", e);
      if (attempt === 0) await new Promise((r) => window.setTimeout(r, 1200));
    }
  }
  el.textContent = "could not read";
}

async function addToVeil(value: string): Promise<void> {
  const d = deployment().starknet;
  const token = addToken === "usdc" ? { address: d.usdc, decimals: 6, symbol: "USDC" } : { address: d.strk, decimals: 18, symbol: "STRK" };
  const ok = await run(`Add ${token.symbol} to Veil`, async (a) => {
    requireDeployed();
    requireKyc();
    const session = requireSession();
    const amount = toUnits(value, token.decimals);
    if (amount === 0n) throw new Error("Enter an amount.");
    const id = await ensureRegistered(a);

    if (addSource === "wallet") {
      a.line("Approve the pool to take the tokens (one wallet transaction)");
      await approve(session, token.address, d.pool, amount);
      a.line("Proving the deposit (sign the authorization in your wallet)");
      await depositToVeil(session, id, BigInt(token.address), amount, a);
      return `${units(amount, token.decimals, 6)} ${token.symbol} is in your private balance.`;
    }

    if (!S.strk20) throw new Error("This wallet did not report a STRK20 balance.");
    const held = S.strk20.get(BigInt(token.address)) ?? 0n;
    if (held < amount) throw new Error(`Not enough ${token.symbol} in your STRK20 balance.`);
    a.line("Opening a private note for it (sign the authorization)");
    const noteId = await createOpenNote(session, id, BigInt(token.address), a);
    a.line("Approve the STRK20 transaction in your wallet");
    await submit(
      session,
      strk20ToVeilActions({ token: BigInt(token.address), strk20Entry: BigInt(d.strk20Entry), veilNoteId: noteId, amount }),
    );
    return `${units(amount, token.decimals, 6)} ${token.symbol} moved from STRK20 into Veil.`;
  });
  if (ok) {
    addValue = "";
    toast("Added to your Veil balance.", "good");
    void refreshAccount();
  }
}

// ── Deposit: Veil USDC -> Hyperliquid ───────────────────────────────────────

export function renderDeposit(root: HTMLElement): void {
  const d = deployment().starknet;
  root.innerHTML = `
    <div class="page-head fade-up">
      <div class="kicker">Deposit</div>
      <h1 class="text-gradient">Fund your private account.</h1>
      <p>USDC you hold privately in Veil goes to Hyperliquid, backed one-to-one by USDC the omnibus holds there.</p>
    </div>
    <section class="panel card" style="margin-bottom:1.25rem"><h2>How it works</h2>${steps(HOW_IN)}
      <p class="hint">About a minute: Circle attests the burn (a fast transfer, ~20 seconds) before the USDC is minted on Hyperliquid, then the keeper credits your note.</p></section>
    <div class="two">
      <section class="panel card form-slot" id="dp-slot"></section>
      <section class="panel card form-slot" id="ad-slot"></section>
    </div>`;
  if (gate(root)) return;
  const usdcBal = inVeil(d.usdc, 6, 2);
  // One unit always comes back as change, so that much is never sendable.
  const heldUsdc = privateBalance(BigInt(d.usdc));
  const sendableUsdc = heldUsdc === undefined ? undefined : heldUsdc > INVOKE_CHANGE ? heldUsdc - INVOKE_CHANGE : 0n;
  $("dp-slot").innerHTML = `
    <h2>Send USDC to Hyperliquid</h2>
    <label class="lbl" for="dp-amount">Amount</label>
    <div class="field-wrap"><input class="field num" id="dp-amount" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${escapeHtml(depositValue)}" /><span class="field-unit">USDC</span></div>
    <div class="summary num">
      <div class="line"><span>Private USDC in Veil</span><span id="dp-held"${
        heldUsdc !== undefined && heldUsdc > INVOKE_CHANGE ? ` class="link" title="Send all of it"` : ""
      }>${usdcBal} USDC</span></div>
      <div class="line"><span>Message fee (private STRK)</span><span id="dp-fee">—</span></div>
      <div class="line"><span id="dp-cctp-label">Circle transfer fee</span><span id="dp-cctp">—</span></div>
      <div class="line"><span>Tradable on Hyperliquid</span><span id="dp-get">—</span></div>
    </div>
    <button class="btn btn-gold btn-block" id="dp-go" ${S.busy || !S.deployed ? "disabled" : ""}>${S.deployed ? "Send to Hyperliquid" : "Opens when HyperVeil is deployed"}</button>
    <div class="hint" id="dp-hint">${S.allowlisting
      ? `Enabling this account to hold HyperVeil assets\u2026`
      : S.kyc === false
        ? `<span class="err">This account is not approved to hold HyperVeil assets yet.</span>`
        : ""}</div>`;
  $("ad-slot").innerHTML = addPanel();
  wireAddPanel(root);
  const input = $<HTMLInputElement>("dp-amount");
  document.getElementById("dp-held")?.addEventListener("click", () => {
    if (sendableUsdc === undefined || sendableUsdc === 0n) return;
    input.value = units(sendableUsdc, 6, 6).replace(/,/g, "");
    depositValue = input.value;
    void estimateDeposit(input.value);
  });
  if (depositValue) void estimateDeposit(depositValue);
  input.addEventListener("input", () => {
    depositValue = input.value;
    window.clearTimeout(feeTimer);
    feeTimer = window.setTimeout(() => void estimateDeposit(input.value), 350);
  });
  $("dp-go").addEventListener("click", () => void deposit(input.value));
}

async function estimateDeposit(value: string): Promise<void> {
  const fee = document.getElementById("dp-fee");
  const get = document.getElementById("dp-get");
  if (!fee || !get) return;
  let amount6: bigint;
  try {
    amount6 = toUnits(value, 6);
  } catch {
    fee.textContent = "—";
    get.textContent = "—";
    return;
  }
  // A fast transfer is paid for out of the transfer: Circle keeps its cut and
  // what lands on Hyperliquid is the rest. Saying the full amount was a lie by
  // a few basis points.
  const cctpEl = document.getElementById("dp-cctp");
  const cctpLabelEl = document.getElementById("dp-cctp-label");
  const fast = deployment().cctp.minFinality <= 1000;
  const bps = fast ? await fastTransferBps() : 0;
  const cut = bps === null ? null : feeOf(amount6, bps);
  if (cctpEl) {
    cctpEl.textContent = !fast ? "none (standard)" : cut === null ? "—" : `${units(cut, 6, 6)} USDC`;
  }
  if (cctpLabelEl) {
    cctpLabelEl.textContent = fast
      ? `Circle fast transfer${bps ? ` (${bps} bps)` : ""}`
      : "Circle transfer fee";
  }
  get.textContent = `${units(amount6 - (cut ?? 0n), 6, 6)} USDC`;
  if (!S.deployed) return;
  try {
    const q = withHeadroom(await quoteDeposit(1n, amount6, BigInt(deployment().fees.returnValue)));
    // Zero is the honest answer on a network where the message costs nothing;
    // "≤ 0 STRK" reads like a failed lookup.
    fee.textContent = q === 0n ? "none" : `≤ ${units(q, 18, 4)} STRK`;
  } catch {
    fee.textContent = "unavailable";
  }
}

async function deposit(value: string): Promise<void> {
  const ok = await run("Send USDC to Hyperliquid", async (a) => {
    requireDeployed();
    requireKyc();
    const session = requireSession();
    const store = S.store!;
    const d = deployment();
    const twin = usdcTwin()!;
    const amount6 = toUnits(value, 6);
    if (amount6 === 0n) throw new Error("Enter an amount.");
    const held = privateBalance(BigInt(d.starknet.usdc));
    if (held !== undefined && held < amount6 + INVOKE_CHANGE) {
      // The invoke spends `amount + 1`: the pool hands one unit back as change,
      // which is what proves the adapter ran. So the balance is never fully
      // sendable, and saying "not enough" without the numbers is no help.
      if (held <= INVOKE_CHANGE) throw new Error("No private USDC in Veil yet. Add some first.");
      throw new Error(
        `You hold ${units(held, 6, 6)} USDC in Veil and this would spend ` +
          `${units(amount6 + INVOKE_CHANGE, 6, 6)} (one unit comes back as change). ` +
          `The most you can send is ${units(held - INVOKE_CHANGE, 6, 6)}.`,
      );
    }
    const id = await ensureRegistered(a);

    // A note opened for a deposit that never went out is reused.
    let noteId: bigint | undefined;
    const pending = store.pendingDepositNote;
    if (pending && isEmptyOpenNote(await noteValue(BigInt(pending))) && (await depositOfNote(BigInt(pending))) === 0n) {
      noteId = BigInt(pending);
    }
    if (noteId === undefined) {
      a.line("Opening a private note for the Hyperliquid USDC (sign the authorization)");
      noteId = await createOpenNote(session, id, BigInt(twin.address), a);
      store.setPendingDepositNote(hex(noteId));
    }

    const need = withHeadroom(await quoteDeposit(noteId, amount6, BigInt(d.fees.returnValue)));
    const have = await noteCredit(noteId);
    if (have < need) {
      requireFeeBalance(need - have);
      a.line(`Prepaying the message fee from your private STRK (${units(need - have, 18, 4)} STRK)`);
      await payFee(session, id, FUND_NOTE, noteId, need - have, a);
    }

    a.line("Proving the transfer (sign the authorization in your wallet)");
    const tx = await depositToHyperliquid(session, id, amount6, noteId, a);
    store.addDeposit({
      noteId: hex(noteId),
      depositId: hex(depositId(noteId)),
      amountUsdc6: amount6.toString(),
      createdAt: Date.now(),
      txHash: tx,
    });
    store.setPendingDepositNote(undefined);
    return "On its way. It appears in your Hyperliquid balance once the omnibus credits it.";
  });
  if (ok) {
    depositValue = "";
    toast("Deposit sent.", "good");
    void refreshAccount();
  }
}

// ── Withdraw: Hyperliquid -> Veil USDC, and Veil -> anywhere ────────────────

export function renderWithdraw(root: HTMLElement): void {
  const d = deployment().starknet;
  root.innerHTML = `
    <div class="page-head fade-up">
      <div class="kicker">Withdraw</div>
      <h1 class="text-gradient">Bring it back, privately.</h1>
      <p>USDC leaves Hyperliquid by Circle CCTP and lands straight in a private note of yours. Take it out of Veil whenever you want.</p>
    </div>
    <section class="panel card" style="margin-bottom:1.25rem"><h2>How it works</h2>${steps(HOW_OUT)}</section>
    <div class="two">
      <section class="panel card form-slot" id="wd-slot"></section>
      <section class="panel card form-slot" id="ou-slot"></section>
    </div>
    <section class="panel card" id="wd-exits" style="margin-top:1.25rem"></section>`;
  if (gate(root)) return;
  const twin = S.deployed ? usdcTwin() : undefined;
  const bal = twin ? privateBalance(BigInt(twin.address)) : undefined;
  // A plain withdrawal keeps nothing back, so the whole private balance goes.
  const heldUsdcOut = privateBalance(BigInt(d.usdc));
  $("wd-slot").innerHTML = `
    <h2>Bring USDC back from Hyperliquid</h2>
    <label class="lbl" for="wd-amount">Amount</label>
    <div class="field-wrap"><input class="field num" id="wd-amount" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${escapeHtml(withdrawValue)}" /><span class="field-unit">USDC</span></div>
    <div class="summary num">
      <div class="line"><span>On Hyperliquid</span><span id="wd-held"${
        bal !== undefined && twin && bal > INVOKE_CHANGE && S.identity ? ` class="link" title="Bring all of it back"` : ""
      }>${
        !S.identity ? `<button class="btn btn-ghost btn-sm" id="wd-unlock">Unlock</button>` : bal === undefined || !twin ? "…" : `${units(bal, twin.decimals, 2)} USDC`
      }</span></div>
      <div class="line"><span>Message fee (private STRK)</span><span id="wd-fee">—</span></div>
    </div>
    <button class="btn btn-gold btn-block" id="wd-go" ${S.busy || !S.deployed ? "disabled" : ""}>${S.deployed ? "Bring back to Veil" : "Opens when HyperVeil is deployed"}</button>
    <div class="hint">Whole cents only: USDC crosses by CCTP with 6 decimals.</div>`;
  $("ou-slot").innerHTML = `
    <h2>Take USDC out of Veil</h2>
    <label class="lbl" for="ou-amount">Amount</label>
    <div class="field-wrap"><input class="field num" id="ou-amount" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${escapeHtml(outValue)}" /><span class="field-unit">USDC</span></div>
    <div class="summary num">
      <div class="line"><span>Private USDC in Veil</span><span id="ou-held"${
        heldUsdcOut !== undefined && heldUsdcOut > 0n ? ` class="link" title="Withdraw all of it"` : ""
      }>${inVeil(d.usdc, 6, 2)} USDC</span></div>
      <div class="line"><span>Goes to</span><span>${S.session ? escapeHtml(`${S.session.address.slice(0, 8)}…${S.session.address.slice(-4)}`) : "—"}</span></div>
    </div>
    <button class="btn btn-ghost btn-block" id="ou-go" ${S.busy || !S.deployed ? "disabled" : ""}>Withdraw to my wallet</button>
    <div class="hint">A proven withdrawal: the amount and the address are public, the sender is not.</div>`;
  const input = $<HTMLInputElement>("wd-amount");
  document.getElementById("wd-held")?.addEventListener("click", () => {
    const max = maxExit(bal);
    if (max === 0n || !twin) return;
    input.value = units(max, twin.decimals, 6).replace(/,/g, "");
    withdrawValue = input.value;
    void estimateExit(input.value);
  });
  if (withdrawValue) void estimateExit(withdrawValue);
  input.addEventListener("input", () => {
    withdrawValue = input.value;
    window.clearTimeout(feeTimer);
    feeTimer = window.setTimeout(() => void estimateExit(input.value), 350);
  });
  $("wd-go").addEventListener("click", () => void withdraw(input.value));
  const outInput = $<HTMLInputElement>("ou-amount");
  document.getElementById("ou-held")?.addEventListener("click", () => {
    if (heldUsdcOut === undefined || heldUsdcOut === 0n) return;
    outInput.value = units(heldUsdcOut, 6, 6).replace(/,/g, "");
    outValue = outInput.value;
  });
  outInput.addEventListener("input", () => (outValue = outInput.value));
  $("ou-go").addEventListener("click", () => void takeOut(outInput.value));
  document.getElementById("wd-unlock")?.addEventListener("click", async () => {
    try {
      await ensureIdentity();
      await refreshAccount();
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  });
  drawExits();
  void loadExits();
}

/** USDC twin units (8 dp) for a human amount; always a whole CCTP unit. */
function exitAmount(value: string): bigint {
  return toUnits(value, 6) * 100n;
}

/**
 * The most a holder can bring back, in twin units (8 dp): their balance, less
 * the one unit the invoke hands back as change, floored to a whole 6-decimal
 * USDC — CCTP carries 6 decimals, and the omnibus rejects anything that is not
 * a multiple of `USDC_CORE_PER_CCTP_UNIT`.
 */
function maxExit(balance: bigint | undefined): bigint {
  if (balance === undefined || balance <= INVOKE_CHANGE) return 0n;
  const spendable = balance - INVOKE_CHANGE;
  return spendable - (spendable % 100n);
}

async function estimateExit(value: string): Promise<void> {
  const fee = document.getElementById("wd-fee");
  if (!fee || !S.deployed) return;
  try {
    const amount = exitAmount(value);
    if (amount === 0n) throw new Error();
    const q = withHeadroom(await quoteExit(amount));
    fee.textContent = q === 0n ? "none" : `≤ ${units(q, 18, 4)} STRK`;
  } catch {
    fee.textContent = "—";
  }
}

async function withdraw(value: string): Promise<void> {
  const ok = await run("Bring USDC back from Hyperliquid", async (a) => {
    requireDeployed();
    const session = requireSession();
    const store = S.store!;
    const d = deployment();
    const twin = usdcTwin()!;
    const amount = exitAmount(value);
    if (amount === 0n) throw new Error("Enter an amount.");
    const id = await ensureRegistered(a);
    const bal = privateBalance(BigInt(twin.address));
    if (bal !== undefined && bal < amount + INVOKE_CHANGE) {
      if (bal <= INVOKE_CHANGE) throw new Error("Nothing on Hyperliquid to bring back yet.");
      throw new Error(
        `You hold ${units(bal, twin.decimals, 6)} USDC on Hyperliquid and this would spend ` +
          `${units(amount + INVOKE_CHANGE, twin.decimals, 6)} (one unit comes back as change). ` +
          `The most you can bring back is ${units(maxExit(bal), twin.decimals, 6)}.`,
      );
    }

    // The note the USDC comes back into: opened once, reused if a withdrawal
    // was started and never sent.
    let noteId: bigint | undefined;
    const pending = store.pendingExitNote;
    if (pending && isEmptyOpenNote(await noteValue(BigInt(pending))) && (await exitOfNote(BigInt(pending))) === 0n) {
      noteId = BigInt(pending);
    }
    if (noteId === undefined) {
      a.line("Opening the private note it comes back into (sign the authorization)");
      noteId = await createOpenNote(session, id, BigInt(d.starknet.usdc), a);
      store.setPendingExitNote(hex(noteId));
    }

    const need = withHeadroom(await quoteExit(amount));
    const have = await noteCredit(noteId);
    if (have < need) {
      requireFeeBalance(need - have);
      a.line(`Prepaying the message fee from your private STRK (${units(need - have, 18, 4)} STRK)`);
      await payFee(session, id, FUND_NOTE, noteId, need - have, a);
    }

    a.line("Proving the withdrawal (sign the authorization in your wallet)");
    const tx = await exit(session, id, BigInt(twin.address), amount, noteId, a);
    const exitId = await exitIdFromTx(tx);
    store.addExit({
      noteId: hex(noteId),
      amount: amount.toString(),
      createdAt: Date.now(),
      txHash: tx,
      exitId: exitId === null ? undefined : hex(exitId),
    });
    store.setPendingExitNote(undefined);
    return "On its way back. It lands in your private USDC balance in a few minutes.";
  });
  if (ok) {
    withdrawValue = "";
    toast("Withdrawal sent.", "good");
    void refreshAccount();
    void loadExits();
  }
}

async function takeOut(value: string): Promise<void> {
  const ok = await run("Withdraw USDC from Veil", async (a) => {
    requireDeployed();
    const session = requireSession();
    const d = deployment().starknet;
    const amount = toUnits(value, 6);
    if (amount === 0n) throw new Error("Enter an amount.");
    const held = privateBalance(BigInt(d.usdc));
    if (held !== undefined && held < amount) throw new Error("Not enough private USDC in Veil.");
    const id = await ensureRegistered(a);
    a.line("Proving the withdrawal (sign the authorization in your wallet)");
    await withdrawFromVeil(session, id, BigInt(d.usdc), amount, BigInt(session.address), a);
    return `${units(amount, 6, 6)} USDC sent to your wallet.`;
  });
  if (ok) {
    outValue = "";
    toast("Withdrawn.", "good");
    void refreshAccount();
  }
}

async function loadExits(): Promise<void> {
  const store = S.store;
  if (!store || !S.deployed) return;
  const next = new Map<string, ExitRecord>();
  await Promise.all(
    store.exits
      .filter((e) => e.exitId)
      .map(async (e) => {
        try {
          next.set(e.exitId!, await exitOf(BigInt(e.exitId!)));
        } catch {
          /* leave unknown */
        }
      }),
  );
  exitRecords = next;
  drawExits();
}

/** Called on every account poll while the Deposit tab is open. */
export function pollDeposit(): void {
  void walletBalance();
}

export function pollWithdraw(): void {
  void loadExits();
}

function drawExits(): void {
  const el = document.getElementById("wd-exits");
  if (!el) return;
  const exits = S.store?.exits ?? [];
  const head = `<div class="section-title"><h2>Withdrawals</h2><button class="btn btn-ghost btn-sm" id="wd-recover" ${S.busy ? "disabled" : ""}>Find my withdrawals</button></div>`;
  if (!exits.length) {
    el.innerHTML = `${head}<div class="empty">No withdrawals from this browser yet.</div>`;
  } else {
    el.innerHTML = `${head}<div class="table-wrap"><table>
      <thead><tr><th class="r">Amount</th><th>Status</th><th>Started</th></tr></thead>
      <tbody>${exits
        .map((e) => {
          const rec = e.exitId ? exitRecords.get(e.exitId) : undefined;
          let label = "…";
          let tone = "";
          if (!e.exitId) {
            label = "Sent · use Find my withdrawals";
            tone = "chip-gold";
          } else if (rec?.status === EXIT_REGISTERED) {
            label = "Crossing from Hyperliquid";
            tone = "chip-gold";
          } else if (rec?.status === EXIT_FUNDED) {
            label = "Arrived · being delivered";
            tone = "chip-gold";
          } else if (rec?.status === EXIT_DELIVERED) {
            label = "In your private balance";
            tone = "chip-good";
          }
          const shown = rec && rec.funded ? `${units(rec.funded, 6, 2)} USDC` : `${units(BigInt(e.amount), 8, 2)} USDC`;
          return `<tr>
            <td class="r num">${shown}</td>
            <td><span class="chip ${tone}">${escapeHtml(label)}</span></td>
            <td class="faint">${e.txHash ? `<a href="${txLink(e.txHash)}" target="_blank" rel="noreferrer">${ago(e.createdAt)}</a>` : ago(e.createdAt)}</td>
          </tr>`;
        })
        .join("")}</tbody></table></div>`;
  }
  $("wd-recover").addEventListener("click", () => void recover());
}

/** Rebuilds lost withdrawal records: the vault's exits name the USDC notes
 *  they pay, and the user's own key knows which notes are theirs. */
async function recover(): Promise<void> {
  await run("Find my withdrawals", async (a) => {
    requireDeployed();
    const store = S.store!;
    const id = await ensureIdentity(a);
    const d = deployment().starknet;
    a.line("Checking the notes this key owns");
    const mine = new Set<bigint>((S.notes ?? []).filter((n) => n.token === BigInt(d.usdc)).map((n) => n.noteId));
    if (store.pendingExitNote) mine.add(BigInt(store.pendingExitNote));
    for (const e of store.exits) mine.add(BigInt(e.noteId));
    const found = await exitsFor(mine);
    let added = 0;
    for (const f of found) {
      if (store.exits.some((e) => e.exitId && BigInt(e.exitId) === f.exitId)) continue;
      const unread = store.exits.find((e) => !e.exitId && BigInt(e.noteId) === f.noteId);
      if (unread) {
        store.updateExit((e) => e === unread, { exitId: hex(f.exitId) });
      } else {
        store.addExit({ exitId: hex(f.exitId), noteId: hex(f.noteId), amount: (f.amount * 100n).toString(), createdAt: Date.now() });
      }
      added++;
    }
    void id;
    return added ? `Found ${added} withdrawal${added > 1 ? "s" : ""}.` : "Nothing new found.";
  });
  void loadExits();
}
