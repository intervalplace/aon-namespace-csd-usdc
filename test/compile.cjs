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
  // EIP-2612, as USDC implements it (domain "USD Coin", version "2")
  mapping(address=>uint256) public nonces;
  bytes32 public constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
  function DOMAIN_SEPARATOR() public view returns (bytes32) { return keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("USD Coin"), keccak256("2"), block.chainid, address(this))); }
  function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
    require(block.timestamp <= deadline, "expired");
    bytes32 d = keccak256(abi.encodePacked("\\x19\\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))));
    address signer = ecrecover(d, v, r, s); require(signer != address(0) && signer == owner, "permit sig");
    allowance[owner][spender] = value;
  }
}`;
const sources = {
  "CsdUsdcSettlement.sol": { content: fs.readFileSync(dir + "CsdUsdcSettlement.sol", "utf8") },
  "CsdHeaderOracle.sol":   { content: fs.readFileSync(dir + "CsdHeaderOracle.sol", "utf8") },
  "MockUSDC.sol": { content: mock },
  "TestContracts.sol": { content: fs.readFileSync(path.join(__dirname, "TestContracts.sol"), "utf8") },
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
