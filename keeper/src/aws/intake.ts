// The keeper's intake, as a Lambda behind a Function URL. The app posts here:
//
//   POST /openings  {orderId, maker, makerSalt, makerRules?, tif}
//   POST /cancel    {orderId, makerSalt}
//   POST /allowlist {address}   TESTNET ONLY (HV_OPEN_ALLOWLIST)
//   POST /relay-cash {message, attestation}   an EVM wallet's CCTP burn into
//                                              its note (HV_CASH_VAULT)
//   POST /fund-note {noteId, purpose, amount}  the paymaster pays a deposit's
//                                              or exit's message fee (STRK)
//   GET  /health
//
// Same checks as the long-running intake: an opening is accepted only if it
// opens the order's on-chain commitments, and a cancel only from whoever knows
// the order's maker salt. It writes single opening items, so it never races
// the ticker, which owns the rest of the state.
//
// Browsers call this directly, so it answers CORS preflights.

import { Account, RpcProvider } from "starknet";
import { NEUTRAL_RULES, type SenderBalanceRules } from "veil-sdk";
import { loadConfig } from "../config.js";
import { checkOpening, parseAddress } from "../intake.js";
import { noteFeeToFund } from "../noteFees.js";
import { StarknetSide } from "../starknetSide.js";
import { key, type Opening } from "../store.js";
import { DynamoStore } from "./store.js";

interface FunctionUrlEvent {
  rawPath?: string;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string; path?: string } };
}

const CORS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

/** Reads, plus the one transaction the intake sends itself: the paymaster's
 *  note-fee payment (`/fund-note`). Everything else is the tick's. */
const starknetSide = (cfg: ReturnType<typeof loadConfig>): StarknetSide =>
  new StarknetSide(
    cfg.starknet.rpcUrl,
    cfg.starknet.keeperAddress,
    cfg.starknet.keeperKey,
    cfg.starknet.pool,
    cfg.starknet.gateway,
    cfg.starknet.entryHelper,
    cfg.starknet.exitVault,
    cfg.starknet.strk,
    cfg.starknet.permissionManager,
  );

const reply = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: CORS,
  body: JSON.stringify(body),
});

/** Hex bytes (0x…) as Cairo `ByteArray` calldata: [full 31-byte words…,
 *  pending word, pending length]. */
function byteArrayCalldata(value: unknown): string[] {
  const hex = String(value ?? "").replace(/^0x/i, "");
  if (!hex || hex.length % 2 || !/^[0-9a-fA-F]+$/.test(hex)) throw new Error("expected hex bytes");
  const words: string[] = [];
  let i = 0;
  for (; i + 62 <= hex.length; i += 62) words.push("0x" + hex.slice(i, i + 62));
  const pending = hex.slice(i);
  return [String(words.length), ...words, "0x" + (pending || "0"), String(pending.length / 2)];
}

const rules = (v: unknown): SenderBalanceRules => {
  if (!v || typeof v !== "object") return NEUTRAL_RULES;
  const r = v as Record<string, unknown>;
  return {
    fullRequired: Boolean(r.fullRequired),
    capped: Boolean(r.capped),
    locked: BigInt(String(r.locked ?? 0)),
    minResidual: BigInt(String(r.minResidual ?? 0)),
    residualStrict: Boolean(r.residualStrict),
  };
};

