import type { AonObject } from "../object.js";
import {
  requireNamespace,
  requireReferenceTypes,
  type ValidationGraph,
} from "./graph.js";

export async function validateProof(obj: AonObject) {
  if ((obj.references ?? []).length !== 1) {
    throw new Error("INVALID_PROOF_REFERENCE_COUNT");
  }
}

export async function validateProofGraph(
  obj: AonObject,
  graph: ValidationGraph
) {
  await validateProof(obj);

  const [reserve] = requireReferenceTypes(graph, obj, ["reserve"]);

  requireNamespace(reserve.namespace, obj.namespace);
}
