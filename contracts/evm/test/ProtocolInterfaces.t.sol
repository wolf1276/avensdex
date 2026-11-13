// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import {IAvensVault} from "../src/interfaces/IAvensVault.sol";
import {IAvensExchange} from "../src/interfaces/IAvensExchange.sol";
import {IStrategyExecutor} from "../src/interfaces/IStrategyExecutor.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {IAvensReader} from "../src/interfaces/IAvensReader.sol";

/// @dev ABI boundary checks, not authorization tests of implementations that do not yet exist.
contract ProtocolInterfacesTest {
    function testOwnerPayoutInterfacesCannotSpecifyARecipient() public pure {
        require(IAvensVault.withdraw.selector == bytes4(keccak256("withdraw(uint128)")));
        require(IAvensVault.withdrawStrategy.selector == bytes4(keccak256("withdrawStrategy(uint64,uint128)")));
        require(IAvensVault.withdrawStrategyBase.selector == bytes4(keccak256("withdrawStrategyBase(uint64,uint256)")));
    }

    function testBoundedMatchingAndExpiryRemainExplicit() public pure {
        require(IAvensExchange.matchOrders.selector == bytes4(keccak256("matchOrders(uint64,uint64)")));
        require(IAvensExchange.expireOrder.selector == bytes4(keccak256("expireOrder(uint64)")));
        require(IAvensExchange.cancelAll.selector == bytes4(keccak256("cancelAll(uint64,uint32)")));
    }

    function testCoreSelectorsRemainTyped() public pure {
        require(IAvensVault.deposit.selector == bytes4(keccak256("deposit(uint128)")));
        require(IAvensVault.transferFunding.selector == bytes4(keccak256("transferFunding(uint64,int128)")));
        require(IAvensExchange.settleFunding.selector == bytes4(keccak256("settleFunding(uint64)")));
        require(
            IStrategyExecutor.executeSpot.selector
                == bytes4(
                    keccak256("executeSpot(((address,uint64),(address,uint64,uint64),bool,uint128,uint256,uint64))")
                )
        );
        require(IOracleAdapter.price.selector == bytes4(keccak256("price(uint32)")));
        require(IAvensReader.readiness.selector == bytes4(keccak256("readiness(uint32)")));
    }
}
