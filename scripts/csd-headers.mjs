// Fetching CSD block headers from a CSD node's HTTP API, in the shape the
// header oracle takes. Shared by the deploy, relay and check scripts.
import { createHash } from "node:crypto";

// CSD mainnet genesis (compute-substrate src/params/mod.rs GENESIS_HASH)
export const CSD_GENESIS_HASH = "0x00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52";

const sha = (b) => createHash("sha256").update(b).digest();
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

export function bitsToTarget(bits) {
  const e = BigInt(bits >>> 24), m = BigInt(bits & 0xffffff);
  return e <= 3n ? m >> (8n * (3n - e)) : m << (8n * (e - 3n));
}
const POW_LIMIT_TARGET = bitsToTarget(0x1e00ffff);

// The csdMaxTarget an interface or bot should sign: blocks must have at least
// 3/4 of the current difficulty (target x 4/3), never easier than CSD's limit.
export function suggestedMaxTarget(currentBits) {
  const t = bitsToTarget(currentBits) * 4n / 3n;
  return t > POW_LIMIT_TARGET ? POW_LIMIT_TARGET : t;
}

export function headerHash(h) {
  const bytes = Buffer.concat([u32(h.version), Buffer.from(h.prev.slice(2), "hex"), Buffer.from(h.merkle.slice(2), "hex"), u64(h.time), u32(h.bits), u32(h.nonce)]);
  return "0x" + sha(sha(bytes)).toString("hex");
}

export function csdApi(base) {
  const get = async (path) => {
    const r = await fetch(`${base.replace(/\/$/, "")}${path}`);
    if (!r.ok) throw new Error(`CSD API ${path}: HTTP ${r.status}`);
    return r.json();
  };
  return {
    async tipHeight() { return Number((await get("/tip")).height); },
    // { hash, height, header: { version, prev, merkle, time, bits, nonce } } with the hash checked
    async headerAt(height) {
      const b = await get(`/block/height/${height}`);
      if (!b.ok && b.ok !== undefined) throw new Error(`CSD API: no block at height ${height}`);
      const h = b.header;
      const header = { version: Number(h.version), prev: h.prev, merkle: h.merkle, time: BigInt(h.time), bits: Number(h.bits), nonce: Number(h.nonce) };
      const hash = headerHash(header);
      if (b.hash && b.hash.toLowerCase() !== hash) throw new Error(`header hash mismatch at ${height}: node says ${b.hash}, computed ${hash}`);
      return { hash, height: Number(b.height ?? height), header };
    },
    async headersRange(from, to) { // inclusive, oldest first
      const out = [];
      for (let h = from; h <= to; h++) out.push(await this.headerAt(h));
      return out;
    },
  };
}
