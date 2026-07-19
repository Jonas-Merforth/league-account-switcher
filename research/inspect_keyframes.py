"""Patch-local keyframe reverse-engineering helper.

This is intentionally not part of the production runtime.  It loads the
current League executable into Unicorn and invokes packet constructors and
deserializers against ROFL keyframe blocks.  Run from the repository root with
the research venv described in docs/ once a profile has been verified.
"""

from __future__ import annotations

import argparse
import json
import struct
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import pefile
import zstandard
from capstone import CS_ARCH_X86, CS_MODE_64, Cs
from unicorn import (
    UC_ARCH_X86,
    UC_HOOK_CODE,
    UC_HOOK_MEM_INVALID,
    UC_MODE_64,
    Uc,
    UcError,
)
from unicorn.x86_const import (
    UC_X86_REG_EDX,
    UC_X86_REG_GS_BASE,
    UC_X86_REG_R8,
    UC_X86_REG_R9,
    UC_X86_REG_RAX,
    UC_X86_REG_RBX,
    UC_X86_REG_RCX,
    UC_X86_REG_RDX,
    UC_X86_REG_RIP,
    UC_X86_REG_RSP,
)


CHUNK_HEADER_SIZE = 17
SIGNATURE_SIZE = 0x100
HERO_SNAPSHOT_PACKET_ID = 747
HERO_SNAPSHOT_TABLE_RVA = 0x1AFFB00
ROSTER_PACKET_ID = 761


@dataclass(frozen=True)
class Block:
    timestamp: float
    packet_id: int
    param: int
    payload: bytes


@dataclass(frozen=True)
class Keyframe:
    keyframe_id: int
    blocks: tuple[Block, ...]


@dataclass(frozen=True)
class PacketProfile:
    packet_id: int
    constructor_rva: int
    deserialize_rva: int
    vtable_rva: int


def parse_blocks(data: bytes) -> tuple[Block, ...]:
    cursor = 0
    timestamp = 0.0
    previous_packet_id = 0
    previous_param = 0
    blocks: list[Block] = []
    while cursor < len(data):
        marker = data[cursor]
        cursor += 1
        if marker & 0x80:
            timestamp += data[cursor] * 0.001
            cursor += 1
        else:
            timestamp = struct.unpack_from("<f", data, cursor)[0]
            cursor += 4
        if marker & 0x10:
            length = data[cursor]
            cursor += 1
        else:
            length = struct.unpack_from("<I", data, cursor)[0]
            cursor += 4
        if marker & 0x40:
            packet_id = previous_packet_id
        else:
            packet_id = struct.unpack_from("<H", data, cursor)[0]
            cursor += 2
        if marker & 0x20:
            param = (previous_param + data[cursor]) & 0xFFFFFFFF
            cursor += 1
        else:
            param = struct.unpack_from("<I", data, cursor)[0]
            cursor += 4
        payload = data[cursor : cursor + length]
        if len(payload) != length:
            raise ValueError(f"truncated block payload at {cursor}")
        blocks.append(Block(timestamp, packet_id, param, payload))
        cursor += length
        previous_packet_id = packet_id
        previous_param = param
    return tuple(blocks)


def read_rofl(path: Path) -> tuple[dict, tuple[Keyframe, ...]]:
    data = path.read_bytes()
    if data[:4] != b"RIOT":
        raise ValueError("not a ROFL file")
    version_length = data[0x0E]
    chunks_start = 0x0F + version_length
    metadata_length = struct.unpack_from("<I", data, len(data) - 4)[0]
    metadata_start = len(data) - 4 - metadata_length
    chunks_end = metadata_start - SIGNATURE_SIZE
    metadata = json.loads(data[metadata_start : len(data) - 4])

    cursor = chunks_start
    keyframes: list[Keyframe] = []
    while cursor < chunks_end:
        chunk_id = struct.unpack_from("<I", data, cursor)[0]
        secondary_id = struct.unpack_from("<I", data, cursor + 5)[0]
        uncompressed_length = struct.unpack_from("<I", data, cursor + 9)[0]
        compressed_length = struct.unpack_from("<I", data, cursor + 13)[0]
        body_length = compressed_length or uncompressed_length
        body_start = cursor + CHUNK_HEADER_SIZE
        body = data[body_start : body_start + body_length]
        cursor = body_start + body_length
        if (secondary_id >> 24) != 0x02:
            continue
        decoded = (
            zstandard.ZstdDecompressor().decompress(
                body, max_output_size=uncompressed_length
            )
            if compressed_length
            else body
        )
        if len(decoded) != uncompressed_length:
            raise ValueError(f"keyframe {chunk_id} length mismatch")
        keyframes.append(Keyframe(chunk_id, parse_blocks(decoded)))
    return metadata, tuple(keyframes)


