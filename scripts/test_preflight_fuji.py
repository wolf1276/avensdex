import copy
import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from scripts.preflight_fuji import (
    ENDPOINTS, READ_METHODS, NoRedirect, main, preflight, readonly_rpc,
)
from scripts.qualify_fuji import (
    CONFIG, MAX_RESPONSE_BYTES, RPC, SECONDARY_RPC, QualificationError,
)

DEPLOYER = "0x" + "12" * 20
ZERO = "0x" + "00" * 20


class FakeTransport:
    """Deterministic read-only provider pair with switchable failure cases."""

    def __init__(self, now, balance=10**18, nonce=7, secondary_balance=None,
                 secondary_nonce=None, pinned_hash_secondary=None,
                 recheck_hash=None, recheck_hash_secondary=None,
                 recheck_timestamp=None, outage_endpoint=None):
        self.now = now
        self.height = 98
        self.timestamp = int(now.timestamp()) - 10
        self.pinned_hash = "0x" + "ab" * 32
        self.secondary_pinned_hash = (
            self.pinned_hash if pinned_hash_secondary is None else pinned_hash_secondary)
        self.recheck_hash = self.pinned_hash if recheck_hash is None else recheck_hash
        self.recheck_hash_secondary = (
            self.recheck_hash if recheck_hash_secondary is None
            else recheck_hash_secondary)
        self.recheck_timestamp = (
            self.timestamp if recheck_timestamp is None else recheck_timestamp)
        self.balances = {
            RPC: balance,
            SECONDARY_RPC: balance if secondary_balance is None else secondary_balance,
        }
        self.nonces = {
            RPC: nonce,
            SECONDARY_RPC: nonce if secondary_nonce is None else secondary_nonce,
        }
        self.outage_endpoint = outage_endpoint
        self.calls = []
        self.pinned_reads = {RPC: 0, SECONDARY_RPC: 0}
        self.heads = {RPC: self.height + 2, SECONDARY_RPC: self.height + 3}

    @staticmethod
    def _quantity(value):
        return hex(value) if isinstance(value, int) else value

    def __call__(self, method, params, endpoint=RPC):
        self.calls.append((method, tuple(params), endpoint))
        if self.outage_endpoint == endpoint:
            raise TimeoutError("provider unavailable")
        if method == "eth_chainId":
            return "0xa869"
        if method == "eth_getBlockByNumber":
            if params[0] == "latest":
                return {"number": hex(self.heads[endpoint]),
                        "hash": "0x" + ("aa" if endpoint == RPC else "bb") * 32,
                        "timestamp": hex(self.timestamp)}
            self.pinned_reads[endpoint] += 1
            first_read = self.pinned_reads[endpoint] == 1
            if endpoint == RPC:
                block_hash = self.pinned_hash if first_read else self.recheck_hash
            else:
                block_hash = (self.secondary_pinned_hash if first_read
                              else self.recheck_hash_secondary)
            timestamp = self.timestamp if first_read else self.recheck_timestamp
            return {"number": hex(self.height), "hash": block_hash,
                    "timestamp": hex(timestamp)}
        if method == "eth_getBalance":
            return self._quantity(self.balances[endpoint])
        if method == "eth_getTransactionCount":
            return self._quantity(self.nonces[endpoint])
        raise AssertionError(f"unexpected method {method}")


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(CONFIG.read_text())
        self.now = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def test_success_reports_observation_but_is_always_blocked(self):
        call = FakeTransport(self.now)
        report = preflight(self.config, DEPLOYER, call, self.now)
        self.assertEqual(report["status"], "read-only-preflight-blocked")
        self.assertEqual(report["blockNumber"], 98)
        self.assertEqual(report["blockHash"], "0x" + "ab" * 32)
        self.assertEqual(report["blockTimestamp"], int(self.now.timestamp()) - 10)
        self.assertEqual(report["balanceWei"], str(10**18))
        self.assertEqual(report["nonce"], 7)
        self.assertTrue(report["funded"])
        self.assertEqual(report["observedAt"], self.now.isoformat())
        self.assertFalse(report["deploymentReady"])
        self.assertFalse(report["executionEnabled"])
        self.assertEqual(report["transactionsSubmitted"], 0)
        self.assertTrue(report["blockers"])
        self.assertTrue(set(call[0] for call in call.calls) <= set(READ_METHODS))
        account_calls = [call for call in call.calls
                         if call[0] in ("eth_getBalance", "eth_getTransactionCount")]
        self.assertEqual(len(account_calls), 4)
        self.assertEqual({call[2] for call in account_calls}, set(ENDPOINTS))
        self.assertTrue(all(call[1][1] == "0x62" for call in account_calls))
        pinned = [i for i, call in enumerate(call.calls)
                  if call[0] == "eth_getBlockByNumber" and call[1][0] == "0x62"]
        self.assertEqual(len(pinned), 4)
        account_indices = [i for i, call in enumerate(call.calls)
                           if call[0] in ("eth_getBalance", "eth_getTransactionCount")]
        self.assertLess(max(pinned[:2]), min(account_indices))
        self.assertGreater(min(pinned[2:]), max(account_indices))

    def test_unsafe_configuration_fails_before_reads(self):
        for field, value in [("chainId", 43114), ("executionEnabled", True),
                             ("mainnetEnabled", True), ("rpcUrl", "https://example.com"),
                             ("secondaryRpcUrl", "https://example.com"),
                             ("schemaVersion", 2), ("network", "mainnet")]:
            with self.subTest(field=field):
                config = copy.deepcopy(self.config)
                config[field] = value
                call = MagicMock()
                with self.assertRaises(QualificationError):
                    preflight(config, DEPLOYER, call, self.now)
                call.assert_not_called()

    def test_bad_deployer_rejected_before_reads(self):
        for deployer in [ZERO, "0x" + "12" * 19, "12" * 20, "0x" + "zz" * 20,
                         None, 123]:
            with self.subTest(deployer=deployer):
                call = MagicMock()
                with self.assertRaises(QualificationError):
                    preflight(self.config, deployer, call, self.now)
                call.assert_not_called()

    def test_provider_outage_does_not_fallback(self):
        for endpoint in ENDPOINTS:
            with self.subTest(endpoint=endpoint):
                call = FakeTransport(self.now, outage_endpoint=endpoint)
                with self.assertRaises((TimeoutError, QualificationError)):
                    preflight(self.config, DEPLOYER, call, self.now)
                self.assertFalse(any(
                    item[0] in ("eth_getBalance", "eth_getTransactionCount")
                    for item in call.calls))

    def test_provider_disagreement_fails(self):
        cases = [
            {"secondary_balance": 1},
            {"secondary_nonce": 8},
            {"pinned_hash_secondary": "0x" + "cd" * 32},
            {"recheck_hash": "0x" + "cd" * 32},
            {"recheck_hash_secondary": "0x" + "cd" * 32},
            {"recheck_timestamp": int(self.now.timestamp()) - 11},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                with self.assertRaises(QualificationError):
                    preflight(self.config, DEPLOYER,
                              FakeTransport(self.now, **changes), self.now)

    def test_malformed_or_unbounded_account_quantities_fail(self):
        for raw in ["0x", "0x00", "1", "0x" + "f" * 65, None, 123]:
            with self.subTest(raw=raw):
                call = FakeTransport(self.now)
                call.balances[SECONDARY_RPC] = raw
                with self.assertRaises(QualificationError):
                    preflight(self.config, DEPLOYER, call, self.now)
            with self.subTest(raw=raw, field="nonce"):
                call = FakeTransport(self.now)
                call.nonces[SECONDARY_RPC] = raw
                with self.assertRaises(QualificationError):
                    preflight(self.config, DEPLOYER, call, self.now)

    def test_observation_expiring_during_account_reads_is_rejected(self):
        started = datetime.now(timezone.utc)
        call = FakeTransport(started)
        with patch("scripts.preflight_fuji.datetime") as clock:
            clock.now.return_value = started + timedelta(seconds=121)
            with self.assertRaises(QualificationError):
                preflight(self.config, DEPLOYER, call)

    def test_nonce_must_fit_eoa_uint64_even_when_providers_agree(self):
        with self.assertRaises(QualificationError):
            preflight(self.config, DEPLOYER,
                      FakeTransport(self.now, nonce=2**64), self.now)

    def test_zero_comparison_hash_is_not_valid_evidence(self):
        call = FakeTransport(self.now)
        empty = "0x" + "00" * 32
        call.pinned_hash = call.secondary_pinned_hash = empty
        call.recheck_hash = call.recheck_hash_secondary = empty
        with self.assertRaises(QualificationError):
            preflight(self.config, DEPLOYER, call, self.now)

    def test_funded_wallet_still_blocked(self):
        report = preflight(self.config, DEPLOYER,
                           FakeTransport(self.now, balance=5 * 10**16), self.now)
        self.assertTrue(report["funded"])
        self.assertFalse(report["deploymentReady"])
        self.assertFalse(report["executionEnabled"])
        self.assertEqual(report["transactionsSubmitted"], 0)


class ReadonlyTransportTests(unittest.TestCase):
    def test_redirect_is_rejected_before_following_another_target(self):
        for code in (301, 302, 303, 307, 308):
            with self.subTest(code=code), self.assertRaises(QualificationError):
                NoRedirect().redirect_request(None, None, code, "redirect", {},
                                              "http://127.0.0.1/private")

    def test_no_write_methods_reach_transport(self):
        for method in ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign",
                       "personal_sign", "wallet_sendCalls", "debug_traceCall"]:
            with self.subTest(method=method):
                with patch("scripts.preflight_fuji.urlopen") as transport:
                    with self.assertRaises(QualificationError):
                        readonly_rpc(method, ["0x"])
                    transport.assert_not_called()

    def test_unknown_endpoint_rejected(self):
        with patch("scripts.preflight_fuji.urlopen") as transport:
            with self.assertRaises(QualificationError):
                readonly_rpc("eth_chainId", [], "https://example.com")
            transport.assert_not_called()

    def test_allowed_read_methods_return_result(self):
        for method in READ_METHODS:
            with self.subTest(method=method):
                with patch("scripts.preflight_fuji.urlopen") as transport:
                    response = transport.return_value.__enter__.return_value
                    response.geturl.return_value = RPC
                    response.read.return_value = (
                        b'{"jsonrpc":"2.0","id":1,"result":"0x1"}')
                    self.assertEqual(readonly_rpc(method, []), "0x1")

    def test_bad_envelopes_redirects_and_oversize_fail(self):
        bodies = [b"{}", b"[]", b"not json",
                  b'{"jsonrpc":"2.0","id":2,"result":"0x1"}',
                  b'{"jsonrpc":"2.0","id":1,"error":{"code":-1}}',
                  b'{"jsonrpc":"2.0","id":1,"result":"0x1","error":null}',
                  b"x" * (MAX_RESPONSE_BYTES + 1)]
        for body in bodies:
            with self.subTest(body_length=len(body)):
                with patch("scripts.preflight_fuji.urlopen") as transport:
                    response = transport.return_value.__enter__.return_value
                    response.geturl.return_value = RPC
                    response.read.return_value = body
                    with self.assertRaises((QualificationError, json.JSONDecodeError)):
                        readonly_rpc("eth_chainId", [])

        with patch("scripts.preflight_fuji.urlopen") as transport:
            response = transport.return_value.__enter__.return_value
            response.geturl.return_value = "https://evil.example"
            response.read.return_value = b'{"jsonrpc":"2.0","id":1,"result":"0x1"}'
            with self.assertRaises(QualificationError):
                readonly_rpc("eth_chainId", [])


