// Header oracle: CSD's header rules (difficulty, timestamps, PoW), forks,
// confirmations, and the fixed starting checkpoint. Runs the real oracle's
// rules at an easy PoW limit (TestCsdHeaderOracle) so headers can be mined.
import { createHash } from "node:crypto";
import { createPublicClient, createWalletClient, http, defineChain, BaseError, ContractFunctionRevertedError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";

const RPC = `http://127.0.0.1:${process.env.ANVIL_PORT ?? "8546"}`;
const art = JSON.parse(readFileSync(new URL("./artifacts.json", import.meta.url), "utf8"));
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http() });
const me = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const wc = createWalletClient({ account: me, chain, transport: http() });
const O = "TestCsdHeaderOracle";
let pass = 0;
const check = (c, l) => { if (!c) { console.error("  FAIL:", l); process.exit(1); } pass++; console.log("  ok -", l); };
const { toFunctionSelector } = await import("viem");
const selectors = Object.fromEntries(art.TestCsdHeaderOracle.abi.filter(x => x.type === "error").map(x => [toFunctionSelector(`${x.name}(${x.inputs.map(i => i.type).join(",")})`), x.name]));
const errName = (e) => { const r = e instanceof BaseError ? e.walk(x => x instanceof ContractFunctionRevertedError) : null;
  if (r?.data?.errorName) return r.data.errorName;
  const m = String(e.message).match(/custom error (0x[0-9a-f]{8})/); return m ? (selectors[m[1]] ?? m[1]) : String(e.shortMessage ?? e.message); };
async function reverts(p, name, label) { try { await p; } catch (e) { const n = errName(e); return check(n === name || n.includes(name), `${label} (reverts: ${n})`); } check(false, `${label}: expected ${name}`); }

const sha = (b) => createHash("sha256").update(b).digest();
const dsha = (b) => sha(sha(b));
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hx = (b) => "0x" + Buffer.from(b).toString("hex");
const target = (bits) => { const e = BigInt(bits >>> 24), m = BigInt(bits & 0xffffff); return e <= 3n ? m >> (8n * (3n - e)) : m << (8n * (e - 3n)); };
const LIMIT = 0x207fffff;
let salt = 0;
function mine(h) {
  const t = target(h.bits);
  for (let n = 0; ; n++) {
    const bytes = Buffer.concat([u32(h.version), h.prev, h.merkle, u64(h.time), u32(h.bits), u32(n)]);
    const hash = dsha(bytes);
    if (BigInt(hx(hash)) <= t) return { ...h, nonce: n, hash };
  }
}
const toSol = (h) => ({ version: h.version, prev: hx(h.prev), merkle: hx(h.merkle), time: BigInt(h.time), bits: h.bits, nonce: h.nonce });
const header = (prev, time, bits = LIMIT) => mine({ version: 1, prev: prev.hash, merkle: sha(Buffer.from(`m${salt++}`)), time, bits });
const now = async () => Number((await pub.getBlock()).timestamp);

const GENESIS = hx(sha(Buffer.from("oracle-test-genesis")));
const start = (await now()) - 10 * 86400;
const cp = []; { let prev = { hash: sha(Buffer.from("before")) };
  for (let i = 0; i < 45; i++) { const h = header(prev, start + 120 * i); cp.push(h); prev = h; } }
const deploy = async (args) => (await pub.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: art[O].abi, bytecode: art[O].bytecode, args }) })).contractAddress;
const oracle = await deploy([GENESIS, cp.map(toSol), 5000n, 256n]);
const read = (fn, args = []) => pub.readContract({ address: oracle, abi: art[O].abi, functionName: fn, args });
const submit = async (hs) => { await pub.simulateContract({ account: me, address: oracle, abi: art[O].abi, functionName: "submitHeaders", args: [GENESIS, hs.map(toSol)] });
  const r = await pub.waitForTransactionReceipt({ hash: await wc.writeContract({ address: oracle, abi: art[O].abi, functionName: "submitHeaders", args: [GENESIS, hs.map(toSol)], gas: 20_000_000n }) }); return r; };

