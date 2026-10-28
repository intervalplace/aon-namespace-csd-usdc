// Tests for CsdUsdcSettlement v4: scaled caps/lock windows, payment-freshness
// check, and buyer-signed early release. Runs against a local anvil.
import { createHash } from "node:crypto";
import { createPublicClient, createWalletClient, http, defineChain, hashTypedData, keccak256, toHex, BaseError, ContractFunctionRevertedError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";

const RPC = `http://127.0.0.1:${process.env.ANVIL_PORT ?? "8546"}`;
const art = JSON.parse(readFileSync(new URL("./artifacts.json", import.meta.url), "utf8"));
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http() });
const K = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80","0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d","0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a","0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"];
const [deployer, buyer, executor, seller] = K.map(k => privateKeyToAccount(k));
const wc = (a) => createWalletClient({ account: a, chain, transport: http() });
const deploy = async (n, args = []) => (await pub.waitForTransactionReceipt({ hash: await wc(deployer).deployContract({ abi: art[n].abi, bytecode: art[n].bytecode, args }) })).contractAddress;
const send = async (acct, address, n, fn, args) => { const r = await pub.waitForTransactionReceipt({ hash: await wc(acct).writeContract({ address, abi: art[n].abi, functionName: fn, args, gas: 5_000_000n }) }); if (r.status !== "success") throw new Error(`${fn} reverted`); return r; };
const read = (address, n, fn, args = []) => pub.readContract({ address, abi: art[n].abi, functionName: fn, args });
const rpc = (method, params = []) => pub.request({ method, params });
let pass = 0;
const check = (c, l) => { if (!c) { console.error("  FAIL:", l); process.exit(1); } pass++; console.log("  ok -", l); };
async function reverts(p, errName, label) {
  try { await p; } catch (e) {
    const r = e instanceof BaseError ? e.walk(x => x instanceof ContractFunctionRevertedError) : null;
    const name = r?.data?.errorName ?? r?.reason ?? String(e.shortMessage ?? e.message);
    return check(!errName || name === errName || String(name).includes(errName), `${label} (reverts: ${name})`);
  }
  check(false, `${label}: expected revert ${errName}`);
}
// simulate first so reverts decode with error names
const call = async (acct, address, n, fn, args) => { await pub.simulateContract({ account: acct, address, abi: art[n].abi, functionName: fn, args }); return send(acct, address, n, fn, args); };

// ── CSD encoding helpers (bincode fixint, little-endian) ─────────────────────
const sha = (b) => createHash("sha256").update(b).digest();
const dsha = (b) => sha(sha(b));
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hx = (b) => "0x" + Buffer.from(b).toString("hex");
function csdTx({ inputs = [], outputs }) {
  const parts = [u32(1), u64(inputs.length)];
  for (const i of inputs) parts.push(i.txid, u32(i.vout), u64(i.script.length), i.script);
  parts.push(u64(outputs.length));
  for (const o of outputs) parts.push(u64(o.value), o.script); // CSD: value u64 + bare 20-byte address
  parts.push(u32(0), u32(0)); // locktime, AppPayload::None
  return Buffer.concat(parts);
}
function csdTxid({ inputs = [], outputs }) { return dsha(csdTx({ inputs: inputs.map(i => ({ ...i, script: Buffer.alloc(0) })), outputs })); }
function csdTxidFromRaw(rawHex) { // strip input script_sigs, dsha256 — as the contract does
  const raw = Buffer.from(rawHex.slice(2), "hex"); const parts = [raw.subarray(0, 4)]; let off = 4;
  const n = Number(raw.readBigUInt64LE(off)); parts.push(raw.subarray(off, off + 8)); off += 8;
  for (let i = 0; i < n; i++) { parts.push(raw.subarray(off, off + 36), Buffer.alloc(8)); off += 36; const l = Number(raw.readBigUInt64LE(off)); off += 8 + l; }
  parts.push(raw.subarray(off)); return dsha(Buffer.concat(parts));
}
function headerBytes(h) { return Buffer.concat([u32(h.version), h.prev, h.merkle, u64(h.time), u32(h.bits), u32(h.nonce)]); }
const BITS = 0x207fffff; // TestCsdUsdcSettlement runs the real rules at this easy PoW limit
const TARGET = BigInt(0x7fffff) << BigInt(8 * (0x20 - 3));
const targetOf = (bits) => { const e = BigInt(bits >>> 24), m = BigInt(bits & 0xffffff); return e <= 3n ? m >> (8n * (3n - e)) : m << (8n * (e - 3n)); };
function mine(h) { const t = targetOf(h.bits); for (let n = 0; ; n++) { const hash = dsha(headerBytes({ ...h, nonce: n })); if (BigInt(hx(hash)) <= t) return { ...h, nonce: n, hash }; } }
const toSol = (h) => ({ version: h.version, prev: hx(h.prev), merkle: hx(h.merkle), time: BigInt(h.time), bits: h.bits, nonce: h.nonce });

