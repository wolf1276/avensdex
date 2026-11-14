// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {AvensVault} from "../src/AvensVault.sol";
import {AvensSettlement} from "../src/AvensSettlement.sol";
import {AvensFundingOracle} from "../src/AvensFundingOracle.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {ProtocolTypes as T} from "../src/interfaces/ProtocolTypes.sol";
import {FundingMath} from "../src/libraries/FundingMath.sol";
import {ClobAuth} from "../src/libraries/ClobAuth.sol";
import {MockVaultToken} from "./AvensVault.t.sol";

interface VmFundingLifecycle {
    function chainId(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

contract FundingLifecycleSource is IOracleAdapter {
    T.Price private observation;

    function set(uint128 price18, uint64 sourceTimestamp) external {
        observation = T.Price(price18, sourceTimestamp);
    }

    function price(uint32) external view returns (T.Price memory) {
        return observation;
    }
}

contract FundingLifecycleTest {
    VmFundingLifecycle constant vm = VmFundingLifecycle(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint128 constant CAP = 1_000_000e6;
    uint32 constant MARKET = 1;
    uint64 constant MAX_AGE = 60;
    uint128 constant PRICE = 1000e18;
    bytes32 constant DEPLOYMENT = keccak256("avensdex.funding.lifecycle");
    address constant FUNDING_PUBLISHER = address(0xF00D);

    MockVaultToken token;
    AvensVault vault;
    FundingLifecycleSource indexSource;
    FundingLifecycleSource markSource;
    AvensFundingOracle oracle;
    AvensSettlement settlement;

    uint256 aliceKey;
    uint256 bobKey;
    address ALICE;
    address BOB;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_000_000);
        aliceKey = uint256(keccak256("avensdex funding lifecycle alice"));
        bobKey = uint256(keccak256("avensdex funding lifecycle bob"));
        ALICE = vm.addr(aliceKey);
        BOB = vm.addr(bobKey);

        token = new MockVaultToken(6);
        vault = new AvensVault(address(token), DEPLOYMENT, CAP);
        indexSource = new FundingLifecycleSource();
        markSource = new FundingLifecycleSource();
        indexSource.set(PRICE, uint64(block.timestamp));
        markSource.set(PRICE, uint64(block.timestamp));
        oracle = new AvensFundingOracle(indexSource, markSource, MARKET, FUNDING_PUBLISHER);
        settlement = new AvensSettlement(vault, oracle, MARKET, MAX_AGE);
        vault.bindSettlement(address(settlement));
        vault.activateDeposits();

        _deposit(ALICE, 10_000e6);
        _deposit(BOB, 10_000e6);
    }

    function _deposit(address owner, uint128 amount6) internal {
        token.mint(owner, amount6);
        vm.prank(owner);
        token.approve(address(vault), amount6);
        vm.prank(owner);
        vault.deposit(amount6);
    }

    function _observe(uint128 indexPrice, uint128 markPrice) internal {
        indexSource.set(indexPrice, uint64(block.timestamp));
        markSource.set(markPrice, uint64(block.timestamp));
    }

    function _publishFunding() internal {
        uint256 revision = oracle.revision();
        uint256 epoch = block.timestamp / 3600;
        vm.prank(FUNDING_PUBLISHER);
        oracle.publish(revision, epoch);
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
        bytes32 digest = ClobAuth.orderDigest(ClobAuth.domainSeparator(block.chainid, address(settlement)), order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
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

    function testPositiveFundingAppliesToPairMargins() public {
        _observe(PRICE, PRICE * 10012 / 10000);
        _publishFunding();
        (bytes32 longHash, bytes32 shortHash) = _defaultMatch(1e6);
        require(longHash != shortHash);

        AvensVault.PairMargins memory before = vault.pairMargins(1);
        require(before.longMargin6 == 100e6 && before.shortMargin6 == 100e6);

        vm.warp(block.timestamp + 30);
        _observe(PRICE, PRICE * 10012 / 10000);

        settlement.settleFunding(1);
        AvensVault.PairMargins memory afterFunding = vault.pairMargins(1);
        require(afterFunding.longMargin6 < before.longMargin6, "positive funding should charge long");
        require(afterFunding.shortMargin6 > before.shortMargin6, "positive funding should pay short");
        require(before.longMargin6 - afterFunding.longMargin6 == 1833, "positive exact payment");
        require(afterFunding.shortMargin6 - before.shortMargin6 == 1833, "positive conservation");

        (uint128 size6,, int128 lastIdx,,,) = settlement.pairs(1);
        require(size6 == 1e6);
        (int128 idxNow,) = oracle.fundingIndex(MARKET);
        require(lastIdx == idxNow, "actual funding index applied");
        _accountingReconciled();

        vm.prank(ALICE);
        settlement.closePair(1, 1e6);
        require(vault.pairMargins(1).longOwner == address(0));
        _accountingReconciled();

        uint128 aliceFree = vault.freeBalance(ALICE);
        uint256 tokenBefore = token.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.withdraw(aliceFree);
        require(token.balanceOf(ALICE) == tokenBefore + aliceFree);
        _accountingReconciled();
    }

    function testNegativeFundingAppliesToPairMargins() public {
        _observe(PRICE, PRICE * 9988 / 10000);
        _publishFunding();
        _defaultMatch(1e6);

        AvensVault.PairMargins memory before = vault.pairMargins(1);

        vm.warp(block.timestamp + 30);
        _observe(PRICE, PRICE * 9988 / 10000);

        settlement.settleFunding(1);
        AvensVault.PairMargins memory afterFunding = vault.pairMargins(1);
        require(afterFunding.longMargin6 > before.longMargin6, "negative funding should pay long");
        require(afterFunding.shortMargin6 < before.shortMargin6, "negative funding should charge short");
        require(afterFunding.longMargin6 - before.longMargin6 == 1833, "negative exact payment");
        require(before.shortMargin6 - afterFunding.shortMargin6 == 1833, "negative conservation");

        (uint128 size6,, int128 lastIdx,,,) = settlement.pairs(1);
        require(size6 == 1e6);
        (int128 idxNow,) = oracle.fundingIndex(MARKET);
        require(lastIdx == idxNow, "actual funding index applied");
        _accountingReconciled();

        vm.prank(ALICE);
        settlement.closePair(1, 1e6);
        require(vault.pairMargins(1).longOwner == address(0));
        _accountingReconciled();
    }

    function testFundingExpiryDoesNotBackfill() public {
        _observe(PRICE, PRICE * 10012 / 10000);
        _publishFunding();
        _defaultMatch(1e6);

        uint64 expiry = oracle.rateValidUntil();
        vm.warp(expiry);
        oracle.checkpoint();
        int128 terminal = oracle.checkpointIndex18();

        vm.warp(uint256(expiry) + 60);
        _observe(PRICE, PRICE * 10012 / 10000);

        (int128 indexBefore, uint64 validUntil) = oracle.fundingIndex(MARKET);
        require(indexBefore == terminal, "expired funding index backfilled");
        require(validUntil == expiry, "expiry changed without publication");

        vm.prank(ALICE);
        settlement.closePair(1, 1e6);
        require(vault.pairMargins(1).longOwner == address(0));
        _accountingReconciled();
    }

    function testConfigRevisionResetFailClosedAndRenewal() public {
        _observe(PRICE, PRICE * 10012 / 10000);
        _publishFunding();
        _defaultMatch(1e6);

        uint256 revisionBefore = oracle.revision();
        FundingMath.Params memory params = FundingMath.defaults();
        oracle.configure(FundingMath.Mode.BASELINE, params, revisionBefore);

        require(oracle.revision() == revisionBefore + 1);
        require(oracle.fundingRatePpm() == 0);
        require(oracle.rateValidUntil() == uint64(block.timestamp));

        vm.prank(FUNDING_PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidConfiguration.selector);
        oracle.publish(revisionBefore, block.timestamp / 3600);

        vm.prank(FUNDING_PUBLISHER);
        vm.expectRevert(AvensFundingOracle.InvalidEpoch.selector);
        oracle.publish(revisionBefore + 1, block.timestamp / 3600);

        uint64 orderExpiry = uint64(block.timestamp) + 3600;
        ClobAuth.Order memory longOrder = _order(ALICE, 0, 1e6, PRICE, 10, 2, orderExpiry);
        ClobAuth.Order memory shortOrder = _order(BOB, 1, 1e6, PRICE, 10, 2, orderExpiry);
        vm.expectRevert(AvensSettlement.InvalidOracle.selector);
        settlement.matchOrders(longOrder, _sign(longOrder, aliceKey), shortOrder, _sign(shortOrder, bobKey), 1e6, PRICE);

        vm.warp((block.timestamp / 3600 + 1) * 3600);
        _observe(PRICE, PRICE * 10012 / 10000);
        _publishFunding();

        vm.prank(ALICE);
        settlement.closePair(1, 1e6);
        require(vault.pairMargins(1).longOwner == address(0));
        _accountingReconciled();

        uint128 aliceFree = vault.freeBalance(ALICE);
        uint256 tokenBefore = token.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.withdraw(aliceFree);
        require(token.balanceOf(ALICE) == tokenBefore + aliceFree);
        _accountingReconciled();
    }
}
