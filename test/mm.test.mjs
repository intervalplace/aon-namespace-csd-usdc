// End to end: the market maker against the real settlement contract (anvil),
// a stand-in CSD node, and a user with the in-site wallet (no ETH at all).
import { readFileSync, rmSync } from "fs";
import { createPublicClient, createWalletClient, http, defineChain, hashTypedData, keccak256, toHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { startFakeCsdNode } from "./fake-csd-node.mjs";
import { startFakeAonNode } from "./fake-aon-node.mjs";
import { buyAuthorizationObject, saleRequestObject, salePaymentObject, aonApi, objectSigner } from "../src/aon-client.ts";
import { deriveCsdWallet, csdNode, buildPayment, csdAddressProof, addr20ToBytes32, bitsToTarget, txToNodeJson, CSD_WALLET_MESSAGE, csdSaleRequestDigest, csdSignDigest, incomingPaymentLooksReal } from "../src/csd-wallet.ts";
import { startMarketMaker } from "../src/market-maker.ts";
import { quoteBuy, quoteSell, midPrice } from "../src/pool.ts";
import { csdUsdcNamespace } from "../src/namespace.ts";
import { hashObject, finalizeObject } from "@intervalplace/aon-sdk";
import { recoverMessageAddress } from "viem";
const obj = (h) => published.find(o => o.objectHash?.toLowerCase() === h?.toLowerCase());

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
for (let i = 0; i < 4; i++) csd.mine({ rewardTo: uKey.addr20, reward: 150n * 100_000_000n }); // CSD the user already had, in a few coins

const STATE = "/tmp/claude-0/mm-test-state.json"; rmSync(STATE, { force: true });
const logs = [];
const aonNode = await startFakeAonNode({ port: 18993 }), A = aonApi(aonNode.url);
const published = { find: (f) => [...aonNode.objects.values()].find(f) };
const mmCfg = { rpcUrl: RPC, privateTxRpc: RPC, chainId: 31337, privateKey: MM_KEY, settlement, usdc, csdApi: csd.url, csdGenesis: GENESIS, csdSeed: MM_SEED,
  stateFile: STATE, port: 18990, allowedOrigins: ["https://covenant.market"], initialPool: { usdc: 150_000_000n, csd: 1000n * 100_000_000n },
  maxUnconfirmedUsdc: 10_000_000n, maxLossUsdc: 1_000_000n, sellPayWindowSecs: 8, trustProxy: true,
  pollMs: 60_000, watchMs: 600_000, rebroadcastSecs: 1, declinedCheckMs: 0, newBuysPerMinute: 1000, log: (...a) => logs.push(a.join(" ")), aonNodeUrl: aonNode.url };
let mm = await startMarketMaker(mmCfg);
const API = "http://127.0.0.1:18990/api";
const get = async (p) => { const r = await fetch(API + p); return { ...(await r.json()), http: r.status }; };
// Trading goes over AON: publish an object, let the market maker look, read its signed response
let useHints = false;
const offers = async () => { const m = useHints ? await get("/market") : null; return A.offers([privateKeyToAccount(MM_KEY).address], m ? [m.offers.sell, m.offers.buy] : []); };
let noAnswerMs = 15_000;
const answer = async (o) => { await A.put(o); await mm.watch(); const r = await A.response(o.objectHash, privateKeyToAccount(MM_KEY).address, noAnswerMs); return { ...r, http: r.accepted ? 200 : r.code, objectHash: o.objectHash }; };
// The seller's payment as the site publishes it (with the maker's signed authorization)
const payObject = (authHash, tx) => { const t = mm.state().trades[authHash];
  return salePaymentObject({ authorizationObjectHash: t?.aon?.auth, authHash, authorization: t?.auth ?? {}, authorizationSignature: t?.authSig ?? "0x", csdTxid: "0x", csdTx: tx }); };
async function post(p, b) {
  if (p === "/buy") {
    const off = (await offers()).sell;
    return answer(buyAuthorizationObject({ offerHash: off.objectHash, authorization: b.authorization, signature: b.signature, domain, types: AUTH_TYPES, addressProof: b.addressProof, permit: b.permit }));
  }
  if (p === "/sell/open") {
    const off = (await offers()).buy;
    return answer(saleRequestObject({ offerHash: off.objectHash, csdAmount: BigInt(b.csdAmount), usdcRecipient: b.usdcRecipient, minUsdcOut: BigInt(b.minUsdcOut ?? 0), validUntil: b.validUntil, coins: b.coins, proofs: b.proofs, owners: b.owners ?? [] }));
  }
  if (p === "/sell/pay") {
    const authObj = mm.state().trades[b.authHash]?.aon?.auth;
    return answer(payObject(b.authHash, b.tx));
  }
  throw new Error(p);
}
const domain = { name: "AON CSD/USDC", version: "4", chainId: 31337, verifyingContract: settlement };
const AUTH_TYPES = csdUsdcNamespace.types();
const bal = (a) => read(usdc, "MockUSDC", "balanceOf", [a]);
const until = async (f, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
const tr = (h) => mm.state().trades[h];
const authArgs = (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, /^\d+$/.test(v) ? BigInt(v) : v]));
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
  check(!r2.headers.get("access-control-allow-origin"), "no CORS for other sites");
  const off = await offers(); useHints = true;
  check(off.sell && off.buy && await objectSigner(off.sell) === mmEvm.address && off.sell.payload.poolUsdc === "150000000" && off.sell.payload.poolCsd === "100000000000",
    "the market maker's offers are on AON, signed, with its pool (the site draws the book from them)");
  // Anyone can bury the real offers in a listing under junk dated in the future
  for (let i = 0; i < 45; i++) await A.put(finalizeObject({ objectType: "offer", schemaVersion: "1", namespace: "aon:csd-usdc", createdAt: Date.now() + 86400_000 + i, references: [],
    payload: { offerType: "csd_usdc_sell_csd", marketMaker: mmEvm.address, validBefore: 9e9, n: i } }));
  check(!(await A.offers([mmEvm.address])).sell, "45 junk offers push the real ones out of a plain listing");
  const hinted = await A.offers([mmEvm.address], [m.offers.sell, m.offers.buy]);
  check(hinted.sell?.objectHash === off.sell.objectHash && hinted.buy?.objectHash === off.buy.objectHash, "but the market maker names its current offers, and those are fetched and checked by hash"); }

