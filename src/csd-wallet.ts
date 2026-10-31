// A small CSD wallet for browsers and bots: keys, addresses, transactions,
// signing, and the address-ownership proof the settlement contract checks.
//
// Everything here follows compute-substrate's consensus code:
//   - addresses: addr20 = ripemd160(sha256(compressed secp256k1 pubkey))  (crypto/mod.rs hash160)
//   - transactions: bincode, fixed-int, little-endian                    (types/mod.rs, codec/mod.rs)
//   - txid: sha256d(tx with input script_sigs emptied)                   (crypto/mod.rs txid)
//   - sighash: sha256d(tagged_hash("CSD_SIG_V1", stripped tx || CHAIN_ID_HASH))  (crypto/mod.rs sighash)
//   - script_sig: [64][sig64 compact low-S][33][pub33] = 99 bytes        (state/utxo.rs parse_scriptsig)
// Checked against CSD's own Rust code by test/wallet.test.mjs.
//
// Keys can be derived from an Ethereum wallet signature (deriveCsdWallet), so
// the same Ethereum wallet recreates the same CSD keys on any device. Anyone
// who gets that signature gets the CSD keys: only sign CSD_WALLET_MESSAGE on
// the site you trust.

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { ripemd160 } from "@noble/hashes/legacy";
import { hmac } from "@noble/hashes/hmac";
import { keccak_256 } from "@noble/hashes/sha3";

export type Hex = `0x${string}`;
export type Bytes = Uint8Array;

// sha256("compute-substrate-mainnet")  (params/mod.rs CHAIN_ID_HASH)
export const CSD_CHAIN_ID_HASH = hexToBytes("0x1b17c7b04d05394674ca2c8e24f7433e251a1973cac2000c7b60966546e0b875");
export const CSD_COIN = 100_000_000n;

export const CSD_WALLET_MESSAGE =
  "Covenant CSD wallet\n\n" +
  "Signing this creates your CSD wallet keys. Anyone with this signature can spend your CSD on Covenant, " +
  "so only sign it on covenant.market.\n\n" +
  "Version 1";

