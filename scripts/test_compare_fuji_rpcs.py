import json
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock

from scripts.compare_fuji_rpcs import compare
from scripts.qualify_fuji import CONFIG, QualificationError, RPC, SECONDARY_RPC, rpc


class ProviderComparisonTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(CONFIG.read_text())
        self.now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.block = {"number": "0x62", "hash": "0x" + "ab" * 32,
                      "timestamp": hex(int(self.now.timestamp()) - 10)}

    def call(self, second=None):
        return MagicMock(side_effect=[
            "0xa869", {**self.block, "number": "0x64"},
            "0xa869", {**self.block, "number": "0x65"},
            self.block, self.block if second is None else second,
        ])

    def test_agreement_at_common_height(self):
        call = self.call()
        result = compare(self.config, call, self.now)
        self.assertEqual(result["blockNumber"], 98)
        self.assertFalse(result["qualificationComplete"])
        self.assertFalse(result["executionEnabled"])
        self.assertEqual(call.call_args_list[-2].args,
                         ("eth_getBlockByNumber", ["0x62", False], RPC))
        self.assertEqual(call.call_args_list[-1].args,
                         ("eth_getBlockByNumber", ["0x62", False], SECONDARY_RPC))

    def test_disagreement_wrong_height_and_stale_fail(self):
        for changes in [{"hash": "0x" + "cd" * 32}, {"number": "0x63"},
                        {"timestamp": hex(int(self.now.timestamp()) - 11)},
                        {"timestamp": "0x1"}]:
            with self.subTest(changes=changes):
                with self.assertRaises(QualificationError):
                    compare(self.config, self.call({**self.block, **changes}), self.now)

    def test_secondary_wrong_chain_fails(self):
        call = MagicMock(side_effect=["0xa869", self.block, "0xa86a"])
        with self.assertRaises(QualificationError):
            compare(self.config, call, self.now)
        self.assertEqual(call.call_count, 3)

    def test_provider_outage_does_not_fallback(self):
        with self.assertRaises(TimeoutError):
            compare(self.config, MagicMock(side_effect=TimeoutError), self.now)

    def test_unknown_endpoint_rejected(self):
        with self.assertRaises(QualificationError):
            rpc("eth_chainId", [], "https://example.com")


if __name__ == "__main__":
    unittest.main()