// A buy as the site would build it: authorization + permit + CSD address proof, all gasless
async function signBuy({ csdAmount, usdcAmount, conf = 10, maxTarget = bitsToTarget(BITS), fee = 250_000n, key = uKey, proofKey = key }) {
  const t = Number((await pub.getBlock()).timestamp);
  const auth = { buyer: user.address, sellerUsdcRecipient: mmEvm.address, sellerCsdScriptHash: addr20ToBytes32(key.addr20), csdGenesisHash: GENESIS,
    tradeIntentHash: (await get("/market")).offers?.sell ?? keccak256(toHex("covenant")), csdAmount, usdc, usdcAmount, minConfirmations: BigInt(conf), csdMaxTarget: maxTarget,
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

console.log("\n[2] User buys 50 CSD: CSD sent once the USDC is locked, no ETH needed, the bot is paid after the proof");
{ const csdAmount = 50n * 100_000_000n, price = quoteBuy(pool(), csdAmount);
  const tooCheap = await signBuy({ csdAmount, usdcAmount: price * 98n / 100n });
  check((await post("/buy", tooCheap.body)).http === 409, "a price 2% under the pool's is refused (PRICE_MOVED)");
  const shallow = await signBuy({ csdAmount, usdcAmount: price, conf: 3 });
  check((await post("/buy", shallow.body)).error === "CONFIRMATIONS_OUT_OF_RANGE", "fewer than 10 confirmations is refused (cheap to fake)");
  const tooHard = await signBuy({ csdAmount, usdcAmount: price, maxTarget: bitsToTarget(BITS) / 2n });
  check((await post("/buy", tooHard.body)).error === "CSD_MAX_TARGET_TOO_HARD", "a difficulty the real chain can't meet is refused (the bot could never prove its payment)");
  const notMine = await signBuy({ csdAmount, usdcAmount: price, key: deriveCsdWallet("0x" + "99".repeat(65)).key(0), proofKey: uKey });
  check(String((await post("/buy", notMine.body)).error).includes("LOCK_REJECTED"), "a CSD address the user can't prove is refused by the contract");
  const big = await signBuy({ csdAmount: 300n * 100_000_000n, usdcAmount: quoteBuy(pool(), 300n * 100_000_000n) });
  check((await post("/buy", big.body)).error === "TRADE_SIZE", "over 30 USDC is refused");
  const u0 = await bal(user.address), m0 = await bal(mmEvm.address);
  const b = await signBuy({ csdAmount, usdcAmount: price });
  const t0 = Date.now(); const r = await post("/buy", b.body);
  check(r.http === 200 && r.lockTx && r.authHash === b.hash, `accepted in ${Date.now() - t0} ms: lock ${r.lockTx.slice(0, 10)}…`);
  check(await until(() => tr(b.hash).csdTxid && csd.mempool.has(tr(b.hash).csdTxid)), `once the lock is mined the CSD is broadcast (${Date.now() - t0} ms in all)`);
  check((await post("/buy", b.body)).csdTxid === tr(b.hash).csdTxid, "resubmitting the same buy is harmless (same trade back)");
  check(await bal(user.address) === u0 - price - 250_000n && await pub.getBalance({ address: user.address }) === 0n, `user's ${Number(price + 250_000n) / 1e6} USDC locked by permit; user has no ETH`);
  check(await read(settlement, "TestCsdUsdcSettlement", "usdcLocked", [b.hash]), "USDC is locked in the contract, not paid to the bot");
  await mine();
  const uu = await userNode.utxos(uKey);
  check(uu.some(c => c.value === csdAmount), "after one CSD block the user's wallet holds 50 CSD");
  await mm.tick();
  check(tr(b.hash).status === "locked", "not settled yet: the user asked for 10 confirmations");
  await mine(9); await mm.tick(); await mm.tick();
  check(tr(b.hash).status === "settled" && await bal(mmEvm.address) === m0 + price + 250_000n, "after 10 confirmations the bot proves its payment and receives the USDC plus fee");
  check(midPrice(pool()) > 150000n, `buying moved the price up to ${Number(midPrice(pool())) / 1e6}`);
  await mm.tick();
  const g = tr(b.hash).aon ?? {}, offer = obj(g.offer), auth = obj(g.auth), proof = obj(g.proof), receipt = obj(g.receipt);
  check(offer && auth && proof && receipt, "AON: offer, authorization, proof and receipt all published");
  const { signature: osig, objectHash: _h, ...unsignedOffer } = offer;
  check(offer.objectType === "offer" && await recoverMessageAddress({ message: { raw: hashObject(unsignedOffer) }, signature: osig.signature }) === mmEvm.address, "the offer is signed by the market maker");
  check(auth.references.includes(offer.objectHash.toLowerCase()) && auth.signature.signer === user.address, "the buyer's authorization (signed by the buyer) references the offer");
  check(proof.references.includes(auth.objectHash.toLowerCase()) && proof.payload.txid === tr(b.hash).csdTxid, "the CSD payment proof references the authorization");
  check(receipt.objectType === "receipt" && receipt.references.includes(auth.objectHash.toLowerCase()) && receipt.references.includes(proof.objectHash.toLowerCase())
    && receipt.payload.executionTx === tr(b.hash).settleTx, "the receipt references both and names the settlement transaction");
  check(await objectSigner(receipt) === mmEvm.address && (await A.receipt(auth.objectHash, b.hash, [mmEvm.address]))?.objectHash === receipt.objectHash, "the receipt is signed by the market maker");
  await A.put(finalizeObject({ objectType: "receipt", schemaVersion: "1", namespace: "aon:csd-usdc", createdAt: Date.now() - 1, references: [auth.objectHash.toLowerCase()], payload: { authHash: b.hash, executionTx: "0x" + "66".repeat(32) } }));
  check((await A.receipt(auth.objectHash, b.hash, [mmEvm.address]))?.objectHash === receipt.objectHash, "a fake unsigned receipt is ignored");
  check((await get(`/trade/${b.hash}`)).aon.receipt === receipt.objectHash, "the site can look up the receipt"); }

console.log("\n[2b] Racing the bot's lock: CSD is only sent if the USDC really is locked");
{ await rpc("anvil_setBalance", [user.address, "0xde0b6b3a7640000"]); // the attacker has ETH for front-running
  const csdAmount = 20n * 100_000_000n;
  // Someone copies the bot's lock and gets it mined first: the bot's own transaction reverts, the trade is still locked
  await rpc("evm_setAutomine", [false]);
  const a = await signBuy({ csdAmount, usdcAmount: quoteBuy(pool(), csdAmount) });
  const ra = await post("/buy", a.body);
  const a2 = await signBuy({ csdAmount, usdcAmount: quoteBuy(pool(), csdAmount), key: userCsd.key(7) });
  check((await post("/buy", a2.body)).error === "FINISH_YOUR_OTHER_BUY", "a second buy from the same wallet waits until the first is locked");
  const B = a.body, P = B.permit;
  await wc(deployer).writeContract({ address: settlement, abi: art.TestCsdUsdcSettlement.abi, functionName: "lockCsdUsdcAuthorizationWithPermit",
    args: [B.authorization, B.signature, B.addressProof, { deadline: P.deadline, v: P.v, r: P.r, s: P.s }], gas: 1_000_000n, maxPriorityFeePerGas: 50_000_000_000n, maxFeePerGas: 100_000_000_000n });
  await rpc("evm_mine"); await rpc("evm_setAutomine", [true]);
  check((await pub.getTransactionReceipt({ hash: ra.lockTx })).status === "reverted", "the copy was mined first and the bot's lock reverted");
  check(await until(() => tr(a.hash).status === "locked" && tr(a.hash).csdTxid), "the bot sees the trade locked anyway and sends the CSD (the buyer gets what they paid for)");
  // The buyer moves their USDC out ahead of the lock: the lock fails and nothing is sent
  await rpc("evm_setAutomine", [false]);
  const b = await signBuy({ csdAmount, usdcAmount: quoteBuy(pool(), csdAmount), key: userCsd.key(5) }); // a fresh address: A's is still busy
  const rb = await post("/buy", b.body);
  const all = await bal(user.address);
  await wc(user).writeContract({ address: usdc, abi: art.MockUSDC.abi, functionName: "transfer", args: [deployer.address, all], gas: 100_000n, maxPriorityFeePerGas: 50_000_000_000n, maxFeePerGas: 100_000_000_000n });
  await rpc("evm_mine"); await rpc("evm_setAutomine", [true]);
  check((await pub.getTransactionReceipt({ hash: rb.lockTx })).status === "reverted", "the buyer emptied their USDC first; the lock reverted");
  check(await until(() => tr(b.hash).status === "lock_failed"), "the bot marks it failed");
  check(!tr(b.hash).csdTxid && ![...csd.mempool.values()].some(tx => tx.outputs.some(o => o.addr20 === userCsd.key(5).addr20)), "and never sent any CSD for it");
  check(BigInt(mm.state().lossUsdc) === 0n, "no loss");
  await send(deployer, usdc, "MockUSDC", "transfer", [user.address, all]);
  await mine(10); await mm.tick(); await mm.tick();
  check(tr(a.hash).status === "settled", "the copied-lock trade settles normally"); }

// A sale as the site makes it: name the coins you'll pay with, sign for them, then pay with exactly those
let saleNo = 0; // (each request differs, as each click in the site makes a new one)
async function openSale(csdAmount, { coins, signer = uKey, recipient = user.address, minUsdcOut = 0n } = {}) {
  const all = await userNode.utxos(uKey);
  const sel = coins ?? buildPayment({ utxos: all, to: [{ value: csdAmount, addr20: "0x" + "00".repeat(20) }], change: uKey.addr20 }).spent.map(c => all.find(u => u.txid === c.txid && u.vout === c.vout));
  const validUntil = Number((await pub.getBlock()).timestamp) + 300; // the bot checks against its own clock
  const req = { csdAmount, usdcRecipient: recipient, validUntil: Math.floor(Date.now() / 1000) + 240 + (saleNo++ % 50), coins: sel.map(c => ({ txid: c.txid, vout: c.vout })) };
  const proofs = [csdSignDigest(signer, csdSaleRequestDigest(req))];
  const o = await post("/sell/open", { ...req, minUsdcOut, proofs, owners: [signer.addr20] });
  return { ...o, sel };
}
const payFor = (o, { from = o.sel, value = BigInt(o.csdAmount ?? 0), fee } = {}) =>
  buildPayment({ utxos: from, to: [{ value, addr20: o.csdAddress }], change: uKey.addr20, ...(fee !== undefined ? { fee } : {}) });

// A seller address of its own, holding one fresh coin
const fresh = async (i, csdAmt = 60n) => { const k = userCsd.key(i); await syncClock(); csd.mine({ rewardTo: k.addr20, reward: csdAmt * 100_000_000n }); return { signer: k, coins: await userNode.utxos(k) }; };

console.log("\n[2c] Over AON the permit is public: locks by others, and fake responses");
{ const csdAmount = 10n * 100_000_000n;
  // Someone submits the buyer's lock before the market maker even looks: it sends the CSD all the same
  const a = await signBuy({ csdAmount, usdcAmount: quoteBuy(pool(), csdAmount), key: userCsd.key(30) });
  const off = (await offers()).sell;
  const ao = buyAuthorizationObject({ offerHash: off.objectHash, authorization: a.body.authorization, signature: a.body.signature, domain, types: AUTH_TYPES, addressProof: a.body.addressProof, permit: a.body.permit });
  await A.put(ao);
  const P = a.body.permit;
  await send(deployer, settlement, "TestCsdUsdcSettlement", "lockCsdUsdcAuthorizationWithPermit", [a.body.authorization, a.body.signature, a.body.addressProof, { deadline: P.deadline, v: P.v, r: P.r, s: P.s }]);
  // A fake "response" from someone else is ignored by the site
  const fake = finalizeObject({ objectType: "response", schemaVersion: "1", namespace: "aon:csd-usdc", createdAt: Date.now(), references: [ao.objectHash.toLowerCase()], payload: { accepted: false, error: "GO_AWAY" } });
  await A.put(fake);
  await mm.watch();
  const r = await A.response(ao.objectHash, mmEvm.address, 10_000);
  check(r.accepted === true && r.error === undefined, "a fake response from someone else is ignored; the market maker's own says accepted");
  check(tr(a.hash).status === "locked" && tr(a.hash).csdTxid && !tr(a.hash).lockTx, "the lock was already there (someone used the public permit), so the bot just sent the CSD");
  { let pay = null; await until(async () => (pay = await A.buyPayment(ao.objectHash, a.hash, [mmEvm.address])));
    check(pay?.csdTxid === tr(a.hash).csdTxid.toLowerCase() && !(await A.buyPayment(ao.objectHash, a.hash, [user.address])),
      "the bot publishes the buy's CSD payment on AON next to the order, signed (only the maker's signature counts)");
    const to = userCsd.key(30).addr20;
    check(csd.mempool.has(pay.csdTxid) && await incomingPaymentLooksReal(userNode, pay.csdTx, pay.csdTxid, to, csdAmount),
      "before any CSD block, the page can check it's real (right transaction, pays the order's address, coins in a block, in the mempool) and show the CSD at once");
    check(!(await incomingPaymentLooksReal(userNode, pay.csdTx, pay.csdTxid, to, csdAmount + 1n)) && !(await incomingPaymentLooksReal(userNode, pay.csdTx, pay.csdTxid, "0x" + "ab".repeat(20), 1n))
      && !(await incomingPaymentLooksReal(userNode, pay.csdTx, "0x" + "00".repeat(32), to, 1n)),
      "but not for more than it pays, for another address, or under another txid");
    const madeUp = buildPayment({ utxos: [{ txid: "0x" + "77".repeat(32), vout: 0, value: 50n * 100_000_000n, key: userCsd.key(35) }], to: [{ value: csdAmount, addr20: to }], change: userCsd.key(35).addr20 });
    check(!(await incomingPaymentLooksReal(userNode, txToNodeJson(madeUp.tx), madeUp.txid, to, csdAmount)), "and not for a payment of coins that don't exist (the CSD node refuses it)"); }
  // A buy the market maker declines, locked anyway by someone: refunded to the buyer when the lock expires
  const b = await signBuy({ csdAmount, usdcAmount: quoteBuy(pool(), csdAmount) * 9n / 10n, key: userCsd.key(31) });
  const rb = await post("/buy", b.body);
  check(rb.accepted === false && rb.error.startsWith("PRICE_MOVED"), "a buy below the price is declined, with the reason, on AON");
  const u0 = await bal(user.address), Q = b.body.permit;
  await send(deployer, settlement, "TestCsdUsdcSettlement", "lockCsdUsdcAuthorizationWithPermit", [b.body.authorization, b.body.signature, b.body.addressProof, { deadline: Q.deadline, v: Q.v, r: Q.r, s: Q.s }]);
  check(await bal(user.address) < u0, "someone locked the declined buy anyway with its public permit");
  await mine(10); await mm.tick(); await mm.tick();
  await rpc("evm_increaseTime", [200 * 60]); await rpc("evm_mine"); await mm.tick();
  if (await bal(user.address) !== u0) { await new Promise(r => setTimeout(r, 1500)); console.log("DEBUGR", String(await bal(user.address) - u0), b.hash, await read(settlement, "TestCsdUsdcSettlement", "usdcLocked", [b.hash]), JSON.stringify(mm.state().rejectedBuys?.[b.hash] ? "kept" : "gone"), JSON.stringify(mm.state().declinedLocks), mm.state().declinedFromBlock, logs.filter(l => /declined|refund/i.test(l)).slice(-5).join("|")); }
  check(await bal(user.address) === u0, "the market maker refunded it to the buyer once the lock expired");
  // Someone locks a buy themselves and only publishes it when the lock is about to expire:
  // CSD sent then could never be proven in time, so the bot sends nothing
  const c = await signBuy({ csdAmount, usdcAmount: quoteBuy(pool(), csdAmount), key: userCsd.key(32) });
  const u1 = await bal(user.address), R = c.body.permit;
  await send(deployer, settlement, "TestCsdUsdcSettlement", "lockCsdUsdcAuthorizationWithPermit", [c.body.authorization, c.body.signature, c.body.addressProof, { deadline: R.deadline, v: R.v, r: R.r, s: R.s }]);
  await rpc("evm_increaseTime", [55 * 60]); await rpc("evm_mine");
  const rc = await post("/buy", c.body);
  check(rc.accepted === false && rc.error === "LOCK_TOO_OLD" && tr(c.hash).status === "lock_failed" && !tr(c.hash).csdTxid,
    "a lock made 55 minutes earlier (5 of its 60 left) is declined, and no CSD is sent");
  await rpc("evm_increaseTime", [10 * 60]); await rpc("evm_mine"); await mm.tick(); await mm.tick();
  check(await bal(user.address) === u1 && tr(c.hash).status === "lock_failed", "when it expires the bot refunds the buyer, and never honours it later");
  // An authorization its buyer didn't sign gets no answer at all
  const d = await signBuy({ csdAmount, usdcAmount: quoteBuy(pool(), csdAmount), key: userCsd.key(33) });
  const forged = await privateKeyToAccount(generatePrivateKey()).signTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: d.body.authorization });
  const fo = buyAuthorizationObject({ offerHash: (await offers()).sell.objectHash, authorization: d.body.authorization, signature: forged, domain, types: AUTH_TYPES, addressProof: d.body.addressProof, permit: d.body.permit });
  await A.put(fo); await mm.watch();
  check(await A.response(fo.objectHash, mmEvm.address, 1500).then(() => false, e => e.message === "NO_RESPONSE") && !tr(d.hash) && !mm.state().rejectedBuys?.[d.hash],
    "an authorization not signed by its buyer is ignored: no trade, no answer, nothing kept");
  // A flood of properly signed buys from throwaway keys with no USDC: dropped, and real buyers still get through
  const so = (await offers()).sell.objectHash, junk = [];
  for (let i = 0; i < 30; i++) {
    const k = privateKeyToAccount(generatePrivateKey()), t = Number((await pub.getBlock()).timestamp);
    const ja = { ...d.body.authorization, buyer: k.address, nonce: keccak256(toHex("junk" + i)), validBefore: BigInt(t + 2 * 86400) };
    const js = await k.signTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: ja });
    const jo = buyAuthorizationObject({ offerHash: so, authorization: ja, signature: js, domain, types: AUTH_TYPES, addressProof: d.body.addressProof });
    await A.put(jo); junk.push(jo);
  }
  await mm.watch(); await mm.watch(); await mm.watch();
  const real = await signBuy({ csdAmount, usdcAmount: quoteBuy(pool(), csdAmount), key: userCsd.key(34) });
  const rr = await post("/buy", real.body);
  check(rr.accepted === true && tr(real.hash), "after 30 signed buys from wallets with no USDC, a real buyer is answered and served");
  check(junk.every(j => ![...aonNode.objects.values()].some(x => x.objectType === "response" && x.references.includes(j.objectHash.toLowerCase())))
    && Object.keys(mm.state().rejectedBuys ?? {}).length <= 2, "the junk got no answers and isn't kept anywhere");
  await until(() => tr(real.hash).status === "locked"); await mine(10); await mm.tick(); await mm.tick();
  // One funded wallet publishing many buys at once: only its newest is looked at, and it can't fill the declined list
  const many = [];
  for (let i = 0; i < 20; i++) {
    const x = await signBuy({ csdAmount, usdcAmount: quoteBuy(pool(), csdAmount) / 2n, key: userCsd.key(40 + i) });
    const xo = buyAuthorizationObject({ offerHash: (await offers()).sell.objectHash, authorization: x.body.authorization, signature: x.body.signature, domain, types: AUTH_TYPES, addressProof: x.body.addressProof, permit: x.body.permit });
    await A.put(xo); many.push(xo);
  }
  await mm.watch(); await mm.watch();
  const answered = many.filter(j => [...aonNode.objects.values()].some(x => x.objectType === "response" && x.references.includes(j.objectHash.toLowerCase())));
  const mineDeclined = Object.values(mm.state().rejectedBuys ?? {}).filter(x => x.buyer.toLowerCase() === user.address.toLowerCase()).length;
  check(answered.length === 3 && answered.every(x => many.indexOf(x) < 3) && mineDeclined <= 5, `20 buys from one wallet at once: only 3 are looked at (answered ${answered.length}); at most 5 of its declined buys are kept (${mineDeclined})`);
  // Republishing a copy of an earlier, already-decided authorization (new createdAt, so a new object) is ignored
  const { objectHash: _o, ...old } = many[0];
  const copy = finalizeObject({ ...old, createdAt: Date.now() });
  await A.put(copy); await mm.watch();
  const ra0 = await A.response(many[0].objectHash, mmEvm.address, 2000), rcp = await A.response(copy.objectHash, mmEvm.address, 2000).catch(() => null);
  const strip = (x) => JSON.stringify({ ...x, to: undefined });
  check(rcp && rcp.to === copy.objectHash && strip(rcp) === strip(ra0), "a republished copy of an already-decided buy gets the same answer, and isn't handled again"); }

