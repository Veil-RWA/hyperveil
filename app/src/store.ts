// What this browser remembers for a connected account: its orders (with the
// secret maker salt a cancel needs), its deposits to Hyperliquid and its
// exits. Only on this device, per chain and account.
//
// Nothing here is needed to KEEP funds: an exit pays an open note the user's
// own Veil key finds, and a deposit credits one. These records only let the
// app show progress, and a lost one is recoverable from the vault's and the
// gateway's events.

import type { Tif } from "./orders";

export interface StoredOrder {
  orderId: string;
  market: string;
  coin: string;
  asset: number;
  side: "buy" | "sell";
  kind: "market" | "limit" | "post";
  tif: Tif;
  price: string;
  size: string;
  order: {
    maker: string;
    makerSalt: string;
    offerToken: string;
    offerAmount: string;
    wantToken: string;
    wantAmount: string;
    expiry: string;
    nonce: string;
  };
  makerRules: { fullRequired: boolean; capped: boolean; locked: string; minResidual: string; residualStrict: boolean };
  createdAt: number;
  postTx?: string;
  feeFunded?: string;
  openingSent?: boolean;
  cancelRequested?: boolean;
  closed?: boolean;
}

export interface StoredDeposit {
  noteId: string;
  depositId: string;
  amountUsdc6: string;
  createdAt: number;
  txHash?: string;
}

export interface StoredExit {
  exitId?: string;
  /** The real-USDC open note in the pool this exit fills. */
  noteId: string;
  /** USDC twin units (8 dp). */
  amount: string;
  createdAt: number;
  txHash?: string;
}

interface AccountState {
  orders: StoredOrder[];
  deposits: StoredDeposit[];
  exits: StoredExit[];
  /** An empty USDC-twin open note created for a deposit not yet sent. */
  pendingDepositNote?: string;
  /** An empty USDC open note created for an exit not yet sent. */
  pendingExitNote?: string;
}

const empty = (): AccountState => ({ orders: [], deposits: [], exits: [] });

export class AccountStore {
  private readonly key: string;
  private state: AccountState;

  /** Keyed by pool as well as by account: orders, deposits and exits are the
   *  pool's, and a redeployed pool knows none of them. Without the pool in the
   *  key a new deployment inherits the last one's list and shows entries whose
   *  notes do not exist. */
  constructor(chainId: string, address: string, pool: string) {
    const felt = (v: string) => BigInt(v).toString(16);
    this.key = `hyperveil:${felt(chainId)}:${felt(pool)}:${felt(address)}`;
    this.state = this.load();
  }

  private load(): AccountState {
    try {
      const raw = localStorage.getItem(this.key);
      return raw ? { ...empty(), ...(JSON.parse(raw) as AccountState) } : empty();
    } catch {
      return empty();
    }
  }

  private save(): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.state));
    } catch {
      /* storage unavailable: the session still works, nothing survives a reload */
    }
  }

  get orders(): StoredOrder[] {
    return this.state.orders;
  }
  get deposits(): StoredDeposit[] {
    return this.state.deposits;
  }
  get exits(): StoredExit[] {
    return this.state.exits;
  }
  get pendingDepositNote(): string | undefined {
    return this.state.pendingDepositNote;
  }
  get pendingExitNote(): string | undefined {
    return this.state.pendingExitNote;
  }

  addOrder(o: StoredOrder): void {
    this.state.orders.unshift(o);
    this.save();
  }

  updateOrder(orderId: string, patch: Partial<StoredOrder>): void {
    const o = this.state.orders.find((x) => x.orderId === orderId);
    if (o) Object.assign(o, patch);
    this.save();
  }

  setPendingDepositNote(noteId: string | undefined): void {
    this.state.pendingDepositNote = noteId;
    this.save();
  }

  setPendingExitNote(noteId: string | undefined): void {
    this.state.pendingExitNote = noteId;
    this.save();
  }

  addDeposit(dep: StoredDeposit): void {
    this.state.deposits.unshift(dep);
    this.save();
  }

  addExit(e: StoredExit): void {
    this.state.exits.unshift(e);
    this.save();
  }

  updateExit(match: (e: StoredExit) => boolean, patch: Partial<StoredExit>): void {
    const e = this.state.exits.find(match);
    if (e) Object.assign(e, patch);
    this.save();
  }
}
