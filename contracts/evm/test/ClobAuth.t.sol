// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;
import {ClobAuth} from "../src/libraries/ClobAuth.sol";

interface VmClob {
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external returns (address);
    function expectRevert(bytes4 selector) external;
}

contract ClobAuthTest {
    VmClob constant vm = VmClob(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant DEPLOYMENT = 0x3333333333333333333333333333333333333333;
    bytes32 constant ORDER_HASH = 0xbb7468dc6ec96631349eed96a95f27a33efcfa05f1f261ee7a1006c00500a114;
    bytes32 constant CANCEL_HASH = 0x9c4ebc9638e8b40ebc842b9823f06a0e13ed52794ebab0797742985ace0f4ce4;

    function fixture() internal pure returns (ClobAuth.Order memory) {
        return ClobAuth.Order({
            trader: address(bytes20(hex"909082f08f95afe2d67d7b92ae6f5f28318e1d29")),
            marketId: 1,
            side: 1,
            kind: 0,
            size6: 1_000_000,
            limitPrice18: 30e18,
            leverage: 2,
            maxFeeBps: 10,
            nonce: 1,
            expiry: 2000,
            reduceOnly: false,
            postOnly: false,
            ioc: false
        });
    }

    function testTypeScriptGoldenOrderAndCancellation() public pure {
        bytes32 domain = ClobAuth.domainSeparator(43113, DEPLOYMENT);
        require(ClobAuth.orderDigest(domain, fixture()) == ORDER_HASH);
        require(ClobAuth.cancelDigest(domain, ClobAuth.Cancel(fixture().trader, ORDER_HASH, 1, 2000)) == CANCEL_HASH);
        bytes memory sig =
            hex"3ceeb9f27cd7bf93eeb1f3ce7305ab9212255684a48a9cdb4ec7e9419965ada36c2cc939cee1b20ee4faa5b4f0ad3faa82a67b6a234b8010b74ea87b3357bc281b";
        require(ClobAuth.recover(ORDER_HASH, sig) == fixture().trader);
        require(ClobAuth.recover(CANCEL_HASH, sig) != fixture().trader);
    }

    function testDomainAndEconomicsAreBound() public pure {
        ClobAuth.Order memory o = fixture();
        bytes32 domain = ClobAuth.domainSeparator(43113, DEPLOYMENT);
        require(ClobAuth.orderDigest(ClobAuth.domainSeparator(1, DEPLOYMENT), o) != ORDER_HASH);
        require(ClobAuth.orderDigest(ClobAuth.domainSeparator(43113, address(4)), o) != ORDER_HASH);
        o.maxFeeBps++;
        require(ClobAuth.orderDigest(domain, o) != ORDER_HASH);
        o = fixture();
        o.leverage++;
        require(ClobAuth.orderDigest(domain, o) != ORDER_HASH);
    }

    function recover(bytes32 digest, bytes memory signature) external pure returns (address) {
        return ClobAuth.recover(digest, signature);
    }

    function testRejectMalformedAndMalleableSignatures() public {
        uint256 key = uint256(keccak256("avensdex public admission fixture A"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, ORDER_HASH);
        uint256 n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        vm.expectRevert(ClobAuth.InvalidSignature.selector);
        this.recover(ORDER_HASH, abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27)));
        vm.expectRevert(ClobAuth.InvalidSignature.selector);
        this.recover(ORDER_HASH, hex"00");
        vm.expectRevert(ClobAuth.InvalidSignature.selector);
        this.recover(ORDER_HASH, abi.encodePacked(r, s, uint8(0)));
        vm.expectRevert(ClobAuth.InvalidSignature.selector);
        this.recover(ORDER_HASH, abi.encodePacked(bytes32(0), s, v));
    }

    function testFuzzSignatureRecovery(bytes32 message) public {
        uint256 key = uint256(keccak256("avensdex public admission fixture A"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, message);
        require(ClobAuth.recover(message, abi.encodePacked(r, s, v)) == vm.addr(key));
    }
}