// ── bytes ──────────────────────────────────────────────────────────────────
export function hexToBytes(h: string): Bytes {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2) throw new Error("ODD_HEX");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
export const bytesToHex = (b: Bytes): Hex => ("0x" + Array.from(b, x => x.toString(16).padStart(2, "0")).join("")) as Hex;
const concat = (...xs: Bytes[]) => { const n = xs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(n); let k = 0; for (const x of xs) { o.set(x, k); k += x.length; } return o; };
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64 = (n: bigint | number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const utf8 = (s: string) => new TextEncoder().encode(s);
export const sha256d = (b: Bytes) => sha256(sha256(b));
export const hash160 = (b: Bytes) => ripemd160(sha256(b));

// ── keys ───────────────────────────────────────────────────────────────────
export type CsdKey = { index: number; priv: Bytes; pub33: Bytes; pub64: Bytes; addr20: Hex };

export function keyFromPrivate(priv: Bytes, index = 0): CsdKey {
  const pub33 = secp256k1.getPublicKey(priv, true);
  const pub64 = secp256k1.getPublicKey(priv, false).slice(1);
  return { index, priv, pub33, pub64, addr20: bytesToHex(hash160(pub33)) };
}

// Deterministic keys from a wallet signature over CSD_WALLET_MESSAGE
export function deriveCsdWallet(walletSignature: Hex) {
  const seed = sha256(concat(utf8("AON CSD wallet v1"), hexToBytes(walletSignature)));
  const key = (index: number): CsdKey => {
    for (let ctr = 0; ; ctr++) {
      const d = hmac(sha256, seed, concat(utf8("key"), u32(index), u32(ctr)));
      if (secp256k1.utils.isValidPrivateKey(d)) return keyFromPrivate(d, index);
    }
  };
  return { key };
}

// ── transactions ───────────────────────────────────────────────────────────
export type CsdOutPoint = { txid: Hex; vout: number };
export type CsdTxIn = { prevout: CsdOutPoint; scriptSig: Bytes };
export type CsdTxOut = { value: bigint; addr20: Hex };
export type CsdTx = { version: number; inputs: CsdTxIn[]; outputs: CsdTxOut[]; locktime: number }; // app: None

export function serializeTx(tx: CsdTx, stripScripts = false): Bytes {
  const parts: Bytes[] = [u32(tx.version), u64(tx.inputs.length)];
  for (const i of tx.inputs) {
    const s = stripScripts ? new Uint8Array(0) : i.scriptSig;
    parts.push(hexToBytes(i.prevout.txid), u32(i.prevout.vout), u64(s.length), s);
  }
  parts.push(u64(tx.outputs.length));
  for (const o of tx.outputs) {
    const a = hexToBytes(o.addr20);
    if (a.length !== 20) throw new Error("BAD_ADDR20");
    parts.push(u64(o.value), a);
  }
  parts.push(u32(tx.locktime), u32(0)); // AppPayload::None
  return concat(...parts);
}

export const csdTxid = (tx: CsdTx): Hex => bytesToHex(sha256d(serializeTx(tx, true)));

export function csdSighash(tx: CsdTx): Bytes {
  const tag = sha256(utf8("CSD_SIG_V1"));
  const tagged = sha256(concat(tag, tag, serializeTx(tx, true), CSD_CHAIN_ID_HASH));
  return sha256d(tagged);
}

// The address behind each input's signature, if every input is validly signed
// for this transaction (null otherwise). Lets a bot discard forged payments
// without asking a node anything.
export function csdInputSigners(tx: CsdTx): Hex[] | null {
  const digest = csdSighash(tx), out: Hex[] = [];
  for (const i of tx.inputs) {
    const s = i.scriptSig;
    if (s.length !== 99 || s[0] !== 64 || s[65] !== 33) return null;
    try { if (!secp256k1.verify(s.slice(1, 65), digest, s.slice(66), { lowS: false })) return null; } catch { return null; }
    out.push(bytesToHex(hash160(s.slice(66))));
  }
  return out;
}

// Signs every input (each input's key must own its prevout's address)
export function signTx(tx: CsdTx, keys: CsdKey[]): CsdTx {
  if (keys.length !== tx.inputs.length) throw new Error("ONE_KEY_PER_INPUT");
  const digest = csdSighash(tx);
  return {
    ...tx,
    inputs: tx.inputs.map((inp, k) => {
      const sig = secp256k1.sign(digest, keys[k].priv, { lowS: true }).toCompactRawBytes();
      return { ...inp, scriptSig: concat(new Uint8Array([64]), sig, new Uint8Array([33]), keys[k].pub33) };
    }),
  };
}

export type CsdUtxo = { txid: Hex; vout: number; value: bigint; key: CsdKey };

// A plain payment: picks inputs (largest first), pays `to`, change to `change`
export function buildPayment(args: { utxos: CsdUtxo[]; to: CsdTxOut[]; change: Hex; fee?: bigint }): { tx: CsdTx; txid: Hex; spent: CsdOutPoint[] } {
  const fee = args.fee ?? 10_000n;
  const need = args.to.reduce((s, o) => s + o.value, 0n) + fee;
  const sorted = [...args.utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const picked: CsdUtxo[] = []; let total = 0n;
  for (const u of sorted) { if (total >= need) break; picked.push(u); total += u.value; }
  if (total < need) throw new Error("INSUFFICIENT_CSD");
  const outputs = [...args.to];
  if (total > need) outputs.push({ value: total - need, addr20: args.change });
  const unsigned: CsdTx = { version: 1, inputs: picked.map(u => ({ prevout: { txid: u.txid, vout: u.vout }, scriptSig: new Uint8Array(0) })), outputs, locktime: 0 };
  const tx = signTx(unsigned, picked.map(u => u.key));
  return { tx, txid: csdTxid(tx), spent: picked.map(u => ({ txid: u.txid, vout: u.vout })) };
}

// The node's /tx/submit JSON (serde: byte arrays as number arrays)
export function txToNodeJson(tx: CsdTx) {
  return {
    version: tx.version,
    inputs: tx.inputs.map(i => ({ prevout: { txid: Array.from(hexToBytes(i.prevout.txid)), vout: i.prevout.vout }, script_sig: Array.from(i.scriptSig) })),
    outputs: tx.outputs.map(o => ({ value: Number(o.value), script_pubkey: Array.from(hexToBytes(o.addr20)) })),
    locktime: tx.locktime,
    app: "None",
  };
}

// The reverse, for transactions handed over by another wallet. Only plain
// payments (app "None"); throws on anything malformed.
export function txFromNodeJson(j: any): CsdTx {
  const bytes = (a: any, n?: number) => {
    if (!Array.isArray(a) || (n !== undefined && a.length !== n) || a.length > 10_000 || !a.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) throw new Error("BAD_TX_JSON");
    return Uint8Array.from(a);
  };
  const int = (x: any, max: number) => { if (!Number.isSafeInteger(x) || x < 0 || x > max) throw new Error("BAD_TX_JSON"); return x; };
  if (!j || j.app !== "None" || !Array.isArray(j.inputs) || !Array.isArray(j.outputs) || j.inputs.length > 512 || j.outputs.length > 512) throw new Error("BAD_TX_JSON");
  return {
    version: int(j.version, 0xffffffff),
    inputs: j.inputs.map((i: any) => ({ prevout: { txid: bytesToHex(bytes(i?.prevout?.txid, 32)), vout: int(i?.prevout?.vout, 0xffffffff) }, scriptSig: bytes(i?.script_sig) })),
    outputs: j.outputs.map((o: any) => ({ value: BigInt(int(o?.value, Number.MAX_SAFE_INTEGER)), addr20: bytesToHex(bytes(o?.script_pubkey, 20)) })),
    locktime: int(j.locktime, 0xffffffff),
  };
}

// ── address-ownership proof for the settlement contract ─────────────────────
// Matches CsdUsdcSettlement.csdOwnershipDigest / _checkCsdAddressProof
export function csdOwnershipDigest(authHash: Hex): Bytes {
  return keccak_256(concat(utf8("AON CSD/USDC: I control this CSD address for trade "), hexToBytes(authHash)));
}
export function csdAddressProof(key: CsdKey, authHash: Hex): { pubKey: Hex; sig: Hex } {
  const s = secp256k1.sign(csdOwnershipDigest(authHash), key.priv, { lowS: true });
  return { pubKey: bytesToHex(key.pub64), sig: bytesToHex(concat(s.toCompactRawBytes(), new Uint8Array([27 + s.recovery]))) };
}
// A sale request: the seller names the exact coins they'll pay with and signs
// for them with the key that owns them (one signature per owning address), so
// opening a sale costs the opener real, confirmed coins.
export type CsdCoinRef = { txid: Hex; vout: number };
export function csdSaleRequestDigest(r: { csdAmount: bigint; usdcRecipient: string; validUntil: number; coins: CsdCoinRef[] }): Bytes {
  const coins = r.coins.map(c => `${c.txid.toLowerCase()}:${c.vout}`).join(",");
  return keccak_256(utf8(`covenant.market CSD sale request v1|${r.csdAmount}|${r.usdcRecipient.toLowerCase()}|${r.validUntil}|${coins}`));
}
// Signs any 32-byte digest in the same format as csdAddressProof
export function csdSignDigest(key: CsdKey, digest: Bytes): { pubKey: Hex; sig: Hex } {
  const s = secp256k1.sign(digest, key.priv, { lowS: true });
  return { pubKey: bytesToHex(key.pub64), sig: bytesToHex(concat(s.toCompactRawBytes(), new Uint8Array([27 + s.recovery]))) };
}
// The CSD address that signed `digest`, or null
export function csdSignerAddress(digest: Bytes, sig: Hex): Hex | null {
  try {
    const b = hexToBytes(sig); if (b.length !== 65 || (b[64] !== 27 && b[64] !== 28)) return null;
    const s = secp256k1.Signature.fromCompact(b.slice(0, 64)); if (s.hasHighS()) return null;
    const pub = s.addRecoveryBit(b[64] - 27).recoverPublicKey(digest).toRawBytes(true);
    return bytesToHex(hash160(pub));
  } catch { return null; }
}

// The address as the contract's bytes32 sellerCsdScriptHash (left-aligned)
export const addr20ToBytes32 = (addr20: Hex): Hex => (addr20 + "00".repeat(12)) as Hex;

// ── difficulty ─────────────────────────────────────────────────────────────
export function bitsToTarget(bits: number): bigint {
  const e = BigInt(bits >>> 24), m = BigInt(bits & 0xffffff);
  return e <= 3n ? m >> (8n * (3n - e)) : m << (8n * (e - 3n));
}
const POW_LIMIT_TARGET = bitsToTarget(0x1e00ffff);
// The csdMaxTarget to sign: 3/4 of the current difficulty (target x 4/3)
export function suggestedMaxTarget(currentBits: number): bigint {
  const t = bitsToTarget(currentBits) * 4n / 3n;
  return t > POW_LIMIT_TARGET ? POW_LIMIT_TARGET : t;
}

// ── node API ───────────────────────────────────────────────────────────────
export function csdNode(base: string, fetchImpl: typeof fetch = fetch) {
  const url = (p: string) => `${base.replace(/\/$/, "")}${p}`;
  const get = async (p: string) => { const r = await fetchImpl(url(p)); if (!r.ok) throw new Error(`CSD_API_${r.status}`); return r.json(); };
  const addrHex = (a: Hex) => a.slice(2);
  return {
    async tip(): Promise<{ height: number; hash: Hex }> { const t = await get("/tip"); return { height: Number(t.height), hash: t.tip }; },
    async headerAt(height: number) { const b = await get(`/block/height/${height}`); return { hash: b.hash as Hex, ...b.header } as any; },
    async currentBits(): Promise<number> { const t = await this.tip(); return Number((await this.headerAt(t.height)).bits); },
    // Confirmed coins at an address, minus those already spent in the node's mempool
    // Confirmed coins at an address; by default leaving out those already being spent in the
    // mempool (`includeSpending` keeps them: "what has arrived here", not "what can be spent")
    async utxosAt(addr20: Hex, includeSpending = false): Promise<{ txid: Hex; vout: number; value: bigint }[]> {
      const r = await get(`/utxos/${addrHex(addr20)}${includeSpending ? "" : "?available=true"}`);
      return (r.utxos ?? []).map((u: any) => ({ txid: String(u.txid).toLowerCase() as Hex, vout: Number(u.vout), value: BigInt(u.value) }));
    },
    async utxos(key: CsdKey): Promise<CsdUtxo[]> { return (await this.utxosAt(key.addr20)).map(u => ({ ...u, key })); },
    async activity(addr20: Hex, limit = 50) { return (await get(`/address/${addrHex(addr20)}/activity?limit=${limit}`)).activity ?? []; },
    async tx(txid: Hex) { return get(`/tx/${txid}`); },
    async submit(tx: CsdTx): Promise<Hex> {
      const r = await fetchImpl(url("/tx/submit"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: txToNodeJson(tx) }) });
      const j = await r.json();
      if (!j.ok) throw new Error(`CSD_SUBMIT_FAILED: ${j.err ?? r.status}`);
      return j.txid;
    },
  };
}

// Is a payment someone published really on its way to `to`, before it's in a block? It must be
// the transaction it says, pay `to` at least `amount`, be properly signed, and the CSD node must
// hold it in its mempool or take it now (the node checks its coins are real and in a block;
// anything made up is refused). A conflicting spend of the same coins by the sender could still
// win the next block, so this is "on its way", not final: show it as unconfirmed.
export async function incomingPaymentLooksReal(node: ReturnType<typeof csdNode>, csdTxJson: unknown, txid: string, to: Hex, amount: bigint): Promise<boolean> {
  let tx: CsdTx;
  try { tx = txFromNodeJson(csdTxJson); } catch { return false; }
  if (csdTxid(tx).toLowerCase() !== txid.toLowerCase()) return false;
  if (tx.outputs.filter(o => o.addr20.toLowerCase() === to.toLowerCase()).reduce((s, o) => s + o.value, 0n) < amount) return false;
  if (!csdInputSigners(tx)) return false;
  try { await node.submit(tx); return true; } catch (e: any) { return /already present/i.test(String(e?.message)); }
}
