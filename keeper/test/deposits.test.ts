// A deposit's way in: Circle mints the USDC to the keeper, the keeper moves it
// into its HyperCore account and spot-sends it to the omnibus, and the omnibus
// credits it. Deposits and exits move one at a time: one that cannot move yet
// must not hold back the ones behind it.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fromUsdc8, toUsdc8 } from "../src/hlApi.js";
import { Keeper, type KeeperParams } from "../src/keeper.js";
import { emptyState } from "../src/store.js";

const PARAMS: KeeperParams = {
  maxFeeBps: 10, minNotional: 1_000_000_000n, returnValue: 5n, unknownGraceMs: 60_000,
  maxReceiptsPerFill: 16, maxReportItems: 8, maxLogWindows: 20, openAllowlist: false,
};

const KEEPER_EVM = "0x878ffCF3351C6596Bd75355E00319AB5Fcf1c639";
const OMNIBUS = "0x938acDEf0428797256180dA45226f79513c35A25";
const FIRST = "0x1";
const SECOND = "0x2";
const AMOUNT6 = 15_000_000n; // 15 USDC

function world(over: Partial<KeeperParams> = {}) {
  const calls: string[] = [];
  const log: string[] = [];
  // The keeper's HyperCore USDC (8 dp): faucet money already there, and what
  // Circle's CoreDepositWallet has credited so far.
  const core = { perps: 960_00000000n, spot: 9_00000000n };
  const evm = {
    wallet: { address: KEEPER_EVM },
    omnibusAddress: OMNIBUS,
    receiveDeposit: async () => { calls.push("receiveDeposit"); return "0xtx"; },
    depositArrived: async () => AMOUNT6,
    toCore: async (amount6: bigint, dex: string) => { calls.push(`toCore ${amount6} ${dex}`); return "0xtoCore"; },
    creditDeposit: async (id: string) => {
      calls.push(`creditDeposit ${BigInt(id)}`);
      if (BigInt(id) === 1n && failCredit.on) throw new Error("execution reverted: Insolvent");
      return "0xcredit";
    },
    burnExit: async (id: string) => {
      calls.push(`burnExit ${BigInt(id)}`);
      if (BigInt(id) === 1n) throw new Error("execution reverted: ExitNotReady");
      return "0xburn";
    },
  };
  const failCredit = { on: false };
  const hl = {
    usdcPerps8: async (user: string) => { assert.equal(user, KEEPER_EVM); return core.perps; },
    usdcSpot8: async (user: string) => { assert.equal(user, KEEPER_EVM); return core.spot; },
    usdClassTransfer: async (amount8: bigint, toPerp: boolean) => {
      calls.push(`usdClassTransfer ${amount8} toPerp=${toPerp}`);
      core.perps -= amount8;
      core.spot += amount8;
    },
    spotSendUsdc: async (to: string, amount8: bigint) => {
      calls.push(`spotSend ${to} ${amount8}`);
      core.spot -= amount8;
    },
  };
  const iris = { attestation: async () => ({ message: "0xm", attestation: "0xa" }) };
  const state = emptyState(0, 0);
  const keeper = new Keeper(
    {} as never, evm as never, hl as never, iris as never, {} as never,
    state, { ...PARAMS, ...over }, (m) => log.push(m),
  );
  return { keeper, state, calls, log, core, failCredit };
}

test("minted to the keeper, into its HyperCore account, spot-sent to the omnibus, then credited", async () => {
  const w = world();
  w.state.deposits[FIRST] = { burnTx: "0xaa", stage: "burned" };

  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[FIRST].stage, "relayed");
  assert.equal(w.state.deposits[FIRST].amount6, String(AMOUNT6));

  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[FIRST].stage, "bridging");
  assert.equal(w.state.deposits[FIRST].baseline8, String(960_00000000n));

  // HyperCore has not credited it yet: nothing is sent, faucet money included.
  w.calls.length = 0;
  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[FIRST].stage, "bridging");
  assert.deepEqual(w.calls, []);

  w.core.perps += AMOUNT6 * 100n; // Circle's credit lands
  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[FIRST].stage, "sent");
  assert.deepEqual(w.calls, [
    `usdClassTransfer ${AMOUNT6 * 100n} toPerp=false`,
    `spotSend ${OMNIBUS} ${AMOUNT6 * 100n}`,
  ]);

  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[FIRST].stage, "credited");
  assert.equal(w.calls.at(-1), "creditDeposit 1");
});

