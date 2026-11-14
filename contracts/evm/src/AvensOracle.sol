// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {ProtocolTypes as T} from "./interfaces/ProtocolTypes.sol";

/// @notice Local qualification adapter with separate price and bounded funding publishers.
/// @dev Trusted-publisher inputs are not a qualified public price feed. Fuji publication stays disabled.
contract AvensOracle is IOracleAdapter {
    error InvalidConfiguration();
    error Unauthorized();
    error Unavailable();
    error InvalidPrice();
    error InvalidRate();

    uint32 public immutable marketId;
    address public immutable pricePublisher;
    address public immutable fundingPublisher;
    uint64 public immutable maxAge;
    uint256 public immutable deploymentChainId;
    T.Price private observation;
    int128 public ratePrice18PerSecond;
    int128 private checkpointIndex18;
    uint64 public rateAt;
    uint64 public rateValidUntil;

    event PricePublished(uint128 price18, uint64 sourceTimestamp);
    event FundingRatePublished(int128 ratePrice18PerSecond, int128 checkpointIndex18, uint64 validUntil);

    constructor(uint32 market, address priceSource, address fundingSource, uint64 maxAge_) {
        if (
            (block.chainid != 31337 && block.chainid != 43113) || market == 0 || market > 8 || priceSource == address(0)
                || fundingSource == address(0) || priceSource == fundingSource || priceSource == msg.sender
                || fundingSource == msg.sender || maxAge_ == 0 || maxAge_ > 3600
        ) revert InvalidConfiguration();
        marketId = market;
        pricePublisher = priceSource;
        fundingPublisher = fundingSource;
        maxAge = maxAge_;
        deploymentChainId = block.chainid;
    }

    function publishPrice(uint128 value18, uint64 sourceTimestamp) external {
        if (msg.sender != pricePublisher) revert Unauthorized();
        _local();
        if (
            value18 == 0 || value18 > 1e27 || sourceTimestamp == 0 || sourceTimestamp > block.timestamp
                || block.timestamp - sourceTimestamp > maxAge || sourceTimestamp < observation.sourceTimestamp
        ) revert InvalidPrice();
        observation = T.Price(value18, sourceTimestamp);
        emit PricePublished(value18, sourceTimestamp);
    }

    function price(uint32 market) public view returns (T.Price memory result) {
        if (block.chainid != deploymentChainId || market != marketId) revert Unavailable();
        result = observation;
        if (
            result.price18 == 0 || result.sourceTimestamp == 0 || result.sourceTimestamp > block.timestamp
                || block.timestamp - result.sourceTimestamp > maxAge
        ) revert InvalidPrice();
    }

    /// @notice Checkpoint the old rate before changing it; expired intervals never accrue retroactively.
    function setFundingRate(int128 rate, uint64 validUntil) external {
        if (msg.sender != fundingPublisher) revert Unauthorized();
        _local();
        T.Price memory observation_ = price(marketId);
        if (validUntil <= block.timestamp || uint256(validUntil) > block.timestamp + 3600) revert InvalidRate();
        // Absolute funding movement is capped at 1% of the independently observed price per hour.
        int256 maxRate = int256(uint256(observation_.price18) / 100 / 3600);
        if (int256(rate) > maxRate || int256(rate) < -maxRate) revert InvalidRate();
        checkpointIndex18 = _indexAt(block.timestamp);
        rateAt = uint64(block.timestamp);
        ratePrice18PerSecond = rate;
        rateValidUntil = validUntil;
        emit FundingRatePublished(rate, checkpointIndex18, validUntil);
    }

    function fundingIndex(uint32 market) external view returns (int128 index18, uint64 validUntil) {
        price(market); // Funding does not make stale price observations executable.
        validUntil = rateValidUntil;
        if (validUntil == 0) revert Unavailable(); // Expired terminal indices remain usable for existing exits.
        index18 = _indexAt(block.timestamp);
    }

    function _indexAt(uint256 at) private view returns (int128) {
        if (rateAt == 0) return checkpointIndex18;
        uint256 until = at < rateValidUntil ? at : rateValidUntil;
        int256 index = int256(checkpointIndex18);
        if (until > rateAt) index += int256(ratePrice18PerSecond) * int256(until - rateAt);
        if (index < type(int128).min || index > type(int128).max) revert InvalidRate();
        return int128(index);
    }

    function _local() private view {
        if (deploymentChainId != 31337 || block.chainid != deploymentChainId) revert Unavailable();
    }
}
