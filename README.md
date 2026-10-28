# @intervalplace/aon-namespace-csd-usdc

CSD/USDC cross-system settlement namespace for the Authorization Object Network.

Implements the `aon:csd-usdc` namespace: atomic settlement between CSD on Compute Substrate and USDC on EVM.

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

The confirmation wait only protects the buyer (who locked the USDC). The
buyer can waive it for a single locked trade by signing a
`CsdUsdcEarlyRelease`: it names the recipient and amount, the CSD payment
being accepted (its txid is then used up, so it can't also pay for another
trade), the current lock, and a deadline. Anyone can submit it to
`releaseEarly`, and the seller is paid immediately without a CSD proof. The
buyer carries the risk of the CSD payment being reversed.

That lets a market maker on the other side of every trade give users about
one CSD block of waiting in both directions. See
[docs/market-maker.md](docs/market-maker.md) and the bot sketch in
`examples/market-maker.ts`.

## How a CSD payment is proven (CsdUsdcSettlement v4)

Settlement is self-contained, so it runs on Ethereum mainnet next to the
ETH/USDT market with nothing to keep running: no header oracle, no relayer.

- The buyer signs `csdMaxTarget` in the authorization: every block in the
  proof must be at least that hard. Interfaces and bots set it to about 3/4
  of CSD's current difficulty (`suggestedMaxTarget()` in
  `scripts/csd-headers.mjs`: current target × 4/3).
- `settleCsdUsdc` gets the payment transaction, its merkle path, the payment
  block and the next blocks (`minConfirmations` in total). It checks they link
  up by hash, each has valid proof of work within CSD's PoW limit and at
  least the signed difficulty, and CSD's 60-second spacing rule.
- So faking k confirmations means mining k blocks at that difficulty,
  however the fake chain is built. About 166k gas per settlement.
- The seller checks the signed difficulty isn't above the real one before
  paying (otherwise real blocks wouldn't qualify); `checkHeaderChain` lets
  anyone pre-check a run of real headers.

## Limits

| | |
|---|---|
| Confirmations | 3 to 60, chosen by the buyer |
| Difficulty | every proof block at least as hard as the buyer's `csdMaxTarget` |
| Max per trade | 30 USDC including the executor fee, whatever the confirmations |
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
| `authorization` | Buyer's signed USDC release authorization. Defines amounts, recipient, CSD script hash, validity window. |
| `reserve` | USDC locked on-chain by executor pending proof. Namespace-specific type. |
| `proof` | CSD payment txid with confirmation count. References the reserve. |
| `receipt` | USDC released to seller. References the proof. |
| `revocation` | Cancels an authorization before it is reserved. |
| `release` | The buyer's signed early release for one locked trade. References the authorization. |

## Settlement contract

`src/contracts/CsdUsdcSettlement.sol` — the on-chain contract that holds USDC in escrow and releases on verified proof.

## Node and SDK

- Node: [intervalplace/aon](https://github.com/intervalplace/aon)
- SDK: [intervalplace/aon-sdk](https://github.com/intervalplace/aon-sdk)
- Spec: [SPEC.md](https://github.com/intervalplace/aon/blob/master/docs/spec.md)