test("through spot, the spot send needs no class transfer", async () => {
  const w = world({ coreDex: "spot" });
  w.state.deposits[FIRST] = { burnTx: "0xaa", stage: "relayed", amount6: String(AMOUNT6) };
  await w.keeper.relayDeposits();
  assert.deepEqual(w.calls, [`toCore ${AMOUNT6} spot`]);
  w.core.spot += AMOUNT6 * 100n;
  await w.keeper.relayDeposits();
  assert.deepEqual(w.calls.slice(1), [`spotSend ${OMNIBUS} ${AMOUNT6 * 100n}`]);
});

test("one deposit crosses into HyperCore at a time", async () => {
  const w = world();
  w.state.deposits[FIRST] = { burnTx: "0xaa", stage: "relayed", amount6: String(AMOUNT6) };
  w.state.deposits[SECOND] = { burnTx: "0xbb", stage: "relayed", amount6: String(AMOUNT6) };
  await w.keeper.relayDeposits();
  assert.deepEqual(w.calls, [`toCore ${AMOUNT6} perps`]);
  assert.equal(w.state.deposits[SECOND].stage, "relayed");

  // The first lands and is sent; the second waits for the next tick, so its
  // baseline is read after that spot send.
  w.core.perps += AMOUNT6 * 100n;
  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[FIRST].stage, "sent");
  assert.equal(w.state.deposits[SECOND].stage, "relayed");

  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[SECOND].stage, "bridging");
  assert.equal(w.state.deposits[SECOND].baseline8, String(960_00000000n));
});

test("a deposit that cannot be credited does not block the next one", async () => {
  const w = world();
  w.failCredit.on = true;
  w.state.deposits[FIRST] = { burnTx: "0xaa", stage: "sent", amount6: String(AMOUNT6) };
  w.state.deposits[SECOND] = { burnTx: "0xbb", stage: "burned" };
  await w.keeper.relayDeposits();
  assert.deepEqual(w.calls, ["creditDeposit 1", "receiveDeposit"]);
  assert.equal(w.state.deposits[FIRST].stage, "sent");
  assert.equal(w.state.deposits[SECOND].stage, "relayed");
  assert.ok(w.log.some((l) => l.startsWith(`[deposits] ${FIRST}:`)));
});

test("a deposit whose HyperCore transfer never lands is re-sent, then set aside so the queue drains", async () => {
  // Found on testnet: a deposit sat in `bridging` for days because its
  // transfer never landed, and since one deposit bridges at a time, every
  // deposit behind it waited too.
  const w = world();
  const LONG_AGO = Date.now() - 4 * 60 * 1000;
  w.state.deposits[FIRST] = {
    burnTx: "0xaa", stage: "bridging", amount6: String(AMOUNT6),
    baseline8: String(960_00000000n), since: LONG_AGO, attempts: 1,
  };
  w.state.deposits[SECOND] = { burnTx: "0xbb", stage: "relayed", amount6: String(AMOUNT6) };

  // Waited too long: re-send against a fresh baseline.
  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[FIRST].stage, "relayed");
  assert.ok(w.log.some((l) => l.includes("re-sending")));

  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[FIRST].stage, "bridging");
  assert.equal(w.state.deposits[FIRST].attempts, 2);
  assert.equal(w.state.deposits[SECOND].stage, "relayed");

  // It still does not land: out of attempts, set aside.
  w.state.deposits[FIRST].since = LONG_AGO;
  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[FIRST].stage, "stalled");
  assert.ok(w.log.some((l) => l.includes("STALLED")));

  // And the one behind it finally moves.
  w.calls.length = 0;
  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[SECOND].stage, "bridging");
  assert.deepEqual(w.calls, [`toCore ${AMOUNT6} perps`]);
});

