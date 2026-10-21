"""Build-pinned offline execution of League 16.20 macOS packet routines.

This module maps a local executable into Unicorn. It neither starts League nor
reads a live process. No executable or session secrets are bundled here.
"""

import hashlib
import struct
from pathlib import Path

from unicorn import Uc, UC_ARCH_X86, UC_MODE_64, UC_HOOK_CODE
from unicorn.x86_const import (
    UC_X86_REG_RDI, UC_X86_REG_RSI, UC_X86_REG_RDX, UC_X86_REG_RCX,
    UC_X86_REG_R8, UC_X86_REG_R9, UC_X86_REG_RSP, UC_X86_REG_RAX,
    UC_X86_REG_RIP, UC_X86_REG_RBP, UC_X86_REG_R13, UC_X86_REG_RBX,
)



BUILD_SHA256 = "f0ff0944c204e51cce8df8493f8d769c82e0b0f70bae63fe90e074c30a973671"


class MachO:
    def __init__(self, path):
        fat = Path(path).read_bytes()
        if hashlib.sha256(fat).hexdigest() != BUILD_SHA256:
            raise ValueError("Expected the verified official 16.20.8248524 macOS build")
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
        if address in (0x1016fc1a0, 0x1016fc0c0, 0x1016fc110, 0x1016fc1d0):
            size = uc.reg_read(UC_X86_REG_RDI)
            alignment = max(16, uc.reg_read(UC_X86_REG_RSI)) if address == 0x1016fc110 else 16
            if alignment > 4096 or alignment & (alignment - 1):
                raise ValueError("Unexpected allocator alignment")
            pointer = (self.heap + alignment - 1) & ~(alignment - 1)
            self.heap = (pointer + max(size, 1) + 15) & ~15
            if self.heap >= self.DATA + 0x3e0000:
                raise ValueError("Oracle heap limit exceeded")
            uc.mem_write(pointer, bytes(max(size, 1)))
            self.allocations.append((pointer, size))
            self._return(pointer)
        elif address in (0x1016fc0f0, 0x1022326fc):  # free / cxa_atexit
            self._return()
        elif address == 0x1022326f0:  # bzero
            uc.mem_write(uc.reg_read(UC_X86_REG_RDI), bytes(uc.reg_read(UC_X86_REG_RSI)))
            self._return()
        elif address == 0x10223271a:  # cxa_guard_acquire
            self._return(1)
        elif address == 0x102232720:  # cxa_guard_release
            uc.mem_write(uc.reg_read(UC_X86_REG_RDI), b"\1")
            self._return()
        elif address == 0x102232b4c:  # memcpy, used by the cipher validation
            dst, src, size = (uc.reg_read(r) for r in
                              (UC_X86_REG_RDI, UC_X86_REG_RSI, UC_X86_REG_RDX))
            if size > 0x10000:
                raise ValueError("Oracle copy limit exceeded")
            uc.mem_write(dst, bytes(uc.mem_read(src, size)))
            self._return(dst)

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

    def segment(self, start, end, registers):
        """Execute a verified straight-line part of the real message consumer."""
        for register, value in registers.items():
            self.uc.reg_write(register, value)
        self.uc.emu_start(start, end, count=2000)
        if self.uc.reg_read(UC_X86_REG_RIP) != end:
            raise ValueError("Consumer did not reach the verified boundary")

    def deserialize(self, packet_id, data):
        expected = {738: 0x1013d1b10, 662: 0x1013d28f0,
                    668: 0x101584470, 673: 0x1013cf000}
        if packet_id not in expected or not 0 < len(data) < 0x7000:
            raise ValueError("Unsupported packet input")
        self.heap = self.DATA + 0x10000
        self.allocations = []
        self.uc.mem_write(self.DATA + 0x1000, bytes(8))
        self.call(0x101237830, self.DATA + 0x1000, packet_id)
        obj = self.qword(self.DATA + 0x1000)
        if not self.DATA + 0x10000 <= obj < self.heap:
            raise ValueError("Packet factory did not allocate an object")
        deserialize = self.qword(self.qword(obj) + 8)
        if deserialize != expected[packet_id]:
            raise ValueError("Unexpected packet deserializer")
        source, cursor = self.DATA + 0x9000, self.DATA + 0x8000
        # Clear neighboring input bytes so short inputs cannot inherit old data.
        self.uc.mem_write(source, bytes(0x7000))
        self.uc.mem_write(source, data)
        self.uc.mem_write(cursor, struct.pack("<Q", source))
        result = self.call(deserialize, obj, cursor, source + len(data))
        if not result & 255 or self.qword(cursor) != source + len(data):
            raise ValueError("Deserializer rejected input or left trailing bytes")
        return obj

    def surrender(self, packet_id, data):
        obj = self.deserialize(packet_id, data)
        if packet_id == 738:
            bp = self.STACK + 0x10000
            self.segment(0x1006df681, 0x1006df79b,
                         {UC_X86_REG_RBP: bp, UC_X86_REG_R13: obj})
            yes, no, team = struct.unpack("<IIH", self.uc.mem_read(bp - 0x338, 10))
            actor = struct.unpack("<I", self.uc.mem_read(bp - 0x33c, 4))[0]
            self.segment(0x1006df8f4, 0x1006df927,
                         {UC_X86_REG_RCX: obj, UC_X86_REG_RBX: 0x102339ce0})
            update_flag = bytes(self.uc.mem_read(obj + 32, 1))[0]
            if update_flag not in (1, 0x7e):
                raise ValueError("Unverified vote start/update flag")
            is_update = update_flag == 1
            return {"stage": "vote-update" if is_update else "vote-start",
                    "yes": yes, "no": no, "teamId": team,
                    "actorNetId": actor,
                    "voteYes": bool(self.uc.reg_read(UC_X86_REG_RDX)),
                    "validation": "exact-deserializer-and-client-consumer"}
        if packet_id == 662:
            reason = struct.unpack("<I", self.uc.mem_read(obj + 28, 4))[0]
            if reason >= 17:
                raise ValueError("Unknown surrender announcement reason")
            event = self.call(0x1006b9a80, reason)
            out = self.DATA + 0x2000
            self.segment(0x1006b9aa0, 0x1006b9b7e,
                         {UC_X86_REG_RDI: out, UC_X86_REG_RSI: obj,
                          UC_X86_REG_RSP: self.STACK + 0x1f000})
            yes, no, team = struct.unpack("<IIH", self.uc.mem_read(out + 8, 10))
            return {"stage": {135: "vote-failed", 137: "surrender-accepted"}.get(
                        event, "other-surrender-announcement"),
                    "announcementId": event, "reason": reason,
                    "yes": yes, "no": no, "teamId": team,
                    "validation": "exact-deserializer-and-client-consumer"}
        if packet_id == 668:
            value = bytes(self.uc.mem_read(obj + 16, 1))[0]
            if value not in (0x1d, 0xcb):
                raise ValueError("Unverified eligibility boolean")
            return {"stage": "eligibility-candidate", "value": value == 0x1d,
                    "validation": "exact-deserializer-meaning-provisional"}
        # The current capture's 673 input fails exact deserialization. Never
        # silently promote its type/arrival-time correlation to a decoded end.
        return {"stage": "game-end-type-candidate",
                "validation": "exact-deserializer-type-meaning-only"}

