#!/usr/bin/env node
// Drives one deposit all the way: wallet USDC -> a private note in the Veil
// pool -> CCTP burn to HyperEVM -> the keeper's HyperCore transfer -> a
// credited hvUSDC twin note.
//
//   node deposit.mjs [--amount 5] [--dry] [--wait 20]
//                     [--skip-deposit] [--note 0x<open note id>]
//
// `--skip-deposit` and `--note` resume a run that already put USDC in the pool
// and reserved its open note: each proven step is minutes, and a failure late
// in the run should not cost the earlier ones again.
//
// Until now this path existed only in the browser app, which needs a wallet,
// so it had never been run end to end. Everything here is what
// `app/src/veil.ts` does, from a private key.
//
// Each proven step is minutes of proving, so every step prints before it
// starts and the prover's progress is echoed on one line.

import { Contract } from "starknet";
import { computeNoteId, planDeposit, planFee, FUND_NOTE } from "veil-sdk";
import {
  account, config, discovery, done, hex, identity, nextNoteIndex, noteValue,
  onEvent, planInputs, pool, prover, provider, randomFelt, randomNoteSalt,
  step, u256, usdc,
} from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const AMOUNT = BigInt(Math.round(Number(flag("amount", "5")) * 1e6));
/** Poll an already-sent deposit and nothing else. */
const WATCH = has("watch");
const WAIT_MIN = Number(flag("wait", "20"));
const TOTAL = 6;

const ERC20 = [
  { type: "function", name: "approve", state_mutability: "external",
    inputs: [{ name: "spender", type: "core::starknet::contract_address::ContractAddress" },
             { name: "amount", type: "core::integer::u256" }], outputs: [] },
  { type: "function", name: "balance_of", state_mutability: "view",
    inputs: [{ name: "account", type: "core::starknet::contract_address::ContractAddress" }],
    outputs: [{ type: "core::integer::u256" }] },
  { type: "function", name: "allowance", state_mutability: "view",
    inputs: [{ name: "owner", type: "core::starknet::contract_address::ContractAddress" },
             { name: "spender", type: "core::starknet::contract_address::ContractAddress" }],
    outputs: [{ type: "core::integer::u256" }] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One proven step, retried: this account is also the keeper's, so a keeper
 *  tick can consume the nonce a derive was built with while it is proving.
 *  A retry rebuilds against the current nonce. Separate accounts for the user
 *  and the keeper are the real fix. */
async function proven(label, run) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await run();
      console.log();
      return res;
    } catch (e) {
      console.log();
      if (attempt >= 3) throw e;
      done(`${label} attempt ${attempt}`, `${String(e?.message || e)} — retrying`);
    }
  }
}

