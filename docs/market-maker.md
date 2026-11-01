# Market maker: instant CSD ↔ USDC

`src/market-maker.ts` is an always-available counterparty for the CSD/USDC
market on covenant.market, and **anyone can run one**: the market is open
(see "Run your own" below). With it, trades feel like an ordinary swap: about
one Ethereum block (~12 s) in either direction, with no CSD confirmations to
wait for and no ETH needed by the user. No consensus change and no custody of
user funds: the bot is a trader with a key, CSD and USDC.

## Price

The bot's price is its pool: **USDC held ÷ CSD held**, plus a spread (3% by
default), like a constant-product AMM (`src/pool.ts`). Buys move the price up
and sells move it down, so there's no price to set or update by hand, and the
pool can't be drained at a stale price. If CSD also trades elsewhere,
arbitrage keeps the two prices close. The starting ratio is the starting
price: 150 USDC + 1,000 CSD starts at 0.15 USDC per CSD.

## The two directions

### User buys CSD

1. The site signs three things with the user's wallet, all free:
   - the `CsdUsdcAuthorization` (USDC for `csdAmount` CSD paid to the user's
     in-site CSD address);
   - a USDC **permit** (EIP-2612), so no approval transaction and no ETH;
   - an **address proof**: the user's CSD key signs the authorization hash, so
     nobody can open trades on someone else's address.
2. The site publishes this on AON as an `authorization` object referencing
   the bot's signed offer; the bot answers with a signed `response`. The bot checks the price against its pool, submits
   `lockCsdUsdcAuthorizationWithPermit` (paying the gas) and sends the CSD
   **as soon as the USDC is locked on-chain** (about one Ethereum block). It
   checks the contract, not its own transaction: if someone else submitted the
   same lock first it still sends; if the lock never happened it sends nothing.
   The permit lasts 5 minutes, so a signed buy can't be used later.
3. After the user's chosen confirmations (10–30; the site uses 20, signed at
   the live CSD difficulty so a faked proof costs more than the trade), the bot proves its payment
   with `settleCsdUsdc` and receives the USDC. If it never does, the user's
   USDC is refunded. **The user takes no risk**; only the bot waits.

### User sells CSD

1. The seller's `request` object on AON (referencing the bot's offer, signed
   with the CSD keys that own the coins): the bot locks its USDC for the trade, against a fresh
   CSD address of its own (with its own address proof), requiring 20
   confirmations to prove a payment, which makes faking one expensive (it
   releases early anyway). The seller names the exact confirmed coins they'll
   pay with and signs for them with their keys; those coins can't back another
   sale meanwhile, and if the sale is left unpaid they can't open one for a day.
   The price is fixed at this point, the seller has 3 minutes to pay, and the
   pool only moves once the payment is in a CSD block. At most 3 sales wait at
   once, one per client, and if 2 go unpaid in an hour (or 10 in a day) sales
   pause, since each unpaid sale costs the bot two transactions.
2. The site recomputes the trade hash from the returned authorization and
   checks on-chain that the USDC is locked, paying the user, for this amount.
