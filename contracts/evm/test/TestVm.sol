// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

interface Vm {
    function projectRoot() external view returns (string memory);
    function readFile(string calldata) external view returns (string memory);
    function parseJson(string calldata) external pure returns (bytes memory);
    function parseJsonInt(string calldata, string calldata) external pure returns (int256);
    function parseJsonIntArray(string calldata, string calldata) external pure returns (int256[] memory);
    function parseJsonString(string calldata, string calldata) external pure returns (string memory);
    function parseJsonKeys(string calldata, string calldata) external pure returns (string[] memory);
    function keyExistsJson(string calldata, string calldata) external view returns (bool);
    function toString(uint256) external pure returns (string memory);
    function parseUint(string calldata) external pure returns (uint256);
    function parseInt(string calldata) external pure returns (int256);
    function expectRevert(bytes4) external;
}
