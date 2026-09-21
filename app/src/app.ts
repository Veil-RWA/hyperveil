// Shared state and the plumbing every view uses: the connected session, the
// user's Veil identity, account reads, the activity panel and toasts, and the
// keeper's intake.

import { INVOKE_CHANGE, type OwnedNote } from "veil-sdk";
import { isWhitelisted, registeredViewingKey } from "./chain";
import { deployment, explorer, isDeployed } from "./config";
import { escapeHtml, units } from "./format";
import type { Book, HyperliquidInfo, Market, Trade } from "./market";
import { AccountStore, type StoredOrder } from "./store";
import { strk20Balances } from "./strk20";
import { forgetKey, hasCachedKey, ownedNotes, register, unlock, type Identity } from "./veil";
import { connectWallet, disconnectWallet, type Session } from "./wallet";

export type Tab = "trade" | "portfolio" | "deposit" | "withdraw";

export interface AppState {
  tab: Tab;
  deployed: boolean;
  info: HyperliquidInfo | null;
  markets: Market[];
  coin: string | null;
  book: Book | null;
  trades: Trade[];
  /** When the book and trades were last fetched, so the page can show that it
   *  is live even when a quiet market returns the same numbers. */
  marketAt: number | null;
  session: Session | null;
  store: AccountStore | null;
  identity: Identity | null;
  /** KYC approval; undefined until read (or when the read failed). */
  kyc: boolean | undefined;
  /** TESTNET: the keeper was asked to put this account on the allowlist and
   *  has not done it yet. */
  allowlisting: boolean;
  /** The public viewing key the pool holds for the account (0 = none). */
  registeredKey: bigint | undefined;
  notes: OwnedNote[] | null;
  /** Private STRK20 balances (token -> amount), when the wallet answered. */
  strk20: Map<bigint, bigint> | null;
  busy: boolean;
}

export const S: AppState = {
  tab: "trade",
  deployed: false,
  info: null,
  markets: [],
  coin: null,
  book: null,
  trades: [],
  marketAt: null,
  session: null,
  store: null,
  identity: null,
  kyc: undefined,
  allowlisting: false,
  registeredKey: undefined,
  notes: null,
  strk20: null,
  busy: false,
};

let rerender: () => void = () => {};
export const onRerender = (fn: () => void): void => {
  rerender = fn;
};
export const refresh = (): void => rerender();

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// ── Messages ────────────────────────────────────────────────────────────────

