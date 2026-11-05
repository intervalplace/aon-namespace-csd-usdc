// Films a real trade on covenant.market at desktop size, in a headless Chrome, with a throwaway
// wallet: type an amount, press Buy, and the page says Received (the CSD is in the wallet within
// seconds); then, if the wallet has CSD ready, the same for a sale. Everything on screen is real
// and on mainnet.
//
//   npm i --no-save playwright@1.47.2 && npx playwright install --with-deps chromium   (once)
//   npx tsx scripts/film-live.mjs --new-key           # makes /root/film-key, prints its address
//   (send ~5 USDC to that address; no ETH needed)
//   npx tsx scripts/film-live.mjs                   # films; writes /root/film/covenant-live.mp4
//
// With CSD already in the film wallet, the buy is followed by a sale in the same take. Its CSD
// address, to send some CSD to:
//   npx tsx scripts/film-live.mjs --csd-address
//
// Env: FILM_KEY_FILE (/root/film-key), FILM_BUY (20 CSD), FILM_SELL ("all", an amount of CSD, or "0" for no sale), FILM_OUT (/root/film),
// FILM_SITE (https://covenant.market/), FILM_RPC (https://ethereum-rpc.publicnode.com),
// FILM_SELL_FIRST (1: sell first, then buy), FILM_W/FILM_H (1600x900), FILM_FAST (8: waits play 8x faster, marked on screen; 1: real time)

import { chromium } from "playwright";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";

const KEY_FILE = process.env.FILM_KEY_FILE ?? "/root/film-key";
const SITE = process.env.FILM_SITE ?? "https://covenant.market/";
const RPC = process.env.FILM_RPC ?? "https://ethereum-rpc.publicnode.com";
const OUT = process.env.FILM_OUT ?? "/root/film";
const SELL_FIRST = process.env.FILM_SELL_FIRST === "1"; // sell first, then buy with what it brought
const BUY = process.env.FILM_BUY ?? "20", SELL = process.env.FILM_SELL ?? "all"; // "all": sells all of it; "0": no sale
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
    b.textContent = `⏩ ${k}× speed, ${what}`;
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
  await page.locator("#csd-amount").waitFor({ timeout: 30_000 });
  await sleep(1200); if (cur) cur.start = at(); // (the clip starts here: no blank page loading)
  await sleep(1800);
  const connect = page.locator(".cv-act").getByRole("button", { name: "Connect wallet" });
  if (await connect.isVisible().catch(() => false)) { await glide(page, connect); await sleep(1500); }
  const openWallet = page.getByRole("button", { name: "Open CSD wallet" });
  if (await openWallet.isVisible().catch(() => false)) {
    const remember = page.getByLabel("Remember on this device");
    if (!(await remember.isChecked().catch(() => true))) await remember.check();
    await glide(page, openWallet); await sleep(2500);
  }
}
const stuck = async (page, why) => {
  await page.screenshot({ path: `${OUT}/stuck.png` }).catch(() => {});
  const main = await page.locator(".cv-main").first().innerText({ timeout: 2000 }).catch(() => "");
  const banner = await page.locator(".banner[role=status]").textContent({ timeout: 1000 }).catch(() => "");
  return new Error(`${why}: "${main.replace(/\s+/g, " ").slice(0, 300)}"${banner ? ` banner: "${banner.replace("Dismiss", "").trim()}"` : ""} (see ${OUT}/stuck.png)`);
};
// Types the sentence, presses the button, and stays until the page says Received
async function trade(page, side, amount) {
  await glide(page, page.getByRole("radio", { name: side === "buy" ? "Buy CSD" : "Sell CSD" })); await sleep(700);
  const input = page.locator("#csd-amount");
  if (amount === "all") { await glide(page, page.getByRole("button", { name: "Sell all" })); }
  else {
    await glide(page, input); await input.fill(""); await input.pressSequentially(amount, { delay: 180 });
    const b = await input.boundingBox().catch(() => null); // (the pointer off the number, so it can be read)
    if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height + 70, { steps: 15 });
  }
  await page.locator(".cv-quote").filter({ hasText: /USDC/ }).waitFor({ timeout: 20_000 }).catch(() => {});
  await sleep(2200); // (the price, read)
  const btn = page.locator(".cv-act button.cv-go");
  for (let i = 0; i < 120 && await btn.isDisabled(); i++) await sleep(500); // (up to a minute: e.g. a sale's USDC still arriving)
  if (await btn.isDisabled()) throw await stuck(page, `the ${side} button stays disabled`);
  const bb = await btn.boundingBox({ timeout: 5000 }).catch(() => null); // (taken before the click: the button's label changes then)
  await glide(page, btn);
  if (bb) await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height + 40, { steps: 15 }); // (off the button's text)
  await sleep(1500); // (the wallet's first steps play at normal speed)
  await fastOn(page, "waiting for Ethereum");
  await page.locator(".cv-done").waitFor({ timeout: 240_000 }).catch(async () => { throw await stuck(page, `no result for the ${side}`); });
  if (!(await page.locator(".cv-status-ok").isVisible().catch(() => false))) {
    await fastOff(page); await sleep(800);
    await fastOn(page, side === "buy" ? "waiting for the CSD payment" : "waiting for the USDC");
    await page.locator(".cv-status-ok").waitFor({ timeout: 120_000 }).catch(() => log(`(the ${side} didn't show Received within 2 minutes)`));
  }
  await fastOff(page);
  log(`${side}: ${(await page.locator(".cv-done h1").textContent().catch(() => "?"))}`);
  // the pointer rests beside the sentence, not over it
  { const b = await page.locator(".cv-done h1").boundingBox({ timeout: 3000 }).catch(() => null);
    if (b) await page.mouse.move(b.x + b.width + 60, b.y + b.height / 2, { steps: 30 }); }
  await sleep(4500);
}