// ── Setup ─────────────────────────────────────────────────────────────────────
const usdc = await deploy("MockUSDC");
const GENESIS = hx(sha(Buffer.from("csd-test-genesis")));
// Self-contained proofs: no oracle. The chain here is just the test's own blocks.
const settlement = await deploy("TestCsdUsdcSettlement", [usdc, 10_000_000_000n, GENESIS]);
await send(deployer, usdc, "MockUSDC", "mint", [buyer.address, 10_000_000_000n]);
await send(buyer, usdc, "MockUSDC", "approve", [settlement, 10_000_000_000n]);
const bal = (who) => read(usdc, "MockUSDC", "balanceOf", [who]);
let tip = { hash: sha(Buffer.from("csd-test-start")), time: Number((await pub.getBlock()).timestamp) - 30 * 86400 };
const now = async () => Number((await pub.getBlock()).timestamp);

const domain = { name: "AON CSD/USDC", version: "4", chainId: 31337, verifyingContract: settlement };
const AUTH_TYPES = { CsdUsdcAuthorization: [
  { name: "buyer", type: "address" }, { name: "sellerUsdcRecipient", type: "address" }, { name: "sellerCsdScriptHash", type: "bytes32" },
  { name: "csdGenesisHash", type: "bytes32" }, { name: "tradeIntentHash", type: "bytes32" }, { name: "csdAmount", type: "uint256" },
  { name: "usdc", type: "address" }, { name: "usdcAmount", type: "uint256" }, { name: "minConfirmations", type: "uint256" }, { name: "csdMaxTarget", type: "uint256" },
  { name: "executorFeeAmount", type: "uint256" }, { name: "validAfter", type: "uint64" }, { name: "validBefore", type: "uint64" }, { name: "nonce", type: "bytes32" } ] };
const RELEASE_TYPES = { CsdUsdcEarlyRelease: [
  { name: "authHash", type: "bytes32" }, { name: "sellerUsdcRecipient", type: "address" }, { name: "usdcAmount", type: "uint256" },
  { name: "csdTxid", type: "bytes32" }, { name: "lockedAt", type: "uint256" }, { name: "deadline", type: "uint64" } ] };
