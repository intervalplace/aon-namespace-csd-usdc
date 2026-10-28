// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// CSD header oracle (v2): a light client for Compute Substrate on EVM.
//
// Every header is checked against the same rules a CSD node applies
// (compute-substrate src/chain/index.rs, pow.rs, time.rs, params/mod.rs):
//   - proof of work:      dsha256(header) <= target(bits), bits within the PoW limit
//   - difficulty:         bits == the LWMA retarget computed from the 45 headers before it
//   - timestamps:         time >= parent.time + 60s, time > median of the last 11,
//                         time <= now + 2h
// So a header chain can only be extended at CSD's real difficulty: faking a
// confirmation costs as much as mining a real CSD block, not a block at some
// configured floor.
//
// There is no owner. The starting point is fixed at deployment: 45
// consecutive real headers (the LWMA window), which anyone can check against
// a CSD node. Anyone can submit headers; the chain with the most work wins.

// Pure CSD consensus math (compute-substrate src/chain/pow.rs, time.rs),
// parameterized by the PoW limit so it can be tested at an easy difficulty.
library CsdConsensus {
    error BitsInvalid();

    uint256 internal constant TARGET_BLOCK_SECS  = 120;
    uint256 internal constant LWMA_MAX_SOLVETIME = 12 * 120;
    uint256 internal constant MTP_WINDOW         = 11;

    // median_time_past: median of the last MTP_WINDOW times ending at the parent
    function medianTimePast(uint64[45] memory times, uint256 m) internal pure returns (uint64) {
        uint256 k = m < MTP_WINDOW ? m : MTP_WINDOW;
        uint64[11] memory s;
        for (uint256 i = 0; i < k; i++) {
            uint64 v = times[i];
            uint256 j = i;
            while (j > 0 && s[j - 1] > v) { s[j] = s[j - 1]; j--; }
            s[j] = v;
        }
        return s[k / 2];
    }

    // expected_bits_strict (LWMA). times/bitsList are newest first; the Rust
    // code walks them oldest first, so index i there is m-1-i here.
    function expectedBits(
        uint32 parentBits, uint256 height,
        uint64[45] memory times, uint32[45] memory bitsList, uint256 m,
        uint32 powLimitBits
    ) internal pure returns (uint32) {
        if (height < 2) return parentBits;
        if (m < 2) return parentBits;

        uint256 weightedSum;
        uint256 denom;
        for (uint256 i = 1; i < m; i++) {
            uint64 a = times[m - i];       // oldest-first index i-1
            uint64 b = times[m - 1 - i];   // oldest-first index i
            uint256 dt = b > a ? uint256(b - a) : 0;
            uint256 st = dt < 1 ? 1 : (dt > LWMA_MAX_SOLVETIME ? LWMA_MAX_SOLVETIME : dt);
            weightedSum += st * i;
            denom += i;
        }
        if (denom == 0) return parentBits;
        uint256 avgSolvetime = weightedSum / denom;

        // floor(sum(targets) / m) and floor(avg * solvetime / T), computed
        // without overflow (exact; the Rust code uses big integers). With
        // CSD's real PoW limit the plain formulas can't overflow, but this
        // keeps the result exact at any limit.
        uint256 avgTarget;
        uint256 rem;
        for (uint256 i = 0; i < m; i++) {
            uint256 t = bitsToTarget(bitsList[i]);
            avgTarget += t / m;
            rem += t % m;
        }
        avgTarget += rem / m;

        uint256 limit = bitsToTarget(powLimitBits);
        uint256 q = avgTarget / TARGET_BLOCK_SECS;
        uint256 nextTarget;
        if (avgSolvetime != 0 && q > limit / avgSolvetime) {
            nextTarget = limit;   // already beyond the limit before the remainder
        } else {
            nextTarget = q * avgSolvetime + (avgTarget % TARGET_BLOCK_SECS) * avgSolvetime / TARGET_BLOCK_SECS;
            if (nextTarget > limit) nextTarget = limit;
        }
        if (nextTarget == 0) return powLimitBits;

        uint32 bits = targetToBits(nextTarget);
        if (!bitsWithinLimit(bits, powLimitBits)) return powLimitBits;
        return bits;
    }

    // bits_to_target_bytes: invalid encodings revert
    function bitsToTarget(uint32 bits) internal pure returns (uint256) {
        uint256 exp  = bits >> 24;
        uint256 mant = bits & 0x00ffffff;
        if (exp == 0 || mant == 0 || (mant & 0x00800000) != 0 || exp > 32) revert BitsInvalid();
        uint256 target = exp <= 3 ? mant >> (8 * (3 - exp)) : mant << (8 * (exp - 3));
        if (target == 0) revert BitsInvalid();
        return target;
    }

    // bits_within_pow_limit: valid encoding and target <= the PoW limit
    function bitsWithinLimit(uint32 bits, uint32 powLimitBits) internal pure returns (bool) {
        if (bits == 0) return false;
        uint256 exp  = bits >> 24;
        uint256 mant = bits & 0x00ffffff;
        if (exp == 0 || mant == 0 || (mant & 0x00800000) != 0 || exp > 32) return false;
        uint256 target = exp <= 3 ? mant >> (8 * (3 - exp)) : mant << (8 * (exp - 3));
        if (target == 0) return false;
        return target <= bitsToTarget(powLimitBits);
    }

    // target_bytes_to_bits (canonical compact encoding)
    function targetToBits(uint256 x) internal pure returns (uint32) {
        if (x == 0) return 0;
        uint256 len;
        for (uint256 t = x; t > 0; t >>= 8) len++;
        uint256 mant = len <= 3 ? (x << (8 * (3 - len))) & 0x00ffffff : (x >> (8 * (len - 3))) & 0x00ffffff;
        uint256 exp = len;
        if ((mant & 0x00800000) != 0) { mant >>= 8; exp += 1; }
        mant &= 0x00ffffff;
        return uint32((exp << 24) | mant);
    }

    // work_from_bits: floor(2^256 / (target + 1)), clamped to u128
    function workFromTarget(uint256 target) internal pure returns (uint256) {
        if (target == type(uint256).max) return 1;
        uint256 d = target + 1;
        uint256 q = type(uint256).max / d;
        if (type(uint256).max % d == d - 1) q += 1;   // 2^256 = max + 1
        return q > type(uint128).max ? type(uint128).max : q;
    }

}

