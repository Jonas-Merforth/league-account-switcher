"""Offline 16.19 oracle for the official macOS x86-64 executable.

No game process is started or inspected. Only packet factory/deserializer
routines execute in Unicorn, with bounded memory, instruction count, and
allocator/C-runtime shims. The SHA gate intentionally rejects other builds.
Usage: python research/inspect_macos_16_19.py BINARY PRIVATE_CAPTURE_ROOT
Emits private JSON for verify_patch_16_19.mjs, never account identifiers.
"""

import argparse
import hashlib
import json
import struct
from pathlib import Path

from unicorn import Uc, UC_ARCH_X86, UC_MODE_64, UC_HOOK_CODE
from unicorn.x86_const import (
    UC_X86_REG_RDI, UC_X86_REG_RSI, UC_X86_REG_RDX, UC_X86_REG_RCX,
    UC_X86_REG_R8, UC_X86_REG_R9, UC_X86_REG_RSP, UC_X86_REG_RAX,
    UC_X86_REG_RIP,
)
from inspect_keyframes import parse_blocks, infer_player_base


BUILD_SHA256 = "ea05eba548fcc408e66d142f4e408d172c686636991786d309334bf2e31c9b53"
TURRET_IDS = (0x88, 0x8b, 0x8c, 0x8d, 0x8e, 0x92, 0x93, 0x94,
              0x96, 0x97, 0x98, 0x9a, 0x9b, 0xa0, 0xa1, 0xa2,
              0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xab)


class MachO:
    def __init__(self, path):
        fat = Path(path).read_bytes()
        if hashlib.sha256(fat).hexdigest() != BUILD_SHA256:
            raise ValueError("Expected the verified official 16.19.8217343 macOS build")
        if fat[:4] != bytes.fromhex("cafebabe"):
            raise ValueError("Expected a universal Mach-O executable")
        for index in range(struct.unpack_from(">I", fat, 4)[0]):
            cpu, _, offset, size, _ = struct.unpack_from(">5I", fat, 8 + 20 * index)
            if cpu == 0x1000007:
                self.raw = fat[offset:offset + size]
                break
        else:
            raise ValueError("No x86-64 slice")
        self.segments = []
        cursor = 32
        for _ in range(struct.unpack_from("<I", self.raw, 16)[0]):
            command, length = struct.unpack_from("<II", self.raw, cursor)
            if command == 0x19:
                name, va, size, offset, file_size = struct.unpack_from(
                    "<16sQQQQ", self.raw, cursor + 8)
                self.segments.append((name.rstrip(b"\0"), va, size, offset, file_size))
            cursor += length

    def get(self, address, size):
        for _, va, _, offset, file_size in self.segments:
            if va <= address and address + size <= va + file_size:
                return self.raw[offset + address - va:offset + address - va + size]
        raise ValueError(f"Unmapped binary address {address:#x}")