let txN = 0;
const fakeTxid = () => hx(sha(Buffer.from(`csd-tx-${txN++}`)));
// The release message for a locked trade (reads lockedAt from the contract)
async function releaseMsg(a, over = {}) {
  return { authHash: a.hash, sellerUsdcRecipient: a.auth.sellerUsdcRecipient, usdcAmount: a.auth.usdcAmount, csdTxid: fakeTxid(),
    lockedAt: await read(settlement, "CsdUsdcSettlement", "lockedAt", [a.hash]), deadline: BigInt((await now()) + 600), ...over };
}
const signRelease = (msg, who = buyer) => who.signTypedData({ domain, types: RELEASE_TYPES, primaryType: "CsdUsdcEarlyRelease", message: msg });
const BUYER_CSD_ADDR = createHash("ripemd160").update(sha(Buffer.from("buyer-csd-pubkey"))).digest(); // hash160
let nonceN = 0;
let addrN = 0;
const freshAddr = () => createHash("ripemd160").update(sha(Buffer.from(`buyer-csd-${addrN++}`))).digest();
async function makeAuth({ usdcAmount, conf = 3n, fee = 50_000n, csdAmount = 500_00000000n, maxTarget = TARGET, addr = freshAddr() }) {
  const t = await now();
  const auth = { buyer: buyer.address, sellerUsdcRecipient: seller.address, sellerCsdScriptHash: hx(Buffer.concat([addr, Buffer.alloc(12)])),
    csdGenesisHash: GENESIS, tradeIntentHash: keccak256(toHex("offer")), csdAmount, usdc, usdcAmount, minConfirmations: conf, csdMaxTarget: maxTarget,
    executorFeeAmount: fee, validAfter: BigInt(t - 60), validBefore: BigInt(t + 6 * 3600), nonce: keccak256(toHex(`n${nonceN++}`)) };
  const sig = await buyer.signTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: auth });
  return { auth, sig, addr, hash: hashTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: auth }) };
}
let payN = 0;
// A CSD payment block plus `extra` confirmation headers on top of the current tip
async function payAndConfirm({ to = BUYER_CSD_ADDR, value, time, extra, keepClock = false }) {
  const coinbase = csdTx({ inputs: [{ txid: Buffer.alloc(32), vout: 0xffffffff, script: u64(1) }], outputs: [{ value: 50n * 100000000n, script: Buffer.alloc(20, 7) }] });
  const cbid = dsha(coinbase); // coinbase script_sig is kept in its txid; the contract never sees it
  const pay = { inputs: [{ txid: sha(Buffer.from(`prevout-${payN++}`)), vout: 0, script: Buffer.alloc(99, 1) }], outputs: [{ value, script: to }, { value: 1n, script: Buffer.alloc(20, 3) }] };
  const pid = csdTxid(pay);
  const merkle = dsha(Buffer.concat([cbid, pid]));
  if (time === undefined) time = tip.time + 120;
  // keep the confirming tip within a few minutes of the EVM clock (MAX_TIP_AHEAD_SECONDS)
  const ahead = time + 120 * extra - (await now()) - 300;
  if (ahead > 0 && !keepClock) { await rpc("evm_increaseTime", [ahead]); await rpc("evm_mine"); }
  if (time < tip.time + 120) throw new Error(`test bug: payment time ${time} not after tip ${tip.time}`);
  const block = mine({ version: 1, prev: tip.hash, merkle, time, bits: BITS, nonce: 0 });
  const conf = []; let prev = block.hash;
  for (let i = 0; i < extra; i++) { const h = mine({ version: 1, prev, merkle: sha(Buffer.from(`m${Math.random()}`)), time: time + 120 * (i + 1), bits: BITS, nonce: 0 }); conf.push(h); prev = h.hash; }
  tip = { hash: prev, time: time + 120 * extra };
  return { txRaw: hx(csdTx(pay)), merkleBranch: [{ hash: hx(cbid), isLeft: true }], header: toSol(block), confirmationChain: conf.map(toSol) };
}
const S = "TestCsdUsdcSettlement";

console.log("\n[1] Hashing matches between contract and off-chain signing");
{ const a = await makeAuth({ usdcAmount: 10_000_000n });
  check(await read(settlement, S, "hashCsdUsdcAuthorization", [a.auth]) === a.hash, "authorization hash (domain version 3)");
  const m = { authHash: a.hash, sellerUsdcRecipient: seller.address, usdcAmount: 10_000_000n, csdTxid: fakeTxid(), lockedAt: 123n, deadline: 456n };
  check(await read(settlement, S, "hashCsdUsdcEarlyRelease", [m]) === hashTypedData({ domain, types: RELEASE_TYPES, primaryType: "CsdUsdcEarlyRelease", message: m }), "early-release hash"); }

console.log("\n[2] Lock windows scale with confirmations; the cap stays 30 USDC");
{ let a = await makeAuth({ usdcAmount: 29_950_000n, conf: 3n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  const t = await now();
  check(Number(await read(settlement, S, "lockedUntil", [a.hash])) === t + 25 * 60, "3 confirmations: 30 USDC (incl. fee) allowed, locked for 25 minutes (unchanged)");
  a = await makeAuth({ usdcAmount: 29_950_001n, conf: 3n });
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]), "TradeLimitExceeded", "3 confirmations: 30.000001 USDC (incl. fee) rejected");
  a = await makeAuth({ usdcAmount: 29_950_000n, conf: 20n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  check(Number(await read(settlement, S, "lockedUntil", [a.hash])) === (await now()) + 110 * 60, "20 confirmations: locked for 110 minutes");
  a = await makeAuth({ usdcAmount: 29_950_001n, conf: 20n });
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]), "TradeLimitExceeded", "20 confirmations: still max 30 USDC");
  a = await makeAuth({ usdcAmount: 1_000_000n, conf: 61n });
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]), "TradeLimitExceeded", "61 confirmations rejected");
  a = await makeAuth({ usdcAmount: 1_000_000n, conf: 2n });
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]), "TradeLimitExceeded", "2 confirmations rejected"); }

