// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// CSD output serialization (little-endian):
//   output_count : uint64le
//   per output   : value(uint64le) + script_len(uint64le) + script(script_len bytes)
//
// CSD txid   = dsha256( version(4le) + input_count(8le) + inputs_with_empty_scripts + outputs_tail )
// Block hash = dsha256( version(4le) + prev(32) + merkle(32) + time(8le) + bits(4le) + nonce(4le) )
//
// Difficulty ratchet:
//   minimumTarget tracks the hardest difficulty target seen in a settled block.
//   It is stored as a uint256 target (decoded from bits), not as the raw block hash.
//   This ensures consecutive blocks at the same difficulty can all settle —
//   a lucky block (hash << target) does not artificially inflate the floor.
//   The PoW check requires blockHash <= minimumTarget.
//   minimumTarget can only decrease (floor can only get harder).

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract CsdUsdcSettlement {

    bytes32 public constant CSD_USDC_AUTH_TYPEHASH = keccak256(
        "CsdUsdcAuthorization(address buyer,address sellerUsdcRecipient,bytes32 sellerCsdScriptHash,"
        "bytes32 csdGenesisHash,bytes32 tradeIntentHash,uint256 csdAmount,address usdc,"
        "uint256 usdcAmount,uint256 minConfirmations,uint256 executorFeeAmount,"
        "uint64 validAfter,uint64 validBefore,bytes32 nonce)"
    );

    bytes32 private immutable DOMAIN_SEPARATOR;

    // Starts at uint256 max (any hash passes). Updated on every successful settlement
    // to the min of the current value and the settled block's difficulty target.
    uint256 public minimumTarget = type(uint256).max;

    mapping(bytes32 => bool)    public finalizedAuthorization;
    mapping(bytes32 => bool)    public consumedCsdTx;
    mapping(bytes32 => bool)    public usdcLocked;
    mapping(bytes32 => uint256) public lockedUntil;
    mapping(bytes32 => uint256) public lockedAmount;

    uint256 public constant SETTLEMENT_LOCK_SECONDS = 20 minutes;

    // ── Structs ───────────────────────────────────────────────────────────────

    struct CsdUsdcAuthorization {
        address buyer;
        address sellerUsdcRecipient;
        bytes32 sellerCsdScriptHash;   // 20-byte script left-aligned in bytes32
        bytes32 csdGenesisHash;
        bytes32 tradeIntentHash;
        uint256 csdAmount;
        address usdc;
        uint256 usdcAmount;
        uint256 minConfirmations;
        uint256 executorFeeAmount;
        uint64  validAfter;
        uint64  validBefore;
        bytes32 nonce;
    }

    struct CsdMerkleStep {
        bytes32 hash;
        bool    isLeft;               // true = sibling is on the left
    }

    struct CsdBlockHeader {
        uint32  version;
        bytes32 prev;
        bytes32 merkle;
        uint64  time;
        uint32  bits;
        uint32  nonce;
    }

    struct CsdSpvProof {
        bytes           txRaw;         // Full raw transaction bytes
        CsdMerkleStep[] merkleBranch;  // Merkle inclusion proof
        CsdBlockHeader  header;        // Block header containing the tx
        bytes32         genesisHash;   // CSD chain identifier
    }

    // ── Events ────────────────────────────────────────────────────────────────

    event CsdUsdcSettled(
        bytes32 indexed authHash,
        bytes32 indexed csdTxid,
        address indexed buyer,
        address sellerUsdcRecipient,
        address usdc,
        uint256 usdcAmount,
        uint256 csdAmount
    );
    event CsdUsdcAuthorizationLocked(bytes32 indexed authHash, uint256 lockedUntil);
    event CsdUsdcAuthorizationFinalized(bytes32 indexed authHash, bytes32 indexed csdTxid);
    event CsdMinimumDifficultyUpdated(uint256 newMinimumTarget);

    // ── Errors ────────────────────────────────────────────────────────────────

    error BadSignature();
    error AuthorizationExpired(bytes32 authHash);
    error AuthorizationAlreadyFinalized(bytes32 authHash);
    error AuthorizationLocked(bytes32 authHash, uint256 lockedUntil);
    error AuthorizationNotLocked(bytes32 authHash);
    error CsdTxAlreadyConsumed(bytes32 csdTxid);
    error CsdGenesisHashMismatch();
    error CsdMerkleInvalid();
    error CsdPaymentOutputNotFound();
    error CsdInsufficientPoW();
    error TransferFailed();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("AON CSD/USDC")),
            keccak256(bytes("2")),
            block.chainid,
            address(this)
        ));
    }

    function domainSeparator() external view returns (bytes32) { return DOMAIN_SEPARATOR; }

    // ── EIP-712 hashing ───────────────────────────────────────────────────────

    function hashCsdUsdcAuthorization(
        CsdUsdcAuthorization calldata auth
    ) public view returns (bytes32) {
        return keccak256(abi.encodePacked(
            "\x19\x01",
            DOMAIN_SEPARATOR,
            keccak256(abi.encode(
                CSD_USDC_AUTH_TYPEHASH,
                auth.buyer, auth.sellerUsdcRecipient, auth.sellerCsdScriptHash,
                auth.csdGenesisHash, auth.tradeIntentHash, auth.csdAmount, auth.usdc,
                auth.usdcAmount, auth.minConfirmations, auth.executorFeeAmount,
                auth.validAfter, auth.validBefore, auth.nonce
            ))
        ));
    }

    // ── Lock ─────────────────────────────────────────────────────────────────
    // Buyer locks USDC to signal commitment. Seller can then safely send CSD.

    function lockCsdUsdcAuthorization(
        CsdUsdcAuthorization calldata auth,
        bytes calldata authSig
    ) external {
        bytes32 authHash = hashCsdUsdcAuthorization(auth);

        if (usdcLocked[authHash])            revert AuthorizationLocked(authHash, lockedUntil[authHash]);
        if (finalizedAuthorization[authHash]) revert AuthorizationAlreadyFinalized(authHash);
        if (block.timestamp < auth.validAfter || block.timestamp > auth.validBefore)
            revert AuthorizationExpired(authHash);
        if (_recover(authHash, authSig) != auth.buyer) revert BadSignature();

        // CEI: set state before external call to prevent reentrancy
        uint256 lockAmount = auth.usdcAmount + auth.executorFeeAmount;
        uint256 until = block.timestamp + SETTLEMENT_LOCK_SECONDS;
        if (until > auth.validBefore) until = auth.validBefore;

        lockedAmount[authHash] = lockAmount;
        usdcLocked[authHash]   = true;
        lockedUntil[authHash]  = until;

        if (!IERC20(auth.usdc).transferFrom(auth.buyer, address(this), lockAmount))
            revert TransferFailed();

        emit CsdUsdcAuthorizationLocked(authHash, until);
    }

    // ── Refund ────────────────────────────────────────────────────────────────
    // Returns USDC to buyer if the lock window expired without settlement.

    function refundExpiredLock(CsdUsdcAuthorization calldata auth) external {
        bytes32 authHash = hashCsdUsdcAuthorization(auth);

        if (finalizedAuthorization[authHash]) revert AuthorizationAlreadyFinalized(authHash);
        if (!usdcLocked[authHash])            revert AuthorizationNotLocked(authHash);
        if (block.timestamp <= lockedUntil[authHash])
            revert AuthorizationLocked(authHash, lockedUntil[authHash]);

        // CEI: clear state before transfer
        uint256 amount = lockedAmount[authHash];
        lockedAmount[authHash] = 0;
        usdcLocked[authHash]   = false;
        lockedUntil[authHash]  = 0;

        if (!IERC20(auth.usdc).transfer(auth.buyer, amount)) revert TransferFailed();
    }

    // ── Settle ────────────────────────────────────────────────────────────────
    // Verifies the CSD payment on-chain via SPV, releases USDC to seller.

    function settleCsdUsdc(
        CsdUsdcAuthorization calldata auth,
        bytes calldata authSig,
        CsdSpvProof calldata spvProof
    ) external {
        bytes32 authHash = hashCsdUsdcAuthorization(auth);

        if (finalizedAuthorization[authHash]) revert AuthorizationAlreadyFinalized(authHash);
        if (!usdcLocked[authHash] || block.timestamp > lockedUntil[authHash])
            revert AuthorizationNotLocked(authHash);
        if (block.timestamp < auth.validAfter || block.timestamp > auth.validBefore)
            revert AuthorizationExpired(authHash);
        if (_recover(authHash, authSig) != auth.buyer) revert BadSignature();

        // Full on-chain SPV — returns verified txid and updates difficulty floor
        bytes32 csdTxid = _verifyCsdSpv(
            spvProof, auth.sellerCsdScriptHash, auth.csdAmount, auth.csdGenesisHash
        );

        if (consumedCsdTx[csdTxid]) revert CsdTxAlreadyConsumed(csdTxid);

        // CEI: update all state before transfers
        consumedCsdTx[csdTxid]          = true;
        finalizedAuthorization[authHash] = true;
        lockedAmount[authHash] = 0;
        usdcLocked[authHash]   = false;
        lockedUntil[authHash]  = 0;

        if (!IERC20(auth.usdc).transfer(auth.sellerUsdcRecipient, auth.usdcAmount))
            revert TransferFailed();

        if (auth.executorFeeAmount > 0)
            if (!IERC20(auth.usdc).transfer(msg.sender, auth.executorFeeAmount))
                revert TransferFailed();

        emit CsdUsdcAuthorizationFinalized(authHash, csdTxid);
        emit CsdUsdcSettled(
            authHash, csdTxid, auth.buyer, auth.sellerUsdcRecipient,
            auth.usdc, auth.usdcAmount, auth.csdAmount
        );
    }

    // ── SPV verification ──────────────────────────────────────────────────────

    function _verifyCsdSpv(
        CsdSpvProof calldata proof,
        bytes32 expectedScriptHash,
        uint256 expectedAmount,
        bytes32 expectedGenesisHash
    ) internal returns (bytes32 csdTxid) {
        if (proof.genesisHash != expectedGenesisHash) revert CsdGenesisHashMismatch();

        // 1. Compute txid from raw bytes (strips input script_sigs, dsha256)
        csdTxid = _csdTxidFromRaw(proof.txRaw);

        // 2. Verify an output in the tx pays expectedScriptHash >= expectedAmount
        _verifyCsdPaymentOutput(proof.txRaw, expectedScriptHash, expectedAmount);

        // 3. Verify txid is included in the block via merkle branch
        bytes32 computedMerkle = _csdMerkleRoot(csdTxid, proof.merkleBranch);
        if (computedMerkle != proof.header.merkle) revert CsdMerkleInvalid();

        // 4. Hash the block header and verify it meets the ratcheted difficulty floor
        bytes32 blockHash = _csdHeaderHash(proof.header);
        if (uint256(blockHash) > minimumTarget) revert CsdInsufficientPoW();

        // 5. Ratchet: update the floor using the difficulty TARGET (from bits),
        //    not the raw block hash. This allows consecutive blocks at the same
        //    difficulty to settle — a lucky hash does not inflate the floor.
        uint256 blockDifficultyTarget = _bitsToTarget(proof.header.bits);
        if (blockDifficultyTarget < minimumTarget) {
            minimumTarget = blockDifficultyTarget;
            emit CsdMinimumDifficultyUpdated(blockDifficultyTarget);
        }
    }

    // ── SPV primitives ────────────────────────────────────────────────────────

    // Compute CSD txid: dsha256 of tx bytes with input script_sigs replaced by empty
    function _csdTxidFromRaw(bytes calldata txRaw) internal pure returns (bytes32) {
        uint256 len = txRaw.length;
        require(len >= 12, "CSD_TX_TOO_SHORT");

        bytes memory buf = new bytes(len); // upper bound; trimmed before hashing
        uint256 boff = 0;
        uint256 off  = 0;

        // version (4 bytes)
        _cpCalldata(txRaw, off, buf, boff, 4); off += 4; boff += 4;

        // input_count (8 bytes u64le)
        uint64 inputCount = _readU64LE(txRaw, off);
        _cpCalldata(txRaw, off, buf, boff, 8); off += 8; boff += 8;

        for (uint64 i = 0; i < inputCount; i++) {
            require(off + 44 <= len, "CSD_TX_INPUT_OVF"); // 32 prev + 4 vout + 8 scriptLen
            // prev txid (32) + vout (4)
            _cpCalldata(txRaw, off, buf, boff, 36); off += 36; boff += 36;
            // read script_len, write 0 (empty script_sig), skip the actual script bytes
            uint64 scriptLen = _readU64LE(txRaw, off);
            off  += 8;
            boff += 8; // buf is zero-initialized so these 8 bytes are already 0
            require(off + scriptLen <= len, "CSD_TX_SCRIPT_OVF");
            off += scriptLen;
        }

        // outputs + tail
        uint256 tail = len - off;
        _cpCalldata(txRaw, off, buf, boff, tail); boff += tail;

        assembly { mstore(buf, boff) } // trim to actual length
        return sha256(abi.encodePacked(sha256(buf)));
    }

    // Verify at least one output pays >= expectedAmount to expectedScriptHash (20 bytes, left-aligned)
    function _verifyCsdPaymentOutput(
        bytes calldata txRaw,
        bytes32 expectedScriptHash,
        uint256 expectedAmount
    ) internal pure {
        uint256 off = 4; // skip version
        uint256 len = txRaw.length;

        // skip inputs
        uint64 inputCount = _readU64LE(txRaw, off); off += 8;
        for (uint64 i = 0; i < inputCount; i++) {
            require(off + 44 <= len, "CSD_OUT_INPUT_OVF");
            off += 36;
            uint64 scriptLen = _readU64LE(txRaw, off); off += 8 + scriptLen;
        }

        require(off + 8 <= len, "CSD_NO_OUTPUT_COUNT");
        uint64 outputCount = _readU64LE(txRaw, off); off += 8;

        bytes20 expectedScript = bytes20(expectedScriptHash); // left-aligned 20 bytes
        bool paid = false;

        for (uint64 i = 0; i < outputCount && !paid; i++) {
            require(off + 16 <= len, "CSD_OUTPUT_OVF");
            uint64 value     = _readU64LE(txRaw, off); off += 8;
            uint64 scriptLen = _readU64LE(txRaw, off); off += 8;
            require(off + scriptLen <= len, "CSD_SCRIPT_OVF");

            if (scriptLen == 20 && value >= expectedAmount) {
                // calldataload reads 32 bytes; bytes20 takes the leftmost 20
                bytes20 script;
                uint256 soff = off;
                assembly { script := calldataload(add(txRaw.offset, soff)) }
                if (script == expectedScript) paid = true;
            }
            off += scriptLen;
        }

        if (!paid) revert CsdPaymentOutputNotFound();
    }

    // Walk merkle branch: dsha256(sibling || cur) or dsha256(cur || sibling)
    function _csdMerkleRoot(
        bytes32 txid,
        CsdMerkleStep[] calldata branch
    ) internal pure returns (bytes32) {
        bytes32 cur = txid;
        for (uint i = 0; i < branch.length; i++) {
            bytes32 h = branch[i].hash;
            cur = branch[i].isLeft
                ? sha256(abi.encodePacked(sha256(abi.encodePacked(h, cur))))
                : sha256(abi.encodePacked(sha256(abi.encodePacked(cur, h))));
        }
        return cur;
    }

    // dsha256 of: version(4le) + prev(32) + merkle(32) + time(8le) + bits(4le) + nonce(4le)
    function _csdHeaderHash(CsdBlockHeader calldata h) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(abi.encodePacked(
            _u32LE(h.version),
            h.prev,
            h.merkle,
            _u64LE(h.time),
            _u32LE(h.bits),
            _u32LE(h.nonce)
        ))));
    }

    // Decode Bitcoin compact target format (same as CSD uses)
    function _bitsToTarget(uint32 bits) internal pure returns (uint256) {
        uint256 exp  = bits >> 24;
        uint256 mant = bits & 0xFFFFFF;
        return exp > 3
            ? mant << (8 * (exp - 3))
            : mant >> (8 * (3 - exp));
    }

    // ── Byte helpers ──────────────────────────────────────────────────────────

    function _readU64LE(bytes calldata data, uint256 off) internal pure returns (uint64 v) {
        for (uint i = 0; i < 8; i++) v |= uint64(uint8(data[off + i])) << (i * 8);
    }

    function _u32LE(uint32 v) internal pure returns (bytes4) {
        return bytes4(abi.encodePacked(uint8(v), uint8(v>>8), uint8(v>>16), uint8(v>>24)));
    }

    function _u64LE(uint64 v) internal pure returns (bytes8) {
        return bytes8(abi.encodePacked(
            uint8(v), uint8(v>>8), uint8(v>>16), uint8(v>>24),
            uint8(v>>32), uint8(v>>40), uint8(v>>48), uint8(v>>56)
        ));
    }

    function _cpCalldata(
        bytes calldata src, uint256 srcOff,
        bytes memory dst, uint256 dstOff,
        uint256 n
    ) internal pure {
        for (uint256 i = 0; i < n; i++) dst[dstOff + i] = src[srcOff + i];
    }

    // ── ECDSA recovery ────────────────────────────────────────────────────────

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
