// Deploys CsdUsdcSettlement (self-contained CSD proofs; no oracle, nothing to
// keep running).
//
//   AON_EVM_RPC_URL=https://... DEPLOYER_PRIVATE_KEY=0x... \
//   USDC_ADDRESS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 MAX_TOTAL_LOCKED_USDC=300 \
//   node scripts/deploy.mjs
//
// USDC_ADDRESS can be any 6-decimal stablecoin (e.g. USDT 0xdAC17F958D2ee523a2206206994597C13D831ec7);
// one contract escrows one token.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CSD_GENESIS_HASH } from "./csd-headers.mjs";

const env = (k, d) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`${k} missing`); return v; };
const here = dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [join(here, "../test/compile.cjs")], { stdio: "ignore" });
const art = JSON.parse(readFileSync(join(here, "../test/artifacts.json"), "utf8")).CsdUsdcSettlement;

const rpc = env("AON_EVM_RPC_URL");
const account = privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY"));
const pub = createPublicClient({ transport: http(rpc) });
const chainId = await pub.getChainId();
const wallet = createWalletClient({ account, chain: { id: chainId, name: `evm-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }, transport: http(rpc) });
const token = getAddress(env("USDC_ADDRESS"));
const maxTotalLocked = parseUnits(env("MAX_TOTAL_LOCKED_USDC"), 6);

const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [token, maxTotalLocked, CSD_GENESIS_HASH] });
const rc = await pub.waitForTransactionReceipt({ hash });
if (rc.status !== "success") throw new Error("deployment failed");
console.log(`CsdUsdcSettlement: ${rc.contractAddress} on chain ${chainId} (tx ${hash})\n  token ${token}, max total locked ${env("MAX_TOTAL_LOCKED_USDC")}, CSD genesis ${CSD_GENESIS_HASH}\n  AON_SETTLEMENT_CONTRACT=${rc.contractAddress}`);