console.log("\n[2d] Low on ETH: no new trades, so what's left finishes the open ones");
{ const eth = await pub.getBalance({ address: mmEvm.address });
  await rpc("anvil_setBalance", [mmEvm.address, "0x" + (10n ** 15n).toString(16)]); // 0.001 ETH
  const x = await signBuy({ csdAmount: 10n * 100_000_000n, usdcAmount: quoteBuy(pool(), 10n * 100_000_000n), key: userCsd.key(60) });
  check((await post("/buy", x.body)).error === "MARKET_MAKER_PAUSED" && !tr(x.hash) && logs.some(l => l.includes("LOW GAS")), "below the ETH reserve a new buy is declined (nothing locked) and the operator is warned");
  await rpc("anvil_setBalance", [mmEvm.address, "0x" + eth.toString(16)]); }

console.log("\n[3] User sells 40 CSD: USDC released before any CSD block");
let sold;
{ const csdAmount = 40n * 100_000_000n, quote = quoteSell(pool(), csdAmount) - 250_000n, mid0 = midPrice(pool()), m0ask = (await get("/market")).bestAsk;
  const thief = deriveCsdWallet("0x" + "77".repeat(65)).key(0);
  // Sale requests signed by throwaway keys that own nothing: ignored before any budget is spent
  const so = (await offers()).buy.objectHash, junkSales = [];
  for (let i = 0; i < 30; i++) {
    const k = deriveCsdWallet(keccak256(toHex("junk-seller" + i)) + "00").key(0);
    const jr = { csdAmount: csdAmount, usdcRecipient: user.address, validUntil: Math.floor(Date.now() / 1000) + 300, coins: [{ txid: "0x" + "ee".repeat(32), vout: i }] };
    const jo = saleRequestObject({ offerHash: so, ...jr, minUsdcOut: 0n, proofs: [csdSignDigest(k, csdSaleRequestDigest(jr))], owners: [k.addr20] });
    await A.put(jo); junkSales.push(jo);
  }
  await mm.watch();
  check(junkSales.every(j => ![...aonNode.objects.values()].some(x => x.objectType === "response" && x.references.includes(j.objectHash.toLowerCase())))
    && !Object.values(mm.state().trades).some(t => t.kind === "sell" && t.status === "opening"), "30 sale requests signed by keys that own nothing are ignored");
  noAnswerMs = 1500;
  check((await openSale(csdAmount, { signer: thief }).catch(e => ({ error: e.message }))).error === "NO_RESPONSE", "a sale signed by keys that don't own its coins is ignored (no answer, nothing kept)");
  noAnswerMs = 15_000;
  const o = await openSale(csdAmount, { minUsdcOut: quote });
  check(o.http === 200 && o.lockTx && o.csdAddress, "bot opens the trade: locks its USDC against a fresh CSD address");
  { const { objectHash: _x, ...orig } = aonNode.objects.get(o.objectHash.toLowerCase());
    const again = await answer(finalizeObject({ ...orig, createdAt: Date.now() }));
    check(again.authHash === o.authHash && Object.values(mm.state().trades).filter(t => t.kind === "sell" && t.requestDigest === tr(o.authHash).requestDigest).length === 1,
      "the same signed request republished by someone else gets the same answer, not a second sale"); }
  check(midPrice(pool()) === mid0 && (await get("/market")).bestAsk === m0ask, "opening a sale doesn't move the pool or the buy price");
  check((await openSale(csdAmount - 1n, { coins: o.sel })).error === "COINS_IN_USE", "the same coins can't back a second sale");
  const others = (await userNode.utxos(uKey)).filter(c => !o.sel.some(x => x.txid === c.txid && x.vout === c.vout));
  check((await openSale(csdAmount, { coins: others.slice(0, 1) })).http === 429, "the same USDC recipient can't open a second sale while one waits for payment");
  const h = hashTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: authArgs(o.authorization) });
  check(h === o.authHash && await read(settlement, "TestCsdUsdcSettlement", "usdcLocked", [h]), "the site recomputes the trade hash and sees the USDC locked on-chain");
  check(o.authorization.sellerUsdcRecipient === user.address && BigInt(o.authorization.usdcAmount) === quote && BigInt(o.authorization.csdAmount) === csdAmount && o.authorization.minConfirmations === "20",
    "the lock pays the user the quoted amount for exactly 40 CSD (and needs 20 confirmations to prove, so faking it is expensive)");
  await until(() => tr(o.authHash).status === "open");
  check((await post("/sell/pay", { authHash: o.authHash, tx: txToNodeJson(payFor(o, { value: csdAmount - 1n }).tx) })).error === "CSD_PAYMENT_TOO_SMALL", "a payment 1 unit short is refused");
  check((await post("/sell/pay", { authHash: o.authHash, tx: txToNodeJson(payFor(o, { fee: 500n }).tx) })).error === "CSD_FEE_TOO_LOW", "a payment with a token fee is refused");
  const other = (await userNode.utxos(uKey)).filter(c => !o.sel.some(x => x.txid === c.txid && x.vout === c.vout));
  check((await post("/sell/pay", { authHash: o.authHash, tx: txToNodeJson(payFor(o, { from: other }).tx) })).error === "PAY_WITH_THE_COINS_YOU_NAMED", "paying with other coins than the ones named is refused");
  // Ten forged payments (not signed by the seller's keys) first: they don't use up the seller's attempts
  for (let i = 0; i < 10; i++) {
    const f = payFor(o); f.tx.inputs = f.tx.inputs.map(x => ({ ...x, scriptSig: new Uint8Array([64, ...new Uint8Array(64).fill(i + 1), 33, ...x.scriptSig.slice(66)]) }));
    await A.put(payObject(o.authHash, txToNodeJson(f.tx)));
  }
  await mm.watch();
  check(tr(o.authHash).status === "open" && !tr(o.authHash).csdTxid, "ten forged payments for the sale are ignored");
  const pay = payFor(o);
  const u0 = await bal(user.address), height0 = csd.blocks.length;
  const t0 = Date.now(); const r = await post("/sell/pay", { authHash: o.authHash, tx: txToNodeJson(pay.tx) });
  check(r.http === 200 && r.status === "released" && r.releaseTx && r.instant, `released in ${Date.now() - t0} ms without waiting for CSD`);
  await pub.waitForTransactionReceipt({ hash: r.releaseTx });
  check(await bal(user.address) === u0 + quote && csd.blocks.length === height0, `user received ${Number(quote) / 1e6} USDC with no CSD block mined`);
  check(csd.mempool.has(r.csdTxid), "the user's CSD payment is broadcast by the bot");
  check(midPrice(pool()) === mid0, "the price doesn't move until the payment is in a block");
  await mine(); await mm.tick();
  check(midPrice(pool()) < mid0, "once it's in a block, the price moves");
  await mine(2); await mm.tick();
  check(tr(o.authHash).status === "done", "after 3 CSD confirmations the bot stops counting it as risk");
  await mm.tick();
  const g = tr(o.authHash).aon ?? {}, req = obj(g.request), auth = obj(g.auth), rel = obj(g.release), receipt = obj(g.receipt);
  check(req && auth && rel && receipt, "AON: request, authorization, release and receipt all published");
  check(req.signature.signers.includes(uKey.addr20) && req.payload.coins.length === o.sel.length, "the seller's request is signed with the keys that own its coins");
  check(auth.references.includes(req.objectHash.toLowerCase()) && auth.signature.signer === mmEvm.address, "the market maker's authorization references the seller's request");
  check(rel.references.includes(auth.objectHash.toLowerCase()) && rel.payload.release.csdTxid === tr(o.authHash).csdTxid, "the release references it and names the seller's CSD payment");
  check(receipt.references.includes(auth.objectHash.toLowerCase()) && receipt.references.includes(rel.objectHash.toLowerCase()) && receipt.references.includes(req.objectHash.toLowerCase())
    && receipt.payload.executionTx === tr(o.authHash).releaseTx, "the receipt ties request, authorization and release to the release transaction");
  sold = o;
  { // Someone copies a seller's request (new date, so another object) before the bot looks: both get the answer
    const k = (await fresh(25)), req = { csdAmount: 10n * 100_000_000n, usdcRecipient: user.address, validUntil: Math.floor(Date.now() / 1000) + 290, coins: k.coins.map(c => ({ txid: c.txid, vout: c.vout })) };
    const ro = saleRequestObject({ offerHash: (await offers()).buy.objectHash, ...req, minUsdcOut: 0n, proofs: [csdSignDigest(k.signer, csdSaleRequestDigest(req))], owners: [k.signer.addr20] });
    const { objectHash: _c, ...rest } = ro, cp = finalizeObject({ ...rest, createdAt: ro.createdAt - 1000 });
    await A.put(cp); await A.put(ro); await mm.watch();
    const r1 = await A.response(ro.objectHash, mmEvm.address, 3000).catch(() => null), r2 = await A.response(cp.objectHash, mmEvm.address, 3000).catch(() => null);
    check(r1?.accepted && r2?.accepted && r1.authHash === r2.authHash, "a seller's request copied by someone else: both get the same answer, so the seller isn't left waiting");
    await until(() => tr(r1.authHash).status === "open");
    await post("/sell/pay", { authHash: r1.authHash, tx: txToNodeJson(buildPayment({ utxos: k.coins, to: [{ value: req.csdAmount, addr20: r1.csdAddress }], change: k.signer.addr20 }).tx) });
    await mine(3); await mm.tick(); }
}

