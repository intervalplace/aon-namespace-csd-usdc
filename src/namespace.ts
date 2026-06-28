import type { NamespaceDriver } from "../index.js";
import { findExecutableGraphs } from "../../executable.js";
import { verifyCsdPaymentProof } from "../../verifiers/csd.js";
import {
  executeCsdUsdcSettlementOnEvm,
} from "../../executors/evmCsdUsdcSettlement.js";

export const csdUsdcNamespace: NamespaceDriver = {
  namespace: "aon:csd-usdc",

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

    if (!authorization?.objectHash) throw new Error("MISSING_AUTHORIZATION");
    if (!graph.reserve?.objectHash) throw new Error("MISSING_RESERVE");
    if (!proof?.objectHash) throw new Error("MISSING_PROOF");

    const a = authorization.payload.authorization;

    return verifyCsdPaymentProof({
      proof: proof.payload.proof,
      expectedRecipientScriptPubKey: a.sellerCsdScriptHash,
      expectedAmount: BigInt(a.csdAmount),
      minConfirmations: Number(a.minConfirmations ?? 1),
      expectedGenesisHash: a.csdGenesisHash,
    });
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
      return await executeCsdUsdcSettlementOnEvm({
        authorization: graph.authorization,
        reserve: graph.reserve,
        proof: graph.proof,
      });
    }

    throw new Error("UNKNOWN_EXECUTOR_MODE");
  },
};
