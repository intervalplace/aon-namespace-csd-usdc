// The contract's CSD encodings against vectors from CSD's own serializer
// (test/csd-tx-vectors/txvectors.rs, built inside the compute-substrate
// crate): txids, merkle root, header hash, strict transaction parsing.
import { createPublicClient, createWalletClient, http, defineChain, BaseError, ContractFunctionRevertedError, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";
import { readFileSync } from "fs";

const RPC = `http://127.0.0.1:${process.env.ANVIL_PORT ?? "8546"}`;
const art = JSON.parse(readFileSync(new URL("./artifacts.json", import.meta.url), "utf8")).TestCsdUsdcSettlement;
const v = JSON.parse(readFileSync(new URL("./fixtures/csd-tx-vectors.json", import.meta.url), "utf8"));
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http() });
const wc = createWalletClient({ account: privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"), chain, transport: http() });
let pass = 0; const check = (c, l) => { if (!c) { console.error("  FAIL:", l); process.exit(1); } pass++; console.log("  ok -", l); };
const C = (await pub.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: art.abi, bytecode: art.bytecode, args: ["0x0000000000000000000000000000000000000001", 30_000_000n, keccak256(toHex("g"))] }) })).contractAddress;
const read = (fn, args) => pub.readContract({ address: C, abi: art.abi, functionName: fn, args });
const err = async (p) => { try { await p; return null; } catch (e) { const r = e instanceof BaseError ? e.walk(x => x instanceof ContractFunctionRevertedError) : null; return r?.data?.errorName ?? "?"; } };
const pad = (h20) => h20 + "00".repeat(12);

console.log("\n[encoding] against CSD's own serializer");
for (const [i, t] of v.txs.entries()) if (i > 0) check(await read("txidOf", [t.raw]) === t.txid, `txid of CSD vector ${i} matches CSD's txid`);
const sha = (b) => createHash("sha256").update(b).digest(), dsha = (b) => sha(sha(b));
const ids = v.txs.map(t => Buffer.from(t.txid.slice(2), "hex"));
let layer = ids; while (layer.length > 1) { const n = []; for (let i = 0; i < layer.length; i += 2) n.push(dsha(Buffer.concat([layer[i], layer[i + 1] ?? layer[i]]))); layer = n; }
check("0x" + layer[0].toString("hex") === v.merkle, "merkle root from the txids matches CSD's");
check(await read("headerHashOf", [{ ...v.header, time: BigInt(v.header.time) }]) === v.headerHash, "header hash matches CSD's");
await read("verifyTx", [v.txs[1].raw, pad("0x" + "ab".repeat(20)), 123_456_789n]);
await read("verifyTx", [v.txs[1].raw, pad("0x" + "cd".repeat(20)), 5n]);
check(true, "a real 2-output payment is parsed and found (both outputs)");
await read("verifyTx", [v.txs[2].raw, pad("0x" + "11".repeat(20)), 42n]);
await read("verifyTx", [v.txs[3].raw, pad("0x" + "44".repeat(20)), 3n]);
check(true, "transactions with Attest and Propose payloads parse");
check(await err(read("verifyTx", [v.txs[1].raw, pad("0x" + "ab".repeat(20)), 123_456_790n])) === "CsdPaymentOutputNotFound", "one unit short isn't a payment");
check(await err(read("verifyTx", [v.txs[1].raw + "00", pad("0x" + "ab".repeat(20)), 1n])) === "CsdTxMalformed", "a trailing byte is rejected");
check(await err(read("verifyTx", [v.txs[1].raw.slice(0, -2), pad("0x" + "ab".repeat(20)), 1n])) === "CsdTxMalformed", "a truncated transaction is rejected");
check(await err(read("verifyTx", [v.txs[0].raw, pad("0x" + "09".repeat(20)), 1n])) === "CsdCoinbaseNotSupported", "coinbase payments are refused (their txid keeps the input script)");
// The reviewer's exploit shape: a decoy output whose address looks like a length prefix
{ const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const buyer = Buffer.alloc(20, 0xab);
  const decoy = Buffer.concat([u64(4), Buffer.alloc(4, 1), Buffer.alloc(8, 0xff)]); // 20 bytes
  const raw = Buffer.concat([Buffer.from([1, 0, 0, 0]), u64(1), Buffer.alloc(32, 5), Buffer.alloc(4), u64(0), u64(2), u64(1), decoy, u64(20), buyer, Buffer.alloc(8)]);
  check(await err(read("verifyTx", ["0x" + raw.toString("hex"), pad("0x" + "ab".repeat(20)), 30_000_000n])) === "CsdPaymentOutputNotFound", "a 20-unit payment dressed up with a fake length prefix isn't read as a big payment"); }
console.log(`\nAll ${pass} encoding checks passed.`);
