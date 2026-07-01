import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  AonNodeClient,
  registerNamespace,
  getNamespace,
  finalizeObject,
} from "@intervalplace/aon-sdk";
import {
  csdUsdcNamespace,
  buildCsdUsdcAuthorizationObject,
} from "../dist/index.js";

const AON_URL = process.env.AON_URL ?? "http://127.0.0.1:8787";
const client = new AonNodeClient(AON_URL);
registerNamespace(csdUsdcNamespace);

// ── Crypto helpers (must match csd.ts and Solidity exactly) ──────────────────

function sha256(buf) { return createHash("sha256").update(buf).digest(); }
function dsha(buf)   { return sha256(sha256(buf)); }

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}
function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

// ── Submit helper ─────────────────────────────────────────────────────────────

async function submit(obj, label) {
  const res = await client.putObject(obj);
  console.log(`${label}: ${res.objectHash}`);
  return res.object ?? obj;
}

// ── Participants ──────────────────────────────────────────────────────────────

const buyer = privateKeyToAccount(
  process.env.BUYER_PK ??
    "0x4019e96887def59e26a0929378394432f1b3986f42029269720f249943bf5fb5"
);

const sellerEthAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

// ── Trade constants ───────────────────────────────────────────────────────────

const now = Math.floor(Date.now() / 1000);

// Seller's CSD script: 20 bytes, stored as bytes32 (left-aligned, zero-padded)
// The Solidity verifier does: bytes20(sellerCsdScriptHash) to extract the 20 bytes
const sellerScript20 = Buffer.from("cd".repeat(20), "hex"); // 20 bytes
const sellerScriptHex = "0x" + sellerScript20.toString("hex");
const sellerCsdScriptHash = "0x" + sellerScript20.toString("hex") + "00".repeat(12); // bytes32

const csdGenesisHash  = "0x" + "11".repeat(32);
const tradeIntentHash = "0x" + "22".repeat(32);

const settlementContract = process.env.AON_CSD_USDC_SETTLEMENT_CONTRACT ??
  "0x0000000000000000000000000000000000000042";

const usdcAddress = process.env.USDC_ADDRESS ??
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const csdAmount  = 100_000_000n; // 1.00000000 CSD (8 decimals)
const usdcAmount =   1_000_000n; // 1.000000 USDC (6 decimals)

const domain = {
  name: "AON CSD/USDC",
  version: "2",
  chainId: Number(process.env.CHAIN_ID ?? 1),
  verifyingContract: settlementContract,
};

// ── Step 1: Authorization ─────────────────────────────────────────────────────

const authStruct = {
  buyer:               buyer.address,
  sellerUsdcRecipient: sellerEthAddress,
  sellerCsdScriptHash,
  csdGenesisHash,
  tradeIntentHash,
  csdAmount:           csdAmount.toString(),
  usdc:                usdcAddress,
  usdcAmount:          usdcAmount.toString(),
  minConfirmations:    "1",
  executorFeeAmount:   "0",
  validAfter:          String(now - 60),
  validBefore:         String(now + 3600),
  nonce:               "0x" + "bb".repeat(32),
};

const authSig = await buyer.signTypedData({
  domain,
  types: csdUsdcNamespace.types(),
  primaryType: "CsdUsdcAuthorization",
  message: authStruct,
});

const authObj = await buildCsdUsdcAuthorizationObject({
  authorization: authStruct,
  signature: authSig,
  signer: buyer.address,
  domain,
});

await submit(authObj, "authorization");

// ── Step 2: Reserve ───────────────────────────────────────────────────────────

const reserveObj = await finalizeObject({
  objectType: "reserve",
  schemaVersion: "1",
  namespace: "aon:csd-usdc",
  createdAt: Date.now(),
  creator: buyer.address,
  references: [authObj.objectHash],
  payload: { reserveType: "csd_usdc_intent" },
});

await submit(reserveObj, "reserve");

// ── Step 3: Construct a cryptographically valid synthetic CSD proof ────────────
//
// Raw CSD transaction format:
//   version        : 4 bytes  (u32le)
//   input_count    : 8 bytes  (u64le)
//   [inputs]       : 0 here
//   output_count   : 8 bytes  (u64le)
//   per output     : value(8, u64le) + script_len(8, u64le) + script(20 bytes)
//
// This matches both the TypeScript verifier (csd.ts) and the Solidity contract.

