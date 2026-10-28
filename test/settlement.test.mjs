// Tests for CsdUsdcSettlement v3: scaled caps/lock windows, payment-freshness
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
  for (const o of outputs) parts.push(u64(o.value), u64(20), o.script);
  parts.push(u32(0), u32(0)); // locktime, AppPayload::None
  return Buffer.concat(parts);
}
function csdTxid({ inputs = [], outputs }) { return dsha(csdTx({ inputs: inputs.map(i => ({ ...i, script: Buffer.alloc(0) })), outputs })); }
function headerBytes(h) { return Buffer.concat([u32(h.version), h.prev, h.merkle, u64(h.time), u32(h.bits), u32(h.nonce)]); }
const BITS = 0x207fffff; // very easy target, accepted because the oracle's maxTarget is set to match
const TARGET = BigInt(0x7fffff) << BigInt(8 * (0x20 - 3));
function mine(h) { for (let n = 0; ; n++) { const hash = dsha(headerBytes({ ...h, nonce: n })); if (BigInt(hx(hash)) <= TARGET) return { ...h, nonce: n, hash }; } }
const toSol = (h) => ({ version: h.version, prev: hx(h.prev), merkle: hx(h.merkle), time: BigInt(h.time), bits: h.bits, nonce: h.nonce });

// ── Setup ─────────────────────────────────────────────────────────────────────
const usdc = await deploy("MockUSDC");
const oracle = await deploy("CsdHeaderOracle", [256n]);
const settlement = await deploy("CsdUsdcSettlement", [oracle]);
const GENESIS = hx(sha(Buffer.from("csd-test-genesis")));
const CHECKPOINT = sha(Buffer.from("csd-test-checkpoint"));
await send(deployer, oracle, "CsdHeaderOracle", "registerChainCheckpoint", [GENESIS, hx(CHECKPOINT), 1000n, 1n, TARGET]);
await send(deployer, usdc, "MockUSDC", "mint", [buyer.address, 10_000_000_000n]);
await send(buyer, usdc, "MockUSDC", "approve", [settlement, 10_000_000_000n]);
const bal = (who) => read(usdc, "MockUSDC", "balanceOf", [who]);
let tip = CHECKPOINT;
const now = async () => Number((await pub.getBlock()).timestamp);

const domain = { name: "AON CSD/USDC", version: "3", chainId: 31337, verifyingContract: settlement };
const AUTH_TYPES = { CsdUsdcAuthorization: [
  { name: "buyer", type: "address" }, { name: "sellerUsdcRecipient", type: "address" }, { name: "sellerCsdScriptHash", type: "bytes32" },
  { name: "csdGenesisHash", type: "bytes32" }, { name: "tradeIntentHash", type: "bytes32" }, { name: "csdAmount", type: "uint256" },
  { name: "usdc", type: "address" }, { name: "usdcAmount", type: "uint256" }, { name: "minConfirmations", type: "uint256" },
  { name: "executorFeeAmount", type: "uint256" }, { name: "validAfter", type: "uint64" }, { name: "validBefore", type: "uint64" }, { name: "nonce", type: "bytes32" } ] };
