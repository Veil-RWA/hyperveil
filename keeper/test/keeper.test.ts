// The keeper's pipeline against in-memory stand-ins for both chains,
// Hyperliquid and Circle. What is checked is the orchestration: which actions
// it takes, in which order, with which arguments — not the contracts (their
// own suites cover them).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NEUTRAL_RULES, computeMakerCommitment, hashRules } from "veil-sdk";
import { checkOpening } from "../src/intake.js";
import { Keeper, type KeeperParams } from "../src/keeper.js";
import { byteArrayCalldata, type OrderRecord } from "../src/starknetSide.js";
import { emptyState, key, type Opening } from "../src/store.js";

const USDC_TWIN = 0xa0n;
const HYPE_TWIN = 0xa1n;
const CORE = new Map([[USDC_TWIN, 0n], [HYPE_TWIN, 150n]]);
const PARAMS: KeeperParams = {
  maxFeeBps: 10, minNotional: 1_000_000_000n, returnValue: 5n, unknownGraceMs: 60_000,
  maxReceiptsPerFill: 16, maxReportItems: 8, maxLogWindows: 20,
};
const FAR = Math.floor(Date.now() / 1000) + 86_400;

function order(over: Partial<OrderRecord>): OrderRecord {
  return {
    makerCommitment: 1n, offerToken: USDC_TWIN, wantToken: HYPE_TWIN, offerAmount: 100_000_000_000n,
    wantAmount: 4_000_000_000n, escrowRemaining: 100_000_000_000n, received: 0n, receiveNoteId: 9n,
    expiry: FAR, status: 0, makerRulesHash: 0n, ...over,
  };
}

const opening = (orderId: bigint, tif: 1 | 2 | 3 = 2): Opening => ({
  orderId, maker: 0x100n + orderId, makerSalt: 0x5a17n, makerRules: NEUTRAL_RULES, tif, receivedAt: 0,
});

