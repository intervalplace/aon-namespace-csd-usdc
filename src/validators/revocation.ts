import type { AonObject } from "../object.js";
import { verifyObjectSignature } from "./signatures.js";
import {
  requireReferenceTypes,
  type ValidationGraph,
} from "./graph.js";

export async function validateRevocation(obj: AonObject) {
  await verifyObjectSignature(obj);

  if ((obj.references ?? []).length !== 1) {
    throw new Error("INVALID_REVOCATION_REFERENCE_COUNT");
  }
}

export async function validateRevocationGraph(
  obj: AonObject,
  graph: ValidationGraph
) {
  await validateRevocation(obj);

  requireReferenceTypes(graph, obj, ["authorization"]);
}
