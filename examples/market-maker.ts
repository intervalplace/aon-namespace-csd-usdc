// Market-maker bot for aon:csd-usdc — a SKETCH. See docs/market-maker.md.
//
// Quotes CSD both ways so users wait about one CSD block either way:
//   A. user buys CSD:  the bot sends CSD as soon as the user's USDC is locked,
//                      then settles with a proof later (only the bot waits).
//   B. user sells CSD: the bot locks its USDC against a fresh CSD address of
//                      its own, and signs an early release once the user's
//                      payment has EARLY_RELEASE_CONFIRMATIONS.
//
// Integration points still to fill in are marked TODO. Run with:
//   npx tsx examples/market-maker.ts
//
// Env: AON_NODE_URL, AON_EVM_RPC_URL, AON_EXECUTOR_PRIVATE_KEY (the bot's EVM key,
// holding USDC), AON_SETTLEMENT_CONTRACT, USDC_ADDRESS, CHAIN_ID, CSD_API_URL,
// CSD_GENESIS_HASH, CSD_SEND_CMD (see sendCsd), STATE_FILE.

import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, http, getAddress, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AonNodeClient, finalizeObject } from "@intervalplace/aon-sdk";
import {
  csdUsdcNamespace,
  EARLY_RELEASE_TYPES,
  buildCsdSellOfferObject,
  buildCsdUsdcAuthorizationObject,
  buildCsdUsdcEarlyReleaseObject,
  csdUsdcAuthHash,
  makeCsdPaymentProofObject,
  lockCsdUsdcOnEvm,
  releaseEarlyOnEvm,
  executeCsdUsdcSettlementOnEvm,
} from "../src/index.js";

// ── Config ────────────────────────────────────────────────────────────────────

const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`${k} missing`); return v; };
const CFG = {
  aon:            env("AON_NODE_URL", "https://node2.aon.network"),
  rpc:            env("AON_EVM_RPC_URL"),
  key:            env("AON_EXECUTOR_PRIVATE_KEY") as Hex,
  settlement:     getAddress(env("AON_SETTLEMENT_CONTRACT")),
  usdc:           getAddress(env("USDC_ADDRESS")),
  chainId:        Number(env("CHAIN_ID", "8453")),
  csdApi:         env("CSD_API_URL", "http://127.0.0.1:8887"),
  csdGenesis:     env("CSD_GENESIS_HASH") as Hex,
  stateFile:      env("STATE_FILE", "./mm-state.json"),
  // Prices in USDC (6 decimals) per 1 CSD (1e8 units). TODO: your own pricing.
  askUsdcPerCsd:  BigInt(env("ASK_USDC_PER_CSD", "110000")),   // bot sells CSD at 0.11
  bidUsdcPerCsd:  BigInt(env("BID_USDC_PER_CSD", "90000")),    // bot buys CSD at 0.09
  // Risk limits
  earlyReleaseConfirmations: Number(env("EARLY_RELEASE_CONFIRMATIONS", "1")),
  maxTradeUsdc:             BigInt(env("MAX_TRADE_USDC", "50000000")),            // 50 USDC
  maxUnconfirmedUsdc:       BigInt(env("MAX_UNCONFIRMED_USDC", "200000000")),     // released early, not yet deep
  maxOpenLocksUsdc:         BigInt(env("MAX_OPEN_LOCKS_USDC", "300000000")),      // B: USDC locked at once
};
const me = privateKeyToAccount(CFG.key);
const aon = new AonNodeClient(CFG.aon);
const pub = createPublicClient({ transport: http(CFG.rpc) });
const domain = { name: "AON CSD/USDC", version: "3", chainId: CFG.chainId, verifyingContract: CFG.settlement };
const settlementAbi = [
  { type: "function", name: "usdcLocked", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "finalizedAuthorization", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "lockedAt", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
] as const;
const isLocked = (h: Hex) => pub.readContract({ address: CFG.settlement, abi: settlementAbi, functionName: "usdcLocked", args: [h] });
const lockedAt = (h: Hex) => pub.readContract({ address: CFG.settlement, abi: settlementAbi, functionName: "lockedAt", args: [h] });
const isFinal  = (h: Hex) => pub.readContract({ address: CFG.settlement, abi: settlementAbi, functionName: "finalizedAuthorization", args: [h] });

// ── State (persisted; holds the per-trade CSD keys, so keep it private) ───────

type Trade = {
  dir: "A" | "B"; authObjHash: string; authHash: Hex; usdcAmount: string; csdAmount: string;
  csdTxid?: string;                     // A: our payment; B: the user's payment to us
  csdKey?: string; csdAddr20?: string;  // B: the fresh address we receive on
  released?: boolean; settled?: boolean;
};
const state: { sellOffer?: string; buyOffer?: string; trades: Record<string, Trade>; handled: string[] } =
  existsSync(CFG.stateFile) ? JSON.parse(readFileSync(CFG.stateFile, "utf8")) : { trades: {}, handled: [] };
const save = () => writeFileSync(CFG.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });

