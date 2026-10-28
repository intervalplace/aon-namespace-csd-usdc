import { createHash } from "crypto";
import type { Hex } from "viem";
import type { AonObject } from "@intervalplace/aon-sdk";

export type CsdProof = any;

function strip0x(x: string) {
  return x.startsWith("0x") ? x.slice(2) : x;
}

function hexToBuf(x: string) {
  return Buffer.from(strip0x(x), "hex");
}

function toHex(buf: Buffer): Hex {
  return `0x${buf.toString("hex")}` as Hex;
}

function sha256(buf: Buffer) {
  return createHash("sha256").update(buf).digest();
}

function dsha(buf: Buffer) {
  return sha256(sha256(buf));
}

function u32le(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function u64le(n: number | bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function readU64LE(buf: Buffer, off: number) {
  return Number(buf.readBigUInt64LE(off));
}

function normalizeCsdScriptHash(x: string) {
  const v = x.toLowerCase();

  if (!v.startsWith("0x")) throw new Error("INVALID_CSD_SCRIPT_HASH");

  // bytes20
  if (v.length === 42) return v;

  // bytes32 where bytes20 is left-aligned and zero-padded
  if (v.length === 66 && v.endsWith("000000000000000000000000")) {
    return `0x${v.slice(2, 42)}`;
  }

  throw new Error("INVALID_CSD_SCRIPT_HASH_LENGTH");
}

// CSD txid = double-sha256(tx serialization with input script_sig removed)
function csdTxidFromRaw(txRaw: Hex): Hex {
  const raw = hexToBuf(txRaw);
  let off = 0;

  const parts: Buffer[] = [];

  parts.push(raw.subarray(off, off + 4)); // version
  off += 4;

  const inputCountBytes = raw.subarray(off, off + 8);
  const inputCount = readU64LE(raw, off);
  parts.push(inputCountBytes);
  off += 8;

  for (let i = 0; i < inputCount; i++) {
    parts.push(raw.subarray(off, off + 32)); // prev txid
    off += 32;

    parts.push(raw.subarray(off, off + 4)); // vout
    off += 4;

    const scriptLen = readU64LE(raw, off);
    off += 8;

    parts.push(u64le(0)); // empty script_sig for txid
    off += scriptLen;
  }

  parts.push(raw.subarray(off)); // outputs + locktime/app tail

  return toHex(dsha(Buffer.concat(parts)));
}

// Strict parse of a raw CSD transaction (same rules as the settlement
// contract's _verifyCsdTx): outputs are value u64 + a bare 20-byte address.
export function parseCsdTxOutputs(txRaw: Hex): { value: bigint; script: Hex }[] {
  const raw = hexToBuf(txRaw);
  const need = (n: number) => { if (off + n > raw.length) throw new Error("CSD_TX_MALFORMED"); };
  let off = 4;
  need(8); const inputCount = readU64LE(raw, off); off += 8;
  if (inputCount === 0) throw new Error("CSD_TX_MALFORMED");
  for (let i = 0; i < inputCount; i++) {
    need(44);
    if (i === 0 && raw.subarray(off, off + 32).every(b => b === 0) && raw.readUInt32LE(off + 32) === 0xffffffff) throw new Error("CSD_COINBASE_NOT_SUPPORTED");
    off += 36;
    const sl = readU64LE(raw, off); off += 8; need(sl); off += sl;
  }
  need(8); const outputCount = readU64LE(raw, off); off += 8;
  const outs: { value: bigint; script: Hex }[] = [];
  for (let i = 0; i < outputCount; i++) {
    need(28);
    outs.push({ value: raw.readBigUInt64LE(off), script: ("0x" + raw.subarray(off + 8, off + 28).toString("hex")) as Hex });
    off += 28;
  }
  need(8); off += 4; const variant = raw.readUInt32LE(off); off += 4;
  const str = () => { need(8); const n = readU64LE(raw, off); off += 8; need(n); off += n; };
  if (variant === 1) { str(); need(32); off += 32; str(); need(8); off += 8; }
  else if (variant === 2) { need(40); off += 40; }
  else if (variant !== 0) throw new Error("CSD_TX_MALFORMED");
  if (off !== raw.length) throw new Error("CSD_TX_MALFORMED");
  return outs;
}

function csdMerkleRoot(txid: Hex, branch: { hash: Hex; position: "left" | "right" }[]): Hex {
  let cur = hexToBuf(txid);

  for (const item of branch) {
    const sibling = hexToBuf(item.hash);
    cur =
      item.position === "left"
        ? dsha(Buffer.concat([sibling, cur]))
        : dsha(Buffer.concat([cur, sibling]));
  }

  return toHex(cur);
}

function csdHeaderHash(header: CsdProof["header"]): Hex {
  const encoded = Buffer.concat([
    u32le(header.version),
    hexToBuf(header.prev),
    hexToBuf(header.merkle),
    u64le(header.time),
    u32le(header.bits),
    u32le(header.nonce),
  ]);

  return toHex(dsha(encoded));
}

export function verifyCsdPaymentProof(args: {
  proof: CsdProof;
  expectedRecipientScriptPubKey: Hex;
  expectedIntentHash?: Hex;
  expectedAmount: bigint;
  minConfirmations: number;
  expectedGenesisHash?: Hex;
}) {
  const {
    proof,
    expectedRecipientScriptPubKey,
    expectedAmount,
    minConfirmations,
    expectedGenesisHash,
  } = args;

  if (!proof.ok) throw new Error("CSD_PROOF_NOT_OK");
  if (proof.confirmations < minConfirmations) throw new Error("CSD_CONFIRMATIONS_TOO_LOW");

  const txid = csdTxidFromRaw(proof.tx_raw);
  if (txid.toLowerCase() !== proof.txid.toLowerCase()) throw new Error("CSD_TXID_INVALID");
  if (proof.tx.txid.toLowerCase() !== proof.txid.toLowerCase()) throw new Error("CSD_TX_JSON_MISMATCH");

  const merkle = csdMerkleRoot(proof.txid, proof.merkle_branch ?? []);
  if (merkle.toLowerCase() !== proof.header.merkle.toLowerCase()) throw new Error("CSD_MERKLE_INVALID");

  const blockHash = csdHeaderHash(proof.header);
  if (blockHash.toLowerCase() !== proof.block_hash.toLowerCase()) throw new Error("CSD_BLOCK_HASH_INVALID");

  if (!proof.genesis_hash) throw new Error("CSD_GENESIS_HASH_MISSING");

  if (
    expectedGenesisHash &&
    proof.genesis_hash.toLowerCase() !== expectedGenesisHash.toLowerCase()
  ) {
    throw new Error("CSD_GENESIS_HASH_MISMATCH");
  }

  const expectedScript = normalizeCsdScriptHash(expectedRecipientScriptPubKey);

  // Read the outputs from the raw bytes (bound to the txid), not the JSON
  const paid = parseCsdTxOutputs(proof.tx_raw).some(o =>
    o.script.toLowerCase() === expectedScript.toLowerCase() && o.value >= expectedAmount);

  if (!paid) throw new Error("CSD_PAYMENT_OUTPUT_NOT_FOUND");

  if (args.expectedIntentHash) {
    const appIntentHash =
      proof.tx?.app?.intentHash ??
      proof.tx?.app?.value?.intentHash ??
      proof.tx?.app?.data?.intentHash;

    if (!appIntentHash) throw new Error("CSD_INTENT_HASH_MISSING");

    if (appIntentHash.toLowerCase() !== args.expectedIntentHash.toLowerCase()) {
      throw new Error("CSD_INTENT_HASH_MISMATCH");
    }
  }

  return {
    ok: true,
    txid: proof.txid,
    blockHash: proof.block_hash,
    height: proof.height,
    confirmations: proof.confirmations,
    genesisHash: proof.genesis_hash,
  };
}

export function verifyCsdProofObject(condition: AonObject, proofObj: AonObject) {
  if (proofObj.objectType !== "proof") {
    throw new Error("INVALID_PROOF_OBJECT");
  }

  if (!proofObj.payload) {
    throw new Error("PROOF_PAYLOAD_MISSING");
  }

  const proofType = proofObj.payload.proofType;

  if (proofType !== "csd_payment") {
    throw new Error("UNSUPPORTED_PROOF_TYPE");
  }


  if (!proofObj.payload.proof) {
    throw new Error("CSD_PROOF_PAYLOAD_MISSING");
  }

  if (!condition.payload) {
    throw new Error("CONDITION_PAYLOAD_MISSING");
  }

  const expectedRecipientScriptPubKey =
    condition.payload.expectedRecipientScriptPubKey;
  const expectedAmount        = condition.payload.expectedAmount;
  const minConfirmations      = condition.payload.minConfirmations ?? 1;
  const expectedIntentHash    = condition.payload.expectedIntentHash;
  const expectedGenesisHash   = condition.payload.expectedGenesisHash;

  // H7: Null guards FIRST — before any cross-checks that silently skip on undefined
  if (typeof expectedRecipientScriptPubKey !== "string") {
    throw new Error("CSD_EXPECTED_RECIPIENT_SCRIPT_MISSING");
  }
  if (expectedAmount === undefined || expectedAmount === null) {
    throw new Error("CSD_EXPECTED_AMOUNT_MISSING");
  }

  // Cross-checks between proof and condition fields (now safe — fields are confirmed non-null)
  const proofExpectedRecipientScriptPubKey = proofObj.payload.expectedRecipientScriptPubKey;
  const proofExpectedAmount                = proofObj.payload.expectedAmount;
  const proofExpectedIntentHash            = proofObj.payload.expectedIntentHash;

  if (
    typeof proofExpectedRecipientScriptPubKey === "string" &&
    normalizeCsdScriptHash(proofExpectedRecipientScriptPubKey) !==
      normalizeCsdScriptHash(expectedRecipientScriptPubKey)
  ) {
    throw new Error("PROOF_CONDITION_RECIPIENT_MISMATCH");
  }

  if (
    proofExpectedAmount !== undefined &&
    String(proofExpectedAmount) !== String(expectedAmount)
  ) {
    throw new Error("PROOF_CONDITION_AMOUNT_MISMATCH");
  }

  if (
    typeof proofExpectedIntentHash === "string" &&
    typeof expectedIntentHash === "string" &&
    proofExpectedIntentHash.toLowerCase() !== expectedIntentHash.toLowerCase()
  ) {
    throw new Error("PROOF_CONDITION_INTENT_HASH_MISMATCH");
  }

  return verifyCsdPaymentProof({
    proof: proofObj.payload.proof,
    expectedRecipientScriptPubKey: expectedRecipientScriptPubKey as Hex,
    expectedAmount: BigInt(String(expectedAmount)),
    minConfirmations: Number(minConfirmations),
    expectedIntentHash:
      typeof expectedIntentHash === "string"
        ? (expectedIntentHash as Hex)
        : undefined,
    expectedGenesisHash:
      typeof expectedGenesisHash === "string"
        ? (expectedGenesisHash as Hex)
        : undefined,
  });
}
