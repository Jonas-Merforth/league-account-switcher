"""Independent synthetic wire encoders checked against the 16.21 client code.

These fixtures contain no real match/session data. Set FF_MACOS_BINARY_16_21
to enable the SHA-pinned binary checks. They do not replace a live-game test.
"""
import os
import struct
import unittest
import json
import tempfile
from pathlib import Path
from collections import Counter
from ff_oracle_16_21 import MachO, MacOracle
from ff_live_16_20 import cfb_pass, checksum, analyze, unpack_messages, application_type
from test_ff_live_16_20 import capture


def rol(v, n):
    return ((v << n) | (v >> (8 - n))) & 255


def swap(v):
    return ((v >> 1) & 85) | ((v << 1) & 170)


def inverse_byte(value, decode):
    return next(c for c in range(256) if decode(c) == value)


def varint(value, decode):
    out = []
    while True:
        byte = value & 127
        value >>= 7
        out.append(inverse_byte(byte | (128 if value else 0), decode))
        if not value:
            return bytes(out)


def vote_fixture(binary, team, yes, no=0, update=False, vote_yes=True):
    table = binary.get(0x1020df690, 256)
    def team_decode(c):
        a = rol((table[(c + 0xc8) & 255] + 0xee) & 255, 6)
        v = (~a) & 255
        return (v & 0xaa) | ((v * 4) & 0x54) | (0 if a & 64 else 1)
    def yes_decode(c):
        return swap(((rol(c ^ 0xe0, 4) ^ 0x4a) + 0xce) & 255) ^ 0x60
    # Three-byte field mask: default timeout/actor/kind, variable team/yes;
    # fixed no-count encodings 0,1,2. Common zero NetID prefix is A6.
    no_mode = {0: 1, 1: 5, 2: 2}[no]
    return (bytes([0xa6, 0x61 | (16 if update else 0) | (8 if vote_yes else 0),
                   0xc0 | (no_mode << 3), 0x41]) + varint(team, team_decode)
            + bytes([inverse_byte(yes, yes_decode)]))


def announcement_fixture(binary, team, yes, no, reason):
    table = binary.get(0x1020df690, 256)
    decode_reason = lambda c: rol(((table[rol(swap(c), 2) ^ 0x3d] + 0xc8) & 255) ^ 0x55, 4)
    decode_team = lambda c: ((rol(table[c], 1) ^ 0xa7) + 0x9a) & 255
    decode_no = lambda c: swap(rol(swap(((rol(table[c], 7) ^ 0xf7) + 0x67) & 255), 5))
    decode_yes = lambda c: (rol(rol(c, 5) ^ 0x3e, 3) + 0x92) & 255
    return (bytes([0xa6, 0x0a, 0x5c, 0x05, inverse_byte(no, decode_no)])
            + varint(reason, decode_reason) + varint(team, decode_team)
            + bytes([inverse_byte(yes, decode_yes)]))


