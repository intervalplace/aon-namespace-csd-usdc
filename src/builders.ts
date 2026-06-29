// builders.ts — object construction helpers for aon:csd-usdc

import { getAddress, verifyTypedData, type Hex } from "viem";
import { finalizeObject } from "@intervalplace/aon-sdk";
import type { AonObject } from "@intervalplace/aon-sdk";
import { csdUsdcNamespace } from "./namespace.js";

function requireHex(x: any, code: string): Hex {
  if (typeof x !== "string" || !x.startsWith("0x")) throw new Error(code);
  return x as Hex;
}

async function requireValidTypedSignature(args: {
  domain: any;
  types: any;
  primaryType: string;
  message: any;
  signature: any;
  expectedSigner: string;
  code: string;
}) {
  const signature = requireHex(args.signature, "INVALID_SIGNATURE");
  const ok = await verifyTypedData({
    address: getAddress(args.expectedSigner),
    domain: args.domain,
    types: args.types,
    primaryType: args.primaryType as any,
    message: args.message,
    signature,
  } as any);
  if (!ok) throw new Error(args.code);
}

export async function buildCsdUsdcAuthorizationObject(body: {
  authorization: any;
  signature: any;
  domain: any;
  types?: any;
  primaryType?: string;
  signer?: string;
  namespace?: string;
  createdAt?: number;
  references?: string[];
  summary?: string;
}): Promise<AonObject> {
  const authorization = csdUsdcNamespace.normalizeAuthorization!(body.authorization);
  const signer = getAddress(body.signer ?? authorization.buyer);

  if (signer.toLowerCase() !== authorization.buyer.toLowerCase()) {
    throw new Error("SIGNER_BUYER_MISMATCH");
  }

  await requireValidTypedSignature({
    domain: body.domain,
    types: body.types ?? csdUsdcNamespace.types!(),
    primaryType: body.primaryType ?? "CsdUsdcAuthorization",
    message: authorization,
    signature: body.signature,
    expectedSigner: signer,
    code: "BAD_AUTHORIZATION_SIGNATURE",
  });

  const validBefore = Number(authorization.validBefore);
  if (Number.isFinite(validBefore) && validBefore <= Math.floor(Date.now() / 1000)) {
    throw new Error("AUTHORIZATION_EXPIRED");
  }

  return finalizeObject({
    objectType: "authorization",
    schemaVersion: "1",
    namespace: body.namespace ?? "aon:csd-usdc",
    createdAt: body.createdAt ?? Date.now(),
    creator: signer,
    references: body.references ?? [],
    payload: {
      authorizationType: "csd_usdc_release",
      authorization,
      summary: body.summary ?? null,
    },
    signature: {
      scheme: "eip712",
      signer,
      domain: body.domain,
      types: body.types ?? csdUsdcNamespace.types!(),
      primaryType: body.primaryType ?? "CsdUsdcAuthorization",
      message: authorization,
      signature: body.signature,
    },
  } as any);
}

export async function buildCsdUsdcRevocationObject(
  objects: AonObject[],
  body: {
    targetHash: string;
    signature: any;
    signer?: string;
    reason?: string;
    nonce?: string;
    createdAt?: number;
  }
): Promise<AonObject> {
  const revocationTypes = csdUsdcNamespace.revocationTypes!();
  const targetHash = body.targetHash.toLowerCase();
  const target = objects.find((o) => o.objectHash?.toLowerCase() === targetHash);

  if (!target) throw new Error("TARGET_OBJECT_NOT_FOUND");

  const alreadyRevoked = objects.some(
    (o) => o.objectType === "revocation" &&
    (o.references ?? []).map(r => r.toLowerCase()).includes(targetHash)
  );
  if (alreadyRevoked) throw new Error("TARGET_ALREADY_REVOKED");

  const signer = body.signer ??
    (target.payload as any)?.authorization?.buyer ??
    target.creator;

  const reason = body.reason ?? "user_revoked";
  const nonce  = requireHex(body.nonce ?? body.signature?.message?.nonce, "MISSING_REVOCATION_NONCE");

  const revocationMessage = { targetHash, targetType: target.objectType, reason, nonce };

  await requireValidTypedSignature({
    domain: body.signature.domain,
    types:  body.signature.types ?? revocationTypes,
    primaryType: body.signature.primaryType ?? "AonRevocation",
    message: revocationMessage,
    signature: body.signature.signature,
    expectedSigner: signer!,
    code: "BAD_REVOCATION_SIGNATURE",
  });

  return finalizeObject({
    objectType: "revocation",
    schemaVersion: "1",
    namespace: target.namespace,
    createdAt: body.createdAt ?? Date.now(),
    creator: signer,
    references: [targetHash],
    payload: {
      revocationType: `${target.objectType}_revocation`,
      targetType: target.objectType,
      targetHash,
      reason,
      nonce,
      signature: {
        scheme: body.signature.scheme ?? "eip712",
        signer,
        domain: body.signature.domain,
        types: body.signature.types ?? revocationTypes,
        primaryType: body.signature.primaryType ?? "AonRevocation",
        message: revocationMessage,
        signature: body.signature.signature,
      },
    },
  } as any);
}
