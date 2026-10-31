#!/usr/bin/env python3
"""
Independent third implementation of the canonical string — PROTOCOL_CONTRACT_V5 §2.

WHY THIS EXISTS
---------------
The harness (JavaScript) and the Worker (TypeScript) are separate implementations, but
both were derived from the same contract document by the same author-of-record. If the
contract itself were misread, both would misread it the same way and the suite would stay
green while the wire format was wrong.

This script is that missing third opinion. It is deliberately a *different language, a
different SHA-256, a different string-building idiom* and a different author's reading of
the same frozen text. If all three agree byte-for-byte on the published vectors, the
canonical string is almost certainly specified unambiguously.

It asserts only what is deterministic: the body digest and the canonical string. ECDSA
signatures are randomised (contract §4.3), so they are not compared here — the JS harness
proves signature validity and the DER->P1363 conversion separately.

Usage:  python3 test-support/independent-canonical-check.py
Exit:   0 if every vector matches, 1 otherwise.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

# §1.1 — the three field grammars, restated independently.
import re

RE_TIMESTAMP = re.compile(r"^\d{13}$")
RE_NONCE = re.compile(r"^[0-9a-f]{32}$")
RE_DEVICE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

# The one published copy, shared with the JS harness and the Rust core.
SHARED_VECTORS = Path(__file__).with_name("protocol-vectors.json")

# §4.2 — the published vectors, transcribed from the contract.
VECTORS = [
    {
        "id": "A",
        "method": "POST",
        "pathname": "/v1/sms/outgoing/poll",
        "timestamp": "1776470400000",
        "nonce": "a3f1c0d29b7e4f8a1c6d5e2b9f0a7c34",
        "body": '{"ack_command_ids":[],"fcm_token":"fcm-test-token-0001"}',
        "body_bytes_len": 56,
        "body_sha256": "f8c6ca3e8d50126cc59e541a6644ef1db7c3eec01b155a8310dea13143b9f0a9",
        "canonical": (
            "POST\n"
            "/v1/sms/outgoing/poll\n"
            "1776470400000\n"
            "a3f1c0d29b7e4f8a1c6d5e2b9f0a7c34\n"
            "f8c6ca3e8d50126cc59e541a6644ef1db7c3eec01b155a8310dea13143b9f0a9"
        ),
    },
    {
        "id": "B",
        "method": "GET",
        "pathname": "/v1/device/ws",
        "timestamp": "1776470400000",
        "nonce": "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
        "body": "",
        "body_bytes_len": 0,
        "body_sha256": EMPTY_SHA256,
        "canonical": (
            "GET\n"
            "/v1/device/ws\n"
            "1776470400000\n"
            "0f1e2d3c4b5a69788796a5b4c3d2e1f0\n"
            + EMPTY_SHA256
        ),
    },
    {
        "id": "C",
        "method": "POST",
        "pathname": "/v1/sms/incoming/batch",
        "timestamp": "1776470400000",
        "nonce": "deadbeefcafebabe0123456789abcdef",
        "body": (
            '{"messages":[{"local_id":"m_0001","sender":"+8801712345678",'
            '"body":"\u0986\u09b8\u09b8\u09be\u09b2\u09be\u09ae\u09c1 '
            '\u0986\u09b2\u09be\u0987\u0995\u09c1\u09ae",'
            '"received_at":"2026-04-18T09:15:00.000Z"}]}'
        ),
        "body_bytes_len": 159,
        "body_sha256": "1459860ca2b1d0a6e64d93d02246fb1f6c04d574b75bcdd485881d5830486fc6",
        "canonical": (
            "POST\n"
            "/v1/sms/incoming/batch\n"
            "1776470400000\n"
            "deadbeefcafebabe0123456789abcdef\n"
            "1459860ca2b1d0a6e64d93d02246fb1f6c04d574b75bcdd485881d5830486fc6"
        ),
    },
]


def build_canonical(method: str, pathname: str, ts: str, nonce: str, body: str) -> str:
    """§2.1 — five lines, four \\n, no trailing newline, no ${search} segment."""
    body_sha = hashlib.sha256(body.encode("utf-8")).hexdigest()
    return "\n".join([method.upper(), pathname, ts, nonce, body_sha])


def main() -> int:
    passed = failed = 0

    def check(label: str, actual, expected) -> None:
        nonlocal passed, failed
        if actual == expected:
            passed += 1
            print(f"PASS  {label}")
        else:
            failed += 1
            print(f"FAIL  {label}")
            print(f"        expected: {expected!r}")
            print(f"        actual:   {actual!r}")

    print("-- independent restatement of the §1.1 grammars --")
    check("13 digits accepted", bool(RE_TIMESTAMP.match("1776470400000")), True)
    check("whitespace-padded rejected by the validator (§1.2.1)", bool(RE_TIMESTAMP.match(" 1776470400000")), False)
    check('"+" prefix rejected', bool(RE_TIMESTAMP.match("+1776470400000")), False)
    check('trailing ".0" rejected', bool(RE_TIMESTAMP.match("1776470400000.0")), False)
    check("exponent rejected", bool(RE_TIMESTAMP.match("1.7e12")), False)
    check("32 lowercase hex nonce accepted", bool(RE_NONCE.match("a" * 32)), True)
    check("uppercase nonce rejected", bool(RE_NONCE.match("A" * 32)), False)
    check("device_id alphabet accepted", bool(RE_DEVICE_ID.match("dev047e6bd0a9cc594f")), True)

    print("\n-- §4.2 vectors, computed independently --")
    for v in VECTORS:
        raw = v["body"].encode("utf-8")
        check(f"{v['id']} body_bytes_len (UTF-8, not characters)", len(raw), v["body_bytes_len"])
        check(f"{v['id']} body_sha256", hashlib.sha256(raw).hexdigest(), v["body_sha256"])
        canonical = build_canonical(v["method"], v["pathname"], v["timestamp"], v["nonce"], v["body"])
        check(f"{v['id']} canonical string", canonical, v["canonical"])
        check(f"{v['id']} five lines", len(canonical.split("\n")), 5)
        check(f"{v['id']} no trailing newline", canonical.endswith("\n"), False)

    print("\n-- §2.3 the empty-body digest --")
    check('SHA-256("") matches the published empty-body digest',
          hashlib.sha256(b"").hexdigest(), EMPTY_SHA256)
    check("GET signs the empty-body digest, not an empty string",
          build_canonical("GET", "/v1/device/ws", "1776470400000",
                          "0f1e2d3c4b5a69788796a5b4c3d2e1f0", "").split("\n")[4],
          EMPTY_SHA256)

    print("\n-- the shared file agrees with this transcription --")
    # The transcription above is the independent opinion and must NOT be derived
    # from this file. Comparing the two is the point: if the contract's published
    # values change and only one copy follows, this fails.
    shared = json.loads(SHARED_VECTORS.read_text(encoding="utf-8"))
    by_id = {vector["id"]: vector for vector in shared["canonical"]}
    check("the file carries the same vector ids",
          sorted(by_id), sorted(vector["id"] for vector in VECTORS))
    for vector in VECTORS:
        other = by_id.get(vector["id"])
        if other is None:
            check(f"{vector['id']} present in the shared file", False, True)
            continue
        for field in ("method", "pathname", "timestamp", "nonce", "body", "canonical"):
            check(f"{vector['id']} {field} matches the shared file",
                  other.get(field), vector[field])
        check(f"{vector['id']} body_bytes matches the shared file",
              other.get("body_bytes"), vector["body_bytes_len"])
        check(f"{vector['id']} body_sha256 matches the shared file",
              other.get("body_sha256"), vector["body_sha256"])
    check("empty_body_sha256 matches the shared file",
          shared.get("empty_body_sha256"), EMPTY_SHA256)

    print("\n-- method normalisation --")
    check("lowercase method is uppercased",
          build_canonical("post", "/x", "1" * 13, "0" * 32, "").split("\n")[0], "POST")

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
