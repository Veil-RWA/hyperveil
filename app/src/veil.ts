// The user's side of the Veil pool: viewing key, registration, private
// balances, and every proven action (post / cancel an order, open a note,
// exit). Proofs run on the SNIP-36 prover service; the wallet signs one
// SNIP-12 authorization per derive, and the service's relayer submits the
// settle, so the user's account never sends these transactions itself.

import { Contract, type Abi } from "starknet";
import {
  EMPTY_OPEN_NOTE,
  VIRTUAL_PROGRAM_HASH,
  VeilDvpMaker,
  VeilERC3643Discovery,
  VeilProver,
  computeNoteId,
  computeOrderId,
  deriveChannelKey,
  derivePublicViewingKey,
  deriveViewingKey,
  makeSenderBalanceRulesReader,
  makeVeilERC3643ContractReader,
  planDeposit,
  planExit,
  planFee,
  type InvokePlan,
  type Order,
  type OrderTerms,
  type OwnedNote,
  type SenderBalanceRules,
  type TokenBalance,
} from "veil-sdk";
import { deployment } from "./config";
import { hex } from "./format";
import { rpc, type Session } from "./wallet";

export interface Identity {
  owner: bigint;
  /** Private viewing key: reads the user's notes; spends nothing alone. */
  k: bigint;
  publicKey: bigint;
  selfChannelKey: bigint;
}

/** Where a proven action reports what it is doing. The activity panel
 *  satisfies this as it stands: `line` adds a step, `progress` replaces the
 *  last one, so a prover that reports every few seconds stays one line. */
export interface Progress {
  line(text: string): void;
  progress(text: string): void;
}

// ── Randomness ──────────────────────────────────────────────────────────────

function random(bytes: number): bigint {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b.reduce((v, x) => (v << 8n) | BigInt(x), 0n);
}
/** A random felt (< 2^248). */
export const randomFelt = (): bigint => random(31) || 1n;
/** A note salt: 2 <= salt < 2^120 (0 and 1 are reserved). */
export const randomNoteSalt = (): bigint => (random(15) % ((1n << 120n) - 2n)) + 2n;

// ── Viewing key ─────────────────────────────────────────────────────────────

const vkKey = (address: string) =>
  `hyperveil:vk:${BigInt(deployment().starknet.chainId).toString(16)}:${BigInt(address).toString(16)}`;

function cachedKey(address: string): bigint | null {
  try {
    const raw = localStorage.getItem(vkKey(address));
    return raw ? BigInt(raw) : null;
  } catch {
    return null;
  }
}

export const hasCachedKey = (address: string): boolean => cachedKey(address) !== null;

export function forgetKey(address: string): void {
  try {
    localStorage.removeItem(vkKey(address));
  } catch {
    /* ignore */
  }
}

/** The account's Veil identity. Derived from one wallet signature and kept
 *  on this device, because account signatures need not be deterministic. */
export async function unlock(session: Session): Promise<Identity> {
  let k = cachedKey(session.address);
  let publicKey: bigint;
  if (k === null) {
    const vk = await deriveViewingKey(session.account as never, deployment().starknet.chainId);
    k = vk.privateKey;
    publicKey = vk.publicKey;
    try {
      localStorage.setItem(vkKey(session.address), hex(k));
    } catch {
      /* storage unavailable: re-derived next time */
    }
  } else {
    publicKey = derivePublicViewingKey(k);
  }
  const owner = BigInt(session.address);
  return { owner, k, publicKey, selfChannelKey: deriveChannelKey(owner, k, owner, publicKey) };
}

// ── Pool reads ──────────────────────────────────────────────────────────────

let poolContract: Contract | null = null;

async function pool(): Promise<Contract> {
  if (poolContract) return poolContract;
  const address = deployment().starknet.pool;
  const cls = (await rpc().getClassAt(address)) as { abi: Abi | string };
  const abi = typeof cls.abi === "string" ? (JSON.parse(cls.abi) as Abi) : cls.abi;
  poolContract = new Contract({ abi, address, providerOrAccount: rpc() });
  return poolContract;
}

async function discovery(): Promise<VeilERC3643Discovery> {
  return new VeilERC3643Discovery(makeVeilERC3643ContractReader((await pool()) as never));
}

