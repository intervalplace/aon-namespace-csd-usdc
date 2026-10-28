// Compiles the settlement contract, the header oracle and a test USDC into test/artifacts.json.
const solc = require("solc"), fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "../src/contracts/");
const mock = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract MockUSDC {
  mapping(address=>uint256) public balanceOf; mapping(address=>mapping(address=>uint256)) public allowance;
  function mint(address to, uint256 a) external { balanceOf[to] += a; }
  function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
  function transfer(address to, uint256 a) external returns (bool) { require(balanceOf[msg.sender] >= a, "bal"); balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
  function transferFrom(address f, address to, uint256 a) external returns (bool) { require(allowance[f][msg.sender] >= a, "allow"); require(balanceOf[f] >= a, "bal"); allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true; }
}`;
const sources = {
  "CsdUsdcSettlement.sol": { content: fs.readFileSync(dir + "CsdUsdcSettlement.sol", "utf8") },
  "CsdHeaderOracle.sol":   { content: fs.readFileSync(dir + "CsdHeaderOracle.sol", "utf8") },
  "MockUSDC.sol": { content: mock },
};
const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources,
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
let bad = false;
for (const e of out.errors ?? []) { console.error(e.severity, e.formattedMessage.split("\n").slice(0,3).join(" | ")); if (e.severity === "error") bad = true; }
if (bad) process.exit(1);
const art = {};
for (const f in out.contracts) for (const n in out.contracts[f]) art[n] = { abi: out.contracts[f][n].abi, bytecode: "0x" + out.contracts[f][n].evm.bytecode.object };
fs.writeFileSync(path.join(__dirname, "artifacts.json"), JSON.stringify(art));
console.log("compiled:", Object.keys(art).join(" "), "settlement bytes:", (art.CsdUsdcSettlement.bytecode.length-2)/2);
