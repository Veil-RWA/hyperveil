// The keeper: HyperVeil's off-chain operator, run by the pool's exchange.
//
// Every tick it walks the whole pipeline once. Each step reads the chains,
// does what is due, and records it; a step that fails is retried next tick,
// and every on-chain action is idempotent or guarded, so a crash or a double
// run costs a revert, never value.
//
//  1. scan      new orders, routes, receipts, deposits and exits on both chains
//  2. cross     open Veil orders that cross each other settle inside Veil
//               (proven `execute_batch`); a new order that would cross one
//               already resting on Hyperliquid pulls that one back first
//  3. route     what Veil cannot cross goes to Hyperliquid (`route_order`)
//  4. report    HyperCore fills -> the omnibus (`report`), bounded on-chain
//  5. apply     the gateway's receipts -> makers' notes (proven `venue_fill`)
//  6. release   closed routes -> unspent escrow back to the order
//  7. deposits  CCTP Starknet -> HyperEVM: relay, then credit
//  8. exits     burn on HyperEVM, then CCTP HyperEVM -> Starknet vault,
//               which fills the user's USDC note (retried if it was refused)
//  9. cancel    routed orders past their expiry, or whose maker asked, are
//               cancelled on Hyperliquid

import { getBytes } from "ethers";
import { VeilDvpExchange, type AuthorizationSigner } from "veil-sdk";
import { CCTP_DOMAIN, type IrisApi } from "./iris.js";
import { isClosed, routeTotals, type HlFill } from "./fills.js";
import { hlOrderFor, type SpotPair } from "./hlMath.js";
import { pairFor, pairsFromSpotMeta, type HyperliquidApi } from "./hlApi.js";
import { matchBook, type BookOrder } from "./matcher.js";
import { emptyRelayState, type Relay } from "./relay.js";
import type { CoreDex, HyperEvmSide, ReportItem } from "./hyperevmSide.js";
import type { StarknetSide, OrderRecord } from "./starknetSide.js";
import { key, type DepositState, type KeeperState, type Opening } from "./store.js";

export interface KeeperParams {
  maxFeeBps: number;
  minNotional: bigint;
  /** HYPE (wei) sent with each instruction to pay the omnibus's reply. */
  returnValue: bigint;
  /** How long an order may be unknown to HyperCore after PLACE before it is
   *  treated as rejected (CoreWriter delays orders by a few seconds). */
  unknownGraceMs: number;
  /** Largest number of receipts in one proven venue fill. */
  maxReceiptsPerFill: number;
  /** How many 50-block `eth_getLogs` windows one tick may scan on HyperEVM. */
  maxLogWindows: number;
  /** Largest number of routes in one report. Each item costs the reply
   *  `fillGasPerItem` of Starknet L2 gas, so a huge report cannot be
   *  delivered. */
  maxReportItems: number;
  /** TESTNET ONLY: put anyone who asks the intake on the pool's allowlist. */
  openAllowlist?: boolean;
  /** Where Circle's CoreDepositWallet puts a deposit in the keeper's HyperCore
   *  account on its way to the omnibus. Default perps. */
  coreDex?: CoreDex;
}

const ORDER_OPEN = 0;
/** HyperCore USDC (8 dp) per CCTP USDC unit (6 dp): the omnibus's constant. */
const USDC_CORE_PER_CCTP_UNIT = 100n;
/** The exit vault's EXIT_DELIVERED. */
const EXIT_DELIVERED = 3;
const ROUTE_OPEN = 1;
const ROUTE_CLOSED = 2;
const U128 = (1n << 128n) - 1n;
const b32 = (v: bigint): string => "0x" + v.toString(16).padStart(64, "0");

export class Keeper {
  private pairs = new Map<string, SpotPair>();
  private coreToken = new Map<bigint, bigint>();

  constructor(
    private readonly sn: StarknetSide,
    private readonly evm: HyperEvmSide,
    private readonly hl: HyperliquidApi,
    private readonly iris: IrisApi,
    private readonly exchange: VeilDvpExchange,
    readonly state: KeeperState,
    private readonly params: KeeperParams,
    private readonly log: (msg: string) => void = console.log,
    /** TESTNET ONLY: set when the keeper carries the messages itself because
     *  LayerZero has no pathway (see relay.ts). Undefined on mainnet. */
    private readonly relay?: Relay,
  ) {}