console.log("\n[4] Over the instant limit, the bot waits for confirmations; one payment, one sale");
{ const a = await openSale(40n * 100_000_000n);
  check((await openSale(40n * 100_000_000n, { coins: (await userNode.utxos(uKey)).filter(c => !a.sel.some(x => x.txid === c.txid && x.vout === c.vout)).slice(0, 1) })).error === "FINISH_YOUR_OTHER_SALE", "one waiting sale per CSD address");
  const b = await openSale(40n * 100_000_000n, { ...(await fresh(20)), recipient: deployer.address }); // another seller
  check(a.http === 200 && b.http === 200, "two sales from different addresses");
  await until(() => tr(a.authHash).status === "open" && tr(b.authHash).status === "open");
  const pa = payFor(a);
  const ra = await post("/sell/pay", { authHash: a.authHash, tx: txToNodeJson(pa.tx) });
  check(ra.instant, `first ~${Number(a.usdcAmount) / 1e6} USDC: instant (limit 10 USDC in flight)`);
  { const dup = payObject(b.authHash, txToNodeJson(pa.tx));
    await A.put(dup); await mm.watch();
    check(!tr(b.authHash).csdTxid && await A.response(dup.objectHash, mmEvm.address, 1500).then(() => false, () => true),
      "the same payment can't be used for a second sale (it isn't signed by that sale's seller, so it's ignored)"); }
  const rb = await post("/sell/pay", { authHash: b.authHash, tx: txToNodeJson(payFor(b).tx) });
  check(rb.http === 200 && !rb.instant && rb.status === "paid", "second one would pass the limit: accepted, released after one block");
  await mine(); await mm.tick();
  check(tr(b.authHash).status === "paid", "one block isn't enough while the first sale still counts as in flight (the same limits apply below 3 confirmations)");
  await mine(2); await mm.tick();
  check(["released", "done"].includes(tr(b.authHash).status) && tr(b.authHash).releaseTx, "released once its payment is 3 blocks deep"); }