class MacOracle:
    DATA = 0x30000000
    STACK = 0x20000000
    STOP = 0x50000000

    def __init__(self, binary):
        self.binary = binary
        self.uc = Uc(UC_ARCH_X86, UC_MODE_64)
        for name, va, size, offset, file_size in binary.segments:
            if name == b"__PAGEZERO" or not size:
                continue
            self.uc.mem_map(va, (size + 4095) & ~4095)
            if file_size:
                self.uc.mem_write(va, binary.raw[offset:offset + file_size])
        for va, size in ((self.DATA, 0x400000), (self.STACK, 0x20000), (self.STOP, 0x1000)):
            self.uc.mem_map(va, size)
        self.uc.hook_add(UC_HOOK_CODE, self._hook)
        self.heap = self.DATA + 0x10000
        self.allocations = []

    def _return(self, value=0):
        sp = self.uc.reg_read(UC_X86_REG_RSP)
        target = self.qword(sp)
        self.uc.reg_write(UC_X86_REG_RSP, sp + 8)
        self.uc.reg_write(UC_X86_REG_RAX, value)
        self.uc.reg_write(UC_X86_REG_RIP, target)

    def _hook(self, uc, address, _size, _user):
        if address in (0x1017f4a60, 0x1017f48f0, 0x1017f4990, 0x1017f4ac0):
            size = uc.reg_read(UC_X86_REG_RDI)
            alignment = max(16, uc.reg_read(UC_X86_REG_RSI)) if address == 0x1017f4990 else 16
            if alignment > 4096 or alignment & (alignment - 1):
                raise ValueError("Unexpected allocator alignment")
            pointer = (self.heap + alignment - 1) & ~(alignment - 1)
            self.heap = (pointer + max(size, 1) + 15) & ~15
            if self.heap >= self.DATA + 0x3e0000:
                raise ValueError("Oracle heap limit exceeded")
            uc.mem_write(pointer, bytes(max(size, 1)))
            self.allocations.append((pointer, size))
            self._return(pointer)
        elif address in (0x1017f4950, 0x102323378):  # free / cxa_atexit
            self._return()
        elif address == 0x10232336c:  # bzero
            uc.mem_write(uc.reg_read(UC_X86_REG_RDI), bytes(uc.reg_read(UC_X86_REG_RSI)))
            self._return()
        elif address == 0x102323396:  # cxa_guard_acquire
            self._return(1)
        elif address == 0x10232339c:  # cxa_guard_release
            uc.mem_write(uc.reg_read(UC_X86_REG_RDI), b"\1")
            self._return()

    def qword(self, address):
        return struct.unpack("<Q", self.uc.mem_read(address, 8))[0]

    def call(self, address, *args):
        sp = self.STACK + 0x1f000 - 8
        self.uc.mem_write(sp, struct.pack("<Q", self.STOP))
        self.uc.reg_write(UC_X86_REG_RSP, sp)
        for register, arg in zip((UC_X86_REG_RDI, UC_X86_REG_RSI, UC_X86_REG_RDX,
                                  UC_X86_REG_RCX, UC_X86_REG_R8, UC_X86_REG_R9), args):
            self.uc.reg_write(register, arg)
        self.uc.emu_start(address, self.STOP, count=4_000_000)
        if self.uc.reg_read(UC_X86_REG_RIP) != self.STOP:
            raise ValueError("Oracle instruction limit exceeded")
        return self.uc.reg_read(UC_X86_REG_RAX)

    def prefix(self, param):
        table = self.binary.get(0x10244c6e0, 256)
        def transform(value):
            value = (table[value ^ 255] + 0x54) & 255
            value = ((value << 1) | (value >> 7)) & 255
            return table[(table[value] - 0x4c) & 255]
        inverse = {transform(value): value for value in range(256)}
        value = param if param & 0xffffff == 0 else param ^ 0x40000000
        output = []
        while True:
            byte = value & 127
            value >>= 7
            output.append(inverse[byte | (128 if value else 0)])
            if not value:
                return bytes(output)

    def decode(self, block):
        # These packet routines retain only scalar defaults in global statics.
        # Reset packet-local heap; zero each allocation when reused.
        self.heap = self.DATA + 0x10000
        self.allocations = []
        self.call(0x10132ab60, self.DATA + 0x1000, block.packet_id)
        obj = self.qword(self.DATA + 0x1000)
        deserialize = self.qword(self.qword(obj) + 8)
        data = self.prefix(block.param) + block.payload
        source, cursor = self.DATA + 0x9000, self.DATA + 0x8000
        if len(data) >= 0x7000:
            raise ValueError("Packet too large for the research input buffer")
        self.uc.mem_write(source, data)
        self.uc.mem_write(cursor, struct.pack("<Q", source))
        result = self.call(deserialize, obj, cursor, source + len(data))
        if not result & 255 or self.qword(cursor) != source + len(data):
            raise ValueError(f"Packet {block.packet_id} did not consume its complete input")
        return obj

    def vector(self, address):
        pointer, length = struct.unpack("<QI", self.uc.mem_read(address, 12))
        return bytes(self.uc.mem_read(pointer, length)) if length else b""


def inspect_frame(oracle, path):
    blocks = parse_blocks(path.read_bytes())
    base = infer_player_base(blocks)
    heroes, roster, turrets = [], None, []
    for block in blocks:
        if block.packet_id == 137 and base <= block.param < base + 10:
            obj = oracle.decode(block)
            vector = oracle.vector(obj + 0x18)
            assert len(vector) == 1260
            heroes.append({"param": block.param, "vector": vector.hex()})
        elif block.packet_id == 453:
            obj = oracle.decode(block)
            pointer, count = struct.unpack("<QI", oracle.uc.mem_read(obj + 0x20, 12))
            assert count == 11  # Ten participants plus an empty world record.
            roster = [oracle.vector(pointer + slot * 328 + 0x10).decode("ascii")
                      for slot in range(10)]
            assert not oracle.vector(pointer + 10 * 328 + 0x10)
        elif block.packet_id == 1099 and block.param - 0x40000000 in TURRET_IDS:
            obj = oracle.decode(block)
            name = oracle.vector(obj + 0x18).decode("ascii")
            # Object +0x4d: standing = 0x11, destroyed = 3. Preserve the
            # independent name-derived owner, not the production ID mapping.
            state = oracle.uc.mem_read(obj + 0x4d, 1)[0]
            assert state in (3, 0x11)
            assert name.startswith(("Turret_TOrder_", "Turret_TChaos_"))
            turrets.append({"param": block.param, "destroyed": state == 3,
                            "owner": 100 if name.startswith("Turret_TOrder_") else 200})
        elif block.packet_id == 855 and base <= block.param < base + 10:
            obj = oracle.decode(block)
            assert struct.unpack("<I", oracle.uc.mem_read(obj + 0x20, 4))[0] == 10
            assert any(size == 1680 for _, size in oracle.allocations)
    assert len(heroes) == 10 and roster is not None
    return {"file": str(path), "playerBase": base, "heroes": heroes,
            "roster": roster, "turrets": turrets}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("captures", type=Path)
    args = parser.parse_args()
    oracle = MacOracle(MachO(args.binary))
    files = sorted(args.captures.glob("*/keyframe-*.bin"))
    if not files:
        parser.error("No keyframes in the capture root")
    print(json.dumps([inspect_frame(oracle, path) for path in files]))