console.log("\n[oracle 1] No owner; the starting checkpoint is fixed");
{ const names = art.CsdHeaderOracle.abi.map(x => x.name);
  check(!names.includes("owner") && !names.includes("registerChainCheckpoint") && !names.includes("updateMaxTarget") && !names.includes("transferOwnership"), "the mainnet oracle has no owner and no admin functions");
  check(await read("checkpointHash") === hx(cp[44].hash) && await read("bestHeight", [GENESIS]) === 5044n, "best tip starts at the last checkpoint header (height 5044)");
  const bad = [...cp]; bad[10] = header(cp[8], cp[10].time);
  await reverts(deploy([GENESIS, bad.map(toSol), 5000n, 256n]), "InvalidCheckpoint", "checkpoint headers must link up");
  await reverts(deploy([GENESIS, cp.slice(0, 44).map(toSol), 5000n, 256n]), "InvalidCheckpoint", "checkpoint must be exactly 45 headers");
  const weak = [...cp]; weak[44] = { ...cp[44], nonce: cp[44].nonce + 1 }; // almost surely fails PoW at p=1/2... retry until it does
  for (let n = cp[44].nonce + 1; ; n++) { const b = Buffer.concat([u32(1), cp[44].prev, cp[44].merkle, u64(cp[44].time), u32(LIMIT), u32(n)]); if (BigInt(hx(dsha(b))) > target(LIMIT)) { weak[44] = { ...cp[44], nonce: n }; break; } }
  await reverts(deploy([GENESIS, weak.map(toSol), 5000n, 256n]), "HeaderInsufficientPoW", "checkpoint headers need valid proof of work"); }

console.log("\n[oracle 2] CSD's header rules");
let tip = cp[44];
{ const ok = header(tip, tip.time + 120);
  await reverts(submit([header(tip, tip.time + 59)]), "TimeTooEarly", "a header less than 60 s after its parent is rejected");
  await reverts(submit([header(tip, (await now()) + 2 * 3600 + 120)]), "TimeTooFarInFuture", "a header more than 2 h in the future is rejected");
  await reverts(submit([header(tip, tip.time + 120, 0x2000ffff)]), "UnexpectedBits", "a header claiming a different difficulty is rejected (must equal the LWMA retarget)");
  await reverts(submit([{ ...ok, nonce: ok.nonce, hash: ok.hash, merkle: sha(Buffer.from("tampered")) }].map(h => { for (let n = 0; ; n++) { const b = Buffer.concat([u32(1), h.prev, h.merkle, u64(h.time), u32(h.bits), u32(n)]); if (BigInt(hx(dsha(b))) > target(h.bits)) return { ...h, nonce: n }; } })), "HeaderInsufficientPoW", "a header without enough work is rejected");
  await reverts(submit([header({ hash: sha(Buffer.from("nowhere")) }, tip.time + 120)]), "ParentUnknown", "a header with an unknown parent is rejected");
  await reverts(submit([header(cp[10], cp[10].time + 120)]), "HistoryTooShort", "a fork inside the checkpoint can't be checked, so it's rejected");
  await reverts(pub.simulateContract({ account: me, address: oracle, abi: art[O].abi, functionName: "submitHeaders", args: [hx(sha(Buffer.from("other"))), [toSol(ok)]] }), "WrongChain", "headers for another chain are rejected");
  await submit([ok]); tip = ok;
  check(await read("bestTip", [GENESIS]) === hx(ok.hash), "a valid header extends the best chain"); }

console.log("\n[oracle 3] Difficulty follows LWMA when blocks come fast");
{ let harder = false; const fast = [];
  for (let i = 0; i < 25; i++) {
    const want = await read("expectedBitsAfter", [hx(tip.hash)]);
    const h = header(tip, tip.time + 60, want); await submit([h]); fast.push(h); tip = h;
    if (want !== LIMIT) harder = true;
  }
  check(harder && target(fast[24].bits) < target(LIMIT), `25 blocks at 60 s raise the difficulty (bits ${fast[24].bits.toString(16)})`);
  await reverts(submit([header(tip, tip.time + 60, LIMIT)]), "UnexpectedBits", "once difficulty has risen, a header at the old difficulty is rejected"); }

console.log("\n[oracle 4] Forks and confirmations");
{ const base = tip;
  const a1 = header(base, base.time + 120, await read("expectedBitsAfter", [hx(base.hash)]));
  await submit([a1]);
  const b1 = header(base, base.time + 121, await read("expectedBitsAfter", [hx(base.hash)]));
  await submit([b1]);
  check(await read("bestTip", [GENESIS]) === hx(a1.hash), "an equal-work fork doesn't replace the best tip");
  const b2 = header(b1, b1.time + 120, await read("expectedBitsAfter", [hx(b1.hash)]));
  await submit([b2]);
  check(await read("bestTip", [GENESIS]) === hx(b2.hash), "the fork with more work becomes the best chain");
  check(await read("isConfirmed", [hx(b1.hash), GENESIS, 2n]) === true, "b1 has 2 confirmations on the best chain");
  check(await read("isConfirmed", [hx(b1.hash), GENESIS, 3n]) === false, "but not 3");
  check(await read("isConfirmed", [hx(a1.hash), GENESIS, 1n]) === false, "the orphaned block a1 isn't confirmed at all");
  const r = await submit([header(b2, b2.time + 120, await read("expectedBitsAfter", [hx(b2.hash)]))]);
  console.log(`    (gas for one header: ${r.gasUsed})`); }

console.log(`\nAll ${pass} oracle checks passed.`);
