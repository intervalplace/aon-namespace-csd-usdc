// End to end: the market maker against the real settlement contract (anvil),
// a stand-in CSD node, and a user with the in-site wallet (no ETH at all).
import { readFileSync, rmSync } from "fs";
import { createPublicClient, createWalletClient, http, defineChain, hashTypedData, keccak256, toHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { startFakeCsdNode } from "./fake-csd-node.mjs";
import { deriveCsdWallet, csdNode, buildPayment, csdAddressProof, addr20ToBytes32, bitsToTarget, txToNodeJson, CSD_WALLET_MESSAGE } from "../src/csd-wallet.ts";
import { startMarketMaker } from "../src/market-maker.ts";
import { quoteBuy, quoteSell, midPrice } from "../src/pool.ts";
import { csdUsdcNamespace } from "../src/namespace.ts";

const RPC = `http://127.0.0.1:${process.env.ANVIL_PORT ?? "8546"}`;
const art = JSON.parse(readFileSync(new URL("./artifacts.json", import.meta.url), "utf8"));
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http() });
const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const MM_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // anvil #5
const wc = (a) => createWalletClient({ account: a, chain, transport: http() });
const deploy = async (n, args = []) => (await pub.waitForTransactionReceipt({ hash: await wc(deployer).deployContract({ abi: art[n].abi, bytecode: art[n].bytecode, args }) })).contractAddress;
const send = async (a, address, n, fn, args) => pub.waitForTransactionReceipt({ hash: await wc(a).writeContract({ address, abi: art[n].abi, functionName: fn, args }) });
const read = (address, n, fn, args = []) => pub.readContract({ address, abi: art[n].abi, functionName: fn, args });
const rpc = (method, params = []) => pub.request({ method, params });
let pass = 0;
const check = (c, l) => { if (!c) { console.error("  FAIL:", l); process.exit(1); } pass++; console.log("  ok -", l); };

// ── setup ────────────────────────────────────────────────────────────────────
const BITS = 0x207fffff;
const usdc = await deploy("MockUSDC");
const GENESIS = keccak256(toHex("csd-test-genesis"));
const settlement = await deploy("TestCsdUsdcSettlement", [usdc, 300_000_000n, GENESIS]);
let evmNow = Number((await pub.getBlock()).timestamp);
const csd = await startFakeCsdNode({ port: 18991, bits: BITS, clock: () => evmNow });
const syncClock = async () => { evmNow = Number((await pub.getBlock()).timestamp); };
const mine = async (n = 1) => { await syncClock(); for (let i = 0; i < n; i++) csd.mine(); };

const MM_SEED = "0x" + "5e".repeat(32);
const mmInventory = deriveCsdWallet(MM_SEED).key(0);
csd.mine({ rewardTo: mmInventory.addr20, reward: 1000n * 100_000_000n });
const mmEvm = privateKeyToAccount(MM_KEY);
await send(deployer, usdc, "MockUSDC", "mint", [mmEvm.address, 150_000_000n]);

// The user: an Ethereum wallet with USDC and no ETH; CSD keys from its signature
const user = privateKeyToAccount(generatePrivateKey());
await send(deployer, usdc, "MockUSDC", "mint", [user.address, 100_000_000n]);
const userCsd = deriveCsdWallet(await user.signMessage({ message: CSD_WALLET_MESSAGE }));
const uKey = userCsd.key(0);
csd.mine({ rewardTo: uKey.addr20, reward: 300n * 100_000_000n }); // CSD the user already had

const STATE = "/tmp/claude-0/mm-test-state.json"; rmSync(STATE, { force: true });
const logs = [];
const mmCfg = { rpcUrl: RPC, chainId: 31337, privateKey: MM_KEY, settlement, usdc, csdApi: csd.url, csdGenesis: GENESIS, csdSeed: MM_SEED,
  stateFile: STATE, port: 18990, allowedOrigins: ["https://covenant.market"], initialPool: { usdc: 150_000_000n, csd: 1000n * 100_000_000n },
  maxUnconfirmedUsdc: 10_000_000n, pollMs: 60_000, rebroadcastSecs: 1, log: (...a) => logs.push(a.join(" ")) };
let mm = await startMarketMaker(mmCfg);
const API = "http://127.0.0.1:18990/api";
const get = async (p) => { const r = await fetch(API + p); return { ...(await r.json()), http: r.status }; };
const post = async (p, b) => { const r = await fetch(API + p, { method: "POST", headers: { "content-type": "application/json", origin: "https://covenant.market" }, body: JSON.stringify(b, (_, v) => typeof v === "bigint" ? String(v) : v) }); return { ...(await r.json()), http: r.status }; };
const domain = { name: "AON CSD/USDC", version: "4", chainId: 31337, verifyingContract: settlement };
const AUTH_TYPES = csdUsdcNamespace.types();
const bal = (a) => read(usdc, "MockUSDC", "balanceOf", [a]);
const userNode = csdNode(`${API}/csd`.replace("/api/csd", "/api/csd")); // the in-site wallet goes through the market maker's proxy

