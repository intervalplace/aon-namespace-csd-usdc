// A stand-in CSD node for tests: the real node's HTTP API shapes (/tip,
// /block/height, /utxos, /proof/tx, /tx/:id, /tx/submit), a UTXO set, a
// first-seen mempool that checks signatures like CSD's validate_tx_for_mempool
// (inputs must be confirmed coins), and blocks mined on demand at an easy PoW.
import http from "node:http";
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { serializeTx, csdTxid, csdSighash, hash160, bytesToHex, txFromNodeJson, txToNodeJson } from "../src/csd-wallet.ts";

const sha = (b) => createHash("sha256").update(b).digest();
const dsha = (b) => sha(sha(b));
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hx = (b) => "0x" + Buffer.from(b).toString("hex");
const unhex = (h) => Buffer.from(h.replace(/^0x/, ""), "hex");
const targetOf = (bits) => { const e = BigInt(bits >>> 24), m = BigInt(bits & 0xffffff); return e <= 3n ? m >> (8n * (3n - e)) : m << (8n * (e - 3n)); };

export async function startFakeCsdNode({ port, bits = 0x207fffff, clock = () => Math.floor(Date.now() / 1000) }) {
  const blocks = []; // { hash, header, txs: [{ tx, raw, txid }] }
  const utxos = new Map(); // "txid:vout" -> { value, addr20, height, coinbase }
  const mempool = new Map(); // txid -> tx
  const spentInMempool = new Map(); // "txid:vout" -> txid
  const key = (txid, vout) => `${txid.toLowerCase()}:${vout}`;

  function headerBytes(h) { return Buffer.concat([u32(h.version), unhex(h.prev), unhex(h.merkle), u64(h.time), u32(h.bits), u32(h.nonce)]); }
  function merkleRoot(ids) {
    let layer = ids.map(unhex);
    while (layer.length > 1) { const n = []; for (let i = 0; i < layer.length; i += 2) n.push(dsha(Buffer.concat([layer[i], layer[i + 1] ?? layer[i]]))); layer = n; }
    return layer[0];
  }
  function branch(ids, idx) {
    const out = []; let layer = ids.map(unhex);
    while (layer.length > 1) {
      const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
      out.push({ hash: hx(layer[sib] ?? layer[idx]), position: idx % 2 === 0 ? "right" : "left" });
      const n = []; for (let i = 0; i < layer.length; i += 2) n.push(dsha(Buffer.concat([layer[i], layer[i + 1] ?? layer[i]]))); layer = n; idx = Math.floor(idx / 2);
    }
    return out;
  }
  function validate(tx) {
    if (!tx.inputs.length) throw new Error("tx has no inputs");
    const digest = csdSighash(tx); let inSum = 0n;
    for (const i of tx.inputs) {
      const u = utxos.get(key(i.prevout.txid, i.prevout.vout));
      if (!u) throw new Error("missing utxo (not in the confirmed UTXO set)");
      const s = i.scriptSig;
      if (s.length !== 99 || s[0] !== 64 || s[65] !== 33) throw new Error("bad scriptsig");
      if (bytesToHex(hash160(s.slice(66))) !== u.addr20) throw new Error("pubkey does not own the coin");
      if (!secp256k1.verify(s.slice(1, 65), digest, s.slice(66), { lowS: true })) throw new Error("bad signature");
      inSum += u.value;
    }
    const outSum = tx.outputs.reduce((a, o) => a + o.value, 0n);
    if (outSum >= inSum) throw new Error("fee must be positive");
  }
  function submit(tx) {
    const txid = csdTxid(tx);
    if (mempool.has(txid)) return { ok: false, txid, err: "already present or mempool conflict" };
    validate(tx);
    for (const i of tx.inputs) if (spentInMempool.has(key(i.prevout.txid, i.prevout.vout))) return { ok: false, txid, err: "already present or mempool conflict" };
    mempool.set(txid, tx); for (const i of tx.inputs) spentInMempool.set(key(i.prevout.txid, i.prevout.vout), txid);
    return { ok: true, txid };
  }
  // Mines a block with the mempool (or `only` these txs), paying `reward` to `rewardTo`
  function mine({ rewardTo = "0x" + "77".repeat(20), reward = 50n * 100_000_000n, only } = {}) {
    const height = blocks.length;
    const coinbase = { version: 1, inputs: [{ prevout: { txid: "0x" + "00".repeat(32), vout: 0xffffffff }, scriptSig: u64(height) }], outputs: [{ value: reward, addr20: rewardTo }], locktime: 0 };
    const cbid = hx(dsha(serializeTx(coinbase))); // coinbase txid keeps its script
    const txs = [{ tx: coinbase, txid: cbid }, ...[...(only ?? mempool.values())].map(tx => ({ tx, txid: csdTxid(tx) }))];
    const prev = blocks.at(-1);
    const header = { version: 1, prev: prev ? prev.hash : "0x" + "00".repeat(32), merkle: hx(merkleRoot(txs.map(t => t.txid))), time: Math.max(prev ? prev.header.time + 120 : 0, clock()), bits, nonce: 0 };
    for (;; header.nonce++) if (BigInt(hx(dsha(headerBytes(header)))) <= targetOf(bits)) break;
    const block = { hash: hx(dsha(headerBytes(header))), header, txs };
    for (const [n, t] of txs.entries()) {
      if (n > 0) for (const i of t.tx.inputs) utxos.delete(key(i.prevout.txid, i.prevout.vout));
      t.tx.outputs.forEach((o, v) => utxos.set(key(t.txid, v), { value: o.value, addr20: o.addr20, height, coinbase: n === 0 }));
      mempool.delete(t.txid);
    }
    // drop mempool txs whose inputs are now gone
    spentInMempool.clear();
    for (const [id, tx] of [...mempool]) { try { validate(tx); tx.inputs.forEach(i => spentInMempool.set(key(i.prevout.txid, i.prevout.vout), id)); } catch { mempool.delete(id); } }
    blocks.push(block);
    return block;
  }
  // Test helper: a transaction disappears from the mempool (held up somewhere)
  function drop(txid) { const tx = mempool.get(txid); if (!tx) return; mempool.delete(txid); for (const i of tx.inputs) spentInMempool.delete(key(i.prevout.txid, i.prevout.vout)); }
  // Test helper: a reorg. The last `depth` blocks are replaced by depth + 1 other blocks without
  // their transactions (as if a miner with more hash power left them out)
  let reorgs = 0;
  function reorg(depth) {
    const to = "0x" + (0x60 + (++reorgs % 16)).toString(16).repeat(20); // (different blocks each time)
    blocks.splice(blocks.length - depth, depth);
    utxos.clear(); mempool.clear(); spentInMempool.clear();
    blocks.forEach((b, height) => b.txs.forEach((t, n) => {
      if (n > 0) for (const i of t.tx.inputs) utxos.delete(key(i.prevout.txid, i.prevout.vout));
      t.tx.outputs.forEach((o, v) => utxos.set(key(t.txid, v), { value: o.value, addr20: o.addr20, height, coinbase: n === 0 }));
    }));
    for (let i = 0; i <= depth; i++) mine({ rewardTo: to });
  }
  // Test helper: a conflicting spend gets mined instead (a double spend)
  function doubleSpend(tx) {
    for (const i of tx.inputs) { const id = spentInMempool.get(key(i.prevout.txid, i.prevout.vout)); if (id) mempool.delete(id); }
    spentInMempool.clear(); for (const [id, t] of mempool) t.inputs.forEach(i => spentInMempool.set(key(i.prevout.txid, i.prevout.vout), id));
    validate(tx); return mine({ only: [tx] });
  }
  const hdr = (h) => ({ version: h.version, prev: h.prev, merkle: h.merkle, time: h.time, bits: h.bits, nonce: h.nonce });
  const find = (txid) => { for (const [height, b] of blocks.entries()) { const i = b.txs.findIndex(t => t.txid === txid.toLowerCase()); if (i >= 0) return { height, b, i }; } return null; };

  async function route(req, body) {
    const u = new URL(req.url, "http://x"), p = u.pathname; let m;
    const tipH = blocks.length - 1;
    if (p === "/tip") return { height: tipH, tip: blocks[tipH].hash };
    if ((m = p.match(/^\/block\/height\/(\d+)$/))) { const b = blocks[+m[1]]; return b ? { ok: true, hash: b.hash, height: +m[1], header: hdr(b.header), txs: b.txs.map(t => ({ txid: t.txid })) } : { ok: false, hash: "", height: +m[1], header: { err: "height beyond tip" }, txs: [] }; }
    if ((m = p.match(/^\/utxos\/([0-9a-f]{40})$/))) {
      const out = [];
      for (const [k, v] of utxos) if (v.addr20 === "0x" + m[1] && !(u.searchParams.get("available") === "true" && spentInMempool.has(k))) {
        const [txid, vout] = k.split(":"); out.push({ txid, vout: +vout, value: Number(v.value), height: v.height, confirmations: tipH - v.height + 1, coinbase: v.coinbase });
      }
      return { utxos: out, confirmed_balance: out.reduce((a, x) => a + x.value, 0) };
    }
    if ((m = p.match(/^\/tx\/(0x[0-9a-f]{64})$/))) { const f = find(m[1]); return f ? { ok: true, txid: m[1], block_hash: f.b.hash, height: f.height } : { ok: false, txid: m[1], err: "not found" }; }
    if ((m = p.match(/^\/proof\/tx\/(0x[0-9a-f]{64})$/))) {
      const f = find(m[1]); if (!f) return { ok: false, error: "tx not found in main chain" };
      return { ok: true, txid: m[1], tx_index: f.i, tx_raw: hx(serializeTx(f.b.txs[f.i].tx)), block_hash: f.b.hash, height: f.height, confirmations: tipH - f.height + 1, header: hdr(f.b.header), merkle_branch: branch(f.b.txs.map(t => t.txid), f.i) };
    }
    if ((m = p.match(/^\/address\/([0-9a-f]{40})\/activity$/))) return { activity: [] };
    if (p === "/tx/submit" && req.method === "POST") { try { return submit(txFromNodeJson(body.tx)); } catch (e) { return { ok: false, txid: "", err: e.message }; } }
    return { error: "not found" };
  }
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const out = await route(req, raw ? JSON.parse(raw) : undefined);
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out));
  });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  mine(); // genesis
  return { url: `http://127.0.0.1:${port}`, mine, doubleSpend, reorg, drop, submit, mempool, utxos, blocks, close: () => new Promise(r => server.close(r)), txToNodeJson };
}
