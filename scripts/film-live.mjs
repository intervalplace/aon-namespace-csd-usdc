// Films real trades on covenant.market at desktop size, in a headless Chrome, with a throwaway
// wallet: a buy (the CSD in the balance within seconds), a sell (the USDC arriving), and the
// trade's signed receipt on the AON explorer. Everything on screen is real and on mainnet.
//
//   npm i --no-save playwright@1.47.2 && npx playwright install --with-deps chromium   (once)
//   npx tsx scripts/film-live.mjs --new-key           # makes /root/film-key, prints its address
//   (send ~5 USDC to that address; no ETH needed)
//   npx tsx scripts/film-live.mjs                   # films; writes /root/film/covenant-live.mp4
//
// With CSD already in the film wallet, the buy and the sell are one continuous take (the sell
// doesn't wait for the bought CSD's block). Its CSD address, to send some CSD to:
//   npx tsx scripts/film-live.mjs --csd-address
//
// Env: FILM_KEY_FILE (/root/film-key), FILM_BUY (20 CSD), FILM_SELL ("max", or an amount of CSD), FILM_OUT (/root/film),
// FILM_SITE (https://covenant.market/csd), FILM_RPC (https://ethereum-rpc.publicnode.com),
// FILM_SELL_FIRST (1: sell first and buy with the USDC it brings; for a film wallet low on USDC), FILM_W/FILM_H (1600x900), FILM_FAST (8: waits play 8x faster, marked on screen; 1: real time)

import { chromium } from "playwright";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";

