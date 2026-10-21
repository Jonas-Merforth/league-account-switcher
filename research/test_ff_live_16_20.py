"""Synthetic parser tests and optional independent macOS oracle checks.

Set FF_MACOS_BINARY to enable execution against the SHA-pinned local binary.
No real game key, launch log or captured payload is included in these tests.
"""

import collections
import json
import os
import struct
import tempfile
import unittest
from pathlib import Path

from ff_live_16_20 import (Clock, Fragments, Session, acknowledgment_gaps,
                         application_type, cfb_pass, checksum, decode_transport,
                         decrypt, pcap_records, read_session, udp_frame, unpack_messages)
from ff_oracle_16_20 import MachO, MacOracle


def block(kind, body, endian="<"):
    size = len(body) + 12
    return struct.pack(endian + "II", kind, size) + body + struct.pack(endian + "I", size)


def capture(endian="<", resolution=6, ticks=1234567, frame=b"abcd", original=None):
    shb = block(0x0a0d0d0a, struct.pack(endian + "IHHq", 0x1a2b3c4d, 1, 0, -1), endian)
    opts = struct.pack(endian + "HH", 9, 1) + bytes([resolution, 0, 0, 0]) + bytes(4)
    idb = block(1, struct.pack(endian + "HHI", 1, 0, 65535) + opts, endian)
    epb = block(6, struct.pack(endian + "5I", 0, ticks >> 32, ticks & 0xffffffff,
                              len(frame), original or len(frame)) + frame + bytes(-len(frame) % 4), endian)
    return shb + idb + epb


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, data):
        path = self.root / name
        path.write_bytes(data)
        return path

    def test_pcap_endian_and_timestamp_resolution(self):
        for endian in ("<", ">"):
            for resolution, ticks, seconds in ((6, 1234567, 1.234567), (9, 1234567, .001234567), (0x8a, 1024, 1)):
                counts = collections.Counter()
                rows = list(pcap_records(self.write("capture", capture(endian, resolution, ticks)), counts))
                self.assertEqual(len(rows), 1)
                self.assertAlmostEqual(rows[0][1], seconds)
                self.assertEqual(rows[0][2], b"abcd")
                self.assertEqual(counts["pcapRecords"], 1)

    def test_pcap_sections_reset_interfaces(self):
        rows = list(pcap_records(self.write("capture", capture() + capture(">")), collections.Counter()))
        self.assertEqual([r[0] for r in rows], [1, 2])

    def test_pcap_truncation_and_bad_footer(self):
        for raw in (capture()[:-1], capture()[:-4] + bytes(4), b"abc"):
            with self.assertRaises(ValueError):
                list(pcap_records(self.write("capture", raw), collections.Counter()))
        counts = collections.Counter()
        self.assertEqual(list(pcap_records(self.write("capture", capture(original=5)), counts)), [])
        self.assertEqual(counts["truncatedRecords"], 1)

    def test_message_context_varint_and_fragment(self):
        # Explicit channel/sequence, then inherited channel + incremented seq.
        first = struct.pack("<HBH", 3 << 6, 1, 65535) + b"abc"
        second = struct.pack("<H", (2 << 6) | 16 | 8 | 4 | 3) + b"\2\0\x0a" + b"de"
        rows = unpack_messages(first + second)
        self.assertEqual((rows[1]["channel"], rows[1]["sequence"], rows[1]["fragment"], rows[1]["field"]), (1, 0, (2, 0), 8))
        self.assertEqual(rows[1]["payload"], b"de")
        # Verified zero-initialized previous-message context.
        self.assertEqual(unpack_messages(struct.pack("<H", 24))[0]["sequence"], 1)

    def test_message_rejects_overruns_and_invalid_fragments(self):
        for raw in (b"x", struct.pack("<HBH", 2 << 6, 1, 0) + b"x",
                    struct.pack("<HBH", 4, 1, 0) + b"\2\2",
                    struct.pack("<HBH", 3, 1, 0) + b"\xff" * 5):
            with self.assertRaises(ValueError):
                unpack_messages(raw)

    def test_compact_type_boundaries(self):
        self.assertEqual(application_type(bytes([250])), (250, 1))
        self.assertEqual(application_type(bytes([251, 0])), (251, 2))
        self.assertEqual(application_type(bytes([252, 231])), (738, 2))
        self.assertEqual(application_type(bytes([254, 43])), (1062, 2))
        for raw in (b"", b"\xfb"):
            with self.assertRaises(ValueError):
                application_type(raw)

    def test_fragment_reorder_conflict_expiry(self):
        counts = collections.Counter()
        f = Fragments(counts)
        def msg(index, payload):
            return {"fragment": (2, index), "channel": 1, "sequence": 99, "payload": payload}
        self.assertIsNone(f.feed(msg(1, b"b"), "in", 1, 1))
        self.assertEqual(f.feed(msg(0, b"a"), "in", 2, 2), (b"ab", [1, 2]))
        f.feed(msg(0, b"a"), "in", 3, 3)
        f.feed(msg(0, b"x"), "in", 4, 4)
        self.assertEqual(counts["conflictingFragmentGroups"], 1)
        f.feed(msg(0, b"a"), "in", 5, 5)
        f.expire(11)
        self.assertEqual(counts["incompleteFragmentGroups"], 1)

    def test_session_secrets_are_not_exception_text(self):
        secret = "synthetic-private-token"
        bad = self.write("r3d", f'Command line: "127.0.0.1 5000 {secret} 123"'.encode())
        with self.assertRaises(ValueError) as caught:
            read_session(bad)
        self.assertNotIn(secret, str(caught.exception))
        good = self.write("r3d", b'Command line: "127.0.0.1 5000 YWJjZGVmZ2hpamtsbW5vcA== 123" --auth=DO-NOT-EXPORT')
        session = read_session(good)
        self.assertEqual(session.key, b"abcdefghijklmnop")
        self.assertNotIn("abcdefghijklmnop", repr(session))

    def test_udp_flow_direction_and_length(self):
        session = Session(b"abcdefgh", 123, bytes([127, 0, 0, 1]), 5000)
        ip = bytearray(20)
        ip[0], ip[9] = 0x45, 17
        ip[2:4] = struct.pack(">H", 31)
        ip[12:16], ip[16:20] = session.server, bytes([127, 0, 0, 2])
        frame = bytes(12) + b"\x08\x00" + ip + struct.pack(">HHHH", 5000, 6000, 11, 0) + b"abc"
        self.assertEqual(udp_frame(frame, session), (("in", b"abc", 6000), None))
        with self.assertRaises(ValueError):
            udp_frame(frame[:-1], session)

    def test_clock_and_signed_ack_sequence(self):
        row = {"kind": "sample", "gameTime": 10, "data": {"localTeam": "ORDER", "clockAnchor": {
            "requestedAt": "2026-01-01T00:00:00Z", "receivedAt": "2026-01-01T00:00:00.004Z", "gameTime": 10}}}
        clock = Clock(self.write("debug", json.dumps(row).encode()))
        utc = clock.times[0]
        self.assertAlmostEqual(clock.align(utc + 1)["gameTimeEstimate"], 11)
        self.assertIsNone(clock.align(utc + 6)["gameTimeEstimate"])
        traffic = [(1, utc, "in", 14859), (2, utc + .01, "out", (-14859) & 65535),
                   (3, utc + .02, "out", (-14860) & 65535)]
        gaps = acknowledgment_gaps(traffic, clock)
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0]["sequence"], 14860)

    def test_wrong_binary_is_rejected_before_execution(self):
        with self.assertRaisesRegex(ValueError, "verified official"):
            MachO(self.write("binary", b"not-the-verified-client"))