function world() {
  const calls: string[] = [];
  const orders = new Map<bigint, OrderRecord>();
  const routed = new Set<bigint>();
  const gatewayRoutes = new Map<bigint, { orderId: bigint; status: number; pendingReceipts: number; cancelRequested: boolean }>();
  const currentRoute = new Map<bigint, bigint>();
  const receiptsPending = new Set<bigint>();
  const evmRouteStatus = new Map<string, bigint>();
  const hlStatus = new Map<bigint, { status: string; oid?: bigint }>();
  const fills: unknown[] = [];
  const credits = new Map<bigint, bigint>();
  // The exit vault's view: 1 registered, 2 funded (note not filled), 3 delivered.
  const exitStatus = new Map<bigint, number>();
  const sn = {
    pool: "0xpool", gateway: "0xgw", entryHelper: "0xhelper",
    account: { address: "0xkeeper", signMessage: async () => [] },
    provider: { getChainId: async () => "0x1" },
    blockNumber: async () => 0,
    events: async () => [],
    getOrder: async (id: bigint) => orders.get(id)!,
    isRouted: async (id: bigint) => routed.has(id),
    coreTokenOf: async (t: bigint) => CORE.get(t)!,
    currentRoute: async (id: bigint) => currentRoute.get(id) ?? 0n,
    routeOf: async (r: bigint) => ({ escrow: 0n, cumDraw: 0n, cumDeliver: 0n, seq: 0n, ...gatewayRoutes.get(r)! }),
    receiptPending: async (r: bigint) => receiptsPending.has(r),
    quoteRoute: async () => 1000n,
    orderCredit: async (id: bigint) => credits.get(id) ?? 0n,
    routeOrder: async (id: bigint, hl: { px: bigint; sz: bigint; isBuy: boolean; tif: number }) => {
      calls.push(`route ${id} ${hl.isBuy ? "buy" : "sell"} px=${hl.px} sz=${hl.sz} tif=${hl.tif}`);
      const r = 0x7000n + id;
      currentRoute.set(id, r);
      routed.add(id);
      gatewayRoutes.set(r, { orderId: id, status: 1, pendingReceipts: 0, cancelRequested: false });
      evmRouteStatus.set("0x" + r.toString(16).padStart(64, "0"), 1n);
      return "0xroute";
    },
    cancelRoute: async (id: bigint) => {
      calls.push(`cancel ${id}`);
      gatewayRoutes.get(currentRoute.get(id)!)!.cancelRequested = true;
      return "0xcancel";
    },
    release: async (id: bigint) => {
      calls.push(`release ${id}`);
      return "0xrelease";
    },
    exitStatus: async (id: bigint) => exitStatus.get(id) ?? 1,
    retryDelivery: async (id: bigint) => {
      calls.push(`retry_delivery ${id}`);
      exitStatus.set(id, 3);
      return "0xretry";
    },
    receiveExit: async (m: Uint8Array) => {
      calls.push(`receive_exit ${m.length}`);
      return "0xexit";
    },
  };
  // The keeper's HyperCore perps USDC (8 dp); Circle's credit lands at once.
  let keeperPerps8 = 0n;
  const evm = {
    omnibusAddress: "0xomni",
    wallet: { address: "0xkeeper" },
    blockNumber: async () => 0,
    events: async () => [],
    routeStatus: async (r: string) => evmRouteStatus.get(r) ?? 0n,
    report: async (items: Array<{ routeId: string; cumDraw: bigint; cumDeliver: bigint; closed: boolean }>) => {
      for (const it of items) calls.push(`report ${BigInt(it.routeId)} draw=${it.cumDraw} deliver=${it.cumDeliver} closed=${it.closed}`);
      return "0xreport";
    },
    receiveDeposit: async () => {
      calls.push("receiveDeposit");
      return "0x";
    },
    depositArrived: async () => 1_000_000n,
    toCore: async (amount6: bigint) => {
      calls.push(`toCore ${amount6}`);
      keeperPerps8 += amount6 * 100n;
      return "0x";
    },
    creditDeposit: async (id: string) => {
      calls.push(`creditDeposit ${BigInt(id)}`);
      return "0x";
    },
    burnExit: async (id: string) => {
      calls.push(`burnExit ${BigInt(id)}`);
      return "0xburn";
    },
  };
  const hl = {
    spotMeta: async () => ({
      tokens: [
        { name: "USDC", szDecimals: 8, weiDecimals: 8, index: 0 },
        { name: "HYPE", szDecimals: 2, weiDecimals: 8, index: 150 },
      ],
      universe: [{ name: "@107", tokens: [150, 0] as [number, number], index: 107 }],
    }),
    orderStatus: async (_: string, cloid: bigint) => hlStatus.get(cloid) ?? { status: "unknownOid" },
    fillsSince: async () => fills,
    usdcPerps8: async () => keeperPerps8,
    usdClassTransfer: async (amount8: bigint) => {
      calls.push(`usdClassTransfer ${amount8}`);
      keeperPerps8 -= amount8;
    },
    spotSendUsdc: async (to: string, amount8: bigint) => {
      calls.push(`spotSend ${to} ${amount8}`);
    },
  };
  const iris = {
    attestation: async (domain: number) => ({ message: "0x" + (domain === 25 ? "aa" : "bb").repeat(40), attestation: "0x01" }),
  };
  const exchange = {
    executeBatch: async (a: { orderIds: bigint[]; fills: Array<{ deliver: bigint; draw: bigint }> }) => {
      calls.push(`batch ${a.orderIds.join(",")} ${a.fills.map((f) => `${f.deliver}/${f.draw}`).join(",")}`);
      return { txHash: "0xbatch" };
    },
    venueFill: async (a: { receiptIds: bigint[] }) => {
      calls.push(`venueFill ${a.receiptIds.join(",")}`);
      return { txHash: "0xfill" };
    },
  };
  const state = emptyState(0, 0);
  const keeper = new Keeper(sn as never, evm as never, hl as never, iris as never, exchange as never, state, PARAMS, () => {});
  return { keeper, state, calls, orders, routed, gatewayRoutes, currentRoute, receiptsPending, evmRouteStatus, hlStatus, fills, credits, exitStatus };
}

