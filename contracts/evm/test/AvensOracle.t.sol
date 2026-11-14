// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AvensOracle} from "../src/AvensOracle.sol";
import {ProtocolTypes as T} from "../src/interfaces/ProtocolTypes.sol";

interface VmAvensOracle {
    function chainId(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
}

contract AvensOracleTest {
    VmAvensOracle constant vm = VmAvensOracle(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant PRICE = address(0xFEED);
    address constant FUNDING = address(0xF00D);
    AvensOracle oracle;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1000);
        oracle = new AvensOracle(1, PRICE, FUNDING, 60);
        _publish(100e18);
    }

    function _publish(uint128 price18) private {
        vm.prank(PRICE);
        oracle.publishPrice(price18, uint64(block.timestamp));
    }

    function _rate(int128 rate, uint64 duration) private {
        vm.prank(FUNDING);
        oracle.setFundingRate(rate, uint64(block.timestamp) + duration);
    }

    function testIndependentAuthorityAndConfiguration() public {
        vm.expectRevert();
        new AvensOracle(1, PRICE, PRICE, 60);
        vm.expectRevert();
        new AvensOracle(1, address(this), FUNDING, 60);
        vm.expectRevert();
        new AvensOracle(0, PRICE, FUNDING, 60);
        vm.expectRevert();
        new AvensOracle(1, PRICE, FUNDING, 3601);
        vm.expectRevert();
        oracle.publishPrice(1e18, 1000);
        vm.prank(PRICE);
        vm.expectRevert();
        oracle.setFundingRate(0, 1060);
        vm.prank(FUNDING);
        vm.expectRevert();
        oracle.publishPrice(1e18, 1000);
        vm.chainId(43114);
        vm.expectRevert();
        new AvensOracle(1, PRICE, FUNDING, 60);
    }

    function testFujiCannotPublishAndChainChangeCannotReuseData() public {
        vm.chainId(43113);
        AvensOracle fuji = new AvensOracle(1, PRICE, FUNDING, 60);
        vm.prank(PRICE);
        vm.expectRevert();
        fuji.publishPrice(100e18, 1000);
        vm.prank(FUNDING);
        vm.expectRevert();
        fuji.setFundingRate(0, 1060);
        vm.expectRevert();
        oracle.price(1);
    }

    function testSourceFreshnessFutureRollbackAndMarketBounds() public {
        T.Price memory p = oracle.price(1);
        require(p.price18 == 100e18 && p.sourceTimestamp == 1000);
        vm.prank(PRICE);
        vm.expectRevert();
        oracle.publishPrice(100e18, 1001);
        vm.prank(PRICE);
        vm.expectRevert();
        oracle.publishPrice(100e18, 999);
        vm.prank(PRICE);
        vm.expectRevert();
        oracle.publishPrice(0, 1000);
        vm.expectRevert();
        oracle.price(2);
        vm.warp(1060);
        require(oracle.price(1).sourceTimestamp == 1000);
        vm.warp(1061);
        vm.expectRevert();
        oracle.price(1);
        vm.prank(PRICE);
        vm.expectRevert();
        oracle.publishPrice(100e18, 1000);
        _publish(101e18);
        require(oracle.price(1).sourceTimestamp == 1061);
    }

    function testRateBoundsExpiryAndInitialization() public {
        vm.expectRevert();
        oracle.fundingIndex(1);
        vm.prank(FUNDING);
        vm.expectRevert();
        oracle.setFundingRate(1e18, 1060);
        vm.prank(FUNDING);
        vm.expectRevert();
        oracle.setFundingRate(type(int128).min, 1060);
        vm.prank(FUNDING);
        vm.expectRevert();
        oracle.setFundingRate(0, 1000);
        vm.prank(FUNDING);
        vm.expectRevert();
        oracle.setFundingRate(0, 4601);
        _rate(0, 60);
        (int128 index, uint64 validUntil) = oracle.fundingIndex(1);
        require(index == 0 && validUntil == 1060);
        vm.warp(1060);
        oracle.fundingIndex(1);
        vm.warp(1061);
        _publish(100e18);
        (index, validUntil) = oracle.fundingIndex(1);
        require(index == 0 && validUntil == 1060);
    }

    function testNonzeroTerminalIndexFreezesAndRenewalDoesNotBackfill() public {
        _rate(1e12, 10);
        vm.warp(1020);
        (int128 index, uint64 expiry) = oracle.fundingIndex(1);
        require(index == 10e12 && expiry == 1010);
        vm.warp(1050);
        (index,) = oracle.fundingIndex(1);
        require(index == 10e12);
        _rate(0, 10);
        (index, expiry) = oracle.fundingIndex(1);
        require(index == 10e12 && expiry == 1060);
    }

    function testCheckpointsSignReversalAndExpiredGapWithoutBackfill() public {
        _rate(1e12, 10);
        vm.warp(1005);
        (int128 index,) = oracle.fundingIndex(1);
        require(index == 5e12);
        _rate(-1e12, 5);
        vm.warp(1010);
        (index,) = oracle.fundingIndex(1);
        require(index == 0);
        vm.warp(1100);
        _publish(100e18);
        _rate(1e12, 20);
        (index,) = oracle.fundingIndex(1);
        require(index == 0); // The 90-second expired interval is not silently backfilled.
        vm.warp(1110);
        (index,) = oracle.fundingIndex(1);
        require(index == 10e12);
        _rate(0, 20);
        (index,) = oracle.fundingIndex(1);
        require(index == 10e12);
    }

    function testFuzzRateCheckpointConservation(int64 rawRate, uint8 rawDuration) public {
        int128 rate = int128(rawRate % int64(1e12));
        uint64 duration = uint64(rawDuration % 59 + 1);
        _rate(rate, duration);
        vm.warp(1000 + duration);
        (int128 index,) = oracle.fundingIndex(1);
        require(index == rate * int128(uint128(duration)));
        _rate(-rate, duration);
        vm.warp(1000 + duration * 2);
        _publish(100e18);
        (index,) = oracle.fundingIndex(1);
        require(index == 0);
    }
}
