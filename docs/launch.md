# Launching CSD/USDC on covenant.market

Five parts, in order. Commands are run as root unless noted. Nothing secret
goes in a repo: keys live only in `/etc/covenant-mm.env` on spill1.

## 1. DNS

Two A records (and AAAA if the servers have IPv6):

- `mm.covenant.market` → spill1 (the market maker)
- `csd.aon.network` → spill2 (an independent CSD node the site checks against)

## 2. spill2: the independent CSD node over HTTPS

The site reads CSD's current difficulty from here, not from the market maker,
and also broadcasts sellers' payments here. Only the cheap calls are exposed.
Add to `/etc/caddy/Caddyfile`:

```
csd.aon.network {
	header Access-Control-Allow-Origin "https://covenant.market"
	header Access-Control-Allow-Methods "GET, POST, OPTIONS"
	header Access-Control-Allow-Headers "content-type"
	@preflight method OPTIONS
	handle @preflight {
		respond 204
	}
	@api path /tip /block/height/* /tx/submit
	handle @api {
		reverse_proxy 127.0.0.1:8887
	}
	handle {
		respond 404
	}
}
```

```bash
systemctl reload caddy
curl -s https://csd.aon.network/tip        # {"height":…,"tip":"0x…"}
```

## 3. spill1: deploy the settlement contract

```bash
git clone https://github.com/intervalplace/aon-namespace-csd-usdc /opt/aon-namespace-csd-usdc
cd /opt/aon-namespace-csd-usdc && npm ci
node deploy/build-deploy-page.mjs      # prints the init code sha256; it must match the one in the repo's deploy.html
cp deploy/deploy.html /var/www/covenant/deploy-csd.html
```

Open `https://covenant.market/deploy-csd.html` in your wallet's browser
(MetaMask app → Browser). The page checks its own code, deploys in one
transaction (~3.2M gas), then reads the contract back: USDC, 300 USDC cap,
CSD mainnet. Copy the address, then:

```bash
rm /var/www/covenant/deploy-csd.html
ETHERSCAN_API_KEY=<free key from etherscan.io/myapikey> node deploy/verify-etherscan.mjs 0x<contract>
```

## 4. spill1: the market maker

Node 20+ is needed (`node -v`).

```bash
useradd --system --home /var/lib/covenant-mm --shell /usr/sbin/nologin covenant-mm
cd /opt/aon-namespace-csd-usdc
node -e 'console.log("MM_PRIVATE_KEY=" + require("viem/accounts").generatePrivateKey())'   # a NEW key, only for the bot
npx tsx scripts/market-maker.ts --new-seed                                                 # MM_CSD_SEED=…
```

`/etc/covenant-mm.env` (`chmod 600`, owned by root). Back up the two secrets
somewhere offline: they are the bot's money.

```bash
AON_EVM_RPC_URL=https://…                 # a mainnet RPC (Alchemy/Infura/your own)
MM_PRIVATE_KEY=0x…
MM_CSD_SEED=0x…
SETTLEMENT_CONTRACT=0x…                   # from step 3
POOL_USDC=172                             # = POOL_CSD × the current price (safe.trade)
POOL_CSD=1000
STATE_FILE=/var/lib/covenant-mm/state.json
ALLOWED_ORIGINS=https://covenant.market
CSD_API_URL=http://127.0.0.1:8887
CSD_BROADCAST_APIS=https://csd.aon.network
AON_NODE_URL=http://127.0.0.1:8787,https://explorer.aon.network   # AON nodes the bot reads trades from and publishes to (several, so a request reaching any of them is seen)
```

```bash
set -a; . /etc/covenant-mm.env; set +a
npx tsx scripts/market-maker.ts --addresses
```

Fund it:
- the Ethereum address: the POOL_USDC amount of USDC, and ~0.02 ETH for gas;
- the CSD address: the POOL_CSD amount of CSD (from your CSD wallet, e.g.
  `csd wallet spend --privkey … --auto-input --output <address>:1000 --fee …`).
  Wait for one CSD block.

`/etc/systemd/system/covenant-mm.service`:

```ini
[Unit]
Description=Covenant CSD/USDC market maker
After=network-online.target

[Service]
EnvironmentFile=/etc/covenant-mm.env
WorkingDirectory=/opt/aon-namespace-csd-usdc
ExecStart=/opt/aon-namespace-csd-usdc/node_modules/.bin/tsx scripts/market-maker.ts
User=covenant-mm
StateDirectory=covenant-mm
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now covenant-mm
journalctl -u covenant-mm -f        # "listening on 127.0.0.1:8890; pool …", then "split 1000 CSD into 20 coins"
```

Caddy on spill1, add:

```
mm.covenant.market {
	reverse_proxy 127.0.0.1:8890
}
```

```bash
systemctl reload caddy
curl -s https://mm.covenant.market/api/market | head -c 300
# the bot's offers are on AON (trading happens there, not over this API):
curl -s 'https://explorer.aon.network/v1/objects?namespace=aon:csd-usdc&objectType=offer&limit=2' | head -c 300
```

## 5. Release the site

```bash
node /opt/aon-namespace-csd-usdc/scripts/csd-target-ref.mjs     # prints NEXT_PUBLIC_CSD_TARGET_REF=0x…
```

Add to `covenant-frontend/.env.production`:

```
NEXT_PUBLIC_CSD_MM_URL=https://mm.covenant.market
NEXT_PUBLIC_CSD_SETTLEMENT=0x<contract>
NEXT_PUBLIC_CSD_NODE_URL=https://csd.aon.network
NEXT_PUBLIC_CSD_TARGET_REF=0x<from above>
NEXT_PUBLIC_CSD_MARKET_MAKERS=0x71cDFF394fD19cfA97946E6BAA08232cF357abD0
```

The page only trades with offers and responses signed by the addresses in
`NEXT_PUBLIC_CSD_MARKET_MAKERS` (the bot's Ethereum address).

Then the usual release (RELEASING.md): commit, `npm run release:ipfs`, pin,
`publish-site.sh`, `check-site`, RELEASES.md, tag.

## Day to day

- `journalctl -u covenant-mm` shows every trade; any `LOSS` line is a
  double-spent instant sale (instant sales stop by themselves at 30 USDC of losses).
- Deepen the pool: stop the bot, `--top-up <USDC>` (see market-maker.md), start it.
- If CSD's difficulty falls below half of the release's reference, buys stop
  working until a release with a new reference.