console.log("\n[2b] Total locked across all trades is capped");
{ const capped = await deploy("TestCsdUsdcSettlement", [usdc, 60_000_000n, GENESIS]);
  await send(buyer, usdc, "MockUSDC", "approve", [capped, 10_000_000_000n]);
  const cdomain = { ...domain, verifyingContract: capped };
  const mk = async (usdcAmount, n) => { const t = await now(); const auth = { buyer: buyer.address, sellerUsdcRecipient: seller.address, sellerCsdScriptHash: hx(Buffer.concat([freshAddr(), Buffer.alloc(12)])), csdGenesisHash: GENESIS, tradeIntentHash: keccak256(toHex("offer")), csdAmount: 1n, usdc, usdcAmount, minConfirmations: 3n, csdMaxTarget: TARGET, executorFeeAmount: 0n, validAfter: BigInt(t - 60), validBefore: BigInt(t + 3600), nonce: keccak256(toHex(`cap${n}`)) };
    return { auth, sig: await buyer.signTypedData({ domain: cdomain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: auth }) }; };
  const x = await mk(30_000_000n, 1), y = await mk(30_000_000n, 2), z = await mk(1_000_000n, 3);
  await call(executor, capped, S, "lockCsdUsdcAuthorization", [x.auth, x.sig]);
  await call(executor, capped, S, "lockCsdUsdcAuthorization", [y.auth, y.sig]);
  check(await read(capped, S, "totalLocked") === 60_000_000n, "two 30 USDC trades fill a 60 USDC cap");
  await reverts(call(executor, capped, S, "lockCsdUsdcAuthorization", [z.auth, z.sig]), "TotalLockedLimitExceeded", "a third trade has to wait");
  await rpc("evm_increaseTime", [26 * 60]); await rpc("evm_mine");
  await call(executor, capped, S, "refundExpiredLock", [x.auth]);
  await call(executor, capped, S, "lockCsdUsdcAuthorization", [z.auth, z.sig]);
  check(await read(capped, S, "totalLocked") === 31_000_000n, "room frees up when a trade closes"); }

console.log("\n[2c] Only the deployment's USDC; fees count toward the cap");
{ const other = await deploy("MockUSDC");
  const t = await now();
  const auth = { ...(await makeAuth({ usdcAmount: 1_000_000n })).auth, usdc: other, nonce: keccak256(toHex("wrongtoken")), validBefore: BigInt(t + 3600) };
  const sig = await buyer.signTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: auth });
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [auth, sig]), "WrongToken", "an authorization for another token can't be locked");
  const tiny = await makeAuth({ usdcAmount: 999_999n });
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [tiny.auth, tiny.sig]), "TradeLimitExceeded", "a trade under 1 USDC can't be locked (so an address can't be reserved for free)");
  const big = await makeAuth({ usdcAmount: 1_000_000n, fee: 100_000_000n });
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [big.auth, big.sig]), "TradeLimitExceeded", "a huge executor fee can't get around the cap"); }

console.log("\n[3] Normal settlement with a CSD proof still works");
{ const a = await makeAuth({ usdcAmount: 25_000_000n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  const s0 = await bal(seller.address), e0 = await bal(executor.address);
  const proof = await payAndConfirm({ to: a.addr, value: a.auth.csdAmount, time: Math.max(await now() + 60, tip.time + 120), extra: 2 });
  await call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, proof]);
  check(await bal(seller.address) - s0 === 25_000_000n, "seller received 25 USDC after 3 confirmations");
  check(await bal(executor.address) - e0 === 50_000n, "executor received its fee");
  check(await read(settlement, S, "finalizedAuthorization", [a.hash]) === true, "authorization finalized"); }