console.log("\n[5] Coins already spent, a payment too late, and a sale nobody pays for");
{ await mine(3); await mm.tick();
  const p0 = pool(); const m0 = await bal(mmEvm.address);
  const o = await openSale(10n * 100_000_000n, await fresh(21));
  await until(() => tr(o.authHash).status === "open");
  const elsewhere = buildPayment({ utxos: o.sel, to: [{ value: 100_000_000n, addr20: "0x" + "cd".repeat(20) }], change: uKey.addr20 });
  csd.submit(elsewhere.tx); // the named coins get spent somewhere else
  check((await post("/sell/pay", { authHash: o.authHash, tx: txToNodeJson(payFor(o).tx) })).error === "CSD_COINS_NOT_AVAILABLE", "a payment from coins already spent in the mempool is refused");
  await mine(); await new Promise(r => setTimeout(r, 10_000));
  await mm.tick(); // the first sale's payment window is over
  const o2 = await openSale(10n * 100_000_000n, await fresh(22));
  check(o2.http === 200, "(meanwhile another sale opens fine)");
  await until(() => tr(o2.authHash).status === "open"); await mm.tick();
  check(tr(o.authHash).unpaidAt, "the first sale's payment window has passed");
  check((await post("/sell/pay", { authHash: o.authHash, tx: txToNodeJson(payFor(o, { from: (await fresh(21, 20n)).coins }).tx) })).error === "TOO_LATE_TO_PAY", "after the payment window the bot won't take the CSD (no free option on the price)");
  await new Promise(r => setTimeout(r, 10_000)); await mm.tick();
  const banned = await openSale(10n * 100_000_000n, { signer: userCsd.key(22), coins: o2.sel });
  check(banned.error === "COINS_FROM_AN_UNPAID_SALE", "coins named in a sale left unpaid can't open another for a day");
  check(pool().usdc === p0.usdc && pool().csd === p0.csd, "unpaid sales never moved the pool");
  const newcomer = userCsd.key(9); await syncClock(); csd.mine({ rewardTo: newcomer.addr20, reward: 50n * 100_000_000n });
  check((await get("/market")).limits.sellsPaused === true && (await openSale(10n * 100_000_000n, { signer: newcomer, coins: await userNode.utxos(newcomer) })).error === "SELLS_PAUSED",
    "two unpaid sales in an hour pause selling for new sellers (each costs the bot two transactions)");
  const keep = await openSale(10n * 100_000_000n);
  check(keep.http === 200, "a seller with completed sales (and none left unpaid) can still sell while it's paused");
  noAnswerMs = 1500;
  const o3 = await openSale(10n * 100_000_000n, { signer: userCsd.key(22), coins: (await userNode.utxos(userCsd.key(22))).filter(c => !o2.sel.some(x => x.txid === c.txid && x.vout === c.vout)) }).catch(e => ({ error: e.message }));
  noAnswerMs = 15_000;
  check(o3.error === "SELLS_PAUSED" || o3.error === "COINS_FROM_AN_UNPAID_SALE" || o3.error === "NOT_ENOUGH_COINS" || o3.error === "NO_RESPONSE" || o3.http !== 200, "an address that left a sale unpaid gets no exemption");
  await until(() => tr(keep.authHash).status === "open");
  await post("/sell/pay", { authHash: keep.authHash, tx: txToNodeJson(payFor(keep).tx) });
  await rpc("evm_increaseTime", [120 * 60]); await rpc("evm_mine"); await mm.tick(); await mm.tick();
  check(tr(o.authHash).status === "expired" && tr(o2.authHash).status === "expired", "the unpaid sales' locks were refunded once they expired"); }

