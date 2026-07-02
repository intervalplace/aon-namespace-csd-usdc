// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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
        bool exists;
        bytes32 parent;
        uint256 height;
        uint256 target;
        uint256 chainWork;
    }

    struct Chain {
        bool initialized;
        bytes32 bestTip;
        uint256 bestHeight;
        uint256 bestChainWork;
        uint256 maxTarget;
    }

    address public owner;
    uint256 public immutable maxAncestorDepth;

    mapping(bytes32 => Chain) public chains;              // genesisHash => Chain
    mapping(bytes32 => StoredHeader) public headers;      // blockHash => StoredHeader
    mapping(bytes32 => bytes32) public headerGenesisHash; // blockHash => genesisHash

    event ChainRegistered(
        bytes32 indexed genesisHash,
        bytes32 indexed checkpointHash,
        uint256 checkpointHeight,
        uint256 checkpointChainWork,
        uint256 maxTarget
    );

    event HeaderSubmitted(
        bytes32 indexed genesisHash,
        bytes32 indexed blockHash,
        bytes32 indexed parent,
        uint256 height,
        uint256 chainWork
    );

    event BestTipUpdated(
        bytes32 indexed genesisHash,
        bytes32 indexed bestTip,
        uint256 height,
        uint256 chainWork
    );

    error NotOwner();
    error ChainAlreadyRegistered();
    error ChainNotRegistered();
    error HeaderAlreadyKnown();
    error ParentUnknown();
    error HeaderPrevMismatch();
    error HeaderInsufficientPoW();
    error BitsInvalid();
    error TargetTooEasy();
    error InvalidCheckpoint();

    constructor(uint256 _maxAncestorDepth) {
        owner = msg.sender;
        maxAncestorDepth = _maxAncestorDepth == 0 ? 256 : _maxAncestorDepth;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        owner = nextOwner;
    }

    function registerChainCheckpoint(
        bytes32 genesisHash,
        bytes32 checkpointHash,
        uint256 checkpointHeight,
        uint256 checkpointChainWork,
        uint256 maxTarget
    ) external onlyOwner {
        if (chains[genesisHash].initialized) revert ChainAlreadyRegistered();
        if (genesisHash == bytes32(0) || checkpointHash == bytes32(0)) revert InvalidCheckpoint();
        if (checkpointChainWork == 0 || maxTarget == 0 || maxTarget == type(uint256).max) {
            revert InvalidCheckpoint();
        }

        chains[genesisHash] = Chain({
            initialized: true,
            bestTip: checkpointHash,
            bestHeight: checkpointHeight,
            bestChainWork: checkpointChainWork,
            maxTarget: maxTarget
        });

        headers[checkpointHash] = StoredHeader({
            exists: true,
            parent: bytes32(0),
            height: checkpointHeight,
            target: maxTarget,
            chainWork: checkpointChainWork
        });

        headerGenesisHash[checkpointHash] = genesisHash;

        emit ChainRegistered(
            genesisHash,
            checkpointHash,
            checkpointHeight,
            checkpointChainWork,
            maxTarget
        );
    }

    function submitHeaders(
        bytes32 genesisHash,
        CsdBlockHeader[] calldata newHeaders
    ) external {
        Chain storage chain = chains[genesisHash];
        if (!chain.initialized) revert ChainNotRegistered();

        for (uint256 i = 0; i < newHeaders.length; i++) {
            CsdBlockHeader calldata h = newHeaders[i];

            bytes32 blockHash = _csdHeaderHash(h);
            if (headers[blockHash].exists) revert HeaderAlreadyKnown();

            StoredHeader storage parent = headers[h.prev];
            if (!parent.exists) revert ParentUnknown();
            if (headerGenesisHash[h.prev] != genesisHash) revert HeaderPrevMismatch();

            uint256 target = _bitsToTarget(h.bits);
            if (target > chain.maxTarget) revert TargetTooEasy();

            if (uint256(blockHash) > target) revert HeaderInsufficientPoW();

            uint256 work = _workFromTarget(target);
            uint256 height = parent.height + 1;
            uint256 chainWork = parent.chainWork + work;

            headers[blockHash] = StoredHeader({
                exists: true,
                parent: h.prev,
                height: height,
                target: target,
                chainWork: chainWork
            });

            headerGenesisHash[blockHash] = genesisHash;

            emit HeaderSubmitted(
                genesisHash,
                blockHash,
                h.prev,
                height,
                chainWork
            );

            if (chainWork > chain.bestChainWork) {
                chain.bestTip = blockHash;
                chain.bestHeight = height;
                chain.bestChainWork = chainWork;

                emit BestTipUpdated(
                    genesisHash,
                    blockHash,
                    height,
                    chainWork
                );
            }
        }
    }

    function isConfirmed(
        bytes32 blockHash,
        bytes32 genesisHash,
        uint256 minConfirmations
    ) external view returns (bool) {
        Chain storage chain = chains[genesisHash];
        if (!chain.initialized) return false;

        StoredHeader storage target = headers[blockHash];
        if (!target.exists) return false;
        if (headerGenesisHash[blockHash] != genesisHash) return false;

        uint256 required = minConfirmations == 0 ? 1 : minConfirmations;

        if (chain.bestHeight < target.height) return false;

        uint256 confirmations = chain.bestHeight - target.height + 1;
        if (confirmations < required) return false;

        uint256 distance = chain.bestHeight - target.height;
        if (distance > maxAncestorDepth) return false;

        bytes32 cursor = chain.bestTip;

        for (uint256 i = 0; i < distance; i++) {
            cursor = headers[cursor].parent;
        }

        return cursor == blockHash;
    }

    function blockHeight(bytes32 blockHash) external view returns (uint256) {
        return headers[blockHash].height;
    }

    function blockChainWork(bytes32 blockHash) external view returns (uint256) {
        return headers[blockHash].chainWork;
    }

    function bestTip(bytes32 genesisHash) external view returns (bytes32) {
        return chains[genesisHash].bestTip;
    }

    function bestHeight(bytes32 genesisHash) external view returns (uint256) {
        return chains[genesisHash].bestHeight;
    }

    function bestChainWork(bytes32 genesisHash) external view returns (uint256) {
        return chains[genesisHash].bestChainWork;
    }

    function _workFromTarget(uint256 target) internal pure returns (uint256) {
        if (target == 0 || target == type(uint256).max) revert BitsInvalid();
        return (type(uint256).max / (target + 1)) + 1;
    }

    function _bitsToTarget(uint32 bits) internal pure returns (uint256) {
        uint256 exp  = bits >> 24;
        uint256 mant = bits & 0xFFFFFF;

        if (exp == 0 || exp > 32 || mant == 0) revert BitsInvalid();

        uint256 target = exp > 3
            ? mant << (8 * (exp - 3))
            : mant >> (8 * (3 - exp));

        if (target == 0 || target == type(uint256).max) revert BitsInvalid();

        return target;
    }

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

    function _u32LE(uint32 v) internal pure returns (bytes4) {
        return bytes4(abi.encodePacked(
            uint8(v),
            uint8(v >> 8),
            uint8(v >> 16),
            uint8(v >> 24)
        ));
    }

    function _u64LE(uint64 v) internal pure returns (bytes8) {
        return bytes8(abi.encodePacked(
            uint8(v),
            uint8(v >> 8),
            uint8(v >> 16),
            uint8(v >> 24),
            uint8(v >> 32),
            uint8(v >> 40),
            uint8(v >> 48),
            uint8(v >> 56)
        ));
    }
}
