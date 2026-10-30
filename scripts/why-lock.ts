// Why did a buy's USDC lock fail? Takes the newest buy authorization published on AON (or the
// one whose object hash is given) and checks each thing the contract checks, one by one, then
// replays the lock at the block when it was tried, on an RPC that reports revert reasons.
//
//   npx tsx scripts/why-lock.ts [authorizationObjectHash]
//
// Env: SETTLEMENT_CONTRACT, optional WHY_RPC (default: a public mainnet node), AON (explorer).

import { createPublicClient, http, getAddress, recoverAddress, recoverTypedDataAddress, keccak256, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { settlementAbi, authTuple } from "../src/executors/evmCsdUsdcSettlement.js";
import { csdOwnershipDigest, bytesToHex, hexToBytes, hash160 } from "../src/csd-wallet.js";

const AON = (process.env.AON ?? "https://explorer.aon.network").replace(/\/$/, "");
const SETTLEMENT = getAddress(process.env.SETTLEMENT_CONTRACT ?? "0x8863f0c477a30bb5a2077c813f42250d7fbefcb9");
const RPCS = (process.env.WHY_RPC ?? "https://ethereum-rpc.publicnode.com,https://eth.llamarpc.com,https://cloudflare-eth.com").split(",");
const USDC_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const lockFn: any = (settlementAbi as any).find((f: any) => f.name === "lockCsdUsdcAuthorization");
const HASH_ABI = [{ type: "function", name: "hashCsdUsdcAuthorization", stateMutability: "view", inputs: [lockFn.inputs[0]], outputs: [{ type: "bytes32" }] }] as const;
const ok = (b: boolean, what: string, extra = "") => console.log(`${b ? "OK  " : "FAIL"}  ${what}${extra ? "  " + extra : ""}`);

const want = process.argv[2]?.toLowerCase();
const list = (await (await fetch(`${AON}/v1/objects?namespace=aon:csd-usdc&objectType=authorization&limit=50`)).json()).objects as any[];
const o = list.find(x => want ? x.objectHash.toLowerCase() === want : x.signature?.scheme === "eip712" && x.payload?.usdcPermit);
if (!o) { console.log("No buy authorization found on AON."); process.exit(1); }
console.log(`authorization object ${o.objectHash}, published ${new Date(o.createdAt).toISOString()}\n`);

let c: any = null;
for (const url of RPCS) { try { const x = createPublicClient({ chain: mainnet, transport: http(url) }); await x.getBlockNumber(); c = x; console.log(`RPC ${url}\n`); break; } catch {} }
if (!c) { console.log("No RPC reachable"); process.exit(1); }

const a = authTuple(o.payload.authorization), sig = o.signature.signature as Hex;
const proof = o.payload.csdAddressProof, P = o.payload.usdcPermit;
const domain = o.signature.domain;

// 1. The authorization's hash and signature
const onchainHash = await c.readContract({ address: SETTLEMENT, abi: HASH_ABI, functionName: "hashCsdUsdcAuthorization", args: [a] }) as Hex;
const signer = await recoverAddress({ hash: onchainHash, signature: sig }).catch(() => null);
ok(signer?.toLowerCase() === a.buyer.toLowerCase(), "buyer's signature (checked against the contract's own hash)", `signer ${signer}, buyer ${a.buyer}`);
const pageSigner = await recoverTypedDataAddress({ domain, types: o.signature.types, primaryType: "CsdUsdcAuthorization", message: o.signature.message, signature: sig }).catch(() => null);
ok(pageSigner?.toLowerCase() === a.buyer.toLowerCase(), "signature under the domain the page used", JSON.stringify(domain));

// 2. Time window and limits
const blk = await c.getBlock();
ok(Number(blk.timestamp) >= Number(a.validAfter), "validAfter", `${a.validAfter} vs chain now ${blk.timestamp} (phone clock ahead?)`);
ok(Number(blk.timestamp) <= Number(a.validBefore), "validBefore", String(a.validBefore));
ok(a.minConfirmations >= 3n && a.minConfirmations <= 60n, "confirmations 3–60", String(a.minConfirmations));
ok(a.usdcAmount + a.executorFeeAmount <= 30_000_000n && a.usdcAmount >= 1_000_000n, "trade size 1–30 USDC", `${a.usdcAmount} + fee ${a.executorFeeAmount}`);

// 3. The CSD address proof
try {
  const pub = hexToBytes(proof.pubKey); const y = pub[63];
  const compressed = new Uint8Array([y & 1 ? 3 : 2, ...pub.slice(0, 32)]);
  const addr = bytesToHex(hash160(compressed));
  ok(addr.toLowerCase() === a.sellerCsdScriptHash.slice(0, 42).toLowerCase(), "CSD address proof: key matches the receiving address", addr);
  const keyAddr = getAddress("0x" + keccak256(proof.pubKey).slice(26));
  const by = await recoverAddress({ hash: bytesToHex(csdOwnershipDigest(onchainHash)), signature: proof.sig });
  ok(by === keyAddr, "CSD address proof: signed by that key", `${by} vs ${keyAddr}`);
} catch (e: any) { ok(false, "CSD address proof", e.message); }

// 4. USDC: balance, allowance, and the permit
const usdc = a.usdc;
const [name, version, nonce, bal, allowance] = await Promise.all([
  c.readContract({ address: usdc, abi: USDC_ABI, functionName: "name" }), c.readContract({ address: usdc, abi: USDC_ABI, functionName: "version" }),
  c.readContract({ address: usdc, abi: USDC_ABI, functionName: "nonces", args: [a.buyer] }), c.readContract({ address: usdc, abi: USDC_ABI, functionName: "balanceOf", args: [a.buyer] }),
  c.readContract({ address: usdc, abi: USDC_ABI, functionName: "allowance", args: [a.buyer, SETTLEMENT] }),
]);
ok(bal >= a.usdcAmount + a.executorFeeAmount, "buyer's USDC balance", String(bal));
if (P) {
  const permitSigner = await recoverTypedDataAddress({
    domain: { name, version, chainId: 1, verifyingContract: usdc },
    types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Permit", message: { owner: a.buyer, spender: SETTLEMENT, value: a.usdcAmount + a.executorFeeAmount, nonce, deadline: BigInt(P.deadline) },
    signature: (P.r + P.s.slice(2) + Number(P.v).toString(16).padStart(2, "0")) as Hex,
  }).catch(() => null);
  ok(permitSigner?.toLowerCase() === a.buyer.toLowerCase(), `USDC permit signature (token "${name}" v${version}, nonce ${nonce})`, `signer ${permitSigner}`);
  ok(BigInt(P.deadline) >= BigInt(Math.floor(o.createdAt / 1000)), "permit deadline after it was published", `${P.deadline}`);
} else ok(allowance >= a.usdcAmount + a.executorFeeAmount, "no permit: allowance", String(allowance));

// 5. Replay the lock at the block when it was tried (needs the RPC to keep that state)
const ago = Math.max(0, Math.floor((Date.now() - o.createdAt) / 1000));
const at = blk.number - BigInt(Math.ceil(ago / 12)) + 1n;
try {
  await c.simulateContract({ account: "0x71cDFF394fD19cfA97946E6BAA08232cF357abD0", address: SETTLEMENT, abi: settlementAbi, blockNumber: at,
    functionName: P ? "lockCsdUsdcAuthorizationWithPermit" : "lockCsdUsdcAuthorization",
    args: P ? [a, sig, proof, { deadline: BigInt(P.deadline), v: Number(P.v), r: P.r, s: P.s }] : [a, sig, proof] });
  ok(true, `the lock replayed at block ${at} would succeed`);
} catch (e: any) {
  ok(false, `the lock replayed at block ${at}`, (e.cause?.data?.errorName ? `${e.cause.data.errorName}(${(e.cause.data.args ?? []).join(", ")})` : "") + " " + (e.shortMessage ?? e.message).split("\n")[0]);
}
