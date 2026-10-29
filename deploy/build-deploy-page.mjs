// Builds deploy/deploy.html: a one-tap page that deploys CsdUsdcSettlement
// from your own wallet (e.g. MetaMask's in-app browser on a phone), and
// deploy/etherscan-standard-input.json, the exact compiler input, for
// Etherscan verification.
//
//   npm ci && node deploy/build-deploy-page.mjs
//
// Constructor: mainnet USDC, a 300 USDC total-locked cap, CSD mainnet genesis.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../package.json"));
const solc = require("solc");
const { keccak256, toBytes, encodeAbiParameters } = require("viem");
if (!solc.version().startsWith("0.8.26")) throw new Error(`solc ${solc.version()}; expected 0.8.26`);

export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const MAX_TOTAL_LOCKED = 300_000_000n; // 300 USDC
export const CSD_GENESIS = "0x00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52";
const KEY = "contracts/CsdUsdcSettlement.sol";
const source = readFileSync(join(here, "../src/contracts/CsdUsdcSettlement.sol"), "utf8");

const input = {
  language: "Solidity",
  sources: { [KEY]: { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
};
writeFileSync(join(here, "etherscan-standard-input.json"), JSON.stringify(input, null, 1));
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors ?? []) if (e.severity === "error") throw new Error(e.formattedMessage);
const initcode = "0x" + out.contracts[KEY].CsdUsdcSettlement.evm.bytecode.object;
const args = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [USDC, MAX_TOTAL_LOCKED, CSD_GENESIS]);

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sel = (sig) => keccak256(toBytes(sig)).slice(0, 10);
const values = {
  INITCODE: initcode, ARGS: args,
  INITCODE_SHA256: sha256(Buffer.from(initcode.slice(2), "hex")),
  SOURCE_SHA256: sha256(source),
  SEL_USDC: sel("usdcToken()"), SEL_MAX: sel("maxTotalLocked()"), SEL_GENESIS: sel("csdGenesisHash()"),
};
let html = readFileSync(join(here, "deploy.template.html"), "utf8");
for (const [k, v] of Object.entries(values)) html = html.replaceAll(`__${k}__`, v);
if (/__[A-Z0-9_]+__/.test(html)) throw new Error("unfilled placeholder in template");
writeFileSync(join(here, "deploy.html"), html);
console.log(`deploy/deploy.html written. Init code ${(initcode.length - 2) / 2} bytes, sha256 ${values.INITCODE_SHA256}`);
