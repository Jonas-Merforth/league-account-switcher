"""Recovers a packet's wire layout by running its deserializer on chosen inputs.

Every League build regenerates its packet readers: new packet IDs, a new
order of fields, new selector bits and a new byte substitution for every
field. The generated code keeps one shape, though, and this module leans on
that shape instead of reading disassembly:

- the common header is the owner's object ID as a variable-length integer;
- a fixed number of selector bytes follows;
- every field owns a window of one to three selector bits. Each window value
  either stores a constant in the packet object or reads the field from the
  wire through its own byte substitution;
- a scalar is stored re-encoded in the object, but its plain value passes
  through the field's memory first, or the failed-read path re-encodes
  whatever the field held;
- vectors and strings land in heap blocks as plain bytes.

The result is a schema that `src/core/liveSchema.js` executes.
"""
import random

FILLER = 2048


class ProbeError(Exception):
    pass


def permutation(table):
    return all(value is not None for value in table) and len(set(table)) == 256


def varint_table(value):
    """Recover a variable-length integer's byte substitution from behavior.

    `value(data)` returns the decoded integer when `data` holds exactly one
    complete encoding, else None. The table maps a wire byte to its seven
    value bits, with bit 7 set when another byte follows.
    """
    table = [None] * 256
    for byte in range(256):
        digit = value(bytes((byte,)))
        if digit is not None:
            if digit > 127:
                raise ProbeError("A single-byte integer exceeds seven bits")
            table[byte] = digit
    if 0 not in table:
        raise ProbeError("No terminal byte decodes to zero")
    zero = table.index(0)
    for byte in range(256):
        if table[byte] is None:
            digit = value(bytes((byte, zero)))
            if digit is None or digit > 127:
                raise ProbeError("A continuation byte did not decode")
            table[byte] = digit | 128
    if not permutation(table):
        raise ProbeError("The integer substitution is not a permutation")
    return table


def encode_varint(table, value):
    """Wire bytes of `value` under a recovered substitution."""
    inverse = {digit: byte for byte, digit in enumerate(table)}
    output = bytearray()
    while True:
        digit = value & 127
        value >>= 7
        output.append(inverse[digit | (128 if value else 0)])
        if not value:
            return bytes(output)


def flip_id(value):
    """Object IDs travel with bit 30 flipped unless their low 24 bits are zero."""
    return value ^ 0x40000000 if value & 0xffffff else value


def owner_table(emulator, packet_id):
    """Byte substitution of the common owner ID, from the value the base
    reader stores at object offset 12."""
    def value(data):
        run = emulator.deserialize(packet_id, data)
        stored = [write for write in run.writes if write[0] == 12 and write[1] == 4 and write[3] == len(data)]
        return flip_id(stored[-1][2]) if stored else None

    return varint_table(value)


def middle(left, right):
    """Trim the common prefix and suffix of two write sequences."""
    key = lambda write: write[:3]
    prefix = 0
    while prefix < min(len(left), len(right)) and key(left[prefix]) == key(right[prefix]):
        prefix += 1
    suffix = 0
    while (suffix < min(len(left), len(right)) - prefix
           and key(left[len(left) - 1 - suffix]) == key(right[len(right) - 1 - suffix])):
        suffix += 1
    return left[prefix:len(left) - suffix], right[prefix:len(right) - suffix]


def span(writes):
    covered = set()
    for offset, width, _, _ in writes:
        covered.update(range(offset, offset + width))
    return covered


ORDERS = {
    "forward": lambda i, size: i,
    "reverse": lambda i, size: size - 1 - i,
    "outside-in": lambda i, size: size - 1 - (i >> 1) if i & 1 else i >> 1,
    "outside-in-back": lambda i, size: (i >> 1) if i & 1 else size - 1 - (i >> 1),
}


def order_name(positions):
    """Name the way a reader spreads consecutive wire bytes over its output."""
    for name, rule in ORDERS.items():
        if all(position == rule(index, len(positions)) for index, position in enumerate(positions)):
            return name
    return None


