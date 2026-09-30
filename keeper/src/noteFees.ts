// The paymaster's side of deposits and exits: the keeper pays their message
// fee (STRK) into the note's credit, so a user never needs STRK.
//
// DEPOSIT and WITHDRAW are sent by the gateway with no payer: the fee comes
// only from `note_credit(note)`, which anyone may top up (`fund_note`). The
// app asks the intake before proving; the intake checks the note on-chain and
// pays at most what the message costs. What it will fund is therefore bounded
// by what the chain says, never by what the request says:
//
//   - the note is an EMPTY open note of the right token (the USDC twin for a
//     deposit, real USDC for an exit), i.e. one that is about to receive;
//   - no deposit / exit has used that note yet;
//   - the amount is the gateway's own quote plus headroom, less the credit
//     the note already has. A covered note gets nothing more.

import { EMPTY_OPEN_NOTE } from "veil-sdk";

export type NoteFeePurpose = "deposit" | "exit";

/** What the chain says about the note, read just before deciding. */
export interface NoteFeeFacts {
  /** The token of the note's open-note record (0 when it is not an open note). */
  openNoteToken: bigint;
  /** The note's stored value: `EMPTY_OPEN_NOTE` until the open note is filled. */
  noteValue: bigint;
  /** USDC twin (deposit) or real USDC (exit). */
  expectedToken: bigint;
  /** The deposit / exit id already registered against the note (0 if none). */
  used: bigint;
  /** STRK already credited to the note. */
  credit: bigint;
  /** The gateway's quote for the message, in STRK. */
  quote: bigint;
}

/** Same headroom the app puts on a quote (fees.headroomPct): the price can
 *  move between funding and the proof landing. */
export const NOTE_FEE_HEADROOM_PCT = 30n;

/** STRK to pay into the note's credit (0: nothing to pay), or why not. */
export function noteFeeToFund(f: NoteFeeFacts): { amount: bigint } | { refuse: string } {
  if (f.openNoteToken === 0n || f.openNoteToken !== f.expectedToken) {
    return { refuse: "not an open note for this purpose" };
  }
  if (f.noteValue !== EMPTY_OPEN_NOTE) return { refuse: "the open note is not empty" };
  if (f.used !== 0n) return { refuse: "the note is already used" };
  if (f.quote === 0n || f.credit >= f.quote) return { amount: 0n };
  const target = f.quote + (f.quote * NOTE_FEE_HEADROOM_PCT) / 100n + 1n;
  return { amount: target - f.credit };
}
