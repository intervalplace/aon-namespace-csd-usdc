import type { AonObject } from "@intervalplace/aon-sdk";

export async function validateReserve(obj: AonObject) {
  if ((obj.references ?? []).length !== 1) {
    throw new Error("INVALID_RESERVE_REFERENCE_COUNT");
  }
}
