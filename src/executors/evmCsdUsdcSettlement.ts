import { createWalletClient, createPublicClient, http, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const abi = [
  {
    type: "function",
    name: "lockCsdUsdcAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "auth",
        type: "tuple",
        components: [
          { name: "buyer", type: "address" },
          { name: "sellerUsdcRecipient", type: "address" },
          { name: "sellerCsdScriptHash", type: "bytes32" },
          { name: "csdGenesisHash", type: "bytes32" },
          { name: "tradeIntentHash", type: "bytes32" },
          { name: "csdAmount", type: "uint256" },
          { name: "usdc", type: "address" },
          { name: "usdcAmount", type: "uint256" },
          { name: "minConfirmations", type: "uint256" },
          { name: "executorFeeAmount", type: "uint256" },
          { name: "validAfter", type: "uint64" },
          { name: "validBefore", type: "uint64" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      { name: "authSig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settleCsdUsdc",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "auth",
        type: "tuple",
        components: [
          { name: "buyer", type: "address" },
          { name: "sellerUsdcRecipient", type: "address" },
          { name: "sellerCsdScriptHash", type: "bytes32" },
          { name: "csdGenesisHash", type: "bytes32" },
          { name: "tradeIntentHash", type: "bytes32" },
          { name: "csdAmount", type: "uint256" },
          { name: "usdc", type: "address" },
          { name: "usdcAmount", type: "uint256" },
          { name: "minConfirmations", type: "uint256" },
          { name: "executorFeeAmount", type: "uint256" },
          { name: "validAfter", type: "uint64" },
          { name: "validBefore", type: "uint64" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      { name: "authSig", type: "bytes" },
      {
        name: "proof",
        type: "tuple",
        components: [
          { name: "csdTxid", type: "bytes32" },
          { name: "csdGenesisHash", type: "bytes32" },
          { name: "sellerCsdScriptHash", type: "bytes32" },
          { name: "tradeIntentHash", type: "bytes32" },
          { name: "csdAmount", type: "uint256" },
          { name: "confirmations", type: "uint256" },
          { name: "blockHash", type: "bytes32" },
          { name: "blockHeight", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },

{
  type: "function",
  name: "refundExpiredLock",
  stateMutability: "nonpayable",
  inputs: [
    {
      name: "auth",
      type: "tuple",
      components: [
        { name: "buyer", type: "address" },
        { name: "sellerUsdcRecipient", type: "address" },
        { name: "sellerCsdScriptHash", type: "bytes32" },
        { name: "csdGenesisHash", type: "bytes32" },
        { name: "tradeIntentHash", type: "bytes32" },
        { name: "csdAmount", type: "uint256" },
        { name: "usdc", type: "address" },
        { name: "usdcAmount", type: "uint256" },
        { name: "minConfirmations", type: "uint256" },
        { name: "executorFeeAmount", type: "uint256" },
        { name: "validAfter", type: "uint64" },
        { name: "validBefore", type: "uint64" },
        { name: "nonce", type: "bytes32" },
      ],
    },
  ],
  outputs: [],
},

  { type: "error", name: "UnauthorizedExecutor", inputs: [] },
  { type: "error", name: "BadSignature", inputs: [] },
  { type: "error", name: "InvalidProofAttestation", inputs: [] },
  { type: "error", name: "InsufficientConfirmations", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },

  {
    type: "error",
    name: "AuthorizationRevoked",
    inputs: [{ name: "authHash", type: "bytes32" }],
  },
  {
    type: "error",
    name: "AuthorizationExpired",
    inputs: [{ name: "authHash", type: "bytes32" }],
  },
  {
    type: "error",
    name: "AuthorizationAlreadyFinalized",
    inputs: [{ name: "authHash", type: "bytes32" }],
  },
  {
    type: "error",
    name: "AuthorizationLocked",
    inputs: [
      { name: "authHash", type: "bytes32" },
      { name: "lockedUntil", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "AuthorizationNotLocked",
    inputs: [{ name: "authHash", type: "bytes32" }],
  },
  {
    type: "error",
    name: "CsdTxAlreadyConsumed",
    inputs: [{ name: "csdTxid", type: "bytes32" }],
  },
] as const;

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function asHex(x: any, code: string): Hex {
  if (typeof x !== "string" || !x.startsWith("0x")) throw new Error(code);
  return x as Hex;
}

export async function executeCsdUsdcSettlementOnEvm(args: {
  authorization: any;
  reserve: any;
  proof: any;
}) {
  const contract = getAddress(requireEnv("AON_SETTLEMENT_CONTRACT"));
  const rpcUrl = requireEnv("AON_EVM_RPC_URL");
  const privateKey = asHex(requireEnv("AON_EXECUTOR_PRIVATE_KEY"), "INVALID_EXECUTOR_PRIVATE_KEY");

  const account = privateKeyToAccount(privateKey);

  const client = createWalletClient({
    account,
    chain: mainnet,
    transport: http(rpcUrl),
  });

  const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(rpcUrl),
});

  const auth = args.authorization.payload.authorization;
  const sig = args.authorization.signature?.signature;
  const csdTxid = args.proof.payload?.txid ?? args.proof.payload?.proof?.txid;

  if (!sig) throw new Error("AUTH_SIGNATURE_MISSING");
  if (!csdTxid) throw new Error("CSD_TXID_MISSING");

    const authTuple = {
    buyer: getAddress(auth.buyer),
    sellerUsdcRecipient: getAddress(auth.sellerUsdcRecipient),
    sellerCsdScriptHash: asHex(auth.sellerCsdScriptHash, "INVALID_SELLER_CSD_SCRIPT_HASH"),
    csdGenesisHash: asHex(auth.csdGenesisHash, "INVALID_CSD_GENESIS_HASH"),
    tradeIntentHash: asHex(auth.tradeIntentHash, "INVALID_TRADE_INTENT_HASH"),
    csdAmount: BigInt(auth.csdAmount),
    usdc: getAddress(auth.usdc),
    usdcAmount: BigInt(auth.usdcAmount),
    minConfirmations: BigInt(auth.minConfirmations),
    executorFeeAmount: BigInt(auth.executorFeeAmount),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: asHex(auth.nonce, "INVALID_NONCE"),
  };

  const proofPayload = args.proof.payload?.proof;

  const proofTuple = {
    csdTxid: asHex(csdTxid, "INVALID_CSD_TXID"),
    csdGenesisHash: asHex(proofPayload?.genesis_hash, "INVALID_PROOF_GENESIS_HASH"),
    sellerCsdScriptHash: asHex(auth.sellerCsdScriptHash, "INVALID_SELLER_CSD_SCRIPT_HASH"),
    tradeIntentHash: asHex(auth.tradeIntentHash, "INVALID_TRADE_INTENT_HASH"),
    csdAmount: BigInt(auth.csdAmount),
    confirmations: BigInt(proofPayload?.confirmations ?? 0),
    blockHash: asHex(proofPayload?.block_hash, "INVALID_PROOF_BLOCK_HASH"),
    blockHeight: BigInt(proofPayload?.height ?? 0),
  };


const settleTx = await client.writeContract({
  address: contract,
  abi,
  functionName: "settleCsdUsdc",
  args: [authTuple, asHex(sig, "INVALID_AUTH_SIGNATURE"), proofTuple],
});

await publicClient.waitForTransactionReceipt({
  hash: settleTx,
  confirmations: 1,
});

return {
  executed: true,
  mode: "contract",
  executionTx: settleTx,
  result: "contract_settlement_submitted",
  details: {
      settleTx,
  },
};
}

export async function refundExpiredCsdUsdcLockOnEvm(args: {
  authorization: any;
}) {
  const contract = getAddress(requireEnv("AON_SETTLEMENT_CONTRACT"));
  const rpcUrl = requireEnv("AON_EVM_RPC_URL");
  const privateKey = asHex(requireEnv("AON_EXECUTOR_PRIVATE_KEY"), "INVALID_EXECUTOR_PRIVATE_KEY");

  const account = privateKeyToAccount(privateKey);

  const client = createWalletClient({
    account,
    chain: mainnet,
    transport: http(rpcUrl),
  });

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });

  const auth = args.authorization.payload.authorization;

  const authTuple = {
    buyer: getAddress(auth.buyer),
    sellerUsdcRecipient: getAddress(auth.sellerUsdcRecipient),
    sellerCsdScriptHash: asHex(auth.sellerCsdScriptHash, "INVALID_SELLER_CSD_SCRIPT_HASH"),
    csdGenesisHash: asHex(auth.csdGenesisHash, "INVALID_CSD_GENESIS_HASH"),
    tradeIntentHash: asHex(auth.tradeIntentHash, "INVALID_TRADE_INTENT_HASH"),
    csdAmount: BigInt(auth.csdAmount),
    usdc: getAddress(auth.usdc),
    usdcAmount: BigInt(auth.usdcAmount),
    minConfirmations: BigInt(auth.minConfirmations),
    executorFeeAmount: BigInt(auth.executorFeeAmount ?? 0),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: asHex(auth.nonce, "INVALID_NONCE"),
  };

  const refundTx = await client.writeContract({
    address: contract,
    abi,
    functionName: "refundExpiredLock",
    args: [authTuple],
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: refundTx,
    confirmations: 1,
  });

  return {
    ok: true,
    mode: "contract",
    refundTx,
    receipt: {
      transactionHash: receipt.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber.toString(),
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
    },
    settlementContract: contract,
    executor: account.address,
    buyer: auth.buyer,
    usdc: auth.usdc,
    refundedAmount: String(BigInt(auth.usdcAmount) + BigInt(auth.executorFeeAmount ?? 0)),
  };
}

export async function lockCsdUsdcOnEvm(args: {
  authorization: any;
}) {
  const contract = getAddress(requireEnv("AON_SETTLEMENT_CONTRACT"));
  const rpcUrl = requireEnv("AON_EVM_RPC_URL");
  const privateKey = asHex(requireEnv("AON_EXECUTOR_PRIVATE_KEY"), "INVALID_EXECUTOR_PRIVATE_KEY");

  const account = privateKeyToAccount(privateKey);

  const client = createWalletClient({
    account,
    chain: mainnet,
    transport: http(rpcUrl),
  });

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });

  const auth = args.authorization.payload.authorization;
  const sig = args.authorization.signature?.signature;

  if (!sig) throw new Error("AUTH_SIGNATURE_MISSING");

  const authTuple = {
    buyer: getAddress(auth.buyer),
    sellerUsdcRecipient: getAddress(auth.sellerUsdcRecipient),
    sellerCsdScriptHash: asHex(auth.sellerCsdScriptHash, "INVALID_SELLER_CSD_SCRIPT_HASH"),
    csdGenesisHash: asHex(auth.csdGenesisHash, "INVALID_CSD_GENESIS_HASH"),
    tradeIntentHash: asHex(auth.tradeIntentHash, "INVALID_TRADE_INTENT_HASH"),
    csdAmount: BigInt(auth.csdAmount),
    usdc: getAddress(auth.usdc),
    usdcAmount: BigInt(auth.usdcAmount),
    minConfirmations: BigInt(auth.minConfirmations),
    executorFeeAmount: BigInt(auth.executorFeeAmount),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: asHex(auth.nonce, "INVALID_NONCE"),
  };

  const lockTx = await client.writeContract({
    address: contract,
    abi,
    functionName: "lockCsdUsdcAuthorization",
    args: [authTuple, asHex(sig, "INVALID_AUTH_SIGNATURE")],
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: lockTx,
    confirmations: 1,
  });

return {
  ok: true,
  mode: "contract",
  lockTx,
  receipt: {
    transactionHash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(),
    status: receipt.status,
    gasUsed: receipt.gasUsed.toString(),
  },
  settlementContract: contract,
  executor: account.address,
  buyer: auth.buyer,
  usdc: auth.usdc,
  usdcAmount: String(auth.usdcAmount),
};
}
