// Carrying messages between the chains when LayerZero cannot — TESTNET ONLY.
//
// LayerZero has not enabled the HyperEVM testnet <-> Starknet Sepolia pathway,
// so on testnet both sides are deployed against a relay endpoint instead
// (`HyperVeilRelayEndpoint` on each chain). Those endpoints record what an app
// sends as a `RelayOut` event and hand inbound messages to their receiver.
// This module is what moves one to the other.
//
// The contracts are unchanged: the gateway and the omnibus speak the same
// endpoint interface either way. On mainnet the real endpoint is used, this
// module is switched off (`HV_RELAY` unset), and nothing here runs.
//
// What this means for trust, plainly: while it is on, the keeper can make
// either side believe anything the other could have said. That is what
// LayerZero's DVNs are for, and why this is testnet only.

import { ethers, type EventLog } from "ethers";
import type { HyperEvmSide } from "./hyperevmSide.js";
import type { StarknetSide } from "./starknetSide.js";

export const RELAY_ENDPOINT_ABI = [
  "function deliver(address receiver, uint32 srcEid, bytes32 sender, bytes message)",
  "function sentCount() view returns (uint64)",
  "event RelayOut(uint64 indexed nonce, address indexed sender, uint32 dstEid, bytes32 receiver, bytes message, bytes options)",
];

export interface RelayConfig {
  /** The relay endpoint on Starknet (the gateway's endpoint). */
  starknetEndpoint: string;
  /** The relay endpoint on HyperEVM (the omnibus's endpoint). */
  evmEndpoint: string;
  starknetEid: number;
  evmEid: number;
}

export interface RelayState {
  /** Last `RelayOut` nonce carried from Starknet to HyperEVM. */
  snNonce: number;
  /** Last `RelayOut` nonce carried from HyperEVM to Starknet. */
  evmNonce: number;
  /** Starknet block scanned up to. */
  snBlock: number;
  /** HyperEVM block scanned up to. */
  evmBlock: number;
  /** Failed attempts per message ("sn:12", "evm:3"). A message the far side
   *  refuses would otherwise be retried for ever, and nothing behind it would
   *  move; after `MAX_ATTEMPTS` it is skipped, loudly. */
  failures?: Record<string, number>;
}

/** How many times one message may fail before the relay moves past it. */
const MAX_ATTEMPTS = 3;

const hex = (v: bigint | number): string => "0x" + BigInt(v).toString(16);
const word = (v: string): string => "0x" + BigInt(v).toString(16).padStart(64, "0");

/** Cairo serializes a `ByteArray` as: full-word count, that many 31-byte
 *  words, the pending word, then its length. */
export function decodeByteArray(felts: bigint[], at: number): { bytes: Uint8Array; next: number } {
  const full = Number(felts[at]);
  const out: number[] = [];
  const push = (value: bigint, size: number) => {
    const b = ethers.getBytes(ethers.zeroPadValue(ethers.toBeHex(value), size));
    out.push(...b);
  };
  for (let i = 0; i < full; i++) push(felts[at + 1 + i], 31);
  const pendingLen = Number(felts[at + 2 + full]);
  if (pendingLen > 0) push(felts[at + 1 + full], pendingLen);
  return { bytes: Uint8Array.from(out), next: at + 3 + full };
}

/** The `RelayOut` events the Starknet endpoint emitted in (from, to]. */
async function starknetOutbound(
  sn: StarknetSide,
  endpoint: string,
  fromBlock: number,
  toBlock: number,
): Promise<Array<{ nonce: number; message: Uint8Array }>> {
  const events = await sn.events(endpoint, "RelayOut", fromBlock, toBlock);
  return events.map((e) => {
    // keys: [selector, nonce, sender]; data: [dst_eid, receiver(u256), message, options]
    const nonce = Number(e.keys[1]);
    const { bytes } = decodeByteArray(e.data, 3);
    return { nonce, message: bytes };
  });
}

export class Relay {
  private readonly evmEndpoint: ethers.Contract;

