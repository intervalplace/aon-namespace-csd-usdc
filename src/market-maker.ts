// CSD/USDC market maker: an always-available counterparty for covenant.market.
//
// Prices come from its pool (USDC held ÷ CSD held, plus a spread; src/pool.ts).
// Both directions feel like an ordinary swap, about one Ethereum block:
//
//   User buys CSD:  the user signs (gasless) an authorization, a USDC permit and
//     a CSD address proof. The bot submits the lock and sends the CSD at the
//     same moment. The user's USDC only reaches the bot once the CSD payment is
//     proven on-chain (settleCsdUsdc, after the user's chosen confirmations),
//     otherwise it is refunded, so the user takes no risk.
//
//   User sells CSD: the bot locks its USDC for the trade (a fresh CSD address of
//     its own, with proof), the user's wallet checks the lock on-chain and then
//     hands the bot its signed CSD payment. The bot broadcasts it and releases
//     the USDC straight away (releaseEarly), without waiting for a CSD block.
//     The bot carries the risk that the payment is double-spent, so instant
//     releases are capped (maxUnconfirmedUsdc); above that it waits one block.
//
// No custody of user funds and no consensus change: the bot is a trader with a
// key, CSD and USDC. Its HTTP API also proxies a few read-only CSD node calls
// (and /tx/submit) so the in-site CSD wallet can reach a node over HTTPS.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, defineChain, getAddress, hashTypedData, http as viemHttp,
  keccak256, maxUint256, toHex, type Hex,
} from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import {
  csdNode, deriveCsdWallet, buildPayment, csdTxid, csdAddressProof, addr20ToBytes32, bitsToTarget,
  suggestedMaxTarget, txToNodeJson, txFromNodeJson, type CsdKey, type CsdTx, type CsdUtxo,
} from "./csd-wallet.js";
import { settlementAbi, authTuple, spvProofTuple } from "./executors/evmCsdUsdcSettlement.js";
import { csdUsdcNamespace, EARLY_RELEASE_TYPES } from "./namespace.js";
import { quoteBuy, quoteSell, afterBuy, afterSell, midPrice, ladder, type Pool } from "./pool.js";

export type MarketMakerConfig = {
  rpcUrl: string; chainId: number; privateKey: Hex;
  settlement: Hex; usdc: Hex; csdApi: string; csdGenesis: Hex;
  csdSeed: Hex;                 // secret: the bot's CSD keys are derived from it
  stateFile: string; port: number; host?: string;
  allowedOrigins: string[];     // CORS, e.g. ["https://covenant.market"]; ["*"] for any
  initialPool: { usdc: bigint; csd: bigint };
  spreadBps?: bigint;           // default 300 (3%)
  feeUsdc?: bigint;             // per trade, covers gas; default 0.25 USDC
  maxTradeUsdc?: bigint;        // default 30 USDC (the contract's cap), fee included
  minTradeUsdc?: bigint;        // default 1 USDC
  maxUnconfirmedUsdc?: bigint;  // default 60 USDC: trades trusted before CSD confirms
  buyConfirmations?: [number, number];  // accepted range for users' buys; default [3, 20]
  sellConfirmations?: number;   // what the bot signs when it buys; default 3
  safeConfirmations?: number;   // when a trusted payment stops counting as exposure; default 3
  priceToleranceBps?: bigint;   // how far a signed price may lag the pool; default 50 (0.5%)
  inventoryPieces?: number;     // CSD is kept split into this many coins; default 20
  pollMs?: number;              // default 5000
  rebroadcastSecs?: number;     // resend a CSD payment not mined after this long; default 900
  publishToAon?: (obj: any) => Promise<void>;
  log?: (...a: any[]) => void;
};

type TradeStatus =
  | "locking" | "locked" | "settled" | "lock_failed" | "refunded"          // user buys
  | "opening" | "open" | "paid" | "released" | "done" | "expired" | "reversed" | "open_failed"; // user sells
type Trade = {
  kind: "buy" | "sell"; status: TradeStatus; authHash: Hex; createdAt: number;
  auth: Record<string, string>; authSig: Hex;
  csdAmount: string; usdcAmount: string; poolUsdc: string; // poolUsdc: what moved in or out of the pool
  lockTx?: Hex; lockedAt?: string; lockedUntil?: string;
  csdTxid?: Hex; csdTx?: any; csdSentAt?: number;           // buy: our payment; sell: the user's
  keyIndex?: number; csdAddr?: Hex;                         // sell: our receiving key
  releaseTx?: Hex; settleTx?: Hex; instant?: boolean; error?: string;
};
type State = { pool: { usdc: string; csd: string }; nextKey: number; trades: Record<string, Trade>; lossUsdc: string; lastSplit?: number };

