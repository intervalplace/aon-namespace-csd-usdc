// --set-price --from-wallet: the pool becomes the deepest the bot's wallet allows at the new price,
// from its real USDC (on Ethereum) and CSD (on the CSD node) balances, and it refuses while a
// trade is open.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startFakeCsdNode } from "./fake-csd-node.mjs";
import { deriveCsdWallet } from "../src/csd-wallet.ts";

const PORT = process.env.ANVIL_PORT ?? "8546", RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http() });
const wc = createWalletClient({ account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), chain, transport: http() });
const art = JSON.parse(readFileSync(new URL("./artifacts.json", import.meta.url), "utf8"));
const usdc = (await pub.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: art.MockUSDC.abi, bytecode: art.MockUSDC.bytecode }) })).contractAddress;
const MM_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const SEED = "0x" + "42".repeat(32);
await pub.waitForTransactionReceipt({ hash: await wc.writeContract({ address: usdc, abi: art.MockUSDC.abi, functionName: "mint", args: [privateKeyToAccount(MM_KEY).address, 5_000_000_000n] }) }); // 5,000 USDC

const csd = await startFakeCsdNode({ port: 18997 });
const inv = deriveCsdWallet(SEED).key(0).addr20;
csd.mine({ rewardTo: inv, reward: 48_000n * 100_000_000n }); // 48,000 CSD

const dir = mkdtempSync(join(tmpdir(), "mm-")), state = join(dir, "state.json");
const run = (...args) => new Promise(res => execFile(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../scripts/market-maker.ts", import.meta.url)), ...args],
  { env: { ...process.env, MM_PRIVATE_KEY: MM_KEY, MM_CSD_SEED: SEED, AON_EVM_RPC_URL: RPC, USDC_ADDRESS: usdc, CSD_API_URL: csd.url, STATE_FILE: state } },
  (err, out, errOut) => res({ code: err ? err.code ?? 1 : 0, out: out + errOut })));
const pool = () => JSON.parse(readFileSync(state, "utf8")).pool;

// a pool shrunk by earlier repricing: 913.9 USDC + 15,231.95 CSD
writeFileSync(state, JSON.stringify({ pool: { usdc: "913917012", csd: "1523195020000" }, nextKey: 1, trades: {}, lossUsdc: "0" }));

// plain --set-price can only shrink
await run("--set-price", "0.05", "--yes");
assert.ok(BigInt(pool().usdc) <= 913_917_012n && BigInt(pool().csd) <= 1_523_195_020_000n, "plain --set-price never grows the pool");

// --from-wallet at 0.06: CSD is the limit (47,999.9 CSD x 0.06 = 2,879.99 USDC)
let r = await run("--set-price", "0.06", "--from-wallet");
assert.equal(r.code, 0, r.out);
assert.match(r.out, /Wallet: 5000 USDC \+ 48000 CSD/);
assert.match(r.out, /USDC stays in the wallet/);
r = await run("--set-price", "0.06", "--from-wallet", "--yes");
assert.equal(r.code, 0, r.out);
assert.equal(pool().csd, String(48_000n * 100_000_000n - 10_000_000n));
assert.equal(pool().usdc, String(2_879_994_000n));
console.log("ok  --from-wallet at 0.06 counts 47999.9 CSD + 2879.994 USDC");

// --from-wallet at 0.2: USDC is the limit (5,000 USDC / 0.2 = 25,000 CSD)
await run("--set-price", "0.2", "--from-wallet", "--yes");
assert.equal(pool().usdc, "5000000000");
assert.equal(pool().csd, String(25_000n * 100_000_000n));
console.log("ok  --from-wallet at 0.2 counts 5000 USDC + 25000 CSD");

// and back down to 0.06: the pool is as deep as before, not shrunk by the round trip
await run("--set-price", "0.06", "--from-wallet", "--yes");
assert.equal(pool().csd, String(48_000n * 100_000_000n - 10_000_000n));
console.log("ok  repricing up and back down leaves the pool as deep as the wallet allows");

// refuses while a trade is open
const S = JSON.parse(readFileSync(state, "utf8"));
S.trades = { "0xab": { kind: "buy", status: "locked", authHash: "0xab" } };
writeFileSync(state, JSON.stringify(S));
r = await run("--set-price", "0.07", "--from-wallet", "--yes");
assert.notEqual(r.code, 0);
assert.match(r.out, /still open; run with --drain first/);
assert.equal(pool().csd, String(48_000n * 100_000_000n - 10_000_000n), "left untouched");
console.log("ok  refuses while a trade is open");

await csd.close();
