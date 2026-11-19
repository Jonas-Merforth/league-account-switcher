"""Rank new packet IDs using saved traffic and factory object sizes.

python research/rank_live_roles.py OLD_RECIPE OLD_BINARY OLD_DUMP NEW_BINARY NEW_DUMP
The scores are hints. Confirm each candidate with its native layout and a
recording before using it in a recipe. Works with outer-only new-build dumps.
"""
import argparse
import json
import math
from bisect import bisect_left
from collections import Counter
from pathlib import Path

from liveproto.emulator import Emulator
from liveproto.macho import MachO
from liveproto.probe import owner_table


def inventory(binary, dump):
    sizes = Emulator(binary).packet_ids()
    result = {}
    for key, samples in dump["payloads"].items():
        if not samples:
            continue
        direction, number = key.split(":")
        packet_id = int(number)
        # Coarse length buckets tolerate a selector or owner growing a byte.
        lengths = Counter(round(math.log2(max(1, len(s) // 2)) * 4) for s in samples)
        result[(direction, packet_id)] = (dump["counts"][key], lengths, sizes.get(packet_id, {}).get("size"))
    return result


def distance(left, right):
    n, a, size = left
    m, b, other = right
    if (size is None) != (other is None):
        return math.inf
    # Quantile distance of lengths in quarter-octaves, plus the difference
    # in traffic frequency and native object size. Match duration and mode
    # can affect frequencies, so counts only break otherwise similar ties.
    def quantiles(hist):
        ordered = sorted(hist.elements())
        return [ordered[(len(ordered) - 1) * q // 10] for q in range(11)]
    shape = sum(abs(x - y) for x, y in zip(quantiles(a), quantiles(b))) / 11
    return shape + 0.35 * abs(math.log2(n / m)) + (abs(size - other) / 8 if size else 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("recipe", "old_binary", "old_dump", "new_binary", "new_dump"):
        parser.add_argument(arg, type=Path)
    parser.add_argument("--recap", type=int, help="confirmed new recap ID; rank its companion by receive time")
    parser.add_argument("--action", type=int, help="confirmed new outgoing player action ID")
    args = parser.parse_args()
    recipe = json.loads(args.recipe.read_text())
    old_dump, new_dump = (json.loads(p.read_bytes()) for p in (args.old_dump, args.new_dump))
    old = MachO(args.old_binary)
    if old.sha256 != recipe["sha256"] or old_dump["build"] != recipe["build"]:
        parser.error("Reference build, recipe or binary mismatch")
    new = MachO(args.new_binary)
    previous = inventory(old, old_dump)
    target = inventory(new, new_dump)
    if (args.recap is None) != (args.action is None):
        parser.error("Supply --recap and --action together")
    print(f"Target recording {new_dump['build']}, binary sha256 {new.sha256}")
    for role, packet_id in recipe["ids"].items():
        direction = "out" if role == "ownerAction" else "in"
        ref = previous.get((direction, packet_id))
        if not ref:
            print(f"{role}: absent from reference recording")
            continue
        ranked = sorted((distance(ref, sample), n) for (d, n), sample in target.items() if d == direction)
        candidates = [str(n) for score, n in ranked if math.isfinite(score)]
        if role == "recapOwner" and args.recap is not None:
            times = new_dump.get("times", {})
            deaths = times.get(f"in:{args.recap}")
            if not deaths:
                parser.error("No timed samples for that recap ID. Create a fresh packet dump.")
            table = owner_table(Emulator(new), args.recap)
            def owner_prefix(hex_data):
                for i, b in enumerate(bytes.fromhex(hex_data)[:5]):
                    if table[b] < 128:
                        return hex_data[:2 * (i + 1)]
                return None
            owners = {owner_prefix(s) for s in new_dump["payloads"].get(f"out:{args.action}", [])}
            owners.discard(None)
            if len(owners) != 1:
                parser.error("Action samples do not identify a unique local owner")
            paired = []
            for key, rows in times.items():
                if not key.startswith("in:") or key == f"in:{args.recap}":
                    continue
                ordered = sorted(t for t, s in zip(rows, new_dump["payloads"][key]) if owner_prefix(s) in owners)
                hits = 0
                for t in deaths:
                    i = bisect_left(ordered, t - 2)
                    hits += i < len(ordered) and ordered[i] <= t + 2
                if hits:
                    paired.append((hits / len(deaths), hits / len(ordered), key.split(":")[1]))
            candidates = [n for _, _, n in sorted(paired, reverse=True)]
        print(f"{role:12} {', '.join(candidates[:6]) or 'no candidate'}")


if __name__ == "__main__":
    main()
