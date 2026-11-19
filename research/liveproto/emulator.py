"""Runs the packet factory and deserializers of an official macOS build in Unicorn.

Offline only: no game process is started or inspected. Imported C runtime
functions are replaced by name, and the game's own allocator wrappers are
found the first time one of them faults, so no address is written down per
build.
"""
import struct

from unicorn import Uc, UcError, UC_ARCH_X86, UC_MODE_64, UC_HOOK_CODE, UC_HOOK_MEM_READ, UC_HOOK_MEM_WRITE
from unicorn.x86_const import (
    UC_X86_REG_RDI, UC_X86_REG_RSI, UC_X86_REG_RDX, UC_X86_REG_RCX, UC_X86_REG_R8, UC_X86_REG_R9,
    UC_X86_REG_RSP, UC_X86_REG_RBP, UC_X86_REG_RAX, UC_X86_REG_RIP,
)

ARGUMENTS = (UC_X86_REG_RDI, UC_X86_REG_RSI, UC_X86_REG_RDX, UC_X86_REG_RCX, UC_X86_REG_R8, UC_X86_REG_R9)
EmulationError = (UcError, ValueError)


class Emulator:
    DATA = 0x30000000
    OUT = DATA + 0x1000
    CURSOR = DATA + 0x8000
    SOURCE = DATA + 0x10000
    SOURCE_LIMIT = 0x8000
    IMPORTS = DATA + 0x40000
    HEAP = DATA + 0x100000
    HEAP_END = DATA + 0x800000
    STACK = 0x20000000
    STACK_SIZE = 0x40000
    STOP = 0x50000000

    def __init__(self, binary):
        self.binary = binary
        self.uc = Uc(UC_ARCH_X86, UC_MODE_64)
        # Some readers test a flag on a game singleton that only exists in a
        # running client. Its null pointer lands here and reads as "set".
        self.uc.mem_map(0, 0x10000)
        self.uc.mem_write(0, b"\1" * 0x10000)
        for name, va, size, offset, file_size in binary.segments:
            if name == "__PAGEZERO" or not size:
                continue
            self.uc.mem_map(va, (size + 4095) & ~4095)
            if file_size:
                self.uc.mem_write(va, binary.raw[offset:offset + file_size])
        for va, size in ((self.DATA, self.HEAP_END - self.DATA), (self.STACK, self.STACK_SIZE), (self.STOP, 0x1000)):
            self.uc.mem_map(va, size)
        # Imported data, such as the stack guard: one zeroed cell per pointer.
        for index, slot in enumerate(binary.import_pointer_slots()):
            self.uc.mem_write(slot, struct.pack("<Q", self.IMPORTS + 64 * index))
        self.stub_names = {address: name for name, address in binary.stubs.items()}
        for begin, end in binary.stub_ranges():
            self.uc.hook_add(UC_HOOK_CODE, self._stub, begin=begin, end=end - 1)
        self.free_callers = binary.direct_callers(binary.stubs["_free"]) if "_free" in binary.stubs else set()
        self.wrappers = {}
        self.revived = []
        self.heap = self.HEAP
        self.allocations = []
        self.factory = binary.factory()
        self.reads = None
        self.read_sites = None
        self.writes = None
        self.uc.hook_add(UC_HOOK_MEM_READ, self._on_read, begin=self.SOURCE, end=self.SOURCE + self.SOURCE_LIMIT)
        self.uc.hook_add(UC_HOOK_MEM_WRITE, self._on_write, begin=self.HEAP, end=self.HEAP_END)

    # C runtime and allocator replacements

    def _return(self, value=0):
        sp = self.uc.reg_read(UC_X86_REG_RSP)
        self.uc.reg_write(UC_X86_REG_RSP, sp + 8)
        self.uc.reg_write(UC_X86_REG_RAX, value)
        self.uc.reg_write(UC_X86_REG_RIP, self.qword(sp))

    def allocate(self, size):
        if size > 0x100000:
            raise ValueError("Allocation size out of range")
        pointer = (self.heap + 15) & ~15
        self.heap = pointer + max(size, 1)
        if self.heap >= self.HEAP_END:
            raise ValueError("Heap limit exceeded")
        self.uc.mem_write(pointer, bytes(max(size, 1)))
        self.allocations.append((pointer, size))
        return pointer

    def _stub(self, uc, address, _size, _user):
        name = self.stub_names.get(address)
        if name is None:
            return
        a, b, c = (uc.reg_read(register) for register in ARGUMENTS[:3])
        if name in ("_malloc", "__Znwm", "__Znam"):
            self._return(self.allocate(a))
        elif name == "_calloc":
            self._return(self.allocate(a * b))
        elif name in ("_free", "__ZdlPv", "__ZdaPv", "___cxa_atexit"):
            self._return()
        elif name in ("_bzero", "___bzero"):
            uc.mem_write(a, bytes(min(b, 0x100000)))
            self._return()
        elif name in ("_memcpy", "_memmove"):
            uc.mem_write(a, bytes(uc.mem_read(b, min(c, 0x100000))))
            self._return(a)
        elif name == "_memset":
            uc.mem_write(a, bytes((b & 255,)) * min(c, 0x100000))
            self._return(a)
        elif name == "_strlen":
            length = 0
            while uc.mem_read(a + length, 1)[0]:
                length += 1
            self._return(length)
        elif name == "___cxa_guard_acquire":
            self._return(1)
        elif name == "___cxa_guard_release":
            uc.mem_write(a, b"\1")
            self._return()
        else:
            raise ValueError("Unhandled import " + name)

    def _wrapper(self, uc, _address, _size, kind):
        if kind == "free":
            self._return()
        else:
            self._return(self.allocate(uc.reg_read(UC_X86_REG_RDI if kind == "alloc" else UC_X86_REG_RSI)))

    def _capture(self, uc, address, _size, seen):
        seen.setdefault(address, (uc.reg_read(UC_X86_REG_RDI), uc.reg_read(UC_X86_REG_RSI)))

    def _frames(self):
        """Function starts on the call chain at a fault, innermost first."""
        chain = [self.binary.function_start(self.uc.reg_read(UC_X86_REG_RIP))]
        # A frameless leaf leaves its return address on top of the stack.
        returns = [self.qword(self.uc.reg_read(UC_X86_REG_RSP))]
        frame = self.uc.reg_read(UC_X86_REG_RBP)
        for _ in range(32):
            if not self.STACK <= frame < self.STACK + self.STACK_SIZE - 16:
                break
            returns.append(self.qword(frame + 8))
            frame = self.qword(frame)
        for address in returns:
            if self.binary.in_text(address):
                start = self.binary.function_start(address)
                if start not in chain:
                    chain.append(start)
        return chain

    def _learn_wrapper(self, chain, seen):
        """Replace the allocator wrapper that led to a fault: the outermost
        function on the chain that was handed a size, either alone or after
        a heap instance inside the binary's own data."""
        outermost = [function for function in reversed(chain) if function in seen]
        data = [(va, va + size) for name, va, size, *_ in self.binary.segments if name.startswith("__DATA")]
        for function in outermost:
            first, second = seen[function]
            if 0 < first <= 0x100000:
                return self._replace(function, "alloc")
            if any(low <= first < high for low, high in data) and 0 < second <= 0x100000:
                return self._replace(function, "alloc_second")
        blocks = {pointer for pointer, _ in self.allocations} | {0}
        for function in outermost:
            if function in self.free_callers and seen[function][0] in blocks:
                return self._replace(function, "free")
        return False

    def _replace(self, function, kind):
        self.wrappers[function] = kind
        self.uc.hook_add(UC_HOOK_CODE, self._wrapper, kind, begin=function, end=function)
        return True

    # Calls

    def qword(self, address):
        return struct.unpack("<Q", self.uc.mem_read(address, 8))[0]

    def _run(self, address, args, count):
        sp = self.STACK + self.STACK_SIZE - 0x1008
        self.uc.mem_write(sp, struct.pack("<Q", self.STOP))
        self.uc.reg_write(UC_X86_REG_RSP, sp)
        self.uc.reg_write(UC_X86_REG_RBP, 0)
        for register, value in zip(ARGUMENTS, args):
            self.uc.reg_write(register, value)
        self.uc.emu_start(address, self.STOP, count=count)
        if self.uc.reg_read(UC_X86_REG_RIP) != self.STOP:
            raise ValueError("Instruction limit exceeded")
        return self.uc.reg_read(UC_X86_REG_RAX)

    def call(self, address, *args, count=3_000_000, prepare=None):
        """Call a function. `prepare` restores the memory the call starts from
        and runs again before each retry after a wrapper was learned."""
        for _ in range(16):
            state = (self.heap, len(self.allocations))
            if prepare:
                prepare()
            try:
                return self._run(address, args, count)
            except EmulationError:
                chain = [f for f in self._frames() if f != address and f not in self.wrappers]
                seen = {}
                handles = [self.uc.hook_add(UC_HOOK_CODE, self._capture, seen, begin=f, end=f) for f in chain]
                self.heap = state[0]
                del self.allocations[state[1]:]
                if prepare:
                    prepare()
                try:
                    self._run(address, args, count)
                except EmulationError:
                    pass
                for handle in handles:
                    self.uc.hook_del(handle)
                learned = self._learn_wrapper(chain, seen)
                self.heap = state[0]
                del self.allocations[state[1]:]
                if not learned:
                    raise
        raise ValueError("Allocator discovery did not converge")

    def revive_null_global(self, attempt):
        """Some readers stop unless a game singleton exists. Find the null
        pointer in the binary's data that `attempt` read last and point it
        at a block of set flags. Returns whether `attempt()` then passed."""
        ranges = [(va, va + size) for name, va, size, *_ in self.binary.segments if name.startswith("__DATA")]
        seen = []

        def on_read(uc, _access, address, size, _value, _user):
            if size == 8 and self.qword(address) == 0 and address not in seen:
                seen.append(address)

        handles = [self.uc.hook_add(UC_HOOK_MEM_READ, on_read, begin=low, end=high) for low, high in ranges]
        attempt()
        for handle in handles:
            self.uc.hook_del(handle)
        block = self.DATA + 0x60000
        self.uc.mem_write(block, bytes((1,)) * 0x1000)
        for address in reversed(seen):
            self.uc.mem_write(address, struct.pack("<Q", block))
            if attempt():
                self.revived.append(address)
                return True
            self.uc.mem_write(address, bytes(8))
        return False

    # Packets

    def construct(self, packet_id):
        """A fresh packet object, or 0 when the factory does not know the ID."""
        self.heap = self.HEAP
        self.allocations = []
        self.reads = self.writes = None
        self.uc.mem_write(self.OUT, bytes(8))
        self.call(self.factory, self.OUT, packet_id)
        return self.qword(self.OUT)

    def packet_ids(self, limit=0x800):
        """Every ID the factory builds, with object size and deserializer."""
        packets = {}
        for packet_id in range(limit):
            try:
                obj = self.construct(packet_id)
            except EmulationError:
                continue
            if obj and self.allocations and self.allocations[0][0] == obj:
                packets[packet_id] = {"size": self.allocations[0][1], "deserializer": self.qword(self.qword(obj) + 8)}
        return packets

    def _on_read(self, uc, _access, address, size, _value, _user):
        if self.reads is not None:
            site = uc.reg_read(UC_X86_REG_RIP)
            for offset in range(address - self.SOURCE, address - self.SOURCE + size):
                self.reads.append(offset)
                self.read_sites.append(site)

    def _on_write(self, uc, _access, address, size, value, _user):
        if self.writes is not None:
            self.writes.append((address, size, value & ((1 << (8 * size)) - 1), len(self.reads)))

    def deserialize(self, packet_id, data, seed=None):
        """Deserialize `data` into a fresh object and trace the call.

        Returns a Run. `seed` maps object offsets to bytes written into the
        object after construction, before the deserializer runs.
        """
        if len(data) > self.SOURCE_LIMIT - 64:
            raise ValueError("Packet too large for the input buffer")
        obj = self.construct(packet_id)
        if not obj:
            raise ValueError(f"The factory does not build packet {packet_id}")
        size = self.allocations[0][1]
        created = len(self.allocations)
        heap = self.heap

        def prepare():
            self.heap = heap
            del self.allocations[created:]
            self.uc.mem_write(self.SOURCE, bytes(data) + bytes(64))
            self.uc.mem_write(self.CURSOR, struct.pack("<Q", self.SOURCE))
            for offset, value in (seed or {}).items():
                self.uc.mem_write(obj + offset, bytes(value))
            self.reads, self.read_sites, self.writes = [], [], []

        before = bytes(self.uc.mem_read(obj, size))
        try:
            result = self.call(self.qword(self.qword(obj) + 8), obj, self.CURSOR, self.SOURCE + len(data), prepare=prepare)
            ok = bool(result & 255)
        except EmulationError:
            ok = None
        run = Run(self, obj, size, before, ok, self.qword(self.CURSOR) - self.SOURCE, self.reads, self.read_sites,
                  self.writes, self.allocations[created:])
        self.reads = self.read_sites = self.writes = None
        return run


class Run:
    """One traced deserialization."""

    def __init__(self, emulator, obj, size, before, ok, consumed, reads, read_sites, writes, allocations):
        self.emulator = emulator
        self.obj = obj
        self.size = size
        self.before = before
        self.ok = ok
        self.consumed = consumed
        self.reads = reads
        # Instruction address behind each entry of `reads`.
        self.read_sites = read_sites
        self.allocations = allocations
        self.memory = bytes(emulator.uc.mem_read(obj, size))
        # (object offset, width, value, input bytes read so far)
        self.writes = [(address - obj, width, value, count) for address, width, value, count in writes
                       if obj <= address < obj + size]
        self.heap_writes = [(address, width, value, count) for address, width, value, count in writes
                            if not obj <= address < obj + size]

    def read(self, address, size):
        return bytes(self.emulator.uc.mem_read(address, size))