@unittest.skipUnless(os.environ.get("FF_MACOS_BINARY"), "Set FF_MACOS_BINARY for independent client-code validation")
class OracleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = MachO(os.environ["FF_MACOS_BINARY"])
        cls.oracle = MacOracle(cls.binary)

    def test_cipher_against_real_client_48_cases(self):
        o = self.oracle
        o.uc.mem_write(0x10255e310, struct.pack("<Q", o.DATA + 0x500))
        for length in (4, 16, 24, 56):
            key = bytes(range(length))
            o.uc.mem_write(o.DATA + 0x600, key)
            o.uc.mem_write(o.DATA + 0x700, bytes(8))
            o.call(0x101711140, o.DATA + 0x10000, o.DATA + 0x600, length, o.DATA + 0x700)
            for size in (0, 1, 7, 8, 9, 15, 16, 17, 23, 31, 64, 101):
                with self.subTest(keyLength=length, payloadLength=size):
                    data = bytes((i * 17 + 3) & 255 for i in range(size))
                    o.uc.mem_write(o.DATA + 0x800, data or b"\0")
                    o.call(0x101711b60, o.DATA + 0x10000, o.DATA + 0x800, size, 2)
                    self.assertEqual(bytes(o.uc.mem_read(o.DATA + 0x800, size)), cfb_pass(data, key, True))
                    o.call(0x101711cf0, o.DATA + 0x10000, o.DATA + 0x800, size, 2)
                    self.assertEqual(bytes(o.uc.mem_read(o.DATA + 0x800, size)), data)

    def test_checksum_against_real_client_and_wrong_key_rejection(self):
        o = self.oracle
        table = struct.unpack("<256I", self.binary.get(0x102337ec0, 1024))
        key, player = bytes(range(16)), 12345678  # synthetic only
        for seq in (1, 32767, (-14860) & 65535):
            for size in (0, 1, 7, 8, 17, 100):
                body = bytes((i * 13) & 255 for i in range(size))
                ack = bytes(range(8)) if seq & 0x8000 else b"\xff" * 8
                obj, data = o.DATA + 0x2000, o.DATA + 0x3000
                o.uc.mem_write(obj, bytes(128))
                o.uc.mem_write(obj, struct.pack("<QH", player, seq))
                o.uc.mem_write(obj + 24, ack)
                o.uc.mem_write(obj + 72, struct.pack("<QHH", data, size, size))
                o.uc.mem_write(data, body or b"\0")
                expected = checksum(seq, player, ack, body, table)
                self.assertEqual(o.call(0x1005e90b0, obj) & 0xffffffff, expected)
                plain = struct.pack("<HIB", seq, expected, 0) + (ack if seq & 0x8000 else b"") + body
                wire = bytes(4) + cfb_pass(cfb_pass(plain, key, True)[::-1], key, True)
                session = Session(key, player, bytes(4), 5000)
                self.assertEqual(decode_transport(wire, "in", session, table), (seq, 0, body))
                # Below one complete cipher block, both passes leave bytes
                # unchanged except reversal; such a packet cannot verify a key.
                if len(plain) >= 8:
                    with self.assertRaisesRegex(ValueError, "checksum-failure"):
                        decode_transport(wire, "in", Session(bytes(reversed(key)), player, bytes(4), 5000), table)

    def test_semantic_decoder_rejects_short_or_trailing_input(self):
        for pid in (662, 668, 738):
            for data in (b"", b"\xa6", b"\xa6" + bytes(128)):
                with self.assertRaises(ValueError):
                    self.oracle.deserialize(pid, data)
        # Captured type 673's four-byte body is deliberately not a fixture or a
        # confirmed game-end event; failed exact consumption stays a rejection.

    def test_message_framing_against_real_client(self):
        o = self.oracle
        first = struct.pack("<HBH", 3 << 6, 1, 65535) + b"abc"
        second = struct.pack("<H", (2 << 6) | 16 | 8 | 4 | 3) + b"\2\0\x0a" + b"de"
        for body in (first + second, struct.pack("<H", 24)):
            source, reader, previous, obj = (o.DATA + n for n in (0x9000, 0x2000, 0x3000, 0x4000))
            o.uc.mem_write(source, body)
            o.uc.mem_write(reader, struct.pack("<QHHH", source, len(body), len(body), 0))
            o.uc.mem_write(previous, bytes(64))
            for expected in unpack_messages(body):
                o.uc.mem_write(obj, bytes(64))
                result = o.call(0x1005e8350, obj, reader, previous)
                self.assertEqual(result & 255, 1)
                raw = bytes(o.uc.mem_read(obj, 64))
                self.assertEqual(raw[11], expected["channel"])
                self.assertEqual(struct.unpack_from("<H", raw, 8)[0], expected["sequence"])
                self.assertEqual(struct.unpack_from("<I", raw, 40)[0], expected["field"])
                if expected["fragment"]:
                    self.assertEqual(tuple(raw[24:26]), expected["fragment"])
                length = struct.unpack_from("<H", raw, 58)[0]
                data = bytes(o.uc.mem_read(o.qword(obj + 48), length)) if length else b""
                self.assertEqual(data, expected["payload"])
                o.uc.mem_write(previous, raw)
            self.assertEqual(struct.unpack("<H", o.uc.mem_read(reader + 12, 2))[0], len(body))


if __name__ == "__main__":
    unittest.main()