3. The in-site wallet signs the CSD payment and publishes it on AON as a
   `payment` object (referencing the bot's authorization for the sale), and
   broadcasts it itself too. The bot checks it
   spends confirmed coins not already spent in the mempool and pays a real
   fee, broadcasts it and immediately submits `releaseEarly`: **the user has
   USDC after about one Ethereum block**, with no CSD block mined. If the bot
   disappears instead, the site's "Claim" button settles the sale with a proof
   of the payment, so the user takes no risk here either.
4. The bot carries the risk that the CSD payment is double-spent. Instant
   releases are limited: 60 USDC in flight (`MAX_INSTANT_USDC`), 30 USDC per
   hour per recipient, and none at all once recorded losses reach
   `MAX_LOSS_USDC` (default 30). Otherwise it waits for one CSD block. A
   double-spend is detected and recorded as a loss in the state file. List
   more of your CSD nodes in `CSD_BROADCAST_APIS` so payments reach the
   network from several places.

## Trading happens on AON

Every step is a public object in the `aon:csd-usdc` namespace
(`src/aon-client.ts` builds and reads them):

| object | from | references |
|---|---|---|
| `offer` (sell CSD / buy CSD) | market maker, signed | the maker's previous offer on that side |
| `authorization` (a buy) | buyer, EIP-712 | the offer |
| `request` (a sale) | seller, signed by the coins' CSD keys | the offer |
| `authorization` (the sale's lock) | market maker | the request |
| `payment` (the seller's CSD transaction) | seller | the maker's authorization |
| `response` | market maker, signed | the object it answers |
| `release`, `proof`, `receipt` | market maker (receipts signed) | the trade's objects |

Anyone can publish anything to AON, so the bot only spends effort on objects
that prove something for free first (signatures; for sales, keys that own the
coins; for payments, the sale's own seller), keeps separate queues for
payments, buys and sales, and serves known traders first.

The bot's small HTTP API is read-only: `GET /api/market` (pool, book, recent
trades, its current offer hashes) and `GET /api/trade/:authHash`, plus a proxy
to its CSD node for the in-site wallet (`/api/csd/tip`, `/utxos/:addr`,
`/block/height/:h`, `/proof/tx/:txid` for sales' payments, `POST /api/csd/tx/submit`).

## Run your own

The market is open: there is no list of approved market makers. covenant.market
finds every maker's signed offers on AON, merges them into one order book and
sends each trade to the best price. A user never has to trust a maker: a buyer's
USDC only reaches the maker with a proof that the CSD was paid, and a seller's
CSD only leaves their wallet once the maker's USDC is locked for them.

To be a market maker you need a CSD node, an Ethereum RPC, an AON node (or
several) to read and publish on, Node 20, and your own funds:

- **Both sides** (default): CSD and USDC, and the pool ratio is your price.
- **Sell only** (`SIDES=sell`), e.g. a miner selling what they mine: just CSD
  (and ETH for gas). `POOL_USDC` is then only a price setting (POOL_USDC ÷
  POOL_CSD is your starting price); USDC arrives as you sell.
- **Buy only** (`SIDES=buy`): just USDC.

### Selling only, at your price (CSD and no USDC)

Say you mined 50,000 CSD and want to sell it for at least 0.20 USDC each, with no
USDC to start with. A sell-only maker does that:

```bash
SIDES=sell
POOL_CSD=50000      # what you're selling
POOL_USDC=10000     # 50,000 × 0.20: only sets your floor price; no USDC needed
```

- **No USDC needed.** A sell-only maker never pays out USDC: buyers lock theirs, it
  sends them CSD, and it's paid with a proof. Its USDC balance is only ever checked
  when it buys CSD, which it doesn't. `POOL_USDC` is just a number that sets the price.
- **It never sells below your floor.** Only buyers trade with it, and every buy moves
  its price up. It starts at 0.20 plus the spread (`SPREAD_BPS`, 3% by default).
- **It climbs as it sells.** The price after selling a share *s* of `POOL_CSD` is the
  floor ÷ (1 − *s*)²: about +23% after a tenth, ×1.8 after a quarter, ×4 after half.
  So the bigger `POOL_CSD` is next to what sells, the flatter your price. If the
  market's price rises past yours, the buyers come to you first; if it falls below
  your floor, they don't, and you simply wait.
- **To lower it later** (say you'll accept 0.18 after all), stop the bot and run
  `--set-price 0.18`; to raise it, the same with a higher price.
- **You need a little ETH** (start with about 0.05): the bot sends each sale's
  Ethereum transactions (locking the buyer's USDC with their permit, then settling
  with the proof). The fee it charges each trade (`FEE_USDC`, 0.25 USDC by default)
  pays for that over time.
- **The CSD goes in the bot's CSD address** (`--addresses` prints it); the bot splits
  it into pieces so it can pay several buyers within one CSD block.

The USDC it earns accumulates in its Ethereum address; send it on whenever you like.

What the site checks, since it doesn't trust any maker:

- **Proven makers get the orders.** A maker counts once a trade of theirs has
  settled on Ethereum with a proof of its CSD payment (the site checks their
  signed receipt against the settlement transaction's own event: the trade,
  its amounts and that the maker was a party to it), or if the site lists it.
  A browser remembers proven makers for 30 days and forgets one as soon as it
  declines or doesn't answer. While any proven maker quotes a side, only
  proven makers are used there; so after starting, do one real trade with your
  maker (from another wallet), and it starts receiving orders.
- **Every sale's lock carries an executor fee** (2 USDC, the bot's
  `sellExecutorFeeUsdc`; settling with a proof is about 320k gas). When you release the sale yourself it comes back to
  you; if you ever don't, whoever settles the sale for the seller with a proof
  of their payment earns it. The site won't pay into a lock without it.
- **Your signature over the sale's authorization** must check out, the lock
  must be a direct call to the settlement contract (so anyone can read the sale
  from Ethereum), and the site marks a trade done only once Ethereum says so.

**Watchtower.** The bot also watches other makers' sales (`WATCHTOWER_MS`,
on by default). It finds every lock from the contract's events, reads the
sale's authorization and the maker's signature from the lock transaction
itself, and looks for the seller's payment at the sale's CSD address on its own
CSD node on every new CSD block (a payment can only be spent once it's in a
block, so a maker can't sweep it away unseen); payments published on AON (the site's payment object references the
trade's hash) are a second source. Nothing a maker publishes or withholds on
AON can hide a sale from it. Payments count once they're in a CSD block; until then only ones spending
coins that really exist are kept, a few per coin, so forged ones can't crowd
out the real one. If a maker never releases a sale its seller has paid, the bot settles it for the seller with a proof of the payment 30
minutes before the lock runs out, and earns that sale's executor fee. Running more bots means
more watchtowers.

Follow "Running it" below with your own keys. Your offers appear on the site
on their own; each new offer references your previous one, so a browser that
has seen any of your offers follows the chain to your current price. Price
carefully: with several makers, anyone can buy from the cheapest and sell to
the dearest. Note that the contract caps all open locks together
(`maxTotalLocked`, 300 USDC), shared by every maker.

## Running it

You need: a CSD node (the bot talks to its HTTP API on `127.0.0.1:8887`), an
Ethereum RPC, the settlement contract deployed, and Node 20.

```bash
git clone https://github.com/intervalplace/aon-namespace-csd-usdc && cd aon-namespace-csd-usdc && npm ci
npx tsx scripts/market-maker.ts --new-seed      # → MM_CSD_SEED, keep it secret and backed up
```

`/etc/covenant-mm.env` (mode 600):

```bash
AON_EVM_RPC_URL=https://...           # mainnet RPC
MM_PRIVATE_KEY=0x...                  # a NEW key used only by the bot
MM_CSD_SEED=0x...                     # from --new-seed
SETTLEMENT_CONTRACT=0x...             # the deployed CsdUsdcSettlement
POOL_USDC=150
POOL_CSD=1000
STATE_FILE=/var/lib/covenant-mm/state.json
ALLOWED_ORIGINS=https://covenant.market
AON_NODE_URL=http://127.0.0.1:8787    # AON node(s), comma-separated: trades are requested and answered there
SIDES=sell,buy                        # or just "sell" (only sell CSD) or "buy"
MIN_ETH=0.005                         # below this ETH balance no new trades are taken
# PRIVATE_TX_RPC=https://rpc.flashbots.net/fast   # the default on mainnet: the bot's settlements skip the
#                                     # public mempool, so copy bots can't take its executor fee ("off" to disable)
WATCHTOWER_MS=60000                   # look for other makers' unreleased sales to settle for their sellers (0: off)
```

```bash
set -a; . /etc/covenant-mm.env; set +a
npx tsx scripts/market-maker.ts --addresses
```

Send **1,000 CSD** to the CSD address it prints, **150 USDC** and ~0.02 ETH
(gas) to the Ethereum address. The bot splits the CSD into 20 coins on
start, because CSD only accepts spends of confirmed coins and fast trades
shouldn't wait for change.

`/etc/systemd/system/covenant-mm.service`:

```ini
[Unit]
Description=Covenant CSD/USDC market maker
After=network-online.target

[Service]
EnvironmentFile=/etc/covenant-mm.env
WorkingDirectory=/opt/aon-namespace-csd-usdc
ExecStart=/usr/bin/npx tsx scripts/market-maker.ts
Restart=always
User=covenant-mm
StateDirectory=covenant-mm

[Install]
WantedBy=multi-user.target
```

Caddy (HTTPS for the site):

```
mm.covenant.market {
    reverse_proxy 127.0.0.1:8890
}
```

## Deepening the pool

Stop the bot, then `npx tsx scripts/market-maker.ts --top-up 500`: it prints
the CSD that goes with 500 USDC at the current price. Send both to the bot's
addresses, rerun with `--yes`, and start the bot again. The price doesn't move.

## Moving the price

If CSD trades at another price elsewhere, move the bot's price there before someone profits from
the difference at its expense. Stop the bot, then `npx tsx scripts/market-maker.ts --set-price 0.139`:
it shows the change (it counts less of one side, so the price is the one given; the rest stays in
the bot's wallet), and
`--yes` makes it. Start the bot again.

## The circuit breaker

When someone sells CSD to the bot, it releases their USDC early: within the loss limits before
the payment has 3 CSD blocks (6 for sales over 10 USDC), and on its own after that. Someone
with most of CSD's hash power could take the USDC and then reorg their payment away. So the
bot stops buying CSD on its own when:

- a CSD reorg replaces 2 or more blocks, or
- a sale's payment is reversed after its USDC was released.

The log says `STOPPED BUYING CSD` and why (and names any released sale whose payment is no
longer in a block). Selling CSD to users goes on: that side is safe. Sellers are answered
`SELLS_PAUSED`, the bot's buy offer isn't renewed, and sales already paid are released only
once their payment has 20 blocks. It stays stopped across restarts until you've looked and
resume it:

```bash
systemctl stop covenant-mm && npx tsx scripts/market-maker.ts --resume && systemctl start covenant-mm
```

So an attack costs the bot at most one sale (30 USDC at most), not the pool.

## Costs and limits

- Each trade costs the bot two Ethereum transactions (lock + settle or
  release), roughly 250k gas. The per-trade fee (`FEE_USDC`, 0.25 USDC)
  covers this at normal gas prices; raise it if gas is expensive.
- Trades are 1–30 USDC (the contract's cap, fee included).
- The bot's state file holds its trades and pool; its keys are derived from
  `MM_CSD_SEED` and `MM_PRIVATE_KEY`, so back up those two and the state file.
