// Runs scripts/check-against-csd.mjs against a stand-in CSD node serving the
// mainnet-difficulty fixture chain.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "node:url";

const hs = JSON.parse(readFileSync(new URL("./fixtures/mainnet-difficulty-chain.json", import.meta.url), "utf8"));
const tipH = hs.at(-1).height;
const server = createServer((req, res) => {
  if (req.url === "/tip") return res.end(JSON.stringify({ ok: true, height: tipH }));
  const m = req.url.match(/^\/block\/height\/(\d+)$/);
  const h = m && hs.find(x => x.height === Number(m[1]));
  if (h) return res.end(JSON.stringify({ ok: true, hash: h.hash, height: h.height, header: { version: h.version, prev: h.prev, merkle: h.merkle, time: h.time, bits: h.bits, nonce: h.nonce } }));
  res.statusCode = 404; res.end("{}");
});
await new Promise(r => server.listen(0, r));
console.log("\n[check script] against a stand-in CSD node (mainnet-difficulty chain)");
const out = await new Promise((resolve, reject) => execFile(process.execPath, [fileURLToPath(new URL("../scripts/check-against-csd.mjs", import.meta.url)), `http://127.0.0.1:${server.address().port}`, "60"],
  (err, stdout, stderr) => err ? reject(new Error(stdout + stderr)) : resolve(stdout)));
server.close();
if (!/✓ All 60 real CSD blocks pass/.test(out)) { console.error("  FAIL:", out); process.exit(1); }
console.log("  ok - the check script fetches, verifies hashes, and the contract accepts the blocks");