  static exchangeFor(
    sn: StarknetSide,
    proverEndpoint: string | undefined,
    rpcUrl: string,
    masterAddress?: string,
  ): VeilDvpExchange {
    const account = sn.account;
    const signer: AuthorizationSigner = {
      address: account.address,
      // The SDK's typed data is starknet.js's; the account signs it as-is.
      signMessage: (td) => account.signMessage(td as never) as never,
      getChainId: async () => String(await sn.provider.getChainId()),
    };
    return new VeilDvpExchange({ veilAddress: sn.pool, signer, endpoint: proverEndpoint, rpcUrl, masterAddress });
  }

  acceptOpening(opening: Opening): void {
    this.state.openings[key(opening.orderId)] = opening;
  }

  /** A maker asks to pull its order back from Hyperliquid. Only the maker
   *  (and the keeper) knows the salt behind the order's commitment. */
  requestCancel(orderId: bigint, makerSalt: bigint): string | null {
    const opening = this.state.openings[key(orderId)];
    if (!opening) return "unknown order";
    if (opening.makerSalt !== makerSalt) return "not the maker";
    opening.cancelRequested = true;
    return null;
  }

  async tick(): Promise<void> {
    const steps: Array<[string, () => Promise<void>]> = [
      // Before anything else: a tester waiting to be let in should not sit
      // behind a log scan or a proof.
      ...(this.params.openAllowlist
        ? ([["allowlist", () => this.grantAllowlist()]] as Array<[string, () => Promise<void>]>)
        : []),
      // First, so an instruction reaches the other chain before the steps that
      // wait on its answer.
      ...(this.relay ? ([["relay", () => this.carryMessages()]] as Array<[string, () => Promise<void>]>) : []),
      ["scan", () => this.scan()],
      ["cross+route", () => this.crossAndRoute()],
      ["report", () => this.reportFills()],
      ["apply", () => this.applyReceipts()],
      ["release", () => this.releaseClosed()],
      ["deposits", () => this.relayDeposits()],
      ["exits", () => this.relayExits()],
      ["cancel", () => this.cancelExpired()],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (e) {
        this.log(`[${name}] ${(e as Error).message}`);
      }
    }
  }

  /**
   * TESTNET ONLY: puts everyone the intake recorded on the pool's allowlist.
   *
   * The intake only writes the request down; this sends the transaction,
   * because the keeper's Starknet account must have exactly one writer (the
   * tick holds the lock — two senders would collide on nonces). Everyone
   * waiting goes in ONE transaction.
   */
  private async grantAllowlist(): Promise<void> {
    const waiting = Object.entries(this.state.allowlist).filter(([, r]) => !r.done);
    if (!waiting.length) return;
    const todo: string[] = [];
    for (const [address, request] of waiting) {
      try {
        // Someone already on the list (the deployer, a second request) costs
        // one read and no transaction.
        if (await this.sn.isWhitelisted(address)) {
          request.done = true;
          continue;
        }
        todo.push(address);
      } catch (e) {
        request.error = (e as Error).message;
      }
    }
    if (!todo.length) return;
    try {
      const tx = await this.sn.whitelist(todo);
      for (const address of todo) {
        this.state.allowlist[address].done = true;
        delete this.state.allowlist[address].error;
      }
      this.log(`allowlisted ${todo.length} account${todo.length === 1 ? "" : "s"} (${tx})`);
    } catch (e) {
      // Left pending: the next tick tries again.
      for (const address of todo) this.state.allowlist[address].error = (e as Error).message;
      throw e;
    }
  }

  /** TESTNET ONLY: records an address to be allowlisted on the next tick. */
  requestAllowlist(address: bigint): void {
    const id = key(address);
    this.state.allowlist[id] ??= { requestedAt: Date.now() };
  }

  /** TESTNET ONLY: carries what each chain emitted to the other. */
  private async carryMessages(): Promise<void> {
    if (!this.relay) return;
    this.state.relay ??= emptyRelayState(this.state.snBlock, this.state.evmBlock);
    await this.relay.carry(this.state.relay);
  }

  // ── 1. scan ───────────────────────────────────────────────────────────────