  constructor(
    private readonly sn: StarknetSide,
    private readonly evm: HyperEvmSide,
    private readonly cfg: RelayConfig,
    private readonly log: (msg: string) => void = console.log,
  ) {
    this.evmEndpoint = new ethers.Contract(cfg.evmEndpoint, RELAY_ENDPOINT_ABI, evm.wallet);
  }

  /** Carries everything waiting in both directions. Idempotent: each side's
   *  last nonce is remembered, and the receiving contracts drop a message they
   *  have already applied. */
  async carry(state: RelayState): Promise<void> {
    await this.starknetToHyperEvm(state);
    await this.hyperEvmToStarknet(state);
  }

  private async starknetToHyperEvm(state: RelayState): Promise<void> {
    const to = await this.sn.blockNumber();
    if (to <= state.snBlock) return;
    const out = await starknetOutbound(this.sn, this.cfg.starknetEndpoint, state.snBlock, to);
    for (const m of out) {
      if (m.nonce <= state.snNonce) continue;
      try {
        const tx = await this.evmEndpoint.deliver(
          this.evm.omnibusAddress,
          this.cfg.starknetEid,
          word(this.sn.gateway),
          ethers.hexlify(m.message),
        );
        await tx.wait();
        state.snNonce = m.nonce;
        this.log(`relayed Starknet -> HyperEVM #${m.nonce}: ${tx.hash}`);
      } catch (e) {
        if (!this.giveUp(state, `sn:${m.nonce}`, e as Error)) return;
        state.snNonce = m.nonce;
      }
    }
    state.snBlock = to;
  }

  private async hyperEvmToStarknet(state: RelayState): Promise<void> {
    const to = await this.evm.blockNumber();
    if (to <= state.evmBlock) return;
    // Same 50-block windows the omnibus scan uses.
    const { events, scannedTo } = await this.evmEvents(state.evmBlock, to);
    for (const e of events) {
      const nonce = Number(e.args.nonce as bigint);
      if (nonce <= state.evmNonce) continue;
      const message = ethers.getBytes(e.args.message as string);
      try {
        const tx = await this.sn.relayDeliver(
          this.cfg.starknetEndpoint,
          this.sn.gateway,
          this.cfg.evmEid,
          this.evm.omnibusAddress,
          message,
        );
        state.evmNonce = nonce;
        this.log(`relayed HyperEVM -> Starknet #${nonce}: ${tx}`);
      } catch (e2) {
        if (!this.giveUp(state, `evm:${nonce}`, e2 as Error)) return;
        state.evmNonce = nonce;
      }
    }
    state.evmBlock = scannedTo;
  }

  /** Records a failed delivery. Returns true once this message has failed
   *  often enough to be skipped — the alternative is a stuck relay. */
  private giveUp(state: RelayState, id: string, error: Error): boolean {
    state.failures ??= {};
    const n = (state.failures[id] ?? 0) + 1;
    state.failures[id] = n;
    const reason = error.message.split("\n")[0].slice(0, 160);
    if (n < MAX_ATTEMPTS) {
      this.log(`relay ${id} failed (${n}/${MAX_ATTEMPTS}), will retry: ${reason}`);
      return false;
    }
    this.log(`relay ${id} FAILED ${n} times, skipping it: ${reason}`);
    delete state.failures[id];
    return true;
  }

  private async evmEvents(
    fromBlock: number,
    toBlock: number,
    maxWindows = 20,
  ): Promise<{ events: EventLog[]; scannedTo: number }> {
    const out: EventLog[] = [];
    let scannedTo = fromBlock;
    let windows = 0;
    for (let from = fromBlock + 1; from <= toBlock && windows < maxWindows; from += 50) {
      const end = Math.min(from + 49, toBlock);
      try {
        const logs = await this.evmEndpoint.queryFilter(this.evmEndpoint.filters.RelayOut(), from, end);
        out.push(...logs.filter((l): l is EventLog => "args" in l));
      } catch {
        return { events: out, scannedTo };
      }
      scannedTo = end;
      windows += 1;
    }
    return { events: out, scannedTo };
  }
}

export const emptyRelayState = (snBlock: number, evmBlock: number): RelayState => ({
  snNonce: 0,
  evmNonce: 0,
  snBlock,
  evmBlock,
});

export { hex };
