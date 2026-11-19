"""Check whether a maintenance build can share a shipped live protocol.

python research/check_live_hotfix.py RECIPE PROFILE BASE_BINARY HOTFIX_BINARY METADATA LOG_BUILD
"""
import argparse
import json
import re
import subprocess
import sys
from bisect import bisect_left
from pathlib import Path
from tempfile import TemporaryDirectory

from liveproto.emulator import Emulator
from liveproto.macho import MachO
from liveproto.probe import describe, owner_table
from build_live_profile import write_profile


def json_file(path):
    return json.loads(path.read_bytes())


def inventory(emulator):
    return {packet: info["size"] for packet, info in emulator.packet_ids().items()}


def recap_owner(emulator, packet):
    owner = owner_table(emulator, packet)
    schema = describe(emulator, packet, owner)
    del schema["runs"]
    return schema


def check_recording(file, profile):
    dump = json_file(file)
    if dump["build"] != profile["build"] or not dump.get("expandedBatches"):
        raise ValueError("Expected a timed, batch-expanded dump from the exact hotfix")
    table = bytes.fromhex(profile["owner"])

    def owner(payload):
        value = 0
        for i, wire in enumerate(bytes.fromhex(payload)[:5]):
            digit = table[wire]
            value |= (digit & 127) << (7 * i)
            if digit < 128 and value <= 0xffffffff:
                return value
        raise ValueError("Invalid owner prefix in capture")

    ids = profile["ids"]
    actions = dump["payloads"][f"out:{ids['ownerAction']}"]
    players = {owner(s) for s in actions}
    if not actions or len(players) != 1 or 0 in players:
        raise ValueError("Player actions do not identify a unique local owner")
    key = f"in:{ids['recapOwner']}"
    times = dump["times"]
    updates = sorted(t for t, s in zip(times[key], dump["payloads"][key]) if owner(s) in players)
    deaths = times[f"in:{ids['recap']}"]
    for t in deaths:
        i = bisect_left(updates, t - 2)
        if i >= len(updates) or updates[i] > t + 2:
            raise ValueError("Death Recap lacks a paired local-owner update in the sampled packets")
    if not deaths:
        raise ValueError("Capture has no Death Recap samples")
    print(f"Recording: {len(actions)} sampled actions share one local owner, {len(deaths)} paired recaps.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("recipe", "profile", "base", "hotfix", "metadata"):
        parser.add_argument(arg, type=Path)
    parser.add_argument("build", help="exact four-part version from the hotfix game log")
    parser.add_argument("--candidate", type=Path, help="write the exact hotfix profile for offline replay or packet inventory")
    parser.add_argument("--dump", type=Path, action="append", default=[], help="check a timed hotfix packet dump containing a death")
    args = parser.parse_args()
    recipe, profile = json_file(args.recipe), json_file(args.profile)
    manifest = re.fullmatch(r"([0-9A-F]{16})-LeagueofLegends", args.hotfix.name)
    if manifest and args.metadata.name != f"{manifest[1]}-code-metadata.json":
        parser.error("Use metadata from the same manifest as the downloaded executable")
    compact = re.sub(r"\.(\d+)$", r"\1", args.build)
    if (not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", args.build)
            or args.build.split(".")[:2] != recipe["build"].split(".")[:2]
            or args.build == recipe["build"]
            or json_file(args.metadata)["version"].split("+")[0] != compact):
        parser.error("Requested hotfix, base patch and metadata must agree")
    base, hotfix = MachO(args.base), MachO(args.hotfix)
    if profile["build"] != recipe["build"] or base.sha256 != recipe["sha256"] or base.sha256 != profile["sha256"]:
        parser.error("Reference recipe, profile and executable must refer to the same build")
    pinned = recipe.get("hotfixes", {}).get(args.build)
    if pinned and pinned != hotfix.sha256:
        parser.error("Hotfix executable differs from its pinned SHA-256")

    old, new = Emulator(base), Emulator(hotfix)
    packets = inventory(old)
    if packets != inventory(new):
        parser.error("The packet factory inventory changed. Follow the full port workflow.")
    packet = recipe["ids"]["recapOwner"]
    if recap_owner(old, packet) != recap_owner(new, packet):
        parser.error("The recap companion layout changed")
    with TemporaryDirectory() as directory:
        source, out = (Path(directory) / name for name in ("recipe.json", "profile.json"))
        source.write_text(json.dumps({**recipe, "build": args.build, "sha256": hotfix.sha256, "hotfixes": {}}))
        subprocess.run([sys.executable, Path(__file__).with_name("build_live_profile.py"),
                        args.hotfix, source, out], check=True)
        computed = json_file(out)
    same = ("ids", "owner", "layouts", "secondaryTimestamp", "modes")
    if any(profile.get(key) != computed.get(key) for key in same):
        different = [role for role, layout in computed["layouts"].items() if profile["layouts"].get(role) != layout]
        parser.error(f"Candidate differs from the reference profile. Changed layouts: {different}")
    print(f"{len(packets)} factory IDs and sizes, owner table, recap companion and "
          f"{len(computed['layouts'])} generated layouts match.")
    for file in args.dump:
        check_recording(file, computed)
    if args.candidate:
        write_profile(computed, args.candidate)
    if not args.dump:
        print("Verify the outgoing action and recap pairing with --dump before registering the hotfix.")
    print(json.dumps({args.build: hotfix.sha256}))


if __name__ == "__main__":
    main()