const RELEASE_TYPES = { CsdUsdcEarlyRelease: [{ name: "authHash", type: "bytes32" }] };
const BUYER_CSD_ADDR = createHash("ripemd160").update(sha(Buffer.from("buyer-csd-pubkey"))).digest(); // hash160
let nonceN = 0;
async function makeAuth({ usdcAmount, conf = 3n, fee = 50_000n, csdAmount = 500_00000000n }) {
  const t = await now();
  const auth = { buyer: buyer.address, sellerUsdcRecipient: seller.address, sellerCsdScriptHash: hx(Buffer.concat([BUYER_CSD_ADDR, Buffer.alloc(12)])),
    csdGenesisHash: GENESIS, tradeIntentHash: keccak256(toHex("offer")), csdAmount, usdc, usdcAmount, minConfirmations: conf,
    executorFeeAmount: fee, validAfter: BigInt(t - 60), validBefore: BigInt(t + 6 * 3600), nonce: keccak256(toHex(`n${nonceN++}`)) };
  const sig = await buyer.signTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: auth });
  return { auth, sig, hash: hashTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: auth }) };
}
let payN = 0;
// A CSD payment block plus `extra` confirmation headers on top of the current tip
function payAndConfirm({ to = BUYER_CSD_ADDR, value, time, extra }) {
  const coinbase = csdTx({ inputs: [{ txid: Buffer.alloc(32), vout: 0xffffffff, script: u64(1) }], outputs: [{ value: 50n * 100000000n, script: Buffer.alloc(20, 7) }] });
  const cbid = dsha(coinbase); // coinbase script_sig is kept in its txid; the contract never sees it
  const pay = { inputs: [{ txid: sha(Buffer.from(`prevout-${payN++}`)), vout: 0, script: Buffer.alloc(99, 1) }], outputs: [{ value, script: to }, { value: 1n, script: Buffer.alloc(20, 3) }] };
  const pid = csdTxid(pay);
  const merkle = dsha(Buffer.concat([cbid, pid]));
  const block = mine({ version: 1, prev: tip, merkle, time, bits: BITS, nonce: 0 });
  const conf = []; let prev = block.hash;
  for (let i = 0; i < extra; i++) { const h = mine({ version: 1, prev, merkle: sha(Buffer.from(`m${Math.random()}`)), time: time + 120 * (i + 1), bits: BITS, nonce: 0 }); conf.push(h); prev = h.hash; }
  tip = prev;
  return { txRaw: hx(csdTx(pay)), merkleBranch: [{ hash: hx(cbid), isLeft: true }], header: toSol(block), genesisHash: GENESIS, confirmationChain: conf.map(toSol) };
}
const S = "CsdUsdcSettlement";

console.log("\n[1] Hashing matches between contract and off-chain signing");
{ const a = await makeAuth({ usdcAmount: 10_000_000n });
  check(await read(settlement, S, "hashCsdUsdcAuthorization", [a.auth]) === a.hash, "authorization hash (domain version 3)");
  check(await read(settlement, S, "hashCsdUsdcEarlyRelease", [a.hash]) === hashTypedData({ domain, types: RELEASE_TYPES, primaryType: "CsdUsdcEarlyRelease", message: { authHash: a.hash } }), "early-release hash"); }

console.log("\n[2] Caps and lock windows scale with confirmations");
{ let a = await makeAuth({ usdcAmount: 30_000_000n, conf: 3n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  const t = await now();
  check(Number(await read(settlement, S, "lockedUntil", [a.hash])) === t + 25 * 60, "3 confirmations: 30 USDC allowed, locked for 25 minutes (unchanged)");
  a = await makeAuth({ usdcAmount: 30_000_001n, conf: 3n });
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]), "TradeLimitExceeded", "3 confirmations: 30.000001 USDC rejected");
  a = await makeAuth({ usdcAmount: 200_000_000n, conf: 20n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  check(Number(await read(settlement, S, "lockedUntil", [a.hash])) === (await now()) + 110 * 60, "20 confirmations: 200 USDC allowed, locked for 110 minutes");
  a = await makeAuth({ usdcAmount: 1_000_000n, conf: 61n });
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]), "TradeLimitExceeded", "61 confirmations rejected");
  a = await makeAuth({ usdcAmount: 1_000_000n, conf: 2n });
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]), "TradeLimitExceeded", "2 confirmations rejected"); }

console.log("\n[3] Normal settlement with a CSD proof still works");
{ const a = await makeAuth({ usdcAmount: 25_000_000n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  const s0 = await bal(seller.address), e0 = await bal(executor.address);
  const proof = payAndConfirm({ value: a.auth.csdAmount, time: await now() + 60, extra: 2 });
  await call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, proof]);
  check(await bal(seller.address) - s0 === 25_000_000n, "seller received 25 USDC after 3 confirmations");
  check(await bal(executor.address) - e0 === 50_000n, "executor received its fee");
  check(await read(settlement, S, "finalizedAuthorization", [a.hash]) === true, "authorization finalized"); }