async function main() {
  const cfg = config();
  const p = provider(cfg);
  const acct = account(cfg, p);
  const sn = cfg.sn;
  // The twins are a list keyed by HyperCore token id; USDC is token 0.
  const twinCfg = cfg.twins.find((t) => t.hlToken === 0);
  if (!twinCfg) throw new Error("no hvUSDC twin in app/public/deployment.json");
  const twin = BigInt(twinCfg.address);

  console.log(`account      ${cfg.address}`);
  console.log(`pool         ${sn.pool}`);
  console.log(`prover       ${cfg.prover.endpoint}`);
  console.log(`amount       ${usdc(AMOUNT)} USDC`);
  console.log(`return value ${cfg.returnValue} wei (0 is correct under the relay)`);

  // ── 1. the account ───────────────────────────────────────────────────────
  step(1, TOTAL, "the account");
  const usdcToken = new Contract({ abi: ERC20, address: sn.usdc, providerOrAccount: p });
  const wallet = await usdcToken.balance_of(cfg.address);
  done("wallet USDC", usdc(wallet));
  if (wallet < AMOUNT) throw new Error(`the wallet holds ${usdc(wallet)} USDC, less than the ${usdc(AMOUNT)} asked for`);

  const whitelisted = (await p.callContract({
    contractAddress: sn.permissionManager, entrypoint: "is_whitelisted", calldata: [cfg.address],
  }))[0];
  done("KYC list", BigInt(whitelisted) === 1n ? "whitelisted" : "NOT whitelisted");
  if (BigInt(whitelisted) !== 1n) {
    throw new Error("this account is not on the HyperVeil KYC list; the keeper's intake or scripts/whitelist.js adds it");
  }

  const id = await identity(cfg, acct);
  const registered = (await p.callContract({
    contractAddress: sn.pool, entrypoint: "get_viewing_key", calldata: [cfg.address],
  }))[0];
  done("viewing key", BigInt(registered) === 0n ? "NOT registered" : "registered");
  if (BigInt(registered) !== 0n && BigInt(registered) !== id.publicKey) {
    // The pool encrypts notes to the REGISTERED key. Depositing under a
    // different one would put the money in notes this identity cannot read.
    done("registered key", hex(registered));
    done("derived key", hex(id.publicKey));
    throw new Error(
      "the derived viewing key is not the one registered for this account.\n" +
      "  Delete e2e/.viewing-key.json if it holds a stale key, or use the account that registered.",
    );
  }

  if (has("dry")) { console.log("\n--dry: stopping before anything is proven."); return; }

  const P = prover(cfg, acct);
  if (WATCH) {
    const given = flag("note", "");
    if (!given) throw new Error("--watch needs --note <open note id>");
    return await waitForCredit(cfg, p, id, BigInt(given));
  }

  // ── 2. register the viewing key ──────────────────────────────────────────
  step(2, TOTAL, "viewing key");
  if (BigInt(registered) === 0n) {
    console.log("      registering (a proof, this takes minutes)…");
    const calldata = [hex(id.owner), ...u256(id.k), hex(randomFelt()), hex(randomFelt()), hex(randomFelt())];
    const res = await P.registerViewingKey(calldata, { onEvent: onEvent("register") });
    console.log();
    done("registered", res.txHash);
  } else {
    done("already registered", "");
  }

  // ── 3. USDC into the pool ────────────────────────────────────────────────
  step(3, TOTAL, "USDC into the Veil pool");
  if (has("skip-deposit")) {
    done("skipped", "--skip-deposit: using the USDC already in the pool");
  } else {
  const allowance = await usdcToken.allowance(cfg.address, sn.pool);
  if (allowance < AMOUNT) {
    const tx = await acct.execute([{
      contractAddress: sn.usdc, entrypoint: "approve",
      calldata: [sn.pool, hex(AMOUNT), "0x0"],
    }]);
    await p.waitForTransaction(tx.transaction_hash);
    done("approved", tx.transaction_hash);
  } else {
    done("allowance", "already sufficient");
  }
  console.log("      depositing (a proof)…");
  const depositCalldata = [
    hex(id.owner), ...u256(id.k), hex(BigInt(sn.usdc)), hex(AMOUNT),
    hex(randomNoteSalt()), hex(randomFelt()),
  ];
  const dep = await proven("deposit", () => P.deposit(depositCalldata, { onEvent: onEvent("deposit") }));
  done("deposited", dep.txHash);

  }
  const notes = await (await discovery(cfg, p)).listOwnedNotes(id.owner, id.k);
  const held = notes.filter((n) => BigInt(n.token) === BigInt(sn.usdc));
  done("private USDC notes", String(held.length));

  // ── 4. an open note for the twin ─────────────────────────────────────────
  step(4, TOTAL, "an open note for hvUSDC");
  let twinNoteId;
  const given = flag("note", "");
  if (given) {
    twinNoteId = BigInt(given);
    const enc = await noteValue(cfg, p, twinNoteId);
    done("note id", hex(twinNoteId));
    done("on chain", enc === 0n ? "ABSENT" : "present");
    if (enc === 0n) throw new Error("--note names a note the pool does not have");
  } else {
    const index = await nextNoteIndex(cfg, p, id, twin);
    twinNoteId = computeNoteId(id.selfChannelKey, twin, index);
    console.log("      reserving (a proof)…");
    const open = await proven("open note", () => P.createOpenNote(
      [hex(id.owner), ...u256(id.k), hex(twin), hex(randomFelt()), hex(randomFelt())],
      { onEvent: onEvent("open note") },
    ));
    done("note id", hex(twinNoteId));
    done("reserved", open.txHash);
  }

  // ── 5. pay the gateway's reply fee ───────────────────────────────────────
  step(5, TOTAL, "the gateway's reply fee");
  if (cfg.returnValue === 0n) {
    done("skipped", "return value is 0: the relay endpoint charges nothing");
  } else {
    console.log("      paying from private STRK (a proof)…");
    const plan = planFee({
      ...(await planInputs(cfg, p, id, BigInt(sn.strk))),
      strk: BigInt(sn.strk), feeAdapter: BigInt(sn.feeAdapter),
      target: FUND_NOTE, key: twinNoteId, amount: cfg.returnValue,
    });
    const paid = await P.invoke(plan.deriveCalldata, { settleExtra: plan.settleExtra, onEvent: onEvent("fee") });
    console.log();
    done("paid", paid.txHash);
  }

  // ── 6. send it to Hyperliquid ────────────────────────────────────────────
  step(6, TOTAL, "send it to Hyperliquid");
  const maxFeeBps = BigInt(Math.max(0, Math.round(cfg.cctp.maxFeeBps)));
  const cctpMaxFee = maxFeeBps === 0n ? 0n : (AMOUNT * maxFeeBps + 9999n) / 10000n;
  const plan = planDeposit({
    ...(await planInputs(cfg, p, id, BigInt(sn.usdc))),
    usdc: BigInt(sn.usdc), entryHelper: BigInt(sn.entryHelper),
    amountUsdc6: AMOUNT, twinNoteId, cctpMaxFee,
    minFinality: cfg.cctp.minFinality, returnValue: cfg.returnValue,
  });
  console.log("      burning through CCTP (a proof)…");
  const sent = await proven("send", () =>
    P.invoke(plan.deriveCalldata, { settleExtra: plan.settleExtra, onEvent: onEvent("send") }));
  done("sent", sent.txHash);

  await waitForCredit(cfg, p, id, twinNoteId);
}

