// Minimal ABIs for the frozen Avensdex Fuji deployment. Hand-maintained against
// contracts/evm — do not add functions that are not called by this app.
export const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8", name: "" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address", name: "account" }], outputs: [{ type: "uint256", name: "" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address", name: "owner" }, { type: "address", name: "spender" }], outputs: [{ type: "uint256", name: "" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address", name: "spender" }, { type: "uint256", name: "amount" }], outputs: [{ type: "bool", name: "" }] },
] as const;

export const vaultAbi = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "uint128", name: "amount6" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint128", name: "amount6" }], outputs: [] },
  { type: "function", name: "freeBalance", stateMutability: "view", inputs: [{ type: "address", name: "" }], outputs: [{ type: "uint128", name: "" }] },
  { type: "function", name: "depositsActive", stateMutability: "view", inputs: [], outputs: [{ type: "bool", name: "" }] },
  { type: "function", name: "entriesPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool", name: "" }] },
  { type: "function", name: "depositCap6", stateMutability: "view", inputs: [], outputs: [{ type: "uint128", name: "" }] },
  { type: "function", name: "totalLiabilities6", stateMutability: "view", inputs: [], outputs: [{ type: "uint256", name: "" }] },
  { type: "function", name: "collateralToken", stateMutability: "view", inputs: [], outputs: [{ type: "address", name: "" }] },
] as const;

export const settlementAbi = [
  { type: "function", name: "activationReady", stateMutability: "view", inputs: [], outputs: [{ type: "bool", name: "" }] },
  { type: "function", name: "marketId", stateMutability: "view", inputs: [], outputs: [{ type: "uint32", name: "" }] },
  { type: "function", name: "nextPairId", stateMutability: "view", inputs: [], outputs: [{ type: "uint64", name: "" }] },
  { type: "function", name: "minimumNonce", stateMutability: "view", inputs: [{ type: "address", name: "" }], outputs: [{ type: "uint256", name: "" }] },
  { type: "function", name: "positionCount", stateMutability: "view", inputs: [{ type: "address", name: "" }], outputs: [{ type: "uint32", name: "" }] },
  { type: "function", name: "pairs", stateMutability: "view", inputs: [{ type: "uint64", name: "pairId" }], outputs: [
    { type: "uint128", name: "size6" }, { type: "uint128", name: "entryPrice18" },
    { type: "int128", name: "lastFundingIndex18" }, { type: "int128", name: "fundingRemainder" },
    { type: "bytes32", name: "longHash" }, { type: "bytes32", name: "shortHash" },
  ] },
  { type: "function", name: "cancelOrder", stateMutability: "nonpayable", inputs: [{ type: "bytes32", name: "orderHash_" }, { type: "uint64", name: "nonce" }], outputs: [] },
  { type: "function", name: "closePair", stateMutability: "nonpayable", inputs: [{ type: "uint64", name: "pairId" }, { type: "uint128", name: "closeSize6" }], outputs: [] },
  { type: "function", name: "reserveOrder", stateMutability: "nonpayable", inputs: [
    { type: "tuple", name: "order", components: [
      { type: "address", name: "trader" }, { type: "uint32", name: "marketId" },
      { type: "uint8", name: "side" }, { type: "uint8", name: "kind" },
      { type: "uint128", name: "size6" }, { type: "uint128", name: "limitPrice18" },
      { type: "uint32", name: "leverage" }, { type: "uint16", name: "maxFeeBps" },
      { type: "uint64", name: "nonce" }, { type: "uint64", name: "expiry" },
      { type: "bool", name: "reduceOnly" }, { type: "bool", name: "postOnly" }, { type: "bool", name: "ioc" },
    ] },
    { type: "bytes", name: "signature" }, { type: "uint128", name: "amount6" },
  ], outputs: [] },
] as const;

export const oracleAbi = [
  { type: "function", name: "price", stateMutability: "view", inputs: [{ type: "uint32", name: "marketId" }], outputs: [
    { type: "tuple", name: "result", components: [
      { type: "uint128", name: "price18" }, { type: "uint64", name: "sourceTimestamp" },
    ] },
  ] },
  { type: "function", name: "fundingIndex", stateMutability: "view", inputs: [{ type: "uint32", name: "market" }], outputs: [
    { type: "int128", name: "index18" }, { type: "uint64", name: "validUntil" },
  ] },
  { type: "function", name: "ratePrice18PerSecond", stateMutability: "view", inputs: [], outputs: [{ type: "int128", name: "" }] },
] as const;
