// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AvensVault} from "../src/AvensVault.sol";
import {MockVaultToken} from "./AvensVault.t.sol";

interface VmLedger {
    function chainId(uint256) external;
    function prank(address) external;
    function expectRevert() external;
}

/// @dev Deliberately trusted test module; not a production signature-validation implementation.
contract VaultLedgerModule {
    AvensVault public immutable vault;
    bytes32 public immutable deploymentId;

    constructor(AvensVault vault_, bytes32 id) {
        vault = vault_;
        deploymentId = id;
    }

    function reserve(bytes32 hash, address owner, uint128 amount) external {
        vault.reserveOrder(hash, owner, amount);
    }

    function release(bytes32 hash) external {
        vault.releaseOrder(hash);
    }

    function open(uint64 id, address long, address short, uint128 margin, uint128 fee) external {
        vault.openPair(id, bytes32(uint256(1)), bytes32(uint256(2)), long, short, margin, margin, fee, fee);
    }

    function fund(uint64 id, int128 payment) external {
        vault.transferFunding(id, payment);
    }

    function close(
        uint64 id,
        uint128 longReleased,
        uint128 shortReleased,
        uint128 longPayout,
        uint128 shortPayout,
        uint128 insurance,
        address liquidator,
        uint128 reward
    ) external {
        vault.settlePair(id, longReleased, shortReleased, longPayout, shortPayout, insurance, liquidator, reward);
    }
}