async function waitForCredit(cfg, p, id, twinNoteId) {
  // ── the keeper's half ────────────────────────────────────────────────────
  console.log(`\nwaiting for the keeper (CCTP attestation, HyperCore transfer, CREDIT).`);
  console.log(`it ticks once a minute; giving it ${WAIT_MIN} minutes.\n`);
  const deadline = Date.now() + WAIT_MIN * 60_000;
  for (let i = 0; Date.now() < deadline; i++) {
    const enc = await noteValue(cfg, p, twinNoteId);
    process.stdout.write(`\r  ${String(i).padStart(3)}  twin note ${enc === 0n ? "absent" : "present"}, still empty…   `);
    if (enc !== 0n) {
      const after = await (await discovery(cfg, p)).listOwnedNotes(id.owner, id.k);
      const credited = after.find((n) => n.noteId === twinNoteId);
      if (credited && credited.amount > 0n) {
        console.log(`\n\nCREDITED: ${credited.amount} (8 dp) of hvUSDC in note ${hex(twinNoteId)}`);
        return;
      }
    }
    await sleep(20_000);
  }
  console.log(`\n\nnot credited within ${WAIT_MIN} minutes.`);
  console.log(`check the keeper: aws logs tail /aws/lambda/hyperveil-keeper-tick --follow --region us-east-1`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error("\n" + String(e?.message || e));
  process.exit(1);
});
