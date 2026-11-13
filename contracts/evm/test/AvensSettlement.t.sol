// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AvensVault} from "../src/AvensVault.sol";
import {AvensOracle} from "../src/AvensOracle.sol";
import {AvensSettlement, IFundingOracle} from "../src/AvensSettlement.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {ProtocolTypes as T} from "../src/interfaces/ProtocolTypes.sol";
import {ClobAuth} from "../src/libraries/ClobAuth.sol";
import {MockVaultToken} from "./AvensVault.t.sol";

interface VmSettlement {
    function chainId(uint256 newChainId) external;
    function warp(uint256 newTimestamp) external;
    function prank(address msgSender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external returns (address);
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
}

contract BadOracle is IOracleAdapter, IFundingOracle {
    T.Price private observation;
    int128 private index18;
    uint64 private validUntil;

    function set(uint128 price18, uint64 sourceTimestamp, int128 index, uint64 validUntil_) external {
        observation = T.Price(price18, sourceTimestamp);
        index18 = index;
        validUntil = validUntil_;
    }

    function price(uint32) external view returns (T.Price memory) {
        return observation;
    }

    function fundingIndex(uint32) external view returns (int128, uint64) {
        return (index18, validUntil);
    }
}

contract AvensSettlementTest {
    VmSettlement constant vm = VmSettlement(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint128 constant CAP = 1_000_000e6;
    uint32 constant MARKET = 1;
    uint64 constant MAX_AGE = 60;
    uint128 constant PRICE = 1000e18;
    bytes32 constant DEPLOYMENT = keccak256("avensdex.settlement.test");
    address constant PRICE_PUBLISHER = address(0xBEEF);
    address constant FUNDING_PUBLISHER = address(0xF00D);
    address constant KEEPER = address(0xCAFE);
    address constant OTHER = address(0x1234);

    MockVaultToken token;
    AvensVault vault;
    AvensOracle oracle;
    AvensSettlement settlement;

    uint256 aliceKey;
    uint256 bobKey;
    address ALICE;
    address BOB;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_000_000);
        aliceKey = uint256(keccak256("avensdex settlement alice"));
        bobKey = uint256(keccak256("avensdex settlement bob"));
        ALICE = vm.addr(aliceKey);
        BOB = vm.addr(bobKey);

        token = new MockVaultToken(6);
        vault = new AvensVault(address(token), DEPLOYMENT, CAP);
        oracle = new AvensOracle(MARKET, PRICE_PUBLISHER, FUNDING_PUBLISHER, MAX_AGE);
        settlement = new AvensSettlement(vault, oracle, MARKET, MAX_AGE);
        vault.bindSettlement(address(settlement));
        vault.activateDeposits();
        _deposit(ALICE, 10_000e6);
        _deposit(BOB, 10_000e6);
        _publishPrice(PRICE);
        _setFunding(0, 3600);
    }

    function _deposit(address owner, uint128 amount6) internal {
        token.mint(owner, amount6);
        vm.prank(owner);
        token.approve(address(vault), amount6);
        vm.prank(owner);
        vault.deposit(amount6);
    }

    function _publishPrice(uint128 price18) internal {
        vm.prank(PRICE_PUBLISHER);
        oracle.publishPrice(price18, uint64(block.timestamp));
    }

    function _setFunding(int128 rate, uint64 duration) internal {
        vm.prank(FUNDING_PUBLISHER);
        oracle.setFundingRate(rate, uint64(block.timestamp) + duration);
    }

    function _order(
        address trader,
        uint8 side,
        uint128 size6,
        uint128 limitPrice18,
        uint32 leverage,
        uint64 nonce,
        uint64 expiry
    ) internal pure returns (ClobAuth.Order memory) {
        return ClobAuth.Order({
            trader: trader,
            marketId: MARKET,
            side: side,
            kind: 0,
            size6: size6,
            limitPrice18: limitPrice18,
            leverage: leverage,
            maxFeeBps: 10,
            nonce: nonce,
            expiry: expiry,
            reduceOnly: false,
            postOnly: false,
            ioc: false
        });
    }

    function _sign(ClobAuth.Order memory order, uint256 key) internal returns (bytes memory) {
        return _signFor(settlement, order, key);
    }