/** Spendable notes, in the order the pool selects inputs. */
export async function ownedNotes(id: Identity): Promise<OwnedNote[]> {
  return (await discovery()).listOwnedNotes(id.owner, id.k);
}

export function balancesOf(notes: OwnedNote[]): TokenBalance[] {
  const map = new Map<bigint, TokenBalance>();
  for (const n of notes) {
    const b = map.get(n.token) ?? { token: n.token, balance: 0n, noteCount: 0 };
    b.balance += n.amount;
    b.noteCount += 1;
    map.set(n.token, b);
  }
  return [...map.values()];
}

/** The first empty slot of `token` in the self-channel. */
export async function nextNoteIndex(id: Identity, token: bigint): Promise<number> {
  const reader = makeVeilERC3643ContractReader((await pool()) as never);
  for (let i = 0; ; i += 32) {
    const ids = Array.from({ length: 32 }, (_, j) => computeNoteId(id.selfChannelKey, token, i + j));
    const encs = await reader.getNotesBatch(ids);
    const free = encs.findIndex((e) => e === 0n);
    if (free >= 0) return i + free;
  }
}

export async function noteValue(noteId: bigint): Promise<bigint> {
  const reader = makeVeilERC3643ContractReader((await pool()) as never);
  return (await reader.getNotesBatch([noteId]))[0];
}

export const isEmptyOpenNote = (enc: bigint): boolean => enc === EMPTY_OPEN_NOTE;

// ── Proving ─────────────────────────────────────────────────────────────────

function proverConfig(session: Session) {
  const d = deployment();
  return {
    veilAddress: d.starknet.pool,
    endpoint: d.prover.endpoint || undefined,
    transport: d.prover.transport,
    masterAddress: d.prover.masterAddress || undefined,
    rpcUrl: d.starknet.rpc,
    signer: session.account as never,
    chainId: d.starknet.chainId,
  };
}

const prover = (session: Session) => new VeilProver({ ...proverConfig(session), pool: "erc3643" });

/**
 * Turns the prover's events into something worth reading.
 *
 * The service reports its own internals — a job id, then "queued (5s)",
 * "queued (10s)" — which is a line per poll and names infrastructure the user
 * has no business seeing. Only two things here matter to them: that it is
 * proving, and how long it has been. Everything else goes to the console.
 */
function relay(progress?: Progress) {
  return (e: { type: string; phase?: string; programHash?: string; line?: string; message?: string }) => {
    if (e.type === "program_hash") {
      let ok = false;
      try {
        ok = BigInt(e.programHash ?? "0x0") === BigInt(VIRTUAL_PROGRAM_HASH);
      } catch {
        ok = false;
      }
      // Silent when it is the program it should be; loud when it is not.
      if (!ok) {
        progress?.line(`Warning: unexpected proof program ${e.programHash}`);
        console.warn("[hyperveil] unexpected program hash", e.programHash, "expected", VIRTUAL_PROGRAM_HASH);
      }
      return;
    }
    if (e.type === "error" && e.message) {
      progress?.line(`error: ${e.message}`);
      return;
    }
    if (e.type !== "phase" || !e.phase) return;
    console.debug("[hyperveil] prover", e.phase);
    const phase = e.phase.toLowerCase();
    // "submitted job <uuid>" and anything else naming the service: dropped.
    if (/^submitted\b/.test(phase)) return;
    const seconds = phase.match(/\((\d+)s\)/)?.[1];
    const elapsed = seconds ? ` (${seconds}s)` : "";
    if (/^(queued|pending|running|proving)/.test(phase)) progress?.progress(`Proving${elapsed}`);
    else if (/^(submitting|settling)/.test(phase)) progress?.progress(`Submitting${elapsed}`);
  };
}

/** Waits for a settle the prover's relayer submitted; throws if it reverted. */
export async function settled(txHash: string): Promise<string> {
  const r = (await rpc().waitForTransaction(txHash)) as unknown as {
    isSuccess?: () => boolean;
    execution_status?: string;
    revert_reason?: string;
  };
  const reverted = r.isSuccess ? !r.isSuccess() : r.execution_status === "REVERTED";
  if (reverted) throw new Error(`The settle reverted${r.revert_reason ? `: ${r.revert_reason}` : ""}`);
  return txHash;
}