// ── CSD helpers ───────────────────────────────────────────────────────────────

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const hash160 = (b: Buffer) => createHash("ripemd160").update(sha256(b)).digest();
const csd = async (path: string) => (await fetch(`${CFG.csdApi}${path}`)).json() as Promise<any>;
const csdTipHeight = async () => Number((await csd("/tip")).height);

// A fresh CSD key + address (addr20 = hash160 of the compressed pubkey) per trade
function freshCsdAddress() {
  const key = ("0x" + randomBytes(32).toString("hex")) as Hex;
  const uncompressed = Buffer.from(privateKeyToAccount(key).publicKey.slice(4), "hex"); // x || y
  const x = uncompressed.subarray(0, 32), yOdd = uncompressed[63] & 1;
  const addr20 = hash160(Buffer.concat([Buffer.from([yOdd ? 3 : 2]), x])).toString("hex");
  return { key, addr20 };
}

// Incoming payments to an address, with confirmations
async function paymentsTo(addr20: string) {
  const [act, tip] = await Promise.all([csd(`/address/${addr20}/activity?limit=50`), csdTipHeight()]);
  return (act.activity ?? [])
    .filter((x: any) => BigInt(x.value_delta) > 0n)
    .map((x: any) => ({ txid: x.txid as string, value: BigInt(x.value_delta), confirmations: tip - Number(x.height) + 1 }));
}

// TODO: send CSD with the csd CLI wallet. CSD_SEND_CMD is a command template, e.g.
//   csd wallet spend --privkey <KEY> --auto-input --output {addr}:{value} --fee 10000
// Must print the txid (0x + 64 hex).
const run = promisify(execFile);
async function sendCsd(addr20: string, value: bigint): Promise<string> {
  const [cmd, ...args] = env("CSD_SEND_CMD").split(" ").map(a => a.replace("{addr}", addr20).replace("{value}", String(value)));
  const { stdout } = await run(cmd, args);
  const txid = stdout.match(/0x[0-9a-f]{64}/i)?.[0];
  if (!txid) throw new Error("CSD send printed no txid: " + stdout.slice(0, 200));
  return txid;
}

// ── Offers ────────────────────────────────────────────────────────────────────

async function publishOffers() {
  if (!state.sellOffer) {
    // TODO: size the offer from your CSD balance; refresh it before it expires
    const offer = buildCsdSellOfferObject({
      seller: me.address, sellerUsdcRecipient: me.address, csdGenesisHash: CFG.csdGenesis,
      csdAmount: String(100n * 10n ** 8n), usdcAmount: String(100n * CFG.askUsdcPerCsd),
      validBefore: Math.floor(Date.now() / 1000) + 24 * 3600,
    });
    await aon.putObject(offer); state.sellOffer = offer.objectHash!;
  }
  if (!state.buyOffer) {
    const offer = finalizeObject({
      objectType: "csd_buy_offer", schemaVersion: "1", namespace: "aon:csd-usdc", createdAt: Date.now(), references: [],
      payload: { offerType: "csd_usdc_buy", buyer: me.address, csdGenesisHash: CFG.csdGenesis,
        usdcPerCsd: String(CFG.bidUsdcPerCsd), maxUsdc: String(CFG.maxTradeUsdc), validBefore: Math.floor(Date.now() / 1000) + 24 * 3600 },
    } as any);
    await aon.putObject(offer); state.buyOffer = offer.objectHash!;
  }
  save();
}