console.log("\n[1] Market data: pool at 150 USDC + 1000 CSD is 0.15 USDC per CSD");
await mm.tick(); await mine(); await mm.tick(); // splits the inventory into coins
{ const m = await get("/market");
  check(m.mid === "150000", "mid price 0.150000 USDC per CSD");
  check(BigInt(m.bestAsk) > 150000n && BigInt(m.bestBid) < 150000n, `best ask ${Number(m.bestAsk) / 1e6}, best bid ${Number(m.bestBid) / 1e6} (3% spread around the pool price)`);
  check(m.asks.length === 8 && m.bids.length === 8 && BigInt(m.asks[1].price) > BigInt(m.asks[0].price) && BigInt(m.bids[1].price) < BigInt(m.bids[0].price), "order book: 8 levels each side, prices worsen with depth");
  const u = (await (await fetch(`${csd.url}/utxos/${mmInventory.addr20.slice(2)}`)).json()).utxos;
  check(u.length === 20, "the bot keeps its CSD in 20 coins so trades don't wait on change");
  const r = await fetch(API + "/market", { headers: { origin: "https://covenant.market" } });
  check(r.headers.get("access-control-allow-origin") === "https://covenant.market", "CORS for covenant.market");
  const r2 = await fetch(API + "/market", { headers: { origin: "https://evil.example" } });
  check(!r2.headers.get("access-control-allow-origin"), "no CORS for other sites"); }

