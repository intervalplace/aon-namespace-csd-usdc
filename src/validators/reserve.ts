import type { AonObject } from "../object.js";
import {
  requireNamespace,
  requireReferenceTypes,
  type ValidationGraph,
} from "./graph.js";

export async function validateReserve(obj: AonObject) {
  if ((obj.references ?? []).length !== 1) {
    throw new Error("INVALID_RESERVE_REFERENCE_COUNT");
  }
}

export async function validateReserveGraph(
  obj: AonObject,
  graph: ValidationGraph
) {
  await validateReserve(obj);

  const [auth] = requireReferenceTypes(graph, obj, ["authorization"]);

  requireNamespace(auth.namespace, obj.namespace);
}
