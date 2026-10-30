// CSD/USDC market maker: an always-available counterparty for covenant.market.
//
// Prices come from its pool (USDC held ÷ CSD held, plus a spread; src/pool.ts).
// Both directions feel like an ordinary swap:
//
//   User buys CSD:  the user signs (gasless) an authorization, a short-lived USDC
//     permit and a CSD address proof. The bot submits the lock and sends the CSD
//     as soon as the lock is on Ethereum (~one block). The user's USDC only
//     reaches the bot once the CSD payment is proven on-chain (settleCsdUsdc,
//     after the user's chosen confirmations), otherwise it is refunded, so the
//     user takes no risk.
//
//   User sells CSD: the bot locks its USDC for the trade (a fresh CSD address of
//     its own, with proof), the user's wallet checks the lock on-chain and then
//     hands the bot its signed CSD payment. The bot checks the payment's coins
//     and fee, broadcasts it and releases the USDC straight away (releaseEarly),
//     without waiting for a CSD block. The bot carries the risk that the payment
//     is double-spent, so instant releases are limited (in flight, per recipient,
//     and a total loss budget); otherwise it waits for one CSD block.
//
// No custody of user funds and no consensus change: the bot is a trader with a
// key, CSD and USDC. Its HTTP API also proxies a few CSD node calls so the
// in-site CSD wallet can reach a node over HTTPS.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, defineChain, getAddress, hashTypedData, http as viemHttp,
  keccak256, maxUint256, toHex, type Hex,
} from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import {
  csdNode, deriveCsdWallet, buildPayment, csdTxid, csdAddressProof, addr20ToBytes32, bitsToTarget, bytesToHex, hash160,
  suggestedMaxTarget, txToNodeJson, txFromNodeJson, csdSaleRequestDigest, csdSignerAddress, type CsdKey, type CsdTx, type CsdUtxo,
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
  trustProxy?: boolean;         // behind Caddy: take the client IP from X-Forwarded-For
  broadcastApis?: string[];     // more CSD nodes to broadcast payments to (makes double spends harder)
  initialPool: { usdc: bigint; csd: bigint };
  spreadBps?: bigint;           // default 300 (3%)
  feeUsdc?: bigint;             // per trade, covers gas; default 0.25 USDC
  maxTradeUsdc?: bigint;        // default 30 USDC (the contract's cap), fee included
  minTradeUsdc?: bigint;        // default 1 USDC
  maxUnconfirmedUsdc?: bigint;  // default 60 USDC: released before the CSD payment has confirmations
  maxInstantPerRecipientUsdc?: bigint; // default 30 USDC per hour per USDC recipient
  maxLossUsdc?: bigint;         // default 30 USDC: past this total loss, no more instant releases
  minUserCsdFee?: bigint;       // default 1000 base units: a seller's payment must pay at least this fee
  buyConfirmations?: [number, number];  // accepted range for users' buys; default [10, 30]
  sellConfirmations?: number;   // what the bot signs when it buys; default 20 (it releases early anyway)
  safeConfirmations?: number;   // when a trusted payment stops counting as exposure; default 3
  priceToleranceBps?: bigint;   // how far a signed price may lag the pool; default 50 (0.5%)
  sellPayWindowSecs?: number;   // a seller must pay within this long of the lock; default 180
  maxOpenUnpaid?: number;       // sells waiting for payment at once; default 3
  maxUnpaidPerHour?: number;    // sells left unpaid in the last hour before sells pause; default 2
  maxUnpaidPerDay?: number;     // ... in the last day; default 10
  coinBanSecs?: number;         // coins named in a sale left unpaid can't open another for this long; default 86400
  maxRequestsPerMinute?: number; // per client, for the trading endpoints; default 20
  inventoryPieces?: number;     // CSD is kept split into this many coins; default 20
  pollMs?: number;              // default 5000
  rebroadcastSecs?: number;     // resend a CSD payment not mined after this long; default 900
  nodeTimeoutMs?: number;       // default 10000
  publishToAon?: (obj: any) => Promise<void>;
  log?: (...a: any[]) => void;
};

type TradeStatus =
  | "locking" | "locked" | "settled" | "lock_failed" | "refunded"                                     // user buys
  | "opening" | "open" | "paid" | "released" | "done" | "expired" | "reversed" | "open_failed";      // user sells
type Trade = {
  kind: "buy" | "sell"; status: TradeStatus; authHash: Hex; createdAt: number;
  auth: Record<string, string>; authSig: Hex;
  csdAmount: string; usdcAmount: string; poolUsdc: string; // poolUsdc: what moves into or out of the pool
  lockTx?: Hex; lockedAt?: string; lockedUntil?: string;
  addressProof?: any; permit?: any;                         // buy: what the lock needs
  csdTxid?: Hex; csdTx?: any; csdSentAt?: number;           // buy: our payment; sell: the user's
  keyIndex?: number; csdAddr?: Hex; ip?: string;            // sell: our receiving key, who opened it
  coins?: string[]; poolMoved?: boolean;                    // sell: the coins the seller will pay with ("txid:vout")
  payBy?: number; unpaidAt?: number; paidAt?: number;       // sell: payment deadline; when it lapsed
  releaseTx?: Hex; settleTx?: Hex; instant?: boolean; direct?: boolean; error?: string;
};
type State = { pool: { usdc: string; csd: string }; nextKey: number; trades: Record<string, Trade>; lossUsdc: string; lastSplit?: number };