console.log("\n[3b] The proof's blocks: linked, enough work, at least the signed difficulty, CSD's spacing");
{ // A buyer who asks for a harder minimum difficulty than these blocks have
  const hard = await makeAuth({ usdcAmount: 10_000_000n, maxTarget: TARGET / 4n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [hard.auth, hard.sig]);
  let before = tip;
  const easy = await payAndConfirm({ to: hard.addr, value: hard.auth.csdAmount, extra: 2 });
  await reverts(call(executor, settlement, S, "settleCsdUsdc", [hard.auth, hard.sig, easy]), "CsdInsufficientWork", "3 blocks at a quarter of the signed difficulty aren't enough work");
  tip = before;
  // More blocks make up the work: at half the signed difficulty, 6 blocks count as 3
  const half = await makeAuth({ usdcAmount: 10_000_000n, maxTarget: TARGET / 2n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [half.auth, half.sig]);
  const six = await payAndConfirm({ to: half.addr, value: half.auth.csdAmount, extra: 5 });
  await reverts(call(executor, settlement, S, "settleCsdUsdc", [half.auth, half.sig, { ...six, confirmationChain: six.confirmationChain.slice(0, 4) }]), "CsdInsufficientWork", "5 blocks at half the difficulty: not yet");
  await call(executor, settlement, S, "settleCsdUsdc", [half.auth, half.sig, six]);
  check(await read(settlement, S, "finalizedAuthorization", [half.hash]) === true, "6 blocks at half the difficulty settle (if difficulty eases, the seller just waits for more blocks)");
  const a = await makeAuth({ usdcAmount: 10_000_000n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  before = tip;
  const p = await payAndConfirm({ to: a.addr, value: a.auth.csdAmount, extra: 2 });
  await reverts(call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, { ...p, confirmationChain: p.confirmationChain.slice(0, 1) }]), "CsdBlockNotConfirmed", "too few confirming blocks");
  const broken = { ...p, confirmationChain: [p.confirmationChain[1], p.confirmationChain[0]] };
  await reverts(call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, broken]), "CsdChainBroken", "confirming blocks must link up by hash");
  const c0 = p.confirmationChain[0];
  const fast = mine({ version: 1, prev: Buffer.from(c0.prev.slice(2), "hex"), merkle: Buffer.from(c0.merkle.slice(2), "hex"), time: Number(p.header.time) + 59, bits: BITS, nonce: 0 });
  await reverts(call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, { ...p, confirmationChain: [toSol(fast), p.confirmationChain[1]] }]), "CsdBlockTooSoon", "a block less than 60 s after its parent doesn't count");
  let bad = { ...c0 }; for (let n = c0.nonce + 1; ; n++) { const h = { ...c0, nonce: n }; const b = headerBytes({ version: 1, prev: Buffer.from(h.prev.slice(2), "hex"), merkle: Buffer.from(h.merkle.slice(2), "hex"), time: Number(h.time), bits: h.bits, nonce: n }); if (BigInt(hx(dsha(b))) > TARGET) { bad = h; break; } }
  await reverts(call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, { ...p, confirmationChain: [bad, p.confirmationChain[1]] }]), "CsdInsufficientPoW", "a block without enough proof of work doesn't count");
  const future = { ...p, confirmationChain: [p.confirmationChain[0], toSol(mine({ version: 1, prev: Buffer.from(p.confirmationChain[0].prev.slice(2), "hex"), merkle: sha(Buffer.from("fut")), time: (await now()) + 2 * 3600 + 600, bits: BITS, nonce: 0 }))] };
  future.confirmationChain[1] = toSol(mine({ version: 1, prev: dsha(headerBytes({ version: 1, prev: Buffer.from(c0.prev.slice(2), "hex"), merkle: Buffer.from(c0.merkle.slice(2), "hex"), time: Number(c0.time), bits: c0.bits, nonce: c0.nonce })), merkle: sha(Buffer.from("fut")), time: (await now()) + 2 * 3600 + 600, bits: BITS, nonce: 0 }));
  await reverts(call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, future]), "CsdBlockInFuture", "a block more than 2 h in the future doesn't count");
  const rc = await call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, p]);
  check(await read(settlement, S, "finalizedAuthorization", [a.hash]) === true, `the valid proof settles (gas ${rc.gasUsed} with 3 confirmations)`);
  const g = { ...(await makeAuth({ usdcAmount: 1_000_000n })).auth, csdGenesisHash: hx(sha(Buffer.from("other-chain"))), nonce: keccak256(toHex("g")) };
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [g, await buyer.signTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: g })]), "CsdGenesisHashMismatch", "an authorization for another CSD chain can't be locked");
}

