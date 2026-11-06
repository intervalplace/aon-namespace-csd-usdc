// Screenshots of one live offer seen through two windows: covenant.market's market view, and the
// same offer on the AON explorer, where the market maker published it. Desktop size, as the films.
//
//   npx tsx scripts/shoot-offer.mjs          # writes /root/film/offer-covenant.png, offer-aon.png, offer-two-windows.png
//
// Env: SHOT_OUT (/root/film), SHOT_SITE (https://covenant.market/), SHOT_AON (https://explorer.aon.network),
// SHOT_SIDE (sell: a maker's offer to sell CSD; buy: to buy it), SHOT_W/SHOT_H (1600x900)

import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const OUT = process.env.SHOT_OUT ?? "/root/film";
const SITE = (process.env.SHOT_SITE ?? "https://covenant.market/").replace(/\/?$/, "/");
const AON = (process.env.SHOT_AON ?? "https://explorer.aon.network").replace(/\/$/, "");
const SIDE = process.env.SHOT_SIDE ?? "sell";
const W = Number(process.env.SHOT_W ?? 1600), H = Number(process.env.SHOT_H ?? 900);
const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// The newest live offer on AON, straight from the network
const r = await fetch(`${AON}/v1/objects?namespace=${encodeURIComponent("aon:csd-usdc")}&objectType=offer&limit=50`);
const objects = (await r.json()).objects ?? [];
const now = Math.floor(Date.now() / 1000);
const want = SIDE === "buy" ? "csd_usdc_buy_csd" : "csd_usdc_sell_csd";
const offer = objects.filter(o => o.payload?.offerType === want && Number(o.payload?.validBefore) > now)
  .sort((a, b) => b.createdAt - a.createdAt)[0];
if (!offer) { console.log(`no live ${SIDE} offer on ${AON}`); process.exit(1); }
console.log(`offer ${offer.objectHash}: maker ${offer.payload.marketMaker}, mid ${offer.payload.midUsdcPerCsd} USDC per CSD`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: "light", locale: "en-GB", timezoneId: "Europe/Oslo" });
try {
  // 1. covenant.market, the market view
  const page = await ctx.newPage();
  await page.goto(`${SITE}#market`, { waitUntil: "networkidle" }).catch(() => {});
  await page.locator(".book-row").first().waitFor({ timeout: 60_000 });
  await sleep(2500);
  await page.screenshot({ path: `${OUT}/offer-covenant.png` });

  // 2. the same offer on the AON explorer, its signed contents open
  await page.goto(`${AON}/?hash=${offer.objectHash}`, { waitUntil: "networkidle" }).catch(() => {});
  const root = page.locator(".result .gnode.root .ghead");
  await root.waitFor({ timeout: 60_000 });
  await root.click(); await sleep(800);
  await page.evaluate(() => { const el = document.querySelector(".result"); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 24); });
  await sleep(1200);
  await page.screenshot({ path: `${OUT}/offer-aon.png` });

  // 3. side by side
  const img = f => "data:image/png;base64," + readFileSync(`${OUT}/${f}`).toString("base64");
  const both = await ctx.newPage();
  await both.setViewportSize({ width: 2 * W + 120, height: H + 120 });
  await both.setContent(`<body style="margin:0;background:#0B0E16;display:flex;gap:40px;padding:40px;box-sizing:border-box">
    <img src="${img("offer-covenant.png")}" style="width:${W}px;height:${H}px;border-radius:12px">
    <img src="${img("offer-aon.png")}" style="width:${W}px;height:${H}px;border-radius:12px"></body>`);
  await sleep(500);
  await both.screenshot({ path: `${OUT}/offer-two-windows.png` });
  console.log(`${OUT}/offer-covenant.png, offer-aon.png, offer-two-windows.png`);
} finally { await browser.close(); }
