// Checks that real CSD blocks pass the settlement contract's block checks
// (hashing, proof of work, compact difficulty, 60 s spacing, linkage) at the
// difficulty the interface would suggest, on a throwaway local chain.
//
//   npm install
//   node scripts/check-against-csd.mjs http://127.0.0.1:8887 200
//
// (CSD node API URL, number of recent blocks.)
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, BaseError, ContractFunctionRevertedError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { csdApi, CSD_GENESIS_HASH, suggestedMaxTarget, bitsToTarget } from "./csd-headers.mjs";

const [api = "http://127.0.0.1:8887", countArg = "200"] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const arch = { x64: "amd64", arm64: "arm64" }[process.arch] ?? process.arch;
const anvilBin = join(dirname(require.resolve(`@foundry-rs/anvil-${process.platform}-${arch}/package.json`)), "bin", "anvil");

const csd = csdApi(api);
const tip = await csd.tipHeight();
const from = Math.max(1, tip - Number(countArg) + 1);
console.log(`Fetching CSD blocks ${from}..${tip} from ${api}`);
const hs = await csd.headersRange(from, tip);
const maxTarget = suggestedMaxTarget(hs.at(-1).header.bits);
const easiest = hs.reduce((m, h) => { const t = bitsToTarget(h.header.bits); return t > m ? t : m; }, 0n);
console.log(`Suggested csdMaxTarget (current difficulty x 3/4): 0x${maxTarget.toString(16)}`);
console.log(`Easiest block in range is at ${(Number(easiest * 10000n / maxTarget) / 100).toFixed(2)}% of that limit`);

execFileSync(process.execPath, [join(here, "../test/compile.cjs")], { stdio: "ignore" });
const art = JSON.parse(readFileSync(join(here, "../test/artifacts.json"), "utf8")).CsdUsdcSettlement;
const port = "8549";
const anvil = spawn(anvilBin, ["--port", port, "--silent"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 1500));
try {
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } } });
  const pub = createPublicClient({ chain, transport: http() });
  const wc = createWalletClient({ account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), chain, transport: http() });
  const addr = (await pub.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: art.abi, bytecode: art.bytecode, args: ["0x0000000000000000000000000000000000000001", 30_000_000n, CSD_GENESIS_HASH] }) })).contractAddress;
  try {
    const last = await pub.readContract({ address: addr, abi: art.abi, functionName: "checkHeaderChain", args: [hs.map(h => h.header), maxTarget] });
    console.log(last.toLowerCase() === hs.at(-1).hash ? `✓ All ${hs.length} real CSD blocks pass the contract's checks (mainnet rules) at the suggested difficulty.` : `✗ Unexpected last hash ${last}`);
  } catch (e) {
    const r = e instanceof BaseError ? e.walk(x => x instanceof ContractFunctionRevertedError) : null;
    console.error(`✗ Rejected: ${r?.data?.errorName ?? e.shortMessage}. If it's CsdBlockTooEasy, difficulty fell more than a quarter within the range; try a shorter range.`);
    process.exitCode = 1;
  }
} finally { anvil.kill(); }