contract CsdHeaderOracle {
    struct CsdBlockHeader {
        uint32  version;
        bytes32 prev;
        bytes32 merkle;
        uint64  time;
        uint32  bits;
        uint32  nonce;
    }

    struct StoredHeader {
        bytes32 parent;
        uint64  height;
        uint64  time;
        uint32  bits;
        bool    exists;
        uint256 chainWork;
    }

    // ── CSD consensus parameters (compute-substrate src/params/mod.rs) ────────
    uint256 public constant TARGET_BLOCK_SECS      = 120;
    uint256 public constant LWMA_WINDOW            = 45;
    uint256 public constant LWMA_MAX_SOLVETIME     = 12 * TARGET_BLOCK_SECS;
    uint32  public constant POW_LIMIT_BITS         = 0x1e00ffff;
    uint256 public constant MIN_BLOCK_SPACING_SECS = 60;
    uint256 public constant MTP_WINDOW             = 11;
    uint256 public constant MAX_FUTURE_DRIFT_SECS  = 2 hours;

    bytes32 public immutable genesisHash;
    uint256 public immutable maxAncestorDepth;
    bytes32 public immutable checkpointHash;   // the last of the 45 starting headers

    mapping(bytes32 => StoredHeader) public headers;

    bytes32 private _bestTip;
    uint256 private _bestHeight;
    uint256 private _bestChainWork;

    event HeaderSubmitted(bytes32 indexed genesisHash, bytes32 indexed blockHash, bytes32 indexed parent, uint256 height, uint256 chainWork);
    event BestTipUpdated(bytes32 indexed genesisHash, bytes32 indexed bestTip, uint256 height, uint256 chainWork);

    error WrongChain();
    error InvalidCheckpoint();
    error ParentUnknown();
    error HistoryTooShort();
    error BitsInvalid();
    error UnexpectedBits(uint32 got, uint32 want);
    error HeaderInsufficientPoW();
    error TimeTooEarly();
    error TimeNotAfterMedian();
    error TimeTooFarInFuture();

    constructor(
        bytes32 _genesisHash,
        CsdBlockHeader[] memory checkpoint,   // 45 consecutive headers, oldest first
        uint64 checkpointStartHeight,          // height of checkpoint[0]
        uint256 _maxAncestorDepth
    ) {
        if (_genesisHash == bytes32(0) || checkpoint.length != LWMA_WINDOW || checkpointStartHeight < 2) revert InvalidCheckpoint();
        genesisHash = _genesisHash;
        maxAncestorDepth = _maxAncestorDepth == 0 ? 256 : _maxAncestorDepth;

        bytes32 prevHash;
        uint256 work;
        for (uint256 i = 0; i < checkpoint.length; i++) {
            CsdBlockHeader memory h = checkpoint[i];
            bytes32 blockHash = _headerHash(h);
            if (i > 0 && h.prev != prevHash) revert InvalidCheckpoint();
            if (!CsdConsensus.bitsWithinLimit(h.bits, _powLimitBits())) revert BitsInvalid();
            uint256 target = CsdConsensus.bitsToTarget(h.bits);
            if (uint256(blockHash) > target) revert HeaderInsufficientPoW();
            work += CsdConsensus.workFromTarget(target);
            headers[blockHash] = StoredHeader({
                parent: h.prev, height: checkpointStartHeight + uint64(i), time: h.time,
                bits: h.bits, exists: true, chainWork: work
            });
            prevHash = blockHash;
        }
        checkpointHash = prevHash;
        _bestTip = prevHash;
        _bestHeight = checkpointStartHeight + checkpoint.length - 1;
        _bestChainWork = work;
    }

    // ── Submitting headers ───────────────────────────────────────────────────

    function submitHeaders(bytes32 _genesisHash, CsdBlockHeader[] calldata newHeaders) external {
        if (_genesisHash != genesisHash) revert WrongChain();

        for (uint256 i = 0; i < newHeaders.length; i++) {
            CsdBlockHeader calldata h = newHeaders[i];
            bytes32 blockHash = _headerHashCd(h);
            if (headers[blockHash].exists) continue; // already known

            StoredHeader storage parent = headers[h.prev];
            if (!parent.exists) revert ParentUnknown();

            // Timestamps (index.rs): spacing, median-time-past, future drift
            if (uint256(h.time) < uint256(parent.time) + MIN_BLOCK_SPACING_SECS) revert TimeTooEarly();
            (uint64[45] memory times, uint32[45] memory bitsList, uint256 m) = _history(h.prev, uint256(parent.height) + 1);
            if (h.time <= CsdConsensus.medianTimePast(times, m)) revert TimeNotAfterMedian();
            if (uint256(h.time) > block.timestamp + MAX_FUTURE_DRIFT_SECS) revert TimeTooFarInFuture();

            // Difficulty (pow.rs): bits must be exactly the LWMA retarget
            if (!CsdConsensus.bitsWithinLimit(h.bits, _powLimitBits())) revert BitsInvalid();
            uint32 want = CsdConsensus.expectedBits(parent.bits, uint256(parent.height) + 1, times, bitsList, m, _powLimitBits());
            if (h.bits != want) revert UnexpectedBits(h.bits, want);

            uint256 target = CsdConsensus.bitsToTarget(h.bits);
            if (uint256(blockHash) > target) revert HeaderInsufficientPoW();

            uint256 height = uint256(parent.height) + 1;
            uint256 chainWork = parent.chainWork + CsdConsensus.workFromTarget(target);
            headers[blockHash] = StoredHeader({
                parent: h.prev, height: uint64(height), time: h.time,
                bits: h.bits, exists: true, chainWork: chainWork
            });
            emit HeaderSubmitted(genesisHash, blockHash, h.prev, height, chainWork);

            if (chainWork > _bestChainWork) {
                _bestTip = blockHash;
                _bestHeight = height;
                _bestChainWork = chainWork;
                emit BestTipUpdated(genesisHash, blockHash, height, chainWork);
            }
        }
    }

    // ── Queries ──────────────────────────────────────────────────────────────

    // True if blockHash is on the best known chain with at least
    // minConfirmations (counting the block itself).
    function isConfirmed(bytes32 blockHash, bytes32 _genesisHash, uint256 minConfirmations) external view returns (bool) {
        if (_genesisHash != genesisHash) return false;
        StoredHeader storage target = headers[blockHash];
        if (!target.exists) return false;

        uint256 required = minConfirmations == 0 ? 1 : minConfirmations;
        if (_bestHeight < target.height) return false;
        uint256 confirmations = _bestHeight - target.height + 1;
        if (confirmations < required) return false;

        uint256 distance = _bestHeight - target.height;
        if (distance > maxAncestorDepth) return false;

        bytes32 cursor = _bestTip;
        for (uint256 i = 0; i < distance; i++) cursor = headers[cursor].parent;
        return cursor == blockHash;
    }

    function bestTip(bytes32 _genesisHash) external view returns (bytes32) { return _genesisHash == genesisHash ? _bestTip : bytes32(0); }
    function bestHeight(bytes32 _genesisHash) external view returns (uint256) { return _genesisHash == genesisHash ? _bestHeight : 0; }
    function bestTipTime(bytes32 _genesisHash) external view returns (uint256) { return _genesisHash == genesisHash ? headers[_bestTip].time : 0; }
    function bestChainWork(bytes32 _genesisHash) external view returns (uint256) { return _genesisHash == genesisHash ? _bestChainWork : 0; }
    function blockHeight(bytes32 blockHash) external view returns (uint256) { return headers[blockHash].height; }
    function blockChainWork(bytes32 blockHash) external view returns (uint256) { return headers[blockHash].chainWork; }

    // The bits CSD requires for a child of `parentHash` (for relayers and tests)
    function expectedBitsAfter(bytes32 parentHash) external view returns (uint32) {
        StoredHeader storage parent = headers[parentHash];
        if (!parent.exists) revert ParentUnknown();
        (uint64[45] memory times, uint32[45] memory bitsList, uint256 m) = _history(parentHash, uint256(parent.height) + 1);
        return CsdConsensus.expectedBits(parent.bits, uint256(parent.height) + 1, times, bitsList, m, _powLimitBits());
    }

    // ── CSD consensus rules ──────────────────────────────────────────────────

    // CSD mainnet's PoW limit. Virtual only so the test suite can run the same
    // rules at an easy difficulty (test/TestCsdHeaderOracle.sol).
    function _powLimitBits() internal pure virtual returns (uint32) { return POW_LIMIT_BITS; }

    // Up to LWMA_WINDOW headers ending at `parentHash` (newest first), as in
    // expected_bits_strict: n = min(LWMA_WINDOW, height of the new header).
    function _history(bytes32 parentHash, uint256 height)
        internal view returns (uint64[45] memory times, uint32[45] memory bitsList, uint256 m)
    {
        uint256 n = height < LWMA_WINDOW ? height : LWMA_WINDOW;
        bytes32 cur = parentHash;
        while (m < n) {
            StoredHeader storage h = headers[cur];
            if (!h.exists) revert HistoryTooShort();
            times[m] = h.time;
            bitsList[m] = h.bits;
            m++;
            if (h.parent == bytes32(0)) break;
            cur = h.parent;
        }
    }

    // dsha256(version 4le | prev 32 | merkle 32 | time 8le | bits 4le | nonce 4le)
    function _headerHash(CsdBlockHeader memory h) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(abi.encodePacked(
            _u32LE(h.version), h.prev, h.merkle, _u64LE(h.time), _u32LE(h.bits), _u32LE(h.nonce)
        ))));
    }

    function _headerHashCd(CsdBlockHeader calldata h) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(abi.encodePacked(
            _u32LE(h.version), h.prev, h.merkle, _u64LE(h.time), _u32LE(h.bits), _u32LE(h.nonce)
        ))));
    }

    function _u32LE(uint32 v) internal pure returns (bytes4) {
        return bytes4(abi.encodePacked(uint8(v), uint8(v >> 8), uint8(v >> 16), uint8(v >> 24)));
    }

    function _u64LE(uint64 v) internal pure returns (bytes8) {
        return bytes8(abi.encodePacked(
            uint8(v), uint8(v >> 8), uint8(v >> 16), uint8(v >> 24),
            uint8(v >> 32), uint8(v >> 40), uint8(v >> 48), uint8(v >> 56)
        ));
    }
}
