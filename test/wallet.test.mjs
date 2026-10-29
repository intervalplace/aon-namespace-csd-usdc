// The browser/bot CSD wallet against CSD's own consensus code: the fixture was
// produced by compute-substrate's verify_sig, txid and bincode serializer
// (test/csd-tx-vectors/walletcheck.rs). Also checks key derivation and that
// the settlement contract computes the same txids.
import { readFileSync } from "fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cases } from "./csd-tx-vectors/wallet-cases.ts";
import { serializeTx, csdTxid, csdSighash, bytesToHex, deriveCsdWallet, keyFromPrivate, buildPayment, hash160, suggestedMaxTarget, bitsToTarget, addr20ToBytes32 } from "../src/csd-wallet.ts";

let pass = 0;
const check = (c, l) => { if (!c) { console.error("  FAIL:", l); process.exit(1); } pass++; console.log("  ok -", l); };
const vectors = JSON.parse(readFileSync(new URL("./fixtures/csd-wallet-vectors.json", import.meta.url), "utf8"));

console.log("\n[1] Transactions match CSD's serializer, txid and signature check");
check(vectors.length === cases.length && vectors.every(v => v.ok), `CSD's verify_sig accepted all ${vectors.length} wallet transactions`);
for (const [i, c] of cases.entries()) {
  check(bytesToHex(serializeTx(c.tx)).slice(2) === vectors[i].raw, `${c.name}: same bytes as CSD's bincode`);
  check(c.txid.slice(2) === vectors[i].txid && csdTxid(c.tx) === c.txid, `${c.name}: same txid`);
  const digest = csdSighash(c.tx);
  check(c.tx.inputs.every(inp => inp.scriptSig.length === 99 && inp.scriptSig[0] === 64 && inp.scriptSig[65] === 33
    && secp256k1.verify(inp.scriptSig.slice(1, 65), digest, inp.scriptSig.slice(66), { lowS: true })), `${c.name}: 99-byte script_sigs, low-S`);
}

console.log("\n[2] Coin selection and change");
{ const k = keyFromPrivate(new Uint8Array(32).fill(7));
  const utxos = [{ txid: "0x" + "01".repeat(32), vout: 0, value: 30n, key: k }, { txid: "0x" + "02".repeat(32), vout: 0, value: 100n, key: k }, { txid: "0x" + "03".repeat(32), vout: 0, value: 50n, key: k }];
  const p = buildPayment({ utxos, to: [{ value: 120n, addr20: "0x" + "aa".repeat(20) }], change: k.addr20, fee: 10n });
  check(p.tx.inputs.length === 2 && p.spent[0].txid === utxos[1].txid && p.spent[1].txid === utxos[2].txid, "largest coins first, only as many as needed");
  check(p.tx.outputs.length === 2 && p.tx.outputs[1].value === 20n && p.tx.outputs[1].addr20 === k.addr20, "change goes back to the wallet");
  const exact = buildPayment({ utxos: [utxos[1]], to: [{ value: 90n, addr20: "0x" + "aa".repeat(20) }], change: k.addr20, fee: 10n });
  check(exact.tx.outputs.length === 1, "no change output when the amount is exact");
  let threw = ""; try { buildPayment({ utxos, to: [{ value: 171n, addr20: k.addr20 }], change: k.addr20, fee: 10n }); } catch (e) { threw = e.message; }
  check(threw === "INSUFFICIENT_CSD", "refuses to spend more than the wallet has"); }

console.log("\n[3] Keys from an Ethereum wallet signature");
{ const sig = "0x" + "11".repeat(65), w1 = deriveCsdWallet(sig), w2 = deriveCsdWallet(sig), w3 = deriveCsdWallet("0x" + "12".repeat(65));
  check(w1.key(0).addr20 === w2.key(0).addr20 && w1.key(5).addr20 === w2.key(5).addr20, "the same signature gives the same keys on any device");
  check(w1.key(0).addr20 !== w1.key(1).addr20 && w1.key(0).addr20 !== w3.key(0).addr20, "different index or signature: different key");
  const k = w1.key(0);
  check(bytesToHex(hash160(k.pub33)) === k.addr20 && k.pub64.length === 64 && k.pub33[0] === (k.pub64[63] & 1 ? 3 : 2), "address is hash160 of the compressed key; pub64 is the same key");
  check(addr20ToBytes32(k.addr20).length === 66 && addr20ToBytes32(k.addr20).endsWith("00".repeat(12)), "contract form: address left-aligned in bytes32"); }

console.log("\n[4] Difficulty helpers");
check(bitsToTarget(0x1e00ffff) === 0xffffn << 216n, "PoW limit target");
check(suggestedMaxTarget(0x1d00ffff) === (0xffffn << 208n) * 4n / 3n && suggestedMaxTarget(0x1e00ffff) === bitsToTarget(0x1e00ffff), "signed difficulty: 3/4 of current, never past the PoW limit");

console.log("\n[5] The settlement contract computes the same txids");
{ const RPC = `http://127.0.0.1:${process.env.ANVIL_PORT ?? "8546"}`;
  const art = JSON.parse(readFileSync(new URL("./artifacts.json", import.meta.url), "utf8"));
  const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const pub = createPublicClient({ chain, transport: http() });
  const acct = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const hash = await createWalletClient({ account: acct, chain, transport: http() }).deployContract({ abi: art.TestCsdUsdcSettlement.abi, bytecode: art.TestCsdUsdcSettlement.bytecode, args: [acct.address, 1_000_000_000n, "0x" + "ab".repeat(32)] });
  const addr = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  for (const c of cases) {
    check(await pub.readContract({ address: addr, abi: art.TestCsdUsdcSettlement.abi, functionName: "txidOf", args: [bytesToHex(serializeTx(c.tx))] }) === c.txid, `${c.name}: contract txid matches`);
    await pub.readContract({ address: addr, abi: art.TestCsdUsdcSettlement.abi, functionName: "verifyTx", args: [bytesToHex(serializeTx(c.tx)), addr20ToBytes32(c.tx.outputs[0].addr20), c.tx.outputs[0].value] });
  }
  check(true, "the contract's strict parser accepts every wallet transaction and finds its payment"); }

console.log(`\nAll ${pass} wallet checks passed.`);
