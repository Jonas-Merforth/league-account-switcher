"""Resolve client role IDs by native field shape and decoding recorded samples."""
import json
import subprocess
from collections import Counter
from bisect import bisect_left
from pathlib import Path
from tempfile import TemporaryDirectory

from build_live_profile import bind, write_profile
from liveproto.emulator import Emulator
from liveproto.probe import Probe, ProbeError, describe, owner_table
from liveproto.recap import describe_recap


# Native object sizes allow one alignment group on either side of the
# sizes seen on 16.22/23. A changed shape goes back to the ranked workflow.
# Each proposed role must also pass a different check on real client data.
SHAPES = {
    "batch": (1, [1, 1], 40, 56),
    "combat": (1, [1, 3, 3], 32, 56),
    "marker": (1, [3, 3], 16, 32),
    "replication": (2, [1, 3, 3, 3], 40, 56),
    "recap": (3, [1, 1, 3, 3, 3, 3, 3], 96, 112),
}


def find_role(role, dump, emulator, owner, factory):
    count, widths, low, high = SHAPES[role]
    matches = {}
    for key, samples in dump["payloads"].items():
        direction, packet_id = key.split(":")
        packet = int(packet_id)
        if direction != "in" or len(samples) < 2 or not low <= factory.get(packet, {}).get("size", 0) <= high:
            continue
        probe = Probe(emulator, packet, owner.index(0))
        try:
            if probe.flag_bytes() != count:
                continue
            probe.count = count
            probe.defaults = probe.all_default()
            probe.base_writes = probe.field_writes(probe.run(probe.defaults, probe.filler()))
            observed = Counter(len(group["bits"]) for group in probe.windows())
            if not Counter(widths) <= observed:
                continue
            if role == "recap":
                schemas = describe_recap(emulator, packet, owner)
                layouts = {name: bind(name, schema, {}, candidates=True)
                           for name, schema in zip(("recap", "entry", "detail"), schemas)}
            else:
                layouts = {role: bind(role, describe(emulator, packet, owner), {})}
        except (ProbeError, ValueError):
            continue
        profile = {"partial": True, "build": dump["build"], "ids": {role: packet},
                   "layouts": layouts, "owner": bytes(owner).hex()}
        result = subprocess.run(["node", Path(__file__).with_name("checkLiveRoleSamples.mjs")],
                                input=json.dumps({"role": role, "profile": profile, "samples": samples}),
                                text=True, capture_output=True)
        if result.returncode == 0:
            matches[packet] = profile
    return matches


def show_owner_candidates(data, owner, recap):
    def prefix(sample):
        value = 0
        for index, byte in enumerate(bytes.fromhex(sample[:10])):
            digit = owner[byte]
            value |= (digit & 127) << (7 * index)
            if digit < 128 and value <= 0xffffffff:
                return value
        return None

    actions = []
    for key, samples in data["payloads"].items():
        if not key.startswith("out:") or len(set(samples)) < 2:
            continue
        owners = {prefix(sample) for sample in samples}
        if len(owners) == 1 and None not in owners and 0 not in owners:
            actions.append((data["counts"][key], key, owners.pop()))
    actions.sort(reverse=True)
    print("Outgoing IDs with a consistent owner (ID, observed count):",
          [(key[4:], count) for count, key, _ in actions[:6]])
    if not actions or not recap:
        return
    times = data["times"]
    deaths = times[f"in:{recap}"]
    for local in dict.fromkeys(player for _, _, player in actions[:3]):
        paired = []
        for key, samples in data["payloads"].items():
            if not key.startswith("in:") or key == f"in:{recap}":
                continue
            updates = sorted(t for t, sample in zip(times[key], samples) if prefix(sample) == local)
            def has_update(death):
                index = bisect_left(updates, death - 2)
                return index < len(updates) and updates[index] <= death + 2
            if all(has_update(death) for death in deaths):
                paired.append((len(updates), key))
        print(f"Companions present within 2 ms of all {len(deaths)} recaps (ID, sampled local updates):",
              [(key[3:], count) for count, key in sorted(paired)[:8]])


def discover_client(binary, recipe, recording, recap_evidence):
    emulator = Emulator(binary)
    owner = owner_table(emulator, recipe["ids"]["heroStats"])
    factory = emulator.packet_ids()
    with TemporaryDirectory() as directory:
        def dump(name, profile):
            output = Path(directory) / name
            subprocess.run(["node", Path(__file__).with_name("dumpAllLivePackets.mjs"),
                            recording, output, "2000", profile], check=True)
            data = json.loads(output.read_bytes())
            if data["build"] != recipe["build"]:
                raise ValueError("Recording and replay builds differ")
            return data

        data = dump("outer.json", "--outer-only")
        for role in SHAPES:
            matches = find_role(role, data, emulator, owner, factory)
            if len(matches) != 1:
                print(f"{role}: needs review ({len(matches)} supported candidates {list(matches)})")
                continue
            packet, profile = matches.popitem()
            recipe["ids"][role] = packet
            print(f"{role}: {packet} verified against client samples", flush=True)
            if role == "batch":
                partial = Path(directory) / "batch.json"
                write_profile(profile, partial)
                data = dump("expanded.json", partial)
            if role == "recap" and recap_evidence:
                evidence = json.loads(recap_evidence.read_bytes())
                if evidence["build"] != recipe["build"] or evidence["recording"] != recording.name:
                    raise ValueError("Recap evidence must name this exact build and recording directory")
                result = subprocess.run(["node", Path(__file__).with_name("inferRecapBindings.mjs")], text=True,
                                        input=json.dumps({"profile": profile, "samples": data["payloads"][f"in:{packet}"],
                                                          "observations": evidence["observations"]}), stdout=subprocess.PIPE, check=True)
                recipe["offsets"].update(json.loads(result.stdout))
        if recap_evidence and "detail" not in recipe["offsets"]:
            raise ValueError("Could not identify the recap packet to verify the supplied evidence")
        show_owner_candidates(data, owner, recipe["ids"].get("recap"))
