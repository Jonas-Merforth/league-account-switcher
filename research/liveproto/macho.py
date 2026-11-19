"""Official macOS game binary: the x86-64 slice and what the probe needs from it.

Nothing here is tied to one build. Function starts, import stubs and the
packet factory are located from the file itself.
"""
import bisect
import collections
import hashlib
import struct
from pathlib import Path

LC_SEGMENT_64 = 0x19
LC_SYMTAB = 0x2
LC_DYSYMTAB = 0xb
LC_FUNCTION_STARTS = 0x26
CPU_X86_64 = 0x1000007
S_NON_LAZY_SYMBOL_POINTERS = 0x6
S_SYMBOL_STUBS = 0x8


class MachO:
    def __init__(self, path):
        fat = Path(path).read_bytes()
        self.path = Path(path)
        self.sha256 = hashlib.sha256(fat).hexdigest()
        if fat[:4] != bytes.fromhex("cafebabe"):
            raise ValueError("Expected a universal Mach-O executable")
        for index in range(struct.unpack_from(">I", fat, 4)[0]):
            cpu, _, offset, size, _ = struct.unpack_from(">5I", fat, 8 + 20 * index)
            if cpu == CPU_X86_64:
                self.raw = fat[offset:offset + size]
                break
        else:
            raise ValueError("No x86-64 slice")
        self.segments, self.sections, self.functions = [], [], []
        symtab = dysymtab = None
        cursor = 32
        for _ in range(struct.unpack_from("<I", self.raw, 16)[0]):
            command, length = struct.unpack_from("<II", self.raw, cursor)
            if command == LC_SEGMENT_64:
                name, va, size, offset, file_size, _, _, count, _ = struct.unpack_from("<16sQQQQIIII", self.raw, cursor + 8)
                self.segments.append((name.rstrip(b"\0").decode(), va, size, offset, file_size))
                for index in range(count):
                    fields = struct.unpack_from("<16s16sQQIIIIIII", self.raw, cursor + 72 + 80 * index)
                    self.sections.append({"name": fields[0].rstrip(b"\0").decode(), "addr": fields[2], "size": fields[3],
                                          "offset": fields[4], "type": fields[8] & 0xff, "reserved1": fields[9],
                                          "reserved2": fields[10]})
            elif command == LC_SYMTAB:
                symtab = struct.unpack_from("<4I", self.raw, cursor + 8)
            elif command == LC_DYSYMTAB:
                dysymtab = struct.unpack_from("<18I", self.raw, cursor + 8)
            elif command == LC_FUNCTION_STARTS:
                offset, size = struct.unpack_from("<II", self.raw, cursor + 8)
                address = next(va for name, va, *_ in self.segments if name == "__TEXT")
                delta = shift = 0
                for value in self.raw[offset:offset + size]:
                    delta |= (value & 127) << shift
                    if value & 128:
                        shift += 7
                        continue
                    if not delta:
                        break
                    address += delta
                    self.functions.append(address)
                    delta = shift = 0
            cursor += length
        if not self.functions or symtab is None or dysymtab is None:
            raise ValueError("The executable lacks function starts or symbol tables")
        self.text = next(section for section in self.sections if section["name"] == "__text")
        self.stubs = self._stubs(symtab, dysymtab)

    def get(self, address, size):
        for _, va, _, offset, file_size in self.segments:
            if va <= address and address + size <= va + file_size:
                return self.raw[offset + address - va:offset + address - va + size]
        raise ValueError(f"Unmapped binary address {address:#x}")

    def function_start(self, address):
        return self.functions[bisect.bisect_right(self.functions, address) - 1]

    def function_end(self, address):
        index = bisect.bisect_right(self.functions, address)
        return self.functions[index] if index < len(self.functions) else self.text["addr"] + self.text["size"]

    def in_text(self, address):
        return self.text["addr"] <= address < self.text["addr"] + self.text["size"]

    def _stubs(self, symtab, dysymtab):
        """Imported functions by name. Each stub is one indirect symbol."""
        symbols, _, strings, _ = symtab
        indirect = dysymtab[12]
        result = {}
        for section in self.sections:
            if section["type"] != S_SYMBOL_STUBS:
                continue
            width = section["reserved2"]
            for index in range(section["size"] // width):
                symbol = struct.unpack_from("<I", self.raw, indirect + 4 * (section["reserved1"] + index))[0]
                if symbol & 0xc0000000:
                    continue
                start = strings + struct.unpack_from("<I", self.raw, symbols + 16 * symbol)[0]
                name = self.raw[start:self.raw.index(b"\0", start)].decode()
                result.setdefault(name, section["addr"] + index * width)
        return result

    def stub_ranges(self):
        return [(s["addr"], s["addr"] + s["size"]) for s in self.sections if s["type"] == S_SYMBOL_STUBS]

    def import_pointer_slots(self):
        for section in self.sections:
            if section["type"] == S_NON_LAZY_SYMBOL_POINTERS:
                yield from range(section["addr"], section["addr"] + section["size"], 8)

    def factory(self):
        """The packet factory inlines every constructor, and each constructor
        stores its packet ID with `mov word ptr [reg+8], imm16`. No other
        function holds more than a couple of those stores."""
        data = self.raw[self.text["offset"]:self.text["offset"] + self.text["size"]]
        hits = collections.defaultdict(set)
        for modrm in (0x40, 0x41, 0x42, 0x43, 0x46, 0x47):
            marker = bytes((0x66, 0xc7, modrm, 0x08))
            position = data.find(marker)
            while position >= 0:
                packet_id = struct.unpack_from("<H", data, position + 4)[0]
                if packet_id < 0x800:
                    hits[self.function_start(self.text["addr"] + position)].add(packet_id)
                position = data.find(marker, position + 1)
        ranked = sorted(hits.items(), key=lambda item: -len(item[1]))
        if len(ranked) < 2 or len(ranked[0][1]) < 400 or len(ranked[1][1]) > 20:
            raise ValueError("Could not single out the packet factory")
        return ranked[0][0]

    def direct_callers(self, target):
        """Functions with a direct call or tail jump to `target`."""
        data = self.raw[self.text["offset"]:self.text["offset"] + self.text["size"]]
        found = set()
        for opcode in (0xe8, 0xe9):
            position = data.find(bytes((opcode,)))
            while 0 <= position <= len(data) - 5:
                if self.text["addr"] + position + 5 + struct.unpack_from("<i", data, position + 1)[0] == target:
                    found.add(self.function_start(self.text["addr"] + position))
                position = data.find(bytes((opcode,)), position + 1)
        return found