class Probe:
    """Recovers the layout of one packet type."""

    def __init__(self, emulator, packet_id, owner_zero):
        self.emulator = emulator
        self.packet_id = packet_id
        self.owner = bytes((owner_zero,))
        self.random = random.Random(packet_id)
        self.runs = 0

    # Running

    def run(self, flags, data=b"", seed=None):
        self.runs += 1
        return self.emulator.deserialize(self.packet_id, self.owner + bytes(flags) + bytes(data), seed)

    def filler(self, size=FILLER):
        return bytes(self.random.randrange(256) for _ in range(size))

    def run_ok(self, flags, attempts=24):
        """A run on random data that the reader accepts, else the last try."""
        for _ in range(attempts):
            run = self.run(flags, self.filler())
            if run.ok:
                break
        return run

    def field_writes(self, run):
        """Object writes by field readers, without the base reader's owner."""
        return [write for write in run.writes if write[3] > len(self.owner)]

    def first_read(self, run):
        """(selector reads before the first wire read, its instruction), or
        (None, None) when no field read from the wire."""
        start = len(self.owner) + self.count
        progress = 0
        for offset, site in zip(run.reads, run.read_sites):
            if offset >= start:
                return progress, site
            if offset >= len(self.owner):
                progress += 1
        return None, None

    def data_bytes(self, run):
        return run.consumed - len(self.owner) - self.count

    def own_writes(self, run):
        """What the one reading field wrote. A failed run stops inside it.
        A write that happens to equal the default run's write of the same
        field still belongs to it, so neighbors on the same bytes are kept."""
        writes = self.field_writes(run)
        prefix = 0
        while (prefix < min(len(writes), len(self.base_writes))
               and writes[prefix][:3] == self.base_writes[prefix][:3]):
            prefix += 1
        if not run.ok:
            return writes[prefix:]
        end = prefix + len(middle(self.base_writes, writes)[1])
        if end <= prefix:
            return []
        covered = span(writes[prefix:end])
        while end < len(writes) and span(writes[end:end + 1]) & covered:
            end += 1
        while prefix and span(writes[prefix - 1:prefix]) & covered:
            prefix -= 1
        return writes[prefix:end]

    # Selector bytes and windows

    def flag_bytes(self):
        """The reader checks that all selector bytes are present before it
        looks at the first one."""
        start = len(self.owner)
        for count in range(0, 17):
            run = self.run(bytes(count))
            if any(offset >= start for offset in run.reads):
                return count
            if count == 0 and run.ok:
                # Might hold no fields at all. A wanted selector byte would be read.
                wider = self.run(bytes(1))
                if wider.ok and not any(offset >= start for offset in wider.reads):
                    return 0
        raise ProbeError("No selector bytes found")

    def flip(self, flags, bits):
        flipped = bytearray(flags)
        for bit in bits:
            flipped[bit >> 3] ^= 1 << (bit & 7)
        return bytes(flipped)

    def window(self, flags, bits, value):
        result = bytearray(flags)
        for index, bit in enumerate(bits):
            if value >> index & 1:
                result[bit >> 3] |= 1 << (bit & 7)
            else:
                result[bit >> 3] &= ~(1 << (bit & 7))
        return bytes(result)

    def all_default(self):
        """Selector bytes with which no field reads from the wire."""
        flags = bytes(self.count)
        bits = range(self.count * 8)
        candidates = [(bit,) for bit in bits]
        candidates += [(a, b) for a in bits for b in bits if a < b <= a + 2]
        candidates += [(a, a + 1, a + 2) for a in bits if a + 2 < self.count * 8]
        data = self.filler()
        for _ in range(self.count * 8 + 1):
            run = self.run(flags, data)
            progress, _ = self.first_read(run)
            if progress is None:
                if not run.ok:
                    raise ProbeError("The reader fails without reading a field")
                return flags
            blocked = []
            for flips in candidates:
                trial = self.flip(flags, flips)
                other = self.run(trial, data)
                further, _ = self.first_read(other)
                if further is None and not other.ok:
                    blocked.append(trial)
                if (further is None and other.ok) or (further is not None and further > progress):
                    flags = trial
                    break
            else:
                # A default can reach a game singleton before the first wire read.
                # Retry those paths in the same emulated environment used by windows().
                for trial in blocked:
                    if self.emulator.revive_null_global(lambda: bool(self.run(trial, data).ok)):
                        flags = trial
                        break
                else:
                    raise ProbeError("A field reads from the wire for every selector value")
        raise ProbeError("Could not find selectors without wire fields")

    def windows(self):
        """Group selector bits into fields: flips that start the same reader
        or touch overlapping object bytes select the same field."""
        effects = {}
        for bit in range(self.count * 8):
            flags = self.flip(self.defaults, (bit,))
            run = self.run_ok(flags)
            progress, site = self.first_read(run)
            if not run.ok and progress is None:
                data = self.filler()

                def revived():
                    again = self.run(flags, data)
                    return again.ok or self.first_read(again)[0] is not None

                if self.emulator.revive_null_global(revived):
                    self.base_writes = self.field_writes(self.run(self.defaults, self.filler()))
                    run = self.run_ok(flags)
                    progress, site = self.first_read(run)
            if run.ok:
                before, after = middle(self.base_writes, self.field_writes(run))
                touched = span(before) | span(after)
            else:
                touched = span(self.own_writes(run))
            if touched or progress is not None:
                effects[bit] = {"span": touched, "progress": progress, "site": site, "flags": flags}
        groups = []
        for bit, effect in sorted(effects.items()):
            for group in groups:
                same_reader = effect["progress"] is not None and effect["progress"] in group["progress"]
                if same_reader or group["span"] & effect["span"]:
                    group["bits"].append(bit)
                    group["span"] |= effect["span"]
                    group["progress"].add(effect["progress"])
                    break
            else:
                groups.append({"bits": [bit], "span": set(effect["span"]), "progress": {effect["progress"]}})
        # A bit may only swap one reader for an equivalent one, or one silent
        # default for another. It shows once a neighbor makes the field read.
        data = self.filler()
        for bit in range(self.count * 8):
            if bit in effects:
                continue
            for group in groups:
                if bit not in (min(group["bits"]) - 1, max(group["bits"]) + 1) or len(group["bits"]) >= 3:
                    continue
                for member in list(group["bits"]):
                    effect = effects.get(member)
                    if not effect or effect["progress"] is None:
                        continue
                    here = self.first_read(self.run(effect["flags"], data))
                    there = self.first_read(self.run(self.flip(effect["flags"], (bit,)), data))
                    if here != there:
                        group["bits"].append(bit)
                        break
                if bit in group["bits"]:
                    break
        for group in groups:
            group["bits"].sort()
            bits = group["bits"]
            if bits != list(range(bits[0], bits[0] + len(bits))) or len(bits) > 3:
                raise ProbeError(f"Selector bits {bits} do not form one window")
        return groups

    # Fields

    def describe(self):
        self.count = self.flag_bytes()
        schema = {"flagBytes": self.count, "fields": []}
        if self.count == 0:
            return schema
        self.defaults = self.all_default()
        self.base_writes = self.field_writes(self.run(self.defaults, self.filler()))
        fields = []
        for group in self.windows():
            field = self.field(group["bits"])
            if field:
                fields.append(field)
        # Wire order: fields that read later see more selector reads first.
        fields.sort(key=lambda field: (field.pop("progress"), field["bits"][0]))
        schema["fields"] = fields
        return schema

    def field(self, bits):
        cases = []
        progress = None
        storage = set()
        for value in range(1 << len(bits)):
            flags = self.window(self.defaults, bits, value)
            run = self.run_ok(flags)
            start, _ = self.first_read(run)
            if start is None:
                before, after = middle(self.base_writes, self.field_writes(run))
                storage |= span(after) | span(before)
                cases.append({"flags": flags})
            else:
                progress = start
                storage |= span(self.own_writes(run))
                cases.append({"flags": flags, "reads": True})
        if not storage and progress is None:
            return None
        field = {"bits": [bits[0], len(bits)], "progress": progress if progress is not None else 1 << 30}
        # Readers that behave alike on the same random input share one description.
        samples = [self.filler(512) for _ in range(8)]
        readers = []
        for case in cases:
            if "reads" not in case:
                continue
            behavior = []
            for sample in samples:
                run = self.run(case["flags"], sample)
                behavior.append((run.ok, run.consumed, tuple(write[:3] for write in self.own_writes(run)),
                                 tuple(size for _, size in run.allocations)))
            for index, reader in enumerate(readers):
                if reader["behavior"] == behavior:
                    case["reader"] = index
                    break
            else:
                case["reader"] = len(readers)
                readers.append({"behavior": behavior, "flags": case["flags"]})
        field["readers"] = []
        rest = None
        for reader in readers:
            try:
                described, learned = self.reader(reader["flags"])
            except ProbeError as error:
                described, learned = {"kind": "unknown", "error": str(error)}, None
            field["readers"].append(described)
            if learned:
                storage |= set(learned["span"])
                rest = rest or learned.get("rest")
        if storage:
            field["object"] = [min(storage), max(storage) + 1 - min(storage)]
        field["cases"] = []
        for case in cases:
            if "reader" in case:
                field["cases"].append({"read": case["reader"]})
            else:
                field["cases"].append(self.default(case, storage, rest))
        self.normalize_scalar(field)
        return field

    @staticmethod
    def normalize_scalar(field):
        """Four scalar defaults identify float storage order independently
        of the order in which wire bytes arrive."""
        readers = field["readers"]
        if not readers or not all(r["kind"] == "fixed" and r["size"] == 4 and "order" in r for r in readers):
            return
        values = {case["value"] for case in field["cases"] if "value" in case}
        little = {"00000000", "0000803f", "00000040", "000080bf"}
        big = {bytes.fromhex(v)[::-1].hex() for v in little}
        if values not in (little, big):
            return
        field["type"] = "float"
        if values == big:
            for reader in readers:
                reader["order"] = [3 - pos for pos in reader["order"]]
            for case in field["cases"]:
                if "value" in case:
                    case["value"] = bytes.fromhex(case["value"])[::-1].hex()

    def default(self, case, storage, rest):
        """A selector value without a wire field: the constant it stores.
        `value` is the plain constant when the stored encoding is known."""
        if not storage:
            return {}
        low, high = min(storage), max(storage) + 1
        stored = self.run(case["flags"]).memory[low:high]
        entry = {"stored": stored.hex()}
        if rest and len(rest["tables"]) == high - low:
            plain = [None] * (high - low)
            for index, (table, source) in enumerate(zip(rest["tables"], rest["source"])):
                if stored[index] in table:
                    plain[source] = table.index(stored[index])
            if None not in plain:
                entry["value"] = bytes(plain).hex()
        return entry

    # Readers

    def reader(self, flags):
        """Describe the reader behind one selector value. Returns the schema
        entry and what was learned about how the field is stored."""
        runs = [self.run(flags, self.filler()) for _ in range(16)]
        good = [run for run in runs if run.ok]
        if any(len(run.heap_writes) for run in runs):
            widths = {width for run in good for _, width, _, _ in run.heap_writes}
            return (self.blob(flags) if widths <= {1} else self.varints(flags, max(widths))), None
        if not good:
            # A validated one-byte field accepts few values. Look for one.
            tries = (self.run(flags, bytes((value,)) + self.filler(8)) for value in range(256))
            good = [run for run in tries if run.ok]
            if not good:
                raise ProbeError("The reader rejected every input")
        sizes = {self.data_bytes(run) for run in good}
        if len(sizes) == 1:
            size = sizes.pop()
            try:
                return self.fixed(flags, size)
            except ProbeError as error:
                # Enough to step over the field: its size never changes.
                covered = span(self.own_writes(good[0]))
                return ({"kind": "fixed", "size": size, "opaque": str(error)},
                        {"span": range(min(covered), max(covered) + 1)} if covered else None)
        try:
            return self.varint(flags)
        except ProbeError as error:
            return self.varint_opaque(flags, str(error))

    def plain(self, run):
        """The field's plain bytes: its memory just before the final
        re-encoding, which rewrites every byte once after the last read."""
        writes = self.own_writes(run)
        if not writes:
            return None, None, None
        covered = span(writes)
        low, high = min(covered), max(covered) + 1
        total = max(write[3] for write in writes)
        encoded = set()
        cut = len(writes)
        while cut:
            offset, width, _, count = writes[cut - 1]
            bytes_ = set(range(offset, offset + width))
            if count != total or bytes_ & encoded:
                break
            encoded |= bytes_
            cut -= 1
        if encoded != set(range(low, high)):
            return None, low, high
        memory = {}
        for offset, width, value, _ in writes[:cut]:
            for index in range(width):
                memory[offset + index] = value >> (8 * index) & 255
        if set(memory) != encoded:
            return None, low, high
        return bytes(memory[offset] for offset in range(low, high)), low, high

    def rest(self, flags, encode, low, high):
        """How the field is stored at rest: for each stored byte the plain
        byte it comes from and that byte's substitution. `encode` turns
        chosen plain bytes into wire bytes."""
        width = high - low
        base = bytes((1,)) * width
        reference = self.run(flags, encode(base))
        if self.plain(reference)[0] != base:
            raise ProbeError("Chosen plain bytes did not reach the field")
        tables = [None] * width
        source = [None] * width
        for index in range(width):
            table = [None] * 256
            target = None
            for value in range(256):
                plain = bytearray(base)
                plain[index] = value
                run = self.run(flags, encode(bytes(plain)))
                if not run.ok or self.plain(run)[0] != bytes(plain):
                    raise ProbeError("Chosen plain bytes did not reach the field")
                stored = run.memory[low:high]
                changed = [i for i in range(width) if stored[i] != reference.memory[low + i]]
                if len(changed) > 1:
                    raise ProbeError("One plain byte changed several stored bytes")
                if changed:
                    target = changed[0] if target is None else target
                table[value] = stored
            if target is None or tables[target] is not None:
                raise ProbeError("Plain bytes do not map onto stored bytes one to one")
            tables[target] = [entry[target] for entry in table]
            source[target] = index
            if not permutation(tables[target]):
                raise ProbeError("The stored encoding is not a substitution")
        return {"tables": tables, "source": source}

    def fixed(self, flags, size):
        """A field of `size` wire bytes, each substituted on its own."""
        base = bytearray(self.filler(size))
        plain, low, high = self.plain(self.run(flags, bytes(base)))
        if plain is None:
            return self.fixed_hidden(flags, size, low, high)
        tables, order = [], []
        for position in range(size):
            table = [None] * 256
            target = None
            for value in range(256):
                data = bytearray(base)
                data[position] = value
                run = self.run(flags, bytes(data))
                current = self.plain(run)[0]
                if current is None or not run.ok:
                    raise ProbeError("A fixed-size reader hid its plain value")
                changed = [index for index in range(len(plain)) if current[index] != plain[index]]
                if len(changed) > 1:
                    raise ProbeError("One wire byte changed several plain bytes")
                if changed:
                    target = changed[0] if target is None else target
                table[value] = current
            if target is None:
                raise ProbeError("A wire byte does not reach the field")
            order.append(target)
            tables.append([entry[target] for entry in table])
        if any(not permutation(table) for table in tables) or sorted(order) != list(range(size)):
            raise ProbeError("A fixed-size reader is not a byte-wise substitution")
        reader = {"kind": "fixed", "size": size, "order": order}
        if all(table == tables[0] for table in tables):
            reader["table"] = bytes(tables[0]).hex()
        else:
            reader["tables"] = [bytes(table).hex() for table in tables]

        def encode(wanted):
            return bytes(tables[position].index(wanted[order[position]]) for position in range(size))

        return reader, {"span": range(low, high), "rest": self.rest(flags, encode, low, high)}

    def fixed_hidden(self, flags, size, low, high):
        """A reader whose plain value never reaches memory, as for one-byte
        fields. When the wire bytes are missing, the reader re-encodes what
        the field held, which gives the stored encoding to undo."""
        if low is None or size != high - low:
            raise ProbeError("A hidden fixed-size field does not map bytes one to one")
        rests = []
        for offset in range(low, high):
            table = [self.run(flags, b"", seed={offset: bytes((value,))}).memory[offset] for value in range(256)]
            if not permutation(table):
                raise ProbeError("The failed-read path is not a substitution")
            rests.append(table)
        base = bytearray(self.filler(size))
        reference = self.run(flags, bytes(base)).memory[low:high]
        tables, order = [], []
        for position in range(size):
            stored = []
            target = None
            for value in range(256):
                data = bytearray(base)
                data[position] = value
                run = self.run(flags, bytes(data))
                current = run.memory[low:high]
                changed = [index for index in range(size) if current[index] != reference[index]]
                if len(changed) > 1 or not run.ok:
                    raise ProbeError("One wire byte changed several stored bytes")
                if changed:
                    target = changed[0] if target is None else target
                stored.append(current)
            if target is None:
                raise ProbeError("A wire byte does not reach the field")
            order.append(target)
            tables.append([rests[target].index(entry[target]) for entry in stored])
        if any(not permutation(table) for table in tables):
            raise ProbeError("A fixed-size substitution is not a permutation")
        reader = {"kind": "fixed", "size": size, "order": order}
        if all(table == tables[0] for table in tables):
            reader["table"] = bytes(tables[0]).hex()
        else:
            reader["tables"] = [bytes(table).hex() for table in tables]
        return reader, {"span": range(low, high), "rest": {"tables": rests, "source": list(range(size))}}

    def varint(self, flags):
        """A variable-length integer stored in a two- or four-byte field."""
        info = {}
        fillers = [self.filler(16), self.filler(16)]

        def raw(data):
            # A complete encoding stops by itself, whatever follows it. The
            # last field of a packet may also stop at the end of the input.
            seen = set()
            for filler in fillers:
                run = self.run(flags, data + filler)
                if not run.ok or self.data_bytes(run) != len(data):
                    return None
                plain, low, high = self.plain(run)
                if plain is None:
                    raise ProbeError("A variable-length reader hid its plain value")
                info["span"] = range(low, high)
                seen.add(int.from_bytes(plain, "little"))
            return seen.pop() if len(seen) == 1 else None

        # An object ID flips bit 30, which a seven-bit digit cannot hold.
        single = [raw(bytes((byte,))) for byte in range(256)]
        object_id = any(digit is not None and digit > 127 for digit in single)

        def value(data):
            stored = raw(data)
            return flip_id(stored) if object_id and stored is not None else stored

        table = varint_table(value)
        width = len(info["span"])
        reader = {"kind": "varint", "table": bytes(table).hex(), "width": width}
        if object_id:
            reader["objectId"] = True

        def encode(wanted):
            number = int.from_bytes(wanted, "little")
            return encode_varint(table, flip_id(number) if object_id else number) + fillers[0]

        low = info["span"][0]
        return reader, {"span": info["span"], "rest": self.rest(flags, encode, low, low + width)}

    def varint_opaque(self, flags, reason):
        """An integer whose value stays hidden. Which bytes continue it is
        still visible, and that is all a reader needs to step over it."""
        fillers = [self.filler(16), self.filler(16)]
        table = []
        for byte in range(256):
            ends = [self.run(flags, bytes((byte,)) + filler) for filler in fillers]
            table.append(0 if all(run.ok and self.data_bytes(run) == 1 for run in ends) else 128)
        if table.count(0) != 128:
            raise ProbeError(reason)
        covered = span(self.own_writes(self.run_ok(flags)))
        if covered:
            low, high = min(covered), max(covered) + 1
            if high - low in (2, 4):
                hidden = self.hidden_digits(flags, table, low, high)
                if hidden:
                    return hidden, {"span": range(low, high)}
        return ({"kind": "varint", "table": bytes(table).hex(), "opaque": reason},
                {"span": range(min(covered), max(covered) + 1)} if covered else None)

    def hidden_digits(self, flags, continuation, low, high):
        """Some optional integers write only substituted result bytes. A
        leading zero digit shifts d left by seven, exposing encoded d//2
        in the next byte and its parity in the low byte."""
        def stored(data):
            run = self.run(flags, bytes(data))
            return run.memory[low:high] if run.ok and self.data_bytes(run) == len(data) else b""

        singles = {i: stored([i]) for i in range(256) if not continuation[i]}
        zeros = [i for i, data in singles.items() if data and len(set(data)) == 1]
        if len(zeros) != 1:
            return None
        zero = zeros[0]
        zero_byte = singles[zero][0]
        pairs = {i: stored([i, zero]) for i in range(256) if continuation[i]}
        leads = [i for i, data in pairs.items() if data == singles[zero]]
        if len(leads) != 1:
            return None
        padded = {i: stored([leads[0], i]) for i in singles}
        digits = {zero_byte: 0}
        for _ in range(7):
            for i, value in singles.items():
                shifted = padded[i]
                if value and len(shifted) >= 2 and shifted[1] in digits:
                    digits[value[0]] = 2 * digits[shifted[1]] + int(shifted[0] != zero_byte)
        if set(digits.values()) != set(range(128)):
            return None
        table = []
        for i in range(256):
            raw = pairs[i] if continuation[i] else singles[i]
            if not raw or raw[0] not in digits or any(b != zero_byte for b in raw[1:]):
                return None
            table.append(digits[raw[0]] | continuation[i])
        if permutation(table):
            return {"kind": "varint", "width": high - low, "table": bytes(table).hex()}
        return None

    def varints(self, flags, width):
        """A counted list of variable-length integers in a heap block."""
        fillers = [self.filler(), self.filler(), self.filler()]

        def count(data):
            seen = set()
            for filler in fillers:
                run = self.run(flags, data + filler)
                if run.ok and not run.allocations and self.data_bytes(run) == len(data):
                    seen.add(0)
                    continue
                if not run.ok or not run.allocations:
                    return None
                seen.add(run.allocations[-1][1] // width)
            return seen.pop() if len(seen) == 1 else None

        counts = varint_table(count)
        one = bytes((counts.index(1),))

        def element(data):
            seen = set()
            for filler in fillers[:2]:
                run = self.run(flags, one + data + filler)
                if not run.ok or self.data_bytes(run) != 1 + len(data) or not run.allocations:
                    return None
                seen.add(int.from_bytes(run.read(run.allocations[-1][0], width), "little"))
            return seen.pop() if len(seen) == 1 else None

        table = varint_table(element)
        # Where consecutive elements land.
        size = 5
        body = bytes(table.index(digit) for digit in range(1, size + 1))
        run = self.run(flags, bytes((counts.index(size),)) + body)
        if not run.ok or not run.allocations:
            raise ProbeError("An integer list did not decode")
        block = run.read(run.allocations[-1][0], size * width)
        values = [int.from_bytes(block[index * width:index * width + width], "little") for index in range(size)]
        order = order_name([values.index(digit) for digit in range(1, size + 1)])
        if order is None:
            raise ProbeError("Unknown integer list order")
        return {"kind": "varints", "count": bytes(counts).hex(), "table": bytes(table).hex(), "width": width, "order": order}

    def blob(self, flags):
        """A length-prefixed byte vector or string in a heap block."""
        fillers = [self.filler(), self.filler(), self.filler()]

        def length(data):
            # A complete length consumes the same count whatever follows it.
            seen = set()
            for filler in fillers:
                run = self.run(flags, data + filler)
                if not run.ok:
                    return None
                seen.add(self.data_bytes(run) - len(data))
            return seen.pop() if len(seen) == 1 and min(seen) >= 0 else None

        table = varint_table(length)
        terminal = {digit: byte for byte, digit in enumerate(table) if digit < 128}
        content = [None] * 256
        orders = {}
        values = self.random.sample(range(256), 256)
        for body in (bytes(values[:5]), *(bytes(values[start:start + 64]) for start in range(0, 256, 64))):
            size = len(body)
            run = self.run(flags, bytes((terminal[size],)) + body)
            if not run.ok or self.data_bytes(run) != size + 1:
                raise ProbeError("A byte vector did not consume its length")
            block = next((pointer for pointer, allocated in reversed(run.allocations) if allocated >= size), None)
            if block is None:
                raise ProbeError("A byte vector left no heap block of its length")
            writes = [(address - block, value) for address, width, value, _ in run.heap_writes
                      if width == 1 and block <= address < block + size][-size:]
            if len(writes) != size or len({position for position, _ in writes}) != size:
                raise ProbeError("A byte vector was not written one byte at a time")
            for index, (_, value) in enumerate(writes):
                if content[body[index]] not in (None, value):
                    raise ProbeError("A byte vector substitution depends on position")
                content[body[index]] = value
            orders.setdefault(size, order_name([position for position, _ in writes]))
        if not permutation(content):
            raise ProbeError("A byte vector substitution is not a permutation")
        names = set(orders.values())
        if len(names) != 1 or None in names:
            raise ProbeError(f"Unknown byte order {orders}")
        return {"kind": "bytes", "length": bytes(table).hex(), "table": bytes(content).hex(), "order": names.pop()}


def describe(emulator, packet_id, owner):
    """The schema of one packet type. `owner` is the owner ID substitution."""
    probe = Probe(emulator, packet_id, owner.index(0))
    schema = probe.describe()
    schema["runs"] = probe.runs
    return schema
