// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./CsdHeaderOracle.sol";
import "./CsdUsdcSettlement.sol";

// The real oracle's rules at an easy PoW limit, so tests can mine headers.
contract TestCsdHeaderOracle is CsdHeaderOracle {
    constructor(bytes32 g, CsdBlockHeader[] memory cp, uint64 start, uint256 depth) CsdHeaderOracle(g, cp, start, depth) {}
    function _powLimitBits() internal pure override returns (uint32) { return 0x207fffff; }
}

// Exposes the consensus math for the cross-check against CSD's Rust code.
contract CsdConsensusHarness {
    function expectedBits(uint32 parentBits, uint256 height, uint64[] calldata timesNewestFirst, uint32[] calldata bitsNewestFirst, uint32 powLimitBits) external pure returns (uint32) {
        uint64[45] memory t; uint32[45] memory b;
        for (uint256 i = 0; i < timesNewestFirst.length; i++) { t[i] = timesNewestFirst[i]; b[i] = bitsNewestFirst[i]; }
        return CsdConsensus.expectedBits(parentBits, height, t, b, timesNewestFirst.length, powLimitBits);
    }
    function medianTimePast(uint64[] calldata timesNewestFirst) external pure returns (uint64) {
        uint64[45] memory t;
        for (uint256 i = 0; i < timesNewestFirst.length; i++) t[i] = timesNewestFirst[i];
        return CsdConsensus.medianTimePast(t, timesNewestFirst.length);
    }
    function targetToBits(uint256 x) external pure returns (uint32) { return CsdConsensus.targetToBits(x); }
    function workFromTarget(uint256 x) external pure returns (uint256) { return CsdConsensus.workFromTarget(x); }
}

// The real settlement's rules at an easy PoW limit, so tests can mine headers.
contract TestCsdUsdcSettlement is CsdUsdcSettlement {
    constructor(address usdc, uint256 maxTotal, bytes32 genesis) CsdUsdcSettlement(usdc, maxTotal, genesis) {}
    function _powLimitBits() internal pure override returns (uint32) { return 0x207fffff; }
    // Internals exposed for the encoding tests against CSD's own serializer
    function txidOf(bytes calldata raw) external pure returns (bytes32) { return _csdTxidFromRaw(raw); }
    function verifyTx(bytes calldata raw, bytes32 script, uint256 amount) external pure { _verifyCsdTx(raw, script, amount); }
    function headerHashOf(CsdBlockHeader calldata h) external pure returns (bytes32) { return _csdHeaderHash(h); }
}