// A buy as the site would build it: authorization + permit + CSD address proof, all gasless
async function signBuy({ csdAmount, usdcAmount, conf = 3, maxTarget = bitsToTarget(BITS), fee = 250_000n, key = uKey, proofKey = key }) {
  const t = Number((await pub.getBlock()).timestamp);
  const auth = { buyer: user.address, sellerUsdcRecipient: mmEvm.address, sellerCsdScriptHash: addr20ToBytes32(key.addr20), csdGenesisHash: GENESIS,
    tradeIntentHash: keccak256(toHex("covenant")), csdAmount, usdc, usdcAmount, minConfirmations: BigInt(conf), csdMaxTarget: maxTarget,
    executorFeeAmount: fee, validAfter: BigInt(t - 60), validBefore: BigInt(t + 3 * 3600), nonce: keccak256(toHex(Math.random().toString())) };
  const signature = await user.signTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: auth });
  const hash = hashTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: auth });
  const nonce = await read(usdc, "MockUSDC", "nonces", [user.address]);
  const ps = await user.signTypedData({ domain: { name: "USD Coin", version: "2", chainId: 31337, verifyingContract: usdc },
    types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Permit", message: { owner: user.address, spender: settlement, value: usdcAmount + fee, nonce, deadline: BigInt(t + 3600) } });
  return { hash, body: { authorization: auth, signature, addressProof: csdAddressProof(proofKey, hash), permit: { deadline: BigInt(t + 3600), r: ps.slice(0, 66), s: "0x" + ps.slice(66, 130), v: parseInt(ps.slice(130, 132), 16) } } };
}
const pool = () => { const s = mm.state().pool; return { usdc: BigInt(s.usdc), csd: BigInt(s.csd), spreadBps: 300n }; };

console.log("\n[2] User buys 50 CSD: CSD sent at once, no ETH needed, the bot is paid after the proof");
{ const csdAmount = 50n * 100_000_000n, price = quoteBuy(pool(), csdAmount);
  const tooCheap = await signBuy({ csdAmount, usdcAmount: price * 98n / 100n });
  check((await post("/buy", tooCheap.body)).http === 409, "a price 2% under the pool's is refused (PRICE_MOVED)");
  const tooHard = await signBuy({ csdAmount, usdcAmount: price, maxTarget: bitsToTarget(BITS) / 2n });
  check((await post("/buy", tooHard.body)).error === "CSD_MAX_TARGET_TOO_HARD", "a difficulty the real chain can't meet is refused (the bot could never prove its payment)");
  const notMine = await signBuy({ csdAmount, usdcAmount: price, key: deriveCsdWallet("0x" + "99".repeat(65)).key(0), proofKey: uKey });
  check(String((await post("/buy", notMine.body)).error).includes("LOCK_REJECTED"), "a CSD address the user can't prove is refused by the contract");
  const big = await signBuy({ csdAmount: 300n * 100_000_000n, usdcAmount: quoteBuy(pool(), 300n * 100_000_000n) });
  check((await post("/buy", big.body)).error === "TRADE_SIZE", "over 30 USDC is refused");
  const u0 = await bal(user.address), m0 = await bal(mmEvm.address);
  const b = await signBuy({ csdAmount, usdcAmount: price });
  const t0 = Date.now(); const r = await post("/buy", b.body);
  check(r.http === 200 && r.lockTx && r.csdTxid && r.authHash === b.hash, `accepted in ${Date.now() - t0} ms: lock ${r.lockTx.slice(0, 10)}…, CSD payment ${r.csdTxid.slice(0, 10)}…`);
  check(csd.mempool.has(r.csdTxid), "the CSD payment is already broadcast (the site can show it as incoming right away)");
  check((await post("/buy", b.body)).csdTxid === r.csdTxid, "resubmitting the same buy is harmless (same trade back)");
  check(await bal(user.address) === u0 - price - 250_000n && await pub.getBalance({ address: user.address }) === 0n, `user's ${Number(price + 250_000n) / 1e6} USDC locked by permit; user has no ETH`);
  check(await read(settlement, "TestCsdUsdcSettlement", "usdcLocked", [b.hash]), "USDC is locked in the contract, not paid to the bot");
  await mine();
  const uu = await userNode.utxos(uKey);
  check(uu.some(c => c.value === csdAmount), "after one CSD block the user's wallet holds 50 CSD");
  await mm.tick();
  check(mm.state().trades[b.hash].status === "locked", "not settled yet: the user asked for 3 confirmations");
  await mine(2); await mm.tick(); await mm.tick();
  check(mm.state().trades[b.hash].status === "settled" && await bal(mmEvm.address) === m0 + price + 250_000n, "after 3 confirmations the bot proves its payment and receives the USDC plus fee");
  check(midPrice(pool()) > 150000n, `buying moved the price up to ${Number(midPrice(pool())) / 1e6}`); }

console.log("\n[3] User sells 40 CSD: USDC released before any CSD block");
let sold;
{ const csdAmount = 40n * 100_000_000n, quote = quoteSell(pool(), csdAmount) - 250_000n;
  const o = await post("/sell/open", { csdAmount, usdcRecipient: user.address, minUsdcOut: quote });
  check(o.http === 200 && o.lockTx && o.csdAddress, "bot opens the trade: locks its USDC against a fresh CSD address");
  // The site checks the lock itself, on-chain, before paying
  const h = hashTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: Object.fromEntries(Object.entries(o.authorization).map(([k, v]) => [k, /^\d+$/.test(v) ? BigInt(v) : v])) });
  check(h === o.authHash && await read(settlement, "TestCsdUsdcSettlement", "usdcLocked", [h]), "the site recomputes the trade hash and sees the USDC locked on-chain");
  check(o.authorization.sellerUsdcRecipient === user.address && BigInt(o.authorization.usdcAmount) === quote && BigInt(o.authorization.csdAmount) === csdAmount, "the lock pays the user the quoted amount for exactly 40 CSD");
  await new Promise(r => setTimeout(r, 300)); // lock receipt
  const pay = buildPayment({ utxos: await userNode.utxos(uKey), to: [{ value: csdAmount, addr20: o.csdAddress }], change: uKey.addr20 });
  const short = buildPayment({ utxos: await userNode.utxos(uKey), to: [{ value: csdAmount - 1n, addr20: o.csdAddress }], change: uKey.addr20 });
  check((await post("/sell/pay", { authHash: o.authHash, tx: txToNodeJson(short.tx) })).error === "CSD_PAYMENT_TOO_SMALL", "a payment 1 unit short is refused");
  const u0 = await bal(user.address), height0 = csd.blocks.length;
  const t0 = Date.now(); const r = await post("/sell/pay", { authHash: o.authHash, tx: txToNodeJson(pay.tx) });
  check(r.http === 200 && r.status === "released" && r.releaseTx && r.instant, `released in ${Date.now() - t0} ms without waiting for CSD`);
  await pub.waitForTransactionReceipt({ hash: r.releaseTx });
  check(await bal(user.address) === u0 + quote && csd.blocks.length === height0, `user received ${Number(quote) / 1e6} USDC with no CSD block mined`);
  check(csd.mempool.has(r.csdTxid), "the user's CSD payment is broadcast by the bot");
  await mine(3); await mm.tick();
  check(mm.state().trades[o.authHash].status === "done", "after 3 CSD confirmations the bot stops counting it as risk");
  sold = o; }

