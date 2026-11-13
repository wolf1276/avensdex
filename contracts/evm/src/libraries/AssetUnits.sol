// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @notice Order sizes/collateral use six decimals; raw inventory uses verified token decimals.
library AssetUnits {
    uint256 internal constant SIZE_SCALE = 1e6;
    uint256 internal constant PRICE_SCALE = 1e18;
    uint256 internal constant MAX_PRICE = 1e27;

    error InvalidDecimals();
    error AmountOverflow();
    error ZeroDivisor();

    function rawFactor(uint8 decimals) internal pure returns (uint256) {
        if (decimals < 6 || decimals > 24) revert InvalidDecimals();
        return 10 ** (decimals - 6);
    }

    function toRawBase(uint128 size6, uint8 decimals) internal pure returns (uint256) {
        return uint256(size6) * rawFactor(decimals);
    }

    function fromRawBase(uint256 raw, uint8 decimals) internal pure returns (uint128 size6, uint256 dust) {
        uint256 factor = rawFactor(decimals);
        uint256 size = raw / factor;
        if (size > type(uint128).max) revert AmountOverflow();
        return (uint128(size), raw % factor);
    }

    // Both operands are u128: their product fits u256 without intermediate truncation.
    function mulDiv(uint128 a, uint128 b, uint128 divisor) internal pure returns (uint128) {
        if (divisor == 0) revert ZeroDivisor();
        uint256 result = uint256(a) * b / divisor;
        if (result > type(uint128).max) revert AmountOverflow();
        return uint128(result);
    }

    function ceilDiv(uint256 a, uint256 divisor) internal pure returns (uint256) {
        if (divisor == 0) revert ZeroDivisor();
        return a / divisor + (a % divisor == 0 ? 0 : 1);
    }
}