function post(w: ReturnType<typeof world>, id: bigint, o: OrderRecord, tif: 1 | 2 | 3 = 2) {
  w.orders.set(id, o);
  w.state.orders[key(id)] = { postedAt: Number(id) };
  w.keeper.acceptOpening(opening(id, tif));
  w.credits.set(id, 1000n); // the user prepaid routing from STRK20
}

const SELL = order({
  offerToken: HYPE_TWIN, wantToken: USDC_TWIN, offerAmount: 4_000_000_000n, wantAmount: 96_000_000_000n, escrowRemaining: 4_000_000_000n,
});

test("orders that cross inside Veil settle there and never reach Hyperliquid", async () => {
  const w = world();
  post(w, 1n, order({}));
  post(w, 2n, SELL);
  await w.keeper.crossAndRoute();
  assert.deepEqual(w.calls, ["batch 1,2 3840000000/96000000000,96000000000/3840000000"]);
});

test("an order Veil cannot cross is routed to Hyperliquid at its limit net of the fee", async () => {
  const w = world();
  post(w, 1n, order({}));
  await w.keeper.crossAndRoute();
  assert.deepEqual(w.calls, ["route 1 buy px=2497500000 sz=4000000000 tif=2"]);
  assert.ok(w.state.routes[key(0x7001n)]);
});

test("an order whose routing fee is not prepaid is not routed", async () => {
  const w = world();
  post(w, 1n, order({}));
  w.credits.set(1n, 999n);
  await w.keeper.crossAndRoute();
  assert.deepEqual(w.calls, []);
});

test("a maker's cancel request pulls its order back, and only the maker's", async () => {
  const w = world();
  post(w, 1n, order({}));
  await w.keeper.crossAndRoute();
  w.calls.length = 0;
  assert.equal(w.keeper.requestCancel(1n, 0x1n), "not the maker");
  await w.keeper.cancelExpired();
  assert.deepEqual(w.calls, []);
  assert.equal(w.keeper.requestCancel(1n, 0x5a17n), null);
  await w.keeper.cancelExpired();
  assert.deepEqual(w.calls, ["cancel 1"]);
});

test("an order with no maker opening waits", async () => {
  const w = world();
  w.orders.set(1n, order({}));
  w.state.orders[key(1n)] = { postedAt: 1 };
  await w.keeper.crossAndRoute();
  assert.deepEqual(w.calls, []);
});

test("a new order that would cross one resting on Hyperliquid pulls it back instead of routing", async () => {
  const w = world();
  post(w, 1n, order({}));
  await w.keeper.crossAndRoute(); // 1 rests on Hyperliquid
  post(w, 2n, SELL);
  w.calls.length = 0;
  await w.keeper.crossAndRoute();
  assert.deepEqual(w.calls, ["cancel 1"]);
});

test("fills are reported from HyperCore, then closing, then receipts applied and the route released", async () => {
  const w = world();
  post(w, 1n, order({}));
  await w.keeper.crossAndRoute();
  const cloid = 0x7001n;
  w.hlStatus.set(cloid, { status: "open", oid: 55n });
  w.fills.push({ coin: "@107", px: "24.9", sz: "10", side: "B", oid: 55, fee: "0.007", feeToken: "HYPE", tid: 1 });
  w.calls.length = 0;
  await w.keeper.reportFills();
  assert.deepEqual(w.calls, ["report 28673 draw=24900000000 deliver=999300000 closed=false"]);

  // Nothing new: nothing reported.
  w.calls.length = 0;
  await w.keeper.reportFills();
  assert.deepEqual(w.calls, []);

  // Cancelled on HyperCore: one closing report.
  w.hlStatus.set(cloid, { status: "canceled", oid: 55n });
  await w.keeper.reportFills();
  assert.deepEqual(w.calls, ["report 28673 draw=24900000000 deliver=999300000 closed=true"]);

  // The gateway minted a receipt; the keeper applies it, then releases.
  w.state.receipts[key(0xeeen)] = { orderId: 1n, applied: false };
  w.receiptsPending.add(0xeeen);
  w.calls.length = 0;
  await w.keeper.applyReceipts();
  assert.deepEqual(w.calls, ["venueFill 3822"]);
  w.gatewayRoutes.get(cloid)!.status = 2;
  w.calls.length = 0;
  await w.keeper.releaseClosed();
  assert.deepEqual(w.calls, ["release 1"]);
});

