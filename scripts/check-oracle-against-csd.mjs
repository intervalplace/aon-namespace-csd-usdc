// Replays real CSD headers through the header oracle with CSD mainnet's
// rules, on a throwaway local chain. Proves the oracle accepts the real chain.
//
//   npm install
//   node scripts/check-oracle-against-csd.mjs http://127.0.0.1:8887 300
//
// (CSD node API URL, number of headers to replay after the 45-header checkpoint.)
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, BaseError, ContractFunctionRevertedError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { csdApi, CSD_GENESIS_HASH } from "./csd-headers.mjs";

const [api = "http://127.0.0.1:8887", countArg = "300"] = process.argv.slice(2);
const N = Number(countArg);
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const arch = { x64: "amd64", arm64: "arm64" }[process.arch] ?? process.arch;
const anvilBin = join(dirname(require.resolve(`@foundry-rs/anvil-${process.platform}-${arch}/package.json`)), "bin", "anvil");

const csd = csdApi(api);
const tip = await csd.tipHeight();
const first = tip - N - 44;
if (first < 2) throw new Error(`chain too short: tip ${tip}`);
console.log(`Fetching CSD headers ${first}..${tip} from ${api}`);
const hs = await csd.headersRange(first, tip);

execFileSync(process.execPath, [join(here, "../test/compile.cjs")], { stdio: "ignore" });
const art = JSON.parse(readFileSync(join(here, "../test/artifacts.json"), "utf8")).CsdHeaderOracle;
const port = "8549";
const anvil = spawn(anvilBin, ["--port", port, "--silent", "--gas-limit", "300000000"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 1500));
try {
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } } });
  const pub = createPublicClient({ chain, transport: http() });
  const wc = createWalletClient({ account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), chain, transport: http() });
  const cp = hs.slice(0, 45).map(h => h.header);
  const oracle = (await pub.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [CSD_GENESIS_HASH, cp, BigInt(first), 256n] }) })).contractAddress;
  console.log(`Oracle deployed with checkpoint ${first}..${first + 44} (mainnet rules)`);
  let gas = 0n, done = 0;
  for (let i = 45; i < hs.length; i += 25) {
    const batch = hs.slice(i, i + 25);
    try {
      await pub.simulateContract({ account: wc.account, address: oracle, abi: art.abi, functionName: "submitHeaders", args: [CSD_GENESIS_HASH, batch.map(h => h.header)] });
    } catch (e) {
      const r = e instanceof BaseError ? e.walk(x => x instanceof ContractFunctionRevertedError) : null;
      console.error(`✗ Rejected a header in ${batch[0].height}..${batch.at(-1).height}: ${r?.data?.errorName ?? e.shortMessage} ${r?.data?.args ? JSON.stringify(r.data.args.map(String)) : ""}`);
      process.exitCode = 1; break;
    }
    const rc = await pub.waitForTransactionReceipt({ hash: await wc.writeContract({ address: oracle, abi: art.abi, functionName: "submitHeaders", args: [CSD_GENESIS_HASH, batch.map(h => h.header)], gas: 250_000_000n }) });
    gas += rc.gasUsed; done += batch.length;
  }
  if (!process.exitCode) {
    const best = await pub.readContract({ address: oracle, abi: art.abi, functionName: "bestTip", args: [CSD_GENESIS_HASH] });
    const ok = best.toLowerCase() === hs.at(-1).hash;
    console.log(ok ? `✓ All ${done} real headers accepted under CSD's rules; best tip = CSD tip ${tip}. Average gas per header in batches of 25: ${gas / BigInt(done)}`
                   : `✗ Best tip ${best} isn't the CSD tip ${hs.at(-1).hash}`);
    if (!ok) process.exitCode = 1;
  }
} finally { anvil.kill(); }
