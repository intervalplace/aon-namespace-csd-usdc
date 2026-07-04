// builders.ts — object construction helpers for aon:csd-usdc

import { getAddress, verifyTypedData, type Hex, type Address } from "viem";
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
    references: body.references ?? [],
    payload: {
      authorizationType: "csd_usdc_release",
      authorization,
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
    (target.payload as any)?.authorization?.buyer;

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

// ── Sell offer ────────────────────────────────────────────────────────────────
// A public advertisement that a seller wants to trade CSD for USDC.
// Not signed — the seller's intent is implicit; settlement requires them to
// actually lock and send CSD. Buyers reference the offer's objectHash as
// the tradeIntentHash in their CsdUsdcAuthorization, cryptographically
// binding their authorization to this specific offer.

export type CsdSellOfferBody = {
  seller:               Address;   // ethereum address of the seller
  sellerUsdcRecipient:  Address;   // where USDC should land
  csdGenesisHash:       Hex;       // identifies the CSD chain
  csdAmount:            string;    // satoshis
  usdcAmount:           string;    // 6-decimal USDC units
  pricePerCsd?:         string;    // usdcAmount / csdAmount — informational
  validBefore:          number;    // unix seconds when the offer expires
  createdAt?:           number;
};

export function buildCsdSellOfferObject(body: CsdSellOfferBody): AonObject {
  if (BigInt(body.csdAmount)  <= 0n) throw new Error("INVALID_CSD_AMOUNT");
  if (BigInt(body.usdcAmount) <= 0n) throw new Error("INVALID_USDC_AMOUNT");
  if (body.validBefore <= Math.floor(Date.now() / 1000)) throw new Error("OFFER_ALREADY_EXPIRED");

  return finalizeObject({
    objectType: "csd_sell_offer",
    schemaVersion: "1",
    namespace: "aon:csd-usdc",
    createdAt: body.createdAt ?? Date.now(),
    references: [],
    payload: {
      offerType: "csd_usdc_sell",
      seller:              getAddress(body.seller),
      sellerUsdcRecipient: getAddress(body.sellerUsdcRecipient),
      csdGenesisHash:      body.csdGenesisHash,
      csdAmount:           String(body.csdAmount),
      usdcAmount:          String(body.usdcAmount),
      pricePerCsd:         body.pricePerCsd ?? null,
      validBefore:         body.validBefore,
    },
  } as any);
}
