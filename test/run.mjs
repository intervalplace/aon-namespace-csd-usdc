// Runs the contract + namespace tests: compiles with solc 0.8.26, starts a
// local anvil (from the @foundry-rs/anvil npm package), runs the suite.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const arch = { x64: "amd64", arm64: "arm64" }[process.arch] ?? process.arch;
const anvilBin = join(dirname(require.resolve(`@foundry-rs/anvil-${process.platform}-${arch}/package.json`)), "bin", "anvil");
const port = process.env.ANVIL_PORT ?? "8546";

execFileSync(process.execPath, [join(here, "compile.cjs")], { stdio: "inherit" });
const anvil = spawn(anvilBin, ["--port", port, "--silent"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 1500));
let code = 1;
try {
  for (const t of ["consensus.test.mjs", "oracle.test.mjs", "mainnet.test.mjs", "encoding.test.mjs", "check-script.test.mjs", "relay.test.mjs", "settlement.test.mjs"])
    execFileSync(process.execPath, ["--import", "tsx", join(here, t)], { stdio: "inherit", env: { ...process.env, ANVIL_PORT: port } });
  code = 0;
} catch { code = 1; } finally { anvil.kill(); }
process.exit(code);
