"""Derive the live team damage packet readers from the pinned 16.23 macOS build.

Offline only. The packet factory and deserializers of the official macOS
executable run in Unicorn over packet bodies dumped from a saved recording
with research/dumpLivePackets.mjs. No game process is started or inspected.

Two packets feed the live estimate:

- the combat marker (503 on 16.23): owner, selector byte, four time bytes;
- unit replication (309 on 16.23): tick time, a byte vector, two trailers.

Memory hooks record which input bytes the deserializer reads and what it
writes, which gives the byte tables, the byte order and the field order
without reading disassembly. Synthetic flag bytes then show which selector
values make each field present.

Usage:
  python research/team_live_tables_16_23.py BINARY PAYLOADS.json [--marker 503] [--replication 309]

Paste the printed tables and selector sets into the build's field reader in
src/core, then run `node research/teamLiveEstimate.mjs` on a recording.
"""
import argparse
import collections
import json
import struct
from pathlib import Path

from unicorn import UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE

from inspect_macos_16_23 import MachO, ScoreboardOracle


class Oracle(ScoreboardOracle):
    """Adds raw playing-client decoding and read/write tracing."""

    def __init__(self, binary):
        super().__init__(binary)
        self.source = self.DATA + 0x9000
        self.length = 0
        self.reads = []
        self.writes = []
        self.watch = None
        self.uc.hook_add(UC_HOOK_MEM_READ, self._on_read)
        self.uc.hook_add(UC_HOOK_MEM_WRITE, self._on_write)

    def _on_read(self, uc, access, address, size, value, user):
        if self.source <= address < self.source + self.length:
            self.reads.append(address - self.source)

    def _on_write(self, uc, access, address, size, value, user):
        if self.watch and self.watch[0] <= address < self.watch[0] + self.watch[1]:
            self.writes.append((address - self.watch[0], size, value & ((1 << (8 * size)) - 1), len(self.reads)))

    def run(self, packet_id, data, watch=None):
        """Deserialize a packet body (owner varint included). `watch` picks the
        memory range to trace: "object" or the index of a heap allocation."""
        def once():
            self.heap = self.DATA + 0x10000
            self.allocations = []
            self.call(self.factory, self.DATA + 0x1000, packet_id)
            obj = self.qword(self.DATA + 0x1000)
            cursor = self.DATA + 0x8000
            self.uc.mem_write(self.source, data)
            self.uc.mem_write(cursor, struct.pack("<Q", self.source))
            self.reads, self.writes, self.length = [], [], len(data)
            result = self.call(self.qword(self.qword(obj) + 8), obj, cursor, self.source + len(data))
            return obj, bool(result & 255) and self.qword(cursor) == self.source + len(data)

        self.watch = None
        obj, ok = once()
        if watch is None:
            return obj, ok
        # The bump allocator is deterministic, so a second run can watch the range.
        allocations = list(self.allocations)
        if watch == "object":
            self.watch = (obj + 0x10, allocations[0][1] - 0x10)
        elif watch < len(allocations):
            self.watch = allocations[watch]
        obj, ok = once()
        self.watch = None
        return obj, ok


def permutation(table):
    if any(value is None for value in table) or len(set(table)) != 256:
        return "INCOMPLETE: " + str(sum(value is None for value in table)) + " values unseen"
    return bytes(table).hex()


def accumulated(oracle, count):
    """A float field is decoded one byte per input byte into a 4-byte
    accumulator before it is stored. Returns the decoded bytes in read order."""
    wide = [write for write in oracle.writes if write[1] == 4 and write[3] >= 2]
    if not wide:
        return None
    steps = [write for write in wide if write[0] == wide[0][0]]
    return struct.pack(">I", steps[count][2]) if len(steps) > count else None


def marker(oracle, packet_id, rows):
    table = [None] * 256
    conflicts = 0
    selectors = collections.Counter()
    orders = collections.Counter()
    for _, text in rows:
        data = bytes.fromhex(text)
        obj, ok = oracle.run(packet_id, data, "object")
        body = [offset for offset in oracle.reads if offset >= 2][:4]
        decoded = accumulated(oracle, 4)
        if not ok or len(body) != 4 or decoded is None:
            conflicts += 1
            continue
        for index, offset in enumerate(body):
            if table[data[offset]] not in (None, decoded[index]):
                conflicts += 1
            table[data[offset]] = decoded[index]
        for name, value in (("little-endian", struct.unpack("<f", decoded)[0]), ("big-endian", struct.unpack(">f", decoded)[0])):
            if 1 <= value <= 20000:
                orders[name] += 1
        selectors[(data[1] & 7, data[1] >> 3 & 7, data[1] >> 6)] += 1
    print(f"\n## Combat marker {packet_id}: {len(rows)} packets, conflicts {conflicts}")
    print("time bytes follow the selector byte; packets that read as a plausible game time per byte order:", dict(orders))
    print("selector byte (bits 0-2, bits 3-5, bits 6-7) counts:", selectors.most_common(12))
    print("Two values of one 3-bit selector occur. The more common one in an ARAM is the champion hit;")
    print("confirm with a paired replay. The other selector's values are the ones that send the time.")
    print("time table:", permutation(table))


