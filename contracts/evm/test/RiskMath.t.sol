// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import {AssetUnits as U} from "../src/libraries/AssetUnits.sol";
import {RiskMath as R} from "../src/libraries/RiskMath.sol";
import {Vm} from "./TestVm.sol";

contract RiskMathTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function pair() private pure returns (R.Pair memory) {
        return R.Pair(10_000, 100e18, 10_000_000, 10_000_000, 0, 0);
    }

    function raw(uint256 amount, uint8 decimals) external pure returns (uint128, uint256) {
        return U.fromRawBase(amount, decimals);
    }

    function toRaw(uint128 size, uint8 decimals) external pure returns (uint256) {
        return U.toRawBase(size, decimals);
    }

    function mulDiv(uint128 a, uint128 b, uint128 d) external pure returns (uint128) {
        return U.mulDiv(a, b, d);
    }

    function pay(R.Pair memory p, uint128 price) external pure {
        R.payout(p, price);
    }

    function fund(R.Pair memory p, int128 index) external pure {
        R.fundingSettlement(p, index);
    }

    function split(R.Pair memory p, uint128 amount) external pure {
        R.split(p, amount);
    }

    function signed(uint128 size, int256 delta) external pure {
        R.signedAmount6(size, delta);
    }

    function risk(R.Pair memory p, uint16 bps) external pure {
        R.liquidatable(p, 100e18, bps);
    }

    function testSourceAccountingVectors() public view {
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/../../packages/protocol/accounting-vectors.json"));
        uint256 count;
        for (; count < 64; count++) {
            string memory prefix = string.concat("$[", vm.toString(count), "]");
            if (!vm.keyExistsJson(json, prefix)) break;
            R.Pair memory p = R.Pair(
                unsignedValue(json, prefix, "size"),
                unsignedValue(json, prefix, "entry"),
                unsignedValue(json, prefix, "longMargin"),
                unsignedValue(json, prefix, "shortMargin"),
                int128(value(json, prefix, "checkpoint")),
                int128(value(json, prefix, "remainder"))
            );
            (int128 payment, int128 remainder) = R.fundingSettlement(p, int128(value(json, prefix, "index")));
            require(payment == value(json, prefix, "payment"), "payment mismatch");
            require(remainder == value(json, prefix, "nextRemainder"), "remainder mismatch");
            p.longMargin6 = uint128(uint256(int256(uint256(p.longMargin6)) - payment));
            p.shortMargin6 = uint128(uint256(int256(uint256(p.shortMargin6)) + payment));
            (uint128 longPayout, uint128 shortPayout,) = R.payout(p, unsignedValue(json, prefix, "price"));
            require(longPayout == uint256(value(json, prefix, "longPayout")), "long payout mismatch");
            require(shortPayout == uint256(value(json, prefix, "shortPayout")), "short payout mismatch");
        }
        require(count > 0 && count < 64);
    }

    function unsignedValue(string memory json, string memory prefix, string memory key) private pure returns (uint128) {
        int256 n = value(json, prefix, key);
        require(n >= 0 && uint256(n) <= type(uint128).max, "invalid unsigned fixture");
        return uint128(uint256(n));
    }

    function value(string memory json, string memory prefix, string memory key) private pure returns (int256) {
        return vm.parseInt(vm.parseJsonString(json, string.concat(prefix, ".", key)));
    }

    function testPrecisionAndWideProducts() public {
        uint8[4] memory decimals = [uint8(6), 8, 18, 24];
        for (uint256 i; i < decimals.length; i++) {
            uint256 factor = U.rawFactor(decimals[i]);
            uint256 amount = U.toRawBase(1_000_000, decimals[i]);
            (uint128 size, uint256 dust) = U.fromRawBase(amount + factor - 1, decimals[i]);
            require(size == 1_000_000 && dust == factor - 1);
        }
        require(U.toRawBase(1_000_000, 18) == 1e18);
        require(U.mulDiv(type(uint128).max, type(uint128).max, type(uint128).max) == type(uint128).max);
        require(R.signedAmount6(1, -1e18 + 1) == 0);
        require(R.openingFee6(1) == 1 && R.openingFee6(10_000) == 3);
        vm.expectRevert(U.InvalidDecimals.selector);
        this.toRaw(1, 5);
        vm.expectRevert(U.InvalidDecimals.selector);
        this.toRaw(1, 25);
        vm.expectRevert(U.AmountOverflow.selector);
        this.raw(uint256(type(uint128).max) + 1, 6);
        vm.expectRevert(U.AmountOverflow.selector);
        this.mulDiv(type(uint128).max, type(uint128).max, 1);
        vm.expectRevert(U.ZeroDivisor.selector);
        this.mulDiv(1, 1, 0);
    }

    function testFractionalFundingReversalAndReplay() public pure {
        R.Pair memory p = pair();
        for (int128 n = 1; n <= 100; n++) {
            p = settle(p, n * 1_000_000_000_000);
            (int128 payment, int128 remainder) = R.fundingSettlement(p, p.lastFundingIndex18);
            require(payment == 0 && remainder == p.fundingRemainder, "funding replay");
        }
        require(p.longMargin6 == 9_999_999 && p.shortMargin6 == 10_000_001 && p.fundingRemainder == 0);
        p = settle(p, 50_000_000_000_000);
        p = settle(p, 0);
        require(p.longMargin6 == 10_000_000 && p.shortMargin6 == 10_000_000 && p.fundingRemainder == 0);
    }

    function testSplitAndLiquidation() public {
        R.Pair memory p = R.Pair(3, 100e18, 10, 11, 0, -10);
        (R.Pair memory part, R.Pair memory left) = R.split(p, 1);
        require(part.longMargin6 == 3 && part.shortMargin6 == 3);
        require(left.longMargin6 == 7 && left.shortMargin6 == 8 && left.fundingRemainder == -6);
        (, left) = R.split(p, 3);
        require(left.size6 == 0 && left.longMargin6 == 0 && left.shortMargin6 == 0 && left.fundingRemainder == 0);
        vm.expectRevert(R.InvalidCloseSize.selector);
        this.split(p, 0);
        vm.expectRevert(R.InvalidCloseSize.selector);
        this.split(p, 4);
        p = pair();
        p.size6 = 1_000_000;
        (bool longUnsafe, bool shortUnsafe) = R.liquidatable(p, 100e18, 500);
        require(!longUnsafe && !shortUnsafe);
        (longUnsafe, shortUnsafe) = R.liquidatable(p, 90e18, 500);
        require(longUnsafe && !shortUnsafe);
        require(R.liquidationPrice18(p, 500, true) == uint256(90e18) * 10_000 / 9500);
        require(R.liquidationPrice18(p, 500, false) == uint256(110e18) * 10_000 / 10500);
    }

    function testFuzzConservation(
        uint64 size,
        uint64 longMargin,
        uint64 shortMargin,
        int64 delta,
        uint64 price,
        uint64 amount
    ) public pure {
        R.Pair memory p = R.Pair(uint128(size) + 1, 100e18, longMargin, shortMargin, 0, 0);
        uint256 total = uint256(longMargin) + shortMargin;
        p = settle(p, delta);
        require(uint256(p.longMargin6) + p.shortMargin6 == total);
        (uint128 a, uint128 b,) = R.payout(p, uint128(price) % 1e27 + 1);
        require(uint256(a) + b == total);
        (R.Pair memory part, R.Pair memory left) = R.split(p, uint128(amount) % p.size6 + 1);
        require(uint256(part.longMargin6) + left.longMargin6 == p.longMargin6);
        require(uint256(part.shortMargin6) + left.shortMargin6 == p.shortMargin6);
    }

    function testFuzzRawDust(uint128 size, uint8 precision, uint64 extra) public pure {
        uint8 decimals = precision % 19 + 6;
        uint256 factor = U.rawFactor(decimals);
        uint256 dust = uint256(extra) % factor;
        (uint128 actual, uint256 residual) = U.fromRawBase(U.toRawBase(size, decimals) + dust, decimals);
        require(actual == size && residual == dust);
    }

    function testRejectsInvalidRiskInputs() public {
        R.Pair memory p = pair();
        p.size6 = 0;
        vm.expectRevert(R.InvalidPair.selector);
        this.pay(p, 100e18);
        p = pair();
        vm.expectRevert(R.InvalidPrice.selector);
        this.pay(p, 0);
        vm.expectRevert(R.InvalidPrice.selector);
        this.pay(p, 1e27 + 1);
        p.fundingRemainder = 1e18;
        vm.expectRevert(R.InvalidPair.selector);
        this.pay(p, 100e18);
        p = pair();
        p.longMargin6 = uint128(type(int128).max);
        vm.expectRevert(R.InvalidPair.selector);
        this.pay(p, 100e18);
        p = pair();
        p.lastFundingIndex18 = type(int128).min;
        vm.expectRevert(R.SignedOverflow.selector);
        this.fund(p, type(int128).max);
        vm.expectRevert(R.SignedOverflow.selector);
        this.signed(1e18 + 1, type(int128).max);
        vm.expectRevert(U.AmountOverflow.selector);
        this.signed(type(uint128).max, type(int128).max);
        vm.expectRevert(R.InvalidMaintenance.selector);
        this.risk(pair(), 0);
        vm.expectRevert(R.InvalidMaintenance.selector);
        this.risk(pair(), 10_000);
    }

    function settle(R.Pair memory p, int128 index) private pure returns (R.Pair memory) {
        (int128 payment, int128 remainder) = R.fundingSettlement(p, index);
        p.longMargin6 = uint128(uint256(int256(uint256(p.longMargin6)) - payment));
        p.shortMargin6 = uint128(uint256(int256(uint256(p.shortMargin6)) + payment));
        p.lastFundingIndex18 = index;
        p.fundingRemainder = remainder;
        return p;
    }
}
