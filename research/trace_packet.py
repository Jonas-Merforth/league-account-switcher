"""Show what a packet's deserializer does for each selector value of a field.

A debugging aid for research/liveproto/probe.py: when the probe reports a
reader as unknown or opaque, this prints the raw evidence it works from.
Offline only, like describe_packets.py.

Usage:
  python research/trace_packet.py BINARY ID [--bit N ...] [--trials 2] [--data 300]

Without --bit, only the selector windows are listed. With --bit, every
value of the window that starts at that bit is run on random data and the
field's own object writes, heap blocks and heap writes are printed. Each
write is (object offset, width, value, input bytes read so far).
"""
import argparse
from pathlib import Path

from liveproto.emulator import Emulator
from liveproto.macho import MachO
from liveproto.probe import Probe, owner_table


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("binary", type=Path)
    parser.add_argument("id", type=int)
    parser.add_argument("--bit", type=int, action="append", default=[])
    parser.add_argument("--trials", type=int, default=2)
    parser.add_argument("--data", type=int, default=300)
    args = parser.parse_args()
    emulator = Emulator(MachO(args.binary))
    owner = owner_table(emulator, args.id)
    probe = Probe(emulator, args.id, owner.index(0))
    probe.count = probe.flag_bytes()
    probe.defaults = probe.all_default()
    base = probe.run(probe.defaults, probe.filler())
    probe.base_writes = probe.field_writes(base)
    print(f"selector bytes {probe.count}, all-default selectors {probe.defaults.hex()}, ok {base.ok}")
    print("default writes", [(hex(o), w, hex(v)) for o, w, v, _ in probe.base_writes])
    for group in probe.windows():
        bits = group["bits"]
        print(f"bits {bits} touch object bytes {sorted(hex(offset) for offset in group['span'])}")
        if bits[0] not in args.bit:
            continue
        for value in range(1 << len(bits)):
            flags = probe.window(probe.defaults, bits, value)
            for _ in range(args.trials):
                data = probe.filler(args.data)
                run = probe.run(flags, data)
                progress, site = probe.first_read(run)
                print(f"   value {value} data {data[:6].hex()} ok {run.ok} wire bytes {probe.data_bytes(run)} "
                      f"selector reads before {progress} reader {site or 0:#x}")
                print("      own writes", [(hex(o), w, hex(v), c) for o, w, v, c in probe.own_writes(run)][:16])
                if run.allocations or run.heap_writes:
                    print("      heap blocks", [(hex(p - run.obj), s) for p, s in run.allocations][:6],
                          "heap writes", len(run.heap_writes),
                          [(hex(a - run.obj), w, hex(v), c) for a, w, v, c in run.heap_writes][:10])


if __name__ == "__main__":
    main()
