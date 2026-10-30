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
// Everything goes over AON, not a private API: the bot publishes signed offers,
// watches AON for the authorizations, sale requests and payments that reference
// them, and answers each with a signed response object (plus the trade's graph:
// authorization, proof or release, receipt). Anyone can see every step, and any
// other market maker could answer the same way.
//
// No custody of user funds and no consensus change: the bot is a trader with a
// key, CSD and USDC. Its HTTP API only serves market data and proxies a few CSD
// node calls so the in-site CSD wallet can reach a node over HTTPS.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, defineChain, getAddress, hashTypedData, http as viemHttp, recoverAddress,
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
import { finalizeObject, hashObject } from "@intervalplace/aon-sdk";
import { buildCsdUsdcAuthorizationObject, buildCsdUsdcEarlyReleaseObject } from "./builders.js";

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
  maxAonRequestsPerMinute?: number; // buys (and, separately, sale requests) handled per minute in all; default 60
  lateLockSlackSecs?: number;    // a buy's lock may have this much less than its full window and still be paid; default 300
  inventoryPieces?: number;     // CSD is kept split into this many coins; default 20
  pollMs?: number;              // default 5000
  rebroadcastSecs?: number;     // resend a CSD payment not mined after this long; default 900
  nodeTimeoutMs?: number;       // default 10000
  aonNodeUrl: string;           // the AON node(s) the bot reads requests from and publishes to (comma-separated for several)
  watchMs?: number;             // how often AON is checked for new requests; default 1000
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
  keyIndex?: number; csdAddr?: Hex; ip?: string;            // sell: our receiving key; the client (signer) who opened it
  coins?: string[]; poolMoved?: boolean;                    // sell: the coins the seller will pay with ("txid:vout")
  requestDigest?: Hex; lateLock?: boolean;                  // sell: the signed request it answers; buy: locked too late to pay against
  owners?: string[]; swept?: boolean; sweepTxid?: Hex;      // sell: the addresses that signed for them; our key emptied
  trusted?: boolean;                                        // sell: released before its payment had safeConfirmations
  request?: any; proofJson?: any;                           // sell: the seller's signed request; buy: the proof that settled it
  aon?: { offer?: string; request?: string; auth?: string; proof?: string; release?: string; receipt?: string };
  payBy?: number; unpaidAt?: number; paidAt?: number;       // sell: payment deadline; when it lapsed
  releaseTx?: Hex; settleTx?: Hex; instant?: boolean; direct?: boolean; error?: string;
};
type Offer = { hash: string; mid: string; at: number; poolKey?: string };
type State = { pool: { usdc: string; csd: string }; nextKey: number; trades: Record<string, Trade>; lossUsdc: string; lastSplit?: number;
  offers?: { sell?: Offer; buy?: Offer }; liveOffers?: { hash: string; side: "sell" | "buy"; at: number }[]; aonQueue?: any[];
  seen?: Record<string, number>; rejectedBuys?: Record<string, Record<string, string>> };

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
    sellPayWindowSecs: 180, maxOpenUnpaid: 3, maxUnpaidPerHour: 2, maxUnpaidPerDay: 10, coinBanSecs: 86400, maxRequestsPerMinute: 20, maxAonRequestsPerMinute: 60, lateLockSlackSecs: 300,
    inventoryPieces: 20, pollMs: 5000, watchMs: 1000, rebroadcastSecs: 900, nodeTimeoutMs: 10_000, broadcastApis: [] as string[], trustProxy: false,
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
  // Short cache for the in-site wallet's coin lookups, cleared on every new block or broadcast
  const utxoCache = new Map<string, { at: number; v: any }>();
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
  const ownKeys = () => [inventory, ...Object.values(S.trades).filter(t => t.kind === "sell" && t.keyIndex !== undefined && !t.swept && ["released", "done", "paid"].includes(t.status)).map(t => key(t.keyIndex!))];
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
    utxoCache.clear();
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
  // Moves CSD received for finished sales into the inventory address, so the
  // bot doesn't have to look up more and more addresses
  async function sweepFinished() {
    for (const t of Object.values(S.trades)) {
      if (t.kind !== "sell" || t.status !== "done" || t.swept || t.keyIndex === undefined) continue;
      if (t.sweepTxid && confirmations(t.sweepTxid) > 0) { t.swept = true; save(); continue; }
      const k = key(t.keyIndex), coins = await node.utxos(k);
      if (!coins.length) { if (!t.sweepTxid) { t.swept = true; save(); } continue; } // spent by a trade, or the sweep is waiting for a block
      const total = coins.reduce((s, c) => s + c.value, 0n);
      if (total <= CSD_FEE) { t.swept = true; save(); continue; }
      // (coins visible again: the sweep was dropped, so it's made again)
      const p = buildPayment({ utxos: coins, to: [{ value: total - CSD_FEE, addr20: inventory.addr20 }], change: inventory.addr20, fee: CSD_FEE });
      t.sweepTxid = p.txid; save();
      await broadcast(p.tx);
    }
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
    tipHeight = tip.height; tipHash = tip.hash; utxoCache.clear();
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
        // Only pay against a lock with (nearly) its whole window left. Anyone can submit a buyer's
        // lock, so it may have been made long ago and be about to expire: CSD sent then could
        // never be proven in time, and the buyer would get the USDC back as well.
        const full = 600 + Number(t.auth.minConfirmations) * 300;
        if (Number(t.lockedUntil) - (await chainNow()) < full - C.lateLockSlackSecs) {
          t.status = "lock_failed"; t.lateLock = true;
          S.rejectedBuys = { ...(S.rejectedBuys ?? {}), [t.authHash]: t.auth }; save();
          log(`[mm] buy ${t.authHash}: locked too long ago to pay against; nothing sent (the USDC goes back once the lock expires)`);
          return;
        }
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
  // ── AON: every trade is a graph of objects ──────────────────────────────
  //   buy:  offer (bot) ← authorization (buyer) ← proof (the CSD payment) ← receipt
  //   sell: offer (bot), request (seller, signed with their CSD key) ← authorization (bot) ← release (bot) ← receipt
  // Objects queue up and are published in the background, so AON never slows a trade.
  const NS = "aon:csd-usdc";
  // Several nodes: requests may reach any of them first (browsers fail over between nodes)
  const aonBases = C.aonNodeUrl.split(",").map(x => x.trim().replace(/\/$/, "")).filter(Boolean);
  async function aonPut(o: any) {
    const errs: string[] = [];
    const ok = (await Promise.all(aonBases.map(async b => {
      try {
        const r = await tfetch(`${b}/v1/objects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
        const j = await r.json().catch(() => ({}));
        if (!j.ok) throw new Error(j.error?.code ?? `AON_${r.status}`);
        return true;
      } catch (e: any) { errs.push(e.message); return false; }
    }))).some(Boolean);
    if (!ok) throw new Error(errs.join("; "));
  }
  // Objects referencing a hash, from every node (fails only if no node answers)
  async function aonInbound(hash: string): Promise<any[]> {
    const lists = await Promise.all(aonBases.map(b => tfetch(`${b}/v1/objects/${hash}/references`).then(r => r.json()).then(j => j.inbound ?? [], () => null)));
    if (lists.every(l => l === null)) throw new Error("AON_UNREACHABLE");
    const out = new Map<string, any>();
    for (const l of lists) for (const o of l ?? []) if (o?.objectHash) out.set(String(o.objectHash).toLowerCase(), o);
    return [...out.values()];
  }
  // A full queue drops answers before receipts and offers
  const queueObject = (o: any) => {
    const q = [...(S.aonQueue ?? []), o];
    while (q.length > 500) { const i = q.findIndex(x => x.objectType === "response"); q.splice(i >= 0 ? i : 0, 1); }
    S.aonQueue = q; save(); flushAon(); return o;
  };
  let flushing = false;
  async function flushAon() {
    if (flushing) return; flushing = true;
    try {
      while (S.aonQueue?.length) {
        try { await aonPut(S.aonQueue[0]); } catch (e: any) { log(`[mm] AON publish failed (will retry): ${e.message}`); break; }
        S.aonQueue.shift(); save();
      }
    } finally { flushing = false; }
  }
  // Signs over the hash of everything but the signature (objectHash then covers the signature too)
  async function signed(obj: any) {
    const digest = hashObject(obj as any) as Hex;
    const signature = await account.signMessage({ message: { raw: digest } });
    return finalizeObject({ ...obj, signature: { scheme: "eip191-object", signer: account.address, signature } } as any);
  }
  // The bot's standing quotes, re-published when the price moves 1% or every 30 minutes
  async function refreshOffers() {
    const p = quotePool(), mid = midPrice(p), t = now(), poolKey = `${p.usdc}:${p.csd}`;
    // A new offer whenever the pool changes (so the book on AON is always the real price), or every 30 minutes
    const stale = (o?: Offer) => !o || t - o.at > 1800 || o.poolKey !== poolKey;
    S.offers ??= {};
    for (const side of ["sell", "buy"] as const) {
      if (!stale(S.offers[side])) continue;
      const o = await signed({ objectType: "offer", schemaVersion: "1", namespace: NS, createdAt: Date.now(), references: [],
        payload: { offerType: side === "sell" ? "csd_usdc_sell_csd" : "csd_usdc_buy_csd", marketMaker: account.address, settlementContract: settlement, usdc,
          csdGenesisHash: C.csdGenesis, pricing: "pool", poolUsdc: String(p.usdc), poolCsd: String(p.csd), midUsdcPerCsd: String(mid),
          spreadBps: String(C.spreadBps), feeUsdc: String(C.feeUsdc), minTradeUsdc: String(C.minTradeUsdc), maxTradeUsdc: String(C.maxTradeUsdc), validBefore: t + 3600 } });
      // Published before anyone can reference it
      try { await aonPut(o); } catch { queueObject(o); }
      S.offers[side] = { hash: o.objectHash!, mid: String(mid), at: t, poolKey };
      S.liveOffers = [...(S.liveOffers ?? []), { hash: o.objectHash!, side, at: t }].filter(x => x.at > t - 7200).slice(-40); save();
    }
  }
  const ref = (...h: (string | undefined)[]) => h.filter(Boolean).map(x => x!.toLowerCase());
  async function publishAuth(t: Trade, references: string[]) {
    try {
      const o = await buildCsdUsdcAuthorizationObject({ authorization: t.auth, signature: t.authSig, domain, types: AUTH_TYPES, references });
      t.aon = { ...t.aon, auth: o.objectHash }; save(); queueObject(o);
    } catch (e: any) { log(`[mm] AON authorization for ${t.authHash}: ${e.message}`); }
  }
  // Receipts are signed, so nobody else's "receipt" can pass for one
  const receipting = new Set<string>();
  async function publishReceipt(t: Trade, extra: Record<string, unknown>) {
    if (t.aon?.receipt || receipting.has(t.authHash)) return;
    receipting.add(t.authHash);
    try { await publishReceiptNow(t, extra); } finally { receipting.delete(t.authHash); }
  }
  async function publishReceiptNow(t: Trade, extra: Record<string, unknown>) {
    const o = await signed({ objectType: "receipt", schemaVersion: "1", namespace: NS, createdAt: Date.now(),
      references: ref(t.aon?.auth, t.aon?.proof, t.aon?.release, t.aon?.request),
      payload: { receiptType: "authorized_state_transition_completed", settlementContract: settlement, authHash: t.authHash,
        csdTxid: t.csdTxid, csdAmount: t.csdAmount, usdcAmount: t.usdcAmount, buyer: t.auth.buyer, sellerUsdcRecipient: t.auth.sellerUsdcRecipient, ...extra } });
    t.aon = { ...t.aon, receipt: o.objectHash }; save(); queueObject(o);
  }

  // ── user buys CSD ─────────────────────────────────────────────────────────
  async function buy(body: any, ip: string, aonObj?: any) {
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
    if (Number(auth.validBefore) > t0 + 86400) bad("VALID_BEFORE_TOO_LATE");
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
    // Its permit is public on AON, so anyone may already have submitted the lock: then there's nothing to send
    const alreadyLocked = await view("usdcLocked", authHash);
    // Saved before sending, so a crash can't lose track of a lock
    const t: Trade = { kind: "buy", status: "locking", authHash, createdAt: now(), auth: strAuth(auth), authSig: sig,
      csdAmount: String(auth.csdAmount), usdcAmount: String(auth.usdcAmount), poolUsdc: String(auth.usdcAmount), ip };
    S.trades[authHash] = t; save();
    if (!alreadyLocked) {
      try {
        t.lockTx = permit ? await send("lockCsdUsdcAuthorizationWithPermit", [auth, sig, proof, permit]) : await send("lockCsdUsdcAuthorization", [auth, sig, proof]);
      } catch (e: any) { delete S.trades[authHash]; save(); return bad(`LOCK_REJECTED:${e.shortMessage ?? e.message}`); }
    }
    const offer = (S.liveOffers ?? []).map(o => o.hash).find(h => h.toLowerCase() === auth.tradeIntentHash.toLowerCase());
    // The buyer's own published authorization is the graph's authorization
    t.aon = { offer, auth: aonObj?.objectHash }; save();
    if (!aonObj) publishAuth(t, ref(offer));
    if (alreadyLocked) { await checkLock(t); if (t.status === "lock_failed") throw new HttpError(409, "LOCK_TOO_OLD"); } else watchLock(t);
    log(`[mm] buy ${authHash}: ${Number(auth.csdAmount) / 1e8} CSD for ${Number(auth.usdcAmount) / 1e6} USDC, lock ${t.lockTx ?? "(already locked)"}`);
    return tradeView(t);
  }

  // ── user sells CSD ────────────────────────────────────────────────────────
  // Opening costs the bot two Ethereum transactions (lock, later refund) if the
  // seller never pays, so opens are limited per client and overall, and the
  // pool only moves once the CSD is paid.
  function sellOpenLimits(ip: string, owners: string[] = []) {
    const sells = Object.values(S.trades).filter(t => t.kind === "sell");
    // Waiting: not paid yet, or paid but the payment isn't in a block (it may never be)
    const waiting = sells.filter(t => ((t.status === "opening" || t.status === "open") && !t.unpaidAt) || (t.status === "paid" && confirmations(t.csdTxid!) === 0));
    const mine = (t: Trade) => !!t.owners?.some(o => owners.includes(o));
    // One waiting sale per address; an address that left two sales unpaid in a day waits a day
    if (waiting.some(mine)) throw new HttpError(429, "FINISH_YOUR_OTHER_SALE");
    if (sells.filter(t => mine(t) && t.unpaidAt && t.unpaidAt > now() - 86400).length >= 2) throw new HttpError(429, "TOO_MANY_UNPAID_SALES");
    // Sellers with a completed sale in the last 30 days, and none left unpaid in the last day,
    // can sell even while sales are paused
    const proven = owners.length > 0 && !sells.some(t => mine(t) && t.unpaidAt && t.unpaidAt > now() - 86400)
      && owners.every(o => sells.some(t => t.status === "done" && (t.paidAt ?? 0) > now() - 30 * 86400 && t.owners?.includes(o)));
    if (waiting.some(t => t.ip === ip)) throw new HttpError(429, "FINISH_YOUR_OTHER_SALE");
    if (waiting.length >= C.maxOpenUnpaid) throw new HttpError(503, "BUSY_TRY_AGAIN_SHORTLY");
    const lapsed = sells.filter(t => t.unpaidAt);
    if (!proven && (lapsed.filter(t => t.unpaidAt! > now() - 3600).length >= C.maxUnpaidPerHour
      || lapsed.filter(t => t.unpaidAt! > now() - 86400).length >= C.maxUnpaidPerDay)) throw new HttpError(503, "SELLS_PAUSED");
  }
  // The coins a sale request names: owned by its signers, confirmed, not spent in the mempool,
  // not backing another sale, and not from a sale left unpaid recently
  const saleDigest = (body: any, csd: bigint, recipient: Hex) => {
    try { return bytesToHex(csdSaleRequestDigest({ csdAmount: csd, usdcRecipient: recipient, validUntil: Number(body.validUntil),
      coins: body.coins.map((c: any) => ({ txid: String(c?.txid ?? "").toLowerCase() as Hex, vout: Number(c?.vout) })) })) as Hex; } catch { return undefined; }
  };
  async function checkSaleCoins(body: any, csd: bigint, recipient: Hex): Promise<{ ids: string[]; owners: string[] }> {
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
    const owners: string[] = [...signers];
    for (const t of Object.values(S.trades)) {
      if (t.kind !== "sell") continue;
      // Coins from a sale left unpaid wait a day; coins and addresses behind a double-spent
      // payment (or one that never confirmed) wait a day too
      const lapsed = !!t.unpaidAt && t.unpaidAt > now() - C.coinBanSecs;
      const cheated = (t.status === "reversed" || t.status === "expired" && !!t.paidAt) && (t.paidAt ?? 0) > now() - C.coinBanSecs;
      if ((lapsed || cheated) && t.coins?.some(c => ids.includes(c))) throw new HttpError(429, "COINS_FROM_AN_UNPAID_SALE");
      if (cheated && t.owners?.some(o => owners.includes(o))) throw new HttpError(429, "ADDRESS_FROM_A_DOUBLE_SPEND");
      if (!t.unpaidAt && ["opening", "open", "paid"].includes(t.status) && t.coins?.some(c => ids.includes(c))) throw new HttpError(409, "COINS_IN_USE");
    }
    return { ids, owners };
  }
  async function sellOpen(body: any, ip: string, aonObj?: any) {
    let csd: bigint, recipient: Hex, minOut: bigint;
    try { csd = BigInt(body.csdAmount); recipient = getAddress(body.usdcRecipient); minOut = BigInt(body.minUsdcOut ?? 0); } catch { return bad("BAD_REQUEST"); }
    // A request answered once (or republished by someone else) gets the same sale back, never a second one
    const requestDigest = saleDigest(body, csd, recipient);
    const prior = requestDigest && Object.values(S.trades).find(t => t.kind === "sell" && t.requestDigest === requestDigest);
    if (prior) return tradeView(prior);
    const { ids: coins, owners } = await checkSaleCoins(body, csd, recipient);
    sellOpenLimits(ip, owners);
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
      csdAmount: String(csd), usdcAmount: String(usdcAmount), poolUsdc: String(out), keyIndex, csdAddr: k.addr20, ip, coins, owners, requestDigest };
    S.trades[authHash] = t; save();
    try { t.lockTx = await send("lockCsdUsdcAuthorization", [auth, sig, csdAddressProof(k, authHash)]); }
    catch (e: any) { delete S.trades[authHash]; save(); return bad(`LOCK_REJECTED:${e.shortMessage ?? e.message}`); }
    save(); watchLock(t);
    {
      // The seller's side is their own request object on AON, signed with the keys that own the coins
      const offer = aonObj?.references?.find((h: string) => (S.liveOffers ?? []).some(o => o.hash.toLowerCase() === h.toLowerCase())) ?? S.offers?.buy?.hash;
      t.aon = { offer, request: aonObj?.objectHash }; save();
      await publishAuth(t, ref(aonObj?.objectHash, offer));
    }
    log(`[mm] sell ${authHash} opened: ${Number(csd) / 1e8} CSD for ${Number(usdcAmount) / 1e6} USDC, lock ${t.lockTx}`);
    return tradeView(t);
  }

  // The seller's payment: confirmed coins (not already spent in the mempool),
  // a real fee, and enough paid to the trade's address
  async function checkUserPayment(t: Trade, tx: CsdTx) {
    // Cheap checks first: it must spend exactly the coins named in the request, from the addresses
    // that signed it, so a junk payment can't make the bot look up hundreds of addresses
    if (t.coins) {
      const ins = tx.inputs.map(i => `${i.prevout.txid.toLowerCase()}:${i.prevout.vout}`);
      if (ins.length !== t.coins.length || new Set(ins).size !== ins.length || !ins.every(x => t.coins!.includes(x))) bad("PAY_WITH_THE_COINS_YOU_NAMED");
      for (const i of tx.inputs) {
        const sc = i.scriptSig;
        if (sc.length !== 99 || sc[0] !== 64 || sc[65] !== 33) bad("BAD_CSD_TX");
        if (t.owners && !t.owners.includes(bytesToHex(hash160(sc.slice(66))))) bad("PAY_WITH_THE_COINS_YOU_NAMED");
      }
    }
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
  // Any release before the payment has safeConfirmations blocks is trust, and obeys the same limits
  function earlyReleaseAllowed(t: Trade) {
    if (confirmations(t.csdTxid!) >= C.safeConfirmations) return true;
    const amt = BigInt(t.usdcAmount), to = t.auth.sellerUsdcRecipient.toLowerCase();
    const recent = Object.values(S.trades).filter(o => o.kind === "sell" && o.trusted && o.auth.sellerUsdcRecipient.toLowerCase() === to && (o.paidAt ?? 0) > now() - 3600)
      .reduce((s, o) => s + BigInt(o.usdcAmount), 0n);
    return BigInt(S.lossUsdc) < C.maxLossUsdc && exposure() + amt <= C.maxUnconfirmedUsdc && recent + amt <= C.maxInstantPerRecipientUsdc;
  }
  async function sellPay(body: any) {
    const t = S.trades[body?.authHash]; if (!t || t.kind !== "sell") throw new HttpError(404, "NO_SUCH_TRADE");
    if (t.csdTxid) return tradeView(t);
    if (t.status === "opening") { await checkLock(t); if (t.status === "opening") throw new HttpError(409, "LOCK_NOT_MINED_YET"); }
    if (t.status !== "open") bad(`TRADE_${t.status.toUpperCase()}`);
    // On time if it reached AON in time (it may wait behind other objects to be processed)
    if (t.unpaidAt || Math.min(now(), Number(body.arrivedAt ?? Infinity)) > (t.payBy ?? 0)) bad("TOO_LATE_TO_PAY");
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
    if (earlyReleaseAllowed(t)) {
      t.instant = true; save();
      try { await release(t); } catch (e: any) { log(`[mm] sell ${t.authHash}: release failed, will retry: ${e.shortMessage ?? e.message}`); }
    }
    log(`[mm] sell ${t.authHash}: user paid ${txid}${t.instant ? ", released instantly" : ", releasing once its payment is confirmed"}`);
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
    if (confirmations(t.csdTxid!) < C.safeConfirmations) { t.trusted = true; save(); }
    t.releaseTx = await send("releaseEarly", [authTuple(t.auth), msg, sig]);
    if (t.aon?.auth) {
      try {
        const authObj = await buildCsdUsdcAuthorizationObject({ authorization: t.auth, signature: t.authSig, domain, types: AUTH_TYPES, references: ref(t.aon.request, t.aon.offer) });
        const rel = await buildCsdUsdcEarlyReleaseObject({ authorization: { ...authObj, createdAt: authObj.createdAt } as any, csdTxid: t.csdTxid!, lockedAt: msg.lockedAt, deadline: msg.deadline, signature: sig });
        // (the release names the published authorization by its hash)
        const relFixed = finalizeObject({ ...rel, objectHash: undefined, references: ref(t.aon.auth) } as any);
        t.aon = { ...t.aon, release: relFixed.objectHash }; save(); queueObject(relFixed);
      } catch (e: any) { log(`[mm] AON release for ${t.authHash}: ${e.message}`); }
    }
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
    t.settleTx = await send("settleCsdUsdc", [authTuple(t.auth), t.authSig, spvProofTuple(proof)]); t.proofJson = proof; save();
  }
  const FINAL = new Set(["settled", "lock_failed", "refunded", "done", "expired", "reversed", "open_failed"]);
  async function tick() {
    const tNow = await chainNow();
    await syncBlocks();
    for (const t of Object.values(S.trades)) {
      if (FINAL.has(t.status) && !(t.status === "done" && t.releaseTx && !t.aon?.receipt)) {
        // A lock that looked failed but got mined after all (someone rebroadcast it): honour it
        if (t.kind === "buy" && t.status === "lock_failed" && !t.lateLock && now() - t.createdAt < 3 * 3600 && await view("usdcLocked", t.authHash).catch(() => false)) {
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
          if (!t.csdTxid || (confirmations(t.csdTxid) === 0 && now() - (t.csdSentAt ?? 0) > C.rebroadcastSecs)) await sendBuyCsd(t);
          if (t.settleTx) {
            const r = await pub.getTransactionReceipt({ hash: t.settleTx }).catch(() => null);
            if (r?.status === "success") {
              t.status = "settled"; save(); log(`[mm] buy ${t.authHash} settled (${t.settleTx})`);
              {
                const pr = finalizeObject({ objectType: "proof", schemaVersion: "1", namespace: NS, createdAt: Date.now(), references: ref(t.aon?.auth),
                  payload: { proofType: "csd_payment", txid: t.csdTxid, minConfirmations: Number(t.auth.minConfirmations), proof: t.proofJson } } as any);
                t.aon = { ...t.aon, proof: pr.objectHash }; t.proofJson = undefined; save(); queueObject(pr);
                await publishReceipt(t, { executionTx: t.settleTx, method: "settleCsdUsdc", executorFeeAmount: t.auth.executorFeeAmount });
              }
              continue;
            }
            if (r) { t.settleTx = undefined; save(); } else continue; // reverted: try again; pending: wait
          }
          // Someone else settled it (anyone may submit the proof): we were paid all the same
          if (await view("finalizedAuthorization", t.authHash)) { t.status = "settled"; save(); continue; }
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
          if (t.status === "paid" && confirmations(t.csdTxid!) >= 1 && earlyReleaseAllowed(t)) await release(t);
          // Paid but never mined: once the lock expires, take the USDC back (if the payment
          // turns up later, release() pays the seller directly); give up after a day
          if (t.status === "paid" && confirmations(t.csdTxid!) === 0) {
            if (now() - (t.csdSentAt ?? 0) > C.rebroadcastSecs) { try { await broadcast(txFromNodeJson(t.csdTx)); } catch {} t.csdSentAt = now(); save(); }
            if (tNow > Number(t.lockedUntil) + 30 && await view("usdcLocked", t.authHash)) await send("refundExpiredLock", [authTuple(t.auth)]);
            else if (tNow > Number(t.lockedUntil) + 86400 && !(await mined(t.csdTxid!, true))) { t.status = "expired"; save(); }
          }
          if ((t.status === "released" || t.status === "done") && t.releaseTx && !t.aon?.receipt) {
            const r = await pub.getTransactionReceipt({ hash: t.releaseTx }).catch(() => null);
            if (r?.status === "reverted") { log(`[mm] release ${t.releaseTx} reverted; retrying`); t.status = "paid"; t.releaseTx = undefined; save(); }
            else if (r?.status === "success") await publishReceipt(t, { executionTx: t.releaseTx, method: t.direct ? "direct_transfer" : "releaseEarly" });
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
                  // (if a block had counted the CSD before a reorg removed it, take that back too)
                  const p = pool();
                  t.status = "reversed"; setPool(t.poolMoved ? { ...p, csd: p.csd - BigInt(t.csdAmount) } : { ...p, usdc: p.usdc - BigInt(t.poolUsdc) });
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
    try { await sweepFinished(); } catch (e: any) { log(`[mm] sweep: ${e.message}`); }
    try { await refreshOffers(); } catch (e: any) { log(`[mm] offers: ${e.message}`); }
    try { await refundDeclined(); } catch (e: any) { log(`[mm] declined: ${e.message}`); }
    flushAon();
    try { await splitInventory(); } catch (e: any) { log(`[mm] split: ${e.message}`); }
  }
  let stopped = false, ticking: Promise<unknown> = Promise.resolve();
  const loop = () => { if (stopped) return; ticking = serial(tick).finally(() => { if (!stopped) setTimeout(loop, C.pollMs); }); };

  // ── requests over AON ─────────────────────────────────────────────────────
  // Buyers' authorizations and sellers' requests reference one of the bot's
  // offers; sellers' payments reference the bot's authorization for their sale.
  // Each one gets a signed response object referencing it.
  async function respond(to: any, body: Record<string, unknown>) {
    const o = await signed({ objectType: "response", schemaVersion: "1", namespace: NS, createdAt: Date.now(), references: ref(to.objectHash),
      payload: { responseType: "csd_usdc_market_maker", to: to.objectHash, ...body } });
    try { await aonPut(o); } catch { queueObject(o); }
  }
  const asError = (e: any) => ({ accepted: false, code: e instanceof HttpError ? e.code : 500, error: e instanceof HttpError ? e.message : "INTERNAL_ERROR" });
  async function handle(o: any) {
    const P = o.payload ?? {};
    if (o.objectType === "authorization" && P.authorizationType === "csd_usdc_release") {
      const a = P.authorization ?? {};
      if (String(a.sellerUsdcRecipient ?? "").toLowerCase() !== account.address.toLowerCase()) return; // for someone else
      const client = `buyer:${String(a.buyer).toLowerCase()}`;
      // Nothing is done for an authorization its buyer didn't sign (no state, no answer)
      let h: Hex;
      try {
        h = authHashOf(authTuple(a));
        if ((await recoverAddress({ hash: h, signature: o.signature?.signature })).toLowerCase() !== String(a.buyer).toLowerCase()) return;
      } catch { return; }
      // Past the overall limit, requests are dropped unanswered (answering a flood is work too)
      try { limitRate("aon:buys", C.maxAonRequestsPerMinute); } catch { return; }
      try {
        limitRate(client);
        const v = await serial(() => buy({ authorization: a, signature: o.signature?.signature, addressProof: P.csdAddressProof, permit: P.usdcPermit }, client, o));
        await respond(o, { accepted: true, ...v });
      } catch (e: any) {
        // If someone locks it anyway with the public permit, the buyer gets their USDC back once the lock expires
        // (only ones that could still be locked; bounded, so it can't be flooded)
        const rb = S.rejectedBuys ?? {};
        if (!S.trades[h] && Number(a.validBefore) <= now() + 2 * 86400 && Object.keys(rb).length < 300) { S.rejectedBuys = { ...rb, [h]: strAuth(a) }; save(); }
        await respond(o, asError(e));
      }
    } else if (o.objectType === "request" && P.requestType === "csd_usdc_sale") {
      const client = `seller:${String(P.usdcRecipient ?? "").toLowerCase()}`;
      try { limitRate("aon:sells", C.maxAonRequestsPerMinute); } catch { return; }
      try {
        limitRate(client);
        const v = await serial(() => sellOpen({ csdAmount: P.csdAmount, usdcRecipient: P.usdcRecipient, minUsdcOut: P.minUsdcOut, validUntil: P.validUntil,
          coins: P.coins, proofs: o.signature?.proofs }, client, o));
        await respond(o, { accepted: true, ...v });
      } catch (e: any) { await respond(o, asError(e)); }
    } else if (o.objectType === "payment" && P.paymentType === "csd_usdc_sale_payment") {
      const t = Object.values(S.trades).find(x => x.kind === "sell" && x.aon?.auth && o.references.map((r: string) => r.toLowerCase()).includes(x.aon.auth.toLowerCase()));
      if (!t) return;
      try {
        // Only the trade's own seller can pay it, but anyone can publish junk: a few attempts per sale
        limitRate(`pay:${t.authHash}`, 10);
        const v = await serial(() => sellPay({ authHash: t.authHash, tx: P.csdTx, arrivedAt: Math.floor(Number(o.arrivedAt ?? Date.now()) / 1000) }));
        await respond(o, { accepted: true, ...v });
      } catch (e: any) { await respond(o, asError(e)); }
    }
  }
  let dirty = false;
  async function watch() {
    S.seen ??= {};
    const targets = [...(S.liveOffers ?? []).map(o => o.hash),
      ...Object.values(S.trades).filter(t => t.kind === "sell" && t.aon?.auth && (t.status === "open" || now() - t.createdAt < 3600)).map(t => t.aon!.auth!)];
    // Fetched first, then handled: an object's arrival time is when the bot first saw it
    const fresh: any[] = [], t0 = Date.now();
    for (const h of targets) {
      let inbound: any[] = [];
      try { inbound = await aonInbound(h); } catch { continue; }
      for (const o of inbound) {
        const k = String(o?.objectHash ?? "").toLowerCase();
        if (!k || S.seen[k] || o.namespace !== NS) continue;
        S.seen[k] = now(); dirty = true;
        // Dated in the future: junk trying to jump the queue
        if (!(Number(o.createdAt) <= t0 + 120_000)) continue;
        fresh.push({ ...o, arrivedAt: t0 });
      }
    }
    if (dirty) { save(); dirty = false; }
    for (const o of fresh.sort((a, b) => a.createdAt - b.createdAt)) {
      try { await handle(o); } catch (e: any) { log(`[mm] AON ${o.objectType} ${o.objectHash}: ${e.message}`); }
    }
    const cutoff = now() - 3 * 86400;
    for (const [k, t] of Object.entries(S.seen)) if (t < cutoff) delete S.seen[k];
  }
  let watching: Promise<unknown> = Promise.resolve();
  const watchLoop = () => { if (stopped) return; watching = watch().catch(e => log(`[mm] watch: ${e.message}`)).finally(() => { if (!stopped) setTimeout(watchLoop, C.watchMs); }); };

  // Locks of declined buys that someone submitted anyway: refunded to the buyer once they expire
  async function refundDeclined() {
    for (const [h, a] of Object.entries(S.rejectedBuys ?? {})) {
      if (S.trades[h] && !S.trades[h].lateLock) { delete S.rejectedBuys![h]; save(); continue; }
      try {
        const [locked, until] = await Promise.all([view("usdcLocked", h as Hex), view("lockedUntil", h as Hex)]);
        if (Number(a.validBefore) < now() - 86400 && !locked) { delete S.rejectedBuys![h]; save(); continue; }
        if (locked && (await chainNow()) > Number(until) + 30) { await send("refundExpiredLock", [authTuple(a)]); log(`[mm] refunded a declined buy someone locked anyway (${h})`); }
      } catch (e: any) { log(`[mm] declined buy ${h}: ${e.shortMessage ?? e.message}`); }
    }
  }

  // ── market data ───────────────────────────────────────────────────────────
  function tradeView(t: Trade) {
    return { authHash: t.authHash, kind: t.kind, status: t.status, csdAmount: t.csdAmount, usdcAmount: t.usdcAmount, lockTx: t.lockTx,
      csdTxid: t.csdTxid, releaseTx: t.releaseTx, settleTx: t.settleTx, instant: t.instant, csdAddress: t.csdAddr, lockedUntil: t.lockedUntil, payBy: t.payBy, aon: t.aon,
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
      offers: { sell: S.offers?.sell?.hash, buy: S.offers?.buy?.hash },
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
    const ip = (xff || req.socket.remoteAddress || "?").replace(/^::ffff:/, "");
    // IPv6 clients are grouped by /64: one connection usually has a whole /64 to rotate through
    if (!ip.includes(":")) return ip;
    const [head, tail] = ip.split("::"), h = head ? head.split(":") : [], t = tail !== undefined && tail ? tail.split(":") : [];
    const full = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
    return full.slice(0, 4).map(x => (x || "0").toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
  };
  const hits = new Map<string, number[]>();
  function limitRate(ip: string, max = C.maxRequestsPerMinute) {
    const t = Date.now(), h = (hits.get(ip) ?? []).filter(x => x > t - 60_000);
    if (h.length >= max) throw new HttpError(429, "SLOW_DOWN");
    h.push(t); hits.set(ip, h);
    while (hits.size > 10_000) hits.delete(hits.keys().next().value!); // oldest first
  }
  async function route(req: http.IncomingMessage, body: any): Promise<any> {
    const u = new URL(req.url ?? "/", "http://x"), p = u.pathname, m = req.method;
    if (m === "GET" && p === "/api/market") return market();
    if (m === "GET" && p.startsWith("/api/trade/")) { const t = S.trades[p.slice(11)]; if (!t) throw new HttpError(404, "NO_SUCH_TRADE"); return tradeView(t); }
    // (Trading happens over AON, not here)
    // CSD node, for the in-site wallet (each call costs the node real work, so rate-limited)
    let g: RegExpMatchArray | null;
    if (p.startsWith("/api/csd/")) limitRate(`csd:${clientIp(req)}`, C.maxRequestsPerMinute * 6);
    if (m === "GET" && p === "/api/csd/tip") return proxy("/tip");
    if (m === "GET" && (g = p.match(/^\/api\/csd\/utxos\/([0-9a-fA-Fx]+)$/)) && HEX20.test(g[1])) {
      const a = g[1].replace(/^0x/, "").toLowerCase(), c = utxoCache.get(a);
      if (c && Date.now() - c.at < 5000) return c.v;
      const v = await proxy(`/utxos/${a}?available=true`); utxoCache.set(a, { at: Date.now(), v });
      while (utxoCache.size > 2000) utxoCache.delete(utxoCache.keys().next().value!);
      return v;
    }
    if (m === "GET" && (g = p.match(/^\/api\/csd\/block\/height\/(\d{1,10})$/))) return proxy(`/block/height/${g[1]}`);
    if (m === "GET" && (g = p.match(/^\/api\/csd\/proof\/tx\/(0x[0-9a-fA-F]{64})$/))) {
      // Only for sales' payments (for claiming one yourself): each lookup scans the chain on the node
      const id = g[1].toLowerCase();
      if (!Object.values(S.trades).some(t => t.kind === "sell" && t.csdTxid?.toLowerCase() === id)) throw new HttpError(404, "NOT_A_SALE_PAYMENT");
      return proofFor(id);
    }
    if (m === "POST" && p === "/api/csd/tx/submit") { let tx: CsdTx; try { tx = txFromNodeJson(body?.tx); } catch { return bad("BAD_CSD_TX"); }
      utxoCache.clear();
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
  await refreshOffers().catch(e => log(`[mm] offers: ${e.message}`));
  loop(); watchLoop();
  log(`[mm] ${account.address} listening on ${C.host ?? "127.0.0.1"}:${C.port}; pool ${Number(pool().usdc) / 1e6} USDC + ${Number(pool().csd) / 1e8} CSD, CSD inventory ${inventory.addr20}`);

  return {
    server, address: account.address, csdInventoryAddress: inventory.addr20, state: () => S, tick: () => serial(tick),
    watch: () => watch(),
    async stop() { stopped = true; await ticking.catch(() => {}); await watching.catch(() => {}); await new Promise(r => server.close(r)); },
  };
}