class CliTests(unittest.TestCase):
    def test_blocked_report_prints_json_and_returns_2(self):
        report = {"deploymentReady": False, "executionEnabled": False,
                  "transactionsSubmitted": 0, "balanceWei": "0", "nonce": 0}
        with patch("scripts.preflight_fuji.preflight", return_value=report) as probe, \
                redirect_stdout(io.StringIO()) as out:
            code = main(["--deployer", DEPLOYER])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(out.getvalue()), report)
        probe.assert_called_once()
        self.assertEqual(probe.call_args.args[0]["chainId"], 43113)
        self.assertEqual(probe.call_args.args[1], DEPLOYER)

    def test_failure_is_redacted_and_returns_1(self):
        secret = "https://user:pass@provider.example/secret"
        with patch("scripts.preflight_fuji.preflight",
                   side_effect=RuntimeError(secret)), \
                redirect_stderr(io.StringIO()) as err, \
                redirect_stdout(io.StringIO()) as out:
            code = main(["--deployer", DEPLOYER])
        self.assertEqual(code, 1)
        self.assertEqual(out.getvalue(), "")
        self.assertNotIn(secret, err.getvalue())
        self.assertNotIn("provider.example", err.getvalue())
        self.assertIn("Read-only Fuji preflight failed", err.getvalue())

    def test_signer_flags_are_not_supported(self):
        with patch("scripts.preflight_fuji.preflight") as probe, \
                redirect_stderr(io.StringIO()) as err:
            with self.assertRaises(SystemExit) as raised:
                main(["--deployer", DEPLOYER, "--private-key", "0xdead"])
        self.assertEqual(raised.exception.code, 2)
        self.assertNotIn("0xdead", err.getvalue())
        probe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
