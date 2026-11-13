"""SHA-pinned, offline 16.22 transport oracle for damage research.

This executes bounded routines from a local official macOS artifact in Unicorn.
It does not inspect a running game. Transport validation does not establish
damage semantics or playing-client delivery; those require a matching capture.
"""
import math
import re
import struct

from unicorn.x86_const import UC_X86_REG_RDI, UC_X86_REG_RSI, UC_X86_REG_RDX
from unicorn.x86_const import UC_X86_REG_R12, UC_X86_REG_R13, UC_X86_REG_RBX, UC_X86_REG_RSP, UC_X86_REG_RCX, UC_X86_REG_R8, UC_X86_REG_R9
from unicorn.x86_const import UC_X86_REG_R14, UC_X86_REG_RBP
from ff_oracle_16_20 import MachO as BaseMachO, MacOracle as BaseOracle

BUILD_SHA256 = "368dcf59f0409deb35fce0743bcc2c10fa9d2ea5d040445332c705de8f00f5b5"


class MachO(BaseMachO):
    expected_sha256 = BUILD_SHA256
    expected_version = "16.22.8348910"


class MacOracle(BaseOracle):
    version = "16.22.8348910"
    checksum_table = 0x102113160
    checksum_function = 0x1005fd550
    cipher_setup = 0x1014d1c50
    cipher_encrypt = 0x1014d26d0
    cipher_decrypt = 0x1014d28a0
    stack_guard_pointer = 0x1024ae678
    message_reader = 0x1005fcbc0
    factory = 0x100ff4aa0
    packet_roles = {}  # No damage type has been validated yet.

    def _hook(self, uc, address, _size, _user):
        if address in (0x101488da0, 0x10148aad0, 0x1014ae420):
            size = uc.reg_read(UC_X86_REG_RDI)
            if size > 0x10000 or self.heap + max(size, 1) >= self.DATA + 0x3e0000:
                raise ValueError("Oracle allocation limit")
            pointer = self.heap
            self.heap = (pointer + max(size, 1) + 15) & ~15
            uc.mem_write(pointer, bytes(max(size, 1)))
            self.allocations.append((pointer, size))
            self._return(pointer)
        elif address in (0x101488ce0, 0x1014ae480, 0x10202736a):
            self._return()
        elif address == 0x10202735e:
            dst, size = (uc.reg_read(r) for r in (UC_X86_REG_RDI, UC_X86_REG_RSI))
            if size > 0x10000:
                raise ValueError("Oracle zero limit")
            uc.mem_write(dst, bytes(size))
            self._return(dst)
        elif address == 0x1020277a8:
            dst, src, size = (uc.reg_read(r) for r in
                              (UC_X86_REG_RDI, UC_X86_REG_RSI, UC_X86_REG_RDX))
            if size > 0x10000:
                raise ValueError("Oracle copy limit")
            uc.mem_write(dst, bytes(uc.mem_read(src, size)))
            self._return(dst)
        elif address == 0x102027388:
            self._return(1)
        elif address == 0x10202738e:
            uc.mem_write(uc.reg_read(UC_X86_REG_RDI), b"\1")
            self._return()

    def construct_for_research(self, packet_id):
        """Return an unlabelled object; construction is not semantic validation."""
        if not isinstance(packet_id, int) or not 0 <= packet_id <= 0x4f8:
            raise ValueError("Invalid packet type")
        self.heap = self.DATA + 0x10000
        self.allocations = []
        self.uc.mem_write(self.DATA + 0x1000, bytes(8))
        self.call(self.factory, self.DATA + 0x1000, packet_id)
        obj = self.qword(self.DATA + 0x1000)
        if not self.DATA + 0x10000 <= obj < self.heap:
            raise ValueError("Factory rejected packet type")
        if struct.unpack("<H", self.uc.mem_read(obj + 8, 2))[0] != packet_id:
            raise ValueError("Factory type mismatch")
        return obj

    def surrender(self, *_args):
        raise ValueError("16.22 semantic decoding is not enabled")

    def candidate_damage(self, data):
        """Research-only packet 393 fields, not a validated damage measurement.

        Executes its exact deserializer and bounded straight-line consumer
        segments. Enum meanings, shield accounting and playing-client coverage
        still need a controlled game. Never feed these directly into a meter.
        """
        obj = self._deserialize_research(393, 0x10101f110, data)
        return self.candidate_fields(obj)

    def _deserialize_research(self, packet_id, expected_method, data):
        if not 0 < len(data) < 0x7000:
            raise ValueError("Invalid candidate size")
        obj = self.construct_for_research(packet_id)
        method = self.qword(self.qword(obj) + 8)
        if method != expected_method:
            raise ValueError("Unexpected candidate deserializer")
        source, cursor = self.DATA + 0x9000, self.DATA + 0x8000
        self.uc.mem_write(source, bytes(0x7000))
        self.uc.mem_write(source, data)
        self.uc.mem_write(cursor, struct.pack("<Q", source))
        result = self.call(method, obj, cursor, source + len(data))
        if not result & 255 or self.qword(cursor) != source + len(data):
            raise ValueError("Candidate input rejected or trailing bytes")
        return obj

    def unpack_batch(self, data):
        """Type 1045, dispatched as a length-delimited packet list by 0x10021ffa0."""
        obj = self._deserialize_research(1045, 0x101104670, data)
        count = struct.unpack('<I', self.uc.mem_read(obj + 24, 4))[0]
        size = struct.unpack('<I', self.uc.mem_read(obj + 40, 4))[0]
        if count > 4096 or size > 0x7000:
            raise ValueError('Batch limits exceeded')
        lengths_pointer, data_pointer = self.qword(obj + 16), self.qword(obj + 32)
        for pointer, length in ((lengths_pointer, count * 2), (data_pointer, size)):
            if length and not self._contains_allocation(pointer, length):
                raise ValueError('Batch points outside its allocations')
        lengths = struct.unpack('<' + str(count) + 'H', self.uc.mem_read(lengths_pointer, count * 2)) if count else ()
        if sum(lengths) != size or any(length == 0 for length in lengths):
            raise ValueError('Batch lengths do not cover its payload')
        raw = bytes(self.uc.mem_read(data_pointer, size)) if size else b''
        packets, offset = [], 0
        for length in lengths:
            packets.append(raw[offset:offset + length])
            offset += length
        return packets

    def _contains_allocation(self, pointer, length):
        return any(base <= pointer and pointer + length <= base + size for base, size in self.allocations)

    def damage_stat_event(self, data):
        """Extract the event delivered to damage counters via the generic type 743 envelope."""
        obj = self._deserialize_research(743, 0x1011c1380, data)
        registers = {UC_X86_REG_R14: obj, UC_X86_REG_RBP: self.STACK + 0x10000}
        self.segment(0x1003c9edf, 0x1003c9f7c, registers)
        schema = self.uc.reg_read(UC_X86_REG_RCX) & 0xffffffff
        self.segment(0x1003c9fa2, 0x1003c9ff3, registers)
        kind = self.uc.reg_read(UC_X86_REG_RSI) & 0xffff
        if schema != 0x2839cc82 or kind not in (24, 25):
            return None
        owner = struct.unpack('<I', self.uc.mem_read(obj + 12, 4))[0]
        size = struct.unpack('<I', self.uc.mem_read(obj + 24, 4))[0]
        pointer = self.qword(obj + 16)
        if size != 96 or not self._contains_allocation(pointer, size):
            raise ValueError('Unexpected damage stat event size')
        raw = bytes(self.uc.mem_read(pointer, size))
        peer = struct.unpack_from('<I', raw, 4)[0]
        physical, magic, true, extra = struct.unpack_from('<ffff', raw, 28)
        if not owner or not peer or any(not math.isfinite(v) or v < 0 for v in (physical, magic, true, extra)):
            raise ValueError('Invalid damage stat event fields')
        source, target = (owner, peer) if kind == 25 else (peer, owner)
        return {'candidateSourceNetId': source, 'candidateTargetNetId': target,
                'candidateAmount': physical + magic + true,
                'schools': {'physical': physical, 'magic': magic, 'true': true},
                'extraAmount': extra, 'candidateHash': struct.unpack_from('<I', raw, 80)[0],
                'statDirection': 'outgoing' if kind == 25 else 'incoming',
                'validation': 'exact-client-damage-counter-fields; coverage-unverified'}

    def _prepare_spawn_reader(self):
        # The spawn reader requires the game's initialized flag for a trailing
        # enum whose conversion routine (0x1006d1050) returns its input.
        context = self.DATA + 0x5000
        self.uc.mem_write(0x1024b44b8, struct.pack('<Q', context))
        self.uc.mem_write(context + 0x70, b'\1')
        self.uc.mem_write(self.stack_guard_pointer, struct.pack('<Q', self.DATA + 0x500))

    def _spawn_name(self, obj, offset):
        pointer = self.qword(obj + offset)
        size = struct.unpack('<I', self.uc.mem_read(obj + offset + 8, 4))[0]
        if 0 < size <= 128 and self._contains_allocation(pointer, size):
            return bytes(self.uc.mem_read(pointer, size))
        return b''

    def spawned_practice_dummy(self, data):
        """Type 43 uses the champion spawn path for a Practice Tool dummy."""
        self._prepare_spawn_reader()
        obj = self._deserialize_research(43, 0x101048050, data)
        if self._spawn_name(obj, 0x60) != b'PracticeTool_TargetDummy':
            return None
        self.segment(0x1006ebdd8, 0x1006ebed1, {UC_X86_REG_RBX: obj})
        return (self.uc.reg_read(UC_X86_REG_RSI) & 0xffffffff) or None

    def spawned_wolf(self, data):
        """Identify the Rift wolf models observed in the controlled test."""
        self._prepare_spawn_reader()
        obj = self._deserialize_research(1193, 0x101009a20, data)
        if not re.fullmatch(rb'SRU_Murkwolf(?:Mini)?\.\d+\.\d+', self._spawn_name(obj, 0x80), re.I):
            return None
        self.segment(0x1006ed048, 0x1006ed0d7, {UC_X86_REG_R13: obj})
        return (self.uc.reg_read(UC_X86_REG_RSI) & 0xffffffff) or None

    def candidate_fields(self, obj):
        """Decode object fields via the original client consumer, for oracle tests."""
        self.segment(0x1000e14a7, 0x1000e1568, {UC_X86_REG_RSI: obj})
        target = self.uc.reg_read(UC_X86_REG_RSI) & 0xffffffff
        registers = {UC_X86_REG_R12: obj, UC_X86_REG_R13: 0x10210a2a0}
        self.segment(0x1000e159f, 0x1000e16f5, registers)
        actor = self.uc.reg_read(UC_X86_REG_RSI) & 0xffffffff
        self.segment(0x1000e172b, 0x1000e1792, registers)
        amount = struct.unpack("<f", struct.pack("<I", self.uc.reg_read(UC_X86_REG_RSI) & 0xffffffff))[0]
        sp = self.STACK + 0x10000
        self.segment(0x1000e1900, 0x1000e1ab3,
                     {**registers, UC_X86_REG_RBX: 0, UC_X86_REG_RSP: sp})
        if not math.isfinite(amount) or amount < 0:
            raise ValueError("Invalid candidate amount")
        return {"candidateSourceNetId": actor, "candidateTargetNetId": target,
                "candidateAmount": amount,
                "candidateTypeCode": self.uc.reg_read(UC_X86_REG_R9) & 255,
                "candidateResultCode": self.uc.reg_read(UC_X86_REG_R8) & 255,
                "candidateDisplayCode": self.uc.reg_read(UC_X86_REG_RCX) & 255,
                "candidateHash": struct.unpack("<I", self.uc.mem_read(sp, 4))[0],
                "validation": "exact-client-fields; gameplay-semantics-unverified"}

    def deserialize(self, *_args):
        raise ValueError("16.22 semantic decoding is not enabled")