console.log("\n[4] A CSD payment from before the lock doesn't count");
{ const gap = tip.time + 3600 - await now(); if (gap > 0) { await rpc("evm_increaseTime", [gap]); await rpc("evm_mine"); }
  const a = await makeAuth({ usdcAmount: 10_000_000n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  const before = tip;
  const old = await payAndConfirm({ to: a.addr, value: a.auth.csdAmount, time: await now() - 21 * 60, extra: 2 });
  await reverts(call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, old]), "CsdPaymentBeforeLock", "payment 21 minutes before the lock rejected");
  tip = before; // that branch was never submitted
  const ok = await payAndConfirm({ to: a.addr, value: a.auth.csdAmount, time: await now() - 19 * 60, extra: 2 });
  await call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, ok]);
  check(await read(settlement, S, "finalizedAuthorization", [a.hash]) === true, "payment within the 20-minute timestamp slack accepted"); }

console.log("\n[5] Early release: the buyer waives the wait");
{ const a = await makeAuth({ usdcAmount: 29_950_000n });
  const R = (msg, sig) => call(executor, settlement, S, "releaseEarly", [a.auth, msg, sig]);
  { const m = { authHash: a.hash, sellerUsdcRecipient: seller.address, usdcAmount: 29_950_000n, csdTxid: fakeTxid(), lockedAt: 0n, deadline: BigInt((await now()) + 600) };
    await reverts(R(m, await signRelease(m)), "AuthorizationNotLocked", "nothing to release before the lock"); }
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  let m = await releaseMsg(a);
  await reverts(R(m, await signRelease(m, seller)), "BadSignature", "the seller can't release it");
  await reverts(R(m, await signRelease(m, executor)), "BadSignature", "the executor can't release it");
  const other = await makeAuth({ usdcAmount: 29_950_000n });
  { const o = { ...m, authHash: other.hash }; await reverts(R(o, await signRelease(o)), "EarlyReleaseMismatch", "a release for another trade doesn't work"); }
  { const o = { ...m, usdcAmount: 29_000_000n }; await reverts(R(o, await signRelease(o)), "EarlyReleaseMismatch", "a release naming a different amount doesn't work"); }
  { const o = { ...m, sellerUsdcRecipient: executor.address }; await reverts(R(o, await signRelease(o)), "EarlyReleaseMismatch", "a release naming a different recipient doesn't work"); }
  { const o = { ...m, lockedAt: m.lockedAt - 1n }; await reverts(R(o, await signRelease(o)), "EarlyReleaseMismatch", "a release for a different lock doesn't work"); }
  { const o = { ...m, deadline: BigInt((await now()) - 1) }; await reverts(R(o, await signRelease(o)), "EarlyReleaseExpired", "an expired release doesn't work"); }
  { const o = { ...m, csdTxid: "0x" + "00".repeat(32) }; await reverts(R(o, await signRelease(o)), "EarlyReleaseMismatch", "a release must name a CSD payment"); }
  const s0 = await bal(seller.address), e0 = await bal(executor.address), c0 = await bal(settlement);
  await R(m, await signRelease(m));
  check(await bal(seller.address) - s0 === 29_950_000n, "seller received 29.95 USDC immediately, no CSD proof");
  check(await bal(executor.address) - e0 === 50_000n, "executor received its fee");
  check(c0 - await bal(settlement) === 30_000_000n, "contract paid out exactly the locked amount");
  check(await read(settlement, S, "consumedCsdPayment", [await read(settlement, S, "csdPaymentKey", [m.csdTxid, a.auth.sellerCsdScriptHash])]) === true, "the accepted CSD payment is used up");
  await reverts(R(m, await signRelease(m)), "AuthorizationAlreadyFinalized", "can't be released twice");
  const before = tip;
  const proof = await payAndConfirm({ to: a.addr, value: a.auth.csdAmount, time: Math.max(await now() + 60, tip.time + 120), extra: 2 });
  await reverts(call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, proof]), "AuthorizationAlreadyFinalized", "can't also be settled with a proof");
  tip = before;
  await rpc("evm_increaseTime", [3600]); await rpc("evm_mine");
  await reverts(call(executor, settlement, S, "refundExpiredLock", [a.auth]), "AuthorizationAlreadyFinalized", "can't be refunded afterwards");
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]), "AuthorizationAlreadyFinalized", "can't be locked again"); }

