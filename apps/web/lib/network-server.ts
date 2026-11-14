import type { NetworkId } from "@/config/networks";
export async function networkFromCookies(): Promise<NetworkId> {
  // A single explicit Fuji venue; foreign network cookies cannot repoint it.
  return "fuji";
}