// ── A. User buys CSD: pay as soon as their USDC is locked ─────────────────────

async function handleBuyers(objects: any[]) {
  for (const o of objects.filter(o => o.objectType === "authorization" && !state.handled.includes(o.objectHash))) {
    const a = o.payload?.authorization;
    if (!a || String(a.tradeIntentHash).toLowerCase() !== String(state.sellOffer).toLowerCase()) continue;
    if (getAddress(a.sellerUsdcRecipient) !== me.address) continue;
    try { await csdUsdcNamespace.validateObject!(o); } catch { state.handled.push(o.objectHash); continue; }
    const authHash = csdUsdcAuthHash(o);
    if (!(await isLocked(authHash))) continue;                        // wait for the executor's lock
    // Only pay a fresh lock, so there's plenty of time to settle before it expires
    if (BigInt(Math.floor(Date.now() / 1000)) - (await lockedAt(authHash)) > 300n) { state.handled.push(o.objectHash); continue; }
    if (BigInt(a.usdcAmount) * 10n ** 8n < BigInt(a.csdAmount) * CFG.askUsdcPerCsd) { state.handled.push(o.objectHash); continue; } // below our price
    const addr20 = String(a.sellerCsdScriptHash).slice(2, 42);       // the user's CSD address (20 bytes, left-aligned)
    const txid = await sendCsd(addr20, BigInt(a.csdAmount));
    state.trades[o.objectHash] = { dir: "A", authObjHash: o.objectHash, authHash, usdcAmount: a.usdcAmount, csdAmount: a.csdAmount, csdTxid: txid };
    state.handled.push(o.objectHash); save();
    console.log(`A: sent ${a.csdAmount} CSD units to ${addr20} (${txid}); settling after ${a.minConfirmations} confirmations`);
  }
}

// ── B. User sells CSD: lock our USDC against a fresh address ──────────────────

async function handleSellers(objects: any[]) {
  const openLocks = Object.values(state.trades).filter(t => t.dir === "B" && !t.released && !t.settled).reduce((s, t) => s + BigInt(t.usdcAmount), 0n);
  for (const r of objects.filter(o => o.objectType === "csd_sell_request" && !state.handled.includes(o.objectHash))) {
    state.handled.push(r.objectHash);
    if (!(r.references ?? []).includes(state.buyOffer)) continue;
    const csdAmount = BigInt(r.payload?.csdAmount ?? 0);
    const usdcAmount = (csdAmount * CFG.bidUsdcPerCsd) / 10n ** 8n;
    if (usdcAmount <= 0n || usdcAmount > CFG.maxTradeUsdc || openLocks + usdcAmount > CFG.maxOpenLocksUsdc) continue;
    const { key, addr20 } = freshCsdAddress();
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      buyer: me.address, sellerUsdcRecipient: getAddress(r.payload.sellerUsdcRecipient),
      sellerCsdScriptHash: ("0x" + addr20 + "00".repeat(12)) as Hex, csdGenesisHash: CFG.csdGenesis,
      tradeIntentHash: r.objectHash as Hex, csdAmount, usdc: CFG.usdc, usdcAmount,
      minConfirmations: 3n, executorFeeAmount: 0n, validAfter: BigInt(now - 60), validBefore: BigInt(now + 3600),
      nonce: keccak256(toHex(randomBytes(32))),
    };
    const signature = await me.signTypedData({ domain, types: csdUsdcNamespace.types() as any, primaryType: "CsdUsdcAuthorization", message: authorization as any });
    const authObj = await buildCsdUsdcAuthorizationObject({ authorization, signature, domain, references: [r.objectHash] });
    await aon.putObject(authObj);
    await lockCsdUsdcOnEvm({ authorization: authObj });               // we act as our own executor
    state.trades[authObj.objectHash!] = { dir: "B", authObjHash: authObj.objectHash!, authHash: csdUsdcAuthHash(authObj), usdcAmount: String(usdcAmount), csdAmount: String(csdAmount), csdKey: key, csdAddr20: addr20 };
    save();
    console.log(`B: locked ${usdcAmount} USDC units; waiting for ${csdAmount} CSD units at ${addr20}`);
  }
}