  async scan(): Promise<void> {
    const snTo = await this.sn.blockNumber();
    const from = this.state.snBlock;
    if (snTo > from) {
      for (const e of await this.sn.events(this.sn.pool, "OrderPosted", from, snTo)) {
        this.state.orders[key(e.keys[1])] ??= { postedAt: e.block };
      }
      for (const e of await this.sn.events(this.sn.gateway, "OrderRouted", from, snTo)) {
        const [, orderId, routeId] = e.keys;
        if (!this.state.routes[key(routeId)]) await this.trackRoute(orderId, routeId);
      }
      for (const e of await this.sn.events(this.sn.gateway, "ReceiptCreated", from, snTo)) {
        const [, receiptId, routeId] = e.keys;
        const route = this.state.routes[key(routeId)];
        this.state.receipts[key(receiptId)] ??= { orderId: route?.orderId ?? 0n, applied: false };
      }
      for (const e of await this.sn.events(this.sn.entryHelper, "DepositBurned", from, snTo)) {
        this.state.deposits[key(e.keys[1])] ??= { burnTx: e.txHash, stage: "burned" };
      }
      this.state.snBlock = snTo;
    }
    const evmTo = await this.evm.blockNumber();
    if (evmTo > this.state.evmBlock) {
      // Bounded: HyperEVM makes a block a second and its public RPC serves 50
      // blocks a query, so a long gap is caught up over several ticks.
      const { events, scannedTo } = await this.evm.events(
        "ExitRequested", this.state.evmBlock, evmTo, this.params.maxLogWindows,
      );
      for (const e of events) {
        this.state.exits[key(BigInt(e.args.exitId as string))] ??= { stage: "requested" };
      }
      this.state.evmBlock = scannedTo;
    }
  }

  private async trackRoute(orderId: bigint, routeId: bigint): Promise<void> {
    const order = await this.sn.getOrder(orderId);
    const offer = await this.core(order.offerToken);
    const want = await this.core(order.wantToken);
    const pair = await this.pair(offer, want);
    this.state.routes[key(routeId)] = {
      orderId,
      cloid: (routeId & U128) === 0n ? 1n : routeId & U128,
      isBuy: pair ? pair.base.index === want : true,
      base: pair?.base.index ?? want,
      quote: pair?.quote.index ?? offer,
      placedAt: Date.now(),
      reported: { cumDraw: 0n, cumDeliver: 0n },
      closedReported: false,
    };
  }

  private async core(twin: bigint): Promise<bigint> {
    let c = this.coreToken.get(twin);
    if (c === undefined) {
      c = await this.sn.coreTokenOf(twin);
      this.coreToken.set(twin, c);
    }
    return c;
  }

  private async pair(a: bigint, b: bigint): Promise<SpotPair | undefined> {
    if (this.pairs.size === 0) this.pairs = pairsFromSpotMeta(await this.hl.spotMeta());
    return pairFor(this.pairs, a, b);
  }

  // ── 2 + 3. cross inside Veil, route the rest ─────────────────────────────

