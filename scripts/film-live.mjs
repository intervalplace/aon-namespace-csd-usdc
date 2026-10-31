// Films real trades on covenant.market at desktop size, in a headless Chrome, with a throwaway
// wallet: a buy (the CSD in the balance within seconds), a sell (the USDC arriving), and the
// trade's signed receipt on the AON explorer. Everything on screen is real and on mainnet.
//
//   npm i --no-save playwright@1.47.2 && npx playwright install --with-deps chromium   (once)
//   node scripts/film-live.mjs --new-key            # makes /root/film-key, prints its address
//   (send ~5 USDC to that address; no ETH needed)
//   node scripts/film-live.mjs                      # films; writes /root/film/covenant-live.mp4
//
// Env: FILM_KEY_FILE (/root/film-key), FILM_BUY (20 CSD), FILM_SELL ("max", or an amount of CSD), FILM_OUT (/root/film),
// FILM_SITE (https://covenant.market/csd), FILM_RPC (https://ethereum-rpc.publicnode.com),
// FILM_W/FILM_H (1600x900)

import { chromium } from "playwright";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";

const KEY_FILE = process.env.FILM_KEY_FILE ?? "/root/film-key";
const SITE = process.env.FILM_SITE ?? "https://covenant.market/csd";
const RPC = process.env.FILM_RPC ?? "https://ethereum-rpc.publicnode.com";
const OUT = process.env.FILM_OUT ?? "/root/film";
const BUY = process.env.FILM_BUY ?? "20", SELL = process.env.FILM_SELL ?? "max"; // "max": sells all of it
const CHAIN = Number(process.env.FILM_CHAIN ?? 1);
const W = Number(process.env.FILM_W ?? 1600), H = Number(process.env.FILM_H ?? 900);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (process.argv.includes("--new-key")) {
  if (existsSync(KEY_FILE)) { console.log(`${KEY_FILE} exists already: ${privateKeyToAccount(readFileSync(KEY_FILE, "utf8").trim()).address}`); process.exit(0); }
  const k = generatePrivateKey(); writeFileSync(KEY_FILE, k + "\n", { mode: 0o600 });
  console.log(`Film wallet: ${privateKeyToAccount(k).address}\nSend about 5 USDC there (Ethereum mainnet). No ETH needed.`); process.exit(0);
}
const account = privateKeyToAccount(readFileSync(KEY_FILE, "utf8").trim());
log(`film wallet ${account.address}`);

// The wallet, as a browser extension would provide it: signs with the throwaway key, sends
// everything else to a public RPC. It never sends a transaction (none is needed to trade).
async function wallet(method, params = []) {
  switch (method) {
    case "eth_requestAccounts": case "eth_accounts": return [account.address];
    case "eth_chainId": return "0x" + CHAIN.toString(16);
    case "net_version": return String(CHAIN);
    case "wallet_switchEthereumChain": case "wallet_addEthereumChain": return null;
    case "wallet_requestPermissions": case "wallet_getPermissions": return [{ parentCapability: "eth_accounts" }];
    case "personal_sign": return account.signMessage({ message: /^0x[0-9a-f]*$/i.test(params[0]) ? { raw: params[0] } : params[0] });
    case "eth_signTypedData_v4": {
      const td = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
      const { EIP712Domain, ...types } = td.types;
      return account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
    }
    case "eth_sendTransaction": throw Object.assign(new Error("The film wallet doesn't send transactions"), { code: 4001 });
  }
  const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data });
  return r.result;
}
const INJECT = `(() => {
  const listeners = {};
  const eth = { isMetaMask: true, _film: true,
    request: ({ method, params }) => window.__film(method, params ?? []).then(r => { if (r && r.__err) { const e = new Error(r.message); e.code = r.code; throw e; } return r; }),
    on: (e, f) => { (listeners[e] = listeners[e] || []).push(f); return eth; },
    removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter(x => x !== f); return eth; } };
  window.ethereum = eth;
  const info = { uuid: "7c1f2d3e-0000-4000-8000-000000000001", name: "Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "film.wallet" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider: eth }) }));
  window.addEventListener("eip6963:requestProvider", announce); announce();
  // A visible pointer, since recordings don't show one
  addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div");
    c.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(20,20,30,.55);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);z-index:2147483647;pointer-events:none;transition:transform .12s";
    document.body.appendChild(c);
    addEventListener("mousemove", e => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => c.style.transform = "scale(.7)", true);
    addEventListener("mouseup", () => c.style.transform = "", true);
  });
})();`;