console.log("\n[4] A CSD payment from before the lock doesn't count");
{ const a = await makeAuth({ usdcAmount: 10_000_000n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  const before = tip;
  const old = payAndConfirm({ value: a.auth.csdAmount, time: await now() - 31 * 60, extra: 2 });
  await reverts(call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, old]), "CsdPaymentBeforeLock", "payment 31 minutes before the lock rejected");
  tip = before; // that branch was never submitted
  const ok = payAndConfirm({ value: a.auth.csdAmount, time: await now() - 20 * 60, extra: 2 });
  await call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, ok]);
  check(await read(settlement, S, "finalizedAuthorization", [a.hash]) === true, "payment within the 30-minute timestamp slack accepted"); }

console.log("\n[5] Early release: the buyer waives the wait");
{ const a = await makeAuth({ usdcAmount: 30_000_000n });
  const releaseFor = (h, who = buyer) => who.signTypedData({ domain, types: RELEASE_TYPES, primaryType: "CsdUsdcEarlyRelease", message: { authHash: h } });
  await reverts(call(executor, settlement, S, "releaseEarly", [a.auth, await releaseFor(a.hash)]), "AuthorizationNotLocked", "nothing to release before the lock");
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  await reverts(call(executor, settlement, S, "releaseEarly", [a.auth, await releaseFor(a.hash, seller)]), "BadSignature", "the seller can't release it");
  await reverts(call(executor, settlement, S, "releaseEarly", [a.auth, await releaseFor(a.hash, executor)]), "BadSignature", "the executor can't release it");
  const other = await makeAuth({ usdcAmount: 30_000_000n });
  await reverts(call(executor, settlement, S, "releaseEarly", [a.auth, await releaseFor(other.hash)]), "BadSignature", "a release signed for another trade doesn't work");
  const s0 = await bal(seller.address), e0 = await bal(executor.address), c0 = await bal(settlement);
  await call(executor, settlement, S, "releaseEarly", [a.auth, await releaseFor(a.hash)]);
  check(await bal(seller.address) - s0 === 30_000_000n, "seller received 30 USDC immediately, no CSD proof");
  check(await bal(executor.address) - e0 === 50_000n, "executor received its fee");
  check(c0 - await bal(settlement) === 30_050_000n, "contract paid out exactly the locked amount");
  await reverts(call(executor, settlement, S, "releaseEarly", [a.auth, await releaseFor(a.hash)]), "AuthorizationAlreadyFinalized", "can't be released twice");
  const before = tip;
  const proof = payAndConfirm({ value: a.auth.csdAmount, time: await now() + 60, extra: 2 });
  await reverts(call(executor, settlement, S, "settleCsdUsdc", [a.auth, a.sig, proof]), "AuthorizationAlreadyFinalized", "can't also be settled with a proof");
  tip = before;
  await rpc("evm_increaseTime", [3600]); await rpc("evm_mine");
  await reverts(call(executor, settlement, S, "refundExpiredLock", [a.auth]), "AuthorizationAlreadyFinalized", "can't be refunded afterwards");
  await reverts(call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]), "AuthorizationAlreadyFinalized", "can't be locked again"); }

