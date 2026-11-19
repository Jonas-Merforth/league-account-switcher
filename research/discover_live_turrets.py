"""Identify the Rift tower role and state fields from recorded keyframes."""
import json
import re
from collections import Counter

from build_live_profile import shape
from inspect_keyframes import parse_blocks
from liveproto.emulator import Emulator
from liveproto.probe import ProbeError, describe, encode_varint, flip_id, owner_table
from verify_live_keyframes import vector


def rift_frames(root, recipe):
    frames = []
    hints = 0
    patch = ".".join(recipe["build"].split(".")[:2])
    for manifest in sorted(root.glob("*/manifest.json")):
        game = json.loads(manifest.read_bytes())
        if game.get("queueId") not in (400, 420, 440) or game.get("build") not in (patch, recipe["build"]):
            continue
        for file in sorted(manifest.parent.glob("keyframe-*.bin"), key=lambda p: int(p.stem.split("-")[-1])):
            frames.append((manifest.parent, parse_blocks(file.read_bytes(), secondary_timestamp=recipe["secondaryTimestamp"])))
            hints += game["build"] == patch
    if not frames:
        raise ValueError("No matching Rift keyframes")
    print(f"Rift input: {len(frames)} frames, {hints} with patch-only version metadata.")
    return frames


def field_case(field, flags):
    start, width = field["bits"]
    return field["cases"][(flags >> start) & ((1 << width) - 1)]


def bindings(emulator, owner, packet, frames):
    schema = describe(emulator, packet, owner)
    fields = schema["fields"]
    def of_kind(kind):
        return [f for f in fields if {shape(f, r) for r in f["readers"]} == {kind}]
    text = of_kind("bytes")
    times = [f for f in of_kind("u32") if f["bits"][1] == 1]
    counters = [f for f in of_kind("u32") if f["bits"][1] == 3]
    flags = [f for f in fields if not f["readers"] and len(f["cases"]) == 2 and f.get("object", [0, 0])[1] == 1]
    if not text or len(times) != 2 or not flags or not counters:
        return None
    states = {(f["object"][0], c["stored"]) for f in flags for c in f["cases"]}
    name_fields = {f["object"][0] for f in text}
    expected = {(side, str(lane), str(pos)) for side in ("Order", "Chaos") for lane in range(3)
                for pos in (range(6) if lane == 1 else range(1, 4))}
    previous = {}
    changed = False
    for game, blocks in frames:
        seen = {offset: set() for offset in name_fields}
        for block in blocks:
            if block.packet_id != packet:
                continue
            selectors = int.from_bytes(block.payload[:schema["flagBytes"]], "little")
            present = ["read" in field_case(f, selectors) for f in times]
            if present[0] != present[1]:
                return None
            destroyed = present[0]
            data = encode_varint(owner, flip_id(block.param)) + block.payload
            run = emulator.deserialize(packet, data)
            if not run.ok or run.consumed != len(data):
                return None
            states = {(offset, value) for offset, value in states
                      if (run.memory[offset:offset + 1].hex() == value) == destroyed}
            counters = [f for f in counters if field_case(f, selectors).get("value") == "00000000"]
            for offset in list(name_fields):
                try:
                    name = vector(run, offset, 128).decode("ascii")
                except (UnicodeError, ValueError):
                    name_fields.remove(offset)
                    continue
                match = re.fullmatch(r"Turret_T(Order|Chaos)_L([012])_P([0-5])_\d+_0", name)
                if not match or (match[3] == "0" and destroyed) or match.groups() in seen[offset]:
                    name_fields.remove(offset)
                else:
                    seen[offset].add(match.groups())
            key = (game, block.param)
            if previous.get(key) and not destroyed:
                return None
            changed |= previous.get(key) is False and destroyed
            previous[key] = destroyed
        name_fields = {offset for offset in name_fields if seen[offset] == expected}
    if not changed or len(name_fields) != 1 or len(states) != 1 or len(counters) != 1:
        return None
    offset, value = states.pop()
    first, second = sorted(f["object"][0] for f in times)
    # The runtime tests presence of both optional words. Their order is immaterial.
    return {"name": name_fields.pop(), "counter": counters[0]["object"][0],
            "stateTime": first, "destroyedTime": second}, {"offset": offset, "true": value}


def discover_turrets(binary, recipe, root):
    frames = rift_frames(root, recipe)
    possible = []
    for _, blocks in frames:
        counts = Counter(block.packet_id for block in blocks)
        possible.append({packet for packet, count in counts.items() if count == 24})
    emulator = Emulator(binary)
    owner = owner_table(emulator, recipe["ids"]["heroStats"])
    matches = {}
    for packet in set.intersection(*possible):
        try:
            match = bindings(emulator, owner, packet, frames)
        except ProbeError:
            continue
        if match:
            matches[packet] = match
    if len(matches) != 1:
        raise ValueError(f"Expected one Rift tower assignment across standing and destroyed states, found {len(matches)}")
    packet, (offsets, flag) = matches.popitem()
    recipe["ids"]["turret"] = packet
    recipe["offsets"]["turret"] = offsets
    recipe["turretFlag"] = flag
