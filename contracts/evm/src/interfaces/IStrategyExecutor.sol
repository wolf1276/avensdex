// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import {ProtocolTypes as T} from "./ProtocolTypes.sol";

interface IStrategyExecutor {
    function executeSpot(T.SpotAction calldata action) external returns (uint256 rawReceived);
    function executePerp(T.Book calldata book, T.Authority calldata authority, T.Order calldata order)
        external
        returns (uint64 orderId);
    function executePerpBatch(T.Book[] calldata books, T.Authority[] calldata authorities, T.Order[] calldata orders)
        external
        returns (uint64[] memory orderIds);
    function cancelPerp(uint64 orderId, T.Authority calldata authority) external;
    function closePerp(
        uint64 pairId,
        T.Book calldata book,
        T.Authority calldata authority,
        uint128 size6,
        uint128 minPrice18,
        uint128 maxPrice18
    ) external;
}