console.log("\n[6] Release after the window, and the refund path");
{ const a = await makeAuth({ usdcAmount: 5_000_000n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [a.auth, a.sig]);
  await rpc("evm_increaseTime", [26 * 60]); await rpc("evm_mine");
  const s0 = await bal(seller.address);
  await call(executor, settlement, S, "releaseEarly", [a.auth, await buyer.signTypedData({ domain, types: RELEASE_TYPES, primaryType: "CsdUsdcEarlyRelease", message: { authHash: a.hash } })]);
  check(await bal(seller.address) - s0 === 5_000_000n, "buyer can still release after the window, before anyone refunds");
  const b = await makeAuth({ usdcAmount: 5_000_000n });
  await call(executor, settlement, S, "lockCsdUsdcAuthorization", [b.auth, b.sig]);
  await reverts(call(executor, settlement, S, "refundExpiredLock", [b.auth]), "AuthorizationLocked", "no refund inside the window");
  await rpc("evm_increaseTime", [26 * 60]); await rpc("evm_mine");
  const b0 = await bal(buyer.address);
  await call(executor, settlement, S, "refundExpiredLock", [b.auth]);
  check(await bal(buyer.address) - b0 === 5_050_000n, "refund returns USDC plus the unused fee to the buyer");
  await reverts(call(executor, settlement, S, "releaseEarly", [b.auth, await buyer.signTypedData({ domain, types: RELEASE_TYPES, primaryType: "CsdUsdcEarlyRelease", message: { authHash: b.hash } })]), "AuthorizationNotLocked", "nothing to release after a refund"); }

console.log("\n[7] Namespace objects and the executor");
{ const ns = await import("../src/index.ts");
  const { buildCsdUsdcAuthorizationObject, buildCsdUsdcEarlyReleaseObject, csdUsdcNamespace, EARLY_RELEASE_TYPES, csdUsdcAuthHash, releaseMatchesAuthorization, releaseEarlyOnEvm, lockCsdUsdcOnEvm } = ns;
  Object.assign(process.env, { AON_SETTLEMENT_CONTRACT: settlement, AON_EVM_RPC_URL: RPC, AON_EXECUTOR_PRIVATE_KEY: K[2] });
  const a = await makeAuth({ usdcAmount: 20_000_000n });
  const authObj = await buildCsdUsdcAuthorizationObject({ authorization: a.auth, signature: a.sig, domain, types: AUTH_TYPES });
  check(csdUsdcAuthHash(authObj) === a.hash, "csdUsdcAuthHash matches the contract's authorization hash");
  const relSig = await buyer.signTypedData({ domain, types: EARLY_RELEASE_TYPES, primaryType: "CsdUsdcEarlyRelease", message: { authHash: a.hash } });
  const rel = await buildCsdUsdcEarlyReleaseObject({ authorization: authObj, signature: relSig });
  await csdUsdcNamespace.validateObject(rel);
  check(rel.objectType === "release" && rel.references[0] === authObj.objectHash, "release object references its authorization and validates");
  check(releaseMatchesAuthorization(rel, authObj), "releaseMatchesAuthorization: true for its own authorization");
  const o = await makeAuth({ usdcAmount: 20_000_000n });
  const other = await buildCsdUsdcAuthorizationObject({ authorization: o.auth, signature: o.sig, domain, types: AUTH_TYPES });
  check(!releaseMatchesAuthorization(rel, other), "releaseMatchesAuthorization: false for another authorization");
  const sellerSig = await seller.signTypedData({ domain, types: EARLY_RELEASE_TYPES, primaryType: "CsdUsdcEarlyRelease", message: { authHash: a.hash } });
  await reverts(buildCsdUsdcEarlyReleaseObject({ authorization: authObj, signature: sellerSig }), "BAD_EARLY_RELEASE_SIGNATURE", "builder refuses a release not signed by the buyer");
  const forged = JSON.parse(JSON.stringify(rel)); forged.payload.signature.signature = sellerSig;
  await reverts(csdUsdcNamespace.validateObject(forged), "RELEASE_SIGNATURE_INVALID", "validator rejects a release with the wrong signature");
  await lockCsdUsdcOnEvm({ authorization: authObj });
  const s0 = await bal(seller.address);
  const r = await releaseEarlyOnEvm({ authorization: authObj, release: rel });
  check(r.executed && await bal(seller.address) - s0 === 20_000_000n, "releaseEarlyOnEvm pays the seller immediately"); }

console.log(`\nAll ${pass} checks passed.`);