test("a deposit still inside its window keeps waiting quietly", async () => {
  const w = world();
  w.state.deposits[FIRST] = {
    burnTx: "0xaa", stage: "bridging", amount6: String(AMOUNT6),
    baseline8: String(960_00000000n), since: Date.now(), attempts: 1,
  };
  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[FIRST].stage, "bridging");
  assert.deepEqual(w.calls, []);
});

test("testnet float: a relayed deposit goes to the omnibus from the keeper's HyperCore USDC", async () => {
  // Circle stops crediting an address on HyperCore testnet after 1,000 USDC,
  // so the CoreDepositWallet hop never lands; the float path skips it.
  const w = world({ coreFloat: true });
  w.state.deposits[FIRST] = { burnTx: "0xaa", stage: "relayed", amount6: String(AMOUNT6) };
  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[FIRST].stage, "sent");
  assert.deepEqual(w.calls, [
    `usdClassTransfer ${AMOUNT6 * 100n} toPerp=false`,
    `spotSend ${OMNIBUS} ${AMOUNT6 * 100n}`,
  ]);
  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[FIRST].stage, "credited");
});

test("testnet float: a float that cannot cover the deposit waits, and says so", async () => {
  const w = world({ coreFloat: true });
  w.core.perps = 1_00000000n; // 1 USDC
  w.state.deposits[FIRST] = { burnTx: "0xaa", stage: "relayed", amount6: String(AMOUNT6) };
  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[FIRST].stage, "relayed");
  assert.deepEqual(w.calls, []);
  assert.ok(w.log.some((l) => l.includes("top it up")));
});

test("testnet float: a deposit does not queue behind one still bridging", async () => {
  const w = world({ coreFloat: true });
  w.state.deposits[FIRST] = {
    burnTx: "0xaa", stage: "bridging", amount6: String(AMOUNT6),
    baseline8: String(960_00000000n), since: Date.now(), attempts: 1,
  };
  w.state.deposits[SECOND] = { burnTx: "0xbb", stage: "relayed", amount6: String(AMOUNT6) };
  await w.keeper.relayDeposits();
  assert.equal(w.state.deposits[SECOND].stage, "sent");
});

test("HV_CORE_FLOAT is refused on mainnet", async () => {
  const { loadConfig } = await import("../src/config.js");
  assert.throws(
    () => loadConfig({ HV_NETWORK: "mainnet", HV_CORE_FLOAT: "1" } as never),
    /HV_CORE_FLOAT is testnet only/,
  );
});

test("an exit not paid out yet does not block the next one", async () => {
  const w = world();
  w.state.exits[FIRST] = { stage: "requested" };
  w.state.exits[SECOND] = { stage: "requested" };
  await w.keeper.relayExits();
  assert.deepEqual(w.calls, ["burnExit 1", "burnExit 2"]);
  assert.equal(w.state.exits[FIRST].stage, "requested");
  assert.equal(w.state.exits[SECOND].stage, "burned");
  assert.ok(w.log.some((l) => l.startsWith(`[exits] ${FIRST}:`)));
});

test("HyperCore USDC amounts round-trip through their decimal strings", () => {
  assert.equal(toUsdc8("14.999999"), 1_499_999_900n);
  assert.equal(toUsdc8("1000.0"), 100_000_000_000n);
  assert.equal(toUsdc8("0.1441478"), 14_414_780n);
  assert.equal(fromUsdc8(1_499_999_900n), "14.999999");
  assert.equal(fromUsdc8(1_500_000_000n), "15");
  assert.equal(fromUsdc8(1n), "0.00000001");
  assert.throws(() => toUsdc8("1.000000001"));
});
