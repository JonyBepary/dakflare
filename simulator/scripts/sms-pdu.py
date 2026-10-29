#!/usr/bin/env python3
"""Build 3GPP SMS-DELIVER PDUs (hex) for the DakFlare hardware-gate rig.

A single part is the default. GSM 7-bit when every character is in the default
alphabet, UCS-2 otherwise. No SMSC. Timestamp is now, in +06:00.

  python3 sms-pdu.py "+15550001111" "body text" [--ucs2] [--verify]
  python3 sms-pdu.py "+15550001111" "long body" --parts 3
  python3 sms-pdu.py "+15550001111" "long body" --parts 3 --verify

With --parts N the text is split into N concatenated short messages. Each part
carries an 8-bit-reference concatenation UDH (IEI 0x00, IEDL 0x03, reference,
total, sequence) and TP-UDHI. The output is comma-separated PDU hex, which is
exactly what scripts/android/SmsInject.java accepts in one broadcast.

GSM-7 packing is the part the 3GPP rule makes easy to get wrong: the UDH is an
integer number of octets, and the text septets start at the next septet
boundary after it. A six-octet UDH occupies seven septets (48 bits plus one
fill bit), so TP-UDL counts 7 header septets and only 153 text septets remain.
--verify decodes every part, checks the UDH, and reassembles in sequence order.
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

# Concatenated short message limits. A six-octet UDH is seven septets on the
# GSM-7 wire; UCS-2 spends the six octets from the 140-byte payload.
UDH_LEN = 6
GSM_PART_SEPTETS = 160 - 7
UCS2_PART_UNITS = (140 - UDH_LEN) // 2


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


def gsm_septet_count(text):
    """Septets a character costs, or None when it is not GSM 7-bit."""
    septets = gsm7_septets(text)
    return None if septets is None else len(septets)


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


def pack_septets_after_udh(udh, septets):
    """Pack a UDH and the text septets as one continuous little-endian stream.

    The UDH is written as whole octets. Its bit length is rounded up to the
    next septet boundary with zero fill bits, then the text septets follow.
    For a six-octet UDH that is 48 bits + 1 fill + 7*N text bits, and TP-UDL is
    7 + N septets.
    """
    out, acc, bits = bytearray(), 0, 0
    for byte in udh:
        acc |= byte << bits
        bits += 8
        while bits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            bits -= 8

    # bits is 0 after whole UDH octets; insert the fill up to a septet edge.
    bits += (7 - (len(udh) * 8) % 7) % 7
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
    t = time.localtime(when if when is not None else time.time())
    tz_quarters = 6 * 4  # +06:00
    return semi_octets(
        f"{t.tm_year % 100:02d}{t.tm_mon:02d}{t.tm_mday:02d}"
        f"{t.tm_hour:02d}{t.tm_min:02d}{t.tm_sec:02d}{tz_quarters:02d}"
    )


def _pdu_header(sender, dcs, first_octet, when):
    pdu = bytearray()
    pdu += b"\x00"                 # no SMSC
    pdu += bytes([first_octet])    # SMS-DELIVER; 0x40 sets TP-UDHI
    pdu += address(sender)
    pdu += b"\x00"                 # TP-PID
    pdu += bytes([dcs])
    pdu += scts(when)
    return pdu


def encode(sender, body, force_ucs2=False, when=None):
    septets = None if force_ucs2 else gsm7_septets(body)
    if septets is None:
        dcs, ud, udl = 0x08, body.encode("utf-16-be"), len(body.encode("utf-16-be"))
    else:
        dcs, ud, udl = 0x00, pack_septets(septets), len(septets)

    pdu = _pdu_header(sender, dcs, 0x00, when)
    pdu += bytes([udl]) + ud
    return pdu.hex().upper()


def _split_gsm(body, parts):
    """Split into exactly `parts` chunks, none over 153 septets."""
    total = gsm_septet_count(body)
    if total is None:
        raise SystemExit("body is not GSM 7-bit")
    target = min(GSM_PART_SEPTETS, max(1, (total + parts - 1) // parts))
    chunks, current, units = [], [], 0
    for ch in body:
        cost = gsm_septet_count(ch)
        if units and units + cost > target:
            chunks.append("".join(current))
            current, units = [], 0
        current.append(ch)
        units += cost
    if current:
        chunks.append("".join(current))
    if len(chunks) != parts:
        raise SystemExit(
            f"body cannot be split into exactly {parts} GSM-7 parts "
            f"(got {len(chunks)} at {target} septets each)"
        )
    return chunks


def _utf16_units(text):
    """UTF-16 code units, with surrogate pairs kept together."""
    return [(ch, len(ch.encode("utf-16-be")) // 2) for ch in text]


def _split_ucs2(body, parts):
    """Split into exactly `parts` chunks, none over 67 UTF-16 code units."""
    units = _utf16_units(body)
    total = sum(size for _, size in units)
    target = min(UCS2_PART_UNITS, max(1, (total + parts - 1) // parts))
    chunks, current, count = [], [], 0
    for ch, size in units:
        if count and count + size > target:
            chunks.append("".join(current))
            current, count = [], 0
        current.append(ch)
        count += size
    if current:
        chunks.append("".join(current))
    if len(chunks) != parts:
        raise SystemExit(
            f"body cannot be split into exactly {parts} UCS-2 parts "
            f"(got {len(chunks)} at {target} code units each)"
        )
    return chunks


def encode_parts(sender, body, parts, force_ucs2=False, when=None):
    """Encode `parts` concatenated SMS-DELIVER PDUs for one body."""
    if parts < 1:
        raise SystemExit("--parts must be at least 1")
    if parts == 1:
        return [encode(sender, body, force_ucs2, when)]

    when = time.time() if when is None else when
    reference = int(when) & 0xFF
    pdus = []

    if not force_ucs2 and gsm_septet_count(body) is not None:
        chunks = _split_gsm(body, parts)
        for index, chunk in enumerate(chunks, start=1):
            septets = gsm7_septets(chunk)
            udh = bytes([0x05, 0x00, 0x03, reference, parts, index])
            ud = pack_septets_after_udh(udh, septets)
            header_septets = ((len(udh) * 8) + 6) // 7
            udl = header_septets + len(septets)
            pdu = _pdu_header(sender, 0x00, 0x40, when)
            pdu += bytes([udl]) + ud
            pdus.append(pdu.hex().upper())
    else:
        chunks = _split_ucs2(body, parts)
        for index, chunk in enumerate(chunks, start=1):
            data = chunk.encode("utf-16-be")
            udh = bytes([0x05, 0x00, 0x03, reference, parts, index])
            ud = udh + data
            pdu = _pdu_header(sender, 0x08, 0x40, when)
            pdu += bytes([len(ud)]) + ud
            pdus.append(pdu.hex().upper())

    return pdus


def _read_udh(ud):
    """Return (ref, total, seq, octets) for a concatenation UDH, or None."""
    if len(ud) < 2:
        return None
    udhl = ud[0]
    end = 1 + udhl
    if udhl == 0 or len(ud) < end:
        return None
    i = 1
    while i + 1 < end:
        iei = ud[i]
        iedl = ud[i + 1]
        if i + 2 + iedl > end:
            return None
        if iei == 0x00 and iedl == 3:
            return (ud[i + 2], ud[i + 3], ud[i + 4], end)
        i += 2 + iedl
    return None


def _extract_septets(ud, bit_offset, count):
    septets = []
    for k in range(count):
        value = 0
        for bit in range(7):
            pos = bit_offset + 7 * k + bit
            value |= ((ud[pos // 8] >> (pos % 8)) & 1) << bit
        septets.append(value)
    return septets


def _septets_to_text(septets):
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
    return "".join(out)


def decode_part(pdu_hex):
    """Decode one SMS-DELIVER -> (sender, body, (ref, total, seq) | None)."""
    raw = bytes.fromhex(pdu_hex)
    i = 1 + raw[0]                       # skip SMSC
    first_octet = raw[i]
    i += 1                               # SMS-DELIVER, TP-UDHI in bit 6
    udhi = bool(first_octet & 0x40)

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

    udh = None
    if udhi:
        udh = _read_udh(ud)
        if udh is None:
            raise SystemExit("PDU has TP-UDHI but no concatenation UDH")

    if dcs & 0x0C == 0x08:
        if udhi:
            header_octets = udh[3]
            body = ud[header_octets:udl].decode("utf-16-be")
        else:
            body = ud[:udl].decode("utf-16-be")
        concat = udh[:3] if udh else None
        return number, body, concat

    if udhi:
        header_octets = udh[3]
        header_septets = ((header_octets * 8) + 6) // 7
        count = udl - header_septets
        septets = _extract_septets(ud, header_septets * 7, count)
    else:
        septets, acc, bits = [], 0, 0
        for byte in ud:
            acc |= byte << bits
            bits += 8
            while bits >= 7 and len(septets) < udl:
                septets.append(acc & 0x7F)
                acc >>= 7
                bits -= 7
    concat = udh[:3] if udh else None
    return number, _septets_to_text(septets), concat


def decode(pdu_hex):
    """Minimal self-check used by --verify: SMS-DELIVER -> (sender, body)."""
    number, body, _ = decode_part(pdu_hex)
    return number, body


def _usage(message=None):
    if message:
        print(message, file=sys.stderr)
    print(__doc__, file=sys.stderr)
    raise SystemExit(2)


def main(argv):
    parts = 1
    ucs2 = False
    verify = False
    positional = []

    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--parts":
            i += 1
            if i >= len(argv):
                _usage("--parts needs a value")
            try:
                parts = int(argv[i])
            except ValueError:
                _usage("--parts must be a number")
        elif arg == "--ucs2":
            ucs2 = True
        elif arg == "--verify":
            verify = True
        elif arg == "--encoding":
            # Kept for the documented invocation shape; DCS follows the body.
            i += 1
            if i >= len(argv):
                _usage("--encoding needs a value")
        elif arg.startswith("--"):
            _usage(f"unknown option: {arg}")
        else:
            positional.append(arg)
        i += 1

    if len(positional) < 2:
        _usage()
    sender, body = positional[0], positional[1]

    if not body:
        _usage("body is empty")
    if parts < 1:
        _usage("--parts must be at least 1")

    pdus = encode_parts(sender, body, parts, ucs2)

    if verify:
        decoded = [decode_part(pdu) for pdu in pdus]
        numbers = {number for number, _, _ in decoded}
        if numbers != {sender.lstrip("+")} and numbers != {sender}:
            raise SystemExit(f"roundtrip sender mismatch: {numbers} vs {sender!r}")
        if parts == 1:
            if decoded[0][1] != body:
                raise SystemExit(f"roundtrip body mismatch: {decoded[0][1]!r}")
        else:
            concat = [item for item in decoded if item[2] is not None]
            if len(concat) != parts:
                raise SystemExit("roundtrip lost a concatenation UDH")
            refs = {item[2][0] for item in concat}
            totals = {item[2][1] for item in concat}
            sequences = sorted(item[2][2] for item in concat)
            if len(refs) != 1 or totals != {parts} or sequences != list(range(1, parts + 1)):
                raise SystemExit(
                    f"roundtrip UDH mismatch: refs={refs} totals={totals} seq={sequences}"
                )
            ordered = [
                item[1] for item in sorted(decoded, key=lambda item: item[2][2])
            ]
            if "".join(ordered) != body:
                raise SystemExit(f"roundtrip body mismatch: {''.join(ordered)!r}")
        print(
            f"roundtrip ok: {sender} parts={parts} chars={len(body)}",
            file=sys.stderr,
        )

    print(",".join(pdus))


if __name__ == "__main__":
    main(sys.argv[1:])
