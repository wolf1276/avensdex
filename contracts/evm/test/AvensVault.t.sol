// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AvensVault} from "../src/AvensVault.sol";

interface VmVault {
    function chainId(uint256 newChainId) external;
    function prank(address msgSender) external;
    function expectRevert() external;
}

/// @dev Minimal 6-decimal token with configurable return shapes, fee-on-transfer and a transfer hook.
abstract contract VaultTokenBase {
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public hookTarget;
    bytes public hookData;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function setHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
    }

    function forceBurn(address from, uint256 amount) external {
        balanceOf[from] -= amount;
        totalSupply -= amount;
    }

    function _spendAllowance(address owner, address spender, uint256 amount) internal {
        uint256 allowed = allowance[owner][spender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[owner][spender] = allowed - amount;
        }
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        _hook();
    }

    function _hook() internal {
        address target = hookTarget;
        if (target != address(0)) {
            (bool ok,) = target.call(hookData);
            require(ok, "hook");
        }
    }
}

contract MockVaultToken is VaultTokenBase {
    bool public transferFails;
    bool public transferFromFails;

    constructor(uint8 decimals_) VaultTokenBase(decimals_) {}

    function setTransferFails(bool value) external {
        transferFails = value;
    }

    function setTransferFromFails(bool value) external {
        transferFromFails = value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (transferFails) return false;
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (transferFromFails) return false;
        _spendAllowance(from, msg.sender, amount);
        _move(from, to, amount);
        return true;
    }
}

contract NoReturnVaultToken is VaultTokenBase {
    constructor(uint8 decimals_) VaultTokenBase(decimals_) {}

    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        _spendAllowance(from, msg.sender, amount);
        _move(from, to, amount);
    }
}