const u256Pair = (v: bigint): string[] => [hex(v & ((1n << 128n) - 1n)), hex(v >> 128n)];

export async function register(session: Session, id: Identity, progress?: Progress): Promise<string> {
  // register_viewing_key_derive(user, k: u256, audit_r, self_channel_r, outgoing_salt)
  const calldata = [hex(id.owner), ...u256Pair(id.k), hex(randomFelt()), hex(randomFelt()), hex(randomFelt())];
  const res = await prover(session).registerViewingKey(calldata, { onEvent: relay(progress) as never });
  return settled(res.txHash);
}

/** Reserves an empty open note of `token` in the self-channel; returns its id. */
export async function createOpenNote(session: Session, id: Identity, token: bigint, progress?: Progress): Promise<bigint> {
  const index = await nextNoteIndex(id, token);
  const noteId = computeNoteId(id.selfChannelKey, token, index);
  // create_open_note_derive(owner, k: u256, token, audit_r, subchannel_salt)
  const calldata = [hex(id.owner), ...u256Pair(id.k), hex(token), hex(randomFelt()), hex(randomFelt())];
  await settled((await prover(session).createOpenNote(calldata, { onEvent: relay(progress) as never })).txHash);
  if (!isEmptyOpenNote(await noteValue(noteId))) throw new Error("The open note is not where it was expected; refresh and retry.");
  return noteId;
}

export interface PostedOrder {
  orderId: bigint;
  order: Order;
  rules: SenderBalanceRules;
  txHash: string;
}

export async function postOrder(
  session: Session,
  id: Identity,
  terms: OrderTerms,
  expiry: bigint,
  progress?: Progress,
): Promise<PostedOrder> {
  const d = deployment();
  const order: Order = {
    maker: id.owner,
    makerSalt: randomFelt(),
    offerToken: terms.offerToken,
    offerAmount: terms.offerAmount,
    wantToken: terms.wantToken,
    wantAmount: terms.wantAmount,
    expiry,
    nonce: randomFelt(),
  };
  const maker = new VeilDvpMaker(proverConfig(session));
  // The rules the post proof hashes; the keeper's opening must match them.
  const rules = await maker.rulesSnapshot(makeSenderBalanceRulesReader((await pool()) as never), order);
  const res = await maker.postOrder(
    {
      maker: id.owner,
      makerPrivateViewingKey: id.k,
      order,
      auditEphemeralSecret: randomFelt(),
      changeNoteSalt: randomNoteSalt(),
      offerSubchannelSalt: randomFelt(),
      receiveSubchannelSalt: randomFelt(),
    },
    { onEvent: relay(progress) as never },
  );
  await settled(res.txHash);
  const orderId = computeOrderId(BigInt(d.starknet.pool), BigInt(d.starknet.chainId), order);
  return { orderId, order, rules, txHash: res.txHash };
}

/** Cancels an order resting in Veil, or reclaims what a closed order left in
 *  escrow, into a private note. */
export async function cancelOrder(
  session: Session,
  id: Identity,
  orderId: bigint,
  makerSalt: bigint,
  progress?: Progress,
): Promise<string> {
  const maker = new VeilDvpMaker(proverConfig(session));
  const res = await maker.cancelOrder(
    { maker: id.owner, makerPrivateViewingKey: id.k, orderId, makerSalt, leftoverNoteSalt: randomNoteSalt() },
    { onEvent: relay(progress) as never },
  );
  return settled(res.txHash);
}

// ── Value in and out of the pool ────────────────────────────────────────────

/** Deposits `amount` of `token` from the connected wallet into a private note
 *  (the wallet must have approved the pool first). */
export async function depositToVeil(
  session: Session,
  id: Identity,
  token: bigint,
  amount: bigint,
  progress?: Progress,
): Promise<string> {
  // deposit_derive(owner, k: u256, token, amount: u128, note_salt: u128, subchannel_salt)
  const calldata = [hex(id.owner), ...u256Pair(id.k), hex(token), hex(amount), hex(randomNoteSalt()), hex(randomFelt())];
  const res = await prover(session).deposit(calldata, { onEvent: relay(progress) as never });
  return settled(res.txHash);
}