const ERC20 = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const VIEWS = [
  { type: "function", name: "usdcLocked", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "finalizedAuthorization", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "lockedAt", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lockedUntil", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
] as const;

class HttpError extends Error { constructor(public code: number, msg: string) { super(msg); } }
const bad = (msg: string): never => { throw new HttpError(400, msg); };

export async function startMarketMaker(cfg: MarketMakerConfig) {
  const C = {
    spreadBps: 300n, feeUsdc: 250_000n, maxTradeUsdc: 30_000_000n, minTradeUsdc: 1_000_000n,
    maxUnconfirmedUsdc: 60_000_000n, buyConfirmations: [3, 20] as [number, number], sellConfirmations: 3,
    safeConfirmations: 3, priceToleranceBps: 50n, inventoryPieces: 20, pollMs: 5000, rebroadcastSecs: 900, log: console.log, ...cfg,
  };
  const log = C.log;
  const chain = defineChain({ id: C.chainId, name: `evm-${C.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [C.rpcUrl] } } });
  const account = privateKeyToAccount(C.privateKey, { nonceManager });
  const pub = createPublicClient({ chain, transport: viemHttp(C.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: viemHttp(C.rpcUrl) });
  const settlement = getAddress(C.settlement), usdc = getAddress(C.usdc);
  const domain = { name: "AON CSD/USDC", version: "4", chainId: C.chainId, verifyingContract: settlement } as const;
  const AUTH_TYPES = csdUsdcNamespace.types!() as any;
  const node = csdNode(C.csdApi);
  const keys = deriveCsdWallet(C.csdSeed);
  const keyCache = new Map<number, CsdKey>();
  const key = (i: number) => { let k = keyCache.get(i); if (!k) { k = keys.key(i); keyCache.set(i, k); } return k; };
  const inventory = key(0); // where the bot's CSD and change live

  // ── state ────────────────────────────────────────────────────────────────
  let S: State = existsSync(C.stateFile) ? JSON.parse(readFileSync(C.stateFile, "utf8"))
    : { pool: { usdc: String(C.initialPool.usdc), csd: String(C.initialPool.csd) }, nextKey: 1, trades: {}, lossUsdc: "0" };
  const save = () => { writeFileSync(C.stateFile + ".tmp", JSON.stringify(S, null, 1)); renameSync(C.stateFile + ".tmp", C.stateFile); };
  save();
  const pool = (): Pool => ({ usdc: BigInt(S.pool.usdc), csd: BigInt(S.pool.csd), spreadBps: C.spreadBps });
  const setPool = (p: Pool) => { S.pool = { usdc: String(p.usdc), csd: String(p.csd) }; };
  const addLoss = (x: bigint, why: string) => { S.lossUsdc = String(BigInt(S.lossUsdc) + x); log(`[mm] LOSS ${Number(x) / 1e6} USDC: ${why}`); };
  // USDC value of trades the bot is trusting before CSD confirms
  const exposure = () => Object.values(S.trades).reduce((s, t) =>
    s + ((t.kind === "sell" && t.status === "released") || (t.kind === "buy" && t.status === "locking") ? BigInt(t.usdcAmount) : 0n), 0n);

  // one trade at a time: coins, nonces and the pool stay consistent
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = queue.then(fn); queue = r.catch(() => {}); return r; };

  const now = () => Math.floor(Date.now() / 1000);
  const chainNow = async () => Number((await pub.getBlock()).timestamp);
  const authHashOf = (auth: any) => hashTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: authTuple(auth) });
  const strAuth = (a: any) => Object.fromEntries(Object.entries(authTuple(a)).map(([k, v]) => [k, String(v)]));
  const view = (fn: any, h: Hex) => pub.readContract({ address: settlement, abi: VIEWS, functionName: fn, args: [h] }) as Promise<any>;

  // ── CSD coins ─────────────────────────────────────────────────────────────
  const ownKeys = () => [inventory, ...Object.values(S.trades).filter(t => t.kind === "sell" && t.keyIndex !== undefined && ["released", "done", "paid"].includes(t.status)).map(t => key(t.keyIndex!))];
  async function spendable(): Promise<CsdUtxo[]> {
    const all: CsdUtxo[] = [];
    for (const k of ownKeys()) all.push(...await node.utxos(k));
    return all;
  }
  // Prefer one coin that covers the amount (keeps the others free for the next trade)
  function pick(utxos: CsdUtxo[], need: bigint): CsdUtxo[] {
    const asc = [...utxos].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    const one = asc.find(u => u.value >= need); if (one) return [one];
    const out: CsdUtxo[] = []; let s = 0n;
    for (const u of asc.reverse()) { out.push(u); s += u.value; if (s >= need) return out; }
    throw new HttpError(503, "NOT_ENOUGH_CSD_RIGHT_NOW");
  }
  const CSD_FEE = 10_000n;
  async function sendCsd(to: Hex, value: bigint) {
    const p = buildPayment({ utxos: pick(await spendable(), value + CSD_FEE), to: [{ value, addr20: to }], change: inventory.addr20, fee: CSD_FEE });
    await node.submit(p.tx);
    return p;
  }
  // Keeps CSD in several coins, since a coin spent in the mempool (and its
  // change) can't be used again until the next CSD block
  async function splitInventory() {
    const u = await spendable();
    if (u.length >= Math.max(3, C.inventoryPieces / 4)) return;
    const total = u.reduce((s, x) => s + x.value, 0n);
    const n = BigInt(C.inventoryPieces), piece = (total - CSD_FEE) / n;
    if (piece < 100_000_000n) return; // under 1 CSD per coin: not worth it
    const p = buildPayment({ utxos: u, to: Array.from({ length: C.inventoryPieces - 1 }, () => ({ value: piece, addr20: inventory.addr20 })), change: inventory.addr20, fee: CSD_FEE });
    await node.submit(p.tx); S.lastSplit = now(); save();
    log(`[mm] split ${Number(total) / 1e8} CSD into ${C.inventoryPieces} coins (${p.txid})`);
  }
  // Recent blocks, indexed by txid. (The node's /tx/:id scans the whole chain
  // for a transaction that isn't mined yet, too heavy to poll.)
  const WINDOW = 120, blocks = new Map<number, { hash: string; txids: string[] }>();
  let tipHeight = 0, tipHash = "";
  async function syncBlocks() {
    const tip = await node.tip(); if (tip.hash === tipHash) return;
    const from = Math.max(0, tip.height - WINDOW + 1);
    for (let h = Math.max(from, tipHeight - 6); h <= tip.height; h++) {
      const r = await fetch(`${C.csdApi.replace(/\/$/, "")}/block/height/${h}`); const b = await r.json();
      if (!b?.ok) return; // node mid-reorg; try next tick
      blocks.set(h, { hash: b.hash, txids: (b.txs ?? []).map((x: any) => String(x.txid).toLowerCase()) });
    }
    for (const h of [...blocks.keys()]) if (h < from || h > tip.height) blocks.delete(h);
    tipHeight = tip.height; tipHash = tip.hash;
  }
  function confirmations(txid: Hex): number {
    const id = txid.toLowerCase();
    for (const [h, b] of blocks) if (b.txids.includes(id)) return tipHeight - h + 1;
    return 0;
  }

  // ── EVM ──────────────────────────────────────────────────────────────────
  if ((await pub.readContract({ address: usdc, abi: ERC20, functionName: "allowance", args: [account.address, settlement] })) < 10n ** 15n)
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdc, abi: ERC20, functionName: "approve", args: [settlement, maxUint256] }) });
  async function send(functionName: string, args: any[]): Promise<Hex> {
    await pub.simulateContract({ account, address: settlement, abi: settlementAbi, functionName: functionName as any, args: args as any });
    return wallet.writeContract({ address: settlement, abi: settlementAbi, functionName: functionName as any, args: args as any });
  }
  // Updates a trade as soon as its lock is mined (the loop is the backup)
  function watchLock(t: Trade) {
    pub.waitForTransactionReceipt({ hash: t.lockTx! }).then(r => serial(async () => onLockReceipt(t, r.status === "success")), () => {});
  }
  async function onLockReceipt(t: Trade, ok: boolean) {
    if (t.status !== "locking" && t.status !== "opening") return;
    if (ok) {
      t.lockedAt = String(await view("lockedAt", t.authHash)); t.lockedUntil = String(await view("lockedUntil", t.authHash));
      t.status = t.kind === "buy" ? "locked" : "open";
    } else if (t.kind === "buy") {
      t.status = "lock_failed"; setPool({ ...pool(), usdc: pool().usdc - BigInt(t.poolUsdc) });
      addLoss(BigInt(t.usdcAmount), `buy ${t.authHash}: lock failed after the CSD was sent`);
    } else {
      t.status = "open_failed"; setPool(afterBuy(pool(), BigInt(t.csdAmount), BigInt(t.poolUsdc)));
    }
    save();
  }
  async function publish(t: Trade) {
    if (!C.publishToAon) return;
    try {
      const { buildCsdUsdcAuthorizationObject } = await import("./builders.js");
      await C.publishToAon(await buildCsdUsdcAuthorizationObject({ authorization: t.auth, signature: t.authSig, domain, types: AUTH_TYPES }));
    } catch (e: any) { log(`[mm] AON publish failed for ${t.authHash}: ${e.message}`); }
  }

  // ── user buys CSD ─────────────────────────────────────────────────────────
  async function buy(body: any) {
    const a = body?.authorization; if (!a) bad("MISSING_AUTHORIZATION");
    let auth: ReturnType<typeof authTuple>; try { auth = authTuple(a); } catch { return bad("BAD_AUTHORIZATION"); }
    const authHash = authHashOf(auth);
    if (S.trades[authHash]) return tradeView(S.trades[authHash]);
    const t0 = await chainNow();
    if (auth.sellerUsdcRecipient !== account.address) bad("NOT_FOR_THIS_MARKET_MAKER");
    if (auth.usdc !== usdc) bad("WRONG_TOKEN");
    if (auth.csdGenesisHash.toLowerCase() !== C.csdGenesis.toLowerCase()) bad("WRONG_CSD_CHAIN");
    const conf = Number(auth.minConfirmations);
    if (conf < C.buyConfirmations[0] || conf > C.buyConfirmations[1]) bad("CONFIRMATIONS_OUT_OF_RANGE");
    if (Number(auth.validAfter) > t0) bad("NOT_YET_VALID");
    if (Number(auth.validBefore) < t0 + 600 + conf * 300 + 900) bad("VALID_BEFORE_TOO_SOON");
    if (auth.executorFeeAmount < C.feeUsdc) bad("FEE_TOO_LOW");
    if (auth.usdcAmount + auth.executorFeeAmount > C.maxTradeUsdc || auth.usdcAmount < C.minTradeUsdc) bad("TRADE_SIZE");
    // The difficulty the user signed must let real blocks count, or the bot could never prove the payment
    const tip = await node.tip(); const bits = Number((await node.headerAt(tip.height)).bits);
    if (auth.csdMaxTarget < bitsToTarget(bits)) bad("CSD_MAX_TARGET_TOO_HARD");
    const to = (auth.sellerCsdScriptHash.slice(0, 42)) as Hex;
    if (ownKeys().some(k => k.addr20 === to)) bad("CSD_ADDRESS_IS_OURS");
    const p = pool(), price = quoteBuy(p, auth.csdAmount);
    if (auth.usdcAmount * 10_000n < price * (10_000n - C.priceToleranceBps)) throw new HttpError(409, `PRICE_MOVED:${price}`);
    if (exposure() + auth.usdcAmount > C.maxUnconfirmedUsdc) throw new HttpError(503, "BUSY_TRY_AGAIN_SHORTLY");
    const proof = body.addressProof; if (!proof?.pubKey || !proof?.sig) bad("MISSING_ADDRESS_PROOF");
    const coins = pick(await spendable(), auth.csdAmount + CSD_FEE); void coins;
    const permit = body.permit ? { deadline: BigInt(body.permit.deadline), v: Number(body.permit.v), r: body.permit.r, s: body.permit.s } : undefined;
    const sig = body.signature as Hex;
    let lockTx: Hex;
    try {
      lockTx = permit ? await send("lockCsdUsdcAuthorizationWithPermit", [auth, sig, proof, permit]) : await send("lockCsdUsdcAuthorization", [auth, sig, proof]);
    } catch (e: any) { return bad(`LOCK_REJECTED:${e.shortMessage ?? e.message}`); }
    const t: Trade = { kind: "buy", status: "locking", authHash, createdAt: now(), auth: strAuth(auth), authSig: sig,
      csdAmount: String(auth.csdAmount), usdcAmount: String(auth.usdcAmount), poolUsdc: String(auth.usdcAmount), lockTx };
    S.trades[authHash] = t; setPool(afterBuy(p, auth.csdAmount, auth.usdcAmount)); save();
    try { const pay = await sendCsd(to, auth.csdAmount); t.csdTxid = pay.txid; t.csdTx = txToNodeJson(pay.tx); t.csdSentAt = now(); }
    catch (e: any) { t.error = `CSD send failed, will retry: ${e.message}`; log(`[mm] ${t.error}`); }
    save(); watchLock(t); publish(t);
    log(`[mm] buy ${authHash}: ${Number(auth.csdAmount) / 1e8} CSD for ${Number(auth.usdcAmount) / 1e6} USDC, lock ${lockTx}, csd ${t.csdTxid}`);
    return tradeView(t);
  }

  // ── user sells CSD ────────────────────────────────────────────────────────
  async function sellOpen(body: any) {
    let csd: bigint, recipient: Hex, minOut: bigint;
    try { csd = BigInt(body.csdAmount); recipient = getAddress(body.usdcRecipient); minOut = BigInt(body.minUsdcOut ?? 0); } catch { return bad("BAD_REQUEST"); }
    const p = pool(); let out: bigint; try { out = quoteSell(p, csd); } catch (e: any) { return bad(e.message); }
    const usdcAmount = out - C.feeUsdc;
    if (usdcAmount < minOut) throw new HttpError(409, `PRICE_MOVED:${usdcAmount}`);
    if (usdcAmount > C.maxTradeUsdc || usdcAmount < C.minTradeUsdc) bad("TRADE_SIZE");
    const bal = await pub.readContract({ address: usdc, abi: ERC20, functionName: "balanceOf", args: [account.address] });
    if (bal < usdcAmount) throw new HttpError(503, "NOT_ENOUGH_USDC_RIGHT_NOW");
    const tip = await node.tip(); const bits = Number((await node.headerAt(tip.height)).bits);
    const keyIndex = S.nextKey++; const k = key(keyIndex); const t0 = await chainNow();
    const auth = authTuple({ buyer: account.address, sellerUsdcRecipient: recipient, sellerCsdScriptHash: addr20ToBytes32(k.addr20), csdGenesisHash: C.csdGenesis,
      tradeIntentHash: keccak256(toHex("covenant market maker: sell")), csdAmount: csd, usdc, usdcAmount, minConfirmations: C.sellConfirmations,
      csdMaxTarget: suggestedMaxTarget(bits), executorFeeAmount: 0n, validAfter: t0 - 60, validBefore: t0 + 3 * 3600, nonce: toHex(randomBytes(32)) });
    const authHash = authHashOf(auth);
    const sig = await account.signTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: auth as any });
    let lockTx: Hex;
    try { lockTx = await send("lockCsdUsdcAuthorization", [auth, sig, csdAddressProof(k, authHash)]); }
    catch (e: any) { save(); return bad(`LOCK_REJECTED:${e.shortMessage ?? e.message}`); }
    const t: Trade = { kind: "sell", status: "opening", authHash, createdAt: now(), auth: strAuth(auth), authSig: sig,
      csdAmount: String(csd), usdcAmount: String(usdcAmount), poolUsdc: String(out), lockTx, keyIndex, csdAddr: k.addr20 };
    S.trades[authHash] = t; setPool(afterSell(p, csd, out)); save(); watchLock(t); publish(t);
    log(`[mm] sell ${authHash} opened: ${Number(csd) / 1e8} CSD for ${Number(usdcAmount) / 1e6} USDC, lock ${lockTx}`);
    return tradeView(t);
  }

  async function sellPay(body: any) {
    const t = S.trades[body?.authHash]; if (!t || t.kind !== "sell") throw new HttpError(404, "NO_SUCH_TRADE");
    if (t.csdTxid) return tradeView(t);
    if (t.status === "opening") throw new HttpError(409, "LOCK_NOT_MINED_YET");
    if (t.status !== "open") bad(`TRADE_${t.status.toUpperCase()}`);
    if (Number(t.lockedUntil) - (await chainNow()) < 120) bad("TRADE_EXPIRING");
    let tx: CsdTx; try { tx = txFromNodeJson(body.tx); } catch { return bad("BAD_CSD_TX"); }
    const paid = tx.outputs.filter(o => o.addr20 === t.csdAddr).reduce((s, o) => s + o.value, 0n);
    if (paid < BigInt(t.csdAmount)) bad("CSD_PAYMENT_TOO_SMALL");
    const txid = csdTxid(tx);
    try { await node.submit(tx); }
    catch (e: any) { // one payment may cover several trades: fine if we already broadcast it ourselves
      if (!(String(e.message).includes("already present") && Object.values(S.trades).some(o => o.csdTxid === txid))) return bad(`CSD_TX_REJECTED:${e.message}`);
    }
    t.csdTxid = txid; t.csdTx = txToNodeJson(tx); t.csdSentAt = now(); t.status = "paid"; save();
    if (exposure() + BigInt(t.usdcAmount) <= C.maxUnconfirmedUsdc) { await release(t); t.instant = true; save(); }
    log(`[mm] sell ${t.authHash}: user paid ${txid}${t.instant ? ", released instantly" : ", releasing after 1 CSD block"}`);
    return tradeView(t);
  }

  async function release(t: Trade) {
    const msg = { authHash: t.authHash, sellerUsdcRecipient: getAddress(t.auth.sellerUsdcRecipient), usdcAmount: BigInt(t.usdcAmount),
      csdTxid: t.csdTxid!, lockedAt: BigInt(t.lockedAt!), deadline: BigInt((await chainNow()) + 900) };
    const sig = await account.signTypedData({ domain, types: EARLY_RELEASE_TYPES as any, primaryType: "CsdUsdcEarlyRelease", message: msg as any });
    t.releaseTx = await send("releaseEarly", [authTuple(t.auth), msg, sig]);
    t.status = "released"; save();
  }

  // ── background: settle, release, refund, watch payments ─────────────────
  async function settleBuy(t: Trade) {
    const conf = Number(t.auth.minConfirmations);
    if (confirmations(t.csdTxid!) < conf) return;
    const r = await fetch(`${C.csdApi.replace(/\/$/, "")}/proof/tx/${t.csdTxid}`); const proof = await r.json();
    if (!proof?.ok) return;
    // Enough following headers to reach the work the user signed for
    const work = (target: bigint) => (1n << 256n) / (target + 1n);
    const need = BigInt(conf) * work(BigInt(t.auth.csdMaxTarget));
    let have = work(bitsToTarget(Number(proof.header.bits))); const chainH: any[] = [];
    for (let h = Number(proof.height) + 1; have < need && chainH.length < 120; h++) {
      const hd = await node.headerAt(h); if (!hd?.bits) return; // not enough blocks yet
      chainH.push(hd); have += work(bitsToTarget(Number(hd.bits)));
    }
    if (have < need) return;
    proof.confirmation_chain = chainH;
    t.settleTx = await send("settleCsdUsdc", [authTuple(t.auth), t.authSig, spvProofTuple(proof)]); save();
  }
  const FINAL = new Set(["settled", "lock_failed", "refunded", "done", "expired", "reversed", "open_failed"]);
  async function tick() {
    const tNow = await chainNow();
    await syncBlocks();
    for (const t of Object.values(S.trades)) {
      if (FINAL.has(t.status)) continue;
      try {
        if ((t.status === "locking" || t.status === "opening") && t.lockTx) {
          const r = await pub.getTransactionReceipt({ hash: t.lockTx }).catch(() => null);
          if (r) await onLockReceipt(t, r.status === "success");
        }
        if (t.kind === "buy" && (t.status === "locking" || t.status === "locked")) {
          if (!t.csdTxid) { const pay = await sendCsd(t.auth.sellerCsdScriptHash.slice(0, 42) as Hex, BigInt(t.csdAmount)); t.csdTxid = pay.txid; t.csdTx = txToNodeJson(pay.tx); t.csdSentAt = now(); t.error = undefined; save(); }
          else if (t.status === "locked" && confirmations(t.csdTxid) === 0 && now() - (t.csdSentAt ?? 0) > C.rebroadcastSecs) {
            try { await node.submit(txFromNodeJson(t.csdTx)); } catch {} t.csdSentAt = now(); save(); // dropped from the mempool: rebroadcast
          }
          if (t.status === "locked" && t.settleTx) {
            const r = await pub.getTransactionReceipt({ hash: t.settleTx }).catch(() => null);
            if (r?.status === "success") { t.status = "settled"; save(); log(`[mm] buy ${t.authHash} settled (${t.settleTx})`); continue; }
            if (r) { t.settleTx = undefined; save(); } else continue; // reverted: try again; pending: wait
          }
          if (t.status === "locked") {
            if (!(await view("usdcLocked", t.authHash)) && !(await view("finalizedAuthorization", t.authHash))) {
              t.status = "refunded"; setPool({ ...pool(), usdc: pool().usdc - BigInt(t.poolUsdc) }); addLoss(BigInt(t.usdcAmount), `buy ${t.authHash} refunded before settlement`); save();
            } else await settleBuy(t);
          }
        }
        if (t.kind === "sell") {
          if (t.status === "paid" && confirmations(t.csdTxid!) >= 1) await release(t);
          if (t.status === "released" && t.releaseTx) {
            const r = await pub.getTransactionReceipt({ hash: t.releaseTx }).catch(() => null);
            if (r?.status === "reverted") { log(`[mm] release ${t.releaseTx} reverted; retrying`); t.status = "paid"; t.releaseTx = undefined; save(); }
          }
          if (t.status === "released") {
            const c = confirmations(t.csdTxid!);
            if (c >= C.safeConfirmations) { t.status = "done"; save(); }
            else if (c === 0 && now() - (t.csdSentAt ?? 0) > 2 * C.rebroadcastSecs) {
              try { await node.submit(txFromNodeJson(t.csdTx)); t.csdSentAt = now(); save(); }
              catch (e: any) { if (!String(e.message).includes("already present")) { t.status = "reversed"; addLoss(BigInt(t.usdcAmount), `sell ${t.authHash}: payment ${t.csdTxid} never confirmed (${e.message})`); save(); } }
            }
          }
          if (t.status === "open" && tNow > Number(t.lockedUntil) + 30) {
            // Refund our lock (anyone may; the USDC comes back to us either way)
            if (await view("usdcLocked", t.authHash)) { await send("refundExpiredLock", [authTuple(t.auth)]); }
            else { t.status = "expired"; setPool(afterBuy(pool(), BigInt(t.csdAmount), BigInt(t.poolUsdc))); save(); }
          }
        }
      } catch (e: any) { log(`[mm] ${t.kind} ${t.authHash} (${t.status}): ${e.shortMessage ?? e.message}`); }
    }
    try { await splitInventory(); } catch (e: any) { log(`[mm] split: ${e.message}`); }
  }
  let stopped = false, ticking: Promise<unknown> = Promise.resolve();
  const loop = () => { if (stopped) return; ticking = serial(tick).finally(() => { if (!stopped) setTimeout(loop, C.pollMs); }); };

  // ── market data ───────────────────────────────────────────────────────────
  function tradeView(t: Trade) {
    return { authHash: t.authHash, kind: t.kind, status: t.status, csdAmount: t.csdAmount, usdcAmount: t.usdcAmount, lockTx: t.lockTx,
      csdTxid: t.csdTxid, releaseTx: t.releaseTx, settleTx: t.settleTx, instant: t.instant, csdAddress: t.csdAddr, lockedUntil: t.lockedUntil,
      ...(t.kind === "sell" ? { authorization: t.auth, signature: t.authSig } : {}) };
  }
  async function market() {
    const p = pool(); const tip = await node.tip(); const bits = Number((await node.headerAt(tip.height)).bits);
    const l = ladder(p, 5_000_000n, 8);
    const recent = Object.values(S.trades).filter(t => ["settled", "locked", "locking", "released", "done", "paid"].includes(t.status))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)
      .map(t => ({ side: t.kind, csdAmount: t.csdAmount, usdcAmount: t.usdcAmount, price: String(BigInt(t.usdcAmount) * 100_000_000n / BigInt(t.csdAmount)), at: t.createdAt }));
    return {
      marketMaker: account.address, settlement, usdc, chainId: C.chainId, csdGenesis: C.csdGenesis, domain,
      pool: { usdc: String(p.usdc), csd: String(p.csd) }, mid: String(midPrice(p)), spreadBps: String(C.spreadBps), feeUsdc: String(C.feeUsdc),
      bestAsk: String(quoteBuy(p, 100_000_000n)), bestBid: String(quoteSell(p, 100_000_000n)),
      limits: { minTradeUsdc: String(C.minTradeUsdc), maxTradeUsdc: String(C.maxTradeUsdc), buyConfirmations: C.buyConfirmations, instantRoomUsdc: String(C.maxUnconfirmedUsdc - exposure()) },
      csd: { height: tip.height, bits, suggestedMaxTarget: String(suggestedMaxTarget(bits)) },
      asks: l.asks.map(x => ({ price: String(x.price), csd: String(x.csd) })), bids: l.bids.map(x => ({ price: String(x.price), csd: String(x.csd) })),
      recent,
    };
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const HEX20 = /^(0x)?[0-9a-fA-F]{40}$/, HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;
  async function proxy(path: string, init?: RequestInit) {
    const r = await fetch(`${C.csdApi.replace(/\/$/, "")}${path}`, init);
    return r.json();
  }
  async function route(req: http.IncomingMessage, body: any): Promise<any> {
    const u = new URL(req.url ?? "/", "http://x"), p = u.pathname, m = req.method;
    if (m === "GET" && p === "/api/market") return market();
    if (m === "GET" && p.startsWith("/api/trade/")) { const t = S.trades[p.slice(11)]; if (!t) throw new HttpError(404, "NO_SUCH_TRADE"); return tradeView(t); }
    if (m === "POST" && p === "/api/buy") return serial(() => buy(body));
    if (m === "POST" && p === "/api/sell/open") return serial(() => sellOpen(body));
    if (m === "POST" && p === "/api/sell/pay") return serial(() => sellPay(body));
    // CSD node, for the in-site wallet
    let g: RegExpMatchArray | null;
    if (m === "GET" && p === "/api/csd/tip") return proxy("/tip");
    if (m === "GET" && (g = p.match(/^\/api\/csd\/utxos\/([0-9a-fA-Fx]+)$/)) && HEX20.test(g[1])) return proxy(`/utxos/${g[1].replace(/^0x/, "")}?available=true`);
    if (m === "GET" && (g = p.match(/^\/api\/csd\/address\/([0-9a-fA-Fx]+)\/activity$/)) && HEX20.test(g[1])) return proxy(`/address/${g[1].replace(/^0x/, "")}/activity?limit=50`);
    if (m === "GET" && (g = p.match(/^\/api\/csd\/tx\/([0-9a-fA-Fx]+)$/)) && HEX32.test(g[1])) return proxy(`/tx/${g[1]}`);
    if (m === "GET" && (g = p.match(/^\/api\/csd\/block\/height\/(\d{1,10})$/))) return proxy(`/block/height/${g[1]}`);
    if (m === "POST" && p === "/api/csd/tx/submit") { let tx: CsdTx; try { tx = txFromNodeJson(body?.tx); } catch { return bad("BAD_CSD_TX"); }
      return proxy("/tx/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: txToNodeJson(tx) }) }); }
    throw new HttpError(404, "NOT_FOUND");
  }
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin ?? "";
    const allow = C.allowedOrigins.includes("*") ? "*" : C.allowedOrigins.includes(origin) ? origin : "";
    const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store", vary: "origin" };
    if (allow) Object.assign(headers, { "access-control-allow-origin": allow, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" });
    if (req.method === "OPTIONS") { res.writeHead(204, headers); return res.end(); }
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 65_536) { res.writeHead(413, headers); return res.end(); } }
    try {
      const body = raw ? JSON.parse(raw) : undefined;
      const out = await route(req, body);
      res.writeHead(200, headers); res.end(JSON.stringify(out, (_, v) => typeof v === "bigint" ? String(v) : v));
    } catch (e: any) {
      const code = e instanceof HttpError ? e.code : 500;
      if (code === 500) log(`[mm] ${req.method} ${req.url}: ${e.stack ?? e}`);
      res.writeHead(code, headers); res.end(JSON.stringify({ error: e instanceof HttpError ? e.message : "INTERNAL_ERROR" }));
    }
  });
  await new Promise<void>(r => server.listen(C.port, C.host ?? "127.0.0.1", r));
  for (const t of Object.values(S.trades)) if ((t.status === "locking" || t.status === "opening") && t.lockTx) watchLock(t);
  loop();
  log(`[mm] ${account.address} listening on ${C.host ?? "127.0.0.1"}:${C.port}; pool ${Number(pool().usdc) / 1e6} USDC + ${Number(pool().csd) / 1e8} CSD, CSD inventory ${inventory.addr20}`);

  return {
    server, address: account.address, csdInventoryAddress: inventory.addr20, state: () => S, tick: () => serial(tick),
    async stop() { stopped = true; await ticking.catch(() => {}); await new Promise(r => server.close(r)); },
  };
}
