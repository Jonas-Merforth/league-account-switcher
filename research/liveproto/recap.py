"""Describe the two levels of records inside Death Recap, using the same
selector and scalar probe as the outer packet. Identify the element reader
by its first selector read after a count of one."""
from .probe import Probe, ProbeError, varint_table


class StructProbe(Probe):
    def __init__(self, parent, address, template):
        super().__init__(parent.emulator, parent.packet_id, 0)
        self.owner = b""
        self.address = address
        self.template = template

    def run(self, flags, data=b"", seed=None):
        self.runs += 1
        return self.emulator.deserialize_struct(self.address, self.template, bytes(flags) + bytes(data), seed)


def reader_flags(probe, field):
    start, width = field["bits"]
    active = [i for i, c in enumerate(field["cases"]) if "read" in c]
    if width != 1 or len(active) != 1:
        raise ProbeError("Expected an optional recap field")
    return probe.window(probe.defaults, [start], active[0])


def next_function(probe, run, cursor):
    site = next((site for offset, site in zip(run.reads, run.read_sites) if offset >= cursor), None)
    if site is None:
        raise ProbeError("No element selector was read")
    return probe.emulator.binary.function_start(site)


def collection(probe, flags):
    start = len(probe.owner) + probe.count
    # Enough bytes to let the parent reserve up to 127 elements even when
    # the trailing test bytes are not valid records. Only the first
    # allocation and the writes that install it belong to the count.
    suffix = bytes(1024)
    def allocation(prefix):
        run = probe.run(flags, prefix + suffix)
        if not run.allocations:
            return (0, None, run) if run.ok and probe.data_bytes(run) == len(prefix) else None
        pointer, size = run.allocations[0]
        for _, width, value, reads in run.writes:
            if width != 8 or value != pointer:
                continue
            consumed = max(run.reads[:reads], default=-1) + 1 - start
            if consumed != len(prefix):
                return None
            counts = {v for _, w, v, at in run.writes if at == reads and w == 4}
            if len(counts) == 1:
                n = counts.pop()
                if n > 0 and size % n == 0:
                    return n, size // n, run
        return None

    sizes = set()
    def value(prefix):
        result = allocation(prefix)
        if result is None:
            return None
        n, size, _ = result
        if size is not None:
            sizes.add(size)
        return n

    table = varint_table(value)
    if len(sizes) != 1:
        raise ProbeError("Element stride varies with count")
    one = bytes([table.index(1)])
    run = allocation(one)[2]
    cursor = start + len(one)
    address = next_function(probe, run, cursor)
    template = probe.emulator.struct_template(address, sizes.pop(), lambda: probe.run(flags, one + suffix), cursor)
    return bytes(table).hex(), StructProbe(probe, address, template)


def unresolved(schema):
    return [f for f in schema["fields"] if any(r["kind"] == "unknown" for r in f["readers"])]


def describe_recap(emulator, packet_id, owner):
    parent = Probe(emulator, packet_id, owner.index(0))
    root = parent.describe()
    missing = unresolved(root)
    if len(missing) != 2:
        raise ProbeError("Expected a counted entry list and an inline outgoing entry")
    for field in missing:
        try:
            count, entry_probe = collection(parent, reader_flags(parent, field))
            break
        except ProbeError:
            continue
    else:
        raise ProbeError("No counted recap entry list found")
    field["readers"] = [{"kind": "structs", "count": count, "layout": "entry"}]
    other = next(f for f in missing if f is not field)
    inline_flags = reader_flags(parent, other)
    cursor = len(parent.owner) + parent.count
    run = parent.run(inline_flags, bytes(256))
    if next_function(parent, run, cursor) != entry_probe.address:
        raise ProbeError("Outgoing and list entry readers differ")
    other["readers"] = [{"kind": "struct", "layout": "entry"}]
    entry = entry_probe.describe()
    (details,) = unresolved(entry)
    count, detail_probe = collection(entry_probe, reader_flags(entry_probe, details))
    details["readers"] = [{"kind": "structs", "count": count, "layout": "detail"}]
    detail = detail_probe.describe()
    if unresolved(detail):
        raise ProbeError("Incomplete recap detail schema")
    return root, entry, detail
