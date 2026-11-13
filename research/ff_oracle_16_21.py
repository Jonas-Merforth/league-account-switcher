"""Offline oracle for the SHA-pinned official 16.21.8298620 macOS build.

Vote and announcement layouts were traced from the command sender, packet
factory and client consumers. Live-match compatibility still needs a capture.
"""

import struct
from unicorn.x86_const import (UC_X86_REG_RDI, UC_X86_REG_RSI, UC_X86_REG_RSP,
                              UC_X86_REG_RBP, UC_X86_REG_R12, UC_X86_REG_RCX,
                              UC_X86_REG_RBX, UC_X86_REG_RDX)
from ff_oracle_16_20 import MachO as BaseMachO, MacOracle as BaseOracle

BUILD_SHA256 = "0414ccc2ddfd3ba209c75d9c8f6ee6611ff1de11426afdf54007df12df219fab"


class MachO(BaseMachO):
    expected_sha256 = BUILD_SHA256
    expected_version = "16.21.8298620"


class MacOracle(BaseOracle):
    version = "16.21.8298620"
    checksum_table = 0x1020d4830
    packet_roles = {65: "vote", 938: "announcement", 1254: "request"}
    factory = 0x100fecbb0
    deserializers = {65: 0x101182830, 938: 0x101183820}

    def _hook(self, uc, address, size, user):
        if address in (0x101474a30, 0x10149a2f0):
            length = uc.reg_read(UC_X86_REG_RDI)
            if length > 0x10000 or self.heap + length >= self.DATA + 0x3e0000:
                raise ValueError("Oracle allocation limit")
            pointer = self.heap
            self.heap = (pointer + max(length, 1) + 15) & ~15
            uc.mem_write(pointer, bytes(max(length, 1)))
            self.allocations.append((pointer, length))
            self._return(pointer)
        elif address in (0x10149a350, 0x101474970):
            self._return()
        elif address == 0x101fee5fa:
            dst, length = (uc.reg_read(r) for r in (UC_X86_REG_RDI, UC_X86_REG_RSI))
            if length > 0x10000:
                raise ValueError("Oracle zero limit")
            uc.mem_write(dst, bytes(length))
            self._return()
        elif address == 0x101feea44:  # memcpy used by cipher/serializer
            dst, src, length = (uc.reg_read(r) for r in (UC_X86_REG_RDI, UC_X86_REG_RSI, UC_X86_REG_RDX))
            if length > 0x10000:
                raise ValueError("Oracle copy limit")
            uc.mem_write(dst, bytes(uc.mem_read(src, length)))
            self._return(dst)

    def construct(self, packet_id):
        if packet_id not in self.deserializers:
            raise ValueError("Unsupported 16.21 packet")
        self.heap = self.DATA + 0x10000
        self.allocations = []
        self.uc.mem_write(self.DATA + 0x1000, bytes(8))
        self.call(self.factory, self.DATA + 0x1000, packet_id)
        obj = self.qword(self.DATA + 0x1000)
        if not self.DATA + 0x10000 <= obj < self.heap:
            raise ValueError("Invalid factory object")
        if self.qword(self.qword(obj) + 8) != self.deserializers[packet_id]:
            raise ValueError("Unexpected 16.21 deserializer")
        return obj

    def prefix(self, net_id):
        table = self.binary.get(0x1020ebf80, 256)
        def rol(value, n):
            return ((value << n) | (value >> (8 - n))) & 255
        inverse = {table[(table[rol((table[c ^ 255] + 0x54) & 255, 1)] + 0xb4) & 255]: c
                   for c in range(256)}
        value = net_id if net_id & 0xffffff == 0 else net_id ^ 0x40000000
        result = []
        while True:
            byte = value & 127
            value >>= 7
            result.append(inverse[byte | (128 if value else 0)])
            if not value:
                return bytes(result)

    def deserialize(self, packet_id, data):
        if not 0 < len(data) < 0x7000:
            raise ValueError("Unsupported packet input")
        obj = self.construct(packet_id)
        source, cursor = self.DATA + 0x9000, self.DATA + 0x8000
        self.uc.mem_write(source, bytes(0x7000))
        self.uc.mem_write(source, data)
        self.uc.mem_write(cursor, struct.pack("<Q", source))
        result = self.call(self.deserializers[packet_id], obj, cursor, source + len(data))
        if not result & 255 or self.qword(cursor) != source + len(data):
            raise ValueError("Deserializer rejected input or left trailing bytes")
        return obj

    def surrender(self, packet_id, data):
        obj = self.deserialize(packet_id, data)
        return self.fields(packet_id, obj)

    def fields(self, packet_id, obj):
        bp = self.STACK + 0x10000
        if packet_id == 65:
            self.segment(0x1006d8bd8, 0x1006d8d15,
                         {UC_X86_REG_RBP: bp, UC_X86_REG_R12: obj})
            yes, no, team = struct.unpack("<IIH", self.uc.mem_read(bp - 0x1c8, 10))
            actor = struct.unpack("<I", self.uc.mem_read(bp - 0x1cc, 4))[0]
            self.segment(0x1006d8f01, 0x1006d8f2b,
                         {UC_X86_REG_RCX: obj, UC_X86_REG_RBX: 0x1020d6660})
            flag = bytes(self.uc.mem_read(obj + 20, 1))[0]
            if flag not in (0xaa, 0xd5):
                raise ValueError("Unknown vote update flag")
            return {"stage": "vote-update" if flag == 0xaa else "vote-start",
                    "yes": yes, "no": no, "teamId": team, "actorNetId": actor,
                    "voteYes": bool(self.uc.reg_read(UC_X86_REG_RDX)),
                    "validation": "exact-deserializer-and-client-consumer"}
        if packet_id != 938:
            raise ValueError("Unknown semantic packet")
        reason = struct.unpack("<I", self.uc.mem_read(obj + 40, 4))[0]
        if reason >= 17:
            raise ValueError("Unknown surrender announcement reason")
        event = self.call(0x1006b7c80, reason)
        out = self.DATA + 0x2000
        self.segment(0x1006b7ca0, 0x1006b7d52,
                     {UC_X86_REG_RDI: out, UC_X86_REG_RSI: obj,
                      UC_X86_REG_RSP: self.STACK + 0x1f000})
        yes, no, team = struct.unpack("<IIH", self.uc.mem_read(out + 8, 10))
        return {"stage": {135: "vote-failed", 137: "surrender-accepted"}.get(event, "other-surrender-announcement"),
                "yes": yes, "no": no, "teamId": team, "reason": reason,
                "announcementId": event, "validation": "exact-deserializer-and-client-consumer"}
