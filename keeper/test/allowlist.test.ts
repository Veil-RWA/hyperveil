// TESTNET ONLY: the open allowlist. The intake records who asked; the tick is
// what sends the transaction, so the keeper keeps one writer on its Starknet
// account.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseAddress } from "../src/intake.js";
import { Keeper, type KeeperParams } from "../src/keeper.js";
import { emptyState, key, takeFinishedAllowlist } from "../src/store.js";

const PARAMS: KeeperParams = {
  maxFeeBps: 10, minNotional: 1_000_000_000n, returnValue: 5n, unknownGraceMs: 60_000,
  maxReceiptsPerFill: 16, maxReportItems: 8, maxLogWindows: 20, openAllowlist: true,
};

const A = 0x07f69f195543ee9bc33e3fb1bf4609e96d49a7cc9e22a136ed4a3f80570c7121n;
const B = 0x123n;

function world(over: Partial<KeeperParams> = {}, already: bigint[] = [], failWith?: string) {
  const on = new Set(already.map((a) => key(a)));
  const calls: string[] = [];
  const log: string[] = [];
  const sn = {
    pool: "0xpool", gateway: "0xgw", entryHelper: "0xhelper",
    blockNumber: async () => 0,
    events: async () => [],
    isWhitelisted: async (a: bigint | string) => {
      calls.push(`isWhitelisted ${key(BigInt(a))}`);
      return on.has(key(BigInt(a)));
    },
    whitelist: async (list: (bigint | string)[]) => {
      calls.push(`whitelist ${list.map((a) => key(BigInt(a))).join(",")}`);
      if (failWith) throw new Error(failWith);
      for (const a of list) on.add(key(BigInt(a)));
      return "0xtx";
    },
  };
  const state = emptyState(0, 0);
  const keeper = new Keeper(
    sn as never, {} as never, {} as never, {} as never, {} as never,
    state, { ...PARAMS, ...over }, (m) => log.push(m),
  );
  return { keeper, state, calls, log, on };
}

/** Only the allowlist step; the rest of a tick needs both chains. */
const grant = (w: ReturnType<typeof world>) =>
  (w.keeper as unknown as { grantAllowlist(): Promise<void> }).grantAllowlist();

test("everyone waiting is let in by one transaction", async () => {
  const w = world();
  w.keeper.requestAllowlist(A);
  w.keeper.requestAllowlist(B);
  await grant(w);
  assert.equal(w.calls.filter((c) => c.startsWith("whitelist")).length, 1);
  assert.ok(w.calls.includes(`whitelist ${key(A)},${key(B)}`));
  assert.ok(w.on.has(key(A)) && w.on.has(key(B)));
  assert.ok(w.log.some((l) => l.includes("allowlisted 2 accounts")));
});

test("an address already on the list costs a read and no transaction", async () => {
  const w = world({}, [A]);
  w.keeper.requestAllowlist(A);
  await grant(w);
  assert.deepEqual(w.calls, [`isWhitelisted ${key(A)}`]);
  assert.equal(w.state.allowlist[key(A)].done, true);
});

test("asking twice is asking once", async () => {
  const w = world();
  w.keeper.requestAllowlist(A);
  const first = w.state.allowlist[key(A)].requestedAt;
  w.keeper.requestAllowlist(A);
  assert.equal(Object.keys(w.state.allowlist).length, 1);
  assert.equal(w.state.allowlist[key(A)].requestedAt, first);
});

test("finished requests are handed over once, and then gone", async () => {
  const w = world();
  w.keeper.requestAllowlist(A);
  await grant(w);
  assert.deepEqual(takeFinishedAllowlist(w.state), [key(A)]);
  assert.deepEqual(w.state.allowlist, {});
  // The store deletes exactly what it is handed; nothing is left to delete twice.
  assert.deepEqual(takeFinishedAllowlist(w.state), []);
});

test("a request the chain refused stays pending, with the reason", async () => {
  const w = world({}, [], "account balance too low");
  w.keeper.requestAllowlist(A);
  await assert.rejects(() => grant(w), /balance too low/);
  assert.equal(w.state.allowlist[key(A)].done, undefined);
  assert.match(String(w.state.allowlist[key(A)].error), /balance too low/);
  assert.deepEqual(takeFinishedAllowlist(w.state), [], "nothing is dropped while it is unfinished");
});

test("a tick does not even look while the open allowlist is off", async () => {
  const w = world({ openAllowlist: false });
  w.keeper.requestAllowlist(A);
  await w.keeper.tick();
  assert.deepEqual(w.calls, []);
  assert.equal(w.state.allowlist[key(A)].done, undefined);
});

test("only a Starknet address is accepted", () => {
  assert.equal(parseAddress("0x123"), 0x123n);
  assert.equal(parseAddress(291), 0x123n);
  for (const bad of [undefined, "", "0x0", 0, "not an address", "0x" + "f".repeat(64)]) {
    assert.throws(() => parseAddress(bad), `${String(bad)} should be refused`);
  }
});