console.log("\n[6] A CSD payment accepted by an early release can't pay for another trade");
{ const a = await makeAuth({ usdcAmount: 10_000_000n }), b = await makeAuth({ usdcAmount: 10_000_000n, addr: a.addr }); // same CSD address
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [b.auth, b.sig]), "CsdAddressBusy", "a second open trade to the same CSD address has to wait");
  const before = tip;
  const proof = await payAndConfirm({ to: a.addr, value: a.auth.csdAmount, time: Math.max(await now() + 60, tip.time + 120), extra: 2 });
  const txid = hx(csdTxidFromRaw(proof.txRaw));
  const m = await releaseMsg(a, { csdTxid: txid });
  await call(executor, settlement, S, "releaseEarly", [a.auth, m, await signRelease(m)]);
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [b.auth, b.sig]);
  await reverts(call(executor, settlement, S, "settleCsdUsdc", [b.auth, b.sig, proof]), "CsdTxAlreadyConsumed", "once A closes, B can open, but A's payment can't settle B");
  tip = before; }

console.log("\n[6b] Nobody can block a seller by naming their payment in an unrelated trade");
{ const victim = await makeAuth({ usdcAmount: 10_000_000n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [victim.auth, victim.sig]);
  const before = tip;
  const proof = await payAndConfirm({ to: victim.addr, value: victim.auth.csdAmount, time: Math.max(await now() + 60, tip.time + 120), extra: 2 });
  const txid = hx(csdTxidFromRaw(proof.txRaw));
  // The attacker trades with themselves (own CSD address) and "accepts" the victim's payment
  await send(deployer, usdc, "MockUSDC", "mint", [executor.address, 5_000_000n]);
  await send(executor, usdc, "MockUSDC", "approve", [settlement, 10_000_000n]);
  const t = await now();
  const evil = { ...victim.auth, buyer: executor.address, sellerUsdcRecipient: executor.address, usdcAmount: 1_000_000n, executorFeeAmount: 0n,
    sellerCsdScriptHash: hx(Buffer.concat([Buffer.alloc(20, 0xee), Buffer.alloc(12)])), nonce: keccak256(toHex("evil")), validBefore: BigInt(t + 3600) };
  const evilSig = await executor.signTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: evil });
  const evilHash = hashTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: evil });
  const squat = { ...evil, sellerCsdScriptHash: victim.auth.sellerCsdScriptHash, nonce: keccak256(toHex("squat")) };
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [squat, await executor.signTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: squat })]), "CsdAddressBusy", "nobody can open a second trade on the victim's busy CSD address");
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [evil, evilSig]);
  const em = { authHash: evilHash, sellerUsdcRecipient: executor.address, usdcAmount: 1_000_000n, csdTxid: txid, lockedAt: await read(settlement, S, "lockedAt", [evilHash]), deadline: BigInt((await now()) + 600) };
  await call(executor, settlement, S, "releaseEarly", [evil, em, await executor.signTypedData({ domain, types: RELEASE_TYPES, primaryType: "CsdUsdcEarlyRelease", message: em })]);
  const s0 = await bal(seller.address);
  await call(executor, settlement, S, "settleCsdUsdc", [victim.auth, victim.sig, proof]);
  check(await bal(seller.address) - s0 === 10_000_000n, "the victim's trade still settles with its own payment");
  }