test("an order HyperCore never rested is closed with nothing spent, after the grace period", async () => {
  const w = world();
  post(w, 1n, order({}));
  await w.keeper.crossAndRoute();
  w.calls.length = 0;
  await w.keeper.reportFills();
  assert.deepEqual(w.calls, []); // still within grace
  w.state.routes[key(0x7001n)].placedAt -= 120_000;
  await w.keeper.reportFills();
  assert.deepEqual(w.calls, ["report 28673 draw=0 deliver=0 closed=true"]);
});

test("deposits are relayed, spot-sent then credited; an exit is burned, relayed and delivered", async () => {
  const w = world();
  w.state.deposits[key(0xd1n)] = { burnTx: "0xtx", stage: "burned" };
  w.state.exits[key(0xe1n)] = { stage: "requested" };
  w.exitStatus.set(0xe1n, 3); // the vault fills the note as it receives
  for (let i = 0; i < 4; i++) await w.keeper.relayDeposits();
  await w.keeper.relayExits();
  await w.keeper.relayExits();
  assert.deepEqual(w.calls, [
    "receiveDeposit", "toCore 1000000", "usdClassTransfer 100000000", "spotSend 0xomni 100000000",
    "creditDeposit 209", "burnExit 225", "receive_exit 40",
  ]);
  assert.equal(w.state.deposits[key(0xd1n)].stage, "credited");
  assert.equal(w.state.exits[key(0xe1n)].stage, "delivered");
});

test("an exit the pool refused on arrival is delivered on a later tick", async () => {
  const w = world();
  w.state.exits[key(0xe1n)] = { stage: "requested" };
  w.exitStatus.set(0xe1n, 2); // quarantined in the vault
  await w.keeper.relayExits(); // burn on HyperEVM
  await w.keeper.relayExits(); // relay Circle's message: the fill is refused
  await w.keeper.relayExits(); // deliver it on the next tick
  assert.deepEqual(w.calls, ["burnExit 225", "receive_exit 40", "retry_delivery 225"]);
  assert.equal(w.state.exits[key(0xe1n)].stage, "delivered");
});

test("an expired routed order is pulled back from Hyperliquid once", async () => {
  const w = world();
  post(w, 1n, order({}));
  await w.keeper.crossAndRoute();
  w.orders.set(1n, order({ expiry: 1 }));
  w.calls.length = 0;
  await w.keeper.cancelExpired();
  await w.keeper.cancelExpired();
  assert.deepEqual(w.calls, ["cancel 1"]);
});

test("an opening is accepted only if it opens the order's commitments", () => {
  const o = opening(1n);
  const good = { makerCommitment: computeMakerCommitment(o.maker, o.makerSalt), makerRulesHash: hashRules(NEUTRAL_RULES) };
  assert.equal(checkOpening(o, good), null);
  assert.match(checkOpening({ ...o, makerSalt: 1n }, good)!, /commitment/);
  assert.match(checkOpening(o, { ...good, makerRulesHash: 7n })!, /rules/);
  assert.match(checkOpening(o, { makerCommitment: 0n, makerRulesHash: 0n })!, /unknown/);
});

test("raw bytes serialize as a Cairo ByteArray", () => {
  const bytes = new Uint8Array(40).map((_, i) => i + 1);
  const cd = byteArrayCalldata(bytes);
  assert.equal(cd[0], "0x1"); // one full 31-byte word
  assert.equal(cd.length, 4);
  assert.equal(cd[3], "0x9"); // 9 pending bytes
  assert.equal(BigInt(cd[2]), 0x2021222324252627_28n);
});
