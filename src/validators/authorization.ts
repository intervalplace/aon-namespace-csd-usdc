import { verifyTypedData, type Address, type Hex } from "viem";
import type { AonObject } from "@intervalplace/aon-sdk";

// ── Canonical comparison ───────────────────────────────────────────────────────
// Ensures payload.authorization and signature.message contain the same values.
// A crafted object could have mismatched fields that pass signature verification
// but carry different authorization terms in the payload.

function stableStringify(x: any): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;
  return `{${Object.keys(x)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(x[k])}`)
    .join(",")}}`;
}

function assertSameObject(a: any, b: any) {
  if (stableStringify(a) !== stableStringify(b)) {
    throw new Error("AUTH_PAYLOAD_MESSAGE_MISMATCH");
  }
}

// ── Signature verification ────────────────────────────────────────────────────

export async function verifyAuthorizationObject(obj: AonObject): Promise<void> {
  const sig = (obj as any).signature;
  if (!sig) throw new Error("MISSING_AUTHORIZATION_SIGNATURE");
  if (sig.scheme !== "eip712") throw new Error("UNSUPPORTED_SIGNATURE_SCHEME");

  const payloadAuth = (obj.payload as any)?.authorization;
  if (!payloadAuth) throw new Error("MISSING_AUTHORIZATION_PAYLOAD");

  // Cross-check: payload terms must exactly match what was signed
  assertSameObject(payloadAuth, sig.message);

  // Cryptographic check: recover signer and compare against claimed signer
  const recovered = await verifyTypedData({
    address: sig.signer as Address,
    domain:  sig.domain,
    types:   sig.types,
    primaryType: sig.primaryType,
    message: sig.message,
    signature: sig.signature as Hex,
  });

  if (!recovered) throw new Error("AUTHORIZATION_SIGNATURE_INVALID");
}