// let selling resume for the rest of the test
for (const t of Object.values(mm.state().trades)) if (t.unpaidAt) t.unpaidAt -= 2 * 86400;

console.log("\n[6] Double spends: an instant one is a capped loss; one that wasn't released moves nothing");
{ await mine(3); await mm.tick();
  const o = await openSale(10n * 100_000_000n);
  await until(() => tr(o.authHash).status === "open");
  const r = await post("/sell/pay", { authHash: o.authHash, tx: txToNodeJson(payFor(o).tx) });
  check(r.instant, "released instantly");
  const p0 = pool();
  const cheat = buildPayment({ utxos: o.sel, to: [{ value: 10n * 100_000_000n, addr20: uKey.addr20 }], change: uKey.addr20, fee: 20_000n });
  await syncClock(); csd.doubleSpend(cheat.tx); // the cheater gets a conflicting spend mined first
  await mine(2); await new Promise(r => setTimeout(r, 3100)); await mm.tick();
  check(tr(o.authHash).status === "reversed" && BigInt(mm.state().lossUsdc) === BigInt(o.usdcAmount), `bot records the ${Number(o.usdcAmount) / 1e6} USDC loss`);
  check(pool().csd === p0.csd && pool().usdc === p0.usdc - BigInt(tr(o.authHash).poolUsdc), "the pool counts the USDC as gone and no CSD as received");
  check((await get("/market")).limits.instantSells === false, "past the loss budget (1 USDC in this test) instant sales are off");
  check((await openSale(10n * 100_000_000n)).error === "ADDRESS_FROM_A_DOUBLE_SPEND", "the cheater's address can't open another sale for a day");
  // Not instant now: a double-spent payment leaves the pool (and so the price) untouched
  const d = await openSale(10n * 100_000_000n, await fresh(11));
  await until(() => tr(d.authHash).status === "open");
  const rd = await post("/sell/pay", { authHash: d.authHash, tx: txToNodeJson(payFor(d).tx) });
  check(rd.status === "paid" && !rd.instant, "the next sale waits for a CSD block");
  const ask0 = (await get("/market")).bestAsk, pd = pool();
  await syncClock(); csd.doubleSpend(buildPayment({ utxos: d.sel, to: [{ value: 10n * 100_000_000n, addr20: uKey.addr20 }], change: uKey.addr20, fee: 20_000n }).tx);
  await mine(2); await mm.tick();
  check(tr(d.authHash).status === "paid" && pool().usdc === pd.usdc && pool().csd === pd.csd && (await get("/market")).bestAsk === ask0, "its payment was double-spent: nothing released, the price didn't move");
  // A paid sale whose lock expires before its payment confirms: the bot takes its lock back, and pays directly when the CSD arrives
  const e = await openSale(10n * 100_000_000n, { ...(await fresh(12)), recipient: deployer.address }); // (the user's other sale still waits)
  await until(() => tr(e.authHash).status === "open");
  const pe = payFor(e);
  await post("/sell/pay", { authHash: e.authHash, tx: txToNodeJson(pe.tx) });
  csd.drop(pe.txid); // held up somewhere
  await rpc("evm_increaseTime", [120 * 60]); await rpc("evm_mine"); await mm.tick();
  check(!(await read(settlement, "TestCsdUsdcSettlement", "usdcLocked", [e.authHash])), "the lock expired with the payment unconfirmed; the bot refunded it");
  csd.submit(pe.tx); const u0 = await bal(deployer.address);
  await mine(3); await mm.tick(); // (past the loss budget, release waits for 3 confirmations)
  await until(async () => await bal(deployer.address) === u0 + BigInt(e.usdcAmount));
  check(await bal(deployer.address) === u0 + BigInt(e.usdcAmount), "when the payment confirmed later, the bot paid the seller directly"); }