@unittest.skipUnless(os.environ.get("FF_MACOS_BINARY_16_21"), "Set FF_MACOS_BINARY_16_21 for client-code validation")
class Oracle21Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = MachO(os.environ["FF_MACOS_BINARY_16_21"])
        cls.oracle = MacOracle(cls.binary)

    def test_known_vote_fields_on_both_teams(self):
        for team in (100, 200):
            for yes in range(1, 6):
                for no in range(3):
                    for update in (False, True):
                        data = vote_fixture(self.binary, team, yes, no, update, no == 0)
                        result = self.oracle.surrender(65, data)
                        self.assertEqual((result["teamId"], result["yes"], result["no"], result["voteYes"]),
                                         (team, yes, no, no == 0))
                        self.assertEqual(result["stage"], "vote-update" if update else "vote-start")

    def test_known_failed_and_accepted_announcements(self):
        for team in (100, 200):
            for yes, no, reason, stage in ((1, 2, 0, "vote-failed"), (4, 0, 4, "surrender-accepted")):
                data = announcement_fixture(self.binary, team, yes, no, reason)
                result = self.oracle.surrender(938, data)
                self.assertEqual((result["teamId"], result["yes"], result["no"], result["reason"], result["stage"]),
                                 (team, yes, no, reason, stage))
                for invalid in (data[:-1], data + b"\0"):
                    with self.assertRaises(ValueError):
                        self.oracle.surrender(938, invalid)

    def test_cipher_against_real_client_48_cases(self):
        o = self.oracle
        o.uc.mem_write(0x1022e0310, struct.pack("<Q", o.DATA + 0x500))
        for length in (4, 16, 24, 56):
            key = bytes(range(length))
            o.uc.mem_write(o.DATA + 0x600, key)
            o.uc.mem_write(o.DATA + 0x700, bytes(8))
            o.call(0x1014be360, o.DATA + 0x10000, o.DATA + 0x600, length, o.DATA + 0x700)
            for size in (0, 1, 7, 8, 9, 15, 16, 17, 23, 31, 64, 101):
                data = bytes((i * 17 + 3) & 255 for i in range(size))
                o.uc.mem_write(o.DATA + 0x800, data or b"\0")
                o.call(0x1014bed80, o.DATA + 0x10000, o.DATA + 0x800, size, 2)
                self.assertEqual(bytes(o.uc.mem_read(o.DATA + 0x800, size)), cfb_pass(data, key, True))
                o.call(0x1014bef10, o.DATA + 0x10000, o.DATA + 0x800, size, 2)
                self.assertEqual(bytes(o.uc.mem_read(o.DATA + 0x800, size)), data)

    def test_checksum_against_real_client_18_cases(self):
        o = self.oracle
        table = struct.unpack("<256I", self.binary.get(o.checksum_table, 1024))
        for seq in (1, 32767, (-14860) & 65535):
            for size in (0, 1, 7, 8, 17, 100):
                body = bytes((i * 13) & 255 for i in range(size))
                ack = bytes(range(8)) if seq & 0x8000 else b"\xff" * 8
                obj, data = o.DATA + 0x2000, o.DATA + 0x3000
                o.uc.mem_write(obj, bytes(128))
                o.uc.mem_write(obj, struct.pack("<QH", 12345678, seq))
                o.uc.mem_write(obj + 24, ack)
                o.uc.mem_write(obj + 72, struct.pack("<QHH", data, size, size))
                o.uc.mem_write(data, body or b"\0")
                self.assertEqual(o.call(0x1005f2b90, obj) & 0xffffffff,
                                 checksum(seq, 12345678, ack, body, table))

    def test_message_framing_and_common_prefix_against_client(self):
        o = self.oracle
        body = struct.pack("<HBH", 3 << 6, 1, 65535) + b"abc"
        body += struct.pack("<H", (2 << 6) | 24) + b"de"
        source, reader, previous, obj = (o.DATA + n for n in (0x9000, 0x2000, 0x3000, 0x4000))
        o.uc.mem_write(source, body)
        o.uc.mem_write(reader, struct.pack("<QHHH", source, len(body), len(body), 0))
        o.uc.mem_write(previous, bytes(64))
        for expected in unpack_messages(body):
            o.uc.mem_write(obj, bytes(64))
            self.assertEqual(o.call(0x1005f1e30, obj, reader, previous) & 255, 1)
            raw = bytes(o.uc.mem_read(obj, 64))
            self.assertEqual((raw[11], struct.unpack_from("<H", raw, 8)[0]),
                             (expected["channel"], expected["sequence"]))
            length = struct.unpack_from("<H", raw, 58)[0]
            self.assertEqual(bytes(o.uc.mem_read(o.qword(obj + 48), length)), expected["payload"])
            o.uc.mem_write(previous, raw)
        for net_id in (0, 0x40000034, 0x400000aa, 0x01000000):
            prefix = o.prefix(net_id)
            o.uc.mem_write(source, prefix)
            o.uc.mem_write(reader, struct.pack("<Q", source))
            self.assertEqual(o.call(0x101614300, obj, reader, source + len(prefix)) & 255, 1)
            self.assertEqual(struct.unpack("<I", o.uc.mem_read(obj + 12, 4))[0], net_id)
        # Runtime initializer uses max(enum count,143)+1267. Check the
        # zero-initialized count and the minimum against the compact-ID parser.
        for count in (0, 143):
            total = o.call(0x100ffe1b0, count)
            o.uc.mem_write(0x10247bfa0, struct.pack("<I", total))
            for payload in (bytes([65]), bytes([253, 175]), bytes([254, 235])):
                o.uc.mem_write(source, payload)
                o.uc.mem_write(reader, struct.pack("<Q", source))
                self.assertEqual(o.call(0x101614290, reader, source + len(payload), obj) & 255, 1)
                self.assertEqual(struct.unpack("<H", o.uc.mem_read(obj, 2))[0], application_type(payload)[0])

    def test_interleaved_sockets_keep_votes_fragments_and_acks_separate(self):
        key, player = bytes(range(16)), 12345678
        table = struct.unpack("<256I", self.binary.get(self.oracle.checksum_table, 1024))
        frames = []

        def add(port, seq, message, outgoing=False):
            ack = bytes(8) if seq & 0x8000 else b"\xff" * 8
            plain = struct.pack("<HIB", seq, checksum(seq, player, ack, message, table), 0)
            plain += (ack if seq & 0x8000 else b"") + message
            wire = bytes(12 if outgoing else 4) + cfb_pass(cfb_pass(plain, key, True)[::-1], key, True)
            ip = bytearray(20)
            ip[0], ip[9] = 0x45, 17
            ip[2:4] = struct.pack(">H", 28 + len(wire))
            ip[12:16] = bytes([127, 0, 0, 2 if outgoing else 1])
            ip[16:20] = bytes([127, 0, 0, 1 if outgoing else 2])
            udp = struct.pack(">HHHH", port if outgoing else 5000, 5000 if outgoing else port, 8 + len(wire), 0)
            frame = bytes(12) + b"\x08\x00" + ip + udp + wire
            frames.append(capture(ticks=1767225600002000 + len(frames) * 10000, frame=frame))

        def message(payload, fragment=None):
            return (struct.pack("<HBH", (len(payload) << 6) | (4 if fragment else 0), 1, 55)
                    + (bytes(fragment) if fragment else b"") + payload)

        vote = bytes([65]) + vote_fixture(self.binary, 100, 1)
        add(6000, 8, message(vote))
        add(6001, 9, message(bytes([65]) + vote_fixture(self.binary, 200, 1)))
        # Complementary fragments on different sockets must not become a vote.
        add(6000, 10, message(vote[:3], (2, 0)))
        add(6001, 11, message(vote[3:], (2, 1)))
        # Sequence 8 exists only on socket 6000; this ack belongs to 6001.
        add(6001, (-8) & 65535, b"", outgoing=True)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pcap = root / "packets.pcapng"
            pcap.write_bytes(b"".join(frames))
            log = root / "r3d"
            log.write_text('Version 16.21.829.8620\nCommand line: "127.0.0.1 5000 AAECAwQFBgcICQoLDA0ODw== 12345678"\n')
            debug = root / "debug.jsonl"
            debug.write_text(json.dumps({"kind": "sample", "gameTime": 900, "data": {
                "localTeam": "ORDER", "clockAnchor": {"gameTime": 900,
                "requestedAt": "2026-01-01T00:00:00Z", "receivedAt": "2026-01-01T00:00:00.004Z"}}}))
            report = analyze(pcap, debug, log, os.environ["FF_MACOS_BINARY_16_21"])
            self.assertEqual(Counter(e["teamRelation"] for e in report["events"]), {"own": 1, "opponent": 1})
            self.assertEqual(report["counts"]["incompleteFragmentGroups"], 2)
            self.assertEqual(report["counts"]["acknowledgedSequencesNotObservedWithin5s"], 1)
            self.assertEqual(report["acknowledgmentCoverageGaps"][0]["flow"], "flow-2")
            self.assertTrue(report["gameLogBuildMatched"])
            self.assertNotIn("6000", json.dumps(report))
            log.write_text(log.read_text().replace("16.21.829.8620", "16.20.824.8524"))
            with self.assertRaisesRegex(ValueError, "does not match"):
                analyze(pcap, debug, log, os.environ["FF_MACOS_BINARY_16_21"])


if __name__ == "__main__":
    unittest.main()
