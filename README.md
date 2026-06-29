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
  name: "AON CSD USDC",
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
  minConfirmations:    3,
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

## Exports

```ts
import {
  // Namespace driver — register this with the SDK
  csdUsdcNamespace,

  // Object builders
  buildCsdUsdcAuthorizationObject,
  buildCsdUsdcRevocationObject,

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

## Settlement contract

`src/contracts/CsdUsdcSettlement.sol` — the on-chain contract that holds USDC in escrow and releases on verified proof.

## Node and SDK

- Node: [intervalplace/aon](https://github.com/intervalplace/aon)
- SDK: [intervalplace/aon-sdk](https://github.com/intervalplace/aon-sdk)
- Spec: [SPEC.md](https://github.com/intervalplace/aon/blob/master/docs/spec.md)