def replication(oracle, packet_id, rows):
    vector, time = [None] * 256, [None] * 256
    conflicts = 0
    orders, trailers, steps = collections.Counter(), collections.Counter(), collections.Counter()
    previous = None
    for _, text in rows:
        data = bytes.fromhex(text)
        obj, ok = oracle.run(packet_id, data, "object")
        if not ok:
            conflicts += 1
            continue
        flag_end = 3
        decoded = accumulated(oracle, 4)
        body = [offset for offset in oracle.reads if offset >= flag_end][:4]
        if decoded is not None and body == list(range(body[0], body[0] + 4)):
            for index, offset in enumerate(body):
                if time[data[offset]] not in (None, decoded[index]):
                    conflicts += 1
                time[data[offset]] = decoded[index]
            little, big = struct.unpack("<f", decoded)[0], struct.unpack(">f", decoded)[0]
            # The tick clock rises by about 0.1 s per packet in the right byte order.
            value = little if previous is None and 1 <= little <= 20000 or previous is not None and abs(little - previous) < 5 else big
            orders["time little-endian" if value == little else "time big-endian"] += 1
            if previous is not None:
                steps[round(value - previous, 1)] += 1
            previous = value
        if len(oracle.allocations) < 2:
            continue
        oracle.run(packet_id, data, 1)
        size = oracle.allocations[1][1]
        inputs = []
        for offset, width, value, reads in oracle.writes:
            source = oracle.reads[reads - 1]
            inputs.append(source)
            if vector[data[source]] not in (None, value):
                conflicts += 1
            vector[data[source]] = value
        if inputs:
            first = [offset for offset, _, _, _ in oracle.writes[:4]]
            orders["vector front/back" if first[:2] == [0, size - 1] else "vector " + str(first)] += 1
            trailers[(min(inputs), len(data) - max(inputs) - 1)] += 1
    print(f"\n## Replication {packet_id}: {len(rows)} packets, conflicts {conflicts}")
    print("orders:", dict(orders))
    print("tick time steps (s):", steps.most_common(4))
    print("(vector start offset, bytes after the vector):", trailers.most_common(6))
    print("vector table:", permutation(vector))
    print("time table:", permutation(time))
    selectors(oracle, packet_id, vector)


def selectors(oracle, packet_id, vector):
    """Probe every first flag byte with the low bits of the second: which
    values make the reader consume each field?"""
    small = next((raw for raw, value in enumerate(vector) if value == 4), None)
    if small is None:
        print("selectors: vector table incomplete")
        return
    shapes = {}
    for first in range(256):
        for second in range(4):
            data = bytes([0xa6, first, second]) + bytes([small]) * 40
            try:
                oracle.run(packet_id, data)
            except Exception:  # research output only
                continue
            groups, current = [], 0
            for offset in oracle.reads[1:]:
                if offset in (1, 2):
                    groups.append(current)
                    current = 0
                else:
                    current += 1
            groups.append(current)
            shapes[(first, second)] = tuple(groups)
    print("selector probe, body bytes read after each flag read:", collections.Counter(shapes.values()).most_common(8))
    print("Fit each field to one flag bit or one 3-bit window (first | second << 8) with these shapes;")
    print("on 16.23: time = bit 3, vector = bit 0 clear, byte = bits 7-9 in {1,2,4,7}, counter = bits 4-6 in {0,4,5,6}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("binary", type=Path)
    parser.add_argument("payloads", type=Path)
    parser.add_argument("--marker", type=int, default=503)
    parser.add_argument("--replication", type=int, default=309)
    parser.add_argument("--limit", type=int, default=12000)
    args = parser.parse_args()
    packets = json.loads(args.payloads.read_text())["payloads"]
    oracle = Oracle(MachO(args.binary))
    marker(oracle, args.marker, packets.get(f"in:{args.marker}", [])[:args.limit])
    replication(oracle, args.replication, packets.get(f"in:{args.replication}", [])[:args.limit])
