// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @notice Shared manual-order schema only; not a settlement contract or deployment gate.
library ClobAuth {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant ORDER_TYPEHASH = keccak256(
        "Order(address trader,uint32 marketId,uint8 side,uint8 kind,uint128 size6,uint128 limitPrice18,uint32 leverage,uint16 maxFeeBps,uint64 nonce,uint64 expiry,bool reduceOnly,bool postOnly,bool ioc)"
    );
    bytes32 internal constant CANCEL_TYPEHASH =
        keccak256("Cancel(address trader,bytes32 orderHash,uint64 nonce,uint64 expiry)");
    uint256 internal constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct Order {
        address trader;
        uint32 marketId;
        uint8 side; // buy = 0, sell = 1
        uint8 kind; // limit = 0, price-bounded IOC market = 1
        uint128 size6;
        uint128 limitPrice18;
        uint32 leverage;
        uint16 maxFeeBps;
        uint64 nonce;
        uint64 expiry;
        bool reduceOnly;
        bool postOnly;
        bool ioc;
    }

    struct Cancel {
        address trader;
        bytes32 orderHash;
        uint64 nonce; // The targeted order's nonce, not a generic withdrawal/call nonce.
        uint64 expiry;
    }

    error InvalidSignature();

    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Avensdex"), keccak256("1"), chainId, verifyingContract));
    }

    function orderDigest(bytes32 domain, Order memory order) internal pure returns (bytes32) {
        // All members are static ABI types; encoding the tuple is the EIP-712 member encoding.
        return keccak256(abi.encodePacked(hex"1901", domain, keccak256(abi.encode(ORDER_TYPEHASH, order))));
    }

    function cancelDigest(bytes32 domain, Cancel memory cancel) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domain, keccak256(abi.encode(CANCEL_TYPEHASH, cancel))));
    }

    function recover(bytes32 digest, bytes memory signature) internal pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (uint256(s) == 0 || uint256(s) > HALF_N || (v != 27 && v != 28)) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
