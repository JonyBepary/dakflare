#!/usr/bin/env python3
"""Build a 3GPP SMS-DELIVER PDU (hex) for the DakFlare hardware-gate rig.

Single part only. GSM 7-bit when every character is in the default alphabet,
UCS-2 otherwise. No SMSC. Timestamp is now, in +06:00.

  python3 sms_pdu.py "+15550001111" "body text" [--ucs2] [--encoding 0x00]
"""

import sys
import time

# GSM 03.38 default alphabet, index == septet value. Position 0x1B is the
# escape to the extension table, so it must stay in the string to keep every
# later character at its real index.
BASIC = (
    "@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5"
    "\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u001b\u00c6\u00e6\u00df\u00c9"
    " !\"#\u00a4%&'()*+,-./0123456789:;<=>?"
    "\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7"
    "\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0"
)
assert len(BASIC) == 128, len(BASIC)

ESC = {
    "\f": 0x0A, "^": 0x14, "{": 0x28, "}": 0x29, "\\": 0x2F,
    "[": 0x3C, "~": 0x3D, "]": 0x3E, "|": 0x40, "\u20ac": 0x65,
}


def gsm7_septets(text):
    out = []
    for ch in text:
        if ch == "\u001b":
            return None
        if ch in BASIC:
            out.append(BASIC.index(ch))
        elif ch in ESC:
            out += [0x1B, ESC[ch]]
        else:
            return None
    return out


def pack_septets(septets):
    out, acc, bits = bytearray(), 0, 0
    for s in septets:
        acc |= s << bits
        bits += 7
        while bits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            bits -= 8
    if bits:
        out.append(acc & 0xFF)
    return bytes(out)


def semi_octets(digits):
    if len(digits) % 2:
        digits += "F"
    return bytes(int(digits[i + 1] + digits[i], 16) for i in range(0, len(digits), 2))


def address(number, toa=None):
    if toa is None:
        # Alphanumeric originator (a carrier mask such as "bKash") travels as
        # packed 7-bit septets under TOA 0xD0; the length field counts septets.
        if any(ch.isalpha() for ch in number):
            septets = gsm7_septets(number)
            if septets is None:
                raise SystemExit("mask not representable in GSM 7-bit")
            packed = pack_septets(septets)
            # Address-Length counts semi-octets, so the packed byte count is
            # doubled; Android reads (length * 4) / 7 characters from it.
            return bytes([2 * len(packed), 0xD0]) + packed
        toa = 0x91
    digits = number.lstrip("+")
    return bytes([len(digits), toa]) + semi_octets(digits)


def scts(when=None):
    t = time.localtime(when or time.time())
    tz_quarters = 6 * 4  # +06:00
    return semi_octets(
        f"{t.tm_year % 100:02d}{t.tm_mon:02d}{t.tm_mday:02d}"
        f"{t.tm_hour:02d}{t.tm_min:02d}{t.tm_sec:02d}{tz_quarters:02d}"
    )


def encode(sender, body, force_ucs2=False):
    septets = None if force_ucs2 else gsm7_septets(body)
    if septets is None:
        dcs, ud, udl = 0x08, body.encode("utf-16-be"), len(body.encode("utf-16-be"))
    else:
        dcs, ud, udl = 0x00, pack_septets(septets), len(septets)

    pdu = bytearray()
    pdu += b"\x00"                 # no SMSC
    pdu += b"\x00"                 # SMS-DELIVER, single message
    pdu += address(sender)
    pdu += b"\x00"                 # TP-PID
    pdu += bytes([dcs])
    pdu += scts()
    pdu += bytes([udl]) + ud
    return pdu.hex().upper()


def decode(pdu_hex):
    """Minimal self-check used by --verify: SMS-DELIVER -> (sender, body)."""
    raw = bytes.fromhex(pdu_hex)
    i = 1 + raw[0]                       # skip SMSC
    i += 1                               # SMS-DELIVER
    addr_len, toa = raw[i], raw[i + 1]
    i += 2
    nbytes = (addr_len + 1) // 2
    digits = raw[i:i + nbytes].hex().upper()
    i += nbytes
    number = "".join(
        digits[2 * k + 1] + digits[2 * k] for k in range(nbytes)
    )[:addr_len]
    number = number.rstrip("F")
    if toa & 0x70 == 0x10:               # international
        number = "+" + number
    i += 1                               # TP-PID
    dcs = raw[i]
    i += 1
    i += 7                               # SCTS
    udl = raw[i]
    i += 1
    ud = raw[i:]

    if dcs & 0x0C == 0x08:
        return number, ud.decode("utf-16-be")

    septets, acc, bits = [], 0, 0
    for byte in ud:
        acc |= byte << bits
        bits += 8
        while bits >= 7 and len(septets) < udl:
            septets.append(acc & 0x7F)
            acc >>= 7
            bits -= 7
    out, escape = [], False
    ext = {v: k for k, v in ESC.items()}
    for s in septets:
        if escape:
            out.append(ext.get(s, "?"))
            escape = False
        elif s == 0x1B:
            escape = True
        else:
            out.append(BASIC[s])
    return number, "".join(out)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    ucs2 = "--ucs2" in sys.argv
    if len(args) < 2:
        sys.exit(__doc__)
    pdu = encode(args[0], args[1], ucs2)
    if "--verify" in sys.argv:
        number, body = decode(pdu)
        assert number == args[0].lstrip("+") or number == args[0], (number, args[0])
        assert body == args[1], (repr(body), repr(args[1]))
        print(f"roundtrip ok: {number} {body!r}", file=sys.stderr)
    print(pdu)
