import { finalizeObject } from "@intervalplace/aon-sdk";
import { verifyCsdPaymentProof } from "./verifiers/csd.js";

export async function fetchCsdProofByTxid(txid: string) {
  const base = process.env.CSD_RPC_URL ?? "http://127.0.0.1:8887";
  const res = await fetch(`${base}/proof/tx/${txid}`);

  if (!res.ok) {
    throw new Error(`CSD_PROOF_FETCH_FAILED_${res.status}`);
  }

  return await res.json();
}

// The settlement contract checks a self-contained proof: the payment block
// plus the blocks after it. The CSD node's /proof endpoint returns the block;
// this adds the next (minConfirmations - 1) headers as confirmation_chain.
export async function addConfirmationChain(proof: any, minConfirmations: number) {
  const base = process.env.CSD_RPC_URL ?? "http://127.0.0.1:8887";
  const chain: any[] = [];
  for (let h = Number(proof.height) + 1; h < Number(proof.height) + minConfirmations; h++) {
    const res = await fetch(`${base}/block/height/${h}`);
    if (!res.ok) throw new Error(`CSD_HEADER_FETCH_FAILED_${res.status}`);
    const b = await res.json();
    if (!b?.header || b.header.err) throw new Error("CSD_NOT_ENOUGH_CONFIRMATIONS_YET");
    chain.push(b.header);
  }
  proof.confirmation_chain = chain;
  return proof;
}

export async function makeCsdPaymentProofObject(args: {
  reserveHash: string;
  txid: string;
  expectedRecipientScriptPubKey?: string;
  expectedAmount?: string | number | bigint;
  minConfirmations?: number;
  expectedIntentHash?: string;
}) {
  const proof = await addConfirmationChain(await fetchCsdProofByTxid(args.txid), args.minConfirmations ?? 1);

  // M23: Verify the proof locally before publishing — prevents invalid proof
  // objects from propagating through the network and wasting storage/bandwidth
  if (args.expectedRecipientScriptPubKey && args.expectedAmount !== undefined) {
    verifyCsdPaymentProof({
      proof,
      expectedRecipientScriptPubKey: args.expectedRecipientScriptPubKey as any,
      expectedAmount: BigInt(String(args.expectedAmount)),
      minConfirmations: args.minConfirmations ?? 1,
      expectedGenesisHash: undefined,
    });
  }

  return finalizeObject({
    objectType: "proof",
    schemaVersion: "1",
    namespace: "aon:csd-usdc",
    createdAt: Date.now(),
    references: [args.reserveHash],
    payload: {
      proofType: "csd_payment",
      txid: args.txid,
      proof,
      expectedRecipientScriptPubKey: args.expectedRecipientScriptPubKey,
      expectedAmount:
        args.expectedAmount !== undefined
          ? String(args.expectedAmount)
          : undefined,
      minConfirmations: args.minConfirmations ?? 1,
      expectedIntentHash: args.expectedIntentHash,
    },
  });
}