const ERC20 = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
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
    maxUnconfirmedUsdc: 60_000_000n, maxInstantPerRecipientUsdc: 30_000_000n, maxLossUsdc: 30_000_000n, minUserCsdFee: 1000n,
    buyConfirmations: [10, 30] as [number, number], sellConfirmations: 20, safeConfirmations: 3, priceToleranceBps: 50n,
    sellPayWindowSecs: 180, maxOpenUnpaid: 3, maxUnpaidPerHour: 2, maxUnpaidPerDay: 10, coinBanSecs: 86400, maxRequestsPerMinute: 20,
    inventoryPieces: 20, pollMs: 5000, rebroadcastSecs: 900, nodeTimeoutMs: 10_000, broadcastApis: [] as string[], trustProxy: false,
    log: console.log, ...cfg,
  };
  const log = C.log;
  const chain = defineChain({ id: C.chainId, name: `evm-${C.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [C.rpcUrl] } } });
  const account = privateKeyToAccount(C.privateKey, { nonceManager });
  const pub = createPublicClient({ chain, transport: viemHttp(C.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: viemHttp(C.rpcUrl) });
  const settlement = getAddress(C.settlement), usdc = getAddress(C.usdc);
  const domain = { name: "AON CSD/USDC", version: "4", chainId: C.chainId, verifyingContract: settlement } as const;
  const AUTH_TYPES = csdUsdcNamespace.types!() as any;
  const tfetch = ((u: any, i: any = {}) => fetch(u, { ...i, signal: AbortSignal.timeout(C.nodeTimeoutMs) })) as typeof fetch;
  const csdBase = C.csdApi.replace(/\/$/, "");
  const node = csdNode(csdBase, tfetch);
  const extraNodes = C.broadcastApis.map(b => csdNode(b, tfetch));
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
  // Quotes count buys whose lock is still being mined, so two buys can't get the same price
  const quotePool = (): Pool => Object.values(S.trades).filter(t => t.kind === "buy" && t.status === "locking")
    .reduce((p, t) => afterBuy(p, BigInt(t.csdAmount), BigInt(t.poolUsdc)), pool());
  // Sale quotes count sales still waiting for payment, so simultaneous sellers get the curve's next
  // price rather than all the same one. (Buy quotes don't, so opening sales can't push them down.)
  const sellQuotePool = (): Pool => Object.values(S.trades).filter(t => t.kind === "sell" && !t.poolMoved
      && ((t.status === "opening" || t.status === "open") && !t.unpaidAt || t.status === "paid" || t.status === "released"))
    .reduce((p, t) => afterSell(p, BigInt(t.csdAmount), BigInt(t.poolUsdc)), pool());
  const addLoss = (x: bigint, why: string) => { S.lossUsdc = String(BigInt(S.lossUsdc) + x); log(`[mm] LOSS ${Number(x) / 1e6} USDC: ${why}`); };
  // USDC already released for CSD payments that aren't confirmed yet
  const exposure = () => Object.values(S.trades).reduce((s, t) => s + (t.kind === "sell" && t.status === "released" ? BigInt(t.usdcAmount) : 0n), 0n);

  // one trade at a time: coins, nonces and the pool stay consistent
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = queue.then(fn); queue = r.catch(() => {}); return r; };

  const now = () => Math.floor(Date.now() / 1000);
  // The difficulty to sign: 3/4 of the current one, and never stricter than the blocks being mined
  const signTarget = (bits: number) => { const s = suggestedMaxTarget(bits), t = bitsToTarget(bits); return s > t ? s : t; };
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
  // Broadcasts to the main node (must accept) and, best effort, to the others
  async function broadcast(tx: CsdTx) {
    await node.submit(tx);
    for (const n of extraNodes) n.submit(tx).catch(() => {});
  }
  const explicitlyRejected = (e: any) => String(e?.message ?? e).startsWith("CSD_SUBMIT_FAILED") && !String(e?.message).includes("already present");
  // Is it in a block? Recent blocks first; a full lookup (slow on the node) only when needed
  async function mined(txid: Hex, deep = false): Promise<boolean> {
    if (confirmations(txid) > 0) return true;
    if (!deep) return false;
    try { return !!(await node.tx(txid))?.ok; } catch { return false; }
  }
  // Sends a buy's CSD. The payment is saved before it's broadcast, so a network
  // error can never lead to paying twice: it's rebuilt only when the node
  // explicitly rejected it and it isn't in a block.
  async function sendBuyCsd(t: Trade) {
    if (t.csdTx) {
      try { await broadcast(txFromNodeJson(t.csdTx)); t.csdSentAt = now(); save(); return; }
      catch (e: any) {
        if (!explicitlyRejected(e) || await mined(t.csdTxid!, true)) { t.csdSentAt = now(); save(); return; }
        log(`[mm] buy ${t.authHash}: payment ${t.csdTxid} rejected (${e.message}); building a new one`);
        t.csdTx = undefined; t.csdTxid = undefined;
      }
    }
    const p = buildPayment({ utxos: pick(await spendable(), BigInt(t.csdAmount) + CSD_FEE), to: [{ value: BigInt(t.csdAmount), addr20: t.auth.sellerCsdScriptHash.slice(0, 42) as Hex }], change: inventory.addr20, fee: CSD_FEE });
    t.csdTxid = p.txid; t.csdTx = txToNodeJson(p.tx); t.csdSentAt = now(); save();
    try { await broadcast(p.tx); t.error = undefined; } catch (e: any) { t.error = `CSD broadcast failed, will retry: ${e.message}`; log(`[mm] ${t.error}`); }
    save();
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
    await broadcast(p.tx); S.lastSplit = now(); save();
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
      const b = await (await tfetch(`${csdBase}/block/height/${h}`)).json();
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
  // Acts as soon as a lock is mined (the loop is the backup)
  function watchLock(t: Trade) {
    if (!t.lockTx) return;
    pub.waitForTransactionReceipt({ hash: t.lockTx }).then(() => serial(() => checkLock(t)), () => {});
  }
  // What counts is the contract, not our transaction's receipt: someone may
  // have submitted the same lock first (ours then reverts), or the user may
  // have made it fail. CSD is only sent once the USDC is really locked.
  async function checkLock(t: Trade) {
    if (t.status !== "locking" && t.status !== "opening") return;
    const [locked, fin] = await Promise.all([view("usdcLocked", t.authHash), view("finalizedAuthorization", t.authHash)]);
    if (locked || fin) {
      t.lockedAt = String(await view("lockedAt", t.authHash)); t.lockedUntil = String(await view("lockedUntil", t.authHash));
      if (t.kind === "buy") {
        t.status = "locked"; setPool(afterBuy(pool(), BigInt(t.csdAmount), BigInt(t.poolUsdc))); save();
        await sendBuyCsd(t);
        log(`[mm] buy ${t.authHash}: locked; sent ${Number(t.csdAmount) / 1e8} CSD (${t.csdTxid})`);
      } else { t.status = "open"; t.payBy = now() + C.sellPayWindowSecs; save(); }
      return;
    }
    const r = t.lockTx ? await pub.getTransactionReceipt({ hash: t.lockTx }).catch(() => null) : null;
    const pending = !r && t.lockTx ? await pub.getTransaction({ hash: t.lockTx }).then(() => true, () => false) : false;
    if (r || (!pending && now() - t.createdAt > 600)) { t.status = t.kind === "buy" ? "lock_failed" : "open_failed"; save(); log(`[mm] ${t.kind} ${t.authHash}: lock didn't happen; nothing sent`); }
  }
  async function publish(t: Trade) {
    if (!C.publishToAon) return;
    try {
      const { buildCsdUsdcAuthorizationObject } = await import("./builders.js");
      await C.publishToAon(await buildCsdUsdcAuthorizationObject({ authorization: t.auth, signature: t.authSig, domain, types: AUTH_TYPES }));
    } catch (e: any) { log(`[mm] AON publish failed for ${t.authHash}: ${e.message}`); }
  }

  // ── user buys CSD ─────────────────────────────────────────────────────────
  async function buy(body: any, ip: string) {
    const a = body?.authorization; if (!a) bad("MISSING_AUTHORIZATION");
    let auth: ReturnType<typeof authTuple>; try { auth = authTuple(a); } catch { return bad("BAD_AUTHORIZATION"); }
    const authHash = authHashOf(auth);
    if (S.trades[authHash]) return tradeView(S.trades[authHash]);
    // One buy at a time per buyer and per client, with the USDC actually there: otherwise one
    // balance could back many locks that all but one revert, at the bot's expense
    if (Object.values(S.trades).some(t => t.kind === "buy" && t.status === "locking" && (t.auth.buyer.toLowerCase() === auth.buyer.toLowerCase() || t.ip === ip)))
      throw new HttpError(429, "FINISH_YOUR_OTHER_BUY");
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
    let price: bigint; try { price = quoteBuy(quotePool(), auth.csdAmount); } catch (e: any) { return bad(e.message); }
    if (auth.usdcAmount * 10_000n < price * (10_000n - C.priceToleranceBps)) throw new HttpError(409, `PRICE_MOVED:${price}`);
    const proof = body.addressProof; if (!proof?.pubKey || !proof?.sig) bad("MISSING_ADDRESS_PROOF");
    const buyerBal = await pub.readContract({ address: usdc, abi: ERC20, functionName: "balanceOf", args: [auth.buyer] });
    if (buyerBal < auth.usdcAmount + auth.executorFeeAmount) bad("NOT_ENOUGH_USDC");
    const pending = Object.values(S.trades).filter(t => t.kind === "buy" && t.status === "locking").reduce((s, t) => s + BigInt(t.csdAmount) + CSD_FEE, 0n);
    pick(await spendable(), pending + auth.csdAmount + CSD_FEE); // enough CSD for this and the buys still locking
    const permit = body.permit ? { deadline: BigInt(body.permit.deadline), v: Number(body.permit.v), r: body.permit.r, s: body.permit.s } : undefined;
    const sig = body.signature as Hex;
    // Saved before sending, so a crash can't lose track of a lock
    const t: Trade = { kind: "buy", status: "locking", authHash, createdAt: now(), auth: strAuth(auth), authSig: sig,
      csdAmount: String(auth.csdAmount), usdcAmount: String(auth.usdcAmount), poolUsdc: String(auth.usdcAmount), ip };
    S.trades[authHash] = t; save();
    try {
      t.lockTx = permit ? await send("lockCsdUsdcAuthorizationWithPermit", [auth, sig, proof, permit]) : await send("lockCsdUsdcAuthorization", [auth, sig, proof]);
    } catch (e: any) { delete S.trades[authHash]; save(); return bad(`LOCK_REJECTED:${e.shortMessage ?? e.message}`); }
    save(); watchLock(t); publish(t);
    log(`[mm] buy ${authHash}: ${Number(auth.csdAmount) / 1e8} CSD for ${Number(auth.usdcAmount) / 1e6} USDC, lock ${t.lockTx}`);
    return tradeView(t);
  }

  // ── user sells CSD ────────────────────────────────────────────────────────
  // Opening costs the bot two Ethereum transactions (lock, later refund) if the
  // seller never pays, so opens are limited per client and overall, and the
  // pool only moves once the CSD is paid.
  function sellOpenLimits(ip: string) {
    const sells = Object.values(S.trades).filter(t => t.kind === "sell");
    const waiting = sells.filter(t => (t.status === "opening" || t.status === "open") && !t.unpaidAt);
    if (waiting.some(t => t.ip === ip)) throw new HttpError(429, "FINISH_YOUR_OTHER_SALE");
    if (waiting.length >= C.maxOpenUnpaid) throw new HttpError(503, "BUSY_TRY_AGAIN_SHORTLY");
    const lapsed = sells.filter(t => t.unpaidAt);
    if (lapsed.filter(t => t.unpaidAt! > now() - 3600).length >= C.maxUnpaidPerHour
      || lapsed.filter(t => t.unpaidAt! > now() - 86400).length >= C.maxUnpaidPerDay) throw new HttpError(503, "SELLS_PAUSED");
  }
  // The coins a sale request names: owned by its signers, confirmed, not spent in the mempool,
  // not backing another sale, and not from a sale left unpaid recently
  async function checkSaleCoins(body: any, csd: bigint, recipient: Hex): Promise<string[]> {
    const coins = Array.isArray(body.coins) ? body.coins.map((c: any) => ({ txid: String(c?.txid ?? "").toLowerCase() as Hex, vout: Number(c?.vout) })) : [];
    if (!coins.length || coins.length > 50 || coins.some((c: any) => !/^0x[0-9a-f]{64}$/.test(c.txid) || !Number.isSafeInteger(c.vout) || c.vout < 0)) bad("NAME_YOUR_COINS");
    const validUntil = Number(body.validUntil);
    if (!(validUntil >= now() && validUntil <= now() + 600)) bad("REQUEST_EXPIRED");
    const ids = coins.map((c: any) => `${c.txid}:${c.vout}`);
    if (new Set(ids).size !== ids.length) bad("NAME_YOUR_COINS");
    const digest = csdSaleRequestDigest({ csdAmount: csd, usdcRecipient: recipient, validUntil, coins });
    const signers = new Set((Array.isArray(body.proofs) ? body.proofs : []).slice(0, 10).map((p: any) => csdSignerAddress(digest, p?.sig)).filter(Boolean) as Hex[]);
    let total = 0n; const covered = new Set<string>();
    for (const owner of signers) for (const u of await node.utxosAt(owner)) { const id = `${u.txid}:${u.vout}`; if (ids.includes(id) && !covered.has(id)) { covered.add(id); total += u.value; } }
    if (covered.size !== ids.length) bad("COINS_NOT_YOURS_OR_SPENT");
    if (total < csd + C.minUserCsdFee) bad("NOT_ENOUGH_COINS");
    for (const t of Object.values(S.trades)) {
      if (t.kind !== "sell" || !t.coins?.some(c => ids.includes(c))) continue;
      if (t.unpaidAt && t.unpaidAt > now() - C.coinBanSecs) throw new HttpError(429, "COINS_FROM_AN_UNPAID_SALE");
      if (!t.unpaidAt && ["opening", "open", "paid"].includes(t.status)) throw new HttpError(409, "COINS_IN_USE");
    }
    return ids;
  }
  async function sellOpen(body: any, ip: string) {
    let csd: bigint, recipient: Hex, minOut: bigint;
    try { csd = BigInt(body.csdAmount); recipient = getAddress(body.usdcRecipient); minOut = BigInt(body.minUsdcOut ?? 0); } catch { return bad("BAD_REQUEST"); }
    const coins = await checkSaleCoins(body, csd, recipient);
    sellOpenLimits(ip);
    let out: bigint; try { out = quoteSell(sellQuotePool(), csd); } catch (e: any) { return bad(e.message); }
    const usdcAmount = out - C.feeUsdc;
    if (usdcAmount < minOut) throw new HttpError(409, `PRICE_MOVED:${usdcAmount}`);
    if (usdcAmount > C.maxTradeUsdc || usdcAmount < C.minTradeUsdc) bad("TRADE_SIZE");
    const bal = await pub.readContract({ address: usdc, abi: ERC20, functionName: "balanceOf", args: [account.address] });
    if (bal < usdcAmount) throw new HttpError(503, "NOT_ENOUGH_USDC_RIGHT_NOW");
    const tip = await node.tip(); const bits = Number((await node.headerAt(tip.height)).bits);
    const keyIndex = S.nextKey++; const k = key(keyIndex); const t0 = await chainNow();
    // Many confirmations: the bot releases early anyway, and it makes faking a proof against its own locks expensive
    const auth = authTuple({ buyer: account.address, sellerUsdcRecipient: recipient, sellerCsdScriptHash: addr20ToBytes32(k.addr20), csdGenesisHash: C.csdGenesis,
      tradeIntentHash: keccak256(toHex("covenant market maker: sell")), csdAmount: csd, usdc, usdcAmount, minConfirmations: C.sellConfirmations,
      csdMaxTarget: bitsToTarget(bits), executorFeeAmount: 0n, validAfter: t0 - 60, validBefore: t0 + 4 * 3600, nonce: toHex(randomBytes(32)) });
    const authHash = authHashOf(auth);
    const sig = await account.signTypedData({ domain, types: AUTH_TYPES, primaryType: "CsdUsdcAuthorization", message: auth as any });
    const t: Trade = { kind: "sell", status: "opening", authHash, createdAt: now(), auth: strAuth(auth), authSig: sig,
      csdAmount: String(csd), usdcAmount: String(usdcAmount), poolUsdc: String(out), keyIndex, csdAddr: k.addr20, ip, coins };
    S.trades[authHash] = t; save();
    try { t.lockTx = await send("lockCsdUsdcAuthorization", [auth, sig, csdAddressProof(k, authHash)]); }
    catch (e: any) { delete S.trades[authHash]; save(); return bad(`LOCK_REJECTED:${e.shortMessage ?? e.message}`); }
    save(); watchLock(t); publish(t);
    log(`[mm] sell ${authHash} opened: ${Number(csd) / 1e8} CSD for ${Number(usdcAmount) / 1e6} USDC, lock ${t.lockTx}`);
    return tradeView(t);
  }

  // The seller's payment: confirmed coins (not already spent in the mempool),
  // a real fee, and enough paid to the trade's address
  async function checkUserPayment(t: Trade, tx: CsdTx) {
    const paid = tx.outputs.filter(o => o.addr20 === t.csdAddr).reduce((s, o) => s + o.value, 0n);
    if (paid < BigInt(t.csdAmount)) bad("CSD_PAYMENT_TOO_SMALL");
    const seen = new Set<string>(), coins = new Map<string, { txid: Hex; vout: number; value: bigint }[]>();
    let inSum = 0n;
    for (const i of tx.inputs) {
      const s = i.scriptSig, op = `${i.prevout.txid.toLowerCase()}:${i.prevout.vout}`;
      if (s.length !== 99 || s[0] !== 64 || s[65] !== 33 || seen.has(op)) bad("BAD_CSD_TX");
      seen.add(op);
      const owner = bytesToHex(hash160(s.slice(66)));
      if (!coins.has(owner)) coins.set(owner, await node.utxosAt(owner));
      const c = coins.get(owner)!.find(u => u.txid === i.prevout.txid.toLowerCase() && u.vout === i.prevout.vout);
      if (!c) bad("CSD_COINS_NOT_AVAILABLE");
      inSum += c!.value;
    }
    const outSum = tx.outputs.reduce((s, o) => s + o.value, 0n);
    if (inSum - outSum < C.minUserCsdFee) bad("CSD_FEE_TOO_LOW");
    if (t.coins && !t.coins.every(c => seen.has(c))) bad("PAY_WITH_THE_COINS_YOU_NAMED");
  }
  // Instant only within the limits; otherwise the USDC is released after one CSD block
  function instantAllowed(t: Trade) {
    const amt = BigInt(t.usdcAmount), to = t.auth.sellerUsdcRecipient.toLowerCase();
    const recent = Object.values(S.trades).filter(o => o.kind === "sell" && o.instant && o.auth.sellerUsdcRecipient.toLowerCase() === to && (o.paidAt ?? 0) > now() - 3600)
      .reduce((s, o) => s + BigInt(o.usdcAmount), 0n);
    return BigInt(S.lossUsdc) < C.maxLossUsdc && exposure() + amt <= C.maxUnconfirmedUsdc && recent + amt <= C.maxInstantPerRecipientUsdc;
  }
  async function sellPay(body: any) {
    const t = S.trades[body?.authHash]; if (!t || t.kind !== "sell") throw new HttpError(404, "NO_SUCH_TRADE");
    if (t.csdTxid) return tradeView(t);
    if (t.status === "opening") { await checkLock(t); if (t.status === "opening") throw new HttpError(409, "LOCK_NOT_MINED_YET"); }
    if (t.status !== "open") bad(`TRADE_${t.status.toUpperCase()}`);
    if (t.unpaidAt || now() > (t.payBy ?? 0)) bad("TOO_LATE_TO_PAY");
    if (Number(t.lockedUntil) - (await chainNow()) < 600) bad("TRADE_EXPIRING");
    let tx: CsdTx; try { tx = txFromNodeJson(body.tx); } catch { return bad("BAD_CSD_TX"); }
    const txid = csdTxid(tx);
    // One payment, one sale: a payment can't be checked once and then reused after it's been double-spent
    if (Object.values(S.trades).some(o => o.kind === "sell" && o.csdTxid === txid)) bad("PAYMENT_ALREADY_USED");
    await checkUserPayment(t, tx);
    try { await broadcast(tx); } catch (e: any) { return bad(`CSD_TX_REJECTED:${e.message}`); }
    // The pool moves once the payment is in a block (the loop), not now: a double-spent
    // payment then never moves the price
    t.csdTxid = txid; t.csdTx = txToNodeJson(tx); t.csdSentAt = now(); t.paidAt = now(); t.status = "paid"; save();
    if (instantAllowed(t)) {
      t.instant = true; save();
      try { await release(t); } catch (e: any) { log(`[mm] sell ${t.authHash}: release failed, will retry: ${e.shortMessage ?? e.message}`); }
    }
    log(`[mm] sell ${t.authHash}: user paid ${txid}${t.instant ? ", released instantly" : ", releasing after 1 CSD block"}`);
    return tradeView(t);
  }

  async function release(t: Trade) {
    const [locked, fin] = await Promise.all([view("usdcLocked", t.authHash), view("finalizedAuthorization", t.authHash)]);
    if (fin) { t.status = "done"; save(); return; } // the seller settled it themselves
    if (!locked) {
      // Our lock was refunded (anyone may, once it expires) after the seller paid: pay them directly.
      // Marked first, so a crash mid-way can never pay twice (it's then left for the operator to check).
      if (t.direct) { log(`[mm] sell ${t.authHash}: a direct payment may already have been sent; check ${t.auth.sellerUsdcRecipient} by hand`); return; }
      t.direct = true; save();
      t.releaseTx = await wallet.writeContract({ address: usdc, abi: ERC20, functionName: "transfer", args: [getAddress(t.auth.sellerUsdcRecipient), BigInt(t.usdcAmount)] });
      t.status = "released"; save();
      log(`[mm] sell ${t.authHash}: lock was refunded; paid the seller directly (${t.releaseTx})`);
      return;
    }
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
    const proof = await (await tfetch(`${csdBase}/proof/tx/${t.csdTxid}`)).json();
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
      if (FINAL.has(t.status)) {
        // A lock that looked failed but got mined after all (someone rebroadcast it): honour it
        if (t.kind === "buy" && t.status === "lock_failed" && now() - t.createdAt < 3 * 3600 && await view("usdcLocked", t.authHash).catch(() => false)) {
          t.status = "locking"; await checkLock(t);
        }
        continue;
      }
      try {
        if (t.status === "locking" || t.status === "opening") {
          const r = t.lockTx ? await pub.getTransactionReceipt({ hash: t.lockTx }).catch(() => null) : null;
          if (r || (!t.lockTx && now() - t.createdAt > 120)) await checkLock(t);
        }
        if (t.kind === "buy" && t.status === "locked") {
          // Someone else settled it (anyone may submit the proof): we were paid all the same
          if (await view("finalizedAuthorization", t.authHash)) { t.status = "settled"; save(); continue; }
          if (!t.csdTxid || (confirmations(t.csdTxid) === 0 && now() - (t.csdSentAt ?? 0) > C.rebroadcastSecs)) await sendBuyCsd(t);
          if (t.settleTx) {
            const r = await pub.getTransactionReceipt({ hash: t.settleTx }).catch(() => null);
            if (r?.status === "success") { t.status = "settled"; save(); log(`[mm] buy ${t.authHash} settled (${t.settleTx})`); continue; }
            if (r) { t.settleTx = undefined; save(); } else continue; // reverted: try again; pending: wait
          }
          if (!(await view("usdcLocked", t.authHash))) {
            t.status = "refunded"; setPool({ ...pool(), usdc: pool().usdc - BigInt(t.poolUsdc) });
            addLoss(BigInt(t.usdcAmount), `buy ${t.authHash} refunded before settlement`); save();
          } else if (tNow > Number(t.lockedUntil) + 30) {
            // Couldn't prove our payment in time: refund the buyer so their USDC doesn't sit there
            await send("refundExpiredLock", [authTuple(t.auth)]);
          } else await settleBuy(t);
        }
        if (t.kind === "sell") {
          if (t.status === "open" && !t.unpaidAt && now() > (t.payBy ?? 0)) { t.unpaidAt = now(); save(); }
          // The pool counts the CSD once it's in a block
          if ((t.status === "paid" || t.status === "released") && !t.poolMoved && confirmations(t.csdTxid!) >= 1) {
            t.poolMoved = true; setPool(afterSell(pool(), BigInt(t.csdAmount), BigInt(t.poolUsdc))); save();
          }
          if (t.status === "paid" && confirmations(t.csdTxid!) >= 1) await release(t);
          // Paid but never mined: once the lock expires, take the USDC back (if the payment
          // turns up later, release() pays the seller directly); give up after a day
          if (t.status === "paid" && confirmations(t.csdTxid!) === 0) {
            if (now() - (t.csdSentAt ?? 0) > C.rebroadcastSecs) { try { await broadcast(txFromNodeJson(t.csdTx)); } catch {} t.csdSentAt = now(); save(); }
            if (tNow > Number(t.lockedUntil) + 30 && await view("usdcLocked", t.authHash)) await send("refundExpiredLock", [authTuple(t.auth)]);
            else if (tNow > Number(t.lockedUntil) + 86400 && !(await mined(t.csdTxid!, true))) { t.status = "expired"; save(); }
          }
          if (t.status === "released" && t.releaseTx) {
            const r = await pub.getTransactionReceipt({ hash: t.releaseTx }).catch(() => null);
            if (r?.status === "reverted") { log(`[mm] release ${t.releaseTx} reverted; retrying`); t.status = "paid"; t.releaseTx = undefined; save(); }
          }
          if (t.status === "released") {
            const c = confirmations(t.csdTxid!);
            if (c >= C.safeConfirmations) { t.status = "done"; save(); }
            else if (c === 0 && now() - (t.csdSentAt ?? 0) > 2 * C.rebroadcastSecs) {
              try { await broadcast(txFromNodeJson(t.csdTx)); t.csdSentAt = now(); save(); }
              catch (e: any) {
                if (await mined(t.csdTxid!, true)) { t.status = "done"; save(); }
                else if (explicitlyRejected(e)) {
                  // The USDC is gone and the CSD never came: the pool loses the USDC
                  t.status = "reversed"; setPool({ ...pool(), usdc: pool().usdc - BigInt(t.poolUsdc) });
                  addLoss(BigInt(t.usdcAmount), `sell ${t.authHash}: payment ${t.csdTxid} was double-spent (${e.message})`); save();
                }
              }
            }
          }
          if (t.status === "open" && tNow > Number(t.lockedUntil) + 30) {
            // Refund our lock (anyone may; the USDC comes back to us either way)
            if (await view("usdcLocked", t.authHash)) { await send("refundExpiredLock", [authTuple(t.auth)]); }
            else { t.status = "expired"; save(); }
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
      csdTxid: t.csdTxid, releaseTx: t.releaseTx, settleTx: t.settleTx, instant: t.instant, csdAddress: t.csdAddr, lockedUntil: t.lockedUntil, payBy: t.payBy,
      ...(t.kind === "sell" ? { authorization: t.auth, signature: t.authSig } : {}) };
  }
  async function market() {
    const p = quotePool(); const tip = await node.tip(); const bits = Number((await node.headerAt(tip.height)).bits);
    const l = ladder(p, 5_000_000n, 8);
    const recent = Object.values(S.trades).filter(t => (t.kind === "buy" && ["settled", "locked"].includes(t.status)) || (t.kind === "sell" && ["released", "done", "paid"].includes(t.status)))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)
      .map(t => ({ side: t.kind, csdAmount: t.csdAmount, usdcAmount: t.usdcAmount, price: String(BigInt(t.usdcAmount) * 100_000_000n / BigInt(t.csdAmount)), at: t.createdAt }));
    let sellsPaused = false; try { sellOpenLimits("market-view"); } catch (e: any) { sellsPaused = e.message === "SELLS_PAUSED"; }
    return {
      marketMaker: account.address, settlement, usdc, chainId: C.chainId, csdGenesis: C.csdGenesis, domain,
      pool: { usdc: String(p.usdc), csd: String(p.csd) }, mid: String(midPrice(p)), spreadBps: String(C.spreadBps), feeUsdc: String(C.feeUsdc),
      bestAsk: String(quoteBuy(p, 100_000_000n)), bestBid: String(quoteSell(p, 100_000_000n)),
      limits: { minTradeUsdc: String(C.minTradeUsdc), maxTradeUsdc: String(C.maxTradeUsdc), buyConfirmations: C.buyConfirmations, sellsPaused,
        instantSells: BigInt(S.lossUsdc) < C.maxLossUsdc, instantRoomUsdc: String(C.maxUnconfirmedUsdc - exposure()) },
      csd: { height: tip.height, bits, suggestedMaxTarget: String(signTarget(bits)) },
      asks: l.asks.map(x => ({ price: String(x.price), csd: String(x.csd) })), bids: l.bids.map(x => ({ price: String(x.price), csd: String(x.csd) })),
      recent,
    };
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const HEX20 = /^(0x)?[0-9a-fA-F]{40}$/, HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;
  async function proxy(path: string, init?: RequestInit) { return (await tfetch(`${csdBase}${path}`, init)).json(); }
  // The node's proof lookup scans the chain, so answers are cached briefly
  const proofCache = new Map<string, { at: number; v: any }>();
  async function proofFor(txid: string) {
    const c = proofCache.get(txid); if (c && Date.now() - c.at < 60_000) return c.v;
    const v = await proxy(`/proof/tx/${txid}`); proofCache.set(txid, { at: Date.now(), v });
    if (proofCache.size > 500) proofCache.delete(proofCache.keys().next().value!);
    return v;
  }
  const clientIp = (req: http.IncomingMessage) => {
    const xff = C.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",").map(s => s.trim()).filter(Boolean).at(-1) : undefined;
    return xff || req.socket.remoteAddress || "?";
  };
  const hits = new Map<string, number[]>();
  function limitRate(ip: string) {
    const t = Date.now(), h = (hits.get(ip) ?? []).filter(x => x > t - 60_000);
    if (h.length >= C.maxRequestsPerMinute) throw new HttpError(429, "SLOW_DOWN");
    h.push(t); hits.set(ip, h);
    if (hits.size > 10_000) hits.clear();
  }
  async function route(req: http.IncomingMessage, body: any): Promise<any> {
    const u = new URL(req.url ?? "/", "http://x"), p = u.pathname, m = req.method;
    if (m === "GET" && p === "/api/market") return market();
    if (m === "GET" && p.startsWith("/api/trade/")) { const t = S.trades[p.slice(11)]; if (!t) throw new HttpError(404, "NO_SUCH_TRADE"); return tradeView(t); }
    if (m === "POST" && (p === "/api/buy" || p.startsWith("/api/sell/"))) {
      const ip = clientIp(req);
      limitRate(ip);
      if (p === "/api/buy") return serial(() => buy(body, ip));
      if (p === "/api/sell/open") return serial(() => sellOpen(body, ip));
      if (p === "/api/sell/pay") return serial(() => sellPay(body));
    }
    // CSD node, for the in-site wallet
    let g: RegExpMatchArray | null;
    if (m === "GET" && p === "/api/csd/tip") return proxy("/tip");
    if (m === "GET" && (g = p.match(/^\/api\/csd\/utxos\/([0-9a-fA-Fx]+)$/)) && HEX20.test(g[1])) return proxy(`/utxos/${g[1].replace(/^0x/, "")}?available=true`);
    if (m === "GET" && (g = p.match(/^\/api\/csd\/address\/([0-9a-fA-Fx]+)\/activity$/)) && HEX20.test(g[1])) return proxy(`/address/${g[1].replace(/^0x/, "")}/activity?limit=50`);
    if (m === "GET" && (g = p.match(/^\/api\/csd\/block\/height\/(\d{1,10})$/))) return proxy(`/block/height/${g[1]}`);
    if (m === "GET" && (g = p.match(/^\/api\/csd\/proof\/tx\/(0x[0-9a-fA-F]{64})$/))) {
      // Only for sales' payments (for claiming one yourself): each lookup scans the chain on the node
      const id = g[1].toLowerCase();
      if (!Object.values(S.trades).some(t => t.kind === "sell" && t.csdTxid?.toLowerCase() === id)) throw new HttpError(404, "NOT_A_SALE_PAYMENT");
      return proofFor(id);
    }
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
  for (const t of Object.values(S.trades)) if (t.status === "locking" || t.status === "opening") watchLock(t);
  loop();
  log(`[mm] ${account.address} listening on ${C.host ?? "127.0.0.1"}:${C.port}; pool ${Number(pool().usdc) / 1e6} USDC + ${Number(pool().csd) / 1e8} CSD, CSD inventory ${inventory.addr20}`);

  return {
    server, address: account.address, csdInventoryAddress: inventory.addr20, state: () => S, tick: () => serial(tick),
    async stop() { stopped = true; await ticking.catch(() => {}); await new Promise(r => server.close(r)); },
  };
}
