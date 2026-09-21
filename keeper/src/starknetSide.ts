// The keeper's Starknet side: reads of the Veil pool and the HyperVeil
// gateway / exit vault, and the few transactions the keeper sends there
// (route, cancel, release, relay an exit). Plain calls with hand-built
// calldata, so it needs no ABI artifacts; the layouts are the Cairo structs'
// Serde order (hyperveil/starknet/src).

import { Account, RpcProvider, hash, type Call } from "starknet";

export interface OrderRecord {
  makerCommitment: bigint;
  offerToken: bigint;
  wantToken: bigint;
  offerAmount: bigint;
  wantAmount: bigint;
  escrowRemaining: bigint;
  received: bigint;
  receiveNoteId: bigint;
  expiry: number;
  status: number;
  makerRulesHash: bigint;
}

export interface GatewayRoute {
  orderId: bigint;
  status: number; // 0 none, 1 open, 2 closed, 3 released
  escrow: bigint;
  cumDraw: bigint;
  cumDeliver: bigint;
  seq: bigint;
  pendingReceipts: number;
  cancelRequested: boolean;
}

export interface ChainEvent {
  keys: bigint[];
  data: bigint[];
  txHash: string;
  block: number;
}

const felts = (r: string[]): bigint[] => r.map((x) => BigInt(x));
const hex = (v: bigint | number): string => "0x" + BigInt(v).toString(16);
const u256 = (v: bigint): string[] => [hex(v & ((1n << 128n) - 1n)), hex(v >> 128n)];

/** Cairo `ByteArray` Serde of raw bytes: full 31-byte words, pending word, length. */
export function byteArrayCalldata(bytes: Uint8Array): string[] {
  const full = Math.floor(bytes.length / 31);
  const out: string[] = [hex(full)];
  const word = (from: number, to: number) => {
    let v = 0n;
    for (let i = from; i < to; i++) v = (v << 8n) | BigInt(bytes[i]);
    return hex(v);
  };
  for (let i = 0; i < full; i++) out.push(word(i * 31, i * 31 + 31));
  out.push(word(full * 31, bytes.length), hex(bytes.length - full * 31));
  return out;
}

export class StarknetSide {
  readonly provider: RpcProvider;
  readonly account: Account;

  constructor(
    rpcUrl: string,
    keeperAddress: string,
    keeperKey: string,
    readonly pool: string,
    readonly gateway: string,
    readonly entryHelper: string,
    readonly exitVault: string,
    readonly strk: string,
    /** TESTNET ONLY (HV_OPEN_ALLOWLIST): the pool's allowlist, so the keeper
     *  can put a tester on it. Empty when that mode is off. */
    readonly permissionManager: string = "",
  ) {
    this.provider = new RpcProvider({ nodeUrl: rpcUrl });
    this.account = new Account({ provider: this.provider, address: keeperAddress, signer: keeperKey });
  }

  private async call(contractAddress: string, entrypoint: string, calldata: string[] = []): Promise<bigint[]> {
    return felts(await this.provider.callContract({ contractAddress, entrypoint, calldata }));
  }

  async send(calls: Call[]): Promise<string> {
    const { transaction_hash } = await this.account.execute(calls);
    await this.provider.waitForTransaction(transaction_hash);
    return transaction_hash;
  }

  /** Whether the permission manager lets `account` hold HyperVeil assets. */
  async isWhitelisted(account: bigint | string): Promise<boolean> {
    if (!this.permissionManager) throw new Error("no permission manager configured");
    return (await this.call(this.permissionManager, "is_whitelisted", [hex(BigInt(account))]))[0] === 1n;
  }

  /** TESTNET ONLY: puts accounts on the allowlist. The keeper's Starknet
   *  account is the permission manager's whitelister on this deployment. */
  whitelist(accounts: (bigint | string)[]): Promise<string> {
    if (!this.permissionManager) throw new Error("no permission manager configured");
    const list = accounts.map((a) => hex(BigInt(a)));
    return this.send([
      { contractAddress: this.permissionManager, entrypoint: "whitelist", calldata: [hex(list.length), ...list] },
    ]);
  }

  async blockNumber(): Promise<number> {
    return (await this.provider.getBlockNumber()) as number;
  }

  async getOrder(orderId: bigint): Promise<OrderRecord> {
    const f = await this.call(this.pool, "get_order", [hex(orderId)]);
    return {
      makerCommitment: f[0],
      offerToken: f[4],
      wantToken: f[5],
      offerAmount: f[6],
      wantAmount: f[7],
      escrowRemaining: f[8],
      received: f[9],
      receiveNoteId: f[10],
      expiry: Number(f[11]),
      status: Number(f[12]),
      makerRulesHash: f[13],
    };
  }

  async isRouted(orderId: bigint): Promise<boolean> {
    return (await this.call(this.pool, "get_venue_route", [hex(orderId)]))[0] !== 0n;
  }

  async coreTokenOf(twin: bigint): Promise<bigint> {
    return (await this.call(this.gateway, "core_token_of", [hex(twin)]))[0];
  }

  async currentRoute(orderId: bigint): Promise<bigint> {
    return (await this.call(this.gateway, "current_route", [hex(orderId)]))[0];
  }

