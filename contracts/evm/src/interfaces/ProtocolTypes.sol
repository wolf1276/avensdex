// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @notice Version-one interface types. Implementations must enforce MODULE_CONTRACT.md.
library ProtocolTypes {
    struct Book {
        address owner; // Zero strategyId is the owner's manual book.
        uint64 strategyId;
    }

    struct Authority {
        address actor;
        uint64 policyRevision;
        uint64 nonce;
    }

    struct Order {
        uint32 marketId;
        bool isLong;
        uint128 size6;
        uint128 limitPrice18;
        uint32 leverage;
        bool postOnly;
        bool immediateOrCancel;
        bool reduceOnly;
        uint64 expiry;
    }

    struct Policy {
        address executor;
        address spotAdapter;
        bytes32 routeId;
        uint32 marketId;
        uint64 revision;
        uint64 expiry;
        uint8 permissions;
        uint128 maxNotional6;
        uint128 maxDelta6;
        uint128 minReserve6;
        uint128 maxCosts6;
        uint128 maxTurnover6;
        uint128 minNetCarry6;
        uint32 maxActions;
        uint32 maxHorizonSeconds;
        uint32 cooldownSeconds;
        uint32 maxDeltaSeconds;
        uint16 maxSlippageBps;
        bool executionValidation;
    }

    struct SpotAction {
        Book book;
        Authority authority;
        bool buyBase;
        uint128 amountIn;
        uint256 minAmountOut;
        uint64 deadline;
    }

    struct PairMargins {
        Book longBook;
        Book shortBook;
        uint128 longMargin6;
        uint128 shortMargin6;
    }

    struct Accounting {
        uint256 custody;
        uint256 liabilities;
        uint256 surplus;
    }

    struct Price {
        uint128 price18;
        uint64 sourceTimestamp;
    }

    struct Readiness {
        uint256 chainId;
        bytes32 deploymentId;
        bool ready;
        bool paused;
        uint64 validUntil;
    }
}
