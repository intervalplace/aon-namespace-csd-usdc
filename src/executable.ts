import { AonObject } from "./object.js";

function lowerRefs(obj: AonObject) {
  return (obj.references ?? []).map((x) => x.toLowerCase());
}

export function findExecutableGraphs(
  objects: AonObject[],
  opts?: {
    namespace?: string;
    includeCompleted?: boolean;
  }
) {
  const authorizations = objects.filter((o) =>
    o.objectType === "authorization" &&
    (!opts?.namespace || o.namespace === opts.namespace)
  );

  const reserves = objects.filter((o) =>
    o.objectType === "reserve" &&
    (!opts?.namespace || o.namespace === opts.namespace)
  );

  const proofs = objects.filter((o) =>
    o.objectType === "proof" &&
    (!opts?.namespace || o.namespace === opts.namespace)
  );

  const receipts = objects.filter((o) =>
    o.objectType === "receipt" &&
    (!opts?.namespace || o.namespace === opts.namespace)
  );

  const executable = [];

  for (const auth of authorizations) {
    if (!auth.objectHash) continue;
    const authHash = auth.objectHash.toLowerCase();

    const relatedReserves = reserves.filter((r) =>
      lowerRefs(r).includes(authHash)
    );

    for (const reserve of relatedReserves) {
      if (!reserve.objectHash) continue;
      const reserveHash = reserve.objectHash.toLowerCase();

      const reserveConsumed = receipts.some((r) =>
        lowerRefs(r).includes(reserveHash)
      );

      const relatedProofs = proofs.filter((p) =>
        lowerRefs(p).includes(reserveHash)
      );

      for (const proof of relatedProofs) {
        if (!proof.objectHash) continue;
        const proofHash = proof.objectHash.toLowerCase();

        const exactReceipt = receipts.find((r) => {
          const refs = lowerRefs(r);
          return (
            refs.includes(authHash) &&
            refs.includes(reserveHash) &&
            refs.includes(proofHash)
          );
        });

        const status = exactReceipt
          ? "completed"
          : reserveConsumed
            ? "consumed"
            : "executable";

        if (!opts?.includeCompleted && status !== "executable") continue;

        executable.push({
          status,
          authorization: auth,
          reserve,
          proof,
          receipt: exactReceipt ?? null,
        });
      }
    }
  }

  return executable;
}
