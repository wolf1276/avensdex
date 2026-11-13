// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface IVaultCollateral {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool);
}

/// @notice Custody foundation only; no settlement, delegated spending or public activation.
/// @dev Not an implementation of the superseded v1 onchain-order-book vault interface.
contract AvensVault {
    error InvalidConfiguration();
    error Unauthorized();
    error DepositsUnavailable();
    error InvalidAmount();
    error CapExceeded();
    error InsufficientBalance();
    error CustodyDeficit();
    error TokenTransferFailed();
    error InexactTransfer();
    error ReentrantCall();

    address public immutable collateralToken;
    address public immutable bootstrapOwner;
    bytes32 public immutable deploymentId;
    uint128 public immutable depositCap6;
    bool public depositsActive;
    uint256 public totalLiabilities6;
    mapping(address => uint128) public freeBalance;
    bool private entered;

    event DepositsActivated();
    event Deposited(address indexed owner, uint128 amount6);
    event Withdrawn(address indexed owner, uint128 amount6);

    constructor(address token, bytes32 identity, uint128 cap6) {
        if (
            (block.chainid != 31337 && block.chainid != 43113) || token.code.length == 0 || identity == bytes32(0)
                || cap6 == 0
        ) revert InvalidConfiguration();
        if (IVaultCollateral(token).decimals() != 6) revert InvalidConfiguration();
        collateralToken = token;
        bootstrapOwner = msg.sender;
        deploymentId = identity;
        depositCap6 = cap6;
    }

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    /// @dev Fuji remains unavailable until verified settlement/module activation is implemented.
    function activateDeposits() external {
        if (msg.sender != bootstrapOwner) revert Unauthorized();
        if (block.chainid != 31337 || depositsActive) revert DepositsUnavailable();
        depositsActive = true;
        emit DepositsActivated();
    }

    function accounting() public view returns (uint256 custody, uint256 liabilities, uint256 surplus) {
        custody = IVaultCollateral(collateralToken).balanceOf(address(this));
        liabilities = totalLiabilities6;
        if (custody < liabilities) revert CustodyDeficit();
        surplus = custody - liabilities;
    }

    function deposit(uint128 amount6) external nonReentrant {
        if (!depositsActive || block.chainid != 31337) revert DepositsUnavailable();
        if (amount6 == 0) revert InvalidAmount();
        if (totalLiabilities6 + amount6 > depositCap6) revert CapExceeded();
        (uint256 custodyBefore,,) = accounting();
        uint256 ownerBefore = IVaultCollateral(collateralToken).balanceOf(msg.sender);
        _transfer(abi.encodeCall(IVaultCollateral.transferFrom, (msg.sender, address(this), amount6)));
        uint256 custodyAfter = IVaultCollateral(collateralToken).balanceOf(address(this));
        uint256 ownerAfter = IVaultCollateral(collateralToken).balanceOf(msg.sender);
        if (
            custodyAfter < custodyBefore || custodyAfter - custodyBefore != amount6 || ownerAfter > ownerBefore
                || ownerBefore - ownerAfter != amount6
        ) revert InexactTransfer();
        freeBalance[msg.sender] += amount6;
        totalLiabilities6 += amount6;
        emit Deposited(msg.sender, amount6);
    }

    /// @notice Only the caller's unencumbered balance can be paid, only to that same caller.
    function withdraw(uint128 amount6) external nonReentrant {
        if (amount6 == 0) revert InvalidAmount();
        if (freeBalance[msg.sender] < amount6) revert InsufficientBalance();
        (uint256 custodyBefore,,) = accounting();
        uint256 ownerBefore = IVaultCollateral(collateralToken).balanceOf(msg.sender);
        freeBalance[msg.sender] -= amount6;
        totalLiabilities6 -= amount6;
        _transfer(abi.encodeCall(IVaultCollateral.transfer, (msg.sender, amount6)));
        uint256 custodyAfter = IVaultCollateral(collateralToken).balanceOf(address(this));
        uint256 ownerAfter = IVaultCollateral(collateralToken).balanceOf(msg.sender);
        if (
            custodyAfter > custodyBefore || custodyBefore - custodyAfter != amount6 || ownerAfter < ownerBefore
                || ownerAfter - ownerBefore != amount6
        ) revert InexactTransfer();
        emit Withdrawn(msg.sender, amount6);
    }

    function _transfer(bytes memory callData) private {
        (bool success, bytes memory result) = collateralToken.call(callData);
        if (!success || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TokenTransferFailed();
        }
    }
}
