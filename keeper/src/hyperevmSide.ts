// The keeper's HyperEVM side: the omnibus's reads and the keeper's
// transactions there (reports, CCTP relays, exit burns).

import { Contract, JsonRpcProvider, Wallet, type EventLog } from "ethers";

export const OMNIBUS_ABI = [
  "function report((bytes32 routeId, uint128 cumDraw, uint128 cumDeliver, bool closed)[] items)",
  "function receiveDeposit(bytes message, bytes attestation) returns (bytes32)",
  "function creditDeposit(bytes32 id)",
  "function burnExit(bytes32 id)",
  "function routes(bytes32) view returns (uint8 status, uint128 cloid, uint32 asset, bool isBuy, uint64 offerToken, uint64 wantToken, uint128 offerAmount, uint128 wantAmount, uint128 escrow, uint128 cumDraw, uint128 cumDeliver, uint64 seq)",
  "function deposits(bytes32) view returns (uint128 lzAmount6, uint128 arrived6, uint64 arrivedBlock, bool lzSeen, bool cctpSeen, bool credited)",
  "function exits(bytes32) view returns (uint128 amount8, uint8 status)",
  "function solvency(uint64 token) view returns (uint256 held, uint256 owed)",
  "event Placed(bytes32 indexed routeId, uint32 asset, bool isBuy, uint64 px, uint64 sz, uint8 tif)",
  "event PlaceRejected(bytes32 indexed routeId, bytes32 reason)",
  "event ExitRequested(bytes32 indexed exitId, uint128 amount)",
  "event ExitBurned(bytes32 indexed exitId, uint256 amountUsdc6)",
];

export interface ReportItem {
  routeId: string;
  cumDraw: bigint;
  cumDeliver: bigint;
  closed: boolean;
}

export const ROUTE_OPEN = 1n;

/** HyperEVM's `eth_getLogs` range cap. */
export const LOG_WINDOW = 50;

export class HyperEvmSide {
  readonly provider: JsonRpcProvider;
  readonly wallet: Wallet;
  readonly omnibus: Contract;

  constructor(rpcUrl: string, keeperKey: string, readonly omnibusAddress: string) {
    this.provider = new JsonRpcProvider(rpcUrl);
    this.wallet = new Wallet(keeperKey, this.provider);
    this.omnibus = new Contract(omnibusAddress, OMNIBUS_ABI, this.wallet);
  }

  blockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  /** Every `name` event in (fromBlock, toBlock], and how far it actually got.
   *
   *  HyperEVM's default RPC answers `eth_getLogs` over at most 50 blocks and
   *  rate-limits by IP, so this walks in windows of that size, retries a
   *  rate-limited window a few times, and stops after `maxWindows`. The caller
   *  advances its cursor to `scannedTo`, so a long catch-up is spread over
   *  several ticks instead of hammering the node in one. */
  async events(
    name: string,
    fromBlock: number,
    toBlock: number,
    maxWindows = 20,
  ): Promise<{ events: EventLog[]; scannedTo: number }> {
    const out: EventLog[] = [];
    let scannedTo = fromBlock;
    let windows = 0;
    for (let from = fromBlock + 1; from <= toBlock && windows < maxWindows; from += LOG_WINDOW) {
      const to = Math.min(from + LOG_WINDOW - 1, toBlock);
      let logs;
      for (let attempt = 0; ; attempt++) {
        try {
          logs = await this.omnibus.queryFilter(this.omnibus.filters[name](), from, to);
          break;
        } catch (e) {
          const rateLimited = JSON.stringify((e as { error?: unknown }).error ?? e).includes("rate limit");
          if (!rateLimited || attempt >= 3) {
            // Keep what was scanned so far: the cursor stops here and the next
            // tick resumes from it.
            if (attempt >= 3 || !rateLimited) return { events: out, scannedTo };
          }
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        }
      }
      out.push(...logs.filter((l): l is EventLog => "args" in l));
      scannedTo = to;
      windows += 1;
    }
    return { events: out, scannedTo };
  }

  async routeStatus(routeId: string): Promise<bigint> {
    return (await this.omnibus.routes(routeId)).status as bigint;
  }

  private async sent(tx: Promise<{ wait(): Promise<{ hash: string } | null> }>): Promise<string> {
    const receipt = await (await tx).wait();
    if (!receipt) throw new Error("transaction dropped");
    return receipt.hash;
  }

  report(items: ReportItem[]): Promise<string> {
    return this.sent(this.omnibus.report(items));
  }

  receiveDeposit(message: string, attestation: string): Promise<string> {
    return this.sent(this.omnibus.receiveDeposit(message, attestation));
  }

  creditDeposit(id: string): Promise<string> {
    return this.sent(this.omnibus.creditDeposit(id));
  }

  burnExit(id: string): Promise<string> {
    return this.sent(this.omnibus.burnExit(id));
  }
}
