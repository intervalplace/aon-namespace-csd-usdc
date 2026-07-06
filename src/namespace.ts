import type { NamespaceDriver } from "@intervalplace/aon-sdk";
import { findExecutableGraphs, finalizeObject } from "@intervalplace/aon-sdk";
import { getAddress } from "viem";
import { verifyCsdPaymentProof } from "./verifiers/csd.js";
import { verifyAuthorizationObject } from "./verifiers/authorization.js";
import { executeCsdUsdcSettlementOnEvm } from "./executors/evmCsdUsdcSettlement.js";

// ── Extended driver type ───────────────────────────────────────────────────────

type EIP712Field = { name: string; type: string };
type EIP712Types = Record<string, EIP712Field[]>;

export type CsdUsdcDriver = NamespaceDriver & {
  types(): EIP712Types;
  revocationTypes(): EIP712Types;
  normalizeAuthorization(auth: any): any;
};

// ── EIP-712 schemas ────────────────────────────────────────────────────────────
// Derived from CsdUsdcSettlement.sol AUTH_TYPEHASH.

const AUTH_TYPES: EIP712Types = {
  CsdUsdcAuthorization: [
    { name: "buyer",                  type: "address" },
    { name: "sellerUsdcRecipient",    type: "address" },
    { name: "sellerCsdScriptHash",    type: "bytes32" },
    { name: "csdGenesisHash",         type: "bytes32" },
    { name: "tradeIntentHash",        type: "bytes32" },
    { name: "csdAmount",              type: "uint256" },
    { name: "usdc",                   type: "address" },
    { name: "usdcAmount",             type: "uint256" },
    { name: "minConfirmations",       type: "uint256" },
    { name: "executorFeeAmount",      type: "uint256" },
    { name: "validAfter",             type: "uint64"  },
    { name: "validBefore",            type: "uint64"  },
    { name: "nonce",                  type: "bytes32" },
  ],
};

const REVOCATION_TYPES: EIP712Types = {
  AonRevocation: [
    { name: "targetHash",  type: "bytes32" },
    { name: "targetType",  type: "string"  },
    { name: "reason",      type: "string"  },
    { name: "nonce",       type: "bytes32" },
  ],
};

export const csdUsdcNamespace: CsdUsdcDriver = {
  namespace: "aon:csd-usdc",

  // ── EIP-712 schemas ──────────────────────────────────────────────────────────

  types() { return AUTH_TYPES; },
  revocationTypes() { return REVOCATION_TYPES; },

  // ── Authorization normalization ───────────────────────────────────────────────

  normalizeAuthorization(auth: any) {
    return {
      buyer:                getAddress(auth.buyer),
      sellerUsdcRecipient:  getAddress(auth.sellerUsdcRecipient),
      sellerCsdScriptHash:  auth.sellerCsdScriptHash,
      csdGenesisHash:       auth.csdGenesisHash,
      tradeIntentHash:      auth.tradeIntentHash,
      csdAmount:            String(auth.csdAmount),
      usdc:                 getAddress(auth.usdc),
      usdcAmount:           String(auth.usdcAmount),
      minConfirmations:     String(auth.minConfirmations),
      executorFeeAmount:    String(auth.executorFeeAmount ?? "0"),
      validAfter:           String(auth.validAfter),
      validBefore:          String(auth.validBefore),
      nonce:                auth.nonce,
    };
  },

  evaluate(objects, opts) {
    return findExecutableGraphs(objects, {
      namespace: "aon:csd-usdc",
      ...opts,
    });
  },

  reward(graph: any) {
    const a = graph.authorization?.payload?.authorization ?? {};

    return {
      token: a.usdc,
      amount: String(a.executorFeeAmount ?? "0"),
      tokenSymbol: "USDC",
      decimals: 6,
    };
  },

  verify(graph: any) {
    const authorization = graph.authorization;
    const proof = graph.proof;

    if (!authorization?.objectHash) return { ok: false, reason: "MISSING_AUTHORIZATION" };
    if (!graph.reserve?.objectHash) return { ok: false, reason: "MISSING_RESERVE" };
    if (!proof?.objectHash)         return { ok: false, reason: "MISSING_PROOF" };

    const a = authorization.payload.authorization;

    try {
      return verifyCsdPaymentProof({
        proof: proof.payload.proof,
        expectedRecipientScriptPubKey: a.sellerCsdScriptHash,
        expectedAmount: BigInt(a.csdAmount),
        minConfirmations: Number(a.minConfirmations ?? 1),
        expectedGenesisHash: a.csdGenesisHash,
      });
    } catch (err: any) {
      return { ok: false, reason: err?.message ?? "VERIFY_FAILED" };
    }
  },

  async validateObject(obj: any) {
    if (obj.objectType === "authorization") {
      await verifyAuthorizationObject(obj);
    }
  },

  async execute(graph: any, args?: { mode?: "off" | "simulate" | "contract" }) {
    const mode = args?.mode ?? "simulate";

    if (mode === "off") {
      return {
        executed: false,
        mode,
        executionTx: null,
        result: "verified_only",
      };
    }

    if (mode === "simulate") {
      const txid = graph.proof?.payload?.txid ?? graph.proof?.payload?.proof?.txid;

      return {
        executed: true,
        mode,
        executionTx: `simulated:aon:${txid}`,
        result: "simulated_settlement",
      };
    }

    if (mode === "contract") {
      const result = await executeCsdUsdcSettlementOnEvm({
        authorization: graph.authorization,
        reserve: graph.reserve,
        proof: graph.proof,
      });

      // Build receipt object for AON — the SDK will post it via client.putObject
      const refs = [
        graph.authorization?.objectHash,
        graph.reserve?.objectHash,
        graph.proof?.objectHash,
      ].filter(Boolean);

      const receiptObject = finalizeObject({
        objectType:    "receipt",
        schemaVersion: "1",
        namespace:     "aon:csd-usdc",
        createdAt:     Date.now(),
        references:    refs,
        payload: {
          receiptType: "authorized_state_transition_completed",
          executionTx: result.executionTx,
        },
      });

      return { ...result, receiptObject };
    }

    throw new Error("UNKNOWN_EXECUTOR_MODE");
  },
};
