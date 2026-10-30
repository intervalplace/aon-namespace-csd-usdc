// The client side of trading CSD/USDC over AON: the objects a buyer or seller
// publishes, and reading the market maker's offers and responses.
//
//   buy:  authorization (buyer, references the offer) → response (market maker)
//   sell: request (seller, references the offer) → response + the market maker's authorization
//         payment (seller, references that authorization) → response (+ release)
//
// Offers and responses are signed by the market maker ("eip191-object": a
// personal-sign over the hash of the object without its signature).

import { finalizeObject, hashObject } from "@intervalplace/aon-sdk";
import { recoverMessageAddress, getAddress, type Hex } from "viem";

const NS = "aon:csd-usdc";
const s = (v: unknown) => (typeof v === "bigint" ? String(v) : v);
const strings = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, s(v)]));

// Who signed an "eip191-object" signed object (offers, responses), or null
export async function objectSigner(o: any): Promise<string | null> {
  try {
    if (o?.signature?.scheme !== "eip191-object") return null;
    const { signature, objectHash, ...unsigned } = o;
    if (hashObject({ ...unsigned, signature } as any).toLowerCase() !== String(objectHash).toLowerCase()) return null;
    return getAddress(await recoverMessageAddress({ message: { raw: hashObject(unsigned as any) as Hex }, signature: signature.signature }));
  } catch { return null; }
}

// The buyer's authorization, with what the market maker needs to lock it
export function buyAuthorizationObject(a: { offerHash: string; authorization: Record<string, unknown>; signature: Hex; domain: any; types: any;
  addressProof: { pubKey: Hex; sig: Hex }; permit?: { deadline: bigint | string; v: number; r: Hex; s: Hex } }) {
  const authorization = strings(a.authorization);
  return finalizeObject({
    objectType: "authorization", schemaVersion: "1", namespace: NS, createdAt: Date.now(), references: [a.offerHash.toLowerCase()],
    payload: { authorizationType: "csd_usdc_release", authorization, csdAddressProof: a.addressProof, usdcPermit: a.permit ? strings(a.permit as any) : undefined },
    signature: { scheme: "eip712", signer: getAddress(String(a.authorization.buyer)), domain: a.domain, types: a.types, primaryType: "CsdUsdcAuthorization",
      message: authorization, signature: a.signature },
  } as any);
}

// The seller's request: the coins they'll pay with, signed by the keys that own them
export function saleRequestObject(r: { offerHash: string; csdAmount: bigint; usdcRecipient: string; minUsdcOut: bigint; validUntil: number;
  coins: { txid: Hex; vout: number }[]; proofs: { pubKey: Hex; sig: Hex }[]; owners: string[] }) {
  return finalizeObject({
    objectType: "request", schemaVersion: "1", namespace: NS, createdAt: Date.now(), references: [r.offerHash.toLowerCase()],
    payload: { requestType: "csd_usdc_sale", csdAmount: String(r.csdAmount), usdcRecipient: getAddress(r.usdcRecipient), minUsdcOut: String(r.minUsdcOut),
      validUntil: r.validUntil, coins: r.coins },
    signature: { scheme: "csd-sale-request-v1", signers: r.owners, proofs: r.proofs },
  } as any);
}

// The seller's signed CSD payment for their sale (references the market maker's authorization)
export function salePaymentObject(p: { authorizationObjectHash: string; csdTxid: Hex; csdTx: unknown }) {
  return finalizeObject({
    objectType: "payment", schemaVersion: "1", namespace: NS, createdAt: Date.now(), references: [p.authorizationObjectHash.toLowerCase()],
    payload: { paymentType: "csd_usdc_sale_payment", csdTxid: p.csdTxid, csdTx: p.csdTx },
  } as any);
}

export function aonApi(base: string, fetchImpl: typeof fetch = fetch) {
  const url = base.replace(/\/$/, "");
  return {
    async put(o: any) {
      const r = await fetchImpl(`${url}/v1/objects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error?.code ?? `AON_${r.status}`);
      return o.objectHash as string;
    },
    async inbound(hash: string): Promise<any[]> { const r = await fetchImpl(`${url}/v1/objects/${hash}/references`); return (await r.json()).inbound ?? []; },
    async list(objectType: string, limit = 30): Promise<any[]> {
      const r = await fetchImpl(`${url}/v1/objects?namespace=${encodeURIComponent(NS)}&objectType=${objectType}&limit=${limit}`);
      return (await r.json()).objects ?? [];
    },
    async get(hash: string): Promise<any | null> {
      const r = await fetchImpl(`${url}/v1/objects/${hash}`);
      return r.ok ? ((await r.json()).object ?? null) : null;
    },
    // The newest valid offers from the given market makers (signature checked). `hints` are
    // offer hashes to try first (the market maker lists its current ones), since anyone can
    // bury the real offers in a listing under junk ones.
    async offers(marketMakers: string[], hints: string[] = []) {
      const mm = marketMakers.map(a => a.toLowerCase()), out: { sell?: any; buy?: any } = {};
      const consider = async (o: any) => {
        const side = o?.payload?.offerType === "csd_usdc_sell_csd" ? "sell" : o?.payload?.offerType === "csd_usdc_buy_csd" ? "buy" : null;
        if (!side || out[side] || Number(o.payload?.validBefore) < Date.now() / 1000 || !(Number(o.createdAt) <= Date.now() + 120_000)) return;
        const signer = await objectSigner(o);
        if (signer && mm.includes(signer.toLowerCase()) && signer.toLowerCase() === String(o.payload.marketMaker).toLowerCase()) out[side] = o;
      };
      for (const h of hints) if (/^0x[0-9a-fA-F]{64}$/.test(h)) await consider(await this.get(h).catch(() => null));
      if (!out.sell || !out.buy) for (const o of await this.list("offer", 40)) await consider(o);
      return out;
    },
    // The market maker's signed receipt for a trade (references the trade's authorization object)
    async receipt(authObjectHash: string, authHash: string, marketMakers: string[]): Promise<any | null> {
      const mm = marketMakers.map(a => a.toLowerCase());
      for (const o of await this.inbound(authObjectHash)) {
        if (o.objectType !== "receipt" || String(o.payload?.authHash).toLowerCase() !== authHash.toLowerCase()) continue;
        const signer = await objectSigner(o);
        if (signer && mm.includes(signer.toLowerCase())) return o;
      }
      return null;
    },
    // Waits for the market maker's signed response to one of our objects
    async response(toHash: string, marketMaker: string, timeoutMs = 45_000): Promise<any> {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        for (const o of await this.inbound(toHash).catch(() => [])) {
          if (o.objectType !== "response") continue;
          const signer = await objectSigner(o);
          if (signer && signer.toLowerCase() === marketMaker.toLowerCase()) return o.payload;
        }
        await new Promise(r => setTimeout(r, 700));
      }
      throw new Error("NO_RESPONSE");
    },
  };
}