  async crossAndRoute(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const live: Array<{ id: bigint; order: OrderRecord; routed: boolean; opening?: Opening }> = [];
    for (const id of Object.keys(this.state.orders)) {
      const orderId = BigInt(id);
      const order = await this.sn.getOrder(orderId);
      if (order.status !== ORDER_OPEN || order.expiry < now) continue;
      const routed = await this.sn.isRouted(orderId);
      if (!routed && order.escrowRemaining === 0n) continue;
      live.push({ id: orderId, order, routed, opening: this.state.openings[id] });
    }

    const toBook = (x: (typeof live)[number], core: [bigint, bigint]): BookOrder => ({
      orderId: x.id,
      offerToken: core[0],
      wantToken: core[1],
      offerAmount: x.order.offerAmount,
      wantAmount: x.order.wantAmount,
      // A routed order's escrow is out at the venue (0 in the pool); for
      // spotting a cross with it, its full size is the right bound.
      escrow: x.routed ? x.order.offerAmount : x.order.escrowRemaining,
      received: x.order.received,
      postedAt: this.state.orders[key(x.id)]?.postedAt ?? 0,
    });

    const unrouted: BookOrder[] = [];
    const resting: BookOrder[] = [];
    for (const x of live) {
      if (!x.opening) continue; // cannot prove anything for it yet
      const core: [bigint, bigint] = [await this.core(x.order.offerToken), await this.core(x.order.wantToken)];
      (x.routed ? resting : unrouted).push(toBook(x, core));
    }

    // A new order that would cross one resting on Hyperliquid must meet it
    // inside Veil: on HyperCore both sit on the omnibus's one account, where
    // self-trade prevention would cancel the resting one instead of filling.
    const held = new Set<bigint>();
    for (const r of resting) {
      for (const cross of matchBook([r, ...unrouted.filter((u) => u.postedAt >= r.postedAt)])) {
        if (cross.older !== r.orderId) continue;
        held.add(cross.newer);
        const route = await this.sn.routeOf(await this.sn.currentRoute(r.orderId));
        if (route.status === ROUTE_OPEN && !route.cancelRequested) {
          await this.sn.cancelRoute(r.orderId, this.params.returnValue);
          this.log(`pulled ${key(r.orderId)} back from Hyperliquid to cross ${key(cross.newer)} in Veil`);
        }
      }
    }

    const candidates = unrouted.filter((o) => !held.has(o.orderId));
    const crosses = matchBook(candidates);
    const crossed = new Set<bigint>();
    if (crosses.length > 0) {
      const orderIds: bigint[] = [];
      const fills: Array<{ deliver: bigint; draw: bigint }> = [];
      const makers = [];
      for (const c of crosses) {
        for (const [id, fill] of [[c.older, c.olderFill], [c.newer, c.newerFill]] as const) {
          const o = this.state.openings[key(id)];
          orderIds.push(id);
          fills.push(fill);
          makers.push({ maker: o.maker, makerSalt: o.makerSalt, makerRules: o.makerRules });
          crossed.add(id);
        }
      }
      const batchNonce = BigInt(Date.now());
      const res = await this.exchange.executeBatch({ orderIds, fills, batchNonce, makers });
      this.log(`crossed ${crosses.length} pair(s) inside Veil: ${res.txHash}`);
    }

    for (const o of candidates) {
      if (crossed.has(o.orderId)) continue;
      const pair = await this.pair(o.offerToken, o.wantToken);
      if (!pair) continue; // not a Hyperliquid spot pair: it waits for a Veil counterparty
      const tif = this.state.openings[key(o.orderId)].tif;
      const decision = hlOrderFor(
        { offerToken: o.offerToken, wantToken: o.wantToken, offerAmount: o.offerAmount, wantAmount: o.wantAmount, escrow: o.escrow },
        pair,
        this.params.maxFeeBps,
        tif,
        this.params.minNotional,
      );
      if (!decision.ok) {
        this.log(`not routing ${key(o.orderId)}: ${decision.reason}`);
        continue;
      }
      // The user pays: an order is routed only once its own prepaid credit
      // (funded from STRK held in the pool, through the fee adapter) covers
      // the message.
      const fee = await this.sn.quoteRoute(o.orderId, decision.order, this.params.returnValue);
      if ((await this.sn.orderCredit(o.orderId)) < fee) {
        this.log(`not routing ${key(o.orderId)}: routing fee not prepaid`);
        continue;
      }
      const tx = await this.sn.routeOrder(o.orderId, decision.order, this.params.returnValue);
      const routeId = await this.sn.currentRoute(o.orderId);
      await this.trackRoute(o.orderId, routeId);
      this.log(`routed ${key(o.orderId)} as ${key(routeId)}: ${tx}`);
    }
  }

  // ── 4. report HyperCore fills ─────────────────────────────────────────────

