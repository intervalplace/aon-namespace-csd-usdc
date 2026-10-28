// Cross-checks the oracle's CSD consensus math (LWMA difficulty, median time
// past, work) against vectors produced by CSD's own Rust code
// (test/lwma-vectors: the pure functions copied verbatim from
// compute-substrate src/chain/pow.rs). Regenerate with:
//   cd test/lwma-vectors && cargo run --release > vectors.json
import { createPublicClient, http, defineChain } from "viem";
import { readFileSync } from "fs";

const RPC = `http://127.0.0.1:${process.env.ANVIL_PORT ?? "8546"}`;
const art = JSON.parse(readFileSync(new URL("./artifacts.json", import.meta.url), "utf8"));
const vectors = JSON.parse(readFileSync(new URL("./lwma-vectors/vectors.json", import.meta.url), "utf8"));
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http() });
const { privateKeyToAccount } = await import("viem/accounts");
const { createWalletClient } = await import("viem");
const acct = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const wc = createWalletClient({ account: acct, chain, transport: http() });
const H = (await pub.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: art.CsdConsensusHarness.abi, bytecode: art.CsdConsensusHarness.bytecode }) })).contractAddress;
const read = (fn, args) => pub.readContract({ address: H, abi: art.CsdConsensusHarness.abi, functionName: fn, args });

const bitsToTarget = (bits) => { const e = BigInt(bits >>> 24), m = BigInt(bits & 0xffffff); return e <= 3n ? m >> (8n * (3n - e)) : m << (8n * (e - 3n)); };
let bad = 0, n = 0;
console.log(`\n[consensus] ${vectors.length} vectors from CSD's Rust code`);
for (let i = 0; i < vectors.length; i += 25) {
  await Promise.all(vectors.slice(i, i + 25).map(async v => {
    const times = v.times.map(BigInt), bits = v.bits;
    const [want, mtp, work] = await Promise.all([
      read("expectedBits", [v.parentBits, BigInt(v.height), times, bits, v.limit]),
      read("medianTimePast", [times.slice(0, 11)]),
      read("workFromTarget", [bitsToTarget(v.parentBits)]),
    ]);
    n++;
    if (want !== v.want || mtp !== BigInt(v.mtp) || work !== BigInt(v.parentWork)) {
      bad++; if (bad <= 5) console.error("  MISMATCH", JSON.stringify({ height: v.height, want: v.want, got: want, mtp: v.mtp, gotMtp: String(mtp), work: v.parentWork, gotWork: String(work) }));
    }
  }));
}
if (bad) { console.error(`  FAIL: ${bad} of ${n} vectors differ`); process.exit(1); }
console.log(`  ok - difficulty, median time past and work match CSD's code on all ${n} vectors`);
