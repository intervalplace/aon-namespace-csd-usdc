/**
 * Full integration test for CSD/USDC namespace.
 * Deploys all contracts to a local Hardhat EVM node, registers the CSD chain
 * in the oracle, submits a synthetic header, then runs the complete trade flow.
 */

import { createHash } from "node:crypto";
import { createPublicClient, createWalletClient, http, parseAbi, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import {
  AonNodeClient,
  registerNamespace,
  getNamespace,
  finalizeObject,
} from "@intervalplace/aon-sdk";

// ── Load compiled artifacts ───────────────────────────────────────────────────

const ARTIFACTS_DIR = "/home/claude/work/evm-test/artifacts";
function loadArtifact(name) {
  return JSON.parse(readFileSync(`${ARTIFACTS_DIR}/${name}.json`, "utf8"));
}

const MockUSDC         = loadArtifact("MockUSDC");
const CsdHeaderOracle  = loadArtifact("CsdHeaderOracle");
const CsdUsdcSettlement = loadArtifact("CsdUsdcSettlement");

// ── Load namespace ────────────────────────────────────────────────────────────

// Use our fixed csd-usdc build
const { csdUsdcNamespace, buildCsdUsdcAuthorizationObject } =
  await import("/home/claude/work/csd-usdc-pkg/dist/index.js");

// ── Hardhat node setup ────────────────────────────────────────────────────────

const hardhat = defineChain({
  id: 31337,
  name: "Hardhat",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

// Hardhat default accounts
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BUYER_PK    = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const EXECUTOR_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const deployer = privateKeyToAccount(DEPLOYER_PK);
const buyer    = privateKeyToAccount(BUYER_PK);
const executor = privateKeyToAccount(EXECUTOR_PK);

const walletClient  = (account) => createWalletClient({ account, chain: hardhat, transport: http() });
const publicClient  = createPublicClient({ chain: hardhat, transport: http() });

// ── Crypto helpers ────────────────────────────────────────────────────────────

const sha256 = (buf) => createHash("sha256").update(buf).digest();
const dsha   = (buf) => sha256(sha256(buf));
const u32le  = (n)   => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le  = (n)   => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

// ── Deploy helper ─────────────────────────────────────────────────────────────

async function deploy(artifact, args = [], account = deployer) {
  const hash = await walletClient(account).deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return receipt.contractAddress;
}

async function txn(contractAddress, abi, functionName, args, account = deployer) {
  const hash = await walletClient(account).writeContract({
    address: contractAddress, abi, functionName, args,
  });
  return publicClient.waitForTransactionReceipt({ hash });
}

async function read(contractAddress, abi, functionName, args = []) {
  return publicClient.readContract({ address: contractAddress, abi, functionName, args });
}

// ── Constants ─────────────────────────────────────────────────────────────────

// CSD chain identifiers (fake for testing)
const CSD_GENESIS_HASH  = ("0x" + "11".repeat(32));
const TRADE_INTENT_HASH = ("0x" + "22".repeat(32));

// Seller's CSD script: 20 bytes, stored as bytes32 (left-aligned)
const sellerScript20     = Buffer.from("cd".repeat(20), "hex");
const SELLER_SCRIPT_HEX  = "0x" + sellerScript20.toString("hex");
const SELLER_SCRIPT_B32  = "0x" + sellerScript20.toString("hex") + "00".repeat(12);

const CSD_AMOUNT  = 100_000_000n; // 1 CSD (8 decimals)
const USDC_AMOUNT = 1_000_000n;   // 1 USDC (6 decimals)

// Easy test difficulty: bits = 0x1f7fffff → target ≈ 2^247, any hash passes
const TEST_BITS     = 0x1f7fffff;
const testMant      = BigInt(TEST_BITS & 0xFFFFFF);
const testExp       = BigInt(TEST_BITS >> 24);
const TEST_TARGET   = testMant << (8n * (testExp - 3n));
const MAX_TARGET    = TEST_TARGET; // oracle's maxTarget for this test chain

// ── Build synthetic CSD chain ─────────────────────────────────────────────────
// checkpoint (height 999) → test block (height 1000, contains our tx)

const checkpointHash = "0x" + "aa".repeat(32); // arbitrary known hash for checkpoint
const checkpointHeight = 999n;
const checkpointWork   = 1000000n; // arbitrary starting chainWork

// Raw CSD tx: version(4) + inputCount(8,=0) + outputCount(8,=1) + value(8) + scriptLen(8,=20) + script(20)
const rawTxBuf = Buffer.concat([
  u32le(1), u64le(0n), u64le(1n), u64le(CSD_AMOUNT), u64le(20n), sellerScript20,
]);
const txidBuf = dsha(rawTxBuf);
const txid    = "0x" + txidBuf.toString("hex");

// Test block header: prev = checkpointHash, merkle = txid
const prevBuf    = Buffer.from(checkpointHash.slice(2), "hex");
const blockTime  = Math.floor(Date.now() / 1000);
const headerBuf  = Buffer.concat([
  u32le(1), prevBuf, txidBuf, u64le(BigInt(blockTime)), u32le(TEST_BITS), u32le(0),
]);
const blockHashBuf = dsha(headerBuf);
const blockHash    = "0x" + blockHashBuf.toString("hex");

// Mine for a nonce so the block hash meets TEST_TARGET
let validNonce = 0;
let finalBlockHashBuf = blockHashBuf;
let finalBlockHash    = blockHash;

if (BigInt("0x" + blockHashBuf.toString("hex")) > TEST_TARGET) {
  let found = false;
  for (let nonce = 1; nonce < 1_000_000; nonce++) {
    const h  = Buffer.concat([u32le(1), prevBuf, txidBuf, u64le(BigInt(blockTime)), u32le(TEST_BITS), u32le(nonce)]);
    const bh = dsha(h);
    if (BigInt("0x" + bh.toString("hex")) <= TEST_TARGET) {
      validNonce        = nonce;
      finalBlockHashBuf = bh;
      finalBlockHash    = "0x" + bh.toString("hex");
      found = true;
      break;
    }
  }
  if (!found) throw new Error("could not find valid nonce (difficulty too hard for test)");
}
console.log("  block nonce:", validNonce, "block hash:", finalBlockHash.slice(0,18)+"...");

const csdHeader = {
  version: 1,
  prev:    checkpointHash,
  merkle:  txid,
  time:    BigInt(blockTime),
  bits:    TEST_BITS,
  nonce:   validNonce,
};

const syntheticProof = {
  ok: true, confirmations: 1, txid, block_hash: finalBlockHash, height: 1000,
  genesis_hash: CSD_GENESIS_HASH,
  tx_raw: "0x" + rawTxBuf.toString("hex"),
  tx: { txid, outputs: [{ script_pubkey: SELLER_SCRIPT_HEX, value: CSD_AMOUNT.toString() }] },
  header: { version: 1, prev: checkpointHash, merkle: txid, time: blockTime, bits: TEST_BITS, nonce: validNonce },
  merkle_branch: [],
};

// ── Main test ─────────────────────────────────────────────────────────────────

console.log("=== CSD/USDC Full Integration Test ===\n");

// 1. Deploy contracts
console.log("[1] Deploying contracts...");
const usdcAddr      = await deploy(MockUSDC);
const oracleAddr    = await deploy(CsdHeaderOracle, [256n]);
const settlementAddr = await deploy(CsdUsdcSettlement, [oracleAddr]);
console.log("  MockUSDC:          ", usdcAddr);
console.log("  CsdHeaderOracle:   ", oracleAddr);
console.log("  CsdUsdcSettlement: ", settlementAddr);

// 2. Register CSD chain in oracle
console.log("\n[2] Registering CSD chain in oracle...");
await txn(oracleAddr, CsdHeaderOracle.abi, "registerChainCheckpoint", [
  CSD_GENESIS_HASH,
  checkpointHash,
  checkpointHeight,
  checkpointWork,
  MAX_TARGET,
]);
console.log("  genesis hash:    ", CSD_GENESIS_HASH);
console.log("  checkpoint hash: ", checkpointHash);
console.log("  checkpoint height:", checkpointHeight.toString());
console.log("  maxTarget:       ", "0x" + MAX_TARGET.toString(16).slice(0, 16) + "...");

// 3. Submit test block header to oracle
console.log("\n[3] Headers will be submitted automatically inside settleCsdUsdc.");
console.log("  (no separate oracle submitHeaders call needed)");

// 4. Set up USDC balances
console.log("\n[4] Setting up USDC...");
await txn(usdcAddr, MockUSDC.abi, "mint", [buyer.address, USDC_AMOUNT + 1_000_000n]);
await txn(usdcAddr, MockUSDC.abi, "approve", [settlementAddr, USDC_AMOUNT + 1_000_000n], buyer);
const buyerBalance = await read(usdcAddr, MockUSDC.abi, "balanceOf", [buyer.address]);
console.log("  buyer USDC balance:", buyerBalance.toString());

// 5. Start AON node flow
console.log("\n[5] Starting AON flow...");
const AON_URL = process.env.AON_URL ?? "http://127.0.0.1:8787";
const client  = new AonNodeClient(AON_URL);
registerNamespace(csdUsdcNamespace);

const now    = Math.floor(Date.now() / 1000);
const domain = { name: "AON CSD/USDC", version: "2", chainId: 31337, verifyingContract: settlementAddr };

const authStruct = {
  buyer:               buyer.address,
  sellerUsdcRecipient: executor.address,
  sellerCsdScriptHash: SELLER_SCRIPT_B32,
  csdGenesisHash:      CSD_GENESIS_HASH,
  tradeIntentHash:     TRADE_INTENT_HASH,
  csdAmount:           CSD_AMOUNT.toString(),
  usdc:                usdcAddr,
  usdcAmount:          USDC_AMOUNT.toString(),
  minConfirmations:    "1",
  executorFeeAmount:   "0",
  validAfter:          String(now - 60),
  validBefore:         String(now + 3600),
  nonce:               "0x" + "bb".repeat(32),
};

const authSig = await buyer.signTypedData({
  domain, types: csdUsdcNamespace.types(), primaryType: "CsdUsdcAuthorization", message: authStruct,
});

const authObj = await buildCsdUsdcAuthorizationObject({
  authorization: authStruct, signature: authSig, signer: buyer.address, domain,
});

const authRes = await client.putObject(authObj);
console.log("  authorization:", authRes.objectHash);

const reserveObj = await finalizeObject({
  objectType: "reserve", schemaVersion: "1", namespace: "aon:csd-usdc",
  createdAt: Date.now(), creator: buyer.address,
  references: [authObj.objectHash],
  payload: { reserveType: "csd_usdc_intent" },
});
const reserveRes = await client.putObject(reserveObj);
console.log("  reserve:      ", reserveRes.objectHash);

const proofObj = await finalizeObject({
  objectType: "proof", schemaVersion: "1", namespace: "aon:csd-usdc",
  createdAt: Date.now(), creator: executor.address,
  references: [reserveObj.objectHash],
  payload: {
    proofType: "csd_payment", txid, proof: syntheticProof,
    expectedRecipientScriptPubKey: SELLER_SCRIPT_HEX,
    expectedAmount: CSD_AMOUNT.toString(), minConfirmations: 1,
  },
});
const proofRes = await client.putObject(proofObj);
console.log("  proof:        ", proofRes.objectHash);

// 6. Evaluate graph
console.log("\n[6] Evaluating graph...");
const allObjects = await client.listObjects({ namespace: "aon:csd-usdc" });
const ns         = getNamespace("aon:csd-usdc");
const evaluated  = ns.evaluate(allObjects, { includeCompleted: false });
const executable = Array.isArray(evaluated)
  ? evaluated.find(g => g.status === "executable")
  : evaluated.graphs?.find(g => g.status === "executable");
if (!executable) throw new Error("NO_EXECUTABLE_GRAPH");
console.log("  executable graph found");

// 7. Off-chain SPV verify
const verification = ns.verify(executable);
if (!verification.ok) throw new Error("OFF_CHAIN_VERIFY_FAILED: " + JSON.stringify(verification));
console.log("  off-chain SPV verification: ok");

// 8. Lock USDC on-chain
console.log("\n[7] Locking USDC on-chain...");
const lockReceipt = await txn(
  settlementAddr, CsdUsdcSettlement.abi, "lockCsdUsdcAuthorization",
  [
    {
      buyer:               authStruct.buyer,
      sellerUsdcRecipient: authStruct.sellerUsdcRecipient,
      sellerCsdScriptHash: authStruct.sellerCsdScriptHash,
      csdGenesisHash:      authStruct.csdGenesisHash,
      tradeIntentHash:     authStruct.tradeIntentHash,
      csdAmount:           BigInt(authStruct.csdAmount),
      usdc:                authStruct.usdc,
      usdcAmount:          BigInt(authStruct.usdcAmount),
      minConfirmations:    BigInt(authStruct.minConfirmations),
      executorFeeAmount:   BigInt(authStruct.executorFeeAmount),
      validAfter:          BigInt(authStruct.validAfter),
      validBefore:         BigInt(authStruct.validBefore),
      nonce:               authStruct.nonce,
    },
    authSig,
  ],
  buyer
);
console.log("  lockCsdUsdcAuthorization tx:", lockReceipt.transactionHash);
const contractBalance = await read(usdcAddr, MockUSDC.abi, "balanceOf", [settlementAddr]);
console.log("  contract USDC balance:", contractBalance.toString(), "(locked)");

// 9. Settle on-chain
console.log("\n[8] Settling on-chain...");
const spvProof = {
  txRaw: ("0x" + rawTxBuf.toString("hex")),
  merkleBranch: [],
  header: csdHeader,
  genesisHash: CSD_GENESIS_HASH,
  // minConfirmations=1 means the settlement block itself counts.
  // For minConfirmations=N, provide N-1 additional headers here.
  confirmationChain: [],
};

const settleReceipt = await txn(
  settlementAddr, CsdUsdcSettlement.abi, "settleCsdUsdc",
  [
    {
      buyer:               authStruct.buyer,
      sellerUsdcRecipient: authStruct.sellerUsdcRecipient,
      sellerCsdScriptHash: authStruct.sellerCsdScriptHash,
      csdGenesisHash:      authStruct.csdGenesisHash,
      tradeIntentHash:     authStruct.tradeIntentHash,
      csdAmount:           BigInt(authStruct.csdAmount),
      usdc:                authStruct.usdc,
      usdcAmount:          BigInt(authStruct.usdcAmount),
      minConfirmations:    BigInt(authStruct.minConfirmations),
      executorFeeAmount:   BigInt(authStruct.executorFeeAmount),
      validAfter:          BigInt(authStruct.validAfter),
      validBefore:         BigInt(authStruct.validBefore),
      nonce:               authStruct.nonce,
    },
    authSig,
    spvProof,
  ],
  executor
);

console.log("  settleCsdUsdc tx:", settleReceipt.transactionHash);
console.log("  gas used:", settleReceipt.gasUsed.toString());
console.log("  status:", settleReceipt.status);

// 10. Verify balances
console.log("\n[9] Verifying final balances...");
const sellerFinal  = await read(usdcAddr, MockUSDC.abi, "balanceOf", [executor.address]);
const buyerFinal   = await read(usdcAddr, MockUSDC.abi, "balanceOf", [buyer.address]);
const contractFinal = await read(usdcAddr, MockUSDC.abi, "balanceOf", [settlementAddr]);
console.log("  seller (executor) USDC:", sellerFinal.toString(), "(should be 1000000)");
console.log("  buyer USDC:            ", buyerFinal.toString(),  "(should be 1000000)");
console.log("  contract USDC:         ", contractFinal.toString(), "(should be 0)");

if (sellerFinal !== USDC_AMOUNT) throw new Error(`SELLER_BALANCE_WRONG: got ${sellerFinal}`);
if (contractFinal !== 0n)       throw new Error(`CONTRACT_BALANCE_WRONG: got ${contractFinal}`);

// 11. Submit receipt to AON
console.log("\n[10] Submitting receipt to AON...");
const receiptObj = await finalizeObject({
  objectType: "receipt", schemaVersion: "1", namespace: "aon:csd-usdc",
  createdAt: Date.now(), creator: executor.address,
  references: [
    executable.authorization.objectHash,
    executable.reserve.objectHash,
    executable.proof.objectHash,
  ],
  payload: {
    receiptType: "authorized_state_transition_completed",
    executionTx: settleReceipt.transactionHash,
    gasUsed: settleReceipt.gasUsed.toString(),
    verification,
  },
});
const receiptRes = await client.putObject(receiptObj);
console.log("  receipt:", receiptRes.objectHash);

console.log("\n=== ok: csd-usdc full on-chain flow completed ===");