contract AvensVaultLedgerTest {
    VmLedger constant vm = VmLedger(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 constant ID = keccak256("vault-ledger-test");
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant KEEPER = address(0xCAFE);
    MockVaultToken token;
    AvensVault vault;
    VaultLedgerModule module;

    function setUp() public {
        vm.chainId(31337);
        token = new MockVaultToken(6);
        vault = new AvensVault(address(token), ID, 1_000_000e6);
        module = new VaultLedgerModule(vault, ID);
        vault.bindSettlement(address(module));
        vault.activateDeposits();
        _deposit(ALICE, 1000e6);
        _deposit(BOB, 1000e6);
    }

    function _deposit(address owner, uint128 amount) private {
        token.mint(owner, amount);
        vm.prank(owner);
        token.approve(address(vault), amount);
        vm.prank(owner);
        vault.deposit(amount);
    }

    function _reconciled() private view {
        (uint256 custody, uint256 liabilities, uint256 surplus) = vault.accounting();
        require(custody == 2000e6 && liabilities == custody && surplus == 0);
        require(
            vault.totalFree6() == uint256(vault.freeBalance(ALICE)) + vault.freeBalance(BOB) + vault.freeBalance(KEEPER)
        );
        require(
            liabilities
                == vault.totalFree6() + vault.totalEscrow6() + vault.totalPairMargin6() + vault.feeBalance6()
                    + vault.insuranceBalance6()
        );
    }

    function testBindingRejectsTakeoverRebindAndIdentityMismatch() public {
        AvensVault fresh = new AvensVault(address(token), ID, 1000e6);
        VaultLedgerModule wrong = new VaultLedgerModule(fresh, bytes32(uint256(1)));
        vm.expectRevert();
        fresh.bindSettlement(address(wrong));
        vm.expectRevert();
        fresh.bindSettlement(address(module)); // Correct identity, wrong vault.
        VaultLedgerModule good = new VaultLedgerModule(fresh, ID);
        vm.prank(KEEPER);
        vm.expectRevert();
        fresh.bindSettlement(address(good));
        fresh.bindSettlement(address(good));
        vm.expectRevert();
        fresh.bindSettlement(address(good));
        require(fresh.settlementModule() == address(good));
        AvensVault active = new AvensVault(address(token), ID, 1000e6);
        active.activateDeposits();
        VaultLedgerModule late = new VaultLedgerModule(active, ID);
        vm.expectRevert();
        active.bindSettlement(address(late));
    }

    function testOnlyFrozenModuleMayMutateLedger() public {
        vm.expectRevert();
        vault.reserveOrder(bytes32(uint256(1)), ALICE, 1);
        vm.expectRevert();
        vault.releaseOrder(bytes32(uint256(1)));
        vm.expectRevert();
        vault.openPair(1, bytes32(uint256(1)), bytes32(uint256(2)), ALICE, BOB, 1, 1, 0, 0);
        vm.expectRevert();
        vault.transferFunding(1, 1);
        vm.expectRevert();
        vault.settlePair(1, 1, 1, 1, 1, 0, address(0), 0);
        _reconciled();
    }

    function testReservationIsolationConsumptionAndRelease() public {
        module.reserve(bytes32(uint256(1)), ALICE, 105e6);
        module.reserve(bytes32(uint256(2)), BOB, 50e6);
        require(vault.freeBalance(ALICE) == 895e6 && vault.totalEscrow6() == 155e6);
        vm.prank(ALICE);
        vm.expectRevert();
        vault.withdraw(896e6);
        vm.expectRevert();
        module.reserve(bytes32(uint256(1)), BOB, 1);
        module.open(1, ALICE, BOB, 100e6, 1e6);
        require(vault.reservation(bytes32(uint256(1))).amount6 == 4e6);
        require(vault.reservation(bytes32(uint256(2))).amount6 == 0);
        require(vault.totalEscrow6() == 4e6 && vault.feeBalance6() == 2e6);
        require(vault.totalPairMargin6() == 200e6);
        module.release(bytes32(uint256(1)));
        module.release(bytes32(uint256(2)));
        require(vault.freeBalance(ALICE) == 899e6 && vault.freeBalance(BOB) == 899e6);
        vm.expectRevert();
        module.release(bytes32(uint256(1)));
        _reconciled();
    }

    function testBothSidesRollbackOnInsufficientCollateralOrWrongReservationOwner() public {
        vm.expectRevert();
        module.open(1, ALICE, BOB, 1000e6, 1);
        require(!vault.usedPairIds(1) && vault.freeBalance(ALICE) == 1000e6);
        module.reserve(bytes32(uint256(1)), BOB, 10e6);
        vm.expectRevert();
        module.open(1, ALICE, BOB, 100e6, 0);
        require(vault.reservation(bytes32(uint256(1))).amount6 == 10e6);
        require(vault.freeBalance(ALICE) == 1000e6 && vault.totalPairMargin6() == 0);
        _reconciled();
    }

    function testFundingAndPartialSettlementConserveAndNeverRedirectOwnerClaims() public {
        module.open(1, ALICE, BOB, 100e6, 1e6);
        module.fund(1, 20e6);
        AvensVault.PairMargins memory p = vault.pairMargins(1);
        require(p.longMargin6 == 80e6 && p.shortMargin6 == 120e6);
        module.fund(1, -10e6);
        vm.expectRevert();
        module.fund(1, 91e6);
        vm.expectRevert();
        module.fund(1, type(int128).min);
        vm.expectRevert();
        module.close(1, 30e6, 30e6, 50e6, 11e6, 0, address(0), 0);
        vm.expectRevert();
        module.close(1, 30e6, 30e6, 40e6, 10e6, 0, address(0), 10e6);
        module.close(1, 30e6, 30e6, 40e6, 10e6, 5e6, KEEPER, 5e6);
        require(vault.freeBalance(ALICE) == 939e6 && vault.freeBalance(BOB) == 909e6);
        require(vault.freeBalance(KEEPER) == 5e6 && vault.insuranceBalance6() == 5e6);
        p = vault.pairMargins(1);
        require(p.longMargin6 == 60e6 && p.shortMargin6 == 80e6);
        _reconciled();
        module.close(1, 60e6, 80e6, 0, 140e6, 0, address(0), 0);
        require(vault.pairMargins(1).longOwner == address(0));
        vm.expectRevert();
        module.open(1, ALICE, BOB, 1, 0);
        _reconciled();
    }

    function testFuzzFundingPairAndBucketConservation(uint64 rawMargin, int64 rawFunding, uint64 rawPayout) public {
        uint128 margin = uint128(uint256(rawMargin) % 900e6 + 1);
        int128 payment = int128(rawFunding % int64(uint64(margin)));
        module.open(1, ALICE, BOB, margin, 1);
        module.fund(1, payment);
        _reconciled();
        AvensVault.PairMargins memory p = vault.pairMargins(1);
        require(uint256(p.longMargin6) + p.shortMargin6 == uint256(margin) * 2);
        uint128 longPayout = uint128(uint256(rawPayout) % (uint256(margin) * 2 + 1));
        module.close(1, p.longMargin6, p.shortMargin6, longPayout, margin * 2 - longPayout, 0, address(0), 0);
        require(vault.totalPairMargin6() == 0 && vault.feeBalance6() == 2);
        _reconciled();
    }
}
