// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {ProtocolTypes as T} from "./interfaces/ProtocolTypes.sol";
import {FundingMath} from "./libraries/FundingMath.sol";

/// @notice Epoch-protected funding from separate index and validated-mark adapters.
/// @dev Uses source-derived FundingMath; different addresses do not establish economic independence.
///      No custody or execution authority. Source qualification and publisher liveness remain external gates.
contract AvensFundingOracle is IOracleAdapter {
    error InvalidConfiguration();
    error Unauthorized();
    error Unavailable();
    error InvalidObservation();
    error SourceCodeChanged();
    error InvalidEpoch();
    error InvalidIndex();

    uint256 private constant INTERVAL = 3600;
    int256 private constant DENOMINATOR = 1_000_000 * 3600;
    IOracleAdapter public immutable indexSource;
    IOracleAdapter public immutable markSource;
    uint32 public immutable marketId;
    address public immutable fundingPublisher;
    address public immutable configOwner;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable indexSourceCodeHash;
    bytes32 public immutable markSourceCodeHash;

    FundingMath.Mode public mode;
    FundingMath.Params public params;
    uint256 public revision = 1;
    bool public hasLastEpoch;
    uint256 public lastEpoch;
    bool public hasPremiumEma;
    int256 public premiumEma;
    int256 public fundingRatePpm;
    int128 public checkpointIndex18;
    int256 public fundingRemainder;
    uint64 public fundingUpdatedAt;
    uint64 public rateAppliedAt;
    uint64 public rateValidUntil;
    uint128 public observedIndexPrice18;
    uint64 public observedIndexTimestamp;
    uint64 public observedMarkTimestamp;

    event FundingEpochPublished(uint256 indexed epoch, uint256 indexed revision, int256 ratePpm, uint64 validUntil);
    event FundingConfigured(FundingMath.Mode mode, uint256 revision);
    event FundingObservationsRefreshed(uint256 indexed epoch, uint256 indexed revision, uint64 validUntil);

    constructor(IOracleAdapter indexSource_, IOracleAdapter markSource_, uint32 marketId_, address publisher_) {
        if (
            (block.chainid != 31337 && block.chainid != 43113) || block.timestamp == 0
                || block.timestamp > type(uint64).max - INTERVAL || marketId_ == 0 || marketId_ > 8
                || address(indexSource_).code.length == 0 || address(markSource_).code.length == 0
                || indexSource_ == markSource_ || publisher_ == address(0) || publisher_ == msg.sender
                || publisher_ == address(indexSource_) || publisher_ == address(markSource_)
        ) revert InvalidConfiguration();
        indexSource = indexSource_;
        markSource = markSource_;
        marketId = marketId_;
        fundingPublisher = publisher_;
        configOwner = msg.sender;
        deploymentChainId = block.chainid;
        indexSourceCodeHash = address(indexSource_).codehash;
        markSourceCodeHash = address(markSource_).codehash;
        mode = FundingMath.Mode.ADAPTIVE;
        params = FundingMath.defaults();
        T.Price memory initial = price(marketId_);
        observedIndexPrice18 = initial.price18;
        observedIndexTimestamp = initial.sourceTimestamp;
        fundingUpdatedAt = uint64(block.timestamp);
        rateAppliedAt = uint64(block.timestamp);
        rateValidUntil = uint64(block.timestamp); // No usable rate before an authenticated publication.
    }

    function _available() private view {
        if (block.chainid != deploymentChainId || block.timestamp > type(uint64).max - INTERVAL) revert Unavailable();
    }

    function _validate(T.Price memory observation, uint256 maxAge) private view {
        if (
            observation.price18 == 0 || observation.price18 > 1e27 || observation.sourceTimestamp == 0
                || observation.sourceTimestamp > block.timestamp
                || block.timestamp - observation.sourceTimestamp > maxAge
        ) revert InvalidObservation();
    }

    function price(uint32 market) public view returns (T.Price memory result) {
        _available();
        if (market != marketId) revert Unavailable();
        if (address(indexSource).codehash != indexSourceCodeHash) revert SourceCodeChanged();
        result = indexSource.price(market);
        _validate(result, uint256(params.oracle_max_age_sec));
    }

    function publish(uint256 expectedRevision, uint256 expectedEpoch) external {
        _available();
        if (msg.sender != fundingPublisher) revert Unauthorized();
        if (expectedRevision != revision) revert InvalidConfiguration();
        uint256 epoch = block.timestamp / INTERVAL;
        if (expectedEpoch != epoch || (hasLastEpoch && epoch <= lastEpoch)) revert InvalidEpoch();
        T.Price memory index = price(marketId);
        if (address(markSource).codehash != markSourceCodeHash) revert SourceCodeChanged();
        T.Price memory mark = markSource.price(marketId);
        _validate(mark, uint256(params.mark_max_age_sec));
        int256 sample = FundingMath.premium(
            index.price18, mark.price18, index.sourceTimestamp, mark.sourceTimestamp, block.timestamp, params
        );
        int256 smoothed = FundingMath.ema(sample, premiumEma, hasPremiumEma, params);
        int256 next = FundingMath.nextRate(mode, smoothed, fundingRatePpm, params);
        _checkpoint();
        observedIndexPrice18 = index.price18;
        observedIndexTimestamp = index.sourceTimestamp;
        observedMarkTimestamp = mark.sourceTimestamp;
        premiumEma = smoothed;
        hasPremiumEma = true;
        fundingRatePpm = next;
        rateAppliedAt = uint64(block.timestamp);
        uint256 oracleExpiry = uint256(index.sourceTimestamp) + uint256(params.oracle_max_age_sec);
        uint256 rateExpiry = block.timestamp + INTERVAL;
        rateValidUntil = uint64(oracleExpiry < rateExpiry ? oracleExpiry : rateExpiry);
        hasLastEpoch = true;
        lastEpoch = epoch;
        emit FundingEpochPublished(epoch, revision, next, rateValidUntil);
    }

    /// @notice Renew observations, not the epoch's computed rate. Expired gaps never accrue.
    function refreshObservations(uint256 expectedRevision, uint256 expectedEpoch) external {
        _available();
        if (msg.sender != fundingPublisher) revert Unauthorized();
        if (expectedRevision != revision) revert InvalidConfiguration();
        if (
            !hasLastEpoch || !hasPremiumEma || expectedEpoch != lastEpoch || expectedEpoch != block.timestamp / INTERVAL
                || block.timestamp >= uint256(rateAppliedAt) + INTERVAL
        ) revert InvalidEpoch();
        T.Price memory index = price(marketId);
        if (address(markSource).codehash != markSourceCodeHash) revert SourceCodeChanged();
        T.Price memory mark = markSource.price(marketId);
        _validate(mark, uint256(params.mark_max_age_sec));
        if (index.sourceTimestamp <= observedIndexTimestamp || mark.sourceTimestamp <= observedMarkTimestamp) {
            revert InvalidObservation();
        }
        FundingMath.premium(
            index.price18, mark.price18, index.sourceTimestamp, mark.sourceTimestamp, block.timestamp, params
        );
        _checkpoint();
        observedIndexPrice18 = index.price18;
        observedIndexTimestamp = index.sourceTimestamp;
        observedMarkTimestamp = mark.sourceTimestamp;
        uint256 sourceExpiry = uint256(index.sourceTimestamp) + uint256(params.oracle_max_age_sec);
        uint256 publicationExpiry = uint256(rateAppliedAt) + INTERVAL;
        rateValidUntil = uint64(sourceExpiry < publicationExpiry ? sourceExpiry : publicationExpiry);
        emit FundingObservationsRefreshed(lastEpoch, revision, rateValidUntil);
    }

    function configure(FundingMath.Mode mode_, FundingMath.Params calldata params_, uint256 expectedRevision) external {
        _available();
        if (msg.sender != configOwner) revert Unauthorized();
        if (expectedRevision != revision) revert InvalidConfiguration();
        FundingMath.validate(params_);
        _checkpoint();
        mode = mode_;
        params = params_;
        // Validate under the new freshness policy; any failure rolls back the whole checkpoint/configuration.
        T.Price memory index = price(marketId);
        observedIndexPrice18 = index.price18;
        observedIndexTimestamp = index.sourceTimestamp;
        observedMarkTimestamp = 0;
        fundingRatePpm = 0;
        premiumEma = 0;
        hasPremiumEma = false;
        rateAppliedAt = uint64(block.timestamp);
        rateValidUntil = uint64(block.timestamp);
        lastEpoch = block.timestamp / INTERVAL;
        hasLastEpoch = true;
        revision++;
        emit FundingConfigured(mode_, revision);
    }

    function _accrued() private view returns (int128 index, int256 remainder) {
        if (block.timestamp < fundingUpdatedAt) revert Unavailable();
        uint256 end = block.timestamp < rateValidUntil ? block.timestamp : rateValidUntil;
        int256 accumulated = int256(checkpointIndex18);
        remainder = fundingRemainder;
        if (end > fundingUpdatedAt) {
            int256 numerator =
                int256(uint256(observedIndexPrice18)) * fundingRatePpm * int256(end - fundingUpdatedAt) + remainder;
            accumulated += numerator / DENOMINATOR;
            remainder = numerator % DENOMINATOR;
        }
        if (accumulated < type(int128).min || accumulated > type(int128).max) revert InvalidIndex();
        index = int128(accumulated);
    }

    function _checkpoint() private {
        (checkpointIndex18, fundingRemainder) = _accrued();
        fundingUpdatedAt = uint64(block.timestamp);
    }

    /// @notice Permissionless checkpoint uses chain time only; callers cannot advance or rewind accounting time.
    function checkpoint() external {
        _available();
        _checkpoint();
    }

    function fundingIndex(uint32 market) external view returns (int128 index18, uint64 validUntil) {
        price(market);
        (index18,) = _accrued();
        validUntil = rateValidUntil;
    }
}
