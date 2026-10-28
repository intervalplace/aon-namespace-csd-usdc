// Deploys the header oracle (checkpoint = 45 recent real CSD headers, read
// from your CSD node) and the settlement contract.
//
//   CSD_API_URL=http://127.0.0.1:8887 AON_EVM_RPC_URL=https://... \
//   DEPLOYER_PRIVATE_KEY=0x... MAX_TOTAL_LOCKED_USDC=300 node scripts/deploy.mjs
//
// The checkpoint ends 6 blocks below the CSD tip so it's settled. Anyone can
// check it: every header is printed and can be compared against any CSD node.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { csdApi, CSD_GENESIS_HASH } from "./csd-headers.mjs";

const env = (k, d) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`${k} missing`); return v; };
const here = dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [join(here, "../test/compile.cjs")], { stdio: "ignore" });
const art = JSON.parse(readFileSync(join(here, "../test/artifacts.json"), "utf8"));

const csd = csdApi(env("CSD_API_URL", "http://127.0.0.1:8887"));
const rpc = env("AON_EVM_RPC_URL");
const account = privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY"));
const pub = createPublicClient({ transport: http(rpc) });
const chainId = await pub.getChainId();
const wallet = createWalletClient({ account, chain: { id: chainId, name: `evm-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }, transport: http(rpc) });
const maxTotalLocked = parseUnits(env("MAX_TOTAL_LOCKED_USDC"), 6);

const tip = await csd.tipHeight();
const last = tip - 6, first = last - 44;
const cp = await csd.headersRange(first, last);
console.log(`Checkpoint: CSD headers ${first}..${last}`);
for (const h of cp) console.log(`  ${h.height} ${h.hash}`);

const deploy = async (name, args) => {
  const hash = await wallet.deployContract({ abi: art[name].abi, bytecode: art[name].bytecode, args });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${name} deployment failed`);
  console.log(`${name}: ${rc.contractAddress} (tx ${hash})`);
  return rc.contractAddress;
};
const oracle = await deploy("CsdHeaderOracle", [CSD_GENESIS_HASH, cp.map(h => h.header), BigInt(first), 256n]);
const settlement = await deploy("CsdUsdcSettlement", [oracle, maxTotalLocked]);
console.log(`\nDone on chain ${chainId}.\n  ORACLE_ADDRESS=${oracle}\n  AON_SETTLEMENT_CONTRACT=${settlement}\nNext: run scripts/relay-headers.mjs to keep the oracle current.`);
