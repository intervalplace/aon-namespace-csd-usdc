import type { AonObject } from "@intervalplace/aon-sdk";

export async function validateAuthorization(obj: AonObject) {
  if (obj.objectType !== "authorization") return;
  if (!obj.payload?.authorization) throw new Error("AUTH_PAYLOAD_MISSING");
}