mkdirSync(OUT, { recursive: true });
// CSD ready to sell already? (asked of the page, which counts all the wallet's addresses)
let SELL_TOO = false;
if (SELL !== "0") {
  const ctx = await context(), page = await ctx.newPage();
  try {
    await open(page);
    await page.getByRole("radio", { name: "Sell CSD" }).click();
    // (the wallet's balance shows "…" until it has looked through its addresses)
    await page.locator(".cv-balance").filter({ hasText: /CSD/ }).waitFor({ timeout: 120_000 }).catch(() => log("(the wallet took long to load)"));
    await sleep(3000);
    const line = await page.locator(".cv-balance").innerText().catch(() => "");
    const have = Number((line.match(/You have ([\d.,]+) CSD/) ?? [])[1]?.replace(/,/g, "") ?? 0);
    SELL_TOO = have >= 1;
    log(SELL_TOO ? `the film wallet has ${have} CSD ready to sell: a buy, then a sale, in one take` : "no CSD ready to sell in the film wallet: filming the buy only");
  } catch (e) { log(`(couldn't check the film wallet's CSD: ${String(e.message).split("\n")[0]})`); }
  await done(ctx);
}
// (clips from an earlier run would otherwise be joined into this film)
for (const f of readdirSync(OUT)) if (/^(\d-[a-z]+\.webm|covenant-live\.mp4|list\.txt|stuck\.png)$/.test(f) || f.startsWith("raw-")) rmSync(`${OUT}/${f}`, { recursive: true, force: true });
try {
  await take("1-trade", async page => {
    await open(page);
    const order = !SELL_TOO ? ["buy"] : SELL_FIRST ? ["sell", "buy"] : ["buy", "sell"];
    for (const [i, side] of order.entries()) {
      if (i > 0) { await glide(page, page.locator(".cv-done button.cv-go")); await sleep(1200); }
      await trade(page, side, side === "buy" ? BUY : SELL);
    }
  });
} finally { await browser.close(); }

// One mp4 for posting (H.264, plays everywhere): each clip from where the page has loaded, with
// the waits fast-forwarded (they carry the on-screen badge)
const clips = ["1-trade"].filter(c => existsSync(`${OUT}/${c}.webm`));
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
