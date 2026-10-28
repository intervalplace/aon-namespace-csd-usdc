import { getAddress, hashTypedData, verifyTypedData, type Address, type Hex } from "viem";
import type { AonObject } from "@intervalplace/aon-sdk";

// ── Canonical comparison ───────────────────────────────────────────────────────
// Ensures payload.authorization and signature.message contain the same values.
// Without this check, a crafted authorization could have payload fields that
// differ from what was actually signed — appearing valid off-chain while being
// unexecutable on-chain (the contract uses the EIP-712 hash, not the payload).

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

  // The contract only accepts the buyer's signature, so the claimed signer
  // must be the buyer; otherwise the object could never execute.
  if (getAddress(sig.signer) !== getAddress(payloadAuth.buyer)) throw new Error("SIGNER_BUYER_MISMATCH");

  // Cryptographic check: recover signer and compare against claimed signer
  const recovered = await verifyTypedData({
    address:     sig.signer as Address,
    domain:      sig.domain,
    types:       sig.types,
    primaryType: sig.primaryType,
    message:     sig.message,
    signature:   sig.signature as Hex,
  });

  if (!recovered) throw new Error("AUTHORIZATION_SIGNATURE_INVALID");
}

// ── Early release ─────────────────────────────────────────────────────────────
// A release object: the buyer's EIP-712 signature over CsdUsdcEarlyRelease
// { authHash, sellerUsdcRecipient, usdcAmount, csdTxid, lockedAt, deadline }.

export function csdUsdcAuthHash(authorizationObject: AonObject): Hex {
  const sig = (authorizationObject as any).signature;
  return hashTypedData({
    domain:      sig.domain,
    types:       sig.types,
    primaryType: sig.primaryType,
    message:     sig.message,
  } as any);
}

export async function verifyEarlyReleaseObject(obj: AonObject): Promise<void> {
  const p   = (obj.payload as any) ?? {};
  const sig = p.signature;
  if (p.releaseType !== "csd_usdc_early_release") throw new Error("UNKNOWN_RELEASE_TYPE");
  if (!sig || sig.scheme !== "eip712")             throw new Error("MISSING_RELEASE_SIGNATURE");
  if (sig.primaryType !== "CsdUsdcEarlyRelease")   throw new Error("WRONG_RELEASE_PRIMARY_TYPE");
  assertSameObject(p.release, sig.message);
  if (String(p.release?.authHash).toLowerCase() !== String(p.authHash).toLowerCase())
    throw new Error("RELEASE_PAYLOAD_MESSAGE_MISMATCH");
  if (getAddress(sig.signer) !== getAddress(p.buyer)) throw new Error("RELEASE_SIGNER_NOT_BUYER");
  const ok = await verifyTypedData({
    address:     sig.signer as Address,
    domain:      sig.domain,
    types:       sig.types,
    primaryType: sig.primaryType,
    message:     sig.message,
    signature:   sig.signature as Hex,
  });
  if (!ok) throw new Error("RELEASE_SIGNATURE_INVALID");
}

// Checks a release against the authorization it references: same buyer, same
// domain (contract and chain), and authHash really is that authorization's hash.
export function releaseMatchesAuthorization(release: AonObject, authorization: AonObject): boolean {
  const p = (release.payload as any) ?? {};
  const a = (authorization.payload as any)?.authorization;
  if (!a || !(release.references ?? []).map(r => r.toLowerCase()).includes(String(authorization.objectHash).toLowerCase())) return false;
  if (getAddress(p.buyer) !== getAddress(a.buyer)) return false;
  const r = p.release ?? {};
  if (getAddress(r.sellerUsdcRecipient) !== getAddress(a.sellerUsdcRecipient)) return false;
  if (String(r.usdcAmount) !== String(a.usdcAmount)) return false;
  const ad = (authorization as any).signature?.domain, rd = p.signature?.domain;
  if (!ad || !rd || getAddress(ad.verifyingContract) !== getAddress(rd.verifyingContract) || Number(ad.chainId) !== Number(rd.chainId)) return false;
  return csdUsdcAuthHash(authorization).toLowerCase() === String(p.authHash).toLowerCase();
}
