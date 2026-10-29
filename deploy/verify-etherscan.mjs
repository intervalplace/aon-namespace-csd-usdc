// Verifies the deployed CsdUsdcSettlement on Etherscan with the exact
// compiler input in deploy/etherscan-standard-input.json.
//
//   ETHERSCAN_API_KEY=<your key> node deploy/verify-etherscan.mjs 0xContractAddress
//
// Free API key: https://etherscan.io/myapikey (Node 18+, no installs).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const address = process.argv[2];
const key = process.env.ETHERSCAN_API_KEY;
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) { console.error("Usage: ETHERSCAN_API_KEY=... node deploy/verify-etherscan.mjs 0xContractAddress"); process.exit(1); }
if (!key) { console.error("Set ETHERSCAN_API_KEY (free at https://etherscan.io/myapikey)."); process.exit(1); }

const API = "https://api.etherscan.io/v2/api?chainid=1";
// Constructor: USDC, 300 USDC cap, CSD genesis (as in build-deploy-page.mjs)
const ARGS = "000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
  + (300_000_000n).toString(16).padStart(64, "0")
  + "00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52";
const input = JSON.parse(readFileSync(join(here, "etherscan-standard-input.json"), "utf8"));
input.settings.outputSelection = { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] } };
const post = async (params) => (await fetch(API, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...params, apikey: key }) })).json();
const get = async (params) => (await fetch(`${API}&${new URLSearchParams({ ...params, apikey: key })}`)).json();

const sub = await post({
  module: "contract", action: "verifysourcecode", contractaddress: address,
  sourceCode: JSON.stringify(input), codeformat: "solidity-standard-json-input",
  contractname: "contracts/CsdUsdcSettlement.sol:CsdUsdcSettlement",
  compilerversion: "v0.8.26+commit.8a97fa7a", constructorArguements: ARGS,
});
if (sub.status !== "1") {
  if (/already verified/i.test(sub.result ?? "")) { console.log(`✓ Already verified: https://etherscan.io/address/${address}#code`); process.exit(0); }
  console.error("✗ Etherscan refused the submission:", sub.result ?? sub.message); process.exit(1);
}
console.log("Submitted. Waiting for Etherscan to compile and compare…");
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = await get({ module: "contract", action: "checkverifystatus", guid: sub.result });
  if (/pending/i.test(st.result ?? "")) continue;
  if (st.status === "1" || /already verified/i.test(st.result ?? "")) { console.log(`✓ Verified: https://etherscan.io/address/${address}#code`); process.exit(0); }
  console.error("✗", st.result); process.exit(1);
}
console.error("✗ Still pending after 2.5 minutes; check the address on Etherscan later.");
process.exit(1);
