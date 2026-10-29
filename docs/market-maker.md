# Market maker: CSD ↔ USDC with ~one CSD block of waiting

The confirmation wait in `aon:csd-usdc` protects one party: whoever locked
USDC against a faked CSD payment. A market maker on the other side of every
trade carries that wait (or waives it) so the user doesn't have to. No
consensus change, no custody: the market maker is just a trader with CSD and
USDC who runs a bot.

## The two directions

### User buys CSD (market maker sells)

1. The market maker publishes a `csd_sell_offer` (price, size, its USDC
   address).
2. The user signs a `CsdUsdcAuthorization` against it: their USDC for
   `csdAmount` CSD paid to a *fresh* CSD address of their own
   (`sellerCsdScriptHash` is the address the CSD must be paid **to**), plus
   two more signatures that cost nothing:
   - an **address proof**: the CSD key behind that address signs the
     authorization hash (`csdAddressProof` in `src/csd-wallet.ts`). The
     contract allows one open trade per CSD address and only lets the
     address's owner open one, so nobody can reserve someone else's address;
   - a **USDC permit** (EIP-2612), so the user needs no approval transaction
     and no ETH: the market maker submits `lockCsdUsdcAuthorizationWithPermit`
     and pays the gas (it's paid back through `executorFeeAmount`).
3. The bot sees the lock, checks the difficulty the user signed
   (`csdMaxTarget`) is comfortably below the real one (otherwise real blocks
   might not qualify and the payment could never be proven), and
   **immediately** sends the CSD to the user's address. The user has CSD in their wallet after one CSD block (~2 min).
4. The bot waits for `minConfirmations`, publishes the proof, and settles
   (`settleCsdUsdc`). Only the market maker waits here.

Because only the market maker waits, users can be offered deeper
confirmations (say 20 instead of 3) at no cost to their experience. That
makes faking the payment that much more expensive; the 30 USDC per-trade cap
stays the same.

**The UI should show "CSD received" as soon as the payment is in a block**,
not "waiting for 3 confirmations".

### User sells CSD (market maker buys)

1. The market maker publishes a `csd_buy_offer` (price, size, limits).
2. The user publishes a `csd_sell_request` against it: amount, and the
   address their USDC should go to.
3. The bot signs a `CsdUsdcAuthorization` as the **buyer**, with a **fresh
   CSD address of its own** as the payment address and `csdMaxTarget` at
   3/4 of the current CSD difficulty, and locks its USDC.
4. The user sends the CSD to that address.
5. When the payment has `EARLY_RELEASE_CONFIRMATIONS` (default 1), the bot
   signs a `CsdUsdcEarlyRelease` naming that payment's txid, the current lock
   and a short deadline, and submits `releaseEarly`. The user gets
   USDC right away; the bot carries the risk that the CSD payment is
   reversed, and prices that into its quote.
6. If anything looks wrong, the bot simply doesn't release: the user's proof
   still settles the trade after `minConfirmations`, as today.

## Rules the bot must follow before signing an early release

- **A fresh CSD address per trade.** Then a payment to that address can only
  be for that trade: no old payment and no payment meant for another trade
  can be mistaken for it. (The contract doesn't check payment age for early
  releases; the bot is the one choosing to trust the payment. It does use up
  the txid named in the release, so that payment can't also settle another
  trade.)
- **Payment found in a block** (not just the mempool) with at least
  `EARLY_RELEASE_CONFIRMATIONS` confirmations, paying at least `csdAmount`.
- **The USDC lock is still active** (`usdcLocked(authHash)`), the
  authorization is the bot's own, and it hasn't released it before.
- **Exposure limits:** a max per trade, and a max total value released early
  that hasn't yet reached `minConfirmations`. Above that, the bot waits for
  the normal proof instead.

## Running one

`examples/market-maker.ts` is a skeleton of the loop above. It needs:

- a CSD node with the HTTP API (`/tip`, `/tx/:id`, `/utxos/:addr20`,
  `/address/:addr20/activity`, `/tx/submit`); `src/csd-wallet.ts` builds,
  signs and submits CSD payments and makes fresh addresses (no CLI needed);
- an EVM RPC and a key holding USDC (and a little ETH for gas);
- an AON node URL.

The pricing (what to quote) is deliberately left open: CSD has no external
price feed, so the market maker sets its own spread around a price it
chooses.