const KEY_FILE = process.env.FILM_KEY_FILE ?? "/root/film-key";
const SITE = process.env.FILM_SITE ?? "https://covenant.market/csd";
const RPC = process.env.FILM_RPC ?? "https://ethereum-rpc.publicnode.com";
const OUT = process.env.FILM_OUT ?? "/root/film";
const SELL_FIRST = process.env.FILM_SELL_FIRST === "1"; // sell first, then buy with what it brought
const BUY = process.env.FILM_BUY ?? "20", SELL = process.env.FILM_SELL ?? "max"; // "max": sells all of it
const CHAIN = Number(process.env.FILM_CHAIN ?? 1);
const FAST = Number(process.env.FILM_FAST ?? 8); // waits (Ethereum blocks) play this many times faster, with a badge saying so
const W = Number(process.env.FILM_W ?? 1600), H = Number(process.env.FILM_H ?? 900);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (process.argv.includes("--new-key")) {
  if (existsSync(KEY_FILE)) { console.log(`${KEY_FILE} exists already: ${privateKeyToAccount(readFileSync(KEY_FILE, "utf8").trim()).address}`); process.exit(0); }
  const k = generatePrivateKey(); writeFileSync(KEY_FILE, k + "\n", { mode: 0o600 });
  console.log(`Film wallet: ${privateKeyToAccount(k).address}\nSend about 5 USDC there (Ethereum mainnet). No ETH needed.`); process.exit(0);
}
const account = privateKeyToAccount(readFileSync(KEY_FILE, "utf8").trim());
const CSD_API = (process.env.FILM_CSD_API ?? "https://mm.covenant.market/api/csd").replace(/\/$/, "");
// The site's CSD wallet for this key (derived from a signature, as the page does)
async function csdAddress() {
  const { deriveCsdWallet, CSD_WALLET_MESSAGE } = await import("../src/csd-wallet.ts");
  return deriveCsdWallet(await account.signMessage({ message: CSD_WALLET_MESSAGE })).key(0).addr20.slice(2);
}
if (process.argv.includes("--csd-address")) {
  console.log(`Film wallet's CSD address: ${await csdAddress()}\nSend it some CSD (e.g. 20) from your own wallet ("Send CSD" on covenant.market), then film once it's in a block.`);
  process.exit(0);
}
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
// The browser's memory (the wallet's address count, its trades) is kept between runs
const STATE_FILE = `${OUT}/browser-state.json`;
let state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : undefined;
async function context(record) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: "light", locale: "en-GB", timezoneId: "Europe/Oslo",
    ...(state ? { storageState: state } : {}), ...(record ? { recordVideo: { dir: `${OUT}/raw-${record}`, size: { width: W, height: H } } } : {}) });
  await ctx.exposeFunction("__film", async (m, p) => { try { return await wallet(m, p); } catch (e) { return { __err: true, message: e.message, code: e.code ?? -32603 }; } });
  await ctx.addInitScript(INJECT);
  // (a browser new to this wallet looks further ahead for its CSD, in case of gaps between addresses)
  await ctx.addInitScript(k => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, "40"); } catch {} }, `covenant.csd.v1.${account.address.toLowerCase()}.next`);
  return ctx;
}
async function done(ctx, record) {
  state = await ctx.storageState(); await ctx.close();
  try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
  if (!record) return;
  const dir = `${OUT}/raw-${record}`, f = readdirSync(dir).find(x => x.endsWith(".webm"));
  renameSync(`${dir}/${f}`, `${OUT}/${record}.webm`); rmSync(dir, { recursive: true, force: true });
  log(`clip ${record} saved`);
}
// Where each clip starts (after the page has loaded) and which stretches are waits to fast-forward
const cuts = {}; let cur = null;
const at = () => (Date.now() - cur.t0) / 1000;
async function fastOn(page, what) {
  if (FAST <= 1) return;
  await page.evaluate(([what, k]) => {
    const b = document.createElement("div"); b.id = "__fast";
    b.textContent = `⏩ ${k}× speed · ${what}`;
    b.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);padding:10px 18px;border-radius:999px;background:rgba(17,24,39,.86);color:#fff;font:600 17px/1.2 system-ui,sans-serif;z-index:2147483646;pointer-events:none";
    document.body.appendChild(b);
  }, [what, FAST]).catch(() => {});
  await sleep(500); cur.fast.push([at(), null]);
}
async function fastOff(page) {
  if (FAST <= 1 || !cur.fast.length || cur.fast.at(-1)[1] !== null) return;
  cur.fast.at(-1)[1] = at();
  await page.evaluate(() => document.getElementById("__fast")?.remove()).catch(() => {});
}
// Films one clip; a failed take (say, the market maker is busy) is thrown away and filmed again
async function take(name, fn, tries = 4) {
  for (let i = 1; ; i++) {
    const ctx = await context(name), page = await ctx.newPage();
    cur = { t0: Date.now(), start: 0, fast: [] };
    try { await fn(page); cur.end = at(); cuts[name] = cur; await done(ctx, name); return; }
    catch (e) {
      await ctx.close().catch(() => {}); rmSync(`${OUT}/raw-${name}`, { recursive: true, force: true });
      if (i >= tries) throw e;
      log(`take ${i} of ${name} failed (${String(e.message).split("\n")[0].slice(0, 160)}); again in 90 s`); await sleep(90_000);
    }
  }
}
// Moves the pointer there smoothly, then clicks
async function glide(page, loc, click = true) {
  // (the page re-renders as prices and balances update: look again rather than give up)
  let b = null;
  for (let i = 0; i < 8 && !b; i++) {
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    b = await loc.boundingBox({ timeout: 5000 }).catch(() => null);
    if (!b) await sleep(1000);
  }
  if (!b) throw new Error(`not on the page: ${loc}`);
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
  await sleep(1200); if (cur) cur.start = at(); // (the clip starts here: no blank page loading)
  await sleep(1800);
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
  for (let i = 0; i < 120 && await btn.isDisabled(); i++) await sleep(500); // (up to a minute: e.g. a sale's USDC still arriving)
  if (await btn.isDisabled()) {
    await page.screenshot({ path: `${OUT}/stuck.png` });
    throw new Error(`the ${side} button stays disabled: ${(await page.locator("section").filter({ has: page.locator("#csd-amount") }).first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600)} (see ${OUT}/stuck.png)`);
  }
  const bb = await btn.boundingBox({ timeout: 5000 }).catch(() => null); // (taken before the click: the button's label changes then)
  await glide(page, btn);
  if (bb) await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height + 40, { steps: 15 }); // (off the button's text)
  await sleep(1500); // (the first steps play at normal speed)
  await fastOn(page, "waiting for Ethereum");
  const banner = page.locator(".banner[role=status]");
  await banner.filter({ hasText: done }).waitFor({ timeout: 240_000 }).catch(async () => {
    await page.screenshot({ path: `${OUT}/stuck.png` }).catch(() => {});
    const step = await page.locator("section").filter({ has: page.locator("#csd-amount") }).locator("button.btn-lg").last().innerText({ timeout: 2000 }).catch(() => "?");
    throw new Error(`no "${done}": ${await banner.textContent({ timeout: 2000 }).catch(() => "no banner")}; the button says "${step}" (see ${OUT}/stuck.png)`);
  });
  await fastOff(page);
  log(`${side}: ${(await banner.textContent())?.replace("Dismiss", "").trim()}`);
}

