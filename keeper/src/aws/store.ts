// The keeper's state in DynamoDB, for the Lambda deployment.
//
// Lambda has no durable disk, so the file store cannot be used. One table
// holds four kinds of item, keyed by `pk`:
//
//   state              everything the ticker owns: cursors, orders, routes,
//                      receipts, deposits and exits, as one JSON blob
//   opening#<orderId>  one maker opening each
//   allowlist#<addr>   TESTNET ONLY: an address waiting to be let in
//   lock               who is ticking, and until when
//
// Openings are separate items on purpose. The intake (a second function, which
// browsers call) writes them while a tick may be running; if they lived in the
// blob, whichever wrote last would erase the other's work. Everything else is
// written only by the ticker, which holds the lock.
//
// Everything here except the openings can be rebuilt from the two chains. The
// openings cannot: a maker hands over their salt once, so this table is the
// only copy. That is why it must outlive any single invocation.

import {
  DynamoDBClient,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  emptyState,
  key,
  parseOpening,
  parseRequest,
  parseState,
  serializeOpening,
  serializeRequest,
  serializeState,
  takeFinishedAllowlist,
  type AllowlistRequest,
  type KeeperState,
  type Opening,
} from "../store.js";

const STATE_PK = "state";
const LOCK_PK = "lock";
const OPENING = "opening#";
const ALLOWLIST = "allowlist#";

export class DynamoStore {
  private readonly ddb: DynamoDBClient;

  constructor(
    private readonly table: string,
    region?: string,
    private readonly owner: string = `${process.pid}-${Date.now()}`,
  ) {
    this.ddb = new DynamoDBClient(region ? { region } : {});
  }

  /** Claims the ticker lock for `holdMs`, or returns false if another
   *  invocation holds it. A crashed tick's lock expires on its own. */
  async lock(holdMs: number): Promise<boolean> {
    const now = Date.now();
    try {
      await this.ddb.send(
        new PutItemCommand({
          TableName: this.table,
          Item: {
            pk: { S: LOCK_PK },
            until: { N: String(now + holdMs) },
            owner: { S: this.owner },
          },
          ConditionExpression: "attribute_not_exists(pk) OR #u < :now",
          ExpressionAttributeNames: { "#u": "until" },
          ExpressionAttributeValues: { ":now": { N: String(now) } },
        }),
      );
      return true;
    } catch (e) {
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
      throw e;
    }
  }

  /** Releases the lock, but only if this invocation still holds it. */
  async unlock(): Promise<void> {
    await this.ddb
      .send(
        new DeleteItemCommand({
          TableName: this.table,
          Key: { pk: { S: LOCK_PK } },
          ConditionExpression: "#o = :me",
          ExpressionAttributeNames: { "#o": "owner" },
          ExpressionAttributeValues: { ":me": { S: this.owner } },
        }),
      )
      .catch((e: { name?: string }) => {
        if (e.name !== "ConditionalCheckFailedException") throw e;
      });
  }

  /** The ticker's blob, plus every opening, as one `KeeperState`. */
  async load(fresh: () => KeeperState): Promise<KeeperState> {
    const got = await this.ddb.send(
      new GetItemCommand({ TableName: this.table, Key: { pk: { S: STATE_PK } }, ConsistentRead: true }),
    );
    const state = got.Item?.json?.S ? parseState(got.Item.json.S) : fresh();
    state.openings = await this.openings();
    state.allowlist = await this.allowlist();
    return state;
  }

  /** Writes the ticker's blob. Openings are left alone: the intake owns them.
   *  Allowlist requests the tick finished with are deleted here, which is the
   *  one place that knows both that they are done and how to remove them. */
  async save(state: KeeperState): Promise<void> {
    for (const address of takeFinishedAllowlist(state)) {
      await this.ddb.send(
        new DeleteItemCommand({ TableName: this.table, Key: { pk: { S: ALLOWLIST + address } } }),
      );
    }
    const { openings, allowlist, ...owned } = state;
    await this.ddb.send(
      new PutItemCommand({
        TableName: this.table,
        Item: {
          pk: { S: STATE_PK },
          json: { S: serializeState({ ...(owned as KeeperState), openings: {}, allowlist: {} }) },
          at: { N: String(Date.now()) },
        },
      }),
    );
    void openings; // written only by the intake; a tick never changes one
    void allowlist; // its own items, for the same reason
  }

  /** TESTNET ONLY: the addresses waiting to be let in. */
  async allowlist(): Promise<Record<string, AllowlistRequest>> {
    const out: Record<string, AllowlistRequest> = {};
    for (const [pk, json] of await this.scan(ALLOWLIST)) {
      out[pk.slice(ALLOWLIST.length)] = parseRequest(json);
    }
    return out;
  }

  /** TESTNET ONLY. Written by the intake, so it never rewrites what a running
   *  tick owns; the request is idempotent per address. */
  async putAllowlist(address: bigint): Promise<void> {
    await this.ddb.send(
      new PutItemCommand({
        TableName: this.table,
        Item: {
          pk: { S: ALLOWLIST + key(address) },
          json: { S: serializeRequest({ requestedAt: Date.now() }) },
        },
      }),
    );
  }

  /** Every item under one key prefix, as [pk, json] pairs. */
  private async scan(prefix: string): Promise<[string, string][]> {
    const out: [string, string][] = [];
    let last: Record<string, { S?: string }> | undefined;
    do {
      const page = await this.ddb.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "begins_with(pk, :p)",
          ExpressionAttributeValues: { ":p": { S: prefix } },
          ExclusiveStartKey: last as never,
        }),
      );
      for (const item of page.Items ?? []) {
        if (item.json?.S && item.pk?.S) out.push([item.pk.S, item.json.S]);
      }
      last = page.LastEvaluatedKey as never;
    } while (last);
    return out;
  }

  async openings(): Promise<Record<string, Opening>> {
    const out: Record<string, Opening> = {};
    for (const [pk, json] of await this.scan(OPENING)) {
      out[pk.slice(OPENING.length)] = parseOpening(json);
    }
    return out;
  }

  async putOpening(opening: Opening, id = key(opening.orderId)): Promise<void> {
    await this.ddb.send(
      new PutItemCommand({
        TableName: this.table,
        Item: { pk: { S: OPENING + id }, json: { S: serializeOpening(opening) } },
      }),
    );
  }

  /** Flags an opening as cancel-requested, without touching the rest of it. */
  async requestCancel(orderId: bigint, makerSalt: bigint): Promise<string | null> {
    const id = key(orderId);
    const got = await this.ddb.send(
      new GetItemCommand({ TableName: this.table, Key: { pk: { S: OPENING + id } }, ConsistentRead: true }),
    );
    if (!got.Item?.json?.S) return "unknown order";
    const opening = parseOpening(got.Item.json.S);
    if (opening.makerSalt !== makerSalt) return "not the maker";
    opening.cancelRequested = true;
    await this.ddb.send(
      new UpdateItemCommand({
        TableName: this.table,
        Key: { pk: { S: OPENING + id } },
        UpdateExpression: "SET #j = :j",
        ExpressionAttributeNames: { "#j": "json" },
        ExpressionAttributeValues: { ":j": { S: serializeOpening(opening) } },
      }),
    );
    return null;
  }
}

export { emptyState };
