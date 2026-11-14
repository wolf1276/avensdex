// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {ProtocolTypes as T} from "./interfaces/ProtocolTypes.sol";

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Two-feed Chainlink adapter: BASE/USD divided by COLLATERAL/USD, quoted in 1e18 units.
/// @dev The same code path serves local fixture mocks and (after qualification) public Fuji feeds. Pinning the
///      proxy runtime hash detects code replacement only; it does not prove proxied aggregator/implementation
///      immutability. Local fixtures are not public price evidence and this contract authorizes no activation.
contract AvensFeedOracle is IOracleAdapter {
    error InvalidConfiguration();
    error Unauthorized();
    error Unavailable();
    error InvalidPrice();
    error InvalidRound();
    error InvalidTimestamp();
    error StalePrice();
    error FeedCodeChanged();
    error FeedDecimalsChanged();
    error InvalidRate();

    uint256 private constant WAD = 1e18;
    uint256 private constant MAX_PRICE = 1e27;
    uint64 private constant MAX_FUNDING_LIFETIME = 3600;

    uint32 public immutable marketId;
    address public immutable baseUsdFeed;
    address public immutable collateralUsdFeed;
    address public immutable fundingPublisher;
    uint64 public immutable baseMaxAge;
    uint64 public immutable quoteMaxAge;
    uint256 public immutable deploymentChainId;
    uint8 public immutable capturedBaseDecimals;
    uint8 public immutable capturedQuoteDecimals;
    bytes32 public immutable baseUsdFeedCodeHash;
    bytes32 public immutable collateralUsdFeedCodeHash;

    int128 public ratePrice18PerSecond;
    int128 public checkpointIndex18;
    uint64 public rateAt;
    uint64 public rateValidUntil;

    event FundingRatePublished(int128 ratePrice18PerSecond, int128 checkpointIndex18, uint64 validUntil);

    constructor(
        uint32 marketId_,
        address baseUsdFeed_,
        address collateralUsdFeed_,
        address fundingPublisher_,
        uint64 baseMaxAge_,
        uint64 quoteMaxAge_
    ) {
        if (
            (block.chainid != 31337 && block.chainid != 43113) || block.timestamp == 0 || marketId_ == 0
                || marketId_ > 8 || baseUsdFeed_ == address(0) || collateralUsdFeed_ == address(0)
                || fundingPublisher_ == address(0) || baseUsdFeed_ == collateralUsdFeed_
                || fundingPublisher_ == msg.sender || fundingPublisher_ == baseUsdFeed_
                || fundingPublisher_ == collateralUsdFeed_ || baseUsdFeed_.code.length == 0
                || collateralUsdFeed_.code.length == 0 || baseMaxAge_ == 0 || baseMaxAge_ > 3600 || quoteMaxAge_ == 0
                || quoteMaxAge_ > 86400
        ) revert InvalidConfiguration();

        uint8 baseDecimals = AggregatorV3Interface(baseUsdFeed_).decimals();
        uint8 quoteDecimals = AggregatorV3Interface(collateralUsdFeed_).decimals();
        if (baseDecimals > 18 || quoteDecimals > 18) revert InvalidConfiguration();

        marketId = marketId_;
        baseUsdFeed = baseUsdFeed_;
        collateralUsdFeed = collateralUsdFeed_;
        fundingPublisher = fundingPublisher_;
        baseMaxAge = baseMaxAge_;
        quoteMaxAge = quoteMaxAge_;
        deploymentChainId = block.chainid;
        capturedBaseDecimals = baseDecimals;
        capturedQuoteDecimals = quoteDecimals;
        baseUsdFeedCodeHash = baseUsdFeed_.codehash;
        collateralUsdFeedCodeHash = collateralUsdFeed_.codehash;

        // No live rate at construction: the terminal zero checkpoint expires next block until a publisher renews.
        rateAt = uint64(block.timestamp);
        rateValidUntil = uint64(block.timestamp);
    }

    function price(uint32 market) public view returns (T.Price memory result) {
        if (block.chainid != deploymentChainId || market != marketId) revert Unavailable();
        (uint128 baseUsd18, uint64 baseAt, uint128 collateralUsd18, uint64 quoteAt) = _observe();
        uint256 ratio = uint256(baseUsd18) * WAD / collateralUsd18;
        if (ratio == 0 || ratio > MAX_PRICE) revert InvalidPrice();
        result = T.Price(uint128(ratio), baseAt < quoteAt ? baseAt : quoteAt);
    }

    /// @notice Current validated observations for audit; original feed timestamps are never restamped.
    function sources()
        public
        view
        returns (uint128 baseUsd18, uint64 baseUpdatedAt, uint128 collateralUsd18, uint64 collateralUpdatedAt)
    {
        if (block.chainid != deploymentChainId) revert Unavailable();
        return _observe();
    }

    function _observe()
        internal
        view
        returns (uint128 baseUsd18, uint64 baseUpdatedAt, uint128 collateralUsd18, uint64 collateralUpdatedAt)
    {
        (baseUsd18, baseUpdatedAt) = _readFeed(baseUsdFeed, capturedBaseDecimals, baseUsdFeedCodeHash, baseMaxAge);
        (collateralUsd18, collateralUpdatedAt) =
            _readFeed(collateralUsdFeed, capturedQuoteDecimals, collateralUsdFeedCodeHash, quoteMaxAge);
    }

    function _readFeed(address feed, uint8 expectedDecimals, bytes32 expectedCodeHash, uint64 maxAge)
        private
        view
        returns (uint128 normalized18, uint64 updatedAt)
    {
        if (feed.codehash != expectedCodeHash) revert FeedCodeChanged();
        if (AggregatorV3Interface(feed).decimals() != expectedDecimals) revert FeedDecimalsChanged();
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt_, uint80 answeredInRound) =
            AggregatorV3Interface(feed).latestRoundData();
        if (roundId == 0 || answeredInRound < roundId) revert InvalidRound();
        if (answer <= 0) revert InvalidPrice();
        if (startedAt == 0 || updatedAt_ == 0 || startedAt > block.timestamp || updatedAt_ > block.timestamp) {
            revert InvalidTimestamp();
        }
        if (startedAt > updatedAt_) revert InvalidTimestamp();
        if (block.timestamp - updatedAt_ > maxAge) revert StalePrice();

        // Bounds before scaling keep every intermediate product well inside uint256 and the 1e27 price cap.
        uint256 scale = 10 ** uint256(18 - expectedDecimals);
        uint256 raw = uint256(answer);
        if (raw > MAX_PRICE / scale) revert InvalidPrice();
        normalized18 = uint128(raw * scale);
        if (normalized18 == 0) revert InvalidPrice();
        updatedAt = uint64(updatedAt_);
    }

    /// @notice Only the immutable publisher may renew or change a rate bounded by 1% of fresh price per hour.
    function setFundingRate(int128 ratePrice18PerSecond_, uint64 validUntil) external {
        if (msg.sender != fundingPublisher) revert Unauthorized();
        if (validUntil <= block.timestamp || uint256(validUntil) > block.timestamp + MAX_FUNDING_LIFETIME) {
            revert InvalidRate();
        }
        int256 maxRate = int256(uint256(price(marketId).price18) / 100 / 3600);
        if (int256(ratePrice18PerSecond_) > maxRate || int256(ratePrice18PerSecond_) < -maxRate) {
            revert InvalidRate();
        }
        // Checkpoint the old rate only through its own expiry; renewal starts now and gaps are not backfilled.
        checkpointIndex18 = _indexAt(block.timestamp);
        rateAt = uint64(block.timestamp);
        ratePrice18PerSecond = ratePrice18PerSecond_;
        rateValidUntil = validUntil;
        emit FundingRatePublished(ratePrice18PerSecond_, checkpointIndex18, validUntil);
    }

    /// @notice Requires a fresh actual price, but returns the frozen terminal index and real past expiry if funding expired.
    function fundingIndex(uint32 market) external view returns (int128 index18, uint64 validUntil) {
        price(market);
        validUntil = rateValidUntil;
        index18 = _indexAt(block.timestamp);
    }

    function _indexAt(uint256 at) private view returns (int128) {
        int256 index = int256(checkpointIndex18);
        uint256 until = at < rateValidUntil ? at : rateValidUntil;
        if (until > rateAt) index += int256(ratePrice18PerSecond) * int256(until - rateAt);
        if (index < type(int128).min || index > type(int128).max) revert InvalidRate();
        return int128(index);
    }
}
