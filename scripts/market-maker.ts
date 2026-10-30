// Runs the CSD/USDC market maker (src/market-maker.ts). See docs/market-maker.md.
//
//   npx tsx scripts/market-maker.ts --new-seed   # prints a fresh MM_CSD_SEED
//   npx tsx scripts/market-maker.ts --addresses  # where to send the CSD, USDC and ETH
//   npx tsx scripts/market-maker.ts              # run
//
// Settings come from the environment (an .env file loaded by systemd is fine).

import { randomBytes } from "node:crypto";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveCsdWallet } from "../src/csd-wallet.js";
import { startMarketMaker } from "../src/market-maker.js";

const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined || v === "") { console.error(`missing ${k}`); process.exit(1); } return v; };
const usdcUnits = (x: string) => BigInt(Math.round(Number(x) * 1e6));
const csdUnits = (x: string) => BigInt(Math.round(Number(x) * 1e8));

if (process.argv.includes("--new-seed")) { console.log("MM_CSD_SEED=0x" + randomBytes(32).toString("hex")); process.exit(0); }
if (process.argv.includes("--addresses")) {
  const evm = privateKeyToAccount(env("MM_PRIVATE_KEY") as Hex).address;
  const csd = deriveCsdWallet(env("MM_CSD_SEED") as Hex).key(0).addr20;
  console.log(`Ethereum address (send USDC and some ETH for gas): ${evm}`);
  console.log(`CSD address (send the CSD here):                   ${csd.slice(2)}`);
  process.exit(0);
}

// Deepen the pool at the current price. Stop the bot first, send the USDC and
// CSD to its addresses, then:  npx tsx scripts/market-maker.ts --top-up 500
// (adds 500 USDC and the CSD that keeps the price; the command prints it)
if (process.argv.includes("--top-up")) {
  const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
  const file = env("STATE_FILE", "./mm-state.json");
  if (!existsSync(file)) { console.error(`no state file at ${file}; just set POOL_USDC/POOL_CSD before the first start`); process.exit(1); }
  const S = JSON.parse(readFileSync(file, "utf8"));
  const pu = BigInt(S.pool.usdc), pc = BigInt(S.pool.csd);
  const addUsdc = usdcUnits(process.argv[process.argv.indexOf("--top-up") + 1] ?? "0");
  if (addUsdc <= 0n) { console.error("usage: --top-up <USDC amount>"); process.exit(1); }
  const addCsd = (addUsdc * pc) / pu; // same ratio, same price
  if (!process.argv.includes("--yes")) {
    console.log(`Price ${(Number(pu) / 1e6) / (Number(pc) / 1e8)} USDC per CSD. Send ${Number(addUsdc) / 1e6} USDC and ${Number(addCsd) / 1e8} CSD to the bot, then rerun with --yes.`);
    process.exit(0);
  }
  S.pool = { usdc: String(pu + addUsdc), csd: String(pc + addCsd) };
  writeFileSync(file, JSON.stringify(S, null, 1));
  console.log(`Pool is now ${Number(pu + addUsdc) / 1e6} USDC + ${Number(pc + addCsd) / 1e8} CSD. Start the bot again.`);
  process.exit(0);
}

const mm = await startMarketMaker({
  rpcUrl:        env("AON_EVM_RPC_URL"),
  chainId:       Number(env("CHAIN_ID", "1")),
  privateKey:    env("MM_PRIVATE_KEY") as Hex,
  settlement:    getAddress(env("SETTLEMENT_CONTRACT")),
  usdc:          getAddress(env("USDC_ADDRESS", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")),
  csdApi:        env("CSD_API_URL", "http://127.0.0.1:8887"),
  csdGenesis:    env("CSD_GENESIS_HASH", "0x00000052c2821f71b19c3d79dfabfb12d4076ba15d83b47d008e582aad6c0d52") as Hex,
  csdSeed:       env("MM_CSD_SEED") as Hex,
  stateFile:     env("STATE_FILE", "./mm-state.json"),
  port:          Number(env("PORT", "8890")),
  host:          env("HOST", "127.0.0.1"),
  allowedOrigins: env("ALLOWED_ORIGINS", "https://covenant.market").split(",").map(s => s.trim()),
  trustProxy:    env("TRUST_PROXY", "true") === "true",   // behind Caddy
  broadcastApis: (process.env.CSD_BROADCAST_APIS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  maxLossUsdc:   usdcUnits(env("MAX_LOSS_USDC", "30")),
  initialPool:   { usdc: usdcUnits(env("POOL_USDC", "150")), csd: csdUnits(env("POOL_CSD", "1000")) },
  spreadBps:     BigInt(env("SPREAD_BPS", "300")),
  feeUsdc:       usdcUnits(env("FEE_USDC", "0.25")),
  maxUnconfirmedUsdc: usdcUnits(env("MAX_INSTANT_USDC", "60")),
  // Requests arrive over AON and every trade is published there
  aonNodeUrl:    env("AON_NODE_URL", "http://127.0.0.1:8787"),
});

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { await mm.stop(); process.exit(0); });
