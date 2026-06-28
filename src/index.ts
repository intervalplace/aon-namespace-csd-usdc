// @aon/namespace-csd-usdc
//
// CSD/USDC cross-system settlement namespace for AON.
//
// Install alongside @aon/sdk:
//   npm install @aon/sdk @aon/namespace-csd-usdc
//
// Register and use:
//   import { registerNamespace } from "@aon/sdk";
//   import { csdUsdcNamespace } from "@aon/namespace-csd-usdc";
//   registerNamespace(csdUsdcNamespace);

export { csdUsdcNamespace } from "./namespace.js";

export {
  buildCsdUsdcAuthorizationObject,
  buildCsdUsdcRevocationObject,
} from "./builders.js";

export { makeCsdPaymentProofObject } from "./csdFromTxid.js";
