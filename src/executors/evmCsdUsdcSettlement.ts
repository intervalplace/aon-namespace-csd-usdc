import {
  createWalletClient,
  createPublicClient,
  http,
  getAddress,
  defineChain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── ABI ───────────────────────────────────────────────────────────────────────

const AUTH_COMPONENTS = [
  { name: "buyer",               type: "address"  },
  { name: "sellerUsdcRecipient", type: "address"  },
  { name: "sellerCsdScriptHash", type: "bytes32"  },
  { name: "csdGenesisHash",      type: "bytes32"  },
  { name: "tradeIntentHash",     type: "bytes32"  },
  { name: "csdAmount",           type: "uint256"  },
  { name: "usdc",                type: "address"  },
  { name: "usdcAmount",          type: "uint256"  },
  { name: "minConfirmations",    type: "uint256"  },
  { name: "executorFeeAmount",   type: "uint256"  },
  { name: "validAfter",          type: "uint64"   },
  { name: "validBefore",         type: "uint64"   },
  { name: "nonce",               type: "bytes32"  },
] as const;

const SPV_PROOF_COMPONENTS = [
  { name: "txRaw",       type: "bytes" },
  {
    name: "merkleBranch", type: "tuple[]",
    components: [
      { name: "hash",   type: "bytes32" },
      { name: "isLeft", type: "bool"    },
    ],
  },
  {
    name: "header", type: "tuple",
    components: [
      { name: "version", type: "uint32"  },
      { name: "prev",    type: "bytes32" },
      { name: "merkle",  type: "bytes32" },
      { name: "time",    type: "uint64"  },
      { name: "bits",    type: "uint32"  },
      { name: "nonce",   type: "uint32"  },
    ],
  },
  { name: "genesisHash", type: "bytes32" },
  {
    name: "confirmationChain", type: "tuple[]",
    components: [
      { name: "version", type: "uint32"  },
      { name: "prev",    type: "bytes32" },
      { name: "merkle",  type: "bytes32" },
      { name: "time",    type: "uint64"  },
      { name: "bits",    type: "uint32"  },
      { name: "nonce",   type: "uint32"  },
    ],
  },
] as const;

const abi = [
  {
    type: "function",
    name: "lockCsdUsdcAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "auth",    type: "tuple",  components: AUTH_COMPONENTS },
      { name: "authSig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settleCsdUsdc",
    stateMutability: "nonpayable",
    inputs: [
      { name: "auth",     type: "tuple", components: AUTH_COMPONENTS  },
      { name: "authSig",  type: "bytes"                               },
      { name: "spvProof", type: "tuple", components: SPV_PROOF_COMPONENTS },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "refundExpiredLock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "auth", type: "tuple", components: AUTH_COMPONENTS },
    ],
    outputs: [],
  },
  // errors
  { type: "error", name: "BadSignature",               inputs: [] },
  { type: "error", name: "CsdGenesisHashMismatch",     inputs: [] },
  { type: "error", name: "CsdMerkleInvalid",           inputs: [] },
  { type: "error", name: "CsdPaymentOutputNotFound",   inputs: [] },
  { type: "error", name: "CsdInsufficientPoW",         inputs: [] },
  { type: "error", name: "TransferFailed",             inputs: [] },
  { type: "error", name: "AuthorizationAlreadyFinalized", inputs: [{ name: "authHash", type: "bytes32" }] },
  { type: "error", name: "AuthorizationExpired",          inputs: [{ name: "authHash", type: "bytes32" }] },
  { type: "error", name: "AuthorizationLocked",           inputs: [{ name: "authHash", type: "bytes32" }, { name: "lockedUntil", type: "uint256" }] },
  { type: "error", name: "AuthorizationNotLocked",        inputs: [{ name: "authHash", type: "bytes32" }] },
  { type: "error", name: "CsdTxAlreadyConsumed",          inputs: [{ name: "csdTxid",  type: "bytes32" }] },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name}_MISSING`);
  return v;
}

function asHex(x: any, code: string): Hex {
  if (typeof x !== "string" || !x.startsWith("0x")) throw new Error(code);
  return x as Hex;
}

function authTuple(a: any) {
  return {
    buyer:               getAddress(a.buyer),
    sellerUsdcRecipient: getAddress(a.sellerUsdcRecipient),
    sellerCsdScriptHash: asHex(a.sellerCsdScriptHash, "INVALID_SELLER_CSD_SCRIPT_HASH"),
    csdGenesisHash:      asHex(a.csdGenesisHash,      "INVALID_CSD_GENESIS_HASH"),
    tradeIntentHash:     asHex(a.tradeIntentHash,      "INVALID_TRADE_INTENT_HASH"),
    csdAmount:           BigInt(a.csdAmount),
    usdc:                getAddress(a.usdc),
    usdcAmount:          BigInt(a.usdcAmount),
    minConfirmations:    BigInt(a.minConfirmations),
    executorFeeAmount:   BigInt(a.executorFeeAmount ?? 0),
    validAfter:          BigInt(a.validAfter),
    validBefore:         BigInt(a.validBefore),
    nonce:               asHex(a.nonce, "INVALID_NONCE"),
  };
}

function spvProofTuple(p: any) {
  return {
    txRaw: asHex(p.tx_raw, "INVALID_TX_RAW"),
    merkleBranch: (p.merkle_branch ?? []).map((step: any) => ({
      hash:   asHex(step.hash,   "INVALID_MERKLE_HASH"),
      isLeft: step.position === "left",
    })),
    header: {
      version: Number(p.header.version),
      prev:    asHex(p.header.prev,   "INVALID_HEADER_PREV"),
      merkle:  asHex(p.header.merkle, "INVALID_HEADER_MERKLE"),
      time:    BigInt(p.header.time),
      bits:    Number(p.header.bits),
      nonce:   Number(p.header.nonce),
    },
    genesisHash:       asHex(p.genesis_hash, "INVALID_GENESIS_HASH"),
    // Confirmation headers beyond the settlement block (empty when minConfirmations=1)
    confirmationChain: (p.confirmation_chain ?? []).map((h: any) => ({
      version: Number(h.version),
      prev:    asHex(h.prev,   "INVALID_CONF_PREV"),
      merkle:  asHex(h.merkle, "INVALID_CONF_MERKLE"),
      time:    BigInt(h.time),
      bits:    Number(h.bits),
      nonce:   Number(h.nonce),
    })),
  };
}

function makeClients(rpcUrl: string, privateKey: Hex, chainId: number) {
  // Derive chain from the authorization's EIP-712 domain chainId.
  // Ensures the executor submits to the same chain the parties signed for.
  const chain = defineChain({
    id:             chainId,
    name:           `evm-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls:        { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(privateKey);
  const wallet  = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const pub     = createPublicClient({           chain, transport: http(rpcUrl) });
  return { account, wallet, pub };
}

// ── Exported functions ────────────────────────────────────────────────────────

export async function executeCsdUsdcSettlementOnEvm(args: {
  authorization: any;
  reserve: any;
  proof: any;
}) {
  const contract    = getAddress(requireEnv("AON_SETTLEMENT_CONTRACT"));
  const rpcUrl      = requireEnv("AON_EVM_RPC_URL");
  const privateKey  = asHex(requireEnv("AON_EXECUTOR_PRIVATE_KEY"), "INVALID_EXECUTOR_PRIVATE_KEY");

  const domain  = args.authorization.signature?.domain;
  if (!domain) throw new Error("MISSING_EIP712_DOMAIN");
  const chainId = Number(domain.chainId);

  const { account, wallet, pub } = makeClients(rpcUrl, privateKey, chainId);

  const auth       = args.authorization.payload.authorization;
  const sig        = args.authorization.signature?.signature;
  const proofData  = args.proof.payload?.proof;

  if (!sig)       throw new Error("AUTH_SIGNATURE_MISSING");
  if (!proofData) throw new Error("CSD_PROOF_PAYLOAD_MISSING");

  const tx = await wallet.writeContract({
    address:      contract,
    abi,
    functionName: "settleCsdUsdc",
    args: [authTuple(auth), asHex(sig, "INVALID_AUTH_SIG"), spvProofTuple(proofData)],
  });

  const receipt = await pub.waitForTransactionReceipt({ hash: tx, confirmations: 1 });

  return {
    executed:    true,
    mode:        "contract",
    executionTx: tx,
    result:      "csd_usdc_settlement_submitted",
    details: {
      settlementContract: contract,
      executor:           account.address,
      tx,
      status:             receipt.status,
      blockNumber:        receipt.blockNumber.toString(),
      gasUsed:            receipt.gasUsed.toString(),
    },
  };
}

export async function lockCsdUsdcOnEvm(args: { authorization: any }) {
  const contract   = getAddress(requireEnv("AON_SETTLEMENT_CONTRACT"));
  const rpcUrl     = requireEnv("AON_EVM_RPC_URL");
  const privateKey = asHex(requireEnv("AON_EXECUTOR_PRIVATE_KEY"), "INVALID_EXECUTOR_PRIVATE_KEY");

  const domain  = args.authorization.signature?.domain;
  if (!domain) throw new Error("MISSING_EIP712_DOMAIN");
  const chainId = Number(domain.chainId);

  const { account, wallet, pub } = makeClients(rpcUrl, privateKey, chainId);

  const auth = args.authorization.payload.authorization;
  const sig  = args.authorization.signature?.signature;
  if (!sig) throw new Error("AUTH_SIGNATURE_MISSING");

  const tx = await wallet.writeContract({
    address:      contract,
    abi,
    functionName: "lockCsdUsdcAuthorization",
    args:         [authTuple(auth), asHex(sig, "INVALID_AUTH_SIG")],
  });

  const receipt = await pub.waitForTransactionReceipt({ hash: tx, confirmations: 1 });

  return {
    ok: true, mode: "contract", lockTx: tx,
    receipt: {
      transactionHash: receipt.transactionHash,
      blockHash:       receipt.blockHash,
      blockNumber:     receipt.blockNumber.toString(),
      status:          receipt.status,
      gasUsed:         receipt.gasUsed.toString(),
    },
    settlementContract: contract,
    executor:           account.address,
    buyer:              auth.buyer,
    usdc:               auth.usdc,
    usdcAmount:         String(auth.usdcAmount),
  };
}

export async function refundExpiredCsdUsdcLockOnEvm(args: { authorization: any }) {
  const contract   = getAddress(requireEnv("AON_SETTLEMENT_CONTRACT"));
  const rpcUrl     = requireEnv("AON_EVM_RPC_URL");
  const privateKey = asHex(requireEnv("AON_EXECUTOR_PRIVATE_KEY"), "INVALID_EXECUTOR_PRIVATE_KEY");

  const domain  = args.authorization.signature?.domain;
  if (!domain) throw new Error("MISSING_EIP712_DOMAIN");
  const chainId = Number(domain.chainId);

  const { account, wallet, pub } = makeClients(rpcUrl, privateKey, chainId);

  const auth = args.authorization.payload.authorization;

  const tx = await wallet.writeContract({
    address:      contract,
    abi,
    functionName: "refundExpiredLock",
    args:         [authTuple(auth)],
  });

  const receipt = await pub.waitForTransactionReceipt({ hash: tx, confirmations: 1 });

  return {
    ok: true, mode: "contract", refundTx: tx,
    receipt: {
      transactionHash: receipt.transactionHash,
      blockHash:       receipt.blockHash,
      blockNumber:     receipt.blockNumber.toString(),
      status:          receipt.status,
      gasUsed:         receipt.gasUsed.toString(),
    },
    settlementContract: contract,
    executor:           account.address,
    buyer:              auth.buyer,
    refundedAmount:     String(BigInt(auth.usdcAmount) + BigInt(auth.executorFeeAmount ?? 0)),
  };
}