const browser = await chromium.launch();
let state;
async function context(record) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: "light", locale: "en-GB", timezoneId: "Europe/Oslo",
    ...(state ? { storageState: state } : {}), ...(record ? { recordVideo: { dir: `${OUT}/raw-${record}`, size: { width: W, height: H } } } : {}) });
  await ctx.exposeFunction("__film", async (m, p) => { try { return await wallet(m, p); } catch (e) { return { __err: true, message: e.message, code: e.code ?? -32603 }; } });
  await ctx.addInitScript(INJECT);
  return ctx;
}
async function done(ctx, record) {
  state = await ctx.storageState(); await ctx.close();
  if (!record) return;
  const dir = `${OUT}/raw-${record}`, f = readdirSync(dir).find(x => x.endsWith(".webm"));
  renameSync(`${dir}/${f}`, `${OUT}/${record}.webm`); rmSync(dir, { recursive: true, force: true });
  log(`clip ${record} saved`);
}
// Films one clip; a failed take (say, the market maker is busy) is thrown away and filmed again
async function take(name, fn, tries = 4) {
  for (let i = 1; ; i++) {
    const ctx = await context(name), page = await ctx.newPage();
    try { await fn(page); await done(ctx, name); return; }
    catch (e) {
      await ctx.close().catch(() => {}); rmSync(`${OUT}/raw-${name}`, { recursive: true, force: true });
      if (i >= tries) throw e;
      log(`take ${i} of ${name} failed (${String(e.message).split("\n")[0].slice(0, 160)}); again in 90 s`); await sleep(90_000);
    }
  }
}
// Moves the pointer there smoothly, then clicks
async function glide(page, loc, click = true) {
  await loc.scrollIntoViewIfNeeded(); const b = await loc.boundingBox(); if (!b) throw new Error("not visible");
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 30 }); await sleep(450);
  if (click) await loc.click();
}
async function scrollTo(page, loc) {
  const y = await loc.evaluate(el => el.getBoundingClientRect().top + window.scrollY - 72);
  await page.evaluate(async y => { const from = window.scrollY, n = 40; for (let i = 1; i <= n; i++) { window.scrollTo(0, from + (y - from) * (1 - Math.cos(Math.PI * i / n)) / 2); await new Promise(r => setTimeout(r, 22)); } }, y);
  await sleep(600);
}
async function open(page) {
  await page.goto(SITE, { waitUntil: "networkidle" }).catch(() => {});
  await page.mouse.move(W / 2, H / 3);
  await page.getByText(/Price/).first().waitFor({ timeout: 30_000 });
  await sleep(2500);
  const connect = page.getByRole("button", { name: "Connect wallet to trade" });
  if (await connect.isVisible().catch(() => false)) { await glide(page, connect); await sleep(1500); }
  const openWallet = page.getByRole("button", { name: "Open CSD wallet" });
  if (await openWallet.isVisible().catch(() => false)) {
    const remember = page.getByLabel("Remember on this device");
    if (!(await remember.isChecked().catch(() => true))) await remember.check();
    await glide(page, openWallet); await sleep(2500);
  }
}
async function trade(page, side, amount, done) {
  await scrollTo(page, page.locator(".market-bar"));
  await glide(page, page.getByRole("radio", { name: side === "buy" ? "Buy CSD" : "Sell CSD" })); await sleep(700);
  const input = page.locator("#csd-amount");
  if (amount === "max") await glide(page, page.getByRole("button", { name: "Max" }));
  else { await glide(page, input); await input.fill(""); await input.pressSequentially(amount, { delay: 160 }); }
  await sleep(2800); // the price, average and price-after update
  const btn = page.getByRole("button", { name: side === "buy" ? "Buy CSD" : "Sell CSD", exact: true }).last();
  await btn.waitFor({ state: "visible" });
  for (let i = 0; i < 40 && await btn.isDisabled(); i++) await sleep(500);
  if (await btn.isDisabled()) {
    await page.screenshot({ path: `${OUT}/stuck.png` });
    throw new Error(`the ${side} button stays disabled: ${(await page.locator("section").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600)} (see ${OUT}/stuck.png)`);
  }
  await glide(page, btn);
  const banner = page.locator(".banner[role=status]");
  await banner.filter({ hasText: done }).waitFor({ timeout: 180_000 }).catch(async () => { throw new Error(`no "${done}": ${await banner.textContent().catch(() => "no banner")}`); });
  log(`${side}: ${(await banner.textContent())?.replace("Dismiss", "").trim()}`);
}