  async routeOf(routeId: bigint): Promise<GatewayRoute> {
    const f = await this.call(this.gateway, "route_of", [hex(routeId)]);
    return {
      orderId: f[0],
      status: Number(f[1]),
      escrow: f[2],
      cumDraw: f[3],
      cumDeliver: f[4],
      seq: f[5],
      pendingReceipts: Number(f[6]),
      cancelRequested: f[9] !== 0n,
    };
  }

  async orderCredit(orderId: bigint): Promise<bigint> {
    const [low, high] = await this.call(this.gateway, "order_credit", [hex(orderId)]);
    return low + (high << 128n);
  }

  async quoteRoute(
    orderId: bigint,
    hl: { asset: number; isBuy: boolean; px: bigint; sz: bigint; tif: number },
    returnValue: bigint,
  ): Promise<bigint> {
    const args = [hex(orderId), hex(hl.asset), hl.isBuy ? "0x1" : "0x0", hex(hl.px), hex(hl.sz), hex(hl.tif)];
    return (await this.call(this.gateway, "quote_route", [...args, hex(returnValue)]))[0];
  }

  async receiptPending(receiptId: bigint): Promise<boolean> {
    return (await this.call(this.gateway, "receipt_of", [hex(receiptId)]))[4] !== 0n;
  }

  /** Every event `name` emitted by `address` in (fromBlock, toBlock]. */
  async events(address: string, name: string, fromBlock: number, toBlock: number): Promise<ChainEvent[]> {
    const out: ChainEvent[] = [];
    let continuation_token: string | undefined;
    do {
      const page = await this.provider.getEvents({
        address,
        keys: [[hash.getSelectorFromName(name)]],
        from_block: { block_number: fromBlock + 1 },
        to_block: { block_number: toBlock },
        chunk_size: 500,
        continuation_token,
      });
      for (const e of page.events) {
        out.push({ keys: felts(e.keys), data: felts(e.data), txHash: e.transaction_hash, block: e.block_number ?? 0 });
      }
      continuation_token = page.continuation_token;
    } while (continuation_token);
    return out;
  }

  // ── Keeper transactions ──────────────────────────────────────────────────

  /** Routes an order. The fee comes from the order's prepaid credit; the
   *  approval covers the quote in case the credit fell short since checked. */
  async routeOrder(
    orderId: bigint,
    hl: { asset: number; isBuy: boolean; px: bigint; sz: bigint; tif: number },
    returnValue: bigint,
  ): Promise<string> {
    const args = [hex(orderId), hex(hl.asset), hl.isBuy ? "0x1" : "0x0", hex(hl.px), hex(hl.sz), hex(hl.tif)];
    const fee = (await this.call(this.gateway, "quote_route", [...args, hex(returnValue)]))[0];
    return this.send([
      { contractAddress: this.strk, entrypoint: "approve", calldata: [this.gateway, ...u256(fee)] },
      { contractAddress: this.gateway, entrypoint: "route_order", calldata: [...args, hex(returnValue), ...u256(fee), ...u256(0n)] },
    ]);
  }

  async cancelRoute(orderId: bigint, returnValue: bigint): Promise<string> {
    const fee = (await this.call(this.gateway, "quote_cancel", [hex(orderId), hex(returnValue)]))[0];
    return this.send([
      { contractAddress: this.strk, entrypoint: "approve", calldata: [this.gateway, ...u256(fee)] },
      { contractAddress: this.gateway, entrypoint: "cancel_route", calldata: [hex(orderId), hex(returnValue), ...u256(fee), ...u256(0n)] },
    ]);
  }

  release(orderId: bigint): Promise<string> {
    return this.send([{ contractAddress: this.gateway, entrypoint: "release", calldata: [hex(orderId)] }]);
  }

  /** An exit's status in the vault: 1 registered, 2 funded (its USDC arrived
   *  but the note is not filled yet), 3 delivered. */
  async exitStatus(exitId: bigint): Promise<number> {
    return Number((await this.call(this.exitVault, "exit_of", [hex(exitId)]))[3]);
  }

  retryDelivery(exitId: bigint): Promise<string> {
    return this.send([
      { contractAddress: this.exitVault, entrypoint: "retry_delivery", calldata: [hex(exitId)] },
    ]);
  }

  /** TESTNET ONLY (see relay.ts): hands `message` to `receiver` through the
   *  relay endpoint, as coming from `sender` on `srcEid`. */
  relayDeliver(
    endpoint: string,
    receiver: string,
    srcEid: number,
    sender: string,
    message: Uint8Array,
  ): Promise<string> {
    return this.send([
      {
        contractAddress: endpoint,
        entrypoint: "deliver",
        calldata: [receiver, hex(srcEid), ...u256(BigInt(sender)), ...byteArrayCalldata(message)],
      },
    ]);
  }

  receiveExit(message: Uint8Array, attestation: Uint8Array): Promise<string> {
    return this.send([
      {
        contractAddress: this.exitVault,
        entrypoint: "receive_exit",
        calldata: [...byteArrayCalldata(message), ...byteArrayCalldata(attestation)],
      },
    ]);
  }
}
