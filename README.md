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

## Limits (CsdUsdcSettlement v3)

| | |
|---|---|
| Confirmations | 3 to 60, chosen by the buyer |
| Max per trade | 30 USDC, whatever the confirmations |
| Max locked in total | set at deployment (`maxTotalLocked`), across all open trades |
| Lock window | 10 min + 5 min × confirmations (3 → 25 min, 20 → 110 min) |
| Payment age | the CSD payment's block may be at most 20 min older than the lock |
| Refunds | a refunded authorization can't be locked again |

The per-trade cap doesn't grow with confirmations, and the total cap exists,
because one fake header chain could carry fake payments for every open trade
at once. Changing these numbers means deploying a new contract.

## Header oracle (v2)

`src/contracts/CsdHeaderOracle.sol` is a light client for Compute Substrate.
It checks every header against the same rules a CSD node applies:

- proof of work at the header's difficulty, within CSD's PoW limit;
- difficulty: `bits` must equal the LWMA retarget computed from the 45
  headers before it (a straight port of `expected_bits_strict`);
- timestamps: at least 60 s after the parent, after the median of the last
  11, at most 2 h in the future.

So confirmations can only be faked by mining real CSD blocks at the real
difficulty. There is **no owner**: the starting point is 45 consecutive real
headers fixed at deployment (printed by the deploy script, checkable against
any CSD node), and anyone can submit headers.

Keep it current with the relayer, so a fake chain would have to out-mine the
real network from the current tip:

```bash
node scripts/relay-headers.mjs   # see the header of the file for settings
```

Deploy on an L2 (Base, Arbitrum, ...): checking a header costs roughly
150–450k gas, which is cheap there and expensive on Ethereum mainnet.

## Deploying

```bash
npm install
# 1. Prove the oracle accepts your real chain (local throwaway EVM, no cost):
node scripts/check-oracle-against-csd.mjs http://127.0.0.1:8887 300
# 2. Deploy oracle + settlement:
CSD_API_URL=http://127.0.0.1:8887 AON_EVM_RPC_URL=https://... \
DEPLOYER_PRIVATE_KEY=0x... MAX_TOTAL_LOCKED_USDC=300 node scripts/deploy.mjs
# 3. Keep the oracle current:
CSD_API_URL=... AON_EVM_RPC_URL=... RELAYER_PRIVATE_KEY=0x... ORACLE_ADDRESS=0x... \
node scripts/relay-headers.mjs
```

## Tests

```bash
npm install
npm test     # solc 0.8.26 + a local anvil: consensus vectors from CSD's own code, oracle, relayer, settlement
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