/** Withdraws `amount` of `token` from private notes to a public `recipient`. */
export async function withdrawFromVeil(
  session: Session,
  id: Identity,
  token: bigint,
  amount: bigint,
  recipient: bigint,
  progress?: Progress,
): Promise<string> {
  // withdraw_derive(caller, k: u256, token, amount: u128, recipient, audit_r, change_note_salt)
  const calldata = [
    hex(id.owner), ...u256Pair(id.k), hex(token), hex(amount), hex(recipient), hex(randomFelt()),
    hex(randomNoteSalt()),
  ];
  const res = await prover(session).withdraw(calldata, hex(recipient), { onEvent: relay(progress) as never });
  return settled(res.txHash);
}

// ── HyperVeil invokes (fee, deposit to Hyperliquid, exit) ───────────────────

/** The most we will pay Circle to carry `amount6` fast, in USDC units. */
export function cctpMaxFee(amount6: bigint): bigint {
  const bps = BigInt(Math.max(0, Math.round(deployment().cctp.maxFeeBps)));
  if (bps === 0n) return 0n;
  return (amount6 * bps + 9999n) / 10000n;
}

/** Everything a same-token invoke plan needs about the user's notes of
 *  `token`, read fresh. */
async function planInputs(id: Identity, token: bigint) {
  const [notes, firstFreeSlot] = await Promise.all([ownedNotes(id), nextNoteIndex(id, token)]);
  return {
    owner: id.owner,
    ownerPrivateViewingKey: id.k,
    selfChannelKey: id.selfChannelKey,
    notes,
    firstFreeSlot,
    auditEphemeralSecret: randomFelt(),
    changeNoteSalt: randomNoteSalt(),
    subchannelSalt: randomFelt(),
  };
}

async function runInvoke(session: Session, plan: InvokePlan, progress?: Progress): Promise<string> {
  const res = await prover(session).invoke(plan.deriveCalldata, {
    settleExtra: plan.settleExtra,
    onEvent: relay(progress) as never,
  });
  return settled(res.txHash);
}

/** Prepays a LayerZero fee from the user's STRK notes, through the fee
 *  adapter: `FUND_ORDER` (key = order id) or `FUND_NOTE` (key = note id). */
export async function payFee(
  session: Session,
  id: Identity,
  target: 0 | 1,
  key: bigint,
  amount: bigint,
  progress?: Progress,
): Promise<string> {
  const d = deployment().starknet;
  const plan = planFee({
    ...(await planInputs(id, BigInt(d.strk))),
    strk: BigInt(d.strk),
    feeAdapter: BigInt(d.feeAdapter),
    target,
    key,
    amount,
  });
  return runInvoke(session, plan, progress);
}

/** Sends `amountUsdc6` of the user's private USDC to Hyperliquid: the entry
 *  helper burns it through CCTP and the twin lands in `twinNoteId`. */
export async function depositToHyperliquid(
  session: Session,
  id: Identity,
  amountUsdc6: bigint,
  twinNoteId: bigint,
  progress?: Progress,
): Promise<string> {
  const d = deployment();
  const plan = planDeposit({
    ...(await planInputs(id, BigInt(d.starknet.usdc))),
    usdc: BigInt(d.starknet.usdc),
    entryHelper: BigInt(d.starknet.entryHelper),
    amountUsdc6,
    twinNoteId,
    // Circle's cap is absolute, its price is a rate: round the rate up so a
    // transfer is never refused for being a unit short of the quote.
    cctpMaxFee: cctpMaxFee(amountUsdc6),
    minFinality: d.cctp.minFinality,
    returnValue: BigInt(d.fees.returnValue),
  });
  return runInvoke(session, plan, progress);
}

/** Exits `amount` of the USDC twin (8 dp): a proven pool invoke with the
 *  gateway as adapter; the vault later fills `usdcNoteId` with real USDC. */
export async function exit(
  session: Session,
  id: Identity,
  usdcTwin: bigint,
  amount: bigint,
  usdcNoteId: bigint,
  progress?: Progress,
): Promise<string> {
  const d = deployment();
  const plan = planExit({
    ...(await planInputs(id, usdcTwin)),
    usdcTwin,
    gateway: BigInt(d.starknet.gateway),
    amount,
    usdcNoteId,
    returnValue: 0n,
  });
  return runInvoke(session, plan, progress);
}
