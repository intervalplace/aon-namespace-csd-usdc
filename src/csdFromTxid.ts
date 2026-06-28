

export async function fetchCsdProofByTxid(txid: string) {
  const base = process.env.CSD_RPC_URL ?? "http://127.0.0.1:8887";
  const res = await fetch(`${base}/proof/tx/${txid}`);

  if (!res.ok) {
    throw new Error(`CSD_PROOF_FETCH_FAILED_${res.status}`);
  }

  return await res.json();
}

export async function makeCsdPaymentProofObject(args: {
  reserveHash: string;
  txid: string;
  expectedRecipientScriptPubKey?: string;
  expectedAmount?: string | number | bigint;
  minConfirmations?: number;
  expectedIntentHash?: string;
}) {
  const proof = await fetchCsdProofByTxid(args.txid);

  return {
    objectType: "proof",
    schemaVersion: "1",
    namespace: "aon:csd-usdc",
    createdAt: Date.now(),
    creator: "aon-node-v0",
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
  };
}
