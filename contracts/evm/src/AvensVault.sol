// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface IVaultCollateral {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool);
}

interface IVaultSettlementBinding {
    function vault() external view returns (address);
    function deploymentId() external view returns (bytes32);
    function activationReady() external view returns (bool);
}

/// @notice Canonical custody and bounded accounting for a single frozen settlement module.
/// @dev Fuji starts paused and requires explicit owner qualification attestation; strategy authority is unavailable.
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
    error InvalidReservation();
    error InvalidPair();
    error NonConservingSettlement();

    address public immutable collateralToken;
    address public immutable bootstrapOwner;
    bytes32 public immutable deploymentId;
    uint128 public immutable depositCap6;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable collateralRuntimeHash;
    bytes32 public settlementRuntimeHash;
    bytes32 public activationEvidenceHash;
    bool public depositsActive;
    bool public entriesPaused = true;
    uint256 public totalLiabilities6;
    mapping(address => uint128) public freeBalance;
    address public settlementModule;
    uint256 public totalFree6;
    uint256 public totalEscrow6;
    uint256 public totalPairMargin6;
    uint256 public feeBalance6;
    uint256 public insuranceBalance6;

    struct Reservation {
        address owner;
        uint128 amount6;
    }

    struct PairMargins {
        address longOwner;
        address shortOwner;
        uint128 longMargin6;
        uint128 shortMargin6;
    }

    mapping(bytes32 => Reservation) private reservations;
    mapping(uint64 => PairMargins) private pairs;
    mapping(uint64 => bool) public usedPairIds;
    bool private entered;

    event DepositsActivated();
    event EntriesPaused(bool paused);
    event FujiActivated(bytes32 indexed evidenceHash);
    event Deposited(address indexed owner, uint128 amount6);
    event Withdrawn(address indexed owner, uint128 amount6);
    event SettlementBound(address indexed module);
    event Reserved(bytes32 indexed orderHash, address indexed owner, uint128 amount6);
    event ReservationReleased(bytes32 indexed orderHash, address indexed owner, uint128 amount6);

    constructor(address token, bytes32 identity, uint128 cap6) {
        if (
            (block.chainid != 31337 && block.chainid != 43113) || token.code.length == 0 || identity == bytes32(0)
                || cap6 == 0
        ) revert InvalidConfiguration();
        if (block.chainid == 43113 && cap6 > 10_000_000) revert InvalidConfiguration();
        if (IVaultCollateral(token).decimals() != 6) revert InvalidConfiguration();
        collateralToken = token;
        bootstrapOwner = msg.sender;
        deploymentId = identity;
        depositCap6 = cap6;
        deploymentChainId = block.chainid;
        collateralRuntimeHash = token.codehash;
    }

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    modifier onlySettlement() {
        _network();
        if (
            msg.sender != settlementModule || settlementModule == address(0)
                || settlementModule.codehash != settlementRuntimeHash
        ) revert Unauthorized();
        _;
    }

    function bindSettlement(address module) external {
        _network();
        if (msg.sender != bootstrapOwner) revert Unauthorized();
        if (
            depositsActive || settlementModule != address(0) || module.code.length == 0 || module == address(this)
                || IVaultSettlementBinding(module).vault() != address(this)
                || IVaultSettlementBinding(module).deploymentId() != deploymentId
        ) revert InvalidConfiguration();
        settlementModule = module;
        settlementRuntimeHash = module.codehash;
        emit SettlementBound(module);
    }

    /// @dev Standalone local custody tests cannot activate public custody with this method.
    function activateDeposits() external {
        _network();
        if (msg.sender != bootstrapOwner) revert Unauthorized();
        if (block.chainid != 31337 || depositsActive) revert DepositsUnavailable();
        depositsActive = true;
        entriesPaused = false;
        emit DepositsActivated();
    }

    /// @notice Owner attests the reviewed evidence digest; a hash itself is not asset qualification.
    function activateFuji(bytes32 evidenceHash) external {
        _network();
        if (msg.sender != bootstrapOwner) revert Unauthorized();
        if (block.chainid != 43113 || depositsActive || evidenceHash == bytes32(0)) revert DepositsUnavailable();
        _fujiReady();
        activationEvidenceHash = evidenceHash;
        depositsActive = true;
        entriesPaused = false;
        emit FujiActivated(evidenceHash);
        emit DepositsActivated();
    }

    /// @notice Pauses only new liabilities/exposure; existing owners retain withdrawal and close paths.
    function setEntriesPaused(bool paused) external {
        _network();
        if (msg.sender != bootstrapOwner) revert Unauthorized();
        if (!paused) {
            if (!depositsActive) revert DepositsUnavailable();
            if (block.chainid == 43113) _fujiReady();
        }
        entriesPaused = paused;
        emit EntriesPaused(paused);
    }

    function _fujiReady() private view {
        if (
            settlementModule == address(0) || settlementModule.codehash != settlementRuntimeHash
                || collateralToken.codehash != collateralRuntimeHash
                || IVaultCollateral(collateralToken).decimals() != 6
                || !IVaultSettlementBinding(settlementModule).activationReady()
        ) revert DepositsUnavailable();
    }

    function _network() private view {
        if (block.chainid != deploymentChainId || (block.chainid != 31337 && block.chainid != 43113)) {
            revert DepositsUnavailable();
        }
    }

    function _entries() private view {
        _network();
        if (
            !depositsActive || entriesPaused || collateralToken.codehash != collateralRuntimeHash
                || (settlementModule != address(0) && settlementModule.codehash != settlementRuntimeHash)
        ) {
            revert DepositsUnavailable();
        }
    }

    function accounting() public view returns (uint256 custody, uint256 liabilities, uint256 surplus) {
        custody = IVaultCollateral(collateralToken).balanceOf(address(this));
        liabilities = totalLiabilities6;
        if (totalFree6 + totalEscrow6 + totalPairMargin6 + feeBalance6 + insuranceBalance6 != liabilities) {
            revert NonConservingSettlement();
        }
        if (custody < liabilities) revert CustodyDeficit();
        surplus = custody - liabilities;
    }

    function deposit(uint128 amount6) external nonReentrant {
        _entries();
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
        totalFree6 += amount6;
        totalLiabilities6 += amount6;
        emit Deposited(msg.sender, amount6);
    }

    /// @notice Only the caller's unencumbered balance can be paid, only to that same caller.
    function withdraw(uint128 amount6) external nonReentrant {
        _network();
        if (amount6 == 0) revert InvalidAmount();
        if (freeBalance[msg.sender] < amount6) revert InsufficientBalance();
        (uint256 custodyBefore,,) = accounting();
        uint256 ownerBefore = IVaultCollateral(collateralToken).balanceOf(msg.sender);
        freeBalance[msg.sender] -= amount6;
        totalFree6 -= amount6;
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

    function reservation(bytes32 orderHash) external view returns (Reservation memory) {
        return reservations[orderHash];
    }

    function pairMargins(uint64 pairId) external view returns (PairMargins memory) {
        return pairs[pairId];
    }

    function reserveOrder(bytes32 orderHash, address owner, uint128 amount6) external onlySettlement nonReentrant {
        _entries();
        accounting();
        if (orderHash == bytes32(0) || owner == address(0) || amount6 == 0) revert InvalidReservation();
        if (reservations[orderHash].owner != address(0)) revert InvalidReservation();
        _debitFree(owner, amount6);
        reservations[orderHash] = Reservation(owner, amount6);
        totalEscrow6 += amount6;
        emit Reserved(orderHash, owner, amount6);
    }

    function releaseOrder(bytes32 orderHash) external onlySettlement nonReentrant {
        accounting();
        Reservation memory r = reservations[orderHash];
        if (r.owner == address(0)) revert InvalidReservation();
        delete reservations[orderHash];
        totalEscrow6 -= r.amount6;
        _creditFree(r.owner, r.amount6);
        emit ReservationReleased(orderHash, r.owner, r.amount6);
    }

    function openPair(
        uint64 pairId,
        bytes32 longHash,
        bytes32 shortHash,
        address longOwner,
        address shortOwner,
        uint128 longMargin6,
        uint128 shortMargin6,
        uint128 longFee6,
        uint128 shortFee6
    ) external onlySettlement nonReentrant {
        _entries();
        accounting();
        if (
            pairId == 0 || usedPairIds[pairId] || longHash == bytes32(0) || shortHash == bytes32(0)
                || longHash == shortHash || longOwner == address(0) || shortOwner == address(0)
                || longOwner == shortOwner || longMargin6 == 0 || shortMargin6 == 0
                || uint256(longMargin6) + shortMargin6 > uint128(type(int128).max)
        ) revert InvalidPair();
        _consume(longHash, longOwner, uint256(longMargin6) + longFee6);
        _consume(shortHash, shortOwner, uint256(shortMargin6) + shortFee6);
        usedPairIds[pairId] = true;
        pairs[pairId] = PairMargins(longOwner, shortOwner, longMargin6, shortMargin6);
        totalPairMargin6 += uint256(longMargin6) + shortMargin6;
        feeBalance6 += uint256(longFee6) + shortFee6;
    }

    function transferFunding(uint64 pairId, int128 longPayment6) external onlySettlement nonReentrant {
        accounting();
        PairMargins storage p = pairs[pairId];
        if (p.longOwner == address(0)) revert InvalidPair();
        if (longPayment6 >= 0) {
            uint128 payment = uint128(longPayment6);
            if (payment > p.longMargin6) revert InsufficientBalance();
            p.longMargin6 -= payment;
            p.shortMargin6 += payment;
        } else {
            uint128 payment = uint128(uint256(-int256(longPayment6)));
            if (payment > p.shortMargin6) revert InsufficientBalance();
            p.shortMargin6 -= payment;
            p.longMargin6 += payment;
        }
    }

    function settlePair(
        uint64 pairId,
        uint128 longReleased,
        uint128 shortReleased,
        uint128 longPayout,
        uint128 shortPayout,
        uint128 insurance,
        address liquidator,
        uint128 reward
    ) external onlySettlement nonReentrant {
        accounting();
        PairMargins storage p = pairs[pairId];
        if (p.longOwner == address(0) || longReleased > p.longMargin6 || shortReleased > p.shortMargin6) {
            revert InvalidPair();
        }
        if (
            uint256(longReleased) + shortReleased != uint256(longPayout) + shortPayout + insurance + reward
                || (reward != 0 && liquidator == address(0))
        ) revert NonConservingSettlement();
        p.longMargin6 -= longReleased;
        p.shortMargin6 -= shortReleased;
        totalPairMargin6 -= uint256(longReleased) + shortReleased;
        _creditFree(p.longOwner, longPayout);
        _creditFree(p.shortOwner, shortPayout);
        insuranceBalance6 += insurance;
        if (reward != 0) _creditFree(liquidator, reward);
        if (p.longMargin6 == 0 && p.shortMargin6 == 0) delete pairs[pairId];
    }

    function _consume(bytes32 orderHash, address owner, uint256 amount) private {
        Reservation storage r = reservations[orderHash];
        if (r.owner != address(0)) {
            if (r.owner != owner) revert InvalidReservation();
            uint128 consumed = uint128(amount > r.amount6 ? r.amount6 : amount);
            r.amount6 -= consumed;
            totalEscrow6 -= consumed;
            amount -= consumed;
            // Keep the owner identity even for an exhausted reservation until explicit release.
        }
        _debitFree(owner, amount);
    }

    function _debitFree(address owner, uint256 amount) private {
        if (amount > freeBalance[owner]) revert InsufficientBalance();
        freeBalance[owner] -= uint128(amount);
        totalFree6 -= amount;
    }

    function _creditFree(address owner, uint128 amount) private {
        freeBalance[owner] += amount;
        totalFree6 += amount;
    }

    function _transfer(bytes memory callData) private {
        (bool success, bytes memory result) = collateralToken.call(callData);
        if (!success || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TokenTransferFailed();
        }
    }
}
