"""Offline reference for the 16.23 spectator scoreboard on macOS x86-64."""
import argparse
import json
import struct
from pathlib import Path

from inspect_keyframes import parse_blocks
from ff_oracle_16_20 import MachO as PinnedMachO
from inspect_macos_16_20 import MacOracle


class MachO(PinnedMachO):
    expected_version = "16.23.8396405"
    expected_sha256 = "8ee34ee5848104beb3be0d92344b2f8c6a1953aa853229e889e796c875f88639"


class ScoreboardOracle(MacOracle):
    factory = 0x10100f2d0
    parameter_table = 0x102156e30
    allocators = (0x1014a0330, 0x1014a2060, 0x1014c5b50)
    aligned_allocator = None
    no_op = (0x1014c5bb0, 0x102050b2a)
    bzero = 0x102050b1e
    guard_acquire = 0x102050b48
    guard_release = 0x102050b4e

    def __init__(self, binary):
        super().__init__(binary)
        # The generated spawn reader checks the initialized enum registry.
        registry = self.DATA + 0x3000
        self.uc.mem_write(0x1024e8590, struct.pack("<Q", registry))
        self.uc.mem_write(registry + 0x70, b"\x01")

    def spawn(self, obj):
        # Invert the four byte stores at the end of the +0x54 NetID reader.
        def net_id_byte(value):
            value ^= 255
            value = ((value << 2) | (value >> 6)) & 255
            return (((value ^ 14) + 6) & 255) ^ 0x75
        entity = bytes(net_id_byte(v) for v in self.uc.mem_read(obj + 0x54, 4))
        return int.from_bytes(entity, "little"), self.vector(obj + 0x40).decode("ascii")


def inspect_frame(oracle, file):
    vectors, champions, turrets = {}, {}, {}
    for block in parse_blocks(file.read_bytes(), secondary_timestamp=True):
        if block.packet_id == 313:
            vector = oracle.vector(oracle.decode(block) + 0x10)
            assert len(vector) == 1260 and block.param not in vectors
            vectors[block.param] = vector.hex()
        elif block.packet_id == 88:
            entity, model = oracle.spawn(oracle.decode(block))
            assert entity not in champions
            champions[entity] = model
        elif block.packet_id == 921:
            obj = oracle.decode(block)
            name = oracle.vector(obj + 0x18).decode("ascii")
            state = oracle.uc.mem_read(obj + 0x2d, 1)[0]
            assert state in (0xe8, 0xec) and block.param not in turrets
            turrets[block.param] = {"name": name, "destroyed": state == 0xe8}
    assert len(vectors) == 10 and vectors.keys() == champions.keys()
    return {"build": oracle.binary.expected_version, "file": str(file), "vectors": vectors, "champions": champions, "turrets": turrets}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("captures", type=Path)
    args = parser.parse_args()
    oracle = ScoreboardOracle(MachO(args.binary))
    files = sorted(args.captures.glob("*/keyframe-*.bin"))
    if not files:
        parser.error("No keyframes found")
    print(json.dumps([inspect_frame(oracle, file) for file in files]))