console.log("\n[4] Over the instant limit, the bot waits one CSD block");
{ const mk = async (n) => { const csdAmount = BigInt(n) * 100_000_000n; return post("/sell/open", { csdAmount, usdcRecipient: user.address, minUsdcOut: 0 }); };
  const a = await mk(40), b = await mk(40);
  await new Promise(r => setTimeout(r, 300));
  const coins = await userNode.utxos(uKey);
  const p1 = buildPayment({ utxos: coins, to: [{ value: 40n * 100_000_000n, addr20: a.csdAddress }, { value: 40n * 100_000_000n, addr20: b.csdAddress }], change: uKey.addr20 });
  const ra = await post("/sell/pay", { authHash: a.authHash, tx: txToNodeJson(p1.tx) });
  check(ra.instant, `first ~${Number(a.usdcAmount) / 1e6} USDC: instant (limit 10 USDC in flight)`);
  const rb = await post("/sell/pay", { authHash: b.authHash, tx: txToNodeJson(p1.tx) });
  check(rb.http === 200 && !rb.instant && rb.status === "paid", "second one would pass the limit: accepted, released after one block");
  await mine(); await mm.tick();
  check(mm.state().trades[b.authHash].status === "released", "released once the payment has a block"); }

console.log("\n[5] A sell nobody pays for is refunded and the pool restored");
{ const p0 = pool(); const m0 = await bal(mmEvm.address);
  const o = await post("/sell/open", { csdAmount: 10n * 100_000_000n, usdcRecipient: user.address, minUsdcOut: 0 });
  await new Promise(r => setTimeout(r, 300)); await mm.tick();
  check(pool().csd > p0.csd, "the pool reserves the trade while it's open");
  await rpc("evm_increaseTime", [30 * 60]); await rpc("evm_mine"); await mm.tick(); await mm.tick();
  check(mm.state().trades[o.authHash].status === "expired", "expired and refunded");
  check(pool().usdc === p0.usdc && pool().csd === p0.csd && await bal(mmEvm.address) === m0, "pool and USDC back to where they were"); }

console.log("\n[6] A double-spent instant sale is detected and recorded as a loss");
{ await mine(3); await mm.tick(); // earlier instant sales confirm, freeing the instant allowance
  const csdAmount = 10n * 100_000_000n;
  const o = await post("/sell/open", { csdAmount, usdcRecipient: user.address, minUsdcOut: 0 });
  await new Promise(r => setTimeout(r, 300));
  const coins = await userNode.utxos(uKey);
  const honest = buildPayment({ utxos: coins, to: [{ value: csdAmount, addr20: o.csdAddress }], change: uKey.addr20 });
  const r = await post("/sell/pay", { authHash: o.authHash, tx: txToNodeJson(honest.tx) });
  check(r.instant, "released instantly");
  const cheat = buildPayment({ utxos: coins, to: [{ value: csdAmount, addr20: uKey.addr20 }], change: uKey.addr20, fee: 20_000n });
  await syncClock(); csd.doubleSpend(cheat.tx); // the cheater gets a conflicting spend mined first
  await mine(2); await new Promise(r => setTimeout(r, 3100)); await mm.tick();
  if (mm.state().trades[o.authHash].status !== "reversed") console.log(mm.state().trades[o.authHash], logs.slice(-5));
  check(mm.state().trades[o.authHash].status === "reversed" && BigInt(mm.state().lossUsdc) === BigInt(o.usdcAmount), `bot records the ${Number(o.usdcAmount) / 1e6} USDC loss (capped by the instant limit)`); }

console.log("\n[7] Restart: state survives, CSD proxy works for the in-site wallet");
{ const before = JSON.stringify(mm.state()); await mm.stop();
  mm = await startMarketMaker(mmCfg);
  check(JSON.stringify(mm.state()) === before, "trades and pool reload from the state file");
  const tip = await get("/csd/tip");
  check(tip.height === csd.blocks.length - 1, "GET /api/csd/tip proxied");
  check((await get("/csd/utxos/" + uKey.addr20.slice(2))).utxos.length >= 1, "GET /api/csd/utxos proxied");
  check((await get("/csd/utxos/..%2Fmempool")).http === 404, "proxy only takes well-formed addresses");
  const coins = await userNode.utxos(uKey);
  const send = buildPayment({ utxos: coins, to: [{ value: 100_000_000n, addr20: "0x" + "ab".repeat(20) }], change: uKey.addr20 });
  check((await userNode.submit(send.tx)) === send.txid, "the in-site wallet sends CSD through the proxy"); }

await mm.stop(); await csd.close();
if (logs.some(l => l.includes("INTERNAL"))) console.log(logs.join("\n"));
console.log(`\nAll ${pass} market-maker checks passed.`);
