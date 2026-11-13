import copy
import json
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from scripts.qualify_fuji import CONFIG, QualificationError, qualify, rpc


class FujiQualificationTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(CONFIG.read_text())
        self.now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.block = {"number": "0x123", "hash": "0x" + "ab" * 32,
                      "timestamp": hex(int(self.now.timestamp()) - 5)}
        self.call = MagicMock(side_effect=["0xa869", self.block])

    def test_fuji_identity_is_not_full_qualification(self):
        result = qualify(self.config, self.call, self.now)
        self.assertEqual(result["chainId"], 43113)
        self.assertEqual(result["blockNumber"], 291)
        self.assertFalse(result["executionEnabled"])
        self.assertFalse(result["qualificationComplete"])
        self.assertEqual(self.call.call_args_list[1].args,
                         ("eth_getBlockByNumber", ["latest", False]))

    def test_unsafe_configuration_fails_before_network(self):
        for field, value in [("chainId", 43114), ("executionEnabled", True),
                             ("mainnetEnabled", True), ("rpcUrl", "https://example.com"),
                             ("schemaVersion", 2), ("network", "mainnet")]:
            with self.subTest(field=field):
                config = copy.deepcopy(self.config)
                config[field] = value
                with self.assertRaises(QualificationError):
                    qualify(config, self.call, self.now)
        self.call.assert_not_called()

    def test_wrong_chain_stops_before_block_read(self):
        for chain in ["0xa86a", "0x1", None, 43113, "0x0a869"]:
            with self.subTest(chain=chain):
                call = MagicMock(return_value=chain)
                with self.assertRaises(QualificationError):
                    qualify(self.config, call, self.now)
                self.assertEqual(call.call_count, 1)

    def test_invalid_blocks_fail_closed(self):
        cases = [None, {}, {**self.block, "hash": "0x123"},
                 {**self.block, "number": "123"},
                 {**self.block, "timestamp": hex(int(self.now.timestamp()) + 1)},
                 {**self.block, "timestamp": hex(int(self.now.timestamp()) - 121)}]
        for block in cases:
            with self.subTest(block=block):
                with self.assertRaises(QualificationError):
                    qualify(self.config, MagicMock(side_effect=["0xa869", block]), self.now)

    def test_transport_is_read_only(self):
        with patch("scripts.qualify_fuji.urlopen") as transport:
            with self.assertRaises(QualificationError):
                rpc("eth_sendRawTransaction", ["0x"])
            transport.assert_not_called()

    def test_bad_rpc_envelopes_and_oversize_responses(self):
        bodies = [b'{}', b'[]', b'not json',
                  b'{"jsonrpc":"2.0","id":2,"result":"0xa869"}',
                  b'{"jsonrpc":"2.0","id":1,"error":{"code":-1}}',
                  b'x' * 1_048_577]
        for body in bodies:
            with self.subTest(body_length=len(body)):
                with patch("scripts.qualify_fuji.urlopen") as transport:
                    response = transport.return_value.__enter__.return_value
                    response.geturl.return_value = self.config["rpcUrl"]
                    response.read.return_value = body
                    with self.assertRaises((QualificationError, json.JSONDecodeError)):
                        rpc("eth_chainId", [])


if __name__ == "__main__":
    unittest.main()