def read_rofl_stream(path: Path, stream_code: int) -> tuple[Block, ...]:
    """Read every block from one ROFL stream (1=game, 2=keyframes)."""

    data = path.read_bytes()
    if data[:4] != b"RIOT":
        raise ValueError("not a ROFL file")
    version_length = data[0x0E]
    chunks_start = 0x0F + version_length
    metadata_length = struct.unpack_from("<I", data, len(data) - 4)[0]
    metadata_start = len(data) - 4 - metadata_length
    chunks_end = metadata_start - SIGNATURE_SIZE
    cursor = chunks_start
    blocks: list[Block] = []
    while cursor < chunks_end:
        _chunk_id = struct.unpack_from("<I", data, cursor)[0]
        secondary_id = struct.unpack_from("<I", data, cursor + 5)[0]
        uncompressed_length = struct.unpack_from("<I", data, cursor + 9)[0]
        compressed_length = struct.unpack_from("<I", data, cursor + 13)[0]
        body_length = compressed_length or uncompressed_length
        body_start = cursor + CHUNK_HEADER_SIZE
        body = data[body_start : body_start + body_length]
        cursor = body_start + body_length
        if (secondary_id >> 24) != stream_code:
            continue
        decoded = (
            zstandard.ZstdDecompressor().decompress(
                body, max_output_size=uncompressed_length
            )
            if compressed_length
            else body
        )
        blocks.extend(parse_blocks(decoded))
    return tuple(blocks)


def infer_player_base(blocks: tuple[Block, ...]) -> int:
    scores: dict[int, int] = {}
    for block in blocks:
        if block.param < 0x40000000:
            continue
        scores[block.param] = scores.get(block.param, 0) + 1
    candidates = []
    for base in scores:
        total = sum(scores.get(base + offset, 0) for offset in range(10))
        if all(base + offset in scores for offset in range(10)):
            candidates.append((total, base))
    if not candidates:
        raise ValueError("could not infer ten contiguous player entities")
    return max(candidates)[1]


