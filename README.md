# @intervalplace/aon-namespace-csd-usdc

CSD/USDC cross-system settlement namespace for the Authorization Object Network.

Implements the `aon:csd-usdc` namespace: atomic settlement between CSD on Compute Substrate and USDC on EVM.

**Live:** trade at [covenant.market/csd](https://covenant.market/csd). Settlement contract on Ethereum mainnet:
[`0x8863f0c477a30bb5a2077c813f42250d7fbefcb9`](https://etherscan.io/address/0x8863f0c477a30bb5a2077c813f42250d7fbefcb9)
(no owner, no admin, no upgrades; 1–30 USDC per trade, 300 USDC open in total).

CSD has no smart contracts and no scripts. Nothing changes on the CSD side: the
Ethereum contract checks CSD's proof of work itself. No bridge, no custody, no
fork, no oracle.

**An open market.** There is no list of approved market makers. Anyone with
CSD or USDC can run [`scripts/market-maker.ts`](docs/market-maker.md#run-your-own)
(or their own), publish signed offers on AON, and interfaces route each trade to
the best price. A user never has to trust a maker: a buyer's USDC only reaches
one with a proof that the CSD was paid, and a seller's CSD only leaves their
wallet once the maker's USDC is locked for them. Every bot is also a watchtower
that settles other makers' unreleased sales for their sellers.

## Install

```bash
npm install @intervalplace/aon-sdk @intervalplace/aon-namespace-csd-usdc
```

## Flow

```
authorization   (buyer signs USDC release, EIP-712 signed)
  → reserve     (USDC locked on-chain by executor)
    → proof     (CSD payment txid with confirmations)
      → receipt (USDC released to seller)
```

The buyer authorizes a USDC release conditional on a CSD payment being confirmed on-chain. An executor locks the USDC in the settlement contract, waits for the CSD proof, and releases to the seller on confirmation.

## Quickstart

```ts
import { registerNamespace, runExecutor, AonNodeClient } from "@intervalplace/aon-sdk";
import {
  csdUsdcNamespace,
  buildCsdUsdcAuthorizationObject,
  makeCsdPaymentProofObject,
} from "@intervalplace/aon-namespace-csd-usdc";
import { privateKeyToAccount } from "viem/accounts";

// Register the namespace
registerNamespace(csdUsdcNamespace);

const client = new AonNodeClient("http://localhost:8787");
const buyer  = privateKeyToAccount("0x...");

const domain = {
  name: "AON CSD/USDC",
  version: "1",
  chainId: 1,
  verifyingContract: "0x...",  // your settlement contract
};

// Build and submit an authorization
const authData = {
  buyer:               buyer.address,
  sellerUsdcRecipient: "0x...",
  usdc:                "0x...",
  usdcAmount:          "1000000",       // 1 USDC (6 decimals)
  csdAmount:           "100000000",     // CSD amount
  executorFeeAmount:   "1000",
  sellerCsdScriptHash: "0x" + "cc".repeat(32),
  csdGenesisHash:      "0x" + "dd".repeat(32),
  tradeIntentHash:     "0x" + "ff".repeat(32),
  minConfirmations:    "3",
  validAfter:          String(Math.floor(Date.now() / 1000) - 60),
  validBefore:         String(Math.floor(Date.now() / 1000) + 86400),
  authNonce:           "0x" + "ee".repeat(32),
};


const sig = await buyer.signTypedData({
  domain,
  types: csdUsdcNamespace.types!(),
  primaryType: "CsdUsdcAuthorization",
  message: authData,
});

const authObj = await buildCsdUsdcAuthorizationObject({
  authorization: authData,
  signature: sig,
  signer: buyer.address,
  domain,
});

await client.putObject(authObj);
console.log("authorization submitted:", authObj.objectHash);

// Run an executor
await runExecutor({
  nodeUrl: "http://localhost:8787",
  namespace: "aon:csd-usdc",
  mode: "contract",
  pollIntervalMs: 10000,
});
```

## Waiting less: early release and market makers

Trading happens on AON, with no private channel: a maker's signed `offer`, the
buyer's `authorization` (or the seller's `request` and later `payment`), the
maker's signed `response`s, and the `receipt`. See
[docs/market-maker.md](docs/market-maker.md#trading-happens-on-aon) for the
objects and what an interface must check, since the maker on the other side
may be anyone.


The confirmation wait only protects the buyer (who locked the USDC). The
buyer can waive it for a single locked trade by signing a
`CsdUsdcEarlyRelease`: it names the recipient and amount, the CSD payment
being accepted (its txid is then used up, so it can't also pay for another
trade), the current lock, and a deadline. Anyone can submit it to
`releaseEarly`, and the seller is paid immediately without a CSD proof. The
buyer carries the risk of the CSD payment being reversed.

That lets a market maker on the other side of every trade make both
directions feel like an ordinary swap: about one Ethereum block, no CSD
confirmations to wait for, and no ETH needed by the user (USDC permits; the
market maker pays the gas). `src/market-maker.ts` is that bot, pricing from
its own pool; `src/csd-wallet.ts` is the in-site CSD wallet it trades with.
See [docs/market-maker.md](docs/market-maker.md).

Locks also need a **CSD address proof** (the CSD key behind the payment
address signs the authorization hash), so nobody can open trades on an
address they don't control.

## How a CSD payment is proven (CsdUsdcSettlement v4)

Settlement is self-contained, so it runs on Ethereum mainnet next to the
ETH market with nothing to keep running: no header oracle, no relayer.

- The buyer signs `csdMaxTarget` in the authorization: every block in the
  proof must be at least that hard. This is the buyer's protection: an
  interface sets it from CSD's real difficulty read from a node of its own,
  not from the market maker (covenant.market allows at most 10% easier than
  the live difficulty).
- `settleCsdUsdc` gets the payment transaction (parsed strictly, every byte
  accounted for), its merkle path, the payment block and the next blocks
  (`minConfirmations` or more). It checks they link up by hash, each has
  valid proof of work within CSD's PoW limit, none is more than 2 h in the
  future, CSD's 60-second spacing rule, and that together they carry at
  least `minConfirmations` blocks' worth of work at the signed difficulty.
  If difficulty eases, the seller just includes more blocks.
- So faking k confirmations means mining k blocks' worth of work at that
  difficulty, however the fake chain is built. About 170k gas with 3
  confirmations, about 320k with 20.
- The seller checks the signed difficulty isn't above the real one before
  paying (otherwise real blocks wouldn't qualify); `checkHeaderChain` lets
  anyone pre-check a run of real headers.

## Limits

| | |
|---|---|
| Confirmations | 3 to 60, chosen by the buyer |
| Difficulty | proof blocks carry ≥ confirmations × the work of one block at the buyer's `csdMaxTarget` |
| CSD address | one open trade per receiving address (a payment can't say which trade it's for); use a fresh address per trade and lock before publishing the authorization |
| Coinbase | payments inside a coinbase transaction can't be proven |
| Per trade | 1 to 30 USDC (fee included), whatever the confirmations |
| Max locked in total | set at deployment (`maxTotalLocked`), across all open trades |
| Token / chain | the stablecoin and the CSD genesis fixed at deployment |
| Lock window | 10 min + 5 min × confirmations (3 → 25 min, 20 → 110 min) |
| Payment age | the CSD payment's block may be at most 20 min older than the lock |
| Refunds | a refunded authorization can't be locked again |

The per-trade cap doesn't grow with confirmations, and the total cap exists,
because one fake chain of blocks could carry fake payments for every open
trade at once. Changing these numbers means deploying a new contract.

## Deploying

```bash
npm install
# 1. Check real CSD blocks pass the contract's checks (local throwaway EVM, no cost):
node scripts/check-against-csd.mjs http://127.0.0.1:8887 200
# 2. Deploy (one contract per stablecoin):
AON_EVM_RPC_URL=https://... DEPLOYER_PRIVATE_KEY=0x... \
USDC_ADDRESS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 MAX_TOTAL_LOCKED_USDC=300 \
node scripts/deploy.mjs
```

## Header oracle (optional, for L2s)

`src/contracts/CsdHeaderOracle.sol` is a full CSD light client with no owner:
it checks every header against CSD's consensus rules (LWMA difficulty,
timestamps, PoW), from a fixed 45-header checkpoint, with a relayer
(`scripts/relay-headers.mjs`). It costs ~250k gas per CSD header, so it's only
practical on an L2; the mainnet settlement doesn't use it.

## Tests

```bash
npm install
npm test     # solc 0.8.26 + a local anvil: settlement, mainnet-difficulty blocks, oracle, consensus vectors from CSD's own code
```

## Exports

```ts
import {
  // Namespace driver — register this with the SDK
  csdUsdcNamespace,

  // Object builders
  buildCsdUsdcAuthorizationObject,
  buildCsdUsdcRevocationObject,
  buildCsdUsdcEarlyReleaseObject,
  earlyReleaseMessage,
  EARLY_RELEASE_TYPES,
  csdUsdcAuthHash,

  // Executor calls
  lockCsdUsdcOnEvm,
  executeCsdUsdcSettlementOnEvm,
  releaseEarlyOnEvm,
  refundExpiredCsdUsdcLockOnEvm,

  // Proof construction
  makeCsdPaymentProofObject,
} from "@intervalplace/aon-namespace-csd-usdc";
```

## Object types

| Type | Description |
|---|---|
| `offer` | A market maker's signed quote (its pool, spread, fee, limits) for selling or buying CSD. References the maker's previous offer on that side. |
| `request` | A seller's sale request, signed by the CSD keys that own the coins it names. References an offer. |
| `response` | A market maker's signed answer to an authorization, request or payment. |
| `payment` | A seller's signed CSD transaction for a sale, with the maker's signed authorization. References the maker's authorization object and the trade's hash. |
| `authorization` | Buyer's signed USDC release authorization. Defines amounts, recipient, CSD script hash, validity window. |
| `reserve` | USDC locked on-chain by executor pending proof. Namespace-specific type. |
| `proof` | CSD payment txid with confirmation count. References the reserve. |
| `receipt` | The trade's outcome, signed by the market maker; names the settlement transaction (interfaces check it against that transaction's event). |
| `revocation` | Cancels an authorization before it is reserved. |
| `release` | The buyer's signed early release for one locked trade. References the authorization. |

## Settlement contract

`src/contracts/CsdUsdcSettlement.sol`: holds USDC in escrow and releases it on a verified CSD proof (or the buyer's signed early release), refunding the buyer otherwise. Deployed at `0x8863f0c477a30bb5a2077c813f42250d7fbefcb9` on Ethereum mainnet; it has no owner.

## Node and SDK

- Node: [intervalplace/aon](https://github.com/intervalplace/aon)
- SDK: [intervalplace/aon-sdk](https://github.com/intervalplace/aon-sdk)
- Spec: [SPEC.md](https://github.com/intervalplace/aon/blob/master/docs/spec.md)