mkdirSync(OUT, { recursive: true });
// CSD ready to sell already? (asked of the page, which counts all the wallet's addresses) Then the
// buy and the sell are one continuous take
let ONE_TAKE = false;
{ const ctx = await context(), page = await ctx.newPage();
  try {
    await open(page);
    await page.getByRole("radio", { name: "Sell CSD" }).click();
    // (the wallet's balance shows "…" until it has looked through its addresses)
    await page.waitForFunction(() => { const r = document.querySelector('section[aria-label="Your wallet"] .stat'); return r && r.textContent && r.textContent.trim() !== "…"; }, null, { timeout: 120_000 }).catch(() => log("(the wallet took long to load)"));
    await sleep(3000);
    const panel = await page.locator("section").filter({ has: page.locator("#csd-amount") }).first().innerText();
    const have = Number((panel.match(/Available\s+([\d.,]+)\s*CSD/) ?? [])[1]?.replace(",", "") ?? 0);
    ONE_TAKE = have >= 1;
    log(ONE_TAKE ? `the film wallet has ${have} CSD ready to sell: buy and sell in one take` : "no CSD ready to sell in the film wallet: the sell waits for the bought CSD's block (cut)");
  } catch (e) { log(`(couldn't check the film wallet's CSD: ${String(e.message).split("\n")[0]})`); }
  await done(ctx); }
