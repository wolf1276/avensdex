export function isAccountId(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
export function requireAccountId(value: string): string {
  if (!isAccountId(value)) throw new Error(`Invalid or unconfigured EVM address: ${value || "(empty)"}`);
  return value;
}