let toastTimer: number | undefined;
export function toast(message: string, kind: "good" | "bad" | "info" = "info"): void {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast ${kind === "info" ? "" : kind}`;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), kind === "bad" ? 9000 : 5000);
}

/** The reason in a Starknet / wallet error, without the stack of wrappers. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // The full text goes to the console; the panel gets one readable line.
  console.error("[hyperveil]", e);
  const short = raw.match(/'([A-Z0-9_]{4,})'/)?.[1] ?? raw.match(/Failure reason: [^(]*\('([^']+)'/)?.[1];
  if (short) return short;
  if (/user (rejected|abort|denied)|rejected by user|cancell?ed/i.test(raw)) return "Cancelled in the wallet.";
  // A node that dropped the call dumps the whole request back at us, and the
  // prover's failures name its own host. Neither is the user's problem.
  if (/starknet_call|starknet_[a-zA-Z]+ with params|\{\s*"request"/.test(raw)) {
    return "The Starknet node did not answer. Try again in a moment.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(raw)) return "Could not reach the service. Try again in a moment.";
  const clean = raw.replace(/https?:\/\/\S+/g, "the service");
  return clean.length > 200 ? clean.slice(0, 200) + "…" : clean;
}

export interface Activity {
  line(text: string): void;
  /** A line that REPLACES the last progress line instead of adding one, so a
   *  step that reports every few seconds stays one line. */
  progress(text: string): void;
  done(message?: string): void;
  fail(e: unknown): void;
}

/** The activity panel: one running action, its steps as they happen. */
export function activity(title: string): Activity {
  const el = $("activity");
  const lines: string[] = [];
  let progressAt = -1;
  let state: "run" | "ok" | "bad" = "run";
  const draw = () => {
    const icon = state === "run" ? `<span class="spinner"></span>` : state === "ok" ? `<span class="buy">✓</span>` : `<span class="sell">✕</span>`;
    el.innerHTML = `
      <div class="title"><span style="display:flex;gap:.6rem;align-items:center">${icon}${escapeHtml(title)}</span>
        ${state === "run" ? "" : `<button class="btn btn-ghost btn-sm" id="activity-close">Close</button>`}</div>
      <ol>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ol>`;
    el.hidden = false;
    $("activity-close")?.addEventListener("click", () => (el.hidden = true));
    const ol = el.querySelector("ol");
    if (ol) ol.scrollTop = ol.scrollHeight;
  };
  draw();
  return {
    line(text) {
      if (lines[lines.length - 1] !== text) lines.push(text);
      progressAt = -1;
      draw();
    },
    progress(text) {
      if (progressAt >= 0) lines[progressAt] = text;
      else progressAt = lines.push(text) - 1;
      draw();
    },
    done(message) {
      state = "ok";
      if (message) lines.push(message);
      draw();
    },
    fail(e) {
      state = "bad";
      lines.push(errorText(e));
      draw();
    },
  };
}

/** Runs one user action at a time, reporting into the activity panel. */
export async function run(title: string, fn: (a: Activity) => Promise<string | void>): Promise<boolean> {
  if (S.busy) {
    toast("Another action is still running.");
    return false;
  }
  S.busy = true;
  refresh();
  const a = activity(title);
  try {
    const message = await fn(a);
    a.done(message ?? "Done");
    return true;
  } catch (e) {
    console.error(e);
    a.fail(e);
    return false;
  } finally {
    S.busy = false;
    refresh();
  }
}

// ── Session ─────────────────────────────────────────────────────────────────

async function attach(session: Session, prompt: boolean): Promise<void> {
  S.session = session;
  S.store = new AccountStore(deployment().starknet.chainId, session.address, deployment().starknet.pool);
  S.identity = null;
  S.notes = null;
  S.strk20 = null;
  S.kyc = undefined;
  S.allowlisting = false;
  S.registeredKey = undefined;
  // The signature IS what connecting produces here: it derives the Veil key,
  // and that key is what says where this account's notes are. Behind a button
  // it meant connecting a wallet and still seeing nothing, with nothing saying
  // the app was waiting on a signature — veilx and the bridge frontend made
  // this same change for the same reason. A key already on this device needs
  // no prompt, and a declined signature just leaves the Unlock button in place.
  if (hasCachedKey(session.address)) S.identity = await unlock(session);
  else if (prompt) {
    try {
      S.identity = await unlock(session);
    } catch (e) {
      toast(errorText(e), "bad");
    }
  }
  refresh();
  void refreshAccount();
}

export async function connect(): Promise<void> {
  try {
    await attach(await connectWallet(), true);
  } catch (e) {
    toast(errorText(e), "bad");
  }
}

/** A wallet this browser already authorised, re-attached on load. It must not
 *  prompt: the user did not just ask for anything. */
export async function restore(session: Session): Promise<void> {
  await attach(session, false);
}

export async function disconnect(): Promise<void> {
  if (S.session) forgetKey(S.session.address);
  await disconnectWallet();
  Object.assign(S, { session: null, store: null, identity: null, notes: null, strk20: null, kyc: undefined, allowlisting: false, registeredKey: undefined });
  refresh();
}

/**
 * TESTNET: ask the keeper to put this account on the pool's allowlist.
 *
 * On this deployment the allowlist is a formality — there is no KYC provider
 * yet, and the keeper's account is the permission manager's whitelister, so it
 * lets in anyone who asks (`HV_OPEN_ALLOWLIST`). It only records the request:
 * the transaction goes out on the keeper's next tick, so this polls the chain
 * afterwards rather than believing the answer.
 *
 * On mainnet the keeper refuses (404) and nothing here happens.
 */
async function joinAllowlist(address: string): Promise<void> {
  const intake = deployment().keeper.intake?.replace(/\/$/, "");
  if (!intake || S.allowlisting) return;
  S.allowlisting = true;
  refresh();
  try {
    const res = await fetch(`${intake}/allowlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    });
    if (!res.ok) return; // 404 = the open allowlist is off. Nothing to say.
    for (let i = 0; i < 40 && S.session?.address === address; i++) {
      await new Promise((r) => window.setTimeout(r, 3000));
      if (await isWhitelisted(address)) {
        S.kyc = true;
        toast("This account can now hold HyperVeil assets.", "good");
        return;
      }
    }
  } catch (e) {
    console.warn("allowlist request failed", e);
  } finally {
    S.allowlisting = false;
    refresh();
  }
}

