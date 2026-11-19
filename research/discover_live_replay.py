"""Identify observer framing, packet IDs and field bindings from one full replay."""
import argparse
import itertools
import json
import subprocess
from pathlib import Path

from build_live_profile import bind, shape, write_profile
from discover_live_client import discover_client
from liveproto.emulator import Emulator
from liveproto.macho import MachO
from liveproto.probe import Probe, ProbeError, describe, owner_table


def node(program, replay, profile=None, check=True):
    return subprocess.run(["node", Path(__file__).with_name(program), replay], text=True,
                          input=json.dumps(profile) if profile else None, capture_output=True, check=check)


def layouts(emulator, owner, role, candidates):
    # These selector counts and field shapes survived the known field shuffles.
    # A changed shape needs inspection. Never use a traffic ranking as an ID.
    selectors = {"heroStats": 1, "heroSpawn": 6, "display": 4}
    matches = {}
    for packet in candidates:
        probe = Probe(emulator, packet, owner.index(0))
        try:
            if probe.flag_bytes() != selectors[role]:
                continue
            if role == "display":
                probe.count = selectors[role]
                probe.defaults = probe.all_default()
                probe.base_writes = probe.field_writes(probe.run(probe.defaults, probe.filler()))
                widths = sorted(len(group["bits"]) for group in probe.windows())
                # Some padding bits also cause a native write and form an extra window.
                if widths.count(3) < 9:
                    continue
            schema = describe(emulator, packet, owner)
            kinds = [set(shape(f, r) for r in f["readers"]) for f in schema["fields"]]
            if role == "display" and (kinds.count({"id"}) < 2 or {"float"} not in kinds or {"u8"} not in kinds):
                continue
            if role == "heroSpawn" and (kinds.count({"id"}) != 1 or {"bytes"} not in kinds):
                continue
            matches[packet] = bind(role, schema, {}, candidates=role != "heroStats")
        except (ProbeError, ValueError):
            continue
    return matches


def discover(binary, replay, build):
    process = node("replayRoleCandidates.mjs", replay, check=False)
    if process.returncode:
        raise ValueError(process.stderr.strip())
    inventory = json.loads(process.stdout)
    if inventory["build"] != build:
        raise ValueError(f"Replay build {inventory['build']} differs from the binary build {build}")
    emulator = Emulator(binary)
    roles = ("heroStats", "heroSpawn", "display")
    answers = []
    rejected = []
    for stats in inventory["heroStats"]:
        owner = owner_table(emulator, stats)
        candidates = {role: layouts(emulator, owner, role, [stats] if role == "heroStats" else inventory[role])
                      for role in roles}
        for combination in itertools.product(*(candidates[role] for role in roles)):
            ids = dict(zip(roles, combination))
            profile = {"build": build, "sha256": binary.sha256, "secondaryTimestamp": inventory["secondaryTimestamp"],
                       "ids": ids, "owner": bytes(owner).hex(),
                       "layouts": {role: candidates[role][packet] for role, packet in ids.items()}}
            result = node("inferLiveBindings.mjs", replay, profile, check=False)
            if result.returncode:
                rejected.append(result.stderr.strip())
                continue
            offsets = json.loads(result.stdout)
            answers.append({key: profile[key] for key in ("build", "sha256", "secondaryTimestamp", "ids")}
                           | {"offsets": offsets})
    if len(answers) != 1:
        detail = rejected[0] if rejected else "Check native field shapes and the replay inventory."
        raise ValueError(f"Expected one replay-verified role assignment, found {len(answers)}. {detail}")
    return answers[0]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("binary", "replay", "output"):
        parser.add_argument(arg, type=Path)
    parser.add_argument("--metadata", type=Path, help="matching official code-metadata.json, defaults to the binary's manifest")
    parser.add_argument("--recording", type=Path, help="also discover client packet IDs from a raw Damage recording")
    parser.add_argument("--rift-frames", type=Path, help="also identify tower fields from a native scoreboard keyframe corpus")
    parser.add_argument("--recap-evidence", type=Path, help="labeled Death Recap observations from --recording")
    args = parser.parse_args()
    if args.recap_evidence and not args.recording:
        parser.error("--recap-evidence requires --recording")
    metadata = args.metadata or args.binary.with_name(args.binary.name.removesuffix("-LeagueofLegends") + "-code-metadata.json")
    build = json.loads(metadata.read_bytes())["version"].split("+")[0]
    # The manifest version joins the final two components; only the log/replay stores the split.
    with args.replay.open("rb") as stream:
        header = stream.read(15)
        if header[:4] != b"RIOT" or len(header) != 15:
            parser.error("Invalid replay header")
        version = stream.read(header[14]).decode("ascii")
    parts = version.split(".")
    if len(parts) != 4 or not all(part.isdigit() for part in parts) or ".".join(parts[:2] + ["".join(parts[2:])]) != build:
        parser.error("Replay and official binary metadata versions differ")
    binary = MachO(args.binary)
    result = discover(binary, args.replay, version)
    if args.recording:
        discover_client(binary, result, args.recording, args.recap_evidence)
    if args.rift_frames:
        from discover_live_turrets import discover_turrets
        discover_turrets(binary, result, args.rift_frames)
    write_profile(result, args.output)
    print(json.dumps(result, indent=2))