class LeagueEmulator:
    IMAGE_BASE = 0x140000000
    STACK = 0x20000000
    DATA = 0x30000000
    STOP = 0x50000000
    GS = 0x60000000
    BASE_PARAMETER_TABLE_RVA = 0x1B1FF50
    NETWORK_ENUM_CONTEXT_RVA = 0x1ED6C78

    def __init__(self, executable: Path):
        self.executable = executable
        self.raw = executable.read_bytes()
        self.pe = pefile.PE(data=self.raw)
        self.image_base = self.pe.OPTIONAL_HEADER.ImageBase

    def packet_profile(self, packet_id: int) -> PacketProfile:
        marker = b"\x66\xc7\x41\x08" + struct.pack("<H", packet_id)
        offsets: list[int] = []
        cursor = 0
        while True:
            cursor = self.raw.find(marker, cursor)
            if cursor < 0:
                break
            offsets.append(cursor)
            cursor += 1
        if len(offsets) != 1:
            raise ValueError(
                f"packet {packet_id} has {len(offsets)} constructor markers"
            )
        marker_offset = offsets[0]
        padding_offset = self.raw.rfind(
            b"\xcc", max(0, marker_offset - 0x100), marker_offset
        )
        if padding_offset < 0:
            raise ValueError(f"packet {packet_id} constructor start not found")
        constructor_rva = self.pe.get_rva_from_offset(padding_offset + 1)
        body = self.pe.get_data(constructor_rva, 0x10000)
        disassembler = Cs(CS_ARCH_X86, CS_MODE_64)
        end = None
        for instruction in disassembler.disasm(
            body, self.image_base + constructor_rva
        ):
            if instruction.mnemonic == "ret":
                end = (
                    instruction.address
                    - self.image_base
                    - constructor_rva
                    + instruction.size
                )
                break
        if end is None:
            raise ValueError(f"packet {packet_id} constructor has no return")
        body = body[:end]
        assignments: list[int] = []
        cursor = 0
        lea_mov_prefix = b"\x48\x8d\x05"
        while cursor < len(body):
            cursor = body.find(lea_mov_prefix, cursor)
            if cursor < 0:
                break
            assignment_window = body[cursor + 7 : cursor + 24]
            if b"\x48\x89\x01" in assignment_window:
                displacement = struct.unpack_from("<i", body, cursor + 3)[0]
                assignments.append(
                    constructor_rva + cursor + 7 + displacement
                )
            cursor += 1
        if not assignments:
            raise ValueError(f"packet {packet_id} vtable assignment not found")
        vtable_rva = assignments[-1]
        deserialize_va = struct.unpack(
            "<Q", self.pe.get_data(vtable_rva + 8, 8)
        )[0]
        return PacketProfile(
            packet_id=packet_id,
            constructor_rva=constructor_rva,
            deserialize_rva=deserialize_va - self.image_base,
            vtable_rva=vtable_rva,
        )

    def _new_machine(self) -> tuple[Uc, list[int]]:
        uc = Uc(UC_ARCH_X86, UC_MODE_64)
        image_size = (self.pe.OPTIONAL_HEADER.SizeOfImage + 0xFFF) & ~0xFFF
        uc.mem_map(self.image_base, image_size)
        uc.mem_write(
            self.image_base, self.raw[: self.pe.OPTIONAL_HEADER.SizeOfHeaders]
        )
        for section in self.pe.sections:
            section_data = section.get_data()
            if section_data:
                uc.mem_write(
                    self.image_base + section.VirtualAddress, section_data
                )
        uc.mem_map(self.STACK, 0x20000)
        uc.mem_map(self.DATA, 0x400000)
        uc.mem_map(self.STOP, 0x1000)
        uc.mem_map(self.GS, 0x10000)
        uc.mem_write(self.STOP, b"\xCC")
        uc.reg_write(UC_X86_REG_GS_BASE, self.GS)
        # MSVC's thread-safe local-static checks read the TLS vector through
        # gs:[0x58]. A zeroed thread block is sufficient for packet defaults.
        tls_block = self.DATA + 0x3D0000
        tls_vector = self.DATA + 0x3E0000
        uc.mem_write(self.GS + 0x58, struct.pack("<Q", tls_vector))
        uc.mem_write(tls_vector, struct.pack("<Q", tls_block))
        # Generated primitive readers reject otherwise valid enum bytes until
        # the live client's network context exists.  Their lookup function is
        # identity-only (RVA 0x6D3380); the context merely bounds the decoded
        # byte and advertises readiness.  A permissive research context lets
        # packet deserializers run without launching League.
        enum_context = self.DATA + 0x3C0000
        uc.mem_write(enum_context + 8, b"\xff")
        uc.mem_write(enum_context + 0x70, b"\x01")
        uc.mem_write(
            self.image_base + self.NETWORK_ENUM_CONTEXT_RVA,
            struct.pack("<Q", enum_context),
        )
        return uc, [self.DATA + 0x10000]

    def encode_block_param(self, param: int) -> bytes:
        """Recreate the parameter prefix consumed by Packet::Deserialize.

        Replay framing carries the packet's routing parameter separately from
        its payload.  The client joins the two again before invoking the
        packet-specific deserializer.  Calling the vtable deserializer with
        only ``Block.payload`` shifts every field and can still appear to work
        for packets whose first real field resembles a valid varint.
        """

        table = self.pe.get_data(self.BASE_PARAMETER_TABLE_RVA, 0x100)

        def transform(value: int) -> int:
            value = (~value) & 0xFF
            value = table[value]
            value = (value + 0x54) & 0xFF
            value = ((value << 1) | (value >> 7)) & 0xFF
            value = table[value]
            value = (value - 0x4C) & 0xFF
            return table[value]

        inverse = {transform(value): value for value in range(0x100)}
        if len(inverse) != 0x100:
            raise ValueError("base packet parameter transform is not invertible")

        encoded_value = (
            param
            if param & 0xFFFFFF == 0
            else param ^ 0x40000000
        )
        output = bytearray()
        while True:
            current = encoded_value & 0x7F
            encoded_value >>= 7
            if encoded_value:
                current |= 0x80
            output.append(inverse[current])
            if not encoded_value:
                return bytes(output)

    @staticmethod
    def _return_from_hook(uc: Uc) -> None:
        rsp = uc.reg_read(UC_X86_REG_RSP)
        return_address = struct.unpack("<Q", uc.mem_read(rsp, 8))[0]
        uc.reg_write(UC_X86_REG_RSP, rsp + 8)
        uc.reg_write(UC_X86_REG_RIP, return_address)

    def deserialize(
        self,
        payload: bytes,
        *,
        constructor_rva: int,
        deserialize_rva: int,
        object_size: int,
        trace_field_tags: bool = False,
        trace_plaintext_reads: bool = False,
    ) -> tuple[bool, int, bytes, Uc, int]:
        uc, heap = self._new_machine()
        obj = self.DATA + 0x1000
        cursor = self.DATA + 0x8000
        source = self.DATA + 0x9000
        uc.mem_write(source, payload)
        uc.mem_write(cursor, struct.pack("<Q", source))
        invalid_access: list[tuple[int, int, int]] = []
        self.last_field_tags: list[dict[str, int]] = []
        self.last_plaintext_reads: list[dict[str, int | str]] = []
        self.last_schema_calls: list[dict[str, int | str]] = []
        self.last_execution_rvas: deque[int] = deque(maxlen=128)
        self.last_allocations: list[tuple[int, int]] = []
        pending_field_tags: dict[int, list[dict[str, int]]] = {}
        pending_plaintext_reads: dict[int, list[dict[str, int | str]]] = {}
        pending_schema_calls: dict[int, list[dict[str, int | str]]] = {}

        # These patch-local readers leave the decoded primitive in the target
        # buffer and return to the generated schema before that schema applies
        # its at-rest mutation.  Capturing the value at the return address
        # exposes the wire value without having to reverse every per-field
        # storage transform.
        direct_plaintext_readers = {
            0xF881B0: 2,
            0xF88260: 2,
            0xF8EFA0: 4,
            0xF8F2A0: 4,
            0xF8F630: 4,
            0xF8FF10: 4,
            0xF91220: 4,
        }

        def allocate(length: int) -> int:
            allocation = heap[0]
            heap[0] = (allocation + max(length, 1) + 0xF) & ~0xF
            if heap[0] >= self.DATA + 0x3F0000:
                raise MemoryError("emulated packet heap exhausted")
            uc.mem_write(allocation, b"\0" * max(length, 1))
            self.last_allocations.append((allocation, length))
            return allocation

        def hook(machine: Uc, address: int, _size: int, _user: object) -> None:
            rva = address - self.image_base
            self.last_execution_rvas.append(rva)
            if trace_plaintext_reads:
                completed_schema = pending_schema_calls.get(address)
                if completed_schema:
                    record = completed_schema.pop()
                    cursor_pointer = int(record["cursorPointer"])
                    record["endSourceOffset"] = (
                        struct.unpack(
                            "<Q", machine.mem_read(cursor_pointer, 8)
                        )[0]
                        - source
                    )
                    self.last_schema_calls.append(record)

                if rva in (0x103C4E0, 0x1039FB0):
                    rsp = machine.reg_read(UC_X86_REG_RSP)
                    return_address = struct.unpack(
                        "<Q", machine.mem_read(rsp, 8)
                    )[0]
                    cursor_pointer = machine.reg_read(UC_X86_REG_RDX)
                    record = {
                        "schema": (
                            "inventoryRecord"
                            if rva == 0x103C4E0
                            else "inventoryState"
                        ),
                        "schemaRva": rva,
                        "returnRva": return_address - self.image_base,
                        "target": machine.reg_read(UC_X86_REG_RCX),
                        "cursorPointer": cursor_pointer,
                        "startSourceOffset": (
                            struct.unpack(
                                "<Q", machine.mem_read(cursor_pointer, 8)
                            )[0]
                            - source
                        ),
                    }
                    pending_schema_calls.setdefault(
                        return_address, []
                    ).append(record)

                completed = pending_plaintext_reads.get(address)
                if completed:
                    record = completed.pop()
                    target = int(record["target"])
                    length = int(record["size"])
                    record["valueHex"] = bytes(
                        machine.mem_read(target, length)
                    ).hex()
                    self.last_plaintext_reads.append(record)

                if rva in direct_plaintext_readers:
                    rsp = machine.reg_read(UC_X86_REG_RSP)
                    return_address = struct.unpack(
                        "<Q", machine.mem_read(rsp, 8)
                    )[0]
                    cursor_pointer = machine.reg_read(UC_X86_REG_RDX)
                    source_offset = -1
                    if self.DATA <= cursor_pointer < self.DATA + 0x400000:
                        source_offset = (
                            struct.unpack(
                                "<Q", machine.mem_read(cursor_pointer, 8)
                            )[0]
                            - source
                        )
                    record = {
                        "readerRva": rva,
                        "returnRva": return_address - self.image_base,
                        "target": machine.reg_read(UC_X86_REG_RCX),
                        "size": direct_plaintext_readers[rva],
                        "sourceOffset": source_offset,
                    }
                    pending_plaintext_reads.setdefault(
                        return_address, []
                    ).append(record)

                # Three wrapper readers apply their mutation internally.  The
                # hook points below are immediately after their raw reader and
                # before the first mutation instruction.
                internal_plaintext_points = {
                    0xF9874E: (UC_X86_REG_RBX, 4, 0xF98740),
                    0xF9964E: (UC_X86_REG_RBX, 4, 0xF99640),
                    0xF96F8E: (UC_X86_REG_R9, 1, 0xF96F50),
                }
                internal = internal_plaintext_points.get(rva)
                if internal:
                    register, length, reader_rva = internal
                    target = machine.reg_read(register)
                    self.last_plaintext_reads.append(
                        {
                            "readerRva": reader_rva,
                            "returnRva": rva,
                            "target": target,
                            "size": length,
                            "sourceOffset": -1,
                            "valueHex": bytes(
                                machine.mem_read(target, length)
                            ).hex(),
                        }
                    )
            if trace_field_tags:
                pending = pending_field_tags.get(address)
                if pending:
                    record = pending.pop()
                    record["result"] = machine.reg_read(UC_X86_REG_RAX) & 0xFF
                if address == self.image_base + 0xF21130:
                    rsp = machine.reg_read(UC_X86_REG_RSP)
                    return_address = struct.unpack(
                        "<Q", machine.mem_read(rsp, 8)
                    )[0]
                    field_source = machine.reg_read(UC_X86_REG_RCX)
                    record = {
                        "sourceOffset": field_source - source,
                        "tagBytes": machine.reg_read(UC_X86_REG_RDX) & 0xFF,
                        "schemaMode": machine.reg_read(UC_X86_REG_R8) & 0xFF,
                        "returnRva": return_address - self.image_base,
                    }
                    self.last_field_tags.append(record)
                    pending_field_tags.setdefault(return_address, []).append(
                        record
                    )
            if address == self.image_base + 0x1196540:
                # Patch-local League allocator. Packet vector helpers use this
                # entry point for their backing storage.
                length = machine.reg_read(UC_X86_REG_RCX)
                machine.reg_write(UC_X86_REG_RAX, allocate(length))
                self._return_from_hook(machine)
                return
            if address == self.image_base + 0x1196570:
                # The research machine is discarded after every packet, so
                # freeing individual allocations is intentionally a no-op.
                self._return_from_hook(machine)
                return
            # Riot's byte-vector resize helper.  Replacing it here avoids
            # emulating the CRT allocator while retaining the exact client
            # mutation transforms around it.
            if address == self.image_base + 0x230C00:
                vector = machine.reg_read(UC_X86_REG_RCX)
                length = machine.reg_read(UC_X86_REG_EDX) & 0xFFFFFFFF
                allocation = allocate(length) if length else 0
                machine.mem_write(
                    vector,
                    struct.pack(
                        "<QII", allocation if length else 0, length, length
                    ),
                )
                self._return_from_hook(machine)

        uc.hook_add(UC_HOOK_CODE, hook)
        uc.hook_add(
            UC_HOOK_MEM_INVALID,
            lambda machine, access, address, size, _value, _user: (
                invalid_access.append(
                    (machine.reg_read(UC_X86_REG_RIP), address, size)
                )
                or False
            ),
        )

        def call(rva: int, rcx: int, rdx: int = 0, r8: int = 0) -> int:
            rsp = ((self.STACK + 0x1F000) & ~0xF) - 8
            uc.mem_write(rsp, struct.pack("<Q", self.STOP))
            uc.reg_write(UC_X86_REG_RSP, rsp)
            uc.reg_write(UC_X86_REG_RCX, rcx)
            uc.reg_write(UC_X86_REG_RDX, rdx)
            uc.reg_write(UC_X86_REG_R8, r8)
            try:
                uc.emu_start(
                    self.image_base + rva, self.STOP, count=4_000_000
                )
            except UcError as error:
                detail = ""
                if invalid_access:
                    rip, address, size = invalid_access[-1]
                    detail = (
                        f" at rva=0x{rip - self.image_base:x}, "
                        f"address=0x{address:x}, size={size}"
                    )
                raise RuntimeError(f"packet emulation failed{detail}") from error
            return uc.reg_read(UC_X86_REG_RAX)

        call(constructor_rva, obj)
        result = call(
            deserialize_rva, obj, cursor, source + len(payload)
        )
        consumed = struct.unpack("<Q", uc.mem_read(cursor, 8))[0] - source
        return (
            bool(result & 0xFF),
            consumed,
            bytes(uc.mem_read(obj, object_size)),
            uc,
            obj,
        )

    def deserialize_block(
        self,
        block: Block,
        *,
        constructor_rva: int,
        deserialize_rva: int,
        object_size: int,
        trace_field_tags: bool = False,
        trace_plaintext_reads: bool = False,
    ) -> tuple[bool, int, bytes, Uc, int]:
        parameter_prefix = self.encode_block_param(block.param)
        return self.deserialize(
            parameter_prefix + block.payload,
            constructor_rva=constructor_rva,
            deserialize_rva=deserialize_rva,
            object_size=object_size,
            trace_field_tags=trace_field_tags,
            trace_plaintext_reads=trace_plaintext_reads,
        )