// ── Follow-up: early releases (B) and settlements (A) ─────────────────────────

async function followUp() {
  const unconfirmed = Object.values(state.trades).filter(t => t.dir === "B" && t.released && !t.settled).reduce((s, t) => s + BigInt(t.usdcAmount), 0n);
  for (const t of Object.values(state.trades)) {
    const authObj = await aon.getObject(t.authObjHash) as any;
    if (!authObj) continue;

    if (t.dir === "B" && !t.released) {
      // A fresh address can only receive this trade's payment
      const pay = (await paymentsTo(t.csdAddr20!)).find((p: any) => p.value >= BigInt(t.csdAmount) && p.confirmations >= CFG.earlyReleaseConfirmations);
      if (!pay) continue;
      if (!(await isLocked(t.authHash)) || await isFinal(t.authHash)) continue;
      if (unconfirmed + BigInt(t.usdcAmount) > CFG.maxUnconfirmedUsdc) continue;  // too exposed: let the proof settle it
      const sig = await me.signTypedData({ domain, types: EARLY_RELEASE_TYPES as any, primaryType: "CsdUsdcEarlyRelease", message: { authHash: t.authHash } });
      const rel = await buildCsdUsdcEarlyReleaseObject({ authorization: authObj, signature: sig });
      await aon.putObject(rel);
      const r = await releaseEarlyOnEvm({ authorization: authObj, release: rel });
      t.released = r.executed; t.csdTxid = pay.txid; save();
      console.log(`B: released ${t.usdcAmount} USDC units early (${r.executionTx}) on ${pay.confirmations} CSD confirmation(s)`);
      // TODO: sweep the CSD from csdKey into the main wallet once it's deep
    }

    if (t.dir === "A" && !t.settled && t.csdTxid) {
      const a = authObj.payload.authorization;
      if (await isFinal(t.authHash)) { t.settled = true; save(); continue; }
      const tx = await csd(`/tx/${t.csdTxid}`);
      if (!tx.ok || tx.height == null || (await csdTipHeight()) - Number(tx.height) + 1 < Number(a.minConfirmations)) continue;
      const proof = await makeCsdPaymentProofObject({ reserveHash: t.authObjHash, txid: t.csdTxid, expectedRecipientScriptPubKey: a.sellerCsdScriptHash, expectedAmount: a.csdAmount, minConfirmations: Number(a.minConfirmations) });
      await aon.putObject(proof as any);
      const res = await executeCsdUsdcSettlementOnEvm({ authorization: authObj, reserve: null, proof });
      t.settled = true; save();
      console.log(`A: settled with proof (${res.executionTx})`);
    }

    // Track depth of early releases for the exposure limit
    if (t.dir === "B" && t.released && !t.settled && t.csdTxid) {
      const tx = await csd(`/tx/${t.csdTxid}`);
      if (tx.ok && tx.height != null && (await csdTipHeight()) - Number(tx.height) + 1 >= 20) { t.settled = true; save(); }
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

await publishOffers();
console.log(`market maker ${me.address}: sell offer ${state.sellOffer}, buy offer ${state.buyOffer}`);
for (;;) {
  try {
    const objects = await aon.listObjects({ namespace: "aon:csd-usdc", limit: 1000 });
    await handleBuyers(objects);
    await handleSellers(objects);
    await followUp();
  } catch (e: any) { console.error("loop:", e?.message ?? e); }
  await new Promise(r => setTimeout(r, 15_000));
}