contract InvalidReturnVaultToken is VaultTokenBase {
    bool public invalidReturn;

    constructor(uint8 decimals_) VaultTokenBase(decimals_) {}

    function setInvalidReturn(bool value) external {
        invalidReturn = value;
    }

    function transfer(address to, uint256 amount) external returns (uint256) {
        _move(msg.sender, to, amount);
        return invalidReturn ? 2 : 1;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (uint256) {
        _spendAllowance(from, msg.sender, amount);
        _move(from, to, amount);
        return invalidReturn ? 2 : 1;
    }
}

contract FeeVaultToken is VaultTokenBase {
    uint256 public feeBps;

    constructor(uint8 decimals_, uint256 feeBps_) VaultTokenBase(decimals_) {
        feeBps = feeBps_;
    }

    function setFeeBps(uint256 value) external {
        feeBps = value;
    }

    function _feeMove(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        _hook();
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _feeMove(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _feeMove(from, to, amount);
        return true;
    }
}

contract SurchargeVaultToken is VaultTokenBase {
    bool public surcharge;

    constructor() VaultTokenBase(6) {}

    function setSurcharge(bool enabled) external {
        surcharge = enabled;
    }

    function _send(address from, address to, uint256 amount) private {
        _move(from, to, amount);
        if (surcharge) {
            balanceOf[from] -= 1;
            totalSupply -= 1;
        }
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _send(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _send(from, to, amount);
        return true;
    }
}

contract VaultReentrantActor {
    AvensVault public immutable vault;
    uint8 public mode;
    bool public armed;

    constructor(AvensVault vault_) {
        vault = vault_;
    }

    function arm(uint8 mode_) external {
        mode = mode_;
        armed = true;
    }

    function deposit(uint128 amount6) external {
        vault.deposit(amount6);
    }

    function withdraw(uint128 amount6) external {
        vault.withdraw(amount6);
    }

    function onTokenCallback() external {
        if (!armed) return;
        armed = false;
        bytes memory action = mode == 0
            ? abi.encodeCall(AvensVault.deposit, (uint128(1)))
            : abi.encodeCall(AvensVault.withdraw, (uint128(1)));
        (bool success, bytes memory reason) = address(vault).call(action);
        require(!success && reason.length == 4 && bytes4(reason) == AvensVault.ReentrantCall.selector, "guard");
    }
}

contract AvensVaultTest {
    VmVault constant vm = VmVault(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint128 constant CAP = 1_000_000e6;
    bytes32 constant DEPLOYMENT = keccak256("avensdex.test.vault");
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant OTHER = address(0xCAFE);

    function setUp() public {
        vm.chainId(31337);
    }

    function _vaultFor(address token) internal returns (AvensVault vault) {
        vault = new AvensVault(token, DEPLOYMENT, CAP);
        vault.activateDeposits();
    }

    function _fund(VaultTokenBase token, address vault, address who, uint256 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(vault, type(uint256).max);
    }

    function testBootstrapOwnerAndActivationAuthority() public {
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = new AvensVault(address(token), DEPLOYMENT, CAP);

        require(vault.bootstrapOwner() == address(this));
        require(vault.collateralToken() == address(token));
        require(vault.deploymentId() == DEPLOYMENT);
        require(vault.depositCap6() == CAP);
        require(!vault.depositsActive());

        vm.prank(OTHER);
        vm.expectRevert();
        vault.activateDeposits();
        require(!vault.depositsActive());

        vault.activateDeposits();
        require(vault.depositsActive());
        require(vault.bootstrapOwner() == address(this));

        vm.prank(OTHER);
        vm.expectRevert();
        vault.activateDeposits();
    }

    function testConstructorRejectsMainnetChain() public {
        vm.chainId(1);
        MockVaultToken token = new MockVaultToken(6);
        vm.expectRevert();
        new AvensVault(address(token), DEPLOYMENT, CAP);
    }

    function testFujiDeploymentWithoutQualifiedModuleCannotActivateOrDeposit() public {
        vm.chainId(43113);
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = new AvensVault(address(token), DEPLOYMENT, 10_000_000);

        require(vault.bootstrapOwner() == address(this));
        vm.expectRevert();
        vault.activateDeposits();
        require(!vault.depositsActive());

        _fund(token, address(vault), address(this), 100e6);
        vm.expectRevert();
        vault.deposit(1);
        require(vault.freeBalance(address(this)) == 0);
        require(vault.totalLiabilities6() == 0);
    }

    function testConstructorRejectsBadConfiguration() public {
        MockVaultToken wrongDecimals = new MockVaultToken(18);
        vm.expectRevert();
        new AvensVault(address(wrongDecimals), DEPLOYMENT, CAP);

        MockVaultToken zeroDecimals = new MockVaultToken(0);
        vm.expectRevert();
        new AvensVault(address(zeroDecimals), DEPLOYMENT, CAP);

        MockVaultToken token = new MockVaultToken(6);
        vm.expectRevert();
        new AvensVault(address(token), bytes32(0), CAP);

        vm.expectRevert();
        new AvensVault(address(token), DEPLOYMENT, 0);

        vm.expectRevert();
        new AvensVault(address(0x1234), DEPLOYMENT, CAP);
    }

    function testDepositRejectedBeforeActivation() public {
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = new AvensVault(address(token), DEPLOYMENT, CAP);

        _fund(token, address(vault), address(this), 100e6);
        vm.expectRevert();
        vault.deposit(10e6);
        require(vault.freeBalance(address(this)) == 0);
    }

    function testZeroAmountsRejected() public {
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), address(this), 10e6);

        vm.expectRevert();
        vault.deposit(0);
        vm.expectRevert();
        vault.withdraw(0);
    }

    function testDepositAndWithdrawConserveCustody() public {
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, 100e6);

        vm.prank(ALICE);
        vault.deposit(40e6);
        require(vault.freeBalance(ALICE) == 40e6);
        require(vault.totalLiabilities6() == 40e6);
        require(token.balanceOf(address(vault)) == 40e6);
        require(token.balanceOf(ALICE) == 60e6);
        (uint256 custody, uint256 liabilities, uint256 surplus) = vault.accounting();
        require(custody == 40e6 && liabilities == 40e6 && surplus == 0);

        vm.prank(ALICE);
        vault.withdraw(15e6);
        require(vault.freeBalance(ALICE) == 25e6);
        require(vault.totalLiabilities6() == 25e6);
        require(token.balanceOf(address(vault)) == 25e6);
        require(token.balanceOf(ALICE) == 75e6);

        vm.prank(ALICE);
        vault.withdraw(25e6);
        require(vault.freeBalance(ALICE) == 0);
        require(vault.totalLiabilities6() == 0);
        require(token.balanceOf(address(vault)) == 0);
        require(token.balanceOf(ALICE) == 100e6);
        (custody, liabilities, surplus) = vault.accounting();
        require(custody == 0 && liabilities == 0 && surplus == 0);
    }

    function testDonationIsUncreditedAndDoesNotExpandCap() public {
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, uint256(CAP) + 30e6);

        vm.prank(ALICE);
        token.transfer(address(vault), 30e6);

        require(vault.freeBalance(ALICE) == 0);
        require(vault.totalLiabilities6() == 0);
        (uint256 custody, uint256 liabilities, uint256 surplus) = vault.accounting();
        require(custody == 30e6 && liabilities == 0 && surplus == 30e6);

        vm.prank(ALICE);
        vault.deposit(CAP);
        require(vault.freeBalance(ALICE) == CAP);
        require(vault.totalLiabilities6() == CAP);

        vm.prank(ALICE);
        vm.expectRevert();
        vault.deposit(1);
        require(vault.totalLiabilities6() == CAP);
    }

    function testCapBoundariesAndCumulativeDeposits() public {
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), address(this), uint256(CAP) * 2);

        uint128 half = CAP / 2;
        vault.deposit(half);
        vault.deposit(half);
        require(vault.totalLiabilities6() == CAP);

        vm.expectRevert();
        vault.deposit(1);

        vault.withdraw(1);
        vault.deposit(1);
        require(vault.totalLiabilities6() == CAP);

        vm.expectRevert();
        vault.deposit(uint128(CAP) + 1);
    }

    function testWithdrawOnlyOwnBalanceAndRecipientIsCaller() public {
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, 50e6);
        _fund(token, address(vault), BOB, 20e6);

        vm.prank(ALICE);
        vault.deposit(50e6);
        vm.prank(BOB);
        vault.deposit(20e6);

        vm.prank(BOB);
        vm.expectRevert();
        vault.withdraw(21e6);

        uint256 aliceBefore = token.balanceOf(ALICE);
        uint256 bobBefore = token.balanceOf(BOB);
        uint256 vaultBefore = token.balanceOf(address(vault));

        vm.prank(BOB);
        vault.withdraw(20e6);

        require(token.balanceOf(BOB) == bobBefore + 20e6);
        require(token.balanceOf(ALICE) == aliceBefore);
        require(token.balanceOf(address(vault)) == vaultBefore - 20e6);
        require(vault.freeBalance(BOB) == 0);
        require(vault.freeBalance(ALICE) == 50e6);
        require(vault.totalLiabilities6() == 50e6);
    }

    function testBootstrapOwnerCannotSweepDonationSurplus() public {
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), OTHER, 10e6);

        vm.prank(OTHER);
        token.transfer(address(vault), 10e6);

        require(vault.bootstrapOwner() == address(this));
        vm.expectRevert();
        vault.withdraw(1);

        vm.prank(address(this));
        vm.expectRevert();
        vault.withdraw(1);

        (uint256 custody,, uint256 surplus) = vault.accounting();
        require(custody == 10e6 && surplus == 10e6);
        require(token.balanceOf(address(vault)) == 10e6);
    }

    function testDepositRevertsOnFalseTransferFrom() public {
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, 100e6);

        token.setTransferFromFails(true);
        vm.prank(ALICE);
        vm.expectRevert();
        vault.deposit(10e6);

        require(vault.freeBalance(ALICE) == 0);
        require(vault.totalLiabilities6() == 0);
        require(token.balanceOf(ALICE) == 100e6);
        require(token.balanceOf(address(vault)) == 0);
    }

    function testWithdrawRevertsOnFalseTransfer() public {
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, 100e6);
        vm.prank(ALICE);
        vault.deposit(100e6);

        token.setTransferFails(true);
        vm.prank(ALICE);
        vm.expectRevert();
        vault.withdraw(10e6);

        require(vault.freeBalance(ALICE) == 100e6);
        require(vault.totalLiabilities6() == 100e6);
        require(token.balanceOf(ALICE) == 0);
        require(token.balanceOf(address(vault)) == 100e6);
    }

    function testDepositRevertsOnInvalidReturn() public {
        InvalidReturnVaultToken token = new InvalidReturnVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, 100e6);

        token.setInvalidReturn(true);
        vm.prank(ALICE);
        vm.expectRevert();
        vault.deposit(10e6);

        require(vault.freeBalance(ALICE) == 0);
        require(vault.totalLiabilities6() == 0);
        require(token.balanceOf(ALICE) == 100e6);
    }

    function testWithdrawRevertsOnInvalidReturn() public {
        InvalidReturnVaultToken token = new InvalidReturnVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, 100e6);
        vm.prank(ALICE);
        vault.deposit(100e6);

        token.setInvalidReturn(true);
        vm.prank(ALICE);
        vm.expectRevert();
        vault.withdraw(10e6);

        require(vault.freeBalance(ALICE) == 100e6);
        require(vault.totalLiabilities6() == 100e6);
        require(token.balanceOf(address(vault)) == 100e6);
    }

    function testOptionalEmptyReturnTransfersSucceed() public {
        NoReturnVaultToken token = new NoReturnVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, 100e6);

        vm.prank(ALICE);
        vault.deposit(40e6);
        require(vault.freeBalance(ALICE) == 40e6);
        require(token.balanceOf(address(vault)) == 40e6);

        vm.prank(ALICE);
        vault.withdraw(40e6);
        require(vault.freeBalance(ALICE) == 0);
        require(vault.totalLiabilities6() == 0);
        require(token.balanceOf(ALICE) == 100e6);
        require(token.balanceOf(address(vault)) == 0);
    }

    function testFeeOnTransferDepositRollsBack() public {
        FeeVaultToken token = new FeeVaultToken(6, 100);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, 100e6);

        vm.prank(ALICE);
        vm.expectRevert();
        vault.deposit(100e6);

        require(vault.freeBalance(ALICE) == 0);
        require(vault.totalLiabilities6() == 0);
        require(token.balanceOf(ALICE) == 100e6);
        require(token.balanceOf(address(vault)) == 0);
    }

    function testFeeOnTransferWithdrawRollsBack() public {
        FeeVaultToken token = new FeeVaultToken(6, 0);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, 100e6);
        vm.prank(ALICE);
        vault.deposit(100e6);

        token.setFeeBps(100);
        vm.prank(ALICE);
        vm.expectRevert();
        vault.withdraw(40e6);

        require(vault.freeBalance(ALICE) == 100e6);
        require(vault.totalLiabilities6() == 100e6);
        require(token.balanceOf(ALICE) == 0);
        require(token.balanceOf(address(vault)) == 100e6);
    }

    function testSenderSurchargesRollBackBothDirections() public {
        SurchargeVaultToken token = new SurchargeVaultToken();
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, 101e6);
        token.setSurcharge(true);
        vm.prank(ALICE);
        vm.expectRevert();
        vault.deposit(100e6);
        require(token.balanceOf(ALICE) == 101e6 && vault.totalLiabilities6() == 0);
        token.setSurcharge(false);
        vm.prank(ALICE);
        vault.deposit(100e6);
        token.setSurcharge(true);
        vm.prank(ALICE);
        vm.expectRevert();
        vault.withdraw(40e6);
        require(token.balanceOf(ALICE) == 1e6 && vault.freeBalance(ALICE) == 100e6);
        require(token.balanceOf(address(vault)) == 100e6 && vault.totalLiabilities6() == 100e6);
    }

    function testDepositReentrancyBlocked() public {
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        VaultReentrantActor actor = new VaultReentrantActor(vault);

        _fund(token, address(vault), address(actor), 100e6);
        actor.arm(0);
        token.setHook(address(actor), abi.encodeWithSignature("onTokenCallback()"));

        actor.deposit(10e6);

        require(!actor.armed());
        require(vault.freeBalance(address(actor)) == 10e6);
        require(vault.totalLiabilities6() == 10e6);
        require(token.balanceOf(address(actor)) == 90e6);
    }

    function testWithdrawReentrancyBlocked() public {
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        VaultReentrantActor actor = new VaultReentrantActor(vault);

        _fund(token, address(vault), address(actor), 100e6);
        actor.deposit(100e6);

        actor.arm(1);
        token.setHook(address(actor), abi.encodeWithSignature("onTokenCallback()"));

        actor.withdraw(10e6);

        require(!actor.armed());
        require(vault.freeBalance(address(actor)) == 90e6);
        require(vault.totalLiabilities6() == 90e6);
        require(token.balanceOf(address(vault)) == 90e6);
    }

    function testForcedCustodyDeficitBlocksAccountingAndOperations() public {
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, 50e6);
        vm.prank(ALICE);
        vault.deposit(50e6);

        token.forceBurn(address(vault), 20e6);
        require(token.balanceOf(address(vault)) == 30e6);
        require(vault.totalLiabilities6() == 50e6);

        vm.expectRevert();
        vault.accounting();

        vm.prank(ALICE);
        vm.expectRevert();
        vault.deposit(1);

        vm.prank(ALICE);
        vm.expectRevert();
        vault.withdraw(1);

        require(vault.freeBalance(ALICE) == 50e6);
        require(vault.totalLiabilities6() == 50e6);
    }

    function testFuzzDepositWithdrawRoundtrip(uint256 rawAmount) public {
        uint128 amount = uint128(_bound(rawAmount, 1, CAP));
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, amount);

        vm.prank(ALICE);
        vault.deposit(amount);
        require(vault.freeBalance(ALICE) == amount);
        require(vault.totalLiabilities6() == amount);
        require(token.balanceOf(address(vault)) == amount);
        require(token.balanceOf(ALICE) == 0);

        (uint256 custody, uint256 liabilities, uint256 surplus) = vault.accounting();
        require(custody == amount && liabilities == amount && surplus == 0);

        vm.prank(ALICE);
        vault.withdraw(amount);
        require(vault.freeBalance(ALICE) == 0);
        require(vault.totalLiabilities6() == 0);
        require(token.balanceOf(address(vault)) == 0);
        require(token.balanceOf(ALICE) == amount);

        (custody, liabilities, surplus) = vault.accounting();
        require(custody == 0 && liabilities == 0 && surplus == 0);
    }

    function testFuzzTwoOwnerConservation(uint64 rawAlice, uint64 rawBob, uint64 rawWithdrawal) public {
        uint128 aliceAmount = uint128(_bound(rawAlice, 1, CAP / 2));
        uint128 bobAmount = uint128(_bound(rawBob, 1, CAP / 2));
        uint128 withdrawal = uint128(_bound(rawWithdrawal, 1, aliceAmount));
        MockVaultToken token = new MockVaultToken(6);
        AvensVault vault = _vaultFor(address(token));
        _fund(token, address(vault), ALICE, aliceAmount);
        _fund(token, address(vault), BOB, bobAmount);
        token.mint(address(vault), 17); // Uncredited donation never funds either owner's claim.
        vm.prank(ALICE);
        vault.deposit(aliceAmount);
        vm.prank(BOB);
        vault.deposit(bobAmount);
        vm.prank(ALICE);
        vault.withdraw(withdrawal);
        require(vault.freeBalance(ALICE) == aliceAmount - withdrawal);
        require(vault.freeBalance(BOB) == bobAmount);
        (uint256 custody, uint256 liabilities, uint256 surplus) = vault.accounting();
        require(liabilities == uint256(aliceAmount) + bobAmount - withdrawal);
        require(liabilities == uint256(vault.freeBalance(ALICE)) + vault.freeBalance(BOB));
        require(custody == liabilities + 17 && surplus == 17);
        if (aliceAmount > withdrawal) {
            vm.prank(ALICE);
            vault.withdraw(aliceAmount - withdrawal);
        }
        vm.prank(BOB);
        vault.withdraw(bobAmount);
        require(vault.totalLiabilities6() == 0 && token.balanceOf(address(vault)) == 17);
    }

    function _bound(uint256 value, uint256 min, uint256 max) internal pure returns (uint256) {
        return min + (value % (max - min + 1));
    }
}
