// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import {ProtocolTypes as T} from "./ProtocolTypes.sol";

interface IOracleAdapter {
    /// @notice Revert on invalid/nonpositive/future/stale source data; never return a chart fallback.
    function price(uint32 marketId) external view returns (T.Price memory);
}
