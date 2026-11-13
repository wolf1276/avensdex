"""Read-only Fuji identity probe. No signing, submissions, or deployment support."""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

CONFIG = Path(__file__).resolve().parents[1] / "config" / "fuji.json"
RPC = "https://api.avax-test.network/ext/bc/C/rpc"
MAX_RESPONSE_BYTES = 1_048_576


class QualificationError(ValueError):
    pass


def validate_config(config):
    if (type(config.get("chainId")) is not int or config["chainId"] != 43113
            or config.get("network") != "avalanche-fuji"
            or config.get("schemaVersion") != 1
            or config.get("rpcUrl") != RPC
            or config.get("executionEnabled") is not False
            or config.get("mainnetEnabled") is not False):
        raise QualificationError("Only the fixed, execution-disabled Fuji configuration is supported")


def rpc(method, params):
    # Fixed endpoint and method allowlist; no env overrides or secret-bearing URLs.
    if method not in ("eth_chainId", "eth_getBlockByNumber"):
        raise QualificationError("RPC method is not read-only allowlisted")
    request = Request(RPC, data=json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
    }).encode(), headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=15) as response:
        if response.geturl() != RPC:
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


def quantity(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)", value):
        raise QualificationError("Invalid RPC quantity")
    return int(value, 16)


def qualify(config, call=rpc, now=None):
    validate_config(config)
    if quantity(call("eth_chainId", [])) != 43113:
        raise QualificationError("RPC is not Avalanche Fuji; refusing further reads")
    block = call("eth_getBlockByNumber", ["latest", False])
    if not isinstance(block, dict):
        raise QualificationError("Missing latest block")
    number = quantity(block.get("number"))
    timestamp = quantity(block.get("timestamp"))
    block_hash = block.get("hash")
    if not isinstance(block_hash, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", block_hash):
        raise QualificationError("Invalid block hash")
    now = datetime.now(timezone.utc) if now is None else now
    age = int(now.timestamp()) - timestamp
    if not 0 <= age <= 120:
        raise QualificationError("Latest block is future-dated or older than 120 seconds")
    return {
        "status": "single-rpc-identity-check-passed",
        "observedAt": now.isoformat(),
        "chainId": 43113,
        "blockNumber": number,
        "blockHash": block_hash,
        "blockTimestamp": timestamp,
        "executionEnabled": False,
        "qualificationComplete": False,
        "limitations": [
            "Single RPC only; independent-provider agreement and finality not verified",
            "Assets, oracle, liquidity, contracts and gas not qualified",
            "No deployment, signing, transaction submission or economic admission",
        ],
    }


def main():
    try:
        print(json.dumps(qualify(json.loads(CONFIG.read_text())), indent=2))
    except Exception:
        # Transport exceptions can contain URLs; do not leak response bodies or credentials.
        print("Fuji identity check failed; no execution enabled", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
