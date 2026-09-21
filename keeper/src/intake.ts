// Where makers hand the keeper their openings. The pool publishes only a
// commitment to each maker; the exchange needs the maker's address and salt to
// prove fills (and its rules snapshot), and needs to know how the maker wants
// the order run on Hyperliquid. An opening is accepted only if it opens the
// order's on-chain commitment and rules hash, so nobody can feed the keeper an
// opening for someone else's order.
//
//   POST /openings  {"orderId","maker","makerSalt","makerRules"?,"tif"}
//   POST /cancel    {"orderId","makerSalt"}   pull a routed order back
//   POST /allowlist {"address"}               TESTNET ONLY, see below
//   GET  /health
//
// `/allowlist` exists only while HV_OPEN_ALLOWLIST is on, which is refused on
// mainnet: it puts anyone who asks on the pool's allowlist, so a tester can
// use the app without a KYC step. It only records the request — the tick sends
// the transaction, so the keeper's Starknet account keeps one writer.
//
// Browsers call this from the HyperVeil app, so it answers CORS preflights.

import { createServer, type Server } from "node:http";
import { computeMakerCommitment, hashRules, NEUTRAL_RULES, type SenderBalanceRules } from "veil-sdk";
import type { Tif } from "./hlMath.js";
import type { Opening } from "./store.js";

export interface OrderCommitments {
  makerCommitment: bigint;
  makerRulesHash: bigint;
}

/** Validates an opening against the order's on-chain commitments. */
export function checkOpening(opening: Opening, onChain: OrderCommitments): string | null {
  if (onChain.makerCommitment === 0n) return "unknown order";
  if (computeMakerCommitment(opening.maker, opening.makerSalt) !== onChain.makerCommitment) {
    return "does not open the order's maker commitment";
  }
  if (hashRules(opening.makerRules) !== onChain.makerRulesHash) return "rules snapshot does not match";
  if (![1, 2, 3].includes(opening.tif)) return "tif must be 1 (Alo), 2 (Gtc) or 3 (Ioc)";
  return null;
}

function parseRules(raw: unknown): SenderBalanceRules {
  if (!raw) return NEUTRAL_RULES;
  const r = raw as Record<string, unknown>;
  return {
    fullRequired: Boolean(r.fullRequired),
    capped: Boolean(r.capped),
    locked: BigInt(String(r.locked ?? 0)),
    minResidual: BigInt(String(r.minResidual ?? 0)),
    residualStrict: Boolean(r.residualStrict),
  };
}

/** A Starknet address from a request body, as a felt. */
export function parseAddress(raw: unknown): bigint {
  const address = BigInt(String(raw ?? 0));
  if (address <= 0n || address >= 1n << 252n) throw new Error("address is not a Starknet address");
  return address;
}

export function parseOpening(body: Record<string, unknown>): Opening {
  return {
    orderId: BigInt(String(body.orderId)),
    maker: BigInt(String(body.maker)),
    makerSalt: BigInt(String(body.makerSalt)),
    makerRules: parseRules(body.makerRules),
    tif: Number(body.tif) as Tif,
    receivedAt: Date.now(),
  };
}

export function startIntake(
  port: number,
  lookup: (orderId: bigint) => Promise<OrderCommitments>,
  accept: (opening: Opening) => void,
  cancel: (orderId: bigint, makerSalt: bigint) => string | null,
  /** TESTNET ONLY: present only while the open allowlist is on. */
  allowlist?: (address: bigint) => Promise<{ whitelisted: boolean }>,
): Server {
  const server = createServer(async (req, res) => {
    const headers = {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, headers);
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "OPTIONS") return reply(204, {});
      if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true });
      if (req.method !== "POST") return reply(404, { error: "not found" });
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (req.url === "/openings") {
        const opening = parseOpening(body);
        const problem = checkOpening(opening, await lookup(opening.orderId));
        if (problem) return reply(400, { error: problem });
        accept(opening);
        return reply(200, { ok: true });
      }
      if (req.url === "/allowlist") {
        if (!allowlist) return reply(404, { error: "the open allowlist is off" });
        return reply(200, { ok: true, ...(await allowlist(parseAddress(body.address))) });
      }
      if (req.url === "/cancel") {
        const problem = cancel(BigInt(String(body.orderId)), BigInt(String(body.makerSalt)));
        if (problem) return reply(400, { error: problem });
        return reply(200, { ok: true });
      }
      return reply(404, { error: "not found" });
    } catch (e) {
      return reply(400, { error: (e as Error).message });
    }
  });
  server.listen(port);
  return server;
}
