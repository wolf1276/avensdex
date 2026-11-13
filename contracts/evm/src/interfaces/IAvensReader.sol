// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import {ProtocolTypes as T} from "./ProtocolTypes.sol";

interface IAvensReader {
    /// @notice Aggregate one-block reads only; readiness must fail closed when dependencies are unqualified.
    function readiness(uint32 marketId) external view returns (T.Readiness memory);
    function account(T.Book calldata book) external view returns (uint128 free6, uint64 nextNonce);
    function custody(address token) external view returns (T.Accounting memory);
    function pairMargins(uint64 pairId) external view returns (T.PairMargins memory);
}
