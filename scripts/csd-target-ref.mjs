// Prints CSD's current difficulty target, for the site build's
// NEXT_PUBLIC_CSD_TARGET_REF:   node scripts/csd-target-ref.mjs [http://127.0.0.1:8887]
const base = (process.argv[2] ?? "http://127.0.0.1:8887").replace(/\/$/, "");
const tip = await (await fetch(`${base}/tip`)).json();
const b = await (await fetch(`${base}/block/height/${tip.height}`)).json();
const bits = Number(b.header.bits), e = BigInt(bits >>> 24), m = BigInt(bits & 0xffffff);
const target = e <= 3n ? m >> (8n * (3n - e)) : m << (8n * (e - 3n));
console.log(`height ${tip.height}, bits 0x${bits.toString(16)}`);
console.log(`NEXT_PUBLIC_CSD_TARGET_REF=0x${target.toString(16)}`);