def rotate_right_8(value: int, bits: int) -> int:
    bits &= 7
    return ((value >> bits) | (value << (8 - bits))) & 0xFF


def swap_adjacent_bits(value: int) -> int:
    return (((value & 0xD5) << 1) | ((value >> 1) & 0x55)) & 0xFF


def decode_hero_snapshot_payload(payload: bytes, table: bytes) -> bytes:
    """Decode packet 747's full AIHero replication byte vector.

    Packet 747 has one field after its routing parameter: a mutated byte
    vector.  The vector decoder writes alternating input bytes to the front
    and back of the output buffer.  This function mirrors the patch-local
    League routine at RVA 0xEEBE80 without emulating the client.
    """

    if len(table) != 0x100:
        raise ValueError("hero snapshot mutation table must contain 256 bytes")
    if not payload or payload[0] != 0xE8:
        raise ValueError("unexpected hero snapshot field tag")

    def decode_byte(value: int) -> int:
        value = rotate_right_8(value, 4)
        value = (value - 0x75) & 0xFF
        value = swap_adjacent_bits(value)
        value = rotate_right_8(value, 1) ^ 0xF5
        return table[value]

    cursor = 1
    length = 0
    shift = 0
    while cursor < len(payload):
        value = decode_byte(payload[cursor])
        cursor += 1
        length |= (value & 0x7F) << shift
        if value < 0x80:
            break
        shift += 7
        if shift > 28:
            raise ValueError("hero snapshot vector length varint is too long")
    else:
        raise ValueError("truncated hero snapshot vector length")

    if length != len(payload) - cursor:
        raise ValueError(
            f"hero snapshot vector length {length} does not match "
            f"{len(payload) - cursor} payload bytes"
        )

    output = bytearray(length)
    front = 0
    back = length - 1
    while front < back:
        output[front] = decode_byte(payload[cursor])
        cursor += 1
        front += 1
        output[back] = decode_byte(payload[cursor])
        cursor += 1
        back -= 1
    if front == back:
        output[front] = decode_byte(payload[cursor])
        cursor += 1
    if cursor != len(payload):
        raise ValueError("hero snapshot decoder did not consume the payload")
    return bytes(output)


