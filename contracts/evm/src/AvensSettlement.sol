// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AvensVault} from "./AvensVault.sol";
import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";
import {ProtocolTypes as T} from "./interfaces/ProtocolTypes.sol";
import {AssetUnits as U} from "./libraries/AssetUnits.sol";
import {ClobAuth} from "./libraries/ClobAuth.sol";
import {RiskMath} from "./libraries/RiskMath.sol";

interface IFundingOracle {
    function fundingIndex(uint32 marketId) external view returns (int128 index18, uint64 validUntil);
}

/// @notice Local-only signed bilateral perpetual settlement over the canonical vault ledger.
/// @dev RiskMath remains the source-ported risk/rounding library; this contract adds no spendable balance.
contract AvensSettlement {
    error InvalidConfiguration();
    error TradingUnavailable();
    error Unauthorized();
    error UnsupportedOrder();
    error InvalidSide();
    error WrongMarket();
    error InvalidTrader();
    error InvalidSize();
    error InvalidPrice();
    error InvalidLeverage();
    error InvalidFee();
    error InvalidExpiry();
    error InvalidNonce();
    error ConflictingNonce();
    error OrderUnavailable();
    error InvalidSignature();
    error InvalidFill();
    error InvalidReservation();
    error InvalidOracle();
    error PriceBand();
    error NotCrossing();
    error InvalidPair();
    error NotPairOwner();
    error NotLiquidatable();
    error PositionLimit();
    error UnknownOrder();
    error NotExpired();

    event MatchedFill(
        uint64 indexed pairId,
        bytes32 indexed longOrderHash,
        bytes32 indexed shortOrderHash,
        uint128 size6,
        uint128 price18
    );
    event PairOpened(
        uint64 indexed pairId,
        bytes32 indexed longOrderHash,
        bytes32 indexed shortOrderHash,
        address longOwner,
        address shortOwner,
        uint128 size6,
        uint128 price18,
        uint128 longMargin6,
        uint128 shortMargin6,
        uint128 longFee6,
        uint128 shortFee6
    );
    event FundingSettled(uint64 indexed pairId, int128 longPayment6, int128 fundingIndex18);
    event PairClosed(
        uint64 indexed pairId,
        address indexed longOwner,
        address indexed shortOwner,
        uint128 closeSize6,
        uint128 longPayout6,
        uint128 shortPayout6,
        uint128 insurance6,
        address liquidator,
        uint128 reward6
    );
    event OrderReserved(address indexed trader, bytes32 indexed orderHash, uint128 amount6);
    event OrderCancelled(address indexed trader, bytes32 indexed orderHash, uint64 nonce);
    event OrderExpired(address indexed trader, bytes32 indexed orderHash);
    event NonceInvalidated(address indexed trader, uint256 minimumNonce);

    struct Pair {
        uint128 size6;
        uint128 entryPrice18;
        int128 lastFundingIndex18;
        int128 fundingRemainder;
        bytes32 longHash;
        bytes32 shortHash;
    }

    struct MatchInfo {
        bytes32 longHash;
        bytes32 shortHash;
        uint128 oraclePrice18;
        int128 fundingIndex18;
        uint128 notional6;
        uint128 longMargin6;
        uint128 shortMargin6;
        uint128 longFee6;
        uint128 shortFee6;
    }

    struct LiquidationInfo {
        uint128 price18;
        int128 index18;
        uint128 longPayout6;
        uint128 shortPayout6;
        uint128 insurance6;
        uint128 reward6;
        bool longLoses;
    }

    uint16 public constant MAINTENANCE_BPS = 500;
    uint8 public constant MAX_LEVERAGE = 10;
    uint8 public constant MAX_POSITIONS = 32;
    uint16 internal constant FEE_BPS = 3;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_SIZE6 = 1e15;
    uint256 internal constant MAX_PRICE18 = 1e27;
    uint128 internal constant MIN_NOTIONAL6 = 1e6;
    uint64 internal constant MAX_ORDER_LIFETIME = 86_400;

    AvensVault public immutable vault;
    IOracleAdapter public immutable oracle;
    uint32 public immutable marketId;
    uint64 public immutable maxOracleAge;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable deploymentId;

    uint64 public nextPairId = 1;
    mapping(uint64 => Pair) public pairs;
    mapping(address => uint32) public positionCount;
    mapping(bytes32 => uint128) public filledSize6;
    mapping(bytes32 => bool) public cancelled;
    mapping(address => mapping(uint64 => bytes32)) public nonceHash;
    mapping(address => uint256) public minimumNonce;
    mapping(bytes32 => address) public orderTrader;
    mapping(bytes32 => uint64) public orderNonce;

    constructor(AvensVault vault_, IOracleAdapter oracle_, uint32 marketId_, uint64 maxOracleAge_) {
        if (
            (block.chainid != 31337 && block.chainid != 43113) || address(vault_) == address(0)
                || address(oracle_) == address(0) || address(vault_).code.length == 0
                || address(oracle_).code.length == 0 || address(vault_) == address(this)
                || address(oracle_) == address(this) || address(vault_) == address(oracle_) || marketId_ == 0
                || marketId_ > 8 || address(oracle_) == vault_.collateralToken() || maxOracleAge_ == 0
                || maxOracleAge_ > 3600
        ) revert InvalidConfiguration();
        bytes32 id = vault_.deploymentId();
        if (id == bytes32(0)) revert InvalidConfiguration();
        vault = vault_;
        oracle = oracle_;
        marketId = marketId_;
        maxOracleAge = maxOracleAge_;
        deploymentChainId = block.chainid;
        deploymentId = id;
    }

    function domainSeparator() public view returns (bytes32) {
        if (block.chainid != deploymentChainId) revert TradingUnavailable();
        return ClobAuth.domainSeparator(block.chainid, address(this));
    }

    function orderHash(ClobAuth.Order calldata order) public view returns (bytes32) {
        return ClobAuth.orderDigest(domainSeparator(), order);
    }

    /// @notice Permissionless settlement of a signed crossing pair. The fill price is bound to a fresh oracle.
    function matchOrders(
        ClobAuth.Order calldata longOrder,
        bytes calldata longSignature,
        ClobAuth.Order calldata shortOrder,
        bytes calldata shortSignature,
        uint128 fillSize6,
        uint128 fillPrice18
    ) external {
        _requireTrading();
        if (longOrder.side != 0 || shortOrder.side != 1) revert InvalidSide();
        MatchInfo memory m;
        (m.oraclePrice18, m.fundingIndex18) = _freshOracle();
        m.longHash = _verifyOrder(longOrder, longSignature);
        m.shortHash = _verifyOrder(shortOrder, shortSignature);
        _checkActive(longOrder);
        _checkActive(shortOrder);
        if (longOrder.trader == shortOrder.trader) revert InvalidTrader();
        if (
            fillSize6 == 0 || fillSize6 > longOrder.size6 - filledSize6[m.longHash]
                || fillSize6 > shortOrder.size6 - filledSize6[m.shortHash]
        ) revert InvalidFill();
        if (fillPrice18 == 0 || fillPrice18 > MAX_PRICE18) revert InvalidPrice();
        if (longOrder.limitPrice18 < fillPrice18 || shortOrder.limitPrice18 > fillPrice18) revert NotCrossing();
        _checkBand(fillPrice18, m.oraclePrice18);
        m.notional6 = RiskMath.notional6(fillSize6, fillPrice18);
        if (m.notional6 < MIN_NOTIONAL6) revert InvalidSize();
        m.longMargin6 = _margin(m.notional6, longOrder.leverage);
        m.shortMargin6 = _margin(m.notional6, shortOrder.leverage);
        m.longFee6 = _fee(m.notional6, longOrder.maxFeeBps);
        m.shortFee6 = _fee(m.notional6, shortOrder.maxFeeBps);
        _checkOpenRisk(fillSize6, fillPrice18, m);
        _checkPositionLimit(longOrder.trader);
        _checkPositionLimit(shortOrder.trader);
        _bind(longOrder, m.longHash);
        _bind(shortOrder, m.shortHash);
        filledSize6[m.longHash] += fillSize6;
        filledSize6[m.shortHash] += fillSize6;
        uint64 pairId = nextPairId++;
        if (pairId == 0 || vault.usedPairIds(pairId)) revert InvalidPair();
        positionCount[longOrder.trader] += 1;
        positionCount[shortOrder.trader] += 1;
        pairs[pairId] = Pair(fillSize6, fillPrice18, m.fundingIndex18, 0, m.longHash, m.shortHash);
        vault.openPair(
            pairId,
            m.longHash,
            m.shortHash,
            longOrder.trader,
            shortOrder.trader,
            m.longMargin6,
            m.shortMargin6,
            m.longFee6,
            m.shortFee6
        );
        emit MatchedFill(pairId, m.longHash, m.shortHash, fillSize6, fillPrice18);
        emit PairOpened(
            pairId,
            m.longHash,
            m.shortHash,
            longOrder.trader,
            shortOrder.trader,
            fillSize6,
            fillPrice18,
            m.longMargin6,
            m.shortMargin6,
            m.longFee6,
            m.shortFee6
        );
        _releaseIfFilled(m.longHash, longOrder.size6);
        _releaseIfFilled(m.shortHash, shortOrder.size6);
    }

    /// @notice Caller-funded escrow for its own signed order, bounded by remaining initial margin plus fee.
    function reserveOrder(ClobAuth.Order calldata order, bytes calldata signature, uint128 amount6) external {
        _requireTrading();
        bytes32 hash = _verifyOrder(order, signature);
        _checkActive(order);
        if (msg.sender != order.trader) revert Unauthorized();
        uint128 remaining = order.size6 - filledSize6[hash];
        if (remaining == 0 || amount6 == 0) revert InvalidReservation();
        uint128 notional = RiskMath.notional6(remaining, order.limitPrice18);
        uint256 maximum = uint256(_margin(notional, order.leverage)) + RiskMath.openingFee6(notional);
        if (amount6 > maximum) revert InvalidReservation();
        _bind(order, hash);
        vault.reserveOrder(hash, order.trader, amount6);
        emit OrderReserved(order.trader, hash, amount6);
    }

    function cancelOrder(ClobAuth.Cancel calldata cancel, bytes calldata signature) external {
        _requireTrading();
        if (cancel.trader == address(0) || cancel.trader.code.length != 0) revert InvalidTrader();
        if (cancel.expiry <= block.timestamp || cancel.expiry > block.timestamp + MAX_ORDER_LIFETIME) {
            revert InvalidExpiry();
        }
        if (msg.sender != cancel.trader) revert Unauthorized();
        bytes32 digest = ClobAuth.cancelDigest(domainSeparator(), cancel);
        if (ClobAuth.recover(digest, signature) != cancel.trader) revert InvalidSignature();
        _cancel(cancel.trader, cancel.orderHash, cancel.nonce);
    }

    /// @notice Cancel before the first onchain fill/reservation, proving the original order identity.
    function cancelSignedOrder(ClobAuth.Order calldata order, bytes calldata signature) external {
        _requireTrading();
        if (msg.sender != order.trader) revert Unauthorized();
        bytes32 hash = _verifyOrder(order, signature);
        _bind(order, hash);
        _cancel(order.trader, hash, order.nonce);
    }

    /// @notice Direct owner cancellation for an order already bound onchain.
    function cancelOrder(bytes32 orderHash_, uint64 nonce) external {
        _requireTrading();
        _cancel(msg.sender, orderHash_, nonce);
    }

    /// @notice Monotonic owner invalidation floor; blocks every nonce below the supplied value.
    function invalidateNonce(uint64 nonce) external {
        _requireTrading();
        uint256 floor = uint256(nonce) + 1;
        if (floor > minimumNonce[msg.sender]) minimumNonce[msg.sender] = floor;
        emit NonceInvalidated(msg.sender, minimumNonce[msg.sender]);
    }

    /// @notice Permissionless release of an expired order's reservation; signature proves the identity.
    function expireOrder(ClobAuth.Order calldata order, bytes calldata signature) external {
        _requireTrading();
        bytes32 hash = _verifyOrder(order, signature);
        if (order.expiry > block.timestamp) revert NotExpired();
        _bind(order, hash);
        cancelled[hash] = true;
        if (vault.reservation(hash).owner != address(0)) vault.releaseOrder(hash);
        emit OrderExpired(order.trader, hash);
    }

    /// @notice Permissionless checkpoint of bounded funding; no close or caller-chosen index/price.
    function settleFunding(uint64 pairId) external {
        _requireTrading();
        Pair storage meta = pairs[pairId];
        if (meta.size6 == 0) revert InvalidPair();
        (, int128 index18) = _freshOracle();
        _applyFunding(pairId, meta, vault.pairMargins(pairId), index18);
    }

    /// @notice Either recorded pair owner may close at a fresh independent oracle price.
    function closePair(uint64 pairId, uint128 closeSize6) external {
        _requireTrading();
        Pair storage meta = pairs[pairId];
        if (meta.size6 == 0) revert InvalidPair();
        (uint128 price18, int128 index18) = _freshOracle();
        AvensVault.PairMargins memory pm = vault.pairMargins(pairId);
        if (msg.sender != pm.longOwner && msg.sender != pm.shortOwner) revert NotPairOwner();
        _applyFunding(pairId, meta, pm, index18);
        pm = vault.pairMargins(pairId);
        RiskMath.Pair memory snap = _snapshot(meta, pm);
        if (closeSize6 == 0 || closeSize6 > meta.size6) revert InvalidFill();
        if (closeSize6 == meta.size6) {
            (uint128 longPayout, uint128 shortPayout,) = RiskMath.payout(snap, price18);
            vault.settlePair(pairId, pm.longMargin6, pm.shortMargin6, longPayout, shortPayout, 0, address(0), 0);
            _deletePair(pairId, pm);
            emit PairClosed(pairId, pm.longOwner, pm.shortOwner, closeSize6, longPayout, shortPayout, 0, address(0), 0);
        } else {
            (RiskMath.Pair memory part, RiskMath.Pair memory left) = RiskMath.split(snap, closeSize6);
            (uint128 longPayout, uint128 shortPayout,) = RiskMath.payout(part, price18);
            vault.settlePair(pairId, part.longMargin6, part.shortMargin6, longPayout, shortPayout, 0, address(0), 0);
            meta.size6 = left.size6;
            meta.entryPrice18 = left.entryPrice18;
            meta.lastFundingIndex18 = left.lastFundingIndex18;
            meta.fundingRemainder = left.fundingRemainder;
            emit PairClosed(pairId, pm.longOwner, pm.shortOwner, closeSize6, longPayout, shortPayout, 0, address(0), 0);
        }
    }

    /// @notice Permissionless full liquidation at a fresh oracle; penalty comes only from the unsafe side.
    function liquidatePair(uint64 pairId) external {
        _requireTrading();
        Pair storage meta = pairs[pairId];
        if (meta.size6 == 0) revert InvalidPair();
        LiquidationInfo memory info;
        (info.price18, info.index18) = _freshOracle();
        AvensVault.PairMargins memory pm = vault.pairMargins(pairId);
        _applyFunding(pairId, meta, pm, info.index18);
        pm = vault.pairMargins(pairId);
        RiskMath.Pair memory snap = _snapshot(meta, pm);
        {
            (bool longUnsafe, bool shortUnsafe) = RiskMath.liquidatable(snap, info.price18, MAINTENANCE_BPS);
            if (!longUnsafe && !shortUnsafe) revert NotLiquidatable();
            (info.longPayout6, info.shortPayout6,) = RiskMath.payout(snap, info.price18);
            info.longLoses = longUnsafe && (!shortUnsafe || info.longPayout6 <= info.shortPayout6);
        }
        uint128 penalty = info.longLoses ? info.longPayout6 : info.shortPayout6;
        uint128 cap = RiskMath.notional6(snap.size6, info.price18) / 100;
        if (penalty > cap) penalty = cap;
        info.reward6 = penalty / 2;
        info.insurance6 = penalty - info.reward6;
        if (info.longLoses) info.longPayout6 -= penalty;
        else info.shortPayout6 -= penalty;
        vault.settlePair(
            pairId,
            pm.longMargin6,
            pm.shortMargin6,
            info.longPayout6,
            info.shortPayout6,
            info.insurance6,
            msg.sender,
            info.reward6
        );
        _deletePair(pairId, pm);
        emit PairClosed(
            pairId,
            pm.longOwner,
            pm.shortOwner,
            snap.size6,
            info.longPayout6,
            info.shortPayout6,
            info.insurance6,
            msg.sender,
            info.reward6
        );
    }

    function _freshOracle() internal view returns (uint128 price18, int128 index18) {
        if (block.chainid != 31337 || block.chainid != deploymentChainId) revert TradingUnavailable();
        T.Price memory observed = oracle.price(marketId);
        if (
            observed.price18 == 0 || observed.price18 > MAX_PRICE18 || observed.sourceTimestamp == 0
                || observed.sourceTimestamp > block.timestamp
                || block.timestamp - observed.sourceTimestamp > maxOracleAge
        ) revert InvalidOracle();
        uint64 validUntil;
        (index18, validUntil) = IFundingOracle(address(oracle)).fundingIndex(marketId);
        if (validUntil == 0 || block.timestamp > validUntil) revert InvalidOracle();
        price18 = observed.price18;
    }

    function _verifyOrder(ClobAuth.Order calldata order, bytes calldata signature)
        internal
        view
        returns (bytes32 hash)
    {
        if (order.kind != 0 || order.reduceOnly || order.postOnly || order.ioc) {
            revert UnsupportedOrder();
        }
        if (order.side > 1) revert InvalidSide();
        if (order.marketId != marketId) revert WrongMarket();
        if (order.trader == address(0) || order.trader.code.length != 0) revert InvalidTrader();
        if (order.size6 == 0 || order.size6 > MAX_SIZE6) revert InvalidSize();
        if (order.limitPrice18 == 0 || order.limitPrice18 > MAX_PRICE18) revert InvalidPrice();
        if (order.leverage == 0 || order.leverage > MAX_LEVERAGE) revert InvalidLeverage();
        if (order.maxFeeBps < FEE_BPS || order.maxFeeBps > BPS) revert InvalidFee();
        if (order.nonce == 0) revert InvalidNonce();
        hash = orderHash(order);
        if (cancelled[hash]) revert OrderUnavailable();
        if (ClobAuth.recover(hash, signature) != order.trader) revert InvalidSignature();
    }

    function _checkActive(ClobAuth.Order calldata order) internal view {
        if (order.expiry <= block.timestamp || order.expiry > block.timestamp + MAX_ORDER_LIFETIME) {
            revert InvalidExpiry();
        }
        if (uint256(order.nonce) < minimumNonce[order.trader]) revert InvalidNonce();
    }

    function _bind(ClobAuth.Order calldata order, bytes32 hash) internal {
        bytes32 existing = nonceHash[order.trader][order.nonce];
        if (existing != bytes32(0) && existing != hash) revert ConflictingNonce();
        nonceHash[order.trader][order.nonce] = hash;
        address known = orderTrader[hash];
        if (known != address(0) && known != order.trader) revert OrderUnavailable();
        orderTrader[hash] = order.trader;
        uint64 knownNonce = orderNonce[hash];
        if (knownNonce != 0 && knownNonce != order.nonce) revert ConflictingNonce();
        orderNonce[hash] = order.nonce;
    }

    function _cancel(address trader, bytes32 hash, uint64 nonce) internal {
        if (hash == bytes32(0) || orderTrader[hash] != trader) revert UnknownOrder();
        uint64 knownNonce = orderNonce[hash];
        if (knownNonce != 0 && knownNonce != nonce) revert ConflictingNonce();
        bytes32 existing = nonceHash[trader][nonce];
        if (existing != bytes32(0) && existing != hash) revert ConflictingNonce();
        nonceHash[trader][nonce] = hash;
        orderNonce[hash] = nonce;
        cancelled[hash] = true;
        if (vault.reservation(hash).owner != address(0)) vault.releaseOrder(hash);
        emit OrderCancelled(trader, hash, nonce);
    }

    function _releaseIfFilled(bytes32 hash, uint128 signedSize6) internal {
        if (filledSize6[hash] >= signedSize6 && vault.reservation(hash).owner != address(0)) {
            vault.releaseOrder(hash);
        }
    }

    function _checkPositionLimit(address trader) internal view {
        if (positionCount[trader] >= MAX_POSITIONS) revert PositionLimit();
    }

    function _checkBand(uint128 fillPrice18, uint128 reference18) internal pure {
        uint256 difference = fillPrice18 > reference18 ? fillPrice18 - reference18 : reference18 - fillPrice18;
        if (difference * BPS > uint256(reference18) * 100) revert PriceBand();
    }

    function _checkOpenRisk(uint128 size6, uint128 price18, MatchInfo memory m) internal pure {
        RiskMath.Pair memory snapshot =
            RiskMath.Pair(size6, price18, m.longMargin6, m.shortMargin6, m.fundingIndex18, 0);
        (bool longUnsafe, bool shortUnsafe) = RiskMath.liquidatable(snapshot, m.oraclePrice18, MAINTENANCE_BPS);
        if (longUnsafe || shortUnsafe) revert InvalidPair();
    }

    function _applyFunding(uint64 pairId, Pair storage meta, AvensVault.PairMargins memory pm, int128 index18)
        internal
    {
        if (index18 == meta.lastFundingIndex18) return;
        RiskMath.Pair memory snapshot = RiskMath.Pair(
            meta.size6,
            meta.entryPrice18,
            pm.longMargin6,
            pm.shortMargin6,
            meta.lastFundingIndex18,
            meta.fundingRemainder
        );
        (int128 payment, int128 remainder) = RiskMath.fundingSettlement(snapshot, index18);
        if (payment != 0) vault.transferFunding(pairId, payment);
        meta.lastFundingIndex18 = index18;
        meta.fundingRemainder = remainder;
        emit FundingSettled(pairId, payment, index18);
    }

    function _snapshot(Pair storage meta, AvensVault.PairMargins memory pm)
        internal
        view
        returns (RiskMath.Pair memory)
    {
        return RiskMath.Pair(
            meta.size6,
            meta.entryPrice18,
            pm.longMargin6,
            pm.shortMargin6,
            meta.lastFundingIndex18,
            meta.fundingRemainder
        );
    }

    function _deletePair(uint64 pairId, AvensVault.PairMargins memory pm) internal {
        delete pairs[pairId];
        positionCount[pm.longOwner] -= 1;
        positionCount[pm.shortOwner] -= 1;
    }

    function _margin(uint128 notional6, uint32 leverage) internal pure returns (uint128) {
        uint256 margin = U.ceilDiv(notional6, leverage);
        if (margin > type(uint128).max) revert InvalidSize();
        return uint128(margin);
    }

    function _fee(uint128 notional6, uint16 maxFeeBps) internal pure returns (uint128 fee) {
        fee = RiskMath.openingFee6(notional6);
        if (uint256(fee) > U.ceilDiv(uint256(notional6) * maxFeeBps, BPS)) revert InvalidFee();
    }

    function _requireTrading() internal view {
        if (block.chainid != 31337 || block.chainid != deploymentChainId) revert TradingUnavailable();
    }
}
