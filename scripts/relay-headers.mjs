// Keeps the header oracle close to the real CSD tip by submitting new CSD
// headers as they appear. Anyone can run it; running more than one is fine.
// A current oracle means a fake chain would have to out-mine the real CSD
// network from the current tip, not from an old one.
//
//   CSD_API_URL=http://127.0.0.1:8887 AON_EVM_RPC_URL=https://... \
//   RELAYER_PRIVATE_KEY=0x... ORACLE_ADDRESS=0x... node scripts/relay-headers.mjs
//
// Optional: POLL_SECONDS (default 60), MAX_BATCH (default 25), RUN_ONCE=1
// (catch up once and exit).
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { csdApi, CSD_GENESIS_HASH } from "./csd-headers.mjs";

const env = (k, d) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`${k} missing`); return v; };
const csd = csdApi(env("CSD_API_URL", "http://127.0.0.1:8887"));
const oracle = env("ORACLE_ADDRESS");
const genesis = env("CSD_GENESIS_HASH", CSD_GENESIS_HASH);
const POLL = Number(env("POLL_SECONDS", "60")) * 1000;
const MAX_BATCH = Number(env("MAX_BATCH", "25"));
const account = privateKeyToAccount(env("RELAYER_PRIVATE_KEY"));
const pub = createPublicClient({ transport: http(env("AON_EVM_RPC_URL")) });
const chainId = await pub.getChainId();
const wallet = createWalletClient({ account, chain: { id: chainId, name: `evm-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [env("AON_EVM_RPC_URL")] } } }, transport: http(env("AON_EVM_RPC_URL")) });

const HEADER = { type: "tuple", components: [
  { name: "version", type: "uint32" }, { name: "prev", type: "bytes32" }, { name: "merkle", type: "bytes32" },
  { name: "time", type: "uint64" }, { name: "bits", type: "uint32" }, { name: "nonce", type: "uint32" }] };
const abi = [
  { type: "function", name: "submitHeaders", stateMutability: "nonpayable", inputs: [{ name: "genesisHash", type: "bytes32" }, { ...HEADER, name: "newHeaders", type: "tuple[]" }], outputs: [] },
  { type: "function", name: "bestHeight", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "headers", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [
    { name: "parent", type: "bytes32" }, { name: "height", type: "uint64" }, { name: "time", type: "uint64" }, { name: "bits", type: "uint32" }, { name: "exists", type: "bool" }, { name: "chainWork", type: "uint256" }] },
];
const known = async (hash) => (await pub.readContract({ address: oracle, abi, functionName: "headers", args: [hash] }))[4];

async function step() {
  const best = Number(await pub.readContract({ address: oracle, abi, functionName: "bestHeight", args: [genesis] }));
  const tip = await csd.tipHeight();
  if (tip <= best) return;
  // Start from the first CSD header the oracle doesn't know (walks back over a reorg)
  let from = best + 1;
  while (from > 0 && !(await known((await csd.headerAt(from - 1)).hash))) from--;
  const to = Math.min(tip, from + MAX_BATCH - 1);
  const batch = (await csd.headersRange(from, to)).map(h => h.header);
  const hash = await wallet.writeContract({ address: oracle, abi, functionName: "submitHeaders", args: [genesis, batch] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(`${new Date().toISOString()} submitted CSD ${from}..${to} (tip ${tip}) gas ${rc.gasUsed} ${rc.status}`);
}

console.log(`relaying CSD headers to ${oracle} on chain ${chainId} as ${account.address}`);
if (process.env.RUN_ONCE) {
  for (let i = 0; i < 1000; i++) { const before = Number(await pub.readContract({ address: oracle, abi, functionName: "bestHeight", args: [genesis] })); await step(); if (Number(await pub.readContract({ address: oracle, abi, functionName: "bestHeight", args: [genesis] })) === before) break; }
  process.exit(0);
}
for (;;) {
  try { await step(); } catch (e) { console.error(`${new Date().toISOString()} ${e.shortMessage ?? e.message}`); }
  await new Promise(r => setTimeout(r, POLL));
}
