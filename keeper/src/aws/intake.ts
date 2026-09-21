// The keeper's intake, as a Lambda behind a Function URL. The app posts here:
//
//   POST /openings  {orderId, maker, makerSalt, makerRules?, tif}
//   POST /cancel    {orderId, makerSalt}
//   POST /allowlist {address}   TESTNET ONLY (HV_OPEN_ALLOWLIST)
//   GET  /health
//
// Same checks as the long-running intake: an opening is accepted only if it
// opens the order's on-chain commitments, and a cancel only from whoever knows
// the order's maker salt. It writes single opening items, so it never races
// the ticker, which owns the rest of the state.
//
// Browsers call this directly, so it answers CORS preflights.

import { NEUTRAL_RULES, type SenderBalanceRules } from "veil-sdk";
import { loadConfig } from "../config.js";
import { checkOpening, parseAddress } from "../intake.js";
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

/** The intake never sends a transaction — the tick does — so the key here is
 *  only what the account object wants for the reads they share. */
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
