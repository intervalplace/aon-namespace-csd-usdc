// Wallet test transactions. Deterministic (fixed keys, RFC 6979 signatures),
// so the fixture can pin their exact bytes.
//   npx tsx test/csd-tx-vectors/wallet-cases.ts | <csd>/target/release/walletcheck > test/fixtures/csd-wallet-vectors.json
// (walletcheck.rs goes in compute-substrate's src/bin/)
import { keyFromPrivate, deriveCsdWallet, buildPayment, txToNodeJson, sha256d, type Hex } from "../../src/csd-wallet.ts";

const k = (s: string) => keyFromPrivate(sha256d(new TextEncoder().encode(s)));
const a = k("wallet-a"), b = k("wallet-b");
const derived = deriveCsdWallet(("0x" + "11".repeat(65)) as Hex);
const d0 = derived.key(0), d1 = derived.key(1);
const tx = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;

export const cases = [
  { name: "one input, exact amount", ...buildPayment({ utxos: [{ txid: tx(1), vout: 0, value: 1_000_010_000n, key: a }], to: [{ value: 1_000_000_000n, addr20: b.addr20 }], change: a.addr20 }) },
  { name: "one input with change", ...buildPayment({ utxos: [{ txid: tx(2), vout: 3, value: 5_000_000_000n, key: a }], to: [{ value: 123_456_789n, addr20: b.addr20 }], change: a.addr20, fee: 2_000n }) },
  { name: "two inputs, two keys", ...buildPayment({ utxos: [{ txid: tx(3), vout: 1, value: 60_000n, key: a }, { txid: tx(4), vout: 0, value: 50_000n, key: b }], to: [{ value: 100_000n, addr20: d0.addr20 }], change: b.addr20 }) },
  { name: "derived wallet keys", ...buildPayment({ utxos: [{ txid: tx(5), vout: 2, value: 9_000_000n, key: d0 }, { txid: tx(6), vout: 7, value: 1_000_000n, key: d1 }], to: [{ value: 9_500_000n, addr20: a.addr20 }], change: d1.addr20 }) },
];

if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(cases.map(c => ({ tx: txToNodeJson(c.tx), addrs: c.tx.inputs.map(i => [a, b, d0, d1].find(x => i.scriptSig.length && Buffer.from(i.scriptSig.slice(66)).equals(Buffer.from(x.pub33)))!.addr20.slice(2)) }))));
