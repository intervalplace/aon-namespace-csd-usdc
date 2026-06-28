// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;


interface IERC20TransferFrom {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract CsdUsdcSettlement {

bytes32 public constant CSD_USDC_AUTH_TYPEHASH = keccak256(
    "CsdUsdcAuthorization(address buyer,address sellerUsdcRecipient,bytes32 sellerCsdScriptHash,bytes32 csdGenesisHash,bytes32 tradeIntentHash,uint256 csdAmount,address usdc,uint256 usdcAmount,uint256 minConfirmations,uint256 executorFeeAmount,uint64 validAfter,uint64 validBefore,bytes32 nonce)"
);

    bytes32 private immutable DOMAIN_SEPARATOR;

    mapping(bytes32 => bool) public finalizedAuthorization;
mapping(bytes32 => bool) public consumedCsdTx;

mapping(bytes32 => bool) public usdcLocked;

mapping(bytes32 => uint256) public lockedUntil;

mapping(bytes32 => uint256) public lockedAmount;

uint256 public constant SETTLEMENT_LOCK_SECONDS = 20 minutes;

    struct CsdUsdcAuthorization {
        address buyer;
        address sellerUsdcRecipient;
        bytes32 sellerCsdScriptHash;
        bytes32 csdGenesisHash;
        bytes32 tradeIntentHash;
        uint256 csdAmount;
        address usdc;
        uint256 usdcAmount;
        uint256 minConfirmations;
        uint256 executorFeeAmount;
        uint64 validAfter;
        uint64 validBefore;
        bytes32 nonce;
    }

struct CsdPaymentProofAttestation {
    bytes32 csdTxid;
    bytes32 csdGenesisHash;
    bytes32 sellerCsdScriptHash;
    bytes32 tradeIntentHash;
    uint256 csdAmount;
    uint256 confirmations;
    bytes32 blockHash;
    uint256 blockHeight;
}

    event CsdUsdcSettled(
        bytes32 indexed authHash,
        bytes32 indexed csdTxid,
        address indexed buyer,
        address sellerUsdcRecipient,
        address usdc,
        uint256 usdcAmount,
        uint256 csdAmount,
        uint256 confirmations,
        bytes32 blockHash,
        uint256 blockHeight
    );

    event CsdUsdcAuthorizationFinalized(bytes32 indexed authHash, bytes32 indexed csdTxid);

event CsdUsdcAuthorizationLocked(bytes32 indexed authHash, uint256 lockedUntil);

error AuthorizationLocked(bytes32 authHash, uint256 lockedUntil);
error AuthorizationNotLocked(bytes32 authHash);

    error UnauthorizedExecutor();
    error BadSignature();
    error AuthorizationRevoked(bytes32 authHash);
    error AuthorizationExpired(bytes32 authHash);
    error AuthorizationAlreadyFinalized(bytes32 authHash);
    error InvalidProofAttestation();
    error InsufficientConfirmations();
    error TransferFailed();
    error CsdTxAlreadyConsumed(bytes32 csdTxid);
    error InvalidExecutorFee();
   
constructor() {

    DOMAIN_SEPARATOR = keccak256(

        abi.encode(

            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),

            keccak256(bytes("AON CSD/USDC")),

            keccak256(bytes("2")),

            block.chainid,

            address(this)

        )

    );

}

    function domainSeparator() external view returns (bytes32) {
        return DOMAIN_SEPARATOR;
    }

    function hashCsdUsdcAuthorization(
        CsdUsdcAuthorization memory auth
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
abi.encode(
    CSD_USDC_AUTH_TYPEHASH,
    auth.buyer,
    auth.sellerUsdcRecipient,
    auth.sellerCsdScriptHash,
    auth.csdGenesisHash,
    auth.tradeIntentHash,
    auth.csdAmount,
    auth.usdc,
    auth.usdcAmount,
    auth.minConfirmations,
    auth.executorFeeAmount,
    auth.validAfter,
    auth.validBefore,
    auth.nonce
)
        );

        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

function lockCsdUsdcAuthorization(
    CsdUsdcAuthorization calldata auth,
    bytes calldata authSig
) external {

    bytes32 authHash = hashCsdUsdcAuthorization(auth);

if (usdcLocked[authHash]) revert AuthorizationLocked(authHash, lockedUntil[authHash]);

    if (finalizedAuthorization[authHash]) revert AuthorizationAlreadyFinalized(authHash);
    if (block.timestamp < auth.validAfter || block.timestamp > auth.validBefore) {
        revert AuthorizationExpired(authHash);
    }

    if (_recover(authHash, authSig) != auth.buyer) revert BadSignature();


uint256 lockAmount = auth.usdcAmount;

if (auth.executorFeeAmount > 0) {
        revert InvalidExecutorFee();
    }

    lockAmount += auth.executorFeeAmount;
}

if (!IERC20(auth.usdc).transferFrom(
    auth.buyer,
    address(this),
    lockAmount
)) {
    revert TransferFailed();
}

lockedAmount[authHash] = lockAmount;

usdcLocked[authHash] = true;



  
    uint256 until = block.timestamp + SETTLEMENT_LOCK_SECONDS;

