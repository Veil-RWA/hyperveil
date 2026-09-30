// The paymaster pays a deposit's or exit's message fee into its note's
// credit — but only for a note about to receive, and only what the message
// costs. Anything the chain does not vouch for is refused.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EMPTY_OPEN_NOTE } from "veil-sdk";
import { noteFeeToFund, type NoteFeeFacts } from "../src/noteFees.js";

const USDC_TWIN = 0x7717n;
const facts = (over: Partial<NoteFeeFacts> = {}): NoteFeeFacts => ({
  openNoteToken: USDC_TWIN,
  noteValue: EMPTY_OPEN_NOTE,
  expectedToken: USDC_TWIN,
  used: 0n,
  credit: 0n,
  quote: 1000n,
  ...over,
});

test("an empty, unused open note gets the quote plus headroom", () => {
  assert.deepEqual(noteFeeToFund(facts()), { amount: 1301n });
});

test("only what the note's credit does not already cover", () => {
  assert.deepEqual(noteFeeToFund(facts({ credit: 400n })), { amount: 901n });
  assert.deepEqual(noteFeeToFund(facts({ credit: 1000n })), { amount: 0n });
});

test("a message that costs nothing is not paid for", () => {
  assert.deepEqual(noteFeeToFund(facts({ quote: 0n })), { amount: 0n });
});

test("a note of another token, or no open note at all, is refused", () => {
  assert.ok("refuse" in noteFeeToFund(facts({ openNoteToken: 0x5555n })));
  assert.ok("refuse" in noteFeeToFund(facts({ openNoteToken: 0n, expectedToken: 0n })));
});

test("a filled note, or one a deposit or exit already used, is refused", () => {
  assert.ok("refuse" in noteFeeToFund(facts({ noteValue: 123n })));
  assert.ok("refuse" in noteFeeToFund(facts({ used: 0xabcn })));
});