/** Re-reads everything about the account the views show. */
export async function refreshAccount(): Promise<void> {
  const session = S.session;
  if (!session || !S.deployed) return;
  const d = deployment().starknet;
  const [kyc, key] = await Promise.all([
    isWhitelisted(session.address),
    registeredViewingKey(session.address).catch(() => undefined),
  ]);
  S.kyc = kyc;
  if (kyc === false) void joinAllowlist(session.address);
  S.registeredKey = key;
  refresh();
  if (S.identity) {
    try {
      S.notes = await ownedNotes(S.identity);
    } catch (e) {
      console.warn("note discovery failed", e);
    }
  }
  try {
    S.strk20 = await strk20Balances(session, [d.usdc, d.strk]);
  } catch (e) {
    // Wallets without STRK20 support answer with an error: leave unknown.
    console.warn("strk20 balances unavailable", e);
    S.strk20 = null;
  }
  refresh();
}

export function requireSession(): Session {
  if (!S.session) throw new Error("Connect a Starknet wallet first.");
  return S.session;
}

export function requireDeployed(): void {
  if (!S.deployed || !isDeployed()) throw new Error("HyperVeil is not deployed on this network yet.");
}

export function requireKyc(): void {
  if (S.kyc === false) throw new Error("This account is not approved to hold HyperVeil assets yet.");
}

/** The user's Veil identity; asks the wallet for the one signature that
 *  derives it if this device has not kept it. */
export async function ensureIdentity(a?: Activity): Promise<Identity> {
  const session = requireSession();
  if (!S.identity) {
    a?.line("Sign the Veil key message in your wallet");
    S.identity = await unlock(session);
  }
  return S.identity;
}

/** Identity, registered in the pool (registering it first if needed). */
export async function ensureRegistered(a: Activity): Promise<Identity> {
  const session = requireSession();
  const id = await ensureIdentity(a);
  const key = await registeredViewingKey(session.address);
  if (key === 0n) {
    a.line("Registering your Veil key (one time)");
    await register(session, id, a);
    S.registeredKey = id.publicKey;
  } else if (key !== id.publicKey) {
    throw new Error("This account is registered in Veil with a key this app did not derive. Use the app it was registered with.");
  }
  return id;
}

/** Spendable private balance of `token` (twin units). */
export function privateBalance(token: bigint): bigint | undefined {
  if (!S.notes) return undefined;
  return S.notes.filter((n) => n.token === token).reduce((t, n) => t + n.amount, 0n);
}

/**
 * Refuses a prepayment the account cannot make, with a message that says where
 * to get the STRK. Messages are paid from private STRK, so an account with a
 * full USDC balance and no STRK can otherwise get all the way to the last step
 * and be told "insufficient balance" by the note selector.
 */
export function requireFeeBalance(need: bigint): void {
  if (need <= 0n) return;
  const held = privateBalance(BigInt(deployment().starknet.strk));
  if (held === undefined || held >= need + INVOKE_CHANGE) return;
  throw new Error(
    `This message costs ${units(need, 18, 6)} STRK and you hold ${units(held, 18, 6)} in Veil. ` +
      `Add some under "Add to your Veil balance", on the STRK (fees) tab.`,
  );
}

// ── Keeper intake ───────────────────────────────────────────────────────────

async function intake(path: string, body: unknown): Promise<void> {
  const base = deployment().keeper.intake.replace(/\/$/, "");
  if (!base) throw new Error("No keeper is configured for this deployment.");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const reason = await res.json().then((j: { error?: string }) => j.error).catch(() => undefined);
    throw new Error(`Keeper: ${reason ?? `HTTP ${res.status}`}`);
  }
}

/** Hands the keeper the order's opening: who the maker is behind the
 *  commitment, and how Hyperliquid should run the remainder. */
export async function sendOpening(o: StoredOrder): Promise<void> {
  await intake("/openings", {
    orderId: o.orderId,
    maker: o.order.maker,
    makerSalt: o.order.makerSalt,
    makerRules: o.makerRules,
    tif: o.tif,
  });
}

/** Asks the keeper to pull a routed order back from Hyperliquid. */
export async function sendCancel(o: StoredOrder): Promise<void> {
  await intake("/cancel", { orderId: o.orderId, makerSalt: o.order.makerSalt });
}

/** STRK for a LayerZero quote plus the configured headroom (always > 0,
 *  so a fee's change note is never empty). */
export function withHeadroom(quote: bigint): bigint {
  // Nothing to pay is nothing to pay. On testnet the relay endpoint quotes
  // zero, and rounding that up to 1 wei made the app demand a STRK prepayment
  // for a message that costs nothing.
  if (quote <= 0n) return 0n;
  const pct = BigInt(Math.max(1, Math.round(deployment().fees.headroomPct)));
  return quote + (quote * pct) / 100n + 1n;
}

export const txLink = (tx: string): string => `${explorer()}/tx/${tx}`;