mkdirSync(OUT, { recursive: true });
try {
  // 1. Buy: the CSD shows in the wallet within seconds
  await take("1-buy", async page => {
    await open(page);
    await trade(page, "buy", BUY, /Bought/);
    await sleep(1500);
    await scrollTo(page, page.getByRole("region", { name: "Your wallet" }));
    await page.getByText(/unconfirmed/).waitFor({ timeout: 90_000 }).catch(() => log("(the CSD didn't show as unconfirmed within 90 s)"));
    { const b = await page.getByText(/unconfirmed/).first().boundingBox().catch(() => null); // the pointer beside it, not over it
      if (b) await page.mouse.move(b.x - 26, b.y + b.height / 2, { steps: 30 }); }
    await sleep(4500);
  });

  // (not filmed) the CSD needs a block before it can be sold
  log("waiting for the CSD to be in a block…");
  { const ctx = await context(), page = await ctx.newPage();
    for (let i = 0; i < 90; i++) {
      await page.goto(SITE, { waitUntil: "networkidle" }).catch(() => {}); await sleep(6000);
      const c = page.getByRole("button", { name: "Connect wallet to trade" }); if (await c.isVisible().catch(() => false)) { await c.click(); await sleep(4000); }
      if (!(await page.getByText(/unconfirmed/).isVisible().catch(() => false)) && !(await page.getByText(/CSD arriving/).isVisible().catch(() => false))) break;
      await sleep(14_000);
    }
    await done(ctx); }

  // 2. Sell: the USDC arrives
  await take("2-sell", async page => {
    await open(page);
    await trade(page, "sell", SELL, /Sold|is paid/);
    await sleep(1500);
    await scrollTo(page, page.getByRole("region", { name: "Your wallet" }));
    { const b = await page.getByRole("region", { name: "Your wallet" }).getByText(/USDC arriving|^USDC$/).first().boundingBox().catch(() => null);
      if (b) await page.mouse.move(b.x - 26, b.y + b.height / 2, { steps: 30 }); }
    await sleep(5000);
  });

  // (not filmed) the sale's signed receipt
  log("waiting for the sale's receipt…");
  let receiptUrl = null;
  { const ctx = await context(), page = await ctx.newPage();
    for (let i = 0; i < 60 && !receiptUrl; i++) {
      await page.goto(SITE, { waitUntil: "networkidle" }).catch(() => {}); await sleep(5000);
      const c = page.getByRole("button", { name: "Connect wallet to trade" }); if (await c.isVisible().catch(() => false)) { await c.click(); await sleep(4000); }
      const a = page.getByRole("region", { name: "Your trades" }).getByRole("link", { name: /Receipt/ }).first();
      if (await a.isVisible().catch(() => false)) receiptUrl = await a.getAttribute("href"); else await sleep(10_000);
    }
    await done(ctx); }

  // 3. The trades and the receipt on AON
  if (receiptUrl) await take("3-receipt", async page => {
    await open(page);
    await scrollTo(page, page.getByRole("region", { name: "Your trades" })); await sleep(2500);
    await glide(page, page.getByRole("region", { name: "Your trades" }).getByRole("link", { name: /Receipt/ }).first(), false); await sleep(1200);
    await page.goto(receiptUrl, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForFunction(() => document.body.innerText.length > 200, null, { timeout: 30_000 }).catch(() => log("(the explorer page looks empty)"));
    await page.mouse.move(W - 120, H / 2, { steps: 20 }); await sleep(4000);
    await page.evaluate(async () => { for (let i = 0; i < 60; i++) { window.scrollBy(0, 8); await new Promise(r => setTimeout(r, 30)); } });
    await sleep(4000);
  }, 2); else log("no receipt within the wait; filmed the buy and the sell only");
} finally { await browser.close(); }

// One mp4 for posting (H.264, plays everywhere)
const clips = ["1-buy", "2-sell", "3-receipt"].filter(c => existsSync(`${OUT}/${c}.webm`));
try {
  writeFileSync(`${OUT}/list.txt`, clips.map(c => `file '${OUT}/${c}.webm'`).join("\n"));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${OUT}/list.txt`, "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", `${OUT}/covenant-live.mp4`]);
  log(`film: ${OUT}/covenant-live.mp4 (and each clip as .webm)`);
} catch (e) { log(`clips in ${OUT} (${clips.join(", ")}); ffmpeg not available to join them: apt install -y ffmpeg`); }
