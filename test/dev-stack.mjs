// A local CSD/USDC market for frontend work: anvil (8545), the contracts, a
// stand-in CSD node (18991) mining a block every CSD_BLOCK_SECS, and the
// market maker (18990). Writes the addresses to dev-stack.json.
//   npx tsx test/dev-stack.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startFakeCsdNode } from "./fake-csd-node.mjs";
import { deriveCsdWallet } from "../src/csd-wallet.ts";
import { startMarketMaker } from "../src/market-maker.ts";

const require = createRequire(import.meta.url);
const arch = { x64: "amd64", arm64: "arm64" }[process.arch] ?? process.arch;
const anvilBin = join(dirname(require.resolve(`@foundry-rs/anvil-${process.platform}-${arch}/package.json`)), "bin", "anvil");
const anvil = spawn(anvilBin, ["--port", "8545", "--silent", "--block-time", "2"], { stdio: "ignore" });
process.on("exit", () => anvil.kill());
await new Promise(r => setTimeout(r, 1500));

const RPC = "http://127.0.0.1:8545";
const art = JSON.parse(readFileSync(new URL("./artifacts.json", import.meta.url), "utf8"));
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http() });
const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const wc = createWalletClient({ account: deployer, chain, transport: http() });
const deploy = async (n, args = []) => (await pub.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: art[n].abi, bytecode: art[n].bytecode, args }) })).contractAddress;
const usdc = await deploy("MockUSDC");
const GENESIS = keccak256(toHex("csd-dev-genesis"));
const settlement = await deploy("TestCsdUsdcSettlement", [usdc, 300_000_000n, GENESIS]);
const MM_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const mmAddr = privateKeyToAccount(MM_KEY).address;
const USER = process.env.DEV_USER ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil #1
for (const [to, amt] of [[mmAddr, 150_000_000n], [USER, 100_000_000n]])
  await pub.waitForTransactionReceipt({ hash: await wc.writeContract({ address: usdc, abi: art.MockUSDC.abi, functionName: "mint", args: [to, amt] }) });

let evmNow = Number((await pub.getBlock()).timestamp);
setInterval(async () => { try { evmNow = Number((await pub.getBlock()).timestamp); } catch {} }, 1000);
const csd = await startFakeCsdNode({ port: 18991, bits: 0x207fffff, clock: () => evmNow });
const SEED = "0x" + "5e".repeat(32);
csd.mine({ rewardTo: deriveCsdWallet(SEED).key(0).addr20, reward: 1000n * 100_000_000n });
setInterval(() => csd.mine(), Number(process.env.CSD_BLOCK_SECS ?? 20) * 1000);

const STATE = "/tmp/claude-0/dev-mm-state.json"; rmSync(STATE, { force: true });
await startMarketMaker({ rpcUrl: RPC, chainId: 31337, privateKey: MM_KEY, settlement, usdc, csdApi: csd.url, csdGenesis: GENESIS, csdSeed: SEED,
  stateFile: STATE, port: 18990, allowedOrigins: ["*"], initialPool: { usdc: 150_000_000n, csd: 1000n * 100_000_000n }, pollMs: 3000 });

const info = { rpc: RPC, usdc, settlement, genesis: GENESIS, mm: "http://127.0.0.1:18990", csdNode: csd.url, user: USER };
writeFileSync(new URL("./dev-stack.json", import.meta.url), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info));
// gives the user some CSD too, for selling: POST /fund {addr20, csd}
import("node:http").then(({ default: h }) => h.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c; const b = JSON.parse(raw || "{}");
  csd.mine({ rewardTo: b.addr20, reward: BigInt(Math.round(b.csd * 1e8)) }); res.end("ok");
}).listen(18992, "127.0.0.1"));
