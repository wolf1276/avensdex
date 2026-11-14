// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AvensVault} from "../src/AvensVault.sol";
import {AvensSettlement} from "../src/AvensSettlement.sol";
import {AvensFeedOracle} from "../src/AvensFeedOracle.sol";
import {MockFeed} from "./AvensFeedOracle.t.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {ProtocolTypes as T} from "../src/interfaces/ProtocolTypes.sol";
import {ClobAuth} from "../src/libraries/ClobAuth.sol";
import {MockVaultToken} from "./AvensVault.t.sol";

interface VmFujiActivation {
    function chainId(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function etch(address, bytes calldata) external;
}

/// @dev Local EVM fixture only. This is not a qualified or publicly deployed price source.
contract ActivationOracleFixture is IOracleAdapter {
    uint64 public sourceTime = 1000;
    uint64 public validUntil = 1100;

    function set(uint64 source, uint64 expiry) external {
        sourceTime = source;
        validUntil = expiry;
    }

    function price(uint32) external view returns (T.Price memory) {
        return T.Price(1e18, sourceTime);
    }

    function fundingIndex(uint32) external view returns (int128, uint64) {
        return (0, validUntil);
    }
}

contract UnreadyBindingFixture {
    address public immutable vault;
    bytes32 public immutable deploymentId;

    constructor(address vault_, bytes32 id_) {
        vault = vault_;
        deploymentId = id_;
    }

    function activationReady() external pure returns (bool) {
        return false;
    }
}

contract FujiActivationTest {
    VmFujiActivation constant vm = VmFujiActivation(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 constant ID = keccak256("fuji-activation-unit-fixture");
    bytes32 constant EVIDENCE = keccak256("local-test-attestation-not-public-qualification");
    MockVaultToken token;
    AvensVault vault;
    ActivationOracleFixture oracle;
    AvensSettlement settlement;
    address alice;
    address bob;

    function setUp() public {
        vm.chainId(43113);
        vm.warp(1000);
        alice = vm.addr(101);
        bob = vm.addr(102);
        token = new MockVaultToken(6);
        vault = new AvensVault(address(token), ID, 10_000_000);
        oracle = new ActivationOracleFixture();
        settlement = new AvensSettlement(vault, oracle, 1, 60);
        vault.bindSettlement(address(settlement));
    }

    function _deposit(address owner, uint128 amount) private {
        token.mint(owner, amount);
        vm.prank(owner);
        token.approve(address(vault), amount);
        vm.prank(owner);
        vault.deposit(amount);
    }

    function _order(address trader, uint8 side, uint64 nonce) private pure returns (ClobAuth.Order memory) {
        return ClobAuth.Order(trader, 1, side, 0, 1e6, 1e18, 10, 3, nonce, 2000, false, false, false);
    }

    function _signature(ClobAuth.Order memory order, uint256 key) private returns (bytes memory) {
        bytes32 hash = ClobAuth.orderDigest(ClobAuth.domainSeparator(block.chainid, address(settlement)), order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    function _fill(uint64 nonce) private {
        ClobAuth.Order memory long = _order(alice, 0, nonce);
        ClobAuth.Order memory short = _order(bob, 1, nonce);
        settlement.matchOrders(long, _signature(long, 101), short, _signature(short, 102), 1e6, 1e18);
    }

    function testFujiStartsPausedAndRequiresOwnerEvidenceAndLiveBoundModule() public {
        require(!vault.depositsActive() && vault.entriesPaused());
        vm.expectRevert();
        vault.activateDeposits(); // Local convenience entry point cannot authorize Fuji.
        vm.prank(alice);
        vm.expectRevert();
        vault.activateFuji(EVIDENCE);
        vm.expectRevert();
        vault.activateFuji(bytes32(0));
        vm.expectRevert();
        vault.deposit(1);
        oracle.set(900, 1100);
        vm.expectRevert();
        vault.activateFuji(EVIDENCE);
        oracle.set(1000, 999);
        vm.expectRevert();
        vault.activateFuji(EVIDENCE);
        oracle.set(1000, 1100);
        vault.activateFuji(EVIDENCE);
        require(vault.depositsActive() && !vault.entriesPaused());
        require(vault.activationEvidenceHash() == EVIDENCE);
        vm.expectRevert();
        vault.activateFuji(EVIDENCE);
    }

    function testFujiCapIsFiniteAndCannotBeRaisedByActivation() public {
        vm.expectRevert();
        new AvensVault(address(token), ID, 10_000_001);
        vault.activateFuji(EVIDENCE);
        _deposit(alice, 10_000_000);
        token.mint(alice, 1);
        vm.prank(alice);
        token.approve(address(vault), 1);
        vm.prank(alice);
        vm.expectRevert();
        vault.deposit(1);
        require(vault.totalLiabilities6() == 10_000_000);
    }

    function testPauseBlocksExposureButPreservesFundingCancelOwnerCloseAndWithdrawal() public {
        vault.activateFuji(EVIDENCE);
        _deposit(alice, 2_000_000);
        _deposit(bob, 2_000_000);
        _fill(1);
        token.mint(alice, 1);
        vm.prank(alice);
        token.approve(address(vault), 1);
        vault.setEntriesPaused(true);
        vm.prank(alice);
        vm.expectRevert();
        vault.setEntriesPaused(false);
        vm.prank(alice);
        vm.expectRevert(AvensVault.DepositsUnavailable.selector);
        vault.deposit(1);
        vm.expectRevert();
        _fill(2);
        vm.prank(address(settlement));
        vm.expectRevert();
        vault.openPair(2, bytes32(uint256(3)), bytes32(uint256(4)), alice, bob, 1, 1, 0, 0);
        vm.prank(alice);
        vault.withdraw(1); // Free owner funds do not depend on entries being enabled.
        bytes32 hash = settlement.orderHash(_order(alice, 0, 1));
        vm.prank(alice);
        settlement.cancelOrder(hash, 1);
        vm.warp(1200);
        oracle.set(1200, 1100); // Price fresh; the terminal funding index is frozen after rate expiry.
        vm.expectRevert();
        vault.setEntriesPaused(false);
        settlement.settleFunding(1);
        vm.prank(alice);
        settlement.closePair(1, 1e6);
        require(vault.totalPairMargin6() == 0);
        require(vault.feeBalance6() == 600);
        uint128 aliceFree = vault.freeBalance(alice);
        uint128 bobFree = vault.freeBalance(bob);
        vm.prank(alice);
        vault.withdraw(aliceFree);
        vm.prank(bob);
        vault.withdraw(bobFree);
        (uint256 custody, uint256 liabilities, uint256 surplus) = vault.accounting();
        require(custody == 600 && liabilities == 600 && surplus == 0);
        oracle.set(1200, 1300);
        vault.setEntriesPaused(false);
        require(!vault.entriesPaused());
    }

    function testExpiredRateRejectsUnpausedFillsButDoesNotBypassPriceFreshnessOnExit() public {
        vault.activateFuji(EVIDENCE);
        _deposit(alice, 2_000_000);
        _deposit(bob, 2_000_000);
        _fill(1);
        vm.warp(1200);
        oracle.set(1200, 1100);
        require(!vault.entriesPaused());
        vm.expectRevert();
        _fill(2);
        oracle.set(1100, 1100);
        vm.expectRevert();
        settlement.settleFunding(1);
        vm.prank(alice);
        vm.expectRevert();
        settlement.closePair(1, 1e6);
        require(vault.totalPairMargin6() != 0);
        oracle.set(1200, 1100);
        vm.prank(alice);
        settlement.closePair(1, 1e6);
        require(vault.totalPairMargin6() == 0);
    }

    function testRealAdapterTerminalFundingIsAppliedOnceAndRenewalDoesNotBackfill() public {
        MockFeed base = new MockFeed(8);
        MockFeed quote = new MockFeed(8);
        base.set(1, 1e8, 1000, 1000, 1);
        quote.set(1, 1e8, 1000, 1000, 1);
        AvensFeedOracle live = new AvensFeedOracle(1, address(base), address(quote), address(0xF00D), 60, 60);
        vault = new AvensVault(address(token), ID, 10_000_000);
        settlement = new AvensSettlement(vault, live, 1, 60);
        vault.bindSettlement(address(settlement));
        vm.expectRevert(AvensSettlement.InvalidOracle.selector);
        vault.activateFuji(EVIDENCE); // Constructor-time zero funding is not a published live checkpoint.
        vm.prank(address(0xF00D));
        live.setFundingRate(1e12, 1010);
        vault.activateFuji(EVIDENCE);
        _deposit(alice, 2_000_000);
        _deposit(bob, 2_000_000);
        _fill(1);
        vm.warp(1010);
        vm.expectRevert(AvensSettlement.InvalidOracle.selector);
        _fill(2); // The exact expiry boundary cannot open exposure.
        vm.warp(1020);
        settlement.settleFunding(1);
        AvensVault.PairMargins memory margins = vault.pairMargins(1);
        require(margins.longMargin6 == 99_990 && margins.shortMargin6 == 100_010);
        vm.prank(alice);
        settlement.closePair(1, 1e6);
        require(vault.freeBalance(alice) == 1_999_690 && vault.freeBalance(bob) == 1_999_710);
        vm.warp(1030);
        vm.prank(address(0xF00D));
        live.setFundingRate(0, 1040);
        (int128 index,) = live.fundingIndex(1);
        require(index == 10e12); // The expired gap creates no extra obligation.
    }

    function testWrongChainRejectsFundedUnpausedCustody() public {
        vault.activateFuji(EVIDENCE);
        _deposit(alice, 2_000_000);
        token.mint(alice, 1);
        vm.prank(alice);
        token.approve(address(vault), 1);
        vm.chainId(43114);
        vm.prank(alice);
        vm.expectRevert(AvensVault.DepositsUnavailable.selector);
        vault.deposit(1);
        vm.prank(alice);
        vm.expectRevert(AvensVault.DepositsUnavailable.selector);
        vault.withdraw(1);
        vm.expectRevert(AvensVault.DepositsUnavailable.selector);
        vault.setEntriesPaused(false);
    }

    function testFalseModuleReadinessCannotActivateCustody() public {
        AvensVault fresh = new AvensVault(address(token), ID, 10_000_000);
        fresh.bindSettlement(address(new UnreadyBindingFixture(address(fresh), ID)));
        vm.expectRevert(AvensVault.DepositsUnavailable.selector);
        fresh.activateFuji(EVIDENCE);
        require(!fresh.depositsActive() && fresh.entriesPaused());
    }

    function testChangedCollateralRuntimeRejectsInitialActivation() public {
        vm.etch(address(token), hex"00");
        vm.expectRevert(AvensVault.DepositsUnavailable.selector);
        vault.activateFuji(EVIDENCE);
    }

    function testChangedSettlementBlocksDepositsButPreservesFreeOwnerWithdrawal() public {
        vault.activateFuji(EVIDENCE);
        _deposit(alice, 2_000_000);
        token.mint(alice, 1);
        vm.prank(alice);
        token.approve(address(vault), 1);
        vm.etch(address(settlement), hex"00");
        vm.prank(alice);
        vm.expectRevert(AvensVault.DepositsUnavailable.selector);
        vault.deposit(1);
        vm.prank(alice);
        vault.withdraw(1);
        require(vault.freeBalance(alice) == 1_999_999);
    }

    function testChangedSettlementRuntimeRejectsInitialActivation() public {
        vm.etch(address(settlement), hex"00");
        vm.expectRevert(AvensVault.DepositsUnavailable.selector);
        vault.activateFuji(EVIDENCE);
    }

    function testRuntimeAndChainChangesCannotAuthorizeNewLiabilities() public {
        vault.activateFuji(EVIDENCE);
        vault.setEntriesPaused(true);
        vm.etch(address(settlement), hex"00");
        vm.expectRevert();
        vault.setEntriesPaused(false);
        vm.chainId(43114);
        vm.expectRevert();
        vault.activateFuji(EVIDENCE);
        vm.expectRevert();
        vault.deposit(1);
        vm.expectRevert();
        vault.withdraw(1);
    }
}
