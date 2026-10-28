// The relayer against a stand-in CSD node API: catches up from the
// checkpoint, follows new blocks, and follows a reorg to a heavier chain.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { fileURLToPath } from "node:url";

const RPC = `http://127.0.0.1:${process.env.ANVIL_PORT ?? "8546"}`;
const art = JSON.parse(readFileSync(new URL("./artifacts.json", import.meta.url), "utf8")).TestCsdHeaderOracle;
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http() });
const KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const wc = createWalletClient({ account: privateKeyToAccount(KEY), chain, transport: http() });
let pass = 0; const check = (c, l) => { if (!c) { console.error("  FAIL:", l); process.exit(1); } pass++; console.log("  ok -", l); };

const sha = (b) => createHash("sha256").update(b).digest(), dsha = (b) => sha(sha(b));
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }, u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hx = (b) => "0x" + Buffer.from(b).toString("hex");
const BITS = 0x207fffff, T = BigInt(0x7fffff) << 232n;
let salt = 0;
function mine(prev, time) { const merkle = sha(Buffer.from(`r${salt++}`)); for (let n = 0; ; n++) { const hash = dsha(Buffer.concat([u32(1), prev, merkle, u64(time), u32(BITS), u32(n)])); if (BigInt(hx(hash)) <= T) return { version: 1, prev, merkle, time, bits: BITS, nonce: n, hash }; } }
const json = (h, height) => ({ ok: true, hash: hx(h.hash), height, header: { version: h.version, prev: hx(h.prev), merkle: hx(h.merkle), time: h.time, bits: h.bits, nonce: h.nonce } });

// The stand-in node's chain: heights 2000.. (45 checkpoint headers, then more)
const start = Number((await pub.getBlock()).timestamp) - 5 * 86400;
let main = []; { let prev = sha(Buffer.from("x")); for (let i = 0; i < 80; i++) { const h = mine(prev, start + 120 * i); main.push(h); prev = h.hash; } }
const server = createServer((req, res) => {
  const tipH = 2000 + main.length - 1;
  if (req.url === "/tip") return res.end(JSON.stringify({ ok: true, height: tipH, tip: hx(main.at(-1).hash) }));
  const m = req.url.match(/^\/block\/height\/(\d+)$/);
  if (m) { const i = Number(m[1]) - 2000; return i >= 0 && i < main.length ? res.end(JSON.stringify(json(main[i], Number(m[1])))) : (res.statusCode = 404, res.end("{}")); }
  res.statusCode = 404; res.end("{}");
});
await new Promise(r => server.listen(0, r));
const api = `http://127.0.0.1:${server.address().port}`;

const GENESIS = hx(sha(Buffer.from("relay-genesis")));
const toSol = (h) => ({ version: 1, prev: hx(h.prev), merkle: hx(h.merkle), time: BigInt(h.time), bits: h.bits, nonce: h.nonce });
const oracle = (await pub.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [GENESIS, main.slice(0, 45).map(toSol), 2000n, 256n] }) })).contractAddress;
const best = async () => [await pub.readContract({ address: oracle, abi: art.abi, functionName: "bestHeight", args: [GENESIS] }), await pub.readContract({ address: oracle, abi: art.abi, functionName: "bestTip", args: [GENESIS] })];
const relay = () => new Promise((resolve, reject) => { import("node:child_process").then(({ execFile }) => execFile(process.execPath, [fileURLToPath(new URL("../scripts/relay-headers.mjs", import.meta.url))],
  { env: { ...process.env, RUN_ONCE: "1", CSD_API_URL: api, AON_EVM_RPC_URL: RPC, RELAYER_PRIVATE_KEY: KEY, ORACLE_ADDRESS: oracle, CSD_GENESIS_HASH: GENESIS, MAX_BATCH: "10" } },
  (err, out, errOut) => err ? reject(new Error(errOut || err.message)) : resolve(out))); });

console.log("\n[relay] Following a CSD node");
await relay();
let [h, t] = await best();
check(h === 2079n && t === hx(main[79].hash), "catches up from the checkpoint to the node's tip (35 headers in batches of 10)");
for (let i = 0; i < 5; i++) main.push(mine(main.at(-1).hash, main.at(-1).time + 120));
await relay(); [h, t] = await best();
check(h === 2084n && t === hx(main.at(-1).hash), "follows new blocks");
// Reorg: the node switches to a longer branch forking 3 blocks back
const fork = main.slice(0, main.length - 3); for (let i = 0; i < 6; i++) fork.push(mine(fork.at(-1).hash, fork.at(-1).time + 130));
main = fork;
await relay(); [h, t] = await best();
check(h === 2087n && t === hx(main.at(-1).hash), "follows a reorg to the heavier branch");
server.close();
console.log(`\nAll ${pass} relay checks passed.`);
