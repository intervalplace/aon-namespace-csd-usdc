import type { AonObject } from "@intervalplace/aon-sdk";

export async function validateProof(obj: AonObject) {
  if ((obj.references ?? []).length !== 1) {
    throw new Error("INVALID_PROOF_REFERENCE_COUNT");
  }
}
