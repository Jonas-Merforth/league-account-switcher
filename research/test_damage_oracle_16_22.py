"""Transport checks against the exact 16.22 artifact; no live damage coverage claim."""
import os
import struct
import unittest
import tempfile
import json
from pathlib import Path
from damage_capture_16_22 import analyze
from damage_raw_capture import game_packet
from test_ff_live_16_20 import capture
from damage_oracle_16_22 import MachO, MacOracle
from ff_live_16_20 import cfb_pass, checksum, unpack_messages, application_type

@unittest.skipUnless(os.environ.get("DAMAGE_MACOS_BINARY_16_22"), "Set DAMAGE_MACOS_BINARY_16_22 for binary validation")
class Transport22Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = MachO(os.environ["DAMAGE_MACOS_BINARY_16_22"])
        cls.oracle = MacOracle(cls.binary)

    def test_cipher_against_real_client_48_cases(self):
        o = self.oracle
        o.uc.mem_write(o.stack_guard_pointer, struct.pack("<Q", o.DATA + 0x500))
        for length in (4, 16, 24, 56):
            key = bytes(range(length))
            o.uc.mem_write(o.DATA + 0x600, key)
            o.uc.mem_write(o.DATA + 0x700, bytes(8))
            o.call(o.cipher_setup, o.DATA + 0x10000, o.DATA + 0x600, length, o.DATA + 0x700)
            for size in (0, 1, 7, 8, 9, 15, 16, 17, 23, 31, 64, 101):
                data = bytes((i * 17 + 3) & 255 for i in range(size))
                o.uc.mem_write(o.DATA + 0x800, data or b"\0")
                o.call(o.cipher_encrypt, o.DATA + 0x10000, o.DATA + 0x800, size, 2)
                self.assertEqual(bytes(o.uc.mem_read(o.DATA + 0x800, size)), cfb_pass(data, key, True))
                o.call(o.cipher_decrypt, o.DATA + 0x10000, o.DATA + 0x800, size, 2)
                self.assertEqual(bytes(o.uc.mem_read(o.DATA + 0x800, size)), data)

    def test_candidate_fields_against_consumer(self):
        # Independently invert byte transformations; execute original consumer.
        # This validates field extraction, not packet delivery/meaning in a game.
        o = self.oracle
        table = self.binary.get(0x10210a2a0, 256)
        rol = lambda b, n: ((b << n) | (b >> (8 - n))) & 255
        swap = lambda b: ((b >> 1) & 85) | ((b << 1) & 170)
        def encode(data, decode):
            inverse = {decode(b): b for b in range(256)}
            self.assertEqual(len(inverse), 256)
            return bytes(inverse[b] for b in data)
        for i in range(24):
            actor, target, amount = 0x40000000 + i, 0x01000000 + i * 177, i * 17.25
            obj = o.construct_for_research(393)
            o.uc.mem_write(obj + 0x20, encode(struct.pack('<I', target), lambda b: rol(table[table[swap(b)]], 3)))
            o.uc.mem_write(obj + 0x18, encode(struct.pack('<I', actor), lambda b: swap((swap(table[rol(swap(b), 4)]) + 0x28) & 255)))
            o.uc.mem_write(obj + 0x10, encode(struct.pack('<f', amount), lambda b: rol(table[b] ^ 0x57, 1)))
            o.uc.mem_write(obj + 0x24, encode(bytes([i % 3]), lambda b: swap((~swap((table[(table[b] + 0xdc) & 255] + 0xf5) & 255)) & 255)))
            o.uc.mem_write(obj + 0x14, encode(struct.pack('<I', 0x12345678), lambda b: (~table[b]) & 255))
            fields = o.candidate_fields(obj)
            self.assertEqual(fields['candidateSourceNetId'], actor)
            self.assertEqual(fields['candidateTargetNetId'], target)
            self.assertEqual(fields['candidateAmount'], amount)
            self.assertEqual(fields['candidateTypeCode'], i % 3)
            self.assertEqual(fields['candidateHash'], 0x12345678)

    def test_candidate_rejects_missing_and_truncated_payloads(self):
        for data in (b'', b'\0', b'\0\0', bytes(0x7000)):
            with self.assertRaises(ValueError):
                self.oracle.candidate_damage(data)

    def test_compact_packet_ids_against_runtime_initializer(self):
        o = self.oracle
        source, cursor, result = (o.DATA + n for n in (0x2000, 0x3000, 0x4000))
        for count in (0, 143):
            total = o.call(0x101006630, count)
            self.assertEqual(total, 1416)
            o.uc.mem_write(0x1024c41b0, struct.pack('<I', total))
            for packet_id in (0, 37, 250, 251, 393, 1272, 1415):
                data = bytes([packet_id]) if packet_id < 251 else bytes([251 + ((packet_id - 251) >> 8), (packet_id - 251) & 255])
                o.uc.mem_write(source, data)
                o.uc.mem_write(cursor, struct.pack('<Q', source))
                self.assertEqual(o.call(0x10161e570, cursor, source + len(data), result) & 255, 1)
                self.assertEqual(struct.unpack('<H', o.uc.mem_read(result, 2))[0], packet_id)
                self.assertEqual(application_type(data), (packet_id, len(data)))

    def test_capture_pipeline_rejects_bad_candidates_and_never_claims_damage(self):
        key, player, seq = bytes(range(16)), 12345678, 2
        table = struct.unpack('<256I', self.binary.get(self.oracle.checksum_table, 1024))
        # Correct encrypted transport, but a deliberately truncated 393 payload.
        payload = bytes([251, 142, 0])
        body = struct.pack('<HBH', len(payload) << 6, 1, 55) + payload
        plain = struct.pack('<HIB', seq, checksum(seq, player, b'\xff' * 8, body, table), 0) + body
        wire = bytes(4) + cfb_pass(cfb_pass(plain, key, True)[::-1], key, True)
        ip = bytearray(20)
        ip[0], ip[9] = 0x45, 17
        ip[2:4] = struct.pack('>H', 28 + len(wire))
        ip[12:16], ip[16:20] = bytes([127, 0, 0, 1]), bytes([127, 0, 0, 2])
        udp = struct.pack('>HHHH', 5000, 6000, 8 + len(wire), 0)
        frame = bytes(12) + b'\x08\x00' + ip + udp + wire
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pcap, log, observations = (root / n for n in ('capture', 'r3d', 'observations'))
            pcap.write_bytes(capture(ticks=1767225600002000, frame=frame))
            log.write_text('Version 16.22.834.8910\nCommand line: "127.0.0.1 5000 AAECAwQFBgcICQoLDA0ODw== 12345678"\n')
            observations.write_text(json.dumps({'kind': 'sample', 'gameTime': 42,
                'requestedAt': '2026-01-01T00:00:00Z', 'at': '2026-01-01T00:00:00.004Z'}) + '\n')
            report = analyze(pcap, observations, log, os.environ['DAMAGE_MACOS_BINARY_16_22'])
            self.assertEqual(report['counts']['checksumPass'], 1)
            self.assertEqual(report['counts']['candidateRejected'], 1)
            self.assertEqual(report['candidates'], [])
            self.assertFalse(report['sourceValidated'])
            for secret in ('AAECAwQF', '127.0.0.1', '12345678'):
                self.assertNotIn(secret, json.dumps(report))
            self.assertEqual(game_packet(frame[14:], ip[12:16], ip[16:20], 5000, {6000}), ('in', frame[14:]))
            self.assertIsNone(game_packet(frame[14:], ip[12:16], ip[16:20], 5000, {6001}))
            raw = root / 'raw-ipv4'
            raw.write_bytes(capture(ticks=1767225600002001, frame=frame[14:], link=228))
            merged = analyze(pcap, observations, log, os.environ['DAMAGE_MACOS_BINARY_16_22'], raw)
            self.assertEqual(merged['counts']['checksumPassRawIp'], 1)
            self.assertEqual(merged['counts']['duplicateDatagramsWithin5s'], 1)
            self.assertEqual(merged['counts']['candidateRejected'], 1)

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
                self.assertEqual(o.call(o.checksum_function, obj) & 0xffffffff,
                                 checksum(seq, 12345678, ack, body, table))

    def test_message_framing_against_client(self):
        o = self.oracle
        body = struct.pack("<HBH", 3 << 6, 1, 65535) + b"abc"
        body += struct.pack("<H", (2 << 6) | 24) + b"de"
        source, reader, previous, obj = (o.DATA + n for n in (0x9000, 0x2000, 0x3000, 0x4000))
        o.uc.mem_write(source, body)
        o.uc.mem_write(reader, struct.pack("<QHHH", source, len(body), len(body), 0))
        o.uc.mem_write(previous, bytes(64))
        for expected in unpack_messages(body):
            o.uc.mem_write(obj, bytes(64))
            self.assertEqual(o.call(o.message_reader, obj, reader, previous) & 255, 1)
            raw = bytes(o.uc.mem_read(obj, 64))
            self.assertEqual((raw[11], struct.unpack_from("<H", raw, 8)[0]),
                             (expected["channel"], expected["sequence"]))
            length = struct.unpack_from("<H", raw, 58)[0]
            self.assertEqual(bytes(o.uc.mem_read(o.qword(obj + 48), length)), expected["payload"])
            o.uc.mem_write(previous, raw)

if __name__ == "__main__":
    unittest.main()
