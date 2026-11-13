// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import {ProtocolTypes as T} from "./ProtocolTypes.sol";

interface IAvensVault {
    function collateralToken() external view returns (address);
    function baseToken() external view returns (address);
    function deploymentId() external view returns (bytes32);
    function bindModules(address exchange, address executor) external;
    function activateDeposits() external;
    function deposit(uint128 amount6) external;
    function withdraw(uint128 amount6) external; // Recipient is msg.sender, never a supplied address.
    function createStrategy(uint128 collateralCap6) external returns (uint64 strategyId);
    function allocate(uint64 strategyId, uint128 amount6) external;
    function release(uint64 strategyId, uint128 amount6) external;
    function setStrategyPaused(uint64 strategyId, bool paused) external;
    function approvePolicy(uint64 strategyId, T.Policy calldata policy) external;
    function revokePolicy(uint64 strategyId) external;
    function withdrawStrategy(uint64 strategyId, uint128 amount6) external;
    function withdrawStrategyBase(uint64 strategyId, uint256 rawAmount) external;
    function closeStrategy(uint64 strategyId) external;
    function freeBalance(T.Book calldata book) external view returns (uint128);
    function nextNonce(T.Book calldata book) external view returns (uint64);
    function pairMargins(uint64 pairId) external view returns (T.PairMargins memory);
    function accounting(address token) external view returns (T.Accounting memory);

    // Exchange-only accounting operations: recipients derive from recorded reservations/pairs.
    function reserveOrder(T.Book calldata book, T.Authority calldata authority, uint64 orderId, uint128 amount6)
        external;
    function releaseOrder(uint64 orderId, uint128 amount6) external;
    function openPair(
        uint64 pairId,
        uint64 longOrderId,
        uint64 shortOrderId,
        uint128 longMargin6,
        uint128 shortMargin6,
        uint128 longFee6,
        uint128 shortFee6
    ) external;
    function transferFunding(uint64 pairId, int128 longPayment6) external;
    function settlePair(
        uint64 pairId,
        uint128 longReleasedMargin6,
        uint128 shortReleasedMargin6,
        uint128 longPayout6,
        uint128 shortPayout6,
        uint128 insurance6,
        address liquidator,
        uint128 reward6
    ) external;
    function consumeStrategyAction(T.Book calldata book, T.Authority calldata authority, uint8 permission) external;

    // Executor-only spot operation; configured route, approvals and measured deltas live in the vault.
    function executeSpot(T.SpotAction calldata action) external returns (uint256 rawReceived);
}
