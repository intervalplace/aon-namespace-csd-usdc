// The real oracle (CSD mainnet PoW limit, no test override) against a chain
// mined at mainnet difficulty by CSD's own difficulty code
// (test/lwma-vectors: `cargo run --release -- chain 90 > ../fixtures/mainnet-difficulty-chain.json`).
import { createPublicClient, createWalletClient, http, defineChain, BaseError, ContractFunctionRevertedError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";

const RPC = `http://127.0.0.1:${process.env.ANVIL_PORT ?? "8546"}`;
const art = JSON.parse(readFileSync(new URL("./artifacts.json", import.meta.url), "utf8")).CsdHeaderOracle;
const hs = JSON.parse(readFileSync(new URL("./fixtures/mainnet-difficulty-chain.json", import.meta.url), "utf8"));
const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http() });
const wc = createWalletClient({ account: privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"), chain, transport: http() });
let pass = 0; const check = (c, l) => { if (!c) { console.error("  FAIL:", l); process.exit(1); } pass++; console.log("  ok -", l); };
const sol = (h) => ({ version: h.version, prev: h.prev, merkle: h.merkle, time: BigInt(h.time), bits: h.bits, nonce: h.nonce });
const G = "0x00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52";

console.log(`\n[mainnet] ${hs.length} headers mined at CSD's mainnet difficulty`);
const oracle = (await pub.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [G, hs.slice(0, 45).map(sol), BigInt(hs[0].height), 256n] }) })).contractAddress;
const rest = hs.slice(45);
// (Difficulty changes at mainnet values are covered by the 3000 LWMA vectors in consensus.test.mjs;
// this chain checks the oracle end to end at the real PoW limit.)
// one header with its bits off by one is rejected
const t = { ...rest[0], bits: rest[0].bits - 1 };
try { await pub.simulateContract({ account: wc.account, address: oracle, abi: art.abi, functionName: "submitHeaders", args: [G, [sol(t)]] }); check(false, "tampered bits accepted"); }
catch (e) { const r = e instanceof BaseError ? e.walk(x => x instanceof ContractFunctionRevertedError) : null; check(["UnexpectedBits", "HeaderInsufficientPoW"].includes(r?.data?.errorName), `bits off by one are rejected (${r?.data?.errorName})`); }
let gas = 0n;
for (let i = 0; i < rest.length; i += 15) {
  const batch = rest.slice(i, i + 15);
  await pub.simulateContract({ account: wc.account, address: oracle, abi: art.abi, functionName: "submitHeaders", args: [G, batch.map(sol)] });
  const rc = await pub.waitForTransactionReceipt({ hash: await wc.writeContract({ address: oracle, abi: art.abi, functionName: "submitHeaders", args: [G, batch.map(sol)], gas: 30_000_000n }) });
  gas += rc.gasUsed;
}
const read = (fn, args) => pub.readContract({ address: oracle, abi: art.abi, functionName: fn, args });
check(await read("bestTip", [G]) === hs.at(-1).hash, `all ${rest.length} headers accepted; best tip is the last one (avg gas per header in batches of 15: ${gas / BigInt(rest.length)})`);
check(await read("isConfirmed", [hs.at(-6).hash, G, 6n]) && !(await read("isConfirmed", [hs.at(-6).hash, G, 7n])), "confirmations are counted exactly");

// The settlement contract's block checks (mainnet PoW limit) on the same real-difficulty chain
{ const sart = JSON.parse(readFileSync(new URL("./artifacts.json", import.meta.url), "utf8")).CsdUsdcSettlement;
  const st = (await pub.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: sart.abi, bytecode: sart.bytecode, args: ["0x0000000000000000000000000000000000000001", 30_000_000n, G] }) })).contractAddress;
  const { suggestedMaxTarget } = await import("../scripts/csd-headers.mjs");
  const maxT = suggestedMaxTarget(hs.at(-1).bits);
  const last = await pub.readContract({ address: st, abi: sart.abi, functionName: "checkHeaderChain", args: [hs.map(sol), maxT] });
  check(last === hs.at(-1).hash, `settlement accepts all ${hs.length} mainnet-difficulty blocks at the suggested difficulty`);
  try { await pub.readContract({ address: st, abi: sart.abi, functionName: "checkHeaderChain", args: [hs.map(sol), maxT / 2n] }); check(false, "accepted at double the difficulty"); }
  catch (e) { const r = e instanceof BaseError ? e.walk(x => x instanceof ContractFunctionRevertedError) : null; check(r?.data?.errorName === "CsdBlockTooEasy", "and rejects them when the signed difficulty is higher than theirs"); } }

console.log(`\nAll ${pass} mainnet-difficulty checks passed.`);
