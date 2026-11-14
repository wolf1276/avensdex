"""Read-only Fuji deployment preflight. Never signs, submits or changes configuration."""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from urllib.request import HTTPRedirectHandler, Request, build_opener

from scripts.compare_fuji_rpcs import compare
from scripts.qualify_fuji import (
    CONFIG, MAX_RESPONSE_BYTES, RPC, SECONDARY_RPC, QualificationError,
    quantity, validate_config,
)

ENDPOINTS = (RPC, SECONDARY_RPC)
READ_METHODS = (
    "eth_chainId", "eth_getBlockByNumber", "eth_getBalance",
    "eth_getTransactionCount",
)
ADDRESS_RE = re.compile(r"0x[0-9a-fA-F]{40}")
HASH_RE = re.compile(r"0x[0-9a-fA-F]{64}")
MAX_QUANTITY_HEX_DIGITS = 64


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise QualificationError("RPC redirect is not permitted")


def urlopen(request, timeout):
    return build_opener(NoRedirect()).open(request, timeout=timeout)


def readonly_rpc(method, params, endpoint=RPC):
    """Narrow read-only transport; fixed endpoints and a no-write method allowlist."""
    if endpoint not in ENDPOINTS:
        raise QualificationError("RPC endpoint is not allowlisted")
    if method not in READ_METHODS:
        raise QualificationError("RPC method is not read-only allowlisted")
    request = Request(endpoint, data=json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
    }).encode(), headers={"Content-Type": "application/json",
                          "User-Agent": "avensdex-preflight/1.0"})
    with urlopen(request, timeout=15) as response:
        if response.geturl() != endpoint:
            raise QualificationError("RPC redirect is not permitted")
        raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise QualificationError("RPC response exceeds size limit")
    payload = json.loads(raw)
    if (not isinstance(payload, dict) or payload.get("jsonrpc") != "2.0"
            or type(payload.get("id")) is not int or payload["id"] != 1
            or "error" in payload or "result" not in payload):
        raise QualificationError("Invalid or failed JSON-RPC response")
    return payload["result"]


def public_address(value):
    if (not isinstance(value, str) or not ADDRESS_RE.fullmatch(value)
            or int(value, 16) == 0):
        raise QualificationError("Deployer must be a nonzero full 20-byte public address")
    return value.lower()


def bounded_quantity(value):
    if not isinstance(value, str) or len(value) > MAX_QUANTITY_HEX_DIGITS + 2:
        raise QualificationError("RPC quantity exceeds 32 bytes")
    return quantity(value)


def block_identity(block):
    if not isinstance(block, dict):
        raise QualificationError("Missing block")
    number = bounded_quantity(block.get("number"))
    timestamp = bounded_quantity(block.get("timestamp"))
    block_hash = block.get("hash")
    if (not isinstance(block_hash, str) or not HASH_RE.fullmatch(block_hash)
            or int(block_hash, 16) == 0):
        raise QualificationError("Invalid block hash")
    return number, block_hash.lower(), timestamp


def account_observations(call, deployer, height_hex):
    balances = {}
    for endpoint in ENDPOINTS:
        balances[endpoint] = bounded_quantity(
            call("eth_getBalance", [deployer, height_hex], endpoint))
    if balances[RPC] != balances[SECONDARY_RPC]:
        raise QualificationError("Providers disagree on deployer balance")
    nonces = {}
    for endpoint in ENDPOINTS:
        nonces[endpoint] = bounded_quantity(
            call("eth_getTransactionCount", [deployer, height_hex], endpoint))
        if nonces[endpoint] >= 2**64:
            raise QualificationError("EOA nonce exceeds uint64")
    if nonces[RPC] != nonces[SECONDARY_RPC]:
        raise QualificationError("Providers disagree on deployer nonce")
    return balances[RPC], nonces[RPC]


def preflight(config, deployer, call=readonly_rpc, now=None):
    validate_config(config)
    deployer = public_address(deployer)
    snapshot = compare(config, call, now)
    height = snapshot["blockNumber"]
    height_hex = hex(height)
    balance, nonce = account_observations(call, deployer, height_hex)
    # Re-read the pinned blocks after account reads so a reorg cannot mix heights.
    for endpoint in ENDPOINTS:
        number, block_hash, timestamp = block_identity(
            call("eth_getBlockByNumber", [height_hex, False], endpoint))
        if (number != height or block_hash != snapshot["blockHash"].lower()
                or timestamp != snapshot["blockTimestamp"]):
            raise QualificationError("Pinned block changed during account reads")
    observed_at = datetime.now(timezone.utc) if now is None else now
    age = int(observed_at.timestamp()) - snapshot["blockTimestamp"]
    if not 0 <= age <= 120:
        raise QualificationError("Comparison block expired during account reads")
    return {
        "status": "read-only-preflight-blocked",
        "network": "avalanche-fuji",
        "chainId": 43113,
        "deployer": deployer,
        "providers": list(ENDPOINTS),
        "observedAt": observed_at.isoformat(),
        "blockNumber": height,
        "blockHash": snapshot["blockHash"].lower(),
        "blockTimestamp": snapshot["blockTimestamp"],
        "balanceWei": str(balance),
        "nonce": nonce,
        "funded": balance > 0,
        "deploymentReady": False,
        "executionEnabled": False,
        "transactionsSubmitted": 0,
        "blockers": [
            "Current Fuji-disabled build permanently disables deposits, oracle publication and settlement",
            "Bounded deployment authorization, expiry and roles are absent",
            "Collateral and oracle qualifications and a reviewed deployment manifest are absent",
            "The discussed 0.05 test AVAX budget is a proposal, not a confirmed bounded authorization",
        ],
        "limitations": [
            "Read-only observation only; no signing, transactions, deployment, recovery or contract/config changes",
            "Provider agreement is not finality, availability or deployment readiness",
            "Funded deployer balance is not readiness or authorization evidence",
            "Pinned canonical nonce does not reconcile pending transactions or existing intent journals",
            "No deployment gas estimate is produced without real constructor inputs",
            "Current known version limitations are reported; contract source/runtime gates were not inspected",
        ],
    }


class PublicArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "Invalid public preflight arguments; use --help. No secrets are accepted.\n")


def main(argv=None):
    parser = PublicArgumentParser(
        description="Read-only Avalanche Fuji deployment preflight; never signs or submits transactions.")
    parser.add_argument("--deployer", required=True,
                        help="Public deployer address (0x-prefixed, 20 bytes)")
    args = parser.parse_args(argv)
    try:
        report = preflight(json.loads(CONFIG.read_text()), args.deployer)
    except Exception:
        # Transport errors can contain URLs; never echo response bodies, URLs or secrets.
        print("Read-only Fuji preflight failed; no deployment, signing or transaction was attempted",
              file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2))
    return 2


if __name__ == "__main__":
    sys.exit(main())