console.log("\n[6b] CSD received for finished sales is swept into the bot's main address");
{ await mine(3); await mm.tick(); await mine(); await mm.tick(); await mm.tick();
  const done = Object.values(mm.state().trades).filter(t => t.kind === "sell" && t.status === "done");
  check(done.length >= 3 && done.every(t => t.swept), `all ${done.length} finished sales' addresses are emptied and no longer looked up`); }

console.log("\n[6d] A sale that was already final when the bot thought its release failed still gets its receipt");
{ const t = mm.state().trades[sold.authHash], rel = t.releaseTx;
  t.status = "paid"; t.releaseTx = undefined; delete t.aon.receipt; // (as after a duplicate release reverted)
  await mm.tick(); await mm.tick();
  check(t.status === "done" && t.releaseTx?.toLowerCase() === rel.toLowerCase(), "the bot finds the transaction that really released it, from the contract's events");
  check(t.aon.receipt && obj(t.aon.receipt)?.payload.executionTx?.toLowerCase() === rel.toLowerCase(), "and publishes the receipt naming it"); }

console.log("\n[6e] A buy someone else settled with the bot's proof (a copy bot, say) still gets its receipt");
{ const t = Object.values(mm.state().trades).find(x => x.kind === "buy" && x.status === "settled" && x.aon?.receipt && x.settleTx);
  const real = t.settleTx;
  t.settleTx = undefined; delete t.aon.receipt; delete t.finalLooked; // (as when the copy landed first and ours never did)
  await mm.tick(); await mm.tick();
  check(t.settleTx?.toLowerCase() === real.toLowerCase(), "the bot finds the transaction that settled it, from the contract's events");
  check(t.aon.receipt && obj(t.aon.receipt)?.payload.executionTx?.toLowerCase() === real.toLowerCase() && obj(t.aon.receipt)?.payload.method === "settleCsdUsdc",
    "and publishes the buy's receipt naming it"); }

