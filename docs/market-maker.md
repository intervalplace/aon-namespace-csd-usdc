# Market maker: instant CSD ↔ USDC

`src/market-maker.ts` is an always-available counterparty for the CSD/USDC
market on covenant.market. With it, trades feel like an ordinary swap: about
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
2. `POST /api/buy`. The bot checks the price against its pool, submits
   `lockCsdUsdcAuthorizationWithPermit` (paying the gas) and **in the same
   moment** sends the CSD. The site shows it as incoming immediately.
3. After the user's chosen confirmations (3–20), the bot proves its payment
   with `settleCsdUsdc` and receives the USDC. If it never does, the user's
   USDC is refunded. **The user takes no risk**; only the bot waits.

### User sells CSD

1. `POST /api/sell/open`: the bot locks its USDC for the trade, against a fresh
   CSD address of its own (with its own address proof).
2. The site recomputes the trade hash from the returned authorization and
   checks on-chain that the USDC is locked, paying the user, for this amount.
3. The in-site wallet signs the CSD payment and hands it to the bot
   (`POST /api/sell/pay`). The bot broadcasts it and immediately submits
   `releaseEarly`: **the user has USDC after one Ethereum block**, with no CSD
   block mined. If the bot disappears instead, the user can still settle with a
   proof after 3 confirmations, so the user takes no risk here either.
4. The bot carries the risk that the CSD payment is double-spent. Trades it
   trusts before CSD confirms are capped (`MAX_INSTANT_USDC`, default 60 USDC
   at once); above that it waits for one CSD block before releasing. A
   double-spend is detected and recorded as a loss in the state file.

## API

| | |
|---|---|
| `GET /api/market` | pool, mid/bid/ask, an 8-level order book from the curve, limits, recent trades, contract addresses |
| `POST /api/buy` | `{ authorization, signature, addressProof, permit }` |
| `POST /api/sell/open` | `{ csdAmount, usdcRecipient, minUsdcOut }` |
| `POST /api/sell/pay` | `{ authHash, tx }` (the node's `/tx/submit` JSON) |
| `GET /api/trade/:authHash` | trade status |
| `GET /api/csd/tip`, `/utxos/:addr`, `/address/:addr/activity`, `/tx/:id`, `/block/height/:h`; `POST /api/csd/tx/submit` | the CSD node, for the in-site wallet |

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
AON_NODE_URL=http://127.0.0.1:8080    # optional: publish trades to AON
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

## Costs and limits

- Each trade costs the bot two Ethereum transactions (lock + settle or
  release), roughly 250k gas. The per-trade fee (`FEE_USDC`, 0.25 USDC)
  covers this at normal gas prices; raise it if gas is expensive.
- Trades are 1–30 USDC (the contract's cap, fee included).
- The bot's state file holds its trades and pool; its keys are derived from
  `MM_CSD_SEED` and `MM_PRIVATE_KEY`, so back up those two and the state file.