def decode_mutated_varint(
    payload: bytes, cursor: int, transform
) -> tuple[int, int]:
    """Decode a League generated-schema varint at ``cursor``."""

    value = 0
    shift = 0
    while cursor < len(payload):
        current = transform(payload[cursor])
        cursor += 1
        value |= (current & 0x7F) << shift
        if current < 0x80:
            return value, cursor
        shift += 7
        if shift > 28:
            raise ValueError("mutated varint is too long")
    raise ValueError("truncated mutated varint")


def roster_string_transform_alternating(value: int) -> int:
    """Mutation used by packet 761's alternating string reader."""

    value = swap_adjacent_bits(value)
    value = (value + 0x28) & 0xFF
    value = swap_adjacent_bits(value)
    value = (~value) & 0xFF
    value = swap_adjacent_bits(value)
    return (value + 0x0C) & 0xFF


def roster_string_transform_reverse(value: int) -> int:
    """Mutation used by packet 761's reverse string reader."""

    value = (value - 0x37) & 0xFF
    value = rotate_right_8(value, 2)
    value = (value - 0x5E) & 0xFF
    return swap_adjacent_bits(value)


def roster_string_transform_forward(value: int) -> int:
    """Mutation used by packet 761's forward string reader."""

    value = (value - 0x21) & 0xFF
    value = rotate_right_8(value, 3)
    value = (value - 0x6A) & 0xFF
    value = rotate_right_8(value, 4)
    value = (~value) & 0xFF
    return rotate_right_8(value, 1)


