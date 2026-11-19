"""Recover packet layouts from an official macOS game binary. Offline only.

Runs the packet factory and deserializers in Unicorn on chosen inputs. No
game process is started or inspected, and no address is written down per
build. See docs/live-protocol-automation-handoff.md for profile generation
and validation against real recordings.

Usage:
  python research/describe_packets.py BINARY --list
  python research/describe_packets.py BINARY ID [ID ...] [--recap ID] [--json OUT.json]

--list prints every packet ID the factory builds with its object size.
Otherwise each ID is probed and summarized. --json also writes the full
schemas, with complete byte tables, and the owner ID table.
"""
import argparse
import json
import time
import traceback
from pathlib import Path

from liveproto.emulator import Emulator
from liveproto.macho import MachO
from liveproto.probe import describe, owner_table
from liveproto.recap import describe_recap


def brief(reader):
    return {key: value[:12] + ".." if isinstance(value, str) and len(value) > 16 else value
            for key, value in reader.items()}


def case_label(case):
    if "read" in case:
        return f"R{case['read']}"
    if "value" in case:
        return case["value"]
    return "stored:" + case["stored"] if "stored" in case else "-"


def summarize(packet_id, schema, seconds):
    runs = f"{schema['runs']} runs, " if "runs" in schema else ""
    print(f"== packet {packet_id}: {schema['flagBytes']} selector bytes, {runs}{seconds:.1f}s")
    for field in schema["fields"]:
        where = f"+{field['object'][0]:#x}/{field['object'][1]}" if "object" in field else "no storage"
        print(f"  bits {field['bits'][0]}+{field['bits'][1]}  object {where}  cases {[case_label(c) for c in field['cases']]}")
        for reader in field.get("readers", []):
            print("      ", brief(reader))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("binary", type=Path)
    parser.add_argument("ids", type=int, nargs="*")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--json", type=Path)
    parser.add_argument("--recap", type=int, help="also probe the entry and detail records inside this recap packet ID")
    args = parser.parse_args()
    binary = MachO(args.binary)
    emulator = Emulator(binary)
    print(f"sha256 {binary.sha256}  factory {emulator.factory:#x}")
    if args.list:
        packets = emulator.packet_ids()
        print(f"{len(packets)} packet types; allocator wrappers found: "
              f"{ {hex(address): kind for address, kind in emulator.wrappers.items()} }")
        for packet_id, info in packets.items():
            print(packet_id, info["size"], hex(info["deserializer"]))
        return
    if args.recap is not None and args.recap not in args.ids:
        args.ids.append(args.recap)
    if not args.ids:
        parser.error("Give packet IDs or --list")
    owner = owner_table(emulator, args.ids[0])
    result = {"sha256": binary.sha256, "owner": bytes(owner).hex(), "packets": {}}
    for packet_id in args.ids:
        started = time.time()
        try:
            if packet_id == args.recap:
                schema, entry, detail = describe_recap(emulator, packet_id, owner)
                result["records"] = {"entry": entry, "detail": detail}
                for name, record in result["records"].items():
                    summarize(name, record, time.time() - started)
            else:
                schema = describe(emulator, packet_id, owner)
        except Exception:  # research tool: report and go on with the next ID
            traceback.print_exc()
            continue
        summarize(packet_id, schema, time.time() - started)
        result["packets"][packet_id] = schema
    if args.json:
        args.json.write_text(json.dumps(result, indent=1))
        print("wrote", args.json)
    if set(result["packets"]) != set(args.ids):
        raise SystemExit("Some requested packet layouts could not be recovered")


if __name__ == "__main__":
    main()
