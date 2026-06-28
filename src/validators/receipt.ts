import type { AonObject } from "../object.js";
import {
  requireObject,
  type ValidationGraph,
} from "./graph.js";

export async function validateReceipt(_obj: AonObject) {
  return;
}

export async function validateReceiptGraph(
  obj: AonObject,
  graph: ValidationGraph
) {
  await validateReceipt(obj);

  for (const ref of obj.references ?? []) {
    requireObject(graph, ref);
  }
}
