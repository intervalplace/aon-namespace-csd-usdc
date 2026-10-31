// Why does a buy's settlement revert? Rebuilds the bot's proof for one of its buys (from its state
// file and its CSD node), checks the parts locally, and replays settleCsdUsdc on an RPC that
// reports revert reasons.
//
//   npx tsx scripts/why-settle.ts [authHash]      (default: the oldest buy that is locked)
//
// Env (as for the bot): STATE_FILE, CSD_API_URL, SETTLEMENT_CONTRACT; optional WHY_RPC.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createPublicClient, http, getAddress, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { settlementAbi, authTuple, spvProofTuple } from "../src/executors/evmCsdUsdcSettlement.js";
import { bitsToTarget } from "../src/csd-wallet.js";

const STATE = process.env.STATE_FILE ?? "/var/lib/covenant-mm/state.json";
const CSD = (process.env.CSD_API_URL ?? "http://127.0.0.1:8887").replace(/\/$/, "");
const SETTLEMENT = getAddress(process.env.SETTLEMENT_CONTRACT ?? "0x8863f0c477a30bb5a2077c813f42250d7fbefcb9");
const RPCS = (process.env.WHY_RPC ?? "https://ethereum-rpc.publicnode.com,https://eth.llamarpc.com").split(",");
const ok = (b: boolean, what: string, extra = "") => console.log(`${b ? "OK  " : "FAIL"}  ${what}${extra ? "  " + extra : ""}`);
const sha = (b: Buffer) => createHash("sha256").update(b).digest();
const dsha = (b: Buffer) => sha(sha(b));
const hx = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");
const le = (n: bigint | number, bytes: number) => { const b = Buffer.alloc(bytes); let v = BigInt(n); for (let i = 0; i < bytes; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const headerHash = (h: any) => "0x" + dsha(Buffer.concat([le(Number(h.version), 4), hx(h.prev), hx(h.merkle), le(BigInt(h.time), 8), le(Number(h.bits), 4), le(Number(h.nonce), 4)])).toString("hex");

const S = JSON.parse(readFileSync(STATE, "utf8"));
const want = process.argv[2]?.toLowerCase();
const t: any = Object.values(S.trades).filter((x: any) => x.kind === "buy" && (want ? x.authHash.toLowerCase() === want : x.status === "locked")).sort((a: any, b: any) => a.createdAt - b.createdAt)[0];
if (!t) { console.log("No such locked buy in the state file."); process.exit(1); }
console.log(`buy ${t.authHash}  status ${t.status}  CSD payment ${t.csdTxid}\n`);

const proof = await (await fetch(`${CSD}/proof/tx/${t.csdTxid}`)).json();
ok(!!proof?.ok, "the CSD node has a proof for the payment", proof?.ok ? `height ${proof.height}, ${proof.confirmations} confirmations` : JSON.stringify(proof).slice(0, 200));
if (!proof?.ok) process.exit(1);
console.log("      proof fields:", Object.keys(proof).join(", "));
console.log("      header:", JSON.stringify(proof.header));
console.log("      branch:", JSON.stringify(proof.merkle_branch?.slice(0, 2)), `(${proof.merkle_branch?.length} steps)`);

// 1. Merkle path (as the contract walks it), from the txid the bot computed
const walk = (txid: string, swap: boolean, rev: boolean) => {
  let cur = rev ? Buffer.from(hx(txid)).reverse() : hx(txid);
  for (const s of proof.merkle_branch ?? []) {
    const h = rev ? Buffer.from(hx(s.hash)).reverse() : hx(s.hash);
    const left = (s.position === "left") !== swap;
    cur = left ? dsha(Buffer.concat([h, cur])) : dsha(Buffer.concat([cur, h]));
  }
  return "0x" + (rev ? Buffer.from(cur).reverse() : cur).toString("hex");
};
const root = String(proof.header.merkle).toLowerCase();
ok(walk(t.csdTxid, false, false) === root, "merkle path from the payment's txid reaches the block's merkle root (as the contract walks it)");
if (walk(t.csdTxid, false, false) !== root) {
  console.log("      with left/right swapped:", walk(t.csdTxid, true, false) === root ? "MATCHES" : "no");
  console.log("      with byte order reversed:", walk(t.csdTxid, false, true) === root ? "MATCHES" : "no");
  console.log("      node's txid field:", proof.txid, proof.txid?.toLowerCase() === t.csdTxid.toLowerCase() ? "(same)" : "(DIFFERENT)");
}
ok(headerHash(proof.header) === String(proof.block_hash).toLowerCase(), "header fields hash to the block hash (as the contract hashes them)", `${headerHash(proof.header)} vs ${proof.block_hash}`);

// 2. The confirmation chain, built like the bot builds it
const work = (target: bigint) => (1n << 256n) / (target + 1n);
const need = BigInt(t.auth.minConfirmations) * work(BigInt(t.auth.csdMaxTarget));
let have = work(bitsToTarget(Number(proof.header.bits))); const chain: any[] = [];
let prevHash = headerHash(proof.header), linked = true, spacing: number[] = [], prevTime = Number(proof.header.time);
for (let h = Number(proof.height) + 1; (have < need || chain.length + 1 < Number(t.auth.minConfirmations)) && chain.length < 120; h++) {
  const b = await (await fetch(`${CSD}/block/height/${h}`)).json();
  if (!b?.header?.bits) break;
  if (String(b.header.prev).toLowerCase() !== prevHash) linked = false;
  prevHash = headerHash(b.header); spacing.push(Number(b.header.time) - prevTime); prevTime = Number(b.header.time);
  chain.push(b.header); have += work(bitsToTarget(Number(b.header.bits)));
}
ok(have >= need, "enough work after the payment at the signed difficulty", `${chain.length} headers`);
ok(chain.length + 1 >= Number(t.auth.minConfirmations), "at least minConfirmations blocks", `${chain.length + 1} of ${t.auth.minConfirmations}`);
ok(linked, "the headers link up by hash");
const minGap = Math.min(...spacing);
ok(minGap >= 60, "CSD's 60-second spacing between consecutive blocks", `smallest gap ${minGap}s, gaps ${spacing.slice(0, 25).join(",")}`);
const signedTarget = BigInt(t.auth.csdMaxTarget), blockTarget = bitsToTarget(Number(proof.header.bits));
ok(blockTarget <= signedTarget, "the payment block meets the signed difficulty", `block target ${blockTarget.toString(16).length} hex digits vs signed ${signedTarget.toString(16).length}`);

// 3. Replay on an RPC that reports revert reasons
let c: any = null;
for (const url of RPCS) { try { const x = createPublicClient({ chain: mainnet, transport: http(url) }); await x.getBlockNumber(); c = x; break; } catch {} }
const [lockedAt, lockedUntil] = await Promise.all([
  c.readContract({ address: SETTLEMENT, abi: [{ type: "function", name: "lockedAt", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] }], functionName: "lockedAt", args: [t.authHash] }),
  c.readContract({ address: SETTLEMENT, abi: [{ type: "function", name: "lockedUntil", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] }], functionName: "lockedUntil", args: [t.authHash] }),
]);
console.log(`\n      locked at ${lockedAt}, until ${lockedUntil}; payment block time ${proof.header.time} (${Number(proof.header.time) - Number(lockedAt)}s after the lock)`);
proof.confirmation_chain = chain;
try {
  await c.simulateContract({ account: S.address ?? "0x71cDFF394fD19cfA97946E6BAA08232cF357abD0", address: SETTLEMENT, abi: settlementAbi, functionName: "settleCsdUsdc",
    args: [authTuple(t.auth), t.authSig, spvProofTuple(proof)] });
  ok(true, "settleCsdUsdc replayed now would succeed");
} catch (e: any) {
  ok(false, "settleCsdUsdc replayed", (e.cause?.data?.errorName ? `${e.cause.data.errorName}(${(e.cause.data.args ?? []).join(", ")})` : "") + " " + (e.shortMessage ?? e.message).split("\n")[0]);
}
