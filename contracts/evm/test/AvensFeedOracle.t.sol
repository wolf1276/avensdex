// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AvensFeedOracle} from "../src/AvensFeedOracle.sol";
import {ProtocolTypes as T} from "../src/interfaces/ProtocolTypes.sol";

interface VmFeedOracle {
    function chainId(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function etch(address, bytes calldata) external;
    function deal(address, uint256) external;
}

contract MockFeed {
    uint8 public decimals;
    uint80 public roundId;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function set(uint80 roundId_, int256 answer_, uint256 startedAt_, uint256 updatedAt_, uint80 answeredInRound_)
        external
    {
        roundId = roundId_;
        answer = answer_;
        startedAt = startedAt_;
        updatedAt = updatedAt_;
        answeredInRound = answeredInRound_;
    }

    function setDecimals(uint8 decimals_) external {
        decimals = decimals_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}

contract AvensFeedOracleTest {
    VmFeedOracle constant vm = VmFeedOracle(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant FUNDING = address(0xB0B);
    uint64 constant BASE_MAX_AGE = 60;
    uint64 constant QUOTE_MAX_AGE = 120;

    MockFeed base;
    MockFeed quote;
    AvensFeedOracle oracle;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1000);
        base = new MockFeed(8);
        quote = new MockFeed(8);
        _setBase(800e8);
        _setQuote(1e8);
        oracle = new AvensFeedOracle(1, address(base), address(quote), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
    }

    function _setBase(int256 answer) internal {
        base.set(1, answer, block.timestamp, block.timestamp, 1);
    }

    function _setQuote(int256 answer) internal {
        quote.set(1, answer, block.timestamp, block.timestamp, 1);
    }

    function _refresh() internal {
        _setBase(800e8);
        _setQuote(1e8);
    }

    function _fund(int128 rate, uint64 validUntil) internal {
        _refresh();
        vm.prank(FUNDING);
        oracle.setFundingRate(rate, validUntil);
    }

    function _bound(uint256 value, uint256 min, uint256 max) internal pure returns (uint256) {
        return min + (value % (max - min + 1));
    }

    function testConstructorConfigurationAndRoles() public {
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(0, address(base), address(quote), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(9, address(base), address(quote), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
        new AvensFeedOracle(8, address(base), address(quote), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);

        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(0), address(quote), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(base), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(quote), address(0), BASE_MAX_AGE, QUOTE_MAX_AGE);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(quote), address(this), BASE_MAX_AGE, QUOTE_MAX_AGE);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(quote), address(base), BASE_MAX_AGE, QUOTE_MAX_AGE);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(quote), address(quote), BASE_MAX_AGE, QUOTE_MAX_AGE);

        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(0xBEEF), address(quote), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(0xBEEF), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);

        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(quote), FUNDING, 0, QUOTE_MAX_AGE);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(quote), FUNDING, 3601, QUOTE_MAX_AGE);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(quote), FUNDING, BASE_MAX_AGE, 0);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(quote), FUNDING, BASE_MAX_AGE, 86401);
        new AvensFeedOracle(1, address(base), address(quote), FUNDING, 1, 86400);

        MockFeed feed19 = new MockFeed(19);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(feed19), address(quote), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(feed19), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
    }

    function testChainGuardsAndFrozenDeploymentChain() public {
        vm.chainId(43113);
        new AvensFeedOracle(1, address(base), address(quote), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
        vm.chainId(43114);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(quote), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
        vm.chainId(1);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(quote), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);

        vm.chainId(43113);
        vm.expectRevert(AvensFeedOracle.Unavailable.selector);
        oracle.price(1);
        vm.expectRevert(AvensFeedOracle.Unavailable.selector);
        oracle.fundingIndex(1);
        vm.chainId(31337);
        require(oracle.price(1).price18 == 800e18);

        vm.expectRevert(AvensFeedOracle.Unavailable.selector);
        oracle.price(2);
    }

    function testConstructorRejectsTimestampZero() public {
        vm.warp(0);
        vm.expectRevert(AvensFeedOracle.InvalidConfiguration.selector);
        new AvensFeedOracle(1, address(base), address(quote), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
    }

    function testDecimalScalingEightEightAndQuoteDepeg() public {
        T.Price memory p = oracle.price(1);
        require(p.price18 == 800e18);
        require(p.sourceTimestamp == block.timestamp);

        _setBase(2000e8);
        _setQuote(98e6); // 0.98 USD per collateral unit, so the ratio must not assume a peg.
        p = oracle.price(1);
        require(p.price18 == uint128(uint256(2000e18) * 1e18 / uint256(98e16)));
    }

    function testZeroAndEighteenDecimalFeeds() public {
        MockFeed feed0 = new MockFeed(0);
        MockFeed feed18 = new MockFeed(18);
        feed0.set(1, 800, block.timestamp, block.timestamp, 1);
        feed18.set(1, 1e18, block.timestamp, block.timestamp, 1);
        AvensFeedOracle local =
            new AvensFeedOracle(1, address(feed0), address(feed18), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
        require(local.capturedBaseDecimals() == 0);
        require(local.capturedQuoteDecimals() == 18);
        require(local.price(1).price18 == 800e18);
        (uint128 b18,, uint128 q18,) = local.sources();
        require(b18 == 800e18 && q18 == 1e18);
    }

    function testPriceRejectsInvalidRoundsAndAnswers() public {
        _setBase(0);
        vm.expectRevert(AvensFeedOracle.InvalidPrice.selector);
        oracle.price(1);

        _setBase(-1);
        vm.expectRevert(AvensFeedOracle.InvalidPrice.selector);
        oracle.price(1);

        base.set(0, 800e8, block.timestamp, block.timestamp, 0);
        vm.expectRevert(AvensFeedOracle.InvalidRound.selector);
        oracle.price(1);

        base.set(2, 800e8, block.timestamp, block.timestamp, 1);
        vm.expectRevert(AvensFeedOracle.InvalidRound.selector);
        oracle.price(1);

        _setBase(800e8);
        quote.set(0, 1e8, block.timestamp, block.timestamp, 0);
        vm.expectRevert(AvensFeedOracle.InvalidRound.selector);
        oracle.price(1);

        quote.set(2, 1e8, block.timestamp, block.timestamp, 1);
        vm.expectRevert(AvensFeedOracle.InvalidRound.selector);
        oracle.price(1);
    }

    function testPriceRejectsInvalidTimestamps() public {
        base.set(1, 800e8, 0, block.timestamp, 1);
        vm.expectRevert(AvensFeedOracle.InvalidTimestamp.selector);
        oracle.price(1);

        base.set(1, 800e8, block.timestamp, 0, 1);
        vm.expectRevert(AvensFeedOracle.InvalidTimestamp.selector);
        oracle.price(1);

        base.set(1, 800e8, block.timestamp + 1, block.timestamp + 1, 1);
        vm.expectRevert(AvensFeedOracle.InvalidTimestamp.selector);
        oracle.price(1);

        base.set(1, 800e8, block.timestamp, block.timestamp + 1, 1);
        vm.expectRevert(AvensFeedOracle.InvalidTimestamp.selector);
        oracle.price(1);

        base.set(1, 800e8, block.timestamp, block.timestamp - 1, 1);
        vm.expectRevert(AvensFeedOracle.InvalidTimestamp.selector);
        oracle.price(1);

        _setBase(800e8);
        quote.set(1, 1e8, block.timestamp + 1, block.timestamp + 1, 1);
        vm.expectRevert(AvensFeedOracle.InvalidTimestamp.selector);
        oracle.price(1);
    }

    function testEachSourceFreshnessBoundAndMinimumTimestamp() public {
        base.set(1, 800e8, block.timestamp - 61, block.timestamp - 61, 1);
        _setQuote(1e8);
        vm.expectRevert(AvensFeedOracle.StalePrice.selector);
        oracle.price(1);

        _setBase(800e8);
        quote.set(1, 1e8, block.timestamp - 121, block.timestamp - 121, 1);
        vm.expectRevert(AvensFeedOracle.StalePrice.selector);
        oracle.price(1);

        base.set(1, 800e8, block.timestamp - 60, block.timestamp - 60, 1);
        quote.set(1, 1e8, block.timestamp - 120, block.timestamp - 120, 1);
        T.Price memory p = oracle.price(1);
        require(p.price18 == 800e18);
        require(p.sourceTimestamp == block.timestamp - 120);

        // A fresher quote must not hide a stale base and vice versa (covered above), and each time stays original.
        base.set(1, 900e8, 950, 990, 1);
        quote.set(1, 2e8, 960, 995, 1);
        (uint128 b18, uint64 bt, uint128 q18, uint64 qt) = oracle.sources();
        require(b18 == 900e18 && bt == 990);
        require(q18 == 2e18 && qt == 995);
        p = oracle.price(1);
        require(p.price18 == 450e18);
        require(p.sourceTimestamp == 990);
    }

    function testPriceBoundsPreventOverflowAndZeroRatio() public {
        _setBase(type(int256).max);
        vm.expectRevert(AvensFeedOracle.InvalidPrice.selector);
        oracle.price(1);

        _setBase(1e17 + 1);
        vm.expectRevert(AvensFeedOracle.InvalidPrice.selector);
        oracle.price(1);

        _setBase(1e17);
        MockFeed q1 = new MockFeed(18);
        q1.set(1, 1, block.timestamp, block.timestamp, 1);
        AvensFeedOracle highRatio =
            new AvensFeedOracle(1, address(base), address(q1), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
        vm.expectRevert(AvensFeedOracle.InvalidPrice.selector);
        highRatio.price(1);

        MockFeed b18 = new MockFeed(18);
        MockFeed q8 = new MockFeed(8);
        b18.set(1, 1, block.timestamp, block.timestamp, 1);
        q8.set(1, 1e17, block.timestamp, block.timestamp, 1);
        AvensFeedOracle zeroRatio =
            new AvensFeedOracle(1, address(b18), address(q8), FUNDING, BASE_MAX_AGE, QUOTE_MAX_AGE);
        vm.expectRevert(AvensFeedOracle.InvalidPrice.selector);
        zeroRatio.price(1);
    }

    function testCapturedDecimalsDetectRuntimeChange() public {
        require(oracle.capturedBaseDecimals() == 8);
        require(oracle.capturedQuoteDecimals() == 8);
        base.setDecimals(18);
        vm.expectRevert(AvensFeedOracle.FeedDecimalsChanged.selector);
        oracle.price(1);

        quote.setDecimals(0);
        vm.expectRevert(AvensFeedOracle.FeedDecimalsChanged.selector);
        oracle.price(1);
    }

    function testRuntimeCodeHashPinFailsClosed() public {
        require(oracle.baseUsdFeedCodeHash() == keccak256(address(base).code));
        require(oracle.collateralUsdFeedCodeHash() == keccak256(address(quote).code));

        vm.etch(address(base), hex"00");
        vm.expectRevert(AvensFeedOracle.FeedCodeChanged.selector);
        oracle.price(1);
    }

    function testCollateralRuntimeCodeHashPinFailsClosed() public {
        vm.etch(address(quote), hex"00");
        vm.expectRevert(AvensFeedOracle.FeedCodeChanged.selector);
        oracle.price(1);
    }

    function testFundingInitializationAndPublisherOnly() public {
        vm.expectRevert(AvensFeedOracle.Unauthorized.selector);
        oracle.setFundingRate(0, uint64(block.timestamp) + 10);

        (int128 index, uint64 validUntil) = oracle.fundingIndex(1);
        require(index == 0);
        require(validUntil == 1000);

        vm.warp(1001);
        _refresh();
        (index, validUntil) = oracle.fundingIndex(1);
        require(index == 0);
        require(validUntil == 1000);
    }

    function testFundingRateBoundsAndLifetime() public {
        uint64 now_ = uint64(block.timestamp);
        int256 maxRate = int256(uint256(oracle.price(1).price18) / 100 / 3600);

        vm.prank(FUNDING);
        vm.expectRevert(AvensFeedOracle.InvalidRate.selector);
        oracle.setFundingRate(int128(maxRate + 1), now_ + 60);
        vm.prank(FUNDING);
        vm.expectRevert(AvensFeedOracle.InvalidRate.selector);
        oracle.setFundingRate(int128(-maxRate - 1), now_ + 60);
        vm.prank(FUNDING);
        vm.expectRevert(AvensFeedOracle.InvalidRate.selector);
        oracle.setFundingRate(type(int128).min, now_ + 60);
        vm.prank(FUNDING);
        vm.expectRevert(AvensFeedOracle.InvalidRate.selector);
        oracle.setFundingRate(0, now_);
        vm.prank(FUNDING);
        vm.expectRevert(AvensFeedOracle.InvalidRate.selector);
        oracle.setFundingRate(0, now_ + 3601);

        vm.prank(FUNDING);
        oracle.setFundingRate(int128(maxRate), now_ + 3600);
        (, uint64 validUntil) = oracle.fundingIndex(1);
        require(validUntil == now_ + 3600);
    }

    function testFundingCheckpointsSignsReplayAndExpiredGap() public {
        uint64 t0 = uint64(block.timestamp);
        _fund(1e12, t0 + 10);

        vm.warp(t0 + 5);
        _refresh();
        (int128 index, uint64 validUntil) = oracle.fundingIndex(1);
        require(index == 5e12);
        require(validUntil == t0 + 10);

        vm.prank(FUNDING);
        oracle.setFundingRate(-1e12, t0 + 15);
        require(oracle.checkpointIndex18() == 5e12);

        vm.warp(t0 + 10);
        _refresh();
        (index, validUntil) = oracle.fundingIndex(1);
        require(index == 0);
        require(validUntil == t0 + 15);

        vm.prank(FUNDING);
        oracle.setFundingRate(0, t0 + 20);
        require(oracle.checkpointIndex18() == 0);
        vm.prank(FUNDING);
        oracle.setFundingRate(0, t0 + 21);
        require(oracle.checkpointIndex18() == 0);

        vm.warp(t0 + 100);
        _refresh();
        (index, validUntil) = oracle.fundingIndex(1);
        require(index == 0);
        require(validUntil == t0 + 21);

        vm.prank(FUNDING);
        oracle.setFundingRate(1e12, t0 + 120);
        require(oracle.checkpointIndex18() == 0);

        vm.warp(t0 + 110);
        _refresh();
        (index, validUntil) = oracle.fundingIndex(1);
        require(index == 10e12);
        require(validUntil == t0 + 120);
    }

    function testFundingExpiryReturnsFrozenIndexWhilePriceStaysFresh() public {
        uint64 t0 = uint64(block.timestamp);
        _fund(1e12, t0 + 10);

        vm.warp(t0 + 10);
        _refresh();
        (int128 index, uint64 validUntil) = oracle.fundingIndex(1);
        require(index == 10e12);
        require(validUntil == t0 + 10);

        vm.warp(t0 + 5000);
        _refresh();
        require(oracle.price(1).price18 == 800e18);
        (index, validUntil) = oracle.fundingIndex(1);
        require(index == 10e12);
        require(validUntil == t0 + 10);
    }

    function testFundingAndSetterRequireFreshActualPrice() public {
        uint64 t0 = uint64(block.timestamp);
        _fund(1e12, t0 + 100);

        vm.warp(t0 + 5000);
        vm.expectRevert(AvensFeedOracle.StalePrice.selector);
        oracle.fundingIndex(1);

        vm.prank(FUNDING);
        vm.expectRevert(AvensFeedOracle.StalePrice.selector);
        oracle.setFundingRate(0, uint64(block.timestamp) + 10);
    }

    function testPriceCopiesActualFeedPayload() public {
        base.set(1, 900e8, 990, 990, 1);
        quote.set(1, 2e8, 900, 901, 1);
        T.Price memory p = oracle.price(1);
        require(p.price18 == 450e18);
        require(p.sourceTimestamp == 901);

        base.set(1, 300e8, 995, 995, 1);
        quote.set(1, 2e8, 990, 990, 1);
        p = oracle.price(1);
        require(p.price18 == 150e18);
        require(p.sourceTimestamp == 990);
    }

    function testNoEthTransferMethods() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(oracle).call{value: 1}("");
        require(!ok);
        require(address(oracle).balance == 0);
    }

    function testFuzzRatioConservation(uint64 rawBase, uint64 rawQuote) public {
        uint256 baseAnswer = _bound(uint256(rawBase), 1, 1e17);
        uint256 minQuote = (baseAnswer + 1e9 - 1) / 1e9;
        uint256 quoteAnswer = _bound(uint256(rawQuote), minQuote, 1e17);

        _setBase(int256(baseAnswer));
        _setQuote(int256(quoteAnswer));

        T.Price memory p = oracle.price(1);
        require(p.price18 == uint128(baseAnswer * 1e18 / quoteAnswer));
        require(p.sourceTimestamp == block.timestamp);

        (uint128 b18, uint64 bt, uint128 q18, uint64 qt) = oracle.sources();
        require(b18 == uint128(baseAnswer * 1e10));
        require(q18 == uint128(quoteAnswer * 1e10));
        require(bt == block.timestamp && qt == block.timestamp);
    }

    function testFuzzFundingIndexConservation(int64 rawRate, uint16 rawDuration) public {
        uint64 duration = uint64(_bound(uint256(rawDuration), 1, 3600));
        int256 maxRate = int256(uint256(oracle.price(1).price18) / 100 / 3600);
        int256 rr = int256(rawRate);
        uint256 magnitude = uint256(rr < 0 ? -rr : rr);
        int128 rate = int128(int256(_bound(magnitude, 0, uint256(maxRate))) * (rr < 0 ? int256(-1) : int256(1)));
        uint64 start = uint64(block.timestamp);

        _refresh();
        vm.prank(FUNDING);
        oracle.setFundingRate(rate, start + duration);

        vm.warp(start + duration);
        _refresh();
        (int128 index, uint64 validUntil) = oracle.fundingIndex(1);
        require(validUntil == start + duration);
        require(index == rate * int128(uint128(duration)));
    }

    function testFuzzFundingSignChangeConservation(int64 rawRate, uint8 rawFirst, uint8 rawSecond) public {
        uint64 first = uint64(_bound(uint256(rawFirst), 1, 1000));
        uint64 second = uint64(_bound(uint256(rawSecond), 1, 1000));
        int256 maxRate = int256(uint256(oracle.price(1).price18) / 100 / 3600);
        int256 rr = int256(rawRate);
        uint256 magnitude = uint256(rr < 0 ? -rr : rr);
        int128 rate = int128(int256(_bound(magnitude, 1, uint256(maxRate))));
        uint64 start = uint64(block.timestamp);

        _refresh();
        vm.prank(FUNDING);
        oracle.setFundingRate(rate, start + first);

        vm.warp(start + first);
        _refresh();
        vm.prank(FUNDING);
        oracle.setFundingRate(-rate, start + first + second);

        vm.warp(start + first + second);
        _refresh();
        (int128 index,) = oracle.fundingIndex(1);
        int256 expected = int256(rate) * int256(uint256(first)) - int256(rate) * int256(uint256(second));
        require(index == int128(expected));
    }
}