  async reportFills(): Promise<void> {
    const open = Object.entries(this.state.routes).filter(([, r]) => !r.closedReported);
    if (open.length === 0) return;
    const user = this.evm.omnibusAddress;
    const since = Math.min(...open.map(([, r]) => r.placedAt)) - 60_000;
    let fills: HlFill[] | null = null;
    const items: ReportItem[] = [];
    const updates: Array<() => void> = [];

    for (const [routeKey, r] of open) {
      const routeId = b32(BigInt(routeKey));
      const status = await this.evm.routeStatus(routeId);
      if (status === 0n) continue; // PLACE not delivered yet
      if (status !== BigInt(ROUTE_OPEN)) {
        // Rejected (or already closed): the omnibus answered on its own.
        r.closedReported = true;
        continue;
      }
      const hlStatus = await this.hl.orderStatus(user, r.cloid);
      const pair = await this.pair(r.base, r.quote);
      if (!pair) continue;
      let totals = { cumDraw: 0n, cumDeliver: 0n };
      let closed: boolean;
      if (hlStatus.oid === undefined) {
        // Never rested: HyperCore dropped the CoreWriter order (the EVM is
        // not told). Past the grace period, close with nothing spent.
        closed = Date.now() - r.placedAt > this.params.unknownGraceMs;
        if (!closed) continue;
      } else {
        fills ??= await this.hl.fillsSince(user, since);
        totals = routeTotals(fills, hlStatus.oid, r.isBuy, pair);
        closed = isClosed(hlStatus.status);
      }
      const moved = totals.cumDeliver !== r.reported.cumDeliver || totals.cumDraw !== r.reported.cumDraw;
      if (!moved && !closed) continue;
      items.push({ routeId, cumDraw: totals.cumDraw, cumDeliver: totals.cumDeliver, closed });
      updates.push(() => {
        r.reported = totals;
        r.closedReported = closed;
      });
      // The rest wait for the next tick: one FILL carries them all, and its
      // delivery gas grows with the count.
      if (items.length === this.params.maxReportItems) break;
    }
    if (items.length === 0) return;
    const tx = await this.evm.report(items);
    for (const u of updates) u();
    this.log(`reported ${items.length} route(s): ${tx}`);
  }

  // ── 5. apply receipts to makers ───────────────────────────────────────────

  async applyReceipts(): Promise<void> {
    const pending: bigint[] = [];
    for (const [id, r] of Object.entries(this.state.receipts)) {
      if (r.applied) continue;
      if (!(await this.sn.receiptPending(BigInt(id)))) {
        r.applied = true;
        continue;
      }
      if (this.state.openings[key(r.orderId)]) pending.push(BigInt(id));
      if (pending.length === this.params.maxReceiptsPerFill) break;
    }
    if (pending.length === 0) return;
    const makers = pending.map((id) => {
      const o = this.state.openings[key(this.state.receipts[key(id)].orderId)];
      return { maker: o.maker, makerSalt: o.makerSalt, makerRules: o.makerRules };
    });
    const res = await this.exchange.venueFill({ receiptIds: pending, makers });
    for (const id of pending) this.state.receipts[key(id)].applied = true;
    this.log(`applied ${pending.length} receipt(s): ${res.txHash}`);
  }

  // ── 6. release closed routes ──────────────────────────────────────────────

  async releaseClosed(): Promise<void> {
    for (const [routeKey, r] of Object.entries(this.state.routes)) {
      if (!r.closedReported) continue;
      const route = await this.sn.routeOf(BigInt(routeKey));
      if (route.status !== ROUTE_CLOSED || route.pendingReceipts !== 0) continue;
      const tx = await this.sn.release(r.orderId);
      this.log(`released ${key(r.orderId)}: ${tx}`);
    }
  }

  // ── 7. deposits ───────────────────────────────────────────────────────────

  // A deposit's way in: Circle mints the USDC to the keeper on HyperEVM (the
  // omnibus relays the message and records the amount), the keeper moves it
  // into its own HyperCore account and spot-sends it to the omnibus's, and the
  // omnibus credits the twin once HyperCore holds it (it checks, not trusts).
  async relayDeposits(): Promise<void> {
    const deposits = Object.entries(this.state.deposits);
    // One deposit crosses into HyperCore at a time: its arrival is read as the
    // keeper's HyperCore balance growing by its amount, so two at once would
    // blur. `busy` also holds for the rest of a tick in which one landed, so
    // the next one's baseline is read a tick later, after the spot send.
    let busy = deposits.some(([, d]) => d.stage === "bridging");
    for (const [id, d] of deposits) {
      // Each deposit on its own: one that cannot move yet must not hold back
      // the ones behind it.
      try {
        if (d.stage === "relayed" && busy) continue;
        if (d.stage === "relayed" || d.stage === "bridging") busy = true;
        await this.relayDeposit(id, d);
      } catch (e) {
        this.log(`[deposits] ${id}: ${(e as Error).message}`);
      }
    }
  }