const rawTxBuf = Buffer.concat([
  u32le(1),              // version = 1
  u64le(0n),             // input_count = 0
  u64le(1n),             // output_count = 1
  u64le(csdAmount),      // output[0].value = 1 CSD
  u64le(20n),            // output[0].script_len = 20
  sellerScript20,        // output[0].script = seller's 20-byte script
]);

// txid = dsha256(raw tx with empty script_sigs)
// For 0 inputs, txid = dsha256(rawTxBuf) directly
const txidBuf = dsha(rawTxBuf);
const txid = "0x" + txidBuf.toString("hex");

// Single tx in block → empty merkle branch → merkle root = txid
const prevHash  = Buffer.alloc(32, 0);
const blockTime = now;

// Block header: version(4le) + prev(32) + merkle(32) + time(8le) + bits(4le) + nonce(4le)
const headerBuf = Buffer.concat([
  u32le(1),
  prevHash,
  txidBuf,           // merkle root = txid (single tx, no branch)
  u64le(BigInt(blockTime)),
  u32le(0x1d00ffff),
  u32le(0),
]);
const blockHashBuf = dsha(headerBuf);
const blockHash = "0x" + blockHashBuf.toString("hex");

const syntheticProof = {
  ok: true,
  confirmations: 6,
  txid,
  block_hash: blockHash,
  height: 1000,
  genesis_hash: csdGenesisHash,
  tx_raw: "0x" + rawTxBuf.toString("hex"),
  tx: {
    txid,
    outputs: [
      { script_pubkey: sellerScriptHex, value: csdAmount.toString() },
    ],
  },
  header: {
    version:  1,
    prev:     "0x" + prevHash.toString("hex"),
    merkle:   "0x" + txidBuf.toString("hex"),
    time:     blockTime,
    bits:     0x1d00ffff,
    nonce:    0,
  },
  merkle_branch: [],
};

const proofObj = await finalizeObject({
  objectType: "proof",
  schemaVersion: "1",
  namespace: "aon:csd-usdc",
  createdAt: Date.now(),
  creator: "aon-csd-usdc-test",
  references: [reserveObj.objectHash],
  payload: {
    proofType: "csd_payment",
    txid,
    proof: syntheticProof,
    expectedRecipientScriptPubKey: sellerScriptHex,
    expectedAmount: csdAmount.toString(),
    minConfirmations: 1,
  },
});

await submit(proofObj, "proof");

// ── Step 4: Evaluate ──────────────────────────────────────────────────────────

const allObjects = await client.listObjects({ namespace: "aon:csd-usdc" });
const namespace  = getNamespace("aon:csd-usdc");
const evaluated  = namespace.evaluate(allObjects, { includeCompleted: false });

const executable = Array.isArray(evaluated)
  ? evaluated.find((g) => g.status === "executable")
  : evaluated.graphs?.find((g) => g.status === "executable");

if (!executable) throw new Error("NO_EXECUTABLE_CSD_USDC_GRAPH");
console.log("executable graph found");

// ── Step 5: Off-chain SPV verification ───────────────────────────────────────

const verification = namespace.verify(executable);
console.log("verification:", JSON.stringify(verification, null, 2));

// ── Step 6: Execute (simulate) ────────────────────────────────────────────────
// In contract mode, the executor builds CsdSpvProof from proof.payload.proof
// and passes it to settleCsdUsdc() instead of the old flat attestation.

const action = await namespace.execute(executable, {
  mode: process.env.AON_EXECUTOR_MODE ?? "simulate",
});

// ── Step 7: Receipt ───────────────────────────────────────────────────────────

const receiptObj = await finalizeObject({
  objectType: "receipt",
  schemaVersion: "1",
  namespace: "aon:csd-usdc",
  createdAt: Date.now(),
  creator: "aon-csd-usdc-test",
  references: [
    executable.authorization.objectHash,
    executable.reserve.objectHash,
    executable.proof.objectHash,
  ],
  payload: {
    receiptType: "authorized_state_transition_completed",
    result: action.result,
    executionTx: action.executionTx ?? null,
    verification,
    executor: { mode: action.mode, executed: action.executed },
  },
});

await submit(receiptObj, "receipt");
console.log("ok: csd-usdc local flow completed");