    function _signFor(AvensSettlement target, ClobAuth.Order memory order, uint256 key)
        internal
        returns (bytes memory)
    {
        bytes32 digest = ClobAuth.orderDigest(ClobAuth.domainSeparator(block.chainid, address(target)), order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _cancelSig(address trader, bytes32 hash, uint64 nonce, uint64 expiry, uint256 key)
        internal
        returns (ClobAuth.Cancel memory cancel, bytes memory signature)
    {
        cancel = ClobAuth.Cancel(trader, hash, nonce, expiry);
        bytes32 digest = ClobAuth.cancelDigest(ClobAuth.domainSeparator(block.chainid, address(settlement)), cancel);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _defaultMatch(uint128 size6) internal returns (bytes32 longHash, bytes32 shortHash) {
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, size6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, size6, PRICE, 10, 1, expiry);
        longHash = settlement.orderHash(longOrder);
        shortHash = settlement.orderHash(shortOrder);
        settlement.matchOrders(
            longOrder, _sign(longOrder, aliceKey), shortOrder, _sign(shortOrder, bobKey), size6, PRICE
        );
    }

    function _accountingReconciled() internal view {
        (uint256 custody, uint256 liabilities, uint256 surplus) = vault.accounting();
        require(custody == liabilities && surplus == 0, "conservation");
        require(
            liabilities
                == vault.totalFree6() + vault.totalEscrow6() + vault.totalPairMargin6() + vault.feeBalance6()
                    + vault.insuranceBalance6(),
            "buckets"
        );
    }

    function testConstructorBindingAndDomain() public view {
        require(settlement.deploymentId() == DEPLOYMENT);
        require(address(settlement.vault()) == address(vault));
        require(address(settlement.oracle()) == address(oracle));
        require(settlement.marketId() == MARKET);
        require(settlement.maxOracleAge() == MAX_AGE);
        require(settlement.deploymentChainId() == 31337);
        require(vault.settlementModule() == address(settlement));
        require(settlement.domainSeparator() == ClobAuth.domainSeparator(31337, address(settlement)));
    }

    function testConstructorRejectsBadConfiguration() public {
        vm.expectRevert();
        new AvensSettlement(AvensVault(address(0)), oracle, MARKET, MAX_AGE);
        vm.expectRevert();
        new AvensSettlement(vault, IOracleAdapter(address(0)), MARKET, MAX_AGE);
        vm.expectRevert();
        new AvensSettlement(vault, IOracleAdapter(address(0x1234)), MARKET, MAX_AGE);
        vm.expectRevert();
        new AvensSettlement(vault, IOracleAdapter(address(vault)), MARKET, MAX_AGE);
        vm.expectRevert();
        new AvensSettlement(vault, oracle, 0, MAX_AGE);
        vm.expectRevert();
        new AvensSettlement(vault, oracle, 9, MAX_AGE);
        vm.expectRevert();
        new AvensSettlement(vault, IOracleAdapter(address(token)), MARKET, MAX_AGE);
        vm.expectRevert();
        new AvensSettlement(vault, oracle, MARKET, 0);
        vm.expectRevert();
        new AvensSettlement(vault, oracle, MARKET, 3601);
        vm.chainId(1);
        vm.expectRevert();
        new AvensSettlement(vault, oracle, MARKET, MAX_AGE);
    }

    function testFujiAndCrossChainWritesDisabled() public {
        vm.chainId(43113);
        vm.expectRevert(AvensSettlement.TradingUnavailable.selector);
        settlement.invalidateNonce(1);
        vm.expectRevert(AvensSettlement.TradingUnavailable.selector);
        settlement.cancelOrder(bytes32(uint256(1)), 1);
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory order = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        vm.expectRevert(AvensSettlement.TradingUnavailable.selector);
        settlement.reserveOrder(order, hex"", 1);
    }

    function testSignedFillFundingPartialFullCloseAndWithdrawal() public {
        bytes32 longHash;
        bytes32 shortHash;
        uint128 aliceBefore = vault.freeBalance(ALICE);
        uint128 bobBefore = vault.freeBalance(BOB);
        (longHash, shortHash) = _defaultMatch(1e6);

        require(settlement.filledSize6(longHash) == 1e6);
        require(settlement.filledSize6(shortHash) == 1e6);
        require(settlement.nextPairId() == 2);
        require(settlement.positionCount(ALICE) == 1);
        require(settlement.positionCount(BOB) == 1);
        AvensVault.PairMargins memory margins = vault.pairMargins(1);
        require(margins.longMargin6 == 100e6 && margins.shortMargin6 == 100e6);
        require(vault.feeBalance6() == 600_000);
        _accountingReconciled();

        _setFunding(1e15, 1800);
        vm.warp(block.timestamp + 1800);
        _publishPrice(PRICE);

        vm.prank(ALICE);
        settlement.closePair(1, 400_000);
        (uint128 size6,,,,,) = settlement.pairs(1);
        require(size6 == 600_000);
        margins = vault.pairMargins(1);
        require(margins.longMargin6 == 58_920_000 && margins.shortMargin6 == 61_080_000);

        vm.prank(BOB);
        settlement.closePair(1, 600_000);
        (size6,,,,,) = settlement.pairs(1);
        require(size6 == 0);
        require(settlement.positionCount(ALICE) == 0 && settlement.positionCount(BOB) == 0);
        require(vault.freeBalance(ALICE) == aliceBefore - 300_000 - 1_800_000);
        require(vault.freeBalance(BOB) == bobBefore - 300_000 + 1_800_000);
        _accountingReconciled();

        uint256 tokenBefore = token.balanceOf(ALICE);
        uint128 aliceFree = vault.freeBalance(ALICE);
        vm.prank(ALICE);
        vault.withdraw(aliceFree);
        require(token.balanceOf(ALICE) == tokenBefore + aliceFree);
        require(vault.freeBalance(ALICE) == 0);
        _accountingReconciled();
    }

    function testMatchedFillEventExact() public {
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 1e6, PRICE, 10, 1, expiry);
        bytes32 longHash = settlement.orderHash(longOrder);
        bytes32 shortHash = settlement.orderHash(shortOrder);
        vm.expectEmit(true, true, true, true, address(settlement));
        emit AvensSettlement.MatchedFill(1, longHash, shortHash, 1e6, PRICE);
        settlement.matchOrders(longOrder, _sign(longOrder, aliceKey), shortOrder, _sign(shortOrder, bobKey), 1e6, PRICE);
    }

    function testRejectsForgeryHighSDomainAndFieldTampering() public {
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 1e6, PRICE, 10, 1, expiry);
        bytes memory shortSig = _sign(shortOrder, bobKey);

        vm.expectRevert(AvensSettlement.InvalidSignature.selector);
        settlement.matchOrders(longOrder, _sign(longOrder, bobKey), shortOrder, shortSig, 1e6, PRICE);

        bytes memory highS = _malleate(_sign(longOrder, aliceKey));
        vm.expectRevert();
        settlement.matchOrders(longOrder, highS, shortOrder, shortSig, 1e6, PRICE);

        bytes32 wrongDomainDigest = ClobAuth.orderDigest(ClobAuth.domainSeparator(1, address(settlement)), longOrder);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, wrongDomainDigest);
        vm.expectRevert(AvensSettlement.InvalidSignature.selector);
        settlement.matchOrders(longOrder, abi.encodePacked(r, s, v), shortOrder, shortSig, 1e6, PRICE);