export async function handler(event: FunctionUrlEvent): Promise<unknown> {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS };
  if (method === "GET" && path.endsWith("/health")) return reply(200, { ok: true });

  const table = process.env.HV_STATE_TABLE;
  if (!table) throw new Error("missing HV_STATE_TABLE");
  const store = new DynamoStore(table, process.env.AWS_REGION);

  let body: Record<string, unknown>;
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body ?? "{}";
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return reply(400, { error: "body is not JSON" });
  }

  if (method === "POST" && path.endsWith("/cancel")) {
    try {
      const problem = await store.requestCancel(
        BigInt(String(body.orderId)),
        BigInt(String(body.makerSalt)),
      );
      return problem ? reply(400, { error: problem }) : reply(200, { ok: true });
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  }

  // TESTNET ONLY: let a tester onto the pool's allowlist. Only the request is
  // recorded here; the tick sends the transaction, so the keeper's Starknet
  // account keeps exactly one writer.
  if (method === "POST" && path.endsWith("/allowlist")) {
    const cfg = loadConfig();
    if (!cfg.openAllowlist) return reply(404, { error: "the open allowlist is off" });
    let address: bigint;
    try {
      address = parseAddress(body.address);
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
    const sn = starknetSide(cfg);
    if (await sn.isWhitelisted(address)) return reply(200, { ok: true, whitelisted: true });
    await store.putAllowlist(address);
    return reply(200, { ok: true, whitelisted: false });
  }

  // An EVM wallet's USDC, burned on Ethereum into the cash vault with its note
  // id as hook data. Relaying Circle's attested message is permissionless (the
  // vault checks it through Circle's MessageTransmitter and fills only the note
  // the burn named); an EVM wallet has no Starknet account to send it from, so
  // the keeper's account does. Sent here rather than by the tick so the user
  // waits seconds, not a schedule; a clash with the tick's nonce just fails and
  // the app asks again.
  if (method === "POST" && path.endsWith("/relay-cash")) {
    const vault = process.env.HV_CASH_VAULT;
    if (!vault) return reply(404, { error: "no cash vault configured" });
    try {
      const calldata = [...byteArrayCalldata(body.message), ...byteArrayCalldata(body.attestation)];
      const cfg = loadConfig();
      const provider = new RpcProvider({ nodeUrl: cfg.starknet.rpcUrl });
      const account = new Account({ provider, address: cfg.starknet.keeperAddress, signer: cfg.starknet.keeperKey });
      const res = await account.execute({ contractAddress: vault, entrypoint: "receive_deposit", calldata });
      return reply(200, { ok: true, txHash: res.transaction_hash });
    } catch (e) {
      return reply(400, { error: String((e as Error).message ?? e).slice(0, 400) });
    }
  }

  // The paymaster: pays a deposit's or exit's message fee (STRK) into its
  // note's credit, so the user needs no STRK. The note is checked on-chain
  // first (noteFees.ts): only an empty, unused open note of the right token,
  // and only up to the gateway's own quote. Sent here rather than by the tick
  // so the user waits seconds; a clash with the tick's nonce just fails and
  // the app asks again.
  if (method === "POST" && path.endsWith("/fund-note")) {
    const purpose = body.purpose === "deposit" || body.purpose === "exit" ? body.purpose : null;
    if (!purpose) return reply(400, { error: "purpose must be deposit or exit" });
    try {
      const noteId = BigInt(String(body.noteId));
      const amount = BigInt(String(body.amount));
      const cfg = loadConfig();
      const sn = starknetSide(cfg);
      const decision = noteFeeToFund(await sn.noteFeeFacts(noteId, purpose, amount, cfg.params.returnValue));
      if ("refuse" in decision) return reply(400, { error: decision.refuse });
      if (decision.amount === 0n) return reply(200, { ok: true, funded: "0" });
      const txHash = await sn.fundNote(noteId, decision.amount);
      return reply(200, { ok: true, funded: decision.amount.toString(), txHash });
    } catch (e) {
      return reply(400, { error: String((e as Error).message ?? e).slice(0, 400) });
    }
  }

  if (method === "POST" && path.endsWith("/openings")) {
    let opening: Opening;
    try {
      opening = {
        orderId: BigInt(String(body.orderId)),
        maker: BigInt(String(body.maker)),
        makerSalt: BigInt(String(body.makerSalt)),
        makerRules: rules(body.makerRules),
        tif: Number(body.tif ?? 2) as Opening["tif"],
        receivedAt: Date.now(),
      };
    } catch (e) {
      return reply(400, { error: `bad opening: ${(e as Error).message}` });
    }
    // The order's commitments come from the pool itself: an opening that does
    // not open them is refused, so nobody can claim someone else's order.
    const order = await starknetSide(loadConfig()).getOrder(opening.orderId);
    const problem = checkOpening(opening, {
      makerCommitment: order.makerCommitment,
      makerRulesHash: order.makerRulesHash,
    });
    if (problem) return reply(400, { error: problem });
    await store.putOpening(opening, key(opening.orderId));
    return reply(200, { ok: true });
  }

  return reply(404, { error: "not found" });
}