def decode_mutated_string_at(
    payload: bytes,
    offset: int,
    *,
    transform,
    order: str,
    maximum_length: int = 64,
) -> tuple[str, int]:
    """Decode one of packet 761's three generated string encodings."""

    length, cursor = decode_mutated_varint(payload, offset, transform)
    if length > maximum_length or cursor + length > len(payload):
        raise ValueError("mutated string length is outside the payload")
    output = bytearray(length)
    if order == "forward":
        for index in range(length):
            output[index] = transform(payload[cursor])
            cursor += 1
    elif order == "reverse":
        for index in range(length - 1, -1, -1):
            output[index] = transform(payload[cursor])
            cursor += 1
    elif order == "alternating":
        front = 0
        back = length - 1
        while front < back:
            output[front] = transform(payload[cursor])
            cursor += 1
            front += 1
            output[back] = transform(payload[cursor])
            cursor += 1
            back -= 1
        if front == back:
            output[front] = transform(payload[cursor])
            cursor += 1
    else:
        raise ValueError(f"unsupported string output order {order}")
    return output.decode("utf-8"), cursor


def scan_roster_strings(
    payload: bytes, expected: set[str]
) -> list[tuple[int, str, str]]:
    """Find expected schema strings without relying on League at runtime.

    This is a research aid for determining packet 761 record boundaries.  A
    production decoder must additionally validate the packet structure and
    participant order rather than accepting arbitrary string hits.
    """

    variants = (
        (
            "alternating",
            roster_string_transform_alternating,
            "alternating",
        ),
        ("reverse", roster_string_transform_reverse, "reverse"),
        ("forward", roster_string_transform_forward, "forward"),
    )
    matches: list[tuple[int, str, str]] = []
    for offset in range(len(payload)):
        for name, transform, order in variants:
            try:
                value, _cursor = decode_mutated_string_at(
                    payload,
                    offset,
                    transform=transform,
                    order=order,
                )
            except (UnicodeDecodeError, ValueError):
                continue
            if value in expected:
                matches.append((offset, name, value))
    return matches