// (clips from an earlier run would otherwise be joined into this film)
for (const f of readdirSync(OUT)) if (/^(\d-[a-z]+\.webm|covenant-live\.mp4|list\.txt|stuck\.png)$/.test(f) || f.startsWith("raw-")) rmSync(`${OUT}/${f}`, { recursive: true, force: true });
try {
  if (ONE_TAKE) {
    // One take: buy (the CSD shows within seconds), then sell what was already there
    await take("1-trade", async page => {
      await open(page);
      const steps = { buy: async () => {
        await trade(page, "buy", BUY, /Bought/);
        await sleep(1500);
        await scrollTo(page, page.getByRole("region", { name: "Your wallet" }));
        if (!(await page.getByText(/unconfirmed/).isVisible().catch(() => false))) {
          await fastOn(page, "waiting for the CSD payment");
          await page.getByText(/unconfirmed/).waitFor({ timeout: 90_000 }).catch(() => log("(the CSD didn't show as unconfirmed within 90 s)"));
          await fastOff(page);
        }
        { const b = await page.getByText(/unconfirmed/).first().boundingBox({ timeout: 3000 }).catch(() => null);
          if (b) await page.mouse.move(b.x - 26, b.y + b.height / 2, { steps: 30 }); }
        await sleep(3500);
      }, sell: async () => {
        await trade(page, "sell", SELL, /Sold|is paid/);
        await sleep(1500);
        await scrollTo(page, page.getByRole("region", { name: "Your wallet" }));
        { const b = await page.getByRole("region", { name: "Your wallet" }).getByText(/USDC arriving|^USDC$/).first().boundingBox({ timeout: 3000 }).catch(() => null);
          if (b) await page.mouse.move(b.x - 26, b.y + b.height / 2, { steps: 30 }); }
        await sleep(5000);
      } };
      for (const [i, side] of (SELL_FIRST ? ["sell", "buy"] : ["buy", "sell"]).entries()) {
        if (i > 0) { await sleep(1500); await page.locator(".banner[role=status]").getByRole("button", { name: "Dismiss" }).click().catch(() => {}); }
        await steps[side]();
      }
    });
  } else {
  // 1. Buy: the CSD shows in the wallet within seconds
  await take("1-buy", async page => {
    await open(page);
    await trade(page, "buy", BUY, /Bought/);
    await sleep(1500);
    await scrollTo(page, page.getByRole("region", { name: "Your wallet" }));
    if (!(await page.getByText(/unconfirmed/).isVisible().catch(() => false))) {
      await fastOn(page, "waiting for the CSD payment");
      await page.getByText(/unconfirmed/).waitFor({ timeout: 90_000 }).catch(() => log("(the CSD didn't show as unconfirmed within 90 s)"));
      await fastOff(page);
    }
    { const b = await page.getByText(/unconfirmed/).first().boundingBox({ timeout: 3000 }).catch(() => null); // the pointer beside it, not over it
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
    { const b = await page.getByRole("region", { name: "Your wallet" }).getByText(/USDC arriving|^USDC$/).first().boundingBox({ timeout: 3000 }).catch(() => null);
      if (b) await page.mouse.move(b.x - 26, b.y + b.height / 2, { steps: 30 }); }
    await sleep(5000);
  });
  }

  // (not filmed) the sale's signed receipt
  log("waiting for the sale's receipt…");
  let receiptUrl = null;
  { const ctx = await context(), page = await ctx.newPage();
    // (stays on the page: it looks for the receipt on AON every 10 s; reloading would cut that short)
    for (let round = 0; round < 3 && !receiptUrl; round++) {
      await page.goto(SITE, { waitUntil: "networkidle" }).catch(() => {}); await sleep(5000);
      const c = page.getByRole("button", { name: "Connect wallet to trade" }); if (await c.isVisible().catch(() => false)) { await c.click(); await sleep(4000); }
      const a = page.getByRole("region", { name: "Your trades" }).getByRole("link", { name: /Receipt/ }).first();
      if (await a.waitFor({ timeout: 6 * 60_000 }).then(() => true, () => false)) receiptUrl = await a.getAttribute("href");
    }
    await done(ctx); }

  // 3. The trades and the receipt on AON
  if (receiptUrl) await take("3-receipt", async page => {
    await open(page);
    await scrollTo(page, page.getByRole("region", { name: "Your trades" })); await sleep(2500);
    await glide(page, page.getByRole("region", { name: "Your trades" }).getByRole("link", { name: /Receipt/ }).first(), false); await sleep(1200);
    await page.goto(receiptUrl, { waitUntil: "networkidle" }).catch(() => {});
    // The explorer shows the receipt with the objects it links to (the offer, the order, the
    // payment…), each a collapsed row; the receipt's own row is opened to show what it says
    const root = page.locator(".result .gnode.root .ghead");
    if (await root.waitFor({ timeout: 30_000 }).then(() => true, () => false)) {
      await scrollTo(page, page.locator(".result")); await sleep(2500);
      await glide(page, root); await sleep(1500);
      const pre = page.locator(".result .gnode.root pre");
      await page.mouse.move(W - 140, H / 2, { steps: 20 }); await sleep(2500);
      // read down through it slowly
      await page.evaluate(async () => {
        const el = document.querySelector(".result .gnode.root pre"); if (!el) return;
        const to = el.getBoundingClientRect().bottom + window.scrollY - window.innerHeight + 60, from = window.scrollY;
        if (to <= from) return;
        const n = Math.max(40, Math.round((to - from) / 6));
        for (let i = 1; i <= n; i++) { window.scrollTo(0, from + (to - from) * i / n); await new Promise(r => setTimeout(r, 30)); }
      });
      await sleep(4000);
    } else {
      log("(the explorer didn't show the receipt's graph)");
      await page.mouse.move(W - 120, H / 2, { steps: 20 }); await sleep(5000);
    }
  }, 2); else log("no receipt within the wait; filmed the buy and the sell only");
} finally { await browser.close(); }

// One mp4 for posting (H.264, plays everywhere): each clip from where the page has loaded, with
// the waits fast-forwarded (they carry the on-screen badge)
const clips = ["1-trade", "1-buy", "2-sell", "3-receipt"].filter(c => existsSync(`${OUT}/${c}.webm`));
try {
  const parts = [];
  clips.forEach((c, i) => {
    const k = cuts[c] ?? { start: 0, fast: [], end: null };
    let t = k.start;
    for (const [a, b] of k.fast) {
      if (b === null || a < t) continue;
      if (a > t) parts.push({ i, a: t, b: a, speed: 1 });
      parts.push({ i, a, b, speed: FAST }); t = b;
    }
    parts.push({ i, a: t, b: null, speed: 1 });
  });
  const f = parts.map((p, n) => `[${p.i}:v]trim=start=${p.a.toFixed(3)}${p.b !== null ? `:end=${p.b.toFixed(3)}` : ""},setpts=(PTS-STARTPTS)/${p.speed},fps=30[v${n}]`).join(";")
    + ";" + parts.map((_, n) => `[v${n}]`).join("") + `concat=n=${parts.length}:v=1:a=0[out]`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...clips.flatMap(c => ["-i", `${OUT}/${c}.webm`]), "-filter_complex", f, "-map", "[out]",
    "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${OUT}/covenant-live.mp4`]);
  log(`film: ${OUT}/covenant-live.mp4 (and each clip as .webm)`);
} catch (e) { log(`clips in ${OUT} (${clips.join(", ")}); joining them failed (${String(e.message).split("\n")[0]}; is ffmpeg installed? apt install -y ffmpeg)`); }