  private async relayDeposit(id: string, d: DepositState): Promise<void> {
    const dex = this.params.coreDex ?? "perps";
    const keeperOnCore = this.evm.wallet.address;
    if (d.stage === "burned") {
      const att = await this.iris.attestation(CCTP_DOMAIN.starknet, d.burnTx);
      if (!att) return;
      await this.evm.receiveDeposit(att.message, att.attestation);
      d.amount6 = String(await this.evm.depositArrived(b32(BigInt(id))));
      d.stage = "relayed";
      this.log(`relayed deposit ${id}: ${d.amount6} USDC (6 dp) minted to the keeper`);
    } else if (d.stage === "relayed") {
      const amount6 = BigInt(d.amount6 ?? (await this.evm.depositArrived(b32(BigInt(id)))));
      d.amount6 = String(amount6);
      d.baseline8 = String(await this.coreUsdc8(keeperOnCore, dex));
      const tx = await this.evm.toCore(amount6, dex);
      d.stage = "bridging";
      this.log(`deposit ${id} into the keeper's HyperCore ${dex}: ${tx}`);
    } else if (d.stage === "bridging") {
      const amount8 = BigInt(d.amount6!) * USDC_CORE_PER_CCTP_UNIT;
      if ((await this.coreUsdc8(keeperOnCore, dex)) < BigInt(d.baseline8!) + amount8) return;
      if (dex === "perps") await this.hl.usdClassTransfer(amount8, false);
      await this.hl.spotSendUsdc(this.evm.omnibusAddress, amount8);
      d.stage = "sent";
      this.log(`spot-sent deposit ${id} to the omnibus`);
    } else if (d.stage === "sent") {
      await this.evm.creditDeposit(b32(BigInt(id)));
      d.stage = "credited";
      this.log(`credited deposit ${id}`);
    }
  }

  private coreUsdc8(user: string, dex: CoreDex): Promise<bigint> {
    return dex === "perps" ? this.hl.usdcPerps8(user) : this.hl.usdcSpot8(user);
  }

  // ── 8. exits ──────────────────────────────────────────────────────────────

  async relayExits(): Promise<void> {
    for (const [id, x] of Object.entries(this.state.exits)) {
      try {
        await this.relayExit(id, x);
      } catch (e) {
        this.log(`[exits] ${id}: ${(e as Error).message}`);
      }
    }
  }

  /** One exit, one step forward. Each exit on its own, like deposits. */
  private async relayExit(id: string, x: KeeperState["exits"][string]): Promise<void> {
    if (x.stage === "requested") {
      // Reverts (ExitNotReady) until HyperCore has paid the USDC out to the EVM.
      x.burnTx = await this.evm.burnExit(b32(BigInt(id)));
      x.stage = "burned";
      this.log(`burned exit ${id}`);
    } else if (x.stage === "burned" && x.burnTx) {
      const att = await this.iris.attestation(CCTP_DOMAIN.hyperevm, x.burnTx);
      if (!att) return;
      await this.sn.receiveExit(getBytes(att.message), getBytes(att.attestation));
      x.stage = (await this.sn.exitStatus(BigInt(id))) === EXIT_DELIVERED ? "delivered" : "funded";
      this.log(`${x.stage} exit ${id}`);
    } else if (x.stage === "funded") {
      // The vault holds the USDC: the pool refused the fill (paused, or the
      // vault is not an adapter yet). Anyone may deliver it later.
      if ((await this.sn.exitStatus(BigInt(id))) === EXIT_DELIVERED) {
        x.stage = "delivered";
        return;
      }
      await this.sn.retryDelivery(BigInt(id));
      x.stage = "delivered";
      this.log(`delivered exit ${id}`);
    }
  }

  // ── 9. expired routed orders ──────────────────────────────────────────────

  async cancelExpired(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const [routeKey, r] of Object.entries(this.state.routes)) {
      if (r.closedReported) continue;
      const order = await this.sn.getOrder(r.orderId);
      const asked = this.state.openings[key(r.orderId)]?.cancelRequested === true;
      if (order.expiry >= now && !asked) continue;
      const route = await this.sn.routeOf(BigInt(routeKey));
      if (route.status !== ROUTE_OPEN || route.cancelRequested) continue;
      await this.sn.cancelRoute(r.orderId, this.params.returnValue);
      this.log(`cancelled ${key(r.orderId)} on Hyperliquid (${asked ? "maker asked" : "expired"})`);
    }
  }
}
