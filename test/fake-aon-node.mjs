// A stand-in AON node for tests: the real node's object API (POST /v1/objects,
// GET /v1/objects newest first, GET /v1/objects/:hash, GET
// /v1/objects/:hash/references), in memory, with the same hash check.
import http from "node:http";
import { hashObject } from "@intervalplace/aon-sdk";

export async function startFakeAonNode({ port }) {
  const objects = new Map(); // hash -> object
  const order = [];          // insertion order
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const u = new URL(req.url, "http://x"), p = u.pathname; let m;
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body)); };
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST", "access-control-allow-headers": "content-type" }); return res.end(); }
    if (req.method === "POST" && p === "/v1/objects") {
      const o = JSON.parse(raw);
      if (!o.objectHash || hashObject(o).toLowerCase() !== o.objectHash.toLowerCase()) return send(400, { ok: false, error: { code: "OBJECT_HASH_MISMATCH" } });
      const h = o.objectHash.toLowerCase();
      if (!objects.has(h)) { objects.set(h, o); order.push(h); }
      return send(200, { ok: true, objectHash: h, object: o });
    }
    if (req.method === "GET" && p === "/v1/objects") {
      const ns = u.searchParams.get("namespace"), ty = u.searchParams.get("objectType"), ref = u.searchParams.get("references")?.toLowerCase();
      const limit = Number(u.searchParams.get("limit") ?? 50);
      const list = [...order].reverse().map(h => objects.get(h))
        .filter(o => (!ns || o.namespace === ns) && (!ty || o.objectType === ty) && (!ref || o.references.map(r => r.toLowerCase()).includes(ref)))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
      return send(200, { ok: true, objects: list, total: list.length });
    }
    if (req.method === "GET" && (m = p.match(/^\/v1\/objects\/(0x[0-9a-fA-F]{64})\/references$/))) {
      const t = m[1].toLowerCase();
      const all = order.map((h, i) => ({ o: objects.get(h), rid: i + 1 })).filter(x => x.o.references.map(r => r.toLowerCase()).includes(t));
      // Paged in arrival order when asked, like the real node
      if (u.searchParams.has("after") || u.searchParams.has("limit")) {
        const after = Number(u.searchParams.get("after") ?? 0), limit = Math.min(Number(u.searchParams.get("limit") ?? 50), 200);
        const page = all.filter(x => x.rid > after).slice(0, limit);
        return send(200, { ok: true, target: t, inbound: page.map(x => x.o), next: page.length ? page[page.length - 1].rid : after });
      }
      return send(200, { ok: true, target: t, inbound: all.map(x => x.o) });
    }
    if (req.method === "GET" && (m = p.match(/^\/v1\/objects\/(0x[0-9a-fA-F]{64})$/))) {
      const o = objects.get(m[1].toLowerCase());
      return o ? send(200, { ok: true, object: o }) : send(404, { ok: false, error: { code: "OBJECT_NOT_FOUND" } });
    }
    send(404, { ok: false });
  });
  await new Promise(r => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${port}`, objects, close: () => new Promise(r => server.close(r)) };
}