        bytes memory validSig = _sign(longOrder, aliceKey);
        longOrder.limitPrice18 = PRICE + 1;
        vm.expectRevert(AvensSettlement.InvalidSignature.selector);
        settlement.matchOrders(longOrder, validSig, shortOrder, shortSig, 1e6, PRICE);
    }

    function _malleate(bytes memory signature) internal pure returns (bytes memory) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        uint256 n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        return abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
    }

    function testNonceBindingReplayAndConflictingPayload() public {
        _defaultMatch(1e6);
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory replayLong = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory replayShort = _order(BOB, 1, 1e6, PRICE, 10, 1, expiry);
        vm.expectRevert(AvensSettlement.InvalidFill.selector);
        settlement.matchOrders(
            replayLong, _sign(replayLong, aliceKey), replayShort, _sign(replayShort, bobKey), 1e6, PRICE
        );

        ClobAuth.Order memory conflicting = _order(ALICE, 0, 2e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory freshShort = _order(BOB, 1, 2e6, PRICE, 10, 2, expiry);
        vm.expectRevert(AvensSettlement.ConflictingNonce.selector);
        settlement.matchOrders(
            conflicting, _sign(conflicting, aliceKey), freshShort, _sign(freshShort, bobKey), 1e6, PRICE
        );
    }

    function testCancellationRacesResolveOnchain() public {
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 1e6, PRICE, 10, 1, expiry);
        bytes memory longSig = _sign(longOrder, aliceKey);
        bytes32 longHash = settlement.orderHash(longOrder);

        vm.prank(ALICE);
        settlement.reserveOrder(longOrder, longSig, 100_300_000);
        require(vault.totalEscrow6() == 100_300_000);
        (ClobAuth.Cancel memory cancel, bytes memory cancelSig) = _cancelSig(ALICE, longHash, 1, expiry, aliceKey);
        vm.prank(ALICE);
        settlement.cancelOrder(cancel, cancelSig);
        require(settlement.cancelled(longHash));
        require(settlement.minimumNonce(ALICE) == 0);
        require(vault.totalEscrow6() == 0);
        vm.expectRevert();
        settlement.matchOrders(longOrder, longSig, shortOrder, _sign(shortOrder, bobKey), 1e6, PRICE);

        ClobAuth.Order memory newLong = _order(ALICE, 0, 1e6, PRICE, 10, 2, expiry);
        ClobAuth.Order memory newShort = _order(BOB, 1, 1e6, PRICE, 10, 2, expiry);
        settlement.matchOrders(newLong, _sign(newLong, aliceKey), newShort, _sign(newShort, bobKey), 1e6, PRICE);
        require(settlement.filledSize6(settlement.orderHash(newLong)) == 1e6);
    }

    function testMatchBeforeCancelKeepsFillAndReleasesOnlyRemainder() public {
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 1e6, PRICE, 10, 1, expiry);
        bytes memory longSig = _sign(longOrder, aliceKey);
        bytes32 longHash = settlement.orderHash(longOrder);
        vm.prank(ALICE);
        settlement.reserveOrder(longOrder, longSig, 100_300_000);

        settlement.matchOrders(longOrder, longSig, shortOrder, _sign(shortOrder, bobKey), 400_000, PRICE);
        require(settlement.filledSize6(longHash) == 400_000);
        require(vault.totalEscrow6() == 60_180_000);

        (ClobAuth.Cancel memory cancel, bytes memory cancelSig) = _cancelSig(ALICE, longHash, 1, expiry, aliceKey);
        vm.prank(ALICE);
        settlement.cancelOrder(cancel, cancelSig);
        require(settlement.cancelled(longHash));
        require(vault.totalEscrow6() == 0);
        require(settlement.positionCount(ALICE) == 1);
        _accountingReconciled();
    }

    function testReservationAuthorizationBoundsDirectCancelAndExpiry() public {
        uint64 expiry = uint64(block.timestamp) + 100;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        bytes memory longSig = _sign(longOrder, aliceKey);
        bytes32 longHash = settlement.orderHash(longOrder);

        vm.prank(BOB);
        vm.expectRevert(AvensSettlement.Unauthorized.selector);
        settlement.reserveOrder(longOrder, longSig, 1);

        vm.prank(ALICE);
        vm.expectRevert(AvensSettlement.InvalidReservation.selector);
        settlement.reserveOrder(longOrder, longSig, 100_300_001);

        vm.prank(ALICE);
        settlement.reserveOrder(longOrder, longSig, 100_300_000);
        require(vault.totalEscrow6() == 100_300_000);
        vm.prank(ALICE);
        settlement.cancelOrder(longHash, 1);
        require(vault.totalEscrow6() == 0);
        require(settlement.minimumNonce(ALICE) == 0);

        ClobAuth.Order memory second = _order(ALICE, 0, 1e6, PRICE, 10, 2, expiry);
        bytes memory secondSig = _sign(second, aliceKey);
        vm.prank(ALICE);
        settlement.reserveOrder(second, secondSig, 100_300_000);
        require(vault.totalEscrow6() == 100_300_000);
        vm.warp(expiry + 1);
        settlement.expireOrder(second, secondSig);
        require(vault.totalEscrow6() == 0);
        require(settlement.cancelled(settlement.orderHash(second)));

        vm.prank(ALICE);
        settlement.invalidateNonce(9);
        require(settlement.minimumNonce(ALICE) == 10);
        vm.prank(ALICE);
        settlement.invalidateNonce(3);
        require(settlement.minimumNonce(ALICE) == 10);
    }

    function testInsufficientEitherSideRollsBackFillAndFees() public {
        uint128 bobFree = vault.freeBalance(BOB);
        vm.prank(BOB);
        vault.withdraw(bobFree - 1);
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 1e6, PRICE, 10, 1, expiry);
        bytes32 longHash = settlement.orderHash(longOrder);
        bytes32 shortHash = settlement.orderHash(shortOrder);
        vm.expectRevert();
        settlement.matchOrders(longOrder, _sign(longOrder, aliceKey), shortOrder, _sign(shortOrder, bobKey), 1e6, PRICE);
        require(settlement.filledSize6(longHash) == 0 && settlement.filledSize6(shortHash) == 0);
        require(vault.feeBalance6() == 0 && vault.totalPairMargin6() == 0);
        require(settlement.nextPairId() == 1);

        uint128 aliceFree = vault.freeBalance(ALICE);
        vm.prank(ALICE);
        vault.withdraw(aliceFree - 1);
        vm.expectRevert();
        settlement.matchOrders(longOrder, _sign(longOrder, aliceKey), shortOrder, _sign(shortOrder, bobKey), 1e6, PRICE);
        require(settlement.filledSize6(longHash) == 0);
        require(vault.feeBalance6() == 0 && settlement.nextPairId() == 1);
        _accountingReconciled();
    }

    function testUnsupportedOrderKindsAndFlags() public {
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 1e6, PRICE, 10, 1, expiry);

        longOrder.kind = 1;
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.kind = 0;
        longOrder.reduceOnly = true;
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.reduceOnly = false;
        longOrder.postOnly = true;
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.postOnly = false;
        longOrder.ioc = true;
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.ioc = false;
        longOrder.side = 1;
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.side = 0;
        shortOrder.side = 0;
        _expectMatchRevert(longOrder, shortOrder);
    }

    function _expectMatchRevert(ClobAuth.Order memory longOrder, ClobAuth.Order memory shortOrder) internal {
        vm.expectRevert();
        settlement.matchOrders(longOrder, _sign(longOrder, aliceKey), shortOrder, _sign(shortOrder, bobKey), 1e6, PRICE);
    }

    function testOrderBoundPriceFeeLeverageOracleAndNotional() public {
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 1e6, PRICE, 10, 1, expiry);

        longOrder.size6 = 1e15 + 1;
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.size6 = 1e6;
        longOrder.limitPrice18 = 1e27 + 1;
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.limitPrice18 = PRICE;
        longOrder.leverage = 0;
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.leverage = 11;
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.leverage = 10;
        longOrder.maxFeeBps = 2;
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.maxFeeBps = 10_001;
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.maxFeeBps = 10;
        longOrder.expiry = uint64(block.timestamp) + 86_401;
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.expiry = uint64(block.timestamp);
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.expiry = expiry;
        longOrder.nonce = 0;
        _expectMatchRevert(longOrder, shortOrder);

        longOrder.nonce = 1;
        longOrder.limitPrice18 = 999e18;
        _expectMatchRevert(longOrder, shortOrder);
        longOrder.limitPrice18 = PRICE;
        longOrder.size6 = 1;
        longOrder.limitPrice18 = 1e18;
        shortOrder.size6 = 1;
        shortOrder.limitPrice18 = 1e18;
        _expectMatchRevert(longOrder, shortOrder);

        longOrder.size6 = 1e6;
        longOrder.limitPrice18 = 2000e18;
        shortOrder.size6 = 1e6;
        shortOrder.limitPrice18 = PRICE;
        vm.expectRevert();
        settlement.matchOrders(
            longOrder, _sign(longOrder, aliceKey), shortOrder, _sign(shortOrder, bobKey), 1e6, 1020e18
        );

        vm.warp(block.timestamp + MAX_AGE + 1);
        vm.expectRevert();
        settlement.matchOrders(longOrder, _sign(longOrder, aliceKey), shortOrder, _sign(shortOrder, bobKey), 1e6, PRICE);
    }

    function testBadOracleFreshnessAndFundingExpiryFailClosed() public {
        BadOracle bad = new BadOracle();
        AvensSettlement candidate = new AvensSettlement(vault, bad, MARKET, MAX_AGE);
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 1e6, PRICE, 10, 1, expiry);
        bytes32 digestLong =
            ClobAuth.orderDigest(ClobAuth.domainSeparator(block.chainid, address(candidate)), longOrder);
        bytes32 digestShort =
            ClobAuth.orderDigest(ClobAuth.domainSeparator(block.chainid, address(candidate)), shortOrder);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(aliceKey, digestLong);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(bobKey, digestShort);
        bytes memory longSig = abi.encodePacked(r1, s1, v1);
        bytes memory shortSig = abi.encodePacked(r2, s2, v2);

        bad.set(0, uint64(block.timestamp), 0, uint64(block.timestamp) + 3600);
        vm.expectRevert(AvensSettlement.InvalidOracle.selector);
        candidate.matchOrders(longOrder, longSig, shortOrder, shortSig, 1e6, PRICE);
        bad.set(PRICE, uint64(block.timestamp + 1), 0, uint64(block.timestamp) + 3600);
        vm.expectRevert(AvensSettlement.InvalidOracle.selector);
        candidate.matchOrders(longOrder, longSig, shortOrder, shortSig, 1e6, PRICE);
        bad.set(PRICE, uint64(block.timestamp) - MAX_AGE - 1, 0, uint64(block.timestamp) + 3600);
        vm.expectRevert(AvensSettlement.InvalidOracle.selector);
        candidate.matchOrders(longOrder, longSig, shortOrder, shortSig, 1e6, PRICE);
        bad.set(PRICE, uint64(block.timestamp), 0, uint64(block.timestamp) - 1);
        vm.expectRevert(AvensSettlement.InvalidOracle.selector);
        candidate.matchOrders(longOrder, longSig, shortOrder, shortSig, 1e6, PRICE);
    }

    function testSelfTradeRejected() public {
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(ALICE, 1, 1e6, PRICE, 10, 2, expiry);
        vm.expectRevert(AvensSettlement.InvalidTrader.selector);
        settlement.matchOrders(
            longOrder, _sign(longOrder, aliceKey), shortOrder, _sign(shortOrder, aliceKey), 1e6, PRICE
        );
    }

    function testPositionLimitThirtyTwoActivePairs() public {
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 33e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 33e6, PRICE, 10, 1, expiry);
        bytes memory longSig = _sign(longOrder, aliceKey);
        bytes memory shortSig = _sign(shortOrder, bobKey);
        for (uint256 i; i < 32; i++) {
            settlement.matchOrders(longOrder, longSig, shortOrder, shortSig, 1e6, PRICE);
        }
        require(settlement.positionCount(ALICE) == 32);
        require(settlement.positionCount(BOB) == 32);
        vm.expectRevert(AvensSettlement.PositionLimit.selector);
        settlement.matchOrders(longOrder, longSig, shortOrder, shortSig, 1e6, PRICE);
        require(settlement.filledSize6(settlement.orderHash(longOrder)) == 32e6);
        _accountingReconciled();
    }

    function testCappedGainAndLossCounterpartyIsolation() public {
        _defaultMatch(1e6);
        uint128 aliceBefore = vault.freeBalance(ALICE);
        uint128 bobBefore = vault.freeBalance(BOB);
        _publishPrice(2000e18);
        vm.prank(ALICE);
        settlement.closePair(1, 1e6);
        require(vault.freeBalance(ALICE) == aliceBefore + 200e6);
        require(vault.freeBalance(BOB) == bobBefore);
        require(vault.feeBalance6() == 600_000);
        _accountingReconciled();

        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, 2000e18, 10, 2, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 1e6, 2000e18, 10, 2, expiry);
        settlement.matchOrders(
            longOrder, _sign(longOrder, aliceKey), shortOrder, _sign(shortOrder, bobKey), 1e6, 2000e18
        );
        _publishPrice(1000e18);
        vm.prank(BOB);
        settlement.closePair(2, 1e6);
        require(vault.insuranceBalance6() == 0);
        _accountingReconciled();
    }

    function testPartialCloseDustIsRetained() public {
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 3e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 3e6, PRICE, 9, 1, expiry);
        settlement.matchOrders(longOrder, _sign(longOrder, aliceKey), shortOrder, _sign(shortOrder, bobKey), 3e6, PRICE);
        AvensVault.PairMargins memory before = vault.pairMargins(1);
        require(before.longMargin6 == 300e6);
        require(before.shortMargin6 == 333_333_334);
        vm.prank(ALICE);
        settlement.closePair(1, 1e6);
        AvensVault.PairMargins memory afterPart = vault.pairMargins(1);
        require(afterPart.longMargin6 + 100e6 == before.longMargin6);
        require(afterPart.shortMargin6 + 111_111_111 == before.shortMargin6);
        (uint128 size6,,,,,) = settlement.pairs(1);
        require(size6 == 2e6);
        vm.prank(ALICE);
        settlement.closePair(1, 2e6);
        require(vault.pairMargins(1).longOwner == address(0));
        _accountingReconciled();
    }

    function testFundingRemainderSignReversalAndReplay() public {
        _defaultMatch(1e6);
        _setFunding(1, 3600);
        vm.warp(block.timestamp + 1);
        _publishPrice(PRICE);
        vm.prank(ALICE);
        settlement.closePair(1, 1);
        (uint128 size6,,, int128 remainder,,) = settlement.pairs(1);
        require(size6 == 999_999);
        require(remainder == 999_999);

        _setFunding(-1, 3600);
        vm.warp(block.timestamp + 1);
        _publishPrice(PRICE);
        vm.prank(ALICE);
        settlement.closePair(1, 999_999);
        require(vault.pairMargins(1).longOwner == address(0));
        _accountingReconciled();
    }

    function testSameIndexFundingIsIdempotent() public {
        _defaultMatch(1e6);
        _setFunding(1e15, 1800);
        vm.warp(block.timestamp + 1800);
        _publishPrice(PRICE);
        vm.prank(ALICE);
        settlement.closePair(1, 400_000);
        AvensVault.PairMargins memory first = vault.pairMargins(1);
        vm.prank(ALICE);
        settlement.closePair(1, 100_000);
        AvensVault.PairMargins memory second = vault.pairMargins(1);
        uint128 releasedLong = uint128(uint256(first.longMargin6) * 100_000 / 600_000);
        uint128 releasedShort = uint128(uint256(first.shortMargin6) * 100_000 / 600_000);
        require(second.longMargin6 == first.longMargin6 - releasedLong);
        require(second.shortMargin6 == first.shortMargin6 - releasedShort);
        _accountingReconciled();
    }

    function testFundingPayerLimitClipsAndDiscardsArrears() public {
        _defaultMatch(1e6);
        _publishPrice(1e27);
        _setFunding(1e21, 3600);
        vm.warp(block.timestamp + 3600);
        _publishPrice(1e27);
        settlement.settleFunding(1);
        require(vault.pairMargins(1).longMargin6 == 0);
        require(vault.pairMargins(1).shortMargin6 == 200e6);
        (,,, int128 remainder,,) = settlement.pairs(1);
        require(remainder == 0);
        settlement.settleFunding(1);
        require(vault.pairMargins(1).shortMargin6 == 200e6);
        vm.prank(ALICE);
        settlement.closePair(1, 1e6);
        require(vault.insuranceBalance6() == 0);
        require(vault.feeBalance6() == 600_000);
        _accountingReconciled();
    }

    function testHealthyLiquidationRejectedAndUnhealthyPenaltyBounded() public {
        _defaultMatch(1e6);
        vm.expectRevert(AvensSettlement.NotLiquidatable.selector);
        settlement.liquidatePair(1);

        _publishPrice(947e18);
        uint128 bobBefore = vault.freeBalance(BOB);
        vm.prank(KEEPER);
        uint256 gasBefore = gasleft();
        settlement.liquidatePair(1);
        require(gasBefore - gasleft() <= 2_000_000, "liquidation gas");
        require(vault.pairMargins(1).longOwner == address(0));
        require(settlement.positionCount(ALICE) == 0 && settlement.positionCount(BOB) == 0);
        require(vault.insuranceBalance6() > 0);
        require(vault.freeBalance(KEEPER) > 0);
        require(vault.freeBalance(BOB) == bobBefore + 153e6);
        require(vault.feeBalance6() == 600_000);
        _accountingReconciled();

        vm.prank(KEEPER);
        vm.expectRevert(AvensSettlement.InvalidPair.selector);
        settlement.liquidatePair(1);
    }

    function testNoDelegateWithdrawal() public {
        _defaultMatch(1e6);
        vm.prank(ALICE);
        settlement.closePair(1, 1e6);
        uint128 aliceFree = vault.freeBalance(ALICE);
        require(aliceFree > 0);
        vm.prank(OTHER);
        vm.expectRevert();
        vault.withdraw(aliceFree);
        require(vault.freeBalance(ALICE) == aliceFree);
    }

    function testCancelBeforeFirstFillDoesNotInvalidateUnrelatedNonces() public {
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory later = _order(ALICE, 0, 1e6, PRICE, 10, 20, expiry);
        bytes memory laterSig = _sign(later, aliceKey);
        vm.prank(BOB);
        vm.expectRevert(AvensSettlement.Unauthorized.selector);
        settlement.cancelSignedOrder(later, laterSig);
        vm.prank(ALICE);
        settlement.cancelSignedOrder(later, laterSig);
        require(settlement.cancelled(settlement.orderHash(later)));
        require(settlement.minimumNonce(ALICE) == 0);
        _defaultMatch(1e6); // An exact-hash cancellation is not permission to invalidate lower nonces.
        _accountingReconciled();
    }

    function testCancellationCannotForgeFieldsNonceOrAnotherOwnersOrder() public {
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory order = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        bytes memory orderSig = _sign(order, aliceKey);
        bytes32 hash = settlement.orderHash(order);
        vm.prank(ALICE);
        settlement.reserveOrder(order, orderSig, 1);
        (ClobAuth.Cancel memory cancel, bytes memory signature) = _cancelSig(ALICE, hash, 1, expiry, aliceKey);
        vm.prank(BOB);
        vm.expectRevert(AvensSettlement.Unauthorized.selector);
        settlement.cancelOrder(cancel, signature);
        cancel.expiry += 1;
        vm.prank(ALICE);
        vm.expectRevert(AvensSettlement.InvalidSignature.selector);
        settlement.cancelOrder(cancel, signature);
        (cancel, signature) = _cancelSig(BOB, hash, 1, expiry, bobKey);
        vm.prank(BOB);
        vm.expectRevert(AvensSettlement.UnknownOrder.selector);
        settlement.cancelOrder(cancel, signature);
        (cancel, signature) = _cancelSig(ALICE, hash, 2, expiry, aliceKey);
        vm.prank(ALICE);
        vm.expectRevert(AvensSettlement.ConflictingNonce.selector);
        settlement.cancelOrder(cancel, signature);
        require(!settlement.cancelled(hash) && vault.totalEscrow6() == 1);
        _accountingReconciled();
    }

    function testInvalidatedReservationCanBeRecoveredWithoutReactivatingOrder() public {
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 1e6, PRICE, 10, 1, expiry);
        bytes memory signature = _sign(longOrder, aliceKey);
        bytes memory shortSig = _sign(shortOrder, bobKey);
        bytes32 hash = settlement.orderHash(longOrder);
        vm.prank(ALICE);
        settlement.reserveOrder(longOrder, signature, 100_300_000);
        vm.prank(ALICE);
        settlement.invalidateNonce(1);
        vm.expectRevert(AvensSettlement.InvalidNonce.selector);
        settlement.matchOrders(longOrder, signature, shortOrder, shortSig, 1e6, PRICE);
        vm.prank(ALICE);
        settlement.cancelOrder(hash, 1);
        require(vault.totalEscrow6() == 0 && vault.freeBalance(ALICE) == 10_000e6);
        require(settlement.minimumNonce(ALICE) == 2 && settlement.cancelled(hash));
        _accountingReconciled();
    }

    function testPermissionlessFundingCheckpointReplayAndSignReversal() public {
        _defaultMatch(1e6);
        _setFunding(1e15, 1800);
        vm.warp(block.timestamp + 1800);
        _publishPrice(PRICE);
        vm.prank(KEEPER);
        settlement.settleFunding(1);
        AvensVault.PairMargins memory first = vault.pairMargins(1);
        require(first.longMargin6 == 98_200_000 && first.shortMargin6 == 101_800_000);
        require(vault.freeBalance(KEEPER) == 0);
        settlement.settleFunding(1);
        require(vault.pairMargins(1).longMargin6 == first.longMargin6);
        vm.prank(OTHER);
        vm.expectRevert(AvensSettlement.NotPairOwner.selector);
        settlement.closePair(1, 1e6);
        _setFunding(-1e15, 1800);
        vm.warp(block.timestamp + 1800);
        _publishPrice(PRICE);
        settlement.settleFunding(1);
        require(vault.pairMargins(1).longMargin6 == 100e6);
        require(vault.pairMargins(1).shortMargin6 == 100e6);
        _accountingReconciled();
    }

    function testRuntimeAndBoundedGas() public {
        require(address(settlement).code.length <= 24_576, "settlement runtime size");
        require(address(vault).code.length <= 24_576, "vault runtime size");
        require(address(oracle).code.length <= 24_576, "oracle runtime size");
        uint64 expiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, PRICE, 10, 1, expiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 1e6, PRICE, 10, 1, expiry);
        bytes memory longSig = _sign(longOrder, aliceKey);
        bytes memory shortSig = _sign(shortOrder, bobKey);
        uint256 gasBefore = gasleft();
        settlement.matchOrders(longOrder, longSig, shortOrder, shortSig, 1e6, PRICE);
        uint256 fillGas = gasBefore - gasleft();
        require(fillGas <= 3_000_000, "fill gas");
        gasBefore = gasleft();
        vm.prank(ALICE);
        settlement.closePair(1, 1e6);
        uint256 closeGas = gasBefore - gasleft();
        require(closeGas <= 1_500_000, "close gas");
    }

    function testFuzzConservation(uint64 rawSize, uint64 rawPrice, uint64 rawClose) public {
        uint128 size6 = uint128(_bound(rawSize, 1000, 10_000_000));
        uint128 closeSize6 = uint128(_bound(rawClose, 1, size6));
        uint128 price18 = uint128((uint256(rawPrice) % 2_000_001 + 1) * 1e15);
        _defaultMatch(size6);
        _publishPrice(price18);
        vm.prank(ALICE);
        settlement.closePair(1, closeSize6);
        if (closeSize6 < size6) {
            vm.prank(BOB);
            settlement.closePair(1, size6 - closeSize6);
        }
        _accountingReconciled();
        uint128 aliceFree = vault.freeBalance(ALICE);
        uint128 bobFree = vault.freeBalance(BOB);
        vm.prank(ALICE);
        vault.withdraw(aliceFree);
        vm.prank(BOB);
        vault.withdraw(bobFree);
        (uint256 custody, uint256 liabilities, uint256 surplus) = vault.accounting();
        require(custody == liabilities && surplus == 0);
    }

    function _bound(uint256 value, uint256 min, uint256 max) internal pure returns (uint256) {
        return min + (value % (max - min + 1));
    }
}