    if (until > auth.validBefore) {
        until = auth.validBefore;
    }

    lockedUntil[authHash] = until;

    emit CsdUsdcAuthorizationLocked(authHash, until);
}

function lockedBalance(
    bytes32 authHash
)
    external
    view
    returns (uint256)
{
    return lockedAmount[authHash];
}

function refundExpiredLock(
    CsdUsdcAuthorization calldata auth
) external {
    bytes32 authHash = hashCsdUsdcAuthorization(auth);

    if (finalizedAuthorization[authHash]) revert AuthorizationAlreadyFinalized(authHash);
    if (!usdcLocked[authHash]) revert AuthorizationNotLocked(authHash);
    if (block.timestamp <= lockedUntil[authHash]) revert AuthorizationLocked(authHash, lockedUntil[authHash]);

uint256 amount = lockedAmount[authHash];

lockedAmount[authHash] = 0;
usdcLocked[authHash] = false;
lockedUntil[authHash] = 0;


if (!IERC20(auth.usdc).transfer(auth.buyer, amount)) {
        revert TransferFailed();
    }
}

    function settleCsdUsdc(
        CsdUsdcAuthorization calldata auth,
        bytes calldata authSig,
        CsdPaymentProofAttestation calldata proof
    ) external {

        bytes32 authHash = hashCsdUsdcAuthorization(auth);

        if (finalizedAuthorization[authHash]) revert AuthorizationAlreadyFinalized(authHash);

bool isLocked = lockedUntil[authHash] >= block.timestamp;

if (!isLocked) {
    revert AuthorizationNotLocked(authHash);
}

if (block.timestamp < auth.validAfter || block.timestamp > auth.validBefore) {
    revert AuthorizationExpired(authHash);
}

if (_recover(authHash, authSig) != auth.buyer) {
    revert BadSignature();
}

if (proof.csdGenesisHash != auth.csdGenesisHash) {
    revert InvalidProofAttestation();
}

if (proof.tradeIntentHash != auth.tradeIntentHash) {
    revert InvalidProofAttestation();
}

if (proof.sellerCsdScriptHash != auth.sellerCsdScriptHash) {
    revert InvalidProofAttestation();
}

if (proof.csdAmount < auth.csdAmount) {
    revert InvalidProofAttestation();
}

if (proof.confirmations < auth.minConfirmations) {
    revert InsufficientConfirmations();
}

if (consumedCsdTx[proof.csdTxid]) {
    revert CsdTxAlreadyConsumed(proof.csdTxid);
}

if (!usdcLocked[authHash]) {
    revert AuthorizationNotLocked(authHash);
}

uint256 amount = lockedAmount[authHash];

uint256 sellerAmount = auth.usdcAmount;
uint256 feeAmount = auth.executorFeeAmount;
uint256 totalAmount = sellerAmount + feeAmount;

if (amount < totalAmount) {
    revert TransferFailed();
}

consumedCsdTx[proof.csdTxid] = true;
finalizedAuthorization[authHash] = true;

lockedAmount[authHash] = 0;
usdcLocked[authHash] = false;
lockedUntil[authHash] = 0;

if (!IERC20(auth.usdc).transfer(auth.sellerUsdcRecipient, sellerAmount)) {
    revert TransferFailed();
}

if (feeAmount > 0) {
    if (!IERC20(auth.usdc).transfer(msg.sender, feeAmount)) {
        revert TransferFailed();
    }
}

emit CsdUsdcAuthorizationFinalized(authHash, proof.csdTxid);

        emit CsdUsdcSettled(
            authHash,
            proof.csdTxid,
            auth.buyer,
            auth.sellerUsdcRecipient,
            auth.usdc,
            auth.usdcAmount,
            auth.csdAmount,
            proof.confirmations,
            proof.blockHash,
            proof.blockHeight
        );
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;

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
