# HyperVeil

Private spot trading on Hyperliquid from Starknet, through Veil.

A Starknet user keeps everything in one Veil pool: real USDC (and the STRK
that pays HyperVeil's messages) as private notes, and **twins** — allowlisted
ERC-20s, one per Hyperliquid spot token (HIP-1 tokens and HyperCore USDC) —
as the balance that trades. Each twin is backed 1:1 by the real token, held on
HyperCore by a single **omnibus** contract. When a user trades, the order
first tries to cross another Veil order inside the pool. If nothing crosses,
it goes over LayerZero to the omnibus, which places it on HyperCore's spot
book from its own account; the result comes back into the user's private
notes. On Hyperliquid, every trade is the omnibus's; nothing on-chain names
the Starknet user.

Every step a user takes is one proven pool action, so there is one privacy
system, one key and one set of notes: USDC in, USDC to Hyperliquid, an order,
an exit, USDC out.

```
 Starknet                                                   Hyperliquid
 ────────                                                   ───────────
  wallet ─deposit─┐                    ┌─entry helper ──CCTP burn──▶ HyperEVM
  STRK20 ─entry───┤                    │  (invoke adapter)              │
                  ▼                    │                                ▼
            Veil pool ──invoke─────────┤            HyperVeilOmnibus (LayerZero app)
       (USDC, STRK, twins,             │              │   ▲          │
        DvP orders, notes)             │              │   │          │ CoreWriter /
                  ▲                    └─ fee adapter │   │          │ precompiles
                  │                        (STRK)     │   │          ▼
            exit vault ◀──CCTP mint──────────────────┘   │       HyperCore spot books
                  ▲                                       │     (the omnibus's account
       HyperVeilGateway ◀────────LayerZero────────────────┘      holds every twin's
      (LayerZero app + the pool's venue; also the exit adapter)   backing)
                  ▲
               keeper (the pool's exchange: crosses, routes, reports fills, relays CCTP)
```

## Status

Testnet. Deployed and exercised end to end on Starknet Sepolia and Hyperliquid
testnet; not yet on mainnet.

## Flows

**Getting USDC (and STRK) into the pool.** Either a plain Veil deposit from
the wallet — one approval, then a proven `deposit` — or, privately, one STRK20
transaction that withdraws to the **STRK20 entry** and invokes it, which fills
an open note the user created first (`create_open_note`). The same two routes
carry the STRK that pays for messages.

**Deposit (USDC to Hyperliquid).** The user creates an empty USDC-twin open
note (`create_open_note`) and prepays its DEPOSIT fee from private STRK
(`fund_note`, through the fee adapter). Then one proven pool `invoke`:
1. The pool pays the **entry helper** `amount + 1` USDC and calls it.
2. The helper calls `gateway.register_deposit`, which claims the twin note and sends DEPOSIT, paying from the STRK prepaid against that note.
3. The helper burns the USDC through CCTP to the omnibus. The deposit id is the hook data, and the omnibus is the destination caller.
4. It hands 1 unit back into the invoke's own open note (a pool invoke must return something).

On HyperEVM, the keeper relays Circle's attestation (`receiveDeposit`), which
moves the USDC to HyperCore through Circle's `CoreDepositWallet`. In a later
block, `creditDeposit` checks the HyperCore balance and sends CREDIT. The
gateway then mints the twin into the note.

**Trade.** The user posts a Veil DvP order (`post_order`): offer X for at
least Y. The user hands the keeper an **opening** (maker address, salt, rules
snapshot, and whether it should run IOC / GTC / ALO on Hyperliquid). The
keeper's intake accepts it only if it opens the order's on-chain commitments.
The keeper then:
- **Crosses** it against opposite Veil orders whose limits overlap (proven
  `execute_batch`, at the older order's price). If a new order would cross
  one already resting on Hyperliquid, the resting one is pulled back first.
  Both sit on the omnibus's single account, where self-trade prevention would
  cancel instead of fill.
- **Routes** the rest (`gateway.route_order`). The pool hands over the escrow
  (`venue_route`), the gateway burns it, and PLACE asks the omnibus for a
  HyperCore limit order. The omnibus first checks that every possible fill
  respects the Veil order's pair, escrow and limit price at the worst fee
  (`maxFeeBps`). If not, it rejects and the escrow comes straight back.
- **Reports** fills (`omnibus.report`). HyperCore fills per route become
  cumulative (draw, deliver). The omnibus bounds them, then sends FILL.
- **Applies** receipts. Each FILL mints the delivery into gateway custody as a
  receipt. The exchange's proven `venue_fill` credits it to the maker's
  receive note, with the same per-maker KYC checks as a batch.
- **Releases.** Once the route is closed and every receipt applied,
  `gateway.release` returns the unspent escrow to the order. The maker
  reclaims it privately with `cancel_order`.

Routing fees are prepaid. After posting, the maker pays STRK into the order's
credit (`gateway.fund_order`) from their private STRK, through the fee
adapter. The keeper routes an order only once its credit covers `quote_route`;
PLACE and CANCEL are paid from it.

Cancel: the maker asks the keeper, or anyone may cancel once the order has
expired (`cancel_route`). CANCEL makes the omnibus cancel by cloid. The
keeper's closing report then releases whatever was not spent.

**Exit (USDC back from Hyperliquid).**
1. The user creates an empty real-USDC open note (`create_open_note`) — the note the USDC comes back into — and prepays its WITHDRAW fee from private STRK (`fund_note`). The credit is keyed by that note, so it can only pay for the exit that fills it.
2. A proven pool `invoke` (`in_token == out_token` = the USDC twin, adapter = gateway) spends `amount + 1`. The gateway (`privacy_invoke`) burns `amount`, registers the exit in the **exit vault** against the named note, pays WITHDRAW from its credit, and returns 1 unit into the invoke's open note. The pool places that open note in the slot after the change note.
3. The omnibus moves the USDC HyperCore → HyperEVM (send-asset to USDC's system address).
4. Once it has arrived, `burnExit` burns it through CCTP to the vault, with the exit id as hook data.
5. The keeper relays the attestation (`vault.receive_exit`), and the vault fills the user's note in the same call. If the pool refuses the fill, the USDC stays in the vault, owed to that exit alone, and anyone may `retry_delivery`.

Nothing is claimed afterwards: the USDC lands as a private note the user's own
key finds. Taking it out of Veil is a separate, ordinary proven withdrawal, to
whatever address the user names.

## Trust model

The invariant: **twins never outnumber what the omnibus holds on HyperCore.**
The omnibus keeps `liability[token]`, the twins that exist or are about to.
Twins are removed from it only after they are burned on Starknet (routed
escrow, an exit). Every increase (a credit, a fill's delivery, a closing
refund) is checked against the real HyperCore balance (`spotBalance`
precompile) before the message that mints them is sent.

| Party | Can | Cannot |
|---|---|---|
| Keeper | Delay; choose which orders cross and when; misattribute fills between concurrent routes of the same token (the balance check is per token) | Mint an unbacked twin; fill a maker below their limit price; draw beyond an order's escrow; credit a maker who lost KYC (the fill proof re-checks) |
| Omnibus owner | Configure (keeper, fee bound, gas) | Move funds: the omnibus has no withdraw or rescue |
| LayerZero peer / DVNs | (assumed honest, as for any bridge) | — |
| Circle CCTP | (assumed honest) | — |

Deposits require **both** halves: the LayerZero instruction and the CCTP
USDC, from the configured entry helper. Exits are paid only from the omnibus
into the vault, for an exit the gateway registered, and only to the shadow
account the exit names.

## Wire format

Packed big-endian, kind byte first. Defined in `starknet/src/codec.cairo` and
mirrored in `evm/contracts/HyperVeilCodec.sol`; both suites pin the same hex
vectors.

| Kind | Direction | Payload |
|---|---|---|
| 1 DEPOSIT | SN → HL | deposit_id, amount (CCTP USDC, 6 dp) |
| 2 PLACE | SN → HL | route_id, cloid, asset, is_buy, px, sz, tif, offer/want token, offer/want amount, escrow |
| 3 CANCEL | SN → HL | route_id |
| 4 WITHDRAW | SN → HL | exit_id, amount (8 dp) |
| 5 CREDIT | HL → SN | deposit_id, amount (8 dp) |
| 6 FILL | HL → SN | n × (route_id, seq, cum_draw, cum_deliver, closed) |

A twin's unit is its HyperCore token's wei, so twin amounts are never
rescaled. `px`/`sz` use CoreWriter's 1e8 fixed point.

## Layout

```
hyperveil/
  starknet/   Scarb package `hyperveil` (the Veil pool is a dev-dependency, for tests)
    src/  gateway, twin, permission_manager, kyc_rules, entry_helper, exit_vault,
          fee_adapter, strk20_entry, codec, lz, bytes, interfaces, mocks
    tests/ codec (vectors), gateway (end to end with the real pool), twin
  evm/        HyperVeilOmnibus + codec + HyperCore/CCTP/LayerZero surfaces; @ethereumjs harness
  keeper/     TypeScript keeper: matcher, HL order math, fill reports, CCTP relays, intake,
              and (testnet) the open allowlist
  app/        Web app (Vite + TypeScript, Veil's site theme): trade, portfolio, deposit, withdraw
  scripts/    Deployment: both chains, wiring, DVNs, the app's and the keeper's config
  deployments/ What was deployed where (written by the scripts)
```

The pool side lives in the Veil package itself: `venue_route`,
`venue_release`, `venue_fill_derive/settle` and the route guards in
`src/VeilERC3643.cairo`, tested in `tests/test_venue.cairo`. The pool's
`invoke` also accepts `in_token == out_token` now; its open note then takes
the slot after the change note. The SDK gained `buildVenueFillDeriveCalldata`,
`VeilDvpExchange.venueFill`, and `sdk/src/hyperveil.ts`: the exit plan, order
terms, and the STRK20 actions for deposit, fee prepayment and claim.

## Web app

`app/` is the user's side. Market data (spot pairs, book, trades) comes
straight from Hyperliquid's public info API. Everything else follows the
flows above:

| Page | What it does |
|---|---|
| Trade | Market (IOC), limit (GTC) and post-only (ALO) orders. Posts the DvP order (proven), hands the keeper the opening, then prepays the route fee from STRK20 through a shadow account. Orders under 10 USDC are only crossed inside Veil. |
| Portfolio | Private balances and orders, decrypted in the browser with the Veil key. Cancel runs a proven `cancel_order`. For a routed order, it first asks the keeper to pull the order back from Hyperliquid. |
| Deposit | Adds USDC (or STRK) to Veil from the wallet or from STRK20, and sends USDC to Hyperliquid: opens the USDC-twin note (proven), prepays its fee from private STRK, then one proven invoke. On testnet it also has **Claim USDC faucet**, a link to [Circle's faucet](https://faucet.circle.com/) — 20 USDC every 2 hours on Starknet Sepolia. |
| Withdraw | Brings USDC back: opens the note it lands in (proven), prepays its fee, then one proven invoke — no claim step. Also takes USDC out of Veil to any address. "Find my withdrawals" recovers exits this browser lost track of, by matching the vault's exits against the notes the user's key owns. |

Connecting a wallet asks for one signature straight away: it derives the Veil
key, which is what finds this account's notes. Behind a button it meant
connecting and still seeing nothing (veilx and the bridge frontend made the
same change). A key already on the device needs no prompt, and declining just
leaves the Unlock button. Connecting also asks the keeper for the allowlist
while `HV_OPEN_ALLOWLIST` is on; the header says `Enabling this account…` until
the keeper's next tick has done it.

The app reads `public/deployment.json` at runtime. While it holds no
contract addresses, the app shows live markets with trading disabled. It
needs a wallet with the STRK20 wallet API (starknet.js `WalletAccountV6`).
Order openings (with their maker salts) and shadow nonces live in the
browser's storage.

```bash
cd hyperveil/app && npm install && npm run dev   # http://localhost:5176
```

## Tests

```bash
(cd hyperveil/starknet && snforge test)        # 84: codec, gateway e2e (real pool), KYC rules, twin
(cd hyperveil/evm && bash script/test.sh)      # 36: codec vectors, omnibus
(cd hyperveil/keeper && npm test)              # 39: math (with on-chain parity), fills, matcher, pipeline, allowlist
(cd hyperveil/app && npm test)                 # 6: order drafting, tick rules (parity with the keeper)
(cd sdk && npm test)                           # 62, including hyperveil.test.ts (8)
snforge test test_venue                        # 28, from the repo root: the pool's venue path
```

## Deploying

`scripts/` deploys and wires both chains, and writes the app's and the
keeper's configuration from one deployment file. The runbook, and what to have
ready before starting, is [scripts/README.md](scripts/README.md):

```bash
cd hyperveil/scripts && npm install && cp .env.example .env   # then fill it in
node deploy-hyperevm.js      # the omnibus (needs big blocks: ~18.5 KB of code)
node deploy-starknet.js      # HyperVeil's own pool, gateway, twins, adapters
node wire.js --keeper-evm 0x… --keeper-sn 0x…
node configure-dvns.js       # pin who verifies the messages
node write-config.js --prover https://… --intake http://localhost:8787 --kyc https://… --return-value <wei>
node whitelist.js --account 0x…      # put one account on the allowlist by hand
                                     # (testnet: the keeper lets anyone in anyway)
```

Every address that is not deployed by these scripts — LayerZero's endpoints
and libraries, Circle's CCTP contracts and `CoreDepositWallet`, Hyperliquid's
API — is pinned in `scripts/config.js` with its source and the date it was
read, never fetched at deploy time.

Two numbers must agree across the two configurations, and one script writes
both so they cannot drift: `fees.returnValue` (the app) = `HV_RETURN_VALUE`
(the keeper), and `fees.maxFeeBps` = `HV_MAX_FEE_BPS` = the omnibus's
`maxFeeBps`.

## Limitations

- **Fee bound.** `maxFeeBps` (10) must stay at or above Hyperliquid's worst spot fee (base taker 7 bps). If Hyperliquid ever charged more, fills could not be credited until it is raised.
- **Misattribution.** The keeper could misattribute fills between concurrent routes of one token. Solvency holds regardless; per-user fairness then rests on the keeper.
- **Scope.** Only USDC exits. A HIP-1 twin leaves by selling into USDC first, as specified.
- **Unspent fee credit.** Prepaid STRK that routing, a deposit or an exit does not use stays in `order_credit` / `note_credit`. There is no refund path; the app's headroom keeps the overpayment small.
- **Quarantines.** A credit the pool refuses waits in the gateway (`retry_credit`); an exit delivery it refuses waits in the vault (`retry_delivery`). Both are permissionless, and the keeper retries the second on its next tick.