console.log("\n[6c] Open market: any maker's offers are found, even under junk, by following its chain of offers");
{ const first = [...aonNode.objects.values()].filter(o => o.objectType === "offer" && o.payload?.marketMaker === mmEvm.address && o.payload.offerType === "csd_usdc_sell_csd")
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  for (let i = 0; i < 320; i++) await A.put(finalizeObject({ objectType: "offer", schemaVersion: "1", namespace: "aon:csd-usdc", createdAt: Date.now() + 3600_000 + i, references: [],
    payload: { offerType: "csd_usdc_sell_csd", marketMaker: "0x" + (i + 1).toString(16).padStart(40, "0"), validBefore: 9e9 } }));
  const listed = await A.allOffers([]);
  const chained = await A.allOffers([first.objectHash]);
  const cur = mm.state().offers.sell.hash;
  check(!listed.get(mmEvm.address.toLowerCase())?.sell, "320 junk offers bury the real ones in a plain listing");
  check(first.objectHash !== cur && chained.get(mmEvm.address.toLowerCase())?.sell?.objectHash === cur && chained.size === 1,
    "from an old offer the page follows the maker's chain to its current one (and none of the unsigned junk counts)"); }

console.log("\n[7] Restart: state survives, CSD proxy works for the in-site wallet");
{ const before = JSON.stringify(mm.state()); await mm.stop();
  mm = await startMarketMaker(mmCfg);
  check(JSON.stringify(mm.state()) === before, "trades and pool reload from the state file");
  const tip = await get("/csd/tip");
  check(tip.height === csd.blocks.length - 1, "GET /api/csd/tip proxied");
  check((await get("/csd/utxos/" + uKey.addr20.slice(2))).utxos.length >= 1, "GET /api/csd/utxos proxied");
  check((await get("/csd/utxos/..%2Fmempool")).http === 404 && (await get("/csd/tx/0x" + "00".repeat(32))).http === 404, "proxy only takes well-formed addresses, and not the chain-scanning tx lookup");
  check((await get(`/csd/proof/tx/${tr(sold.authHash).csdTxid}`)).ok === true, "proofs of sales' payments are available for claiming yourself");
  check((await get(`/csd/proof/tx/0x${"12".repeat(32)}`)).http === 404, "but not for arbitrary transactions (each lookup scans the chain)");
  const coins = await userNode.utxos(uKey);
  const send2 = buildPayment({ utxos: coins, to: [{ value: 100_000_000n, addr20: "0x" + "ab".repeat(20) }], change: uKey.addr20 });
  check((await userNode.submit(send2.tx)) === send2.txid, "the in-site wallet sends CSD through the proxy"); }

console.log("\n[8] Watchtower: a maker that never releases a paid sale; another bot settles it for the seller");
{ const o = await openSale(10n * 100_000_000n, await fresh(71));
  check(o.http === 200 && o.authorization.executorFeeAmount === "2000000", "each sale's lock carries a 2 USDC executor fee (back to the maker when it releases)");
  await until(() => tr(o.authHash).status === "open");
  // The maker publishes a fake "payment" for the trade first (signed by a key of its own, from coins that don't exist)
  // (25 of them, more than any small cap, each signed by a throwaway key spending a coin that doesn't exist)
  for (let i = 0; i < 25; i++) {
    const fakeKey = deriveCsdWallet(keccak256(toHex("fake" + i)) + "00").key(0);
    const fakeTx = buildPayment({ utxos: [{ txid: keccak256(toHex("nocoin" + i)), vout: 0, value: 20n * 100_000_000n, key: fakeKey }], to: [{ value: 10n * 100_000_000n, addr20: o.csdAddress }], change: fakeKey.addr20 }).tx;
    await A.put(payObject(o.authHash, txToNodeJson(fakeTx)));
  }
  const r = await post("/sell/pay", { authHash: o.authHash, tx: txToNodeJson(payFor(o).tx) });
  check(r.status === "paid" && !r.releaseTx, "the seller paid; the maker hasn't released (instant sales are off here)");
  // A second sale whose seller paid straight to the CSD network: nothing about it on AON at all
  const o2 = await openSale(20n * 100_000_000n, await fresh(72));
  await until(() => tr(o2.authHash).status === "open");
  csd.submit(payFor(o2).tx);
  await mm.stop(); // the maker disappears
  const towerLogs = [];
  const tower = await startMarketMaker({ ...mmCfg, privateKey: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", csdSeed: "0x" + "71".repeat(32),
    stateFile: STATE + ".tower", port: 18995, watchtowerMs: 1, log: (...a) => towerLogs.push(a.join(" ")) });
  // The maker sweeps the second sale's coin out of the sale address one block after it arrives
  // (the sweep is sent the moment the payment's block lands, before the watchtower looks)
  await mine(1);
  { const direct = csdNode(csd.url), k = deriveCsdWallet(MM_SEED).key(tr(o2.authHash).keyIndex), coins = await direct.utxos(k);
    const sweep = buildPayment({ utxos: coins, to: [{ value: coins.reduce((x, c) => x + c.value, 0n) - 10_000n, addr20: mmInventory.addr20 }], change: k.addr20 });
    await syncClock(); csd.submit(sweep.tx); await tower.tick(); await mine(1);
    check((await direct.utxos(k)).length === 0, "the maker swept the seller's coin out of the sale address the next block"); }
  await mine(24);
  const until0 = Number(await read(settlement, "TestCsdUsdcSettlement", "lockedUntil", [o.authHash])), now0 = Number((await pub.getBlock()).timestamp);
  await rpc("evm_increaseTime", [until0 - now0 - 900]); await rpc("evm_mine");
  const u0 = await bal(user.address), t0 = await bal(tower.address);
  await tower.watchtower();
  await until(async () => await bal(user.address) >= u0 + BigInt(o.usdcAmount) + BigInt(o2.usdcAmount), 10_000);
  check(await bal(user.address) === u0 + BigInt(o.usdcAmount) + BigInt(o2.usdcAmount) && await read(settlement, "TestCsdUsdcSettlement", "finalizedAuthorization", [o.authHash]),
    "15 minutes before the lock runs out, another bot settles the sale with a proof of the seller's payment: the seller gets the USDC");
  check(await read(settlement, "TestCsdUsdcSettlement", "finalizedAuthorization", [o2.authHash]),
    "including the sale paid with nothing on AON and swept right away (authorization read from the lock transaction, payment seen at the sale address on the block it arrived)");
  check(await bal(tower.address) === t0 + 4_000_000n, "and earns the sale's executor fee for it (25 forged payments published first didn't stop it)");
  { const bn = await pub.getBlockNumber(); let gas = 0n;
    for (let i = 0n; i < 6n && !gas; i++) for (const h of (await pub.getBlock({ blockNumber: bn - i })).transactions) {
      const tx = await pub.getTransaction({ hash: h }); if (tx.from.toLowerCase() === tower.address.toLowerCase()) { gas = (await pub.getTransactionReceipt({ hash: h })).gasUsed; break; } }
    console.log(`    (settling with a proof of ${o.authorization.minConfirmations} confirmations used ${gas} gas)`); }
  await tower.stop(); rmSync(STATE + ".tower", { force: true }); }

await mm.stop(); await csd.close(); await aonNode.close();
if (logs.some(l => l.includes("INTERNAL"))) console.log(logs.join("\n"));
console.log(`\nAll ${pass} market-maker checks passed.`);
process.exit(0); // (open keep-alive connections would otherwise hold the process)
