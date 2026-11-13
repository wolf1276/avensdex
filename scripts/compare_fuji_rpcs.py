"""Compare independently operated public Fuji RPCs; never submit transactions."""
import json
import sys
from datetime import datetime

from scripts.qualify_fuji import (
    CONFIG, RPC, SECONDARY_RPC, QualificationError, qualify, rpc, validate_config,
)


def compare(config, call=rpc, now: datetime | None = None):
    validate_config(config)
    # With no fixed test clock, qualify samples time after each response, not before network I/O.
    endpoints = (RPC, SECONDARY_RPC)
    heads = []
    for endpoint in endpoints:
        heads.append(qualify(config, lambda method, params: call(method, params, endpoint), now))
    # Two-block lag is a comparison point only, not a finality guarantee.
    height = min(head["blockNumber"] for head in heads) - 2
    if height < 0:
        raise QualificationError("Insufficient chain history")
    snapshots = []
    for endpoint in endpoints:
        block = call("eth_getBlockByNumber", [hex(height), False], endpoint)
        # Reuse structural/freshness checks on the pinned response.
        snapshot = qualify(config, lambda method, params: "0xa869" if method == "eth_chainId" else block, now)
        if snapshot["blockNumber"] != height:
            raise QualificationError("Provider returned the wrong block height")
        snapshots.append(snapshot)
    if (snapshots[0]["blockHash"].lower() != snapshots[1]["blockHash"].lower()
            or snapshots[0]["blockTimestamp"] != snapshots[1]["blockTimestamp"]):
        raise QualificationError("Providers disagree at the comparison block")
    return {
        **snapshots[0],
        "status": "two-provider-block-agreement-passed",
        "providers": list(endpoints),
        "headNumbers": [head["blockNumber"] for head in heads],
        "limitations": [
            "Same-block agreement is not a finality guarantee or automatic failover policy",
            "Provider limits, historical logs and WebSocket behavior not qualified",
            "Assets, oracle, liquidity, contracts and gas not qualified",
            "No deployment, signing, transaction submission or economic admission",
        ],
    }


def main():
    try:
        print(json.dumps(compare(json.loads(CONFIG.read_text())), indent=2))
    except Exception:
        print("Fuji provider comparison failed; no execution enabled", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
