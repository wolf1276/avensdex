// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AvensFundingOracle} from "../src/AvensFundingOracle.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {ProtocolTypes as T} from "../src/interfaces/ProtocolTypes.sol";
import {FundingMath} from "../src/libraries/FundingMath.sol";

interface VmController {
    function chainId(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function etch(address, bytes calldata) external;
}

contract ControllerSource is IOracleAdapter {
    T.Price private observation;

    function set(uint128 value, uint64 at) external {
        observation = T.Price(value, at);
    }

    function price(uint32) external view returns (T.Price memory) {
        return observation;
    }

    function fundingIndex(uint32) external pure returns (int128, uint64) {
        revert();
    }
}

contract AvensFundingOracleTest {
    VmController constant vm = VmController(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant PUBLISHER = address(0xB0B);
    ControllerSource index;
    ControllerSource mark;
    AvensFundingOracle oracle;
    uint128 constant PRICE = 100e18;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(3599);
        index = new ControllerSource();
        mark = new ControllerSource();
        _observe(PRICE, 100.12e18);
        oracle = new AvensFundingOracle(index, mark, 1, PUBLISHER);
    }

    function _observe(uint128 indexPrice, uint128 markPrice) private {
        index.set(indexPrice, uint64(block.timestamp));
        mark.set(markPrice, uint64(block.timestamp));
    }

    function _publish() private {
        uint256 revision = oracle.revision();
        vm.prank(PUBLISHER);
        oracle.publish(revision, block.timestamp / 3600);
    }

    function testAuthenticatedObservedPremiumAndEpochReplay() public {
        vm.warp(3600);
        _observe(PRICE, 100.12e18);
        vm.expectRevert(AvensFundingOracle.Unauthorized.selector);
        oracle.publish(1, 1);
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidEpoch.selector);
        oracle.publish(1, 0);
        _publish();
        require(oracle.fundingRatePpm() == 220, "golden adaptive rate");
        require(oracle.premiumEma() == 1200 && oracle.lastEpoch() == 1, "observed premium");
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidEpoch.selector);
        oracle.publish(1, 1);
        require(oracle.price(1).price18 == PRICE, "mark must not become index");
    }

    function testNegativeRateAndExactFractionalAccrual() public {
        vm.warp(3600);
        _observe(PRICE + 17, (PRICE + 17) * 9988 / 10000);
        _publish();
        require(oracle.fundingRatePpm() < 0, "negative sign");
        int256 rate = oracle.fundingRatePpm();
        vm.warp(3607);
        oracle.checkpoint();
        int256 numerator = int256(uint256(PRICE + 17)) * rate * 7;
        require(oracle.checkpointIndex18() == numerator / 3_600_000_000, "index rounding");
        require(oracle.fundingRemainder() == numerator % 3_600_000_000, "signed remainder");
    }

    function testStaleMarkAndIndexFailAtomically() public {
        vm.warp(4000);
        index.set(PRICE, 4000);
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidObservation.selector);
        oracle.publish(1, 1);
        require(!oracle.hasLastEpoch(), "failed publish consumed epoch");
        _observe(PRICE, 100.12e18);
        index.set(PRICE, 3939);
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidObservation.selector);
        oracle.publish(1, 1);
        require(oracle.fundingRatePpm() == 0, "failed publish changed rate");
    }

    function testFutureZeroAndOutlierSignalsRejected() public {
        vm.warp(3600);
        index.set(PRICE, 3601);
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidObservation.selector);
        oracle.publish(1, 1);
        _observe(PRICE, 0);
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidObservation.selector);
        oracle.publish(1, 1);
        _observe(PRICE, 200e18);
        vm.prank(PUBLISHER);
        vm.expectRevert(FundingMath.SignalOutsideBounds.selector);
        oracle.publish(1, 1);
    }

    function testExpiryNoBackfillAndFreshPriceDoesNotRenewRate() public {
        vm.warp(3600);
        _observe(PRICE, 100.12e18);
        _publish();
        require(oracle.rateValidUntil() == 3660, "oracle bounds rate");
        vm.warp(3660);
        oracle.checkpoint();
        int128 terminal = oracle.checkpointIndex18();
        vm.warp(7200);
        _observe(PRICE, 100.12e18);
        (int128 indexBefore, uint64 expiry) = oracle.fundingIndex(1);
        require(indexBefore == terminal && expiry == 3660, "fresh price backfilled expired rate");
        _publish();
        require(oracle.checkpointIndex18() == terminal, "renewal backfilled gap");
        require(oracle.rateValidUntil() == 7260, "renewal expiry");
    }

    function testConfigurationAuthorityRevisionAndEpochConsumption() public {
        FundingMath.Params memory p = FundingMath.defaults();
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.Unauthorized.selector);
        oracle.configure(FundingMath.Mode.BASELINE, p, 1);
        vm.expectRevert(AvensFundingOracle.InvalidConfiguration.selector);
        oracle.configure(FundingMath.Mode.BASELINE, p, 2);
        vm.warp(3600);
        _observe(PRICE, 100.12e18);
        _publish();
        oracle.configure(FundingMath.Mode.BASELINE, p, 1);
        require(oracle.revision() == 2 && oracle.fundingRatePpm() == 0, "reset");
        require(!oracle.hasPremiumEma() && oracle.rateValidUntil() == 3600, "config activated rate");
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidEpoch.selector);
        oracle.publish(2, 1);
        vm.warp(7200);
        _observe(PRICE, 100.12e18);
        _publish();
        require(oracle.fundingRatePpm() == 1200, "baseline golden");
    }

    function testInvalidConfigurationRollsBackCheckpoint() public {
        vm.warp(3600);
        _observe(PRICE, 100.12e18);
        _publish();
        vm.warp(3610);
        FundingMath.Params memory p = FundingMath.defaults();
        p.cap_ppm = 2001;
        vm.expectRevert(FundingMath.InvalidParameters.selector);
        oracle.configure(FundingMath.Mode.BASELINE, p, 1);
        require(oracle.checkpointIndex18() == 0 && oracle.fundingUpdatedAt() == 3600, "partial config write");
    }

    function testChainMarketAndSourceCodeChecks() public {
        vm.expectRevert(AvensFundingOracle.Unavailable.selector);
        oracle.price(2);
        vm.chainId(43114);
        vm.expectRevert(AvensFundingOracle.Unavailable.selector);
        oracle.checkpoint();
        vm.expectRevert(AvensFundingOracle.Unavailable.selector);
        oracle.price(1);
        vm.chainId(31337);
        vm.etch(address(mark), hex"00");
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.SourceCodeChanged.selector);
        oracle.publish(1, 0);
        vm.etch(address(index), hex"00");
        vm.expectRevert(AvensFundingOracle.SourceCodeChanged.selector);
        oracle.price(1);
    }

    function testConstructorRejectsWrongChainAndIdentities() public {
        vm.expectRevert(AvensFundingOracle.InvalidConfiguration.selector);
        new AvensFundingOracle(index, index, 1, PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidConfiguration.selector);
        new AvensFundingOracle(index, mark, 1, address(this));
        vm.expectRevert(AvensFundingOracle.InvalidConfiguration.selector);
        new AvensFundingOracle(index, mark, 1, address(0));
        vm.expectRevert(AvensFundingOracle.InvalidConfiguration.selector);
        new AvensFundingOracle(IOracleAdapter(address(1)), mark, 1, PUBLISHER);
        vm.chainId(43114);
        vm.expectRevert(AvensFundingOracle.InvalidConfiguration.selector);
        new AvensFundingOracle(index, mark, 1, PUBLISHER);
    }

    function testFuzzCheckpointSplittingConservesRemainder(uint64 seed, bool negative) public {
        vm.warp(3600);
        uint128 value = PRICE + uint128(seed);
        _observe(value, negative ? value * 9988 / 10000 : value * 10012 / 10000);
        AvensFundingOracle other = new AvensFundingOracle(index, mark, 1, PUBLISHER);
        _publish();
        vm.prank(PUBLISHER);
        other.publish(1, 1);
        uint256 split = 1 + uint256(seed) % 59;
        vm.warp(3600 + split);
        oracle.checkpoint();
        vm.warp(3660);
        oracle.checkpoint();
        other.checkpoint();
        require(oracle.checkpointIndex18() == other.checkpointIndex18(), "split index");
        require(oracle.fundingRemainder() == other.fundingRemainder(), "split remainder");
    }

    function testRefreshKeepsEpochRateAndEmaWithoutReplayingObservations() public {
        vm.warp(3600);
        _observe(PRICE, 100.12e18);
        _publish();
        int256 rate = oracle.fundingRatePpm();
        int256 smoothed = oracle.premiumEma();
        vm.warp(3640);
        _observe(PRICE, 100.13e18);
        vm.prank(PUBLISHER);
        oracle.refreshObservations(1, 1);
        require(oracle.rateValidUntil() == 3700, "freshness not renewed");
        require(oracle.rateAppliedAt() == 3600 && oracle.lastEpoch() == 1, "rate horizon extended");
        require(oracle.fundingRatePpm() == rate && oracle.premiumEma() == smoothed, "epoch math repeated");
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidObservation.selector);
        oracle.refreshObservations(1, 1);
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidEpoch.selector);
        oracle.publish(1, 1);
    }

    function testRefreshAfterExpiryDoesNotBackfillGap() public {
        vm.warp(3600);
        _observe(PRICE, 100.12e18);
        _publish();
        vm.warp(3660);
        oracle.checkpoint();
        int128 terminal = oracle.checkpointIndex18();
        vm.warp(3800);
        _observe(PRICE + 17, 100.12e18);
        vm.prank(PUBLISHER);
        oracle.refreshObservations(1, 1);
        require(oracle.observedIndexPrice18() == PRICE + 17, "refreshed price missing");
        require(oracle.checkpointIndex18() == terminal && oracle.fundingUpdatedAt() == 3800, "gap backfilled");
        vm.warp(3810);
        oracle.checkpoint();
        int256 numerator = int256(uint256(PRICE) * 60 + uint256(PRICE + 17) * 10) * oracle.fundingRatePpm();
        require(oracle.checkpointIndex18() == numerator / 3_600_000_000, "fresh-window accrual");
        require(oracle.fundingRemainder() == numerator % 3_600_000_000, "refresh lost remainder");
    }

    function testRefreshAuthorityRevisionEpochAndConfigurationGuards() public {
        vm.expectRevert(AvensFundingOracle.Unauthorized.selector);
        oracle.refreshObservations(1, 0);
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidEpoch.selector);
        oracle.refreshObservations(1, 0);
        vm.warp(3600);
        _observe(PRICE, 100.12e18);
        _publish();
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidConfiguration.selector);
        oracle.refreshObservations(2, 1);
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidEpoch.selector);
        oracle.refreshObservations(1, 0);
        vm.warp(3601);
        _observe(PRICE, 100.12e18);
        oracle.configure(FundingMath.Mode.ADAPTIVE, FundingMath.defaults(), 1);
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidEpoch.selector);
        oracle.refreshObservations(2, 1);
        vm.warp(7200);
        _observe(PRICE, 100.12e18);
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidEpoch.selector);
        oracle.refreshObservations(2, 1);
    }

    function testRefreshRejectsUnadvancedFutureOutlierAndChangedSourcesAtomically() public {
        vm.warp(3600);
        _observe(PRICE, 100.12e18);
        _publish();
        vm.warp(3640);
        index.set(PRICE, 3640);
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidObservation.selector);
        oracle.refreshObservations(1, 1);
        index.set(PRICE, 3600);
        mark.set(100.12e18, 3640);
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidObservation.selector);
        oracle.refreshObservations(1, 1);
        _observe(PRICE, 200e18);
        vm.prank(PUBLISHER);
        vm.expectRevert(FundingMath.SignalOutsideBounds.selector);
        oracle.refreshObservations(1, 1);
        _observe(PRICE, 100.12e18);
        mark.set(100.12e18, 3641);
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidObservation.selector);
        oracle.refreshObservations(1, 1);
        vm.etch(address(mark), hex"00");
        vm.prank(PUBLISHER);
        vm.expectRevert(AvensFundingOracle.SourceCodeChanged.selector);
        oracle.refreshObservations(1, 1);
        require(oracle.fundingUpdatedAt() == 3600 && oracle.rateValidUntil() == 3660, "failed refresh mutated accrual");
        require(
            oracle.observedIndexTimestamp() == 3600 && oracle.observedMarkTimestamp() == 3600,
            "failed refresh mutated source time"
        );
    }

    function testCallerCannotSupplyAccountingTime() public {
        (bool ok,) = address(oracle).call(abi.encodeWithSignature("accrue(uint256)", uint256(1e12)));
        require(!ok, "arbitrary timestamp accepted");
        require(oracle.fundingUpdatedAt() == 3599, "time changed");
    }
}
