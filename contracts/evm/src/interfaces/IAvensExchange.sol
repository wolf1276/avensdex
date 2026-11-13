// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import {ProtocolTypes as T} from "./ProtocolTypes.sol";
import {FundingMath as F} from "../libraries/FundingMath.sol";

interface IAvensExchange {
    function placeOrder(uint64 strategyId, uint64 nonce, T.Order calldata order) external returns (uint64 orderId);
    function cancelOrder(uint64 orderId) external;
    function cancelAll(uint64 strategyId, uint32 marketId) external;
    function expireOrder(uint64 orderId) external;
    function matchOrders(uint64 makerOrderId, uint64 takerOrderId) external returns (uint64 pairId);
    function closePosition(uint64 pairId, uint64 strategyId, uint128 size6, uint128 minPrice18, uint128 maxPrice18)
        external;
    function settleFunding(uint64 pairId) external;
    function liquidate(uint64 pairId) external;
    function updateFunding(uint32 marketId) external;
    function configureFunding(uint32 marketId, F.Mode mode, F.Params calldata params) external;
    function setRiskPaused(bool paused) external;

    // Only the frozen executor may forward an actor; owner/book checks remain mandatory.
    function placeStrategyOrder(T.Book calldata book, T.Authority calldata authority, T.Order calldata order)
        external
        returns (uint64 orderId);
    function cancelStrategyOrder(uint64 orderId, T.Authority calldata authority) external;
    function closeStrategyPosition(
        uint64 pairId,
        T.Book calldata book,
        T.Authority calldata authority,
        uint128 size6,
        uint128 minPrice18,
        uint128 maxPrice18
    ) external;
}
