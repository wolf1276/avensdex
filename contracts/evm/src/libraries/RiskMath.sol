// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AssetUnits as U} from "./AssetUnits.sol";

/// @notice Stateless bilateral risk/rounding rules from NEARFlow math.rs and trading.rs.
/// @dev Pair is an input snapshot, never an alternate custody ledger. Settle funding before splitting.
library RiskMath {
    struct Pair {
        uint128 size6;
        uint128 entryPrice18;
        uint128 longMargin6;
        uint128 shortMargin6;
        int128 lastFundingIndex18;
        int128 fundingRemainder;
    }

    error InvalidPair();
    error InvalidPrice();
    error InvalidCloseSize();
    error InvalidMaintenance();
    error SignedOverflow();

    function validate(Pair memory p) internal pure {
        if (
            p.size6 == 0 || uint256(p.longMargin6) + p.shortMargin6 > uint128(type(int128).max)
                || p.fundingRemainder <= -int256(U.PRICE_SCALE) || p.fundingRemainder >= int256(U.PRICE_SCALE)
        ) {
            revert InvalidPair();
        }
        checkPrice(p.entryPrice18);
    }

    function checkPrice(uint128 price18) private pure {
        if (price18 == 0 || price18 > U.MAX_PRICE) revert InvalidPrice();
    }

    function notional6(uint128 size6, uint128 price18) internal pure returns (uint128) {
        checkPrice(price18);
        return U.mulDiv(size6, price18, uint128(U.PRICE_SCALE));
    }

    function signedAmount6(uint128 size6, int256 delta18) internal pure returns (int128) {
        if (delta18 < type(int128).min || delta18 > type(int128).max) revert SignedOverflow();
        uint128 magnitude = uint128(uint256(delta18 < 0 ? -delta18 : delta18));
        uint128 amount = U.mulDiv(size6, magnitude, uint128(U.PRICE_SCALE));
        if (amount > uint128(type(int128).max)) revert SignedOverflow();
        return delta18 < 0 ? -int128(amount) : int128(amount);
    }

    function payout(Pair memory p, uint128 price18)
        internal
        pure
        returns (uint128 longPayout6, uint128 shortPayout6, int128 pnl6)
    {
        validate(p);
        checkPrice(price18);
        int256 pnl = signedAmount6(p.size6, int256(uint256(price18)) - int256(uint256(p.entryPrice18)));
        pnl = clamp(pnl, -int256(uint256(p.longMargin6)), int256(uint256(p.shortMargin6)));
        return (
            uint128(uint256(int256(uint256(p.longMargin6)) + pnl)),
            uint128(uint256(int256(uint256(p.shortMargin6)) - pnl)),
            int128(pnl)
        );
    }

    function fundingSettlement(Pair memory p, int128 index18)
        internal
        pure
        returns (int128 payment6, int128 remainder)
    {
        validate(p);
        int256 delta = int256(index18) - p.lastFundingIndex18;
        if (delta < type(int128).min || delta > type(int128).max) revert SignedOverflow();
        signedAmount6(p.size6, delta); // Preserve the source's pre-remainder signed conversion bound.
        // u128 size times i128 delta plus a sub-1e18 remainder fits signed 256 bits.
        int256 numerator = int256(uint256(p.size6)) * delta + p.fundingRemainder;
        int256 owed = numerator / int256(U.PRICE_SCALE);
        if (owed < -int256(type(int128).max) || owed > type(int128).max) revert SignedOverflow();
        int256 paid = clamp(owed, -int256(uint256(p.shortMargin6)), int256(uint256(p.longMargin6)));
        return (int128(paid), paid == owed ? int128(numerator % int256(U.PRICE_SCALE)) : int128(0));
    }

    function split(Pair memory p, uint128 amount6) internal pure returns (Pair memory part, Pair memory remaining) {
        validate(p);
        if (amount6 == 0 || amount6 > p.size6) revert InvalidCloseSize();
        part = Pair(
            amount6,
            p.entryPrice18,
            U.mulDiv(p.longMargin6, amount6, p.size6),
            U.mulDiv(p.shortMargin6, amount6, p.size6),
            p.lastFundingIndex18,
            0
        );
        remaining = Pair(
            p.size6 - amount6,
            p.entryPrice18,
            p.longMargin6 - part.longMargin6,
            p.shortMargin6 - part.shortMargin6,
            p.lastFundingIndex18,
            int128(int256(p.fundingRemainder) * int256(uint256(p.size6 - amount6)) / int256(uint256(p.size6)))
        );
    }

    function liquidatable(Pair memory p, uint128 price18, uint16 maintenanceBps)
        internal
        pure
        returns (bool longUnsafe, bool shortUnsafe)
    {
        checkMaintenance(maintenanceBps);
        (uint128 longEquity, uint128 shortEquity,) = payout(p, price18);
        uint128 maintenance = U.mulDiv(notional6(p.size6, price18), maintenanceBps, 10_000);
        if (maintenance == 0) maintenance = 1;
        return (longEquity <= maintenance, shortEquity <= maintenance);
    }

    /// @dev Informational threshold only. Actual liquidation uses fresh equity via liquidatable().
    function liquidationPrice18(Pair memory p, uint16 maintenanceBps, bool isLong) internal pure returns (uint128) {
        validate(p);
        checkMaintenance(maintenanceBps);
        uint128 entry = notional6(p.size6, p.entryPrice18);
        uint256 numerator =
            isLong ? (entry > p.longMargin6 ? entry - p.longMargin6 : 0) : uint256(entry) + p.shortMargin6;
        uint256 factor = isLong ? 10_000 - maintenanceBps : 10_000 + uint256(maintenanceBps);
        uint256 result = numerator * U.PRICE_SCALE * 10_000 / (uint256(p.size6) * factor);
        if (result > type(uint128).max) revert U.AmountOverflow();
        return uint128(result);
    }

    function openingFee6(uint128 notional) internal pure returns (uint128) {
        return uint128(U.ceilDiv(uint256(notional) * 3, 10_000));
    }

    function checkMaintenance(uint16 bps) private pure {
        if (bps == 0 || bps >= 10_000) revert InvalidMaintenance();
    }

    function clamp(int256 value, int256 low, int256 high) private pure returns (int256) {
        return value < low ? low : value > high ? high : value;
    }
}
