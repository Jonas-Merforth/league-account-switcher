"""Run the native scoreboard readers on real keyframes using a build recipe."""
import argparse
import json
import struct
from pathlib import Path

from inspect_keyframes import parse_blocks
from liveproto.emulator import Emulator
from liveproto.macho import MachO
from liveproto.probe import Probe, encode_varint, flip_id, owner_table


def vector(run, offset, limit):
    pointer, length = struct.unpack_from("<QI", run.memory, offset)
    if length > limit:
        raise ValueError("Invalid native vector size")
    return run.read(pointer, length) if length else b""


class ScoreboardOracle:
    def __init__(self, binary, recipe):
        binaries = {recipe["build"]: recipe["sha256"], **recipe.get("hotfixes", {})}
        self.build = next((build for build, digest in binaries.items() if binary.sha256 == digest), None)
        if self.build is None:
            raise ValueError("Binary does not match recipe")
        self.recipe = recipe
        self.ids = recipe["ids"]
        self.emulator = Emulator(binary)
        self.owner = owner_table(self.emulator, self.ids["heroStats"])
        def probe(role):
            p = Probe(self.emulator, self.ids[role], self.owner.index(0))
            return p, p.describe()["fields"]
        _, stats = probe("heroStats")
        self.stats, = [f["object"][0] for f in stats if any(r["kind"] == "bytes" for r in f["readers"])]
        spawn, fields = probe("heroSpawn")
        id_field, = [f for f in fields if any(r.get("objectId") for r in f["readers"])]
        start, width = id_field["bits"]
        active = next(i for i, c in enumerate(id_field["cases"]) if "read" in c)
        flags = spawn.window(spawn.defaults, range(start, start + width), active)
        _, info = spawn.varint(flags)
        self.id_offset = id_field["object"][0]
        self.id_rest = info["rest"]
        self.model = recipe["offsets"]["heroSpawn"]["model"]
        if "turret" in self.ids:
            _, turret = probe("turret")
            self.name = recipe["offsets"]["turret"]["name"]
            self.state = recipe["turretFlag"]["offset"]
            field, = [f for f in turret if f.get("object", [None])[0] == self.state]
            self.states = {c["stored"]: c["stored"] == recipe["turretFlag"]["true"] for c in field["cases"]}
            if set(self.states.values()) != {False, True}:
                raise ValueError("Unknown native turret states")

    def frame(self, file):
        vectors, champions, turrets = {}, {}, {}
        roles = {self.ids[r]: r for r in ("heroStats", "heroSpawn", "turret") if r in self.ids}
        for block in parse_blocks(file.read_bytes(), secondary_timestamp=self.recipe["secondaryTimestamp"]):
            role = roles.get(block.packet_id)
            if not role:
                continue
            data = encode_varint(self.owner, flip_id(block.param)) + block.payload
            run = self.emulator.deserialize(block.packet_id, data)
            if not run.ok or run.consumed != len(data):
                raise ValueError(f"Native reader did not consume complete {role} payload")
            if role == "heroStats":
                raw = vector(run, self.stats, 1260)
                if len(raw) != 1260 or block.param in vectors:
                    raise ValueError("Invalid native hero vector")
                vectors[block.param] = raw.hex()
            elif role == "heroSpawn":
                # Read the resulting object, independently of the wire decoder.
                plain = bytearray(4)
                for i, (table, pos) in enumerate(zip(self.id_rest["tables"], self.id_rest["source"])):
                    plain[pos] = table.index(run.memory[self.id_offset + i])
                entity = int.from_bytes(plain, "little")
                if entity in champions:
                    raise ValueError("Duplicate native hero")
                champions[entity] = vector(run, self.model, 128).decode("ascii")
            else:
                if block.param in turrets:
                    raise ValueError("Duplicate native turret")
                turrets[block.param] = {"name": vector(run, self.name, 64).decode("ascii"),
                                        "destroyed": self.states[run.memory[self.state:self.state + 1].hex()]}
        if len(vectors) != 10 or vectors.keys() != champions.keys():
            raise ValueError("Incomplete native roster")
        return {"build": self.build, "file": str(file), "vectors": vectors,
                "champions": champions, "turrets": turrets}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("recipe", "binary", "captures"):
        parser.add_argument(arg, type=Path)
    args = parser.parse_args()
    oracle = ScoreboardOracle(MachO(args.binary), json.loads(args.recipe.read_text()))
    files = sorted(args.captures.glob("*/keyframe-*.bin"))
    if not files:
        parser.error("No keyframes found")
    print(json.dumps([oracle.frame(file) for file in files]))