def decoded_vector(uc: Uc, obj: int, offset: int) -> bytes:
    pointer, length, _capacity = struct.unpack(
        "<QII", uc.mem_read(obj + offset, 16)
    )
    return bytes(uc.mem_read(pointer, length)) if pointer and length else b""


def candidate_vectors(
    uc: Uc, obj: int, object_bytes: bytes
) -> Iterator[tuple[int, int, int, bytes]]:
    for offset in range(0x10, len(object_bytes) - 15, 8):
        pointer, length, capacity = struct.unpack_from(
            "<QII", object_bytes, offset
        )
        if not (
            LeagueEmulator.DATA <= pointer < LeagueEmulator.DATA + 0x400000
            and 0 < length <= capacity <= 0x100000
        ):
            continue
        sample_length = min(length, 0x400)
        yield (
            offset,
            length,
            capacity,
            bytes(uc.mem_read(pointer, sample_length)),
        )


def inspect_packet(
    emulator: LeagueEmulator,
    keyframe: Keyframe,
    player_base: int,
    packet_id: int,
) -> None:
    profile = emulator.packet_profile(packet_id)
    print(f"keyframe {keyframe.keyframe_id} profile={profile}")
    by_param = {
        block.param: block
        for block in keyframe.blocks
        if block.packet_id == packet_id
    }
    for slot in range(10):
        param = player_base + slot
        block = by_param.get(param)
        if not block:
            print(f"  slot={slot + 1} missing")
            continue
        try:
            ok, consumed, raw, uc, obj = emulator.deserialize_block(
                block,
                constructor_rva=profile.constructor_rva,
                deserialize_rva=profile.deserialize_rva,
                object_size=0x400,
            )
        except Exception as error:
            print(
                f"  slot={slot + 1} param=0x{param:08x} "
                f"error={error}"
            )
            continue
        vectors = list(candidate_vectors(uc, obj, raw))
        print(
            f"  slot={slot + 1} param=0x{param:08x} "
            f"ok={ok} consumed={consumed}/"
            f"{len(emulator.encode_block_param(block.param)) + len(block.payload)} "
            f"vectors={[(offset, length, capacity) for offset, length, capacity, _sample in vectors]} "
            f"object={raw[:0x80].hex()}"
        )
        for offset, length, _capacity, sample in vectors:
            print(f"    vector@0x{offset:x} length={length} sample={sample.hex()}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("replay", type=Path)
    parser.add_argument(
        "--exe",
        type=Path,
        default=Path(
            r"C:\Riot Games\League of Legends\Game\League of Legends.exe"
        ),
    )
    parser.add_argument("--keyframe", type=int)
    parser.add_argument("--packet", type=int, default=648)
    args = parser.parse_args()

    metadata, keyframes = read_rofl(args.replay)
    stats = json.loads(metadata.get("statsJson", "[]"))
    print(
        json.dumps(
            {
                "gameLength": metadata.get("gameLength"),
                "lastKeyFrameId": metadata.get("lastKeyFrameId"),
                "players": [
                    {
                        "slot": index + 1,
                        "champion": row.get("SKIN"),
                        "team": row.get("TEAM"),
                        "kills": row.get("CHAMPIONS_KILLED"),
                        "deaths": row.get("NUM_DEATHS"),
                        "assists": row.get("ASSISTS"),
                        "minions": row.get("MINIONS_KILLED"),
                        "neutralMinions": row.get("NEUTRAL_MINIONS_KILLED"),
                        "level": row.get("LEVEL"),
                    }
                    for index, row in enumerate(stats)
                ],
            },
            indent=2,
        )
    )
    selected = (
        [frame for frame in keyframes if frame.keyframe_id == args.keyframe]
        if args.keyframe is not None
        else [keyframes[-1]]
    )
    emulator = LeagueEmulator(args.exe)
    for frame in selected:
        inspect_packet(
            emulator,
            frame,
            infer_player_base(frame.blocks),
            args.packet,
        )


if __name__ == "__main__":
    main()
