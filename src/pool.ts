// Pool pricing for the CSD/USDC market maker: the price is the ratio of what
// the pool holds (USDC ÷ CSD), like a constant-product AMM, plus a spread.
// Buying CSD moves the price up, selling moves it down, so nobody has to set
// a price by hand and the pool can't be emptied at a stale one.
//
// Units: USDC in 6 decimals, CSD in 1e8 base units. All rounding favors the pool.

export type Pool = { usdc: bigint; csd: bigint; spreadBps: bigint };
export const CSD_UNIT = 100_000_000n;
const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

// Price of 1 CSD in USDC units, before the spread
export const midPrice = (p: Pool) => (p.usdc * CSD_UNIT) / p.csd;

// USDC a user pays to receive `csd` (a buy). Never more than half the pool's CSD at once.
export function quoteBuy(p: Pool, csd: bigint): bigint {
  if (csd <= 0n) throw new Error("AMOUNT_TOO_SMALL");
  if (csd * 2n > p.csd) throw new Error("AMOUNT_TOO_LARGE");
  return ceilDiv(ceilDiv(p.usdc * csd, p.csd - csd) * (BPS + p.spreadBps), BPS);
}

// USDC a user receives for `csd` (a sell)
export function quoteSell(p: Pool, csd: bigint): bigint {
  if (csd <= 0n) throw new Error("AMOUNT_TOO_SMALL");
  return ((p.usdc * csd) / (p.csd + csd)) * (BPS - p.spreadBps) / BPS;
}

// Most CSD that `usdc` buys
export function csdForUsdc(p: Pool, usdc: bigint): bigint {
  const base = (usdc * BPS) / (BPS + p.spreadBps);
  let x = (p.csd * base) / (p.usdc + base);
  if (x * 2n > p.csd) x = p.csd / 2n;
  while (x > 0n && quoteBuy(p, x) > usdc) x -= 1n + x / 1_000_000n;
  return x > 0n ? x : 0n;
}

// Least CSD to sell to receive at least `usdc`
export function csdToSellFor(p: Pool, usdc: bigint): bigint {
  const base = ceilDiv(usdc * BPS, BPS - p.spreadBps);
  if (base >= p.usdc) throw new Error("AMOUNT_TOO_LARGE");
  let x = ceilDiv(p.csd * base, p.usdc - base);
  while (quoteSell(p, x) < usdc) x += 1n + x / 1_000_000n;
  return x;
}

export const afterBuy = (p: Pool, csd: bigint, usdcIn: bigint): Pool => ({ ...p, usdc: p.usdc + usdcIn, csd: p.csd - csd });
export const afterSell = (p: Pool, csd: bigint, usdcOut: bigint): Pool => ({ ...p, usdc: p.usdc - usdcOut, csd: p.csd + csd });

// An order-book view of the curve: `levels` steps of `stepUsdc` each side.
// Each level's price is the average price of that slice; sizes in CSD units.
export function ladder(p: Pool, stepUsdc: bigint, levels: number) {
  const asks: { price: bigint; csd: bigint }[] = [], bids: { price: bigint; csd: bigint }[] = [];
  let a = p;
  for (let i = 0; i < levels; i++) {
    const x = csdForUsdc(a, stepUsdc); if (x <= 0n) break;
    const cost = quoteBuy(a, x);
    asks.push({ price: (cost * CSD_UNIT) / x, csd: x }); a = afterBuy(a, x, cost);
  }
  let b = p;
  for (let i = 0; i < levels; i++) {
    let x: bigint; try { x = csdToSellFor(b, stepUsdc); } catch { break; }
    const out = quoteSell(b, x);
    bids.push({ price: (out * CSD_UNIT) / x, csd: x }); b = afterSell(b, x, out);
  }
  return { asks, bids };
}
