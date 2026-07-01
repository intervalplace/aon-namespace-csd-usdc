import type { AonObject } from "@intervalplace/aon-sdk";

export async function validateRevocation(obj: AonObject) {
  if ((obj.references ?? []).length !== 1) {
    throw new Error("INVALID_REVOCATION_REFERENCE_COUNT");
  }
}