console.log("\n[7] Release after the window, refunds, and no re-locking after a refund");
{ const a = await makeAuth({ usdcAmount: 5_000_000n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  const m = await releaseMsg(a, { deadline: BigInt((await now()) + 3600) });
  await rpc("evm_increaseTime", [26 * 60]); await rpc("evm_mine");
  const s0 = await bal(seller.address);
  await call(executor, settlement, S, "releaseEarly", [a.auth, m, await signRelease(m)]);
  check(await bal(seller.address) - s0 === 5_000_000n, "buyer can still release after the window, before anyone refunds");
  const b = await makeAuth({ usdcAmount: 5_000_000n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [b.auth, b.sig]);
  const stale = await releaseMsg(b, { deadline: BigInt((await now()) + 6 * 3600) }); // signed, never submitted
  const staleSig = await signRelease(stale);
  await reverts(call(executor, settlement, S, "refundExpiredLock", [b.auth]), "AuthorizationLocked", "no refund inside the window");
  await rpc("evm_increaseTime", [26 * 60]); await rpc("evm_mine");
  const b0 = await bal(buyer.address);
  await call(executor, settlement, S, "refundExpiredLock", [b.auth]);
  check(await bal(buyer.address) - b0 === 5_050_000n, "refund returns USDC plus the unused fee to the buyer");
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [b.auth, b.sig]), "AuthorizationRefunded", "a refunded authorization can't be locked again");
  await reverts(call(executor, settlement, S, "releaseEarly", [b.auth, stale, staleSig]), "AuthorizationNotLocked", "an old, unsent release can't be used after the refund"); }

console.log("\n[8] Namespace objects and the executor");
{ const ns = await import("../src/index.ts");
  const { buildCsdUsdcAuthorizationObject, buildCsdUsdcEarlyReleaseObject, csdUsdcNamespace, EARLY_RELEASE_TYPES, csdUsdcAuthHash, releaseMatchesAuthorization, releaseEarlyOnEvm, lockCsdUsdcOnEvm } = ns;
  Object.assign(process.env, { AON_SETTLEMENT_CONTRACT: settlement, AON_EVM_RPC_URL: RPC, AON_EXECUTOR_PRIVATE_KEY: K[2] });
  const a = await makeAuth({ usdcAmount: 20_000_000n });
  const authObj = await buildCsdUsdcAuthorizationObject({ authorization: a.auth, signature: a.sig, domain, types: AUTH_TYPES });
  check(csdUsdcAuthHash(authObj) === a.hash, "csdUsdcAuthHash matches the contract's authorization hash");
  await lockCsdUsdcOnEvm({ authorization: authObj });
  const relArgs = { csdTxid: fakeTxid(), lockedAt: await read(settlement, S, "lockedAt", [a.hash]), deadline: BigInt((await now()) + 600) };
  const relMsg = ns.earlyReleaseMessage(authObj, relArgs);
  const relSig = await buyer.signTypedData({ domain, types: EARLY_RELEASE_TYPES, primaryType: "CsdUsdcEarlyRelease", message: relMsg });
  const rel = await buildCsdUsdcEarlyReleaseObject({ authorization: authObj, ...relArgs, signature: relSig });
  await csdUsdcNamespace.validateObject(rel);
  check(rel.objectType === "release" && rel.references[0] === authObj.objectHash, "release object references its authorization and validates");
  check(releaseMatchesAuthorization(rel, authObj), "releaseMatchesAuthorization: true for its own authorization");
  const o = await makeAuth({ usdcAmount: 20_000_000n });
  const other = await buildCsdUsdcAuthorizationObject({ authorization: o.auth, signature: o.sig, domain, types: AUTH_TYPES });
  check(!releaseMatchesAuthorization(rel, other), "releaseMatchesAuthorization: false for another authorization");
  const sellerSig = await seller.signTypedData({ domain, types: EARLY_RELEASE_TYPES, primaryType: "CsdUsdcEarlyRelease", message: relMsg });
  await reverts(buildCsdUsdcEarlyReleaseObject({ authorization: authObj, ...relArgs, signature: sellerSig }), "BAD_EARLY_RELEASE_SIGNATURE", "builder refuses a release not signed by the buyer");
  const forged = JSON.parse(JSON.stringify(rel)); forged.payload.signature.signature = sellerSig;
  await reverts(csdUsdcNamespace.validateObject(forged), "RELEASE_SIGNATURE_INVALID", "validator rejects a release with the wrong signature");
  const s0 = await bal(seller.address);
  const r = await releaseEarlyOnEvm({ authorization: authObj, release: rel });
  check(r.executed && await bal(seller.address) - s0 === 20_000_000n, "releaseEarlyOnEvm pays the seller immediately"); }

console.log(`\nAll ${pass} checks passed.`);
