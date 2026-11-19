"""Generate runtime layouts from one binary and a small, reviewed role map.

python research/build_live_profile.py BINARY research/liveproto/builds/16.23.json OUT.json
"""
import argparse
import json
import struct
import subprocess
from pathlib import Path
from tempfile import NamedTemporaryFile

from liveproto.emulator import Emulator
from liveproto.macho import MachO
from liveproto.probe import describe, owner_table
from liveproto.recap import describe_recap


# Fields with a unique shape need no per-build offset. Other meanings must
# be identified on a recording and entered in the build's offsets.
ROLES = {
    "combat": {"kind": "u16", "schema": "u32", "body": "bytes"},
    "batch": {"lengths": "varints", "body": "bytes"},
    "heroStats": {"vector": "bytes", "counter": "u32"},
    "heroSpawn": {"model": "bytes", "id": "id"},
    "display": {"amount": "float", "typeCode": "u8", "sourceId": "id", "targetId": "id"},
    "marker": {"time": "float", "kind": "u8"},
    "replication": {"time": "float", "vector": "bytes"},
    "recap": {"duration": "float", "outgoing": "struct"},
    "entry": {"details": "structs"},
    "detail": {"physical": "float", "magic": "float", "true": "float"},
    "turret": {"name": "bytes", "destroyedTime": "u32", "stateTime": "u32", "counter": "u32"},
}
EXTRA_DISPLAY = {"hash": "u32", "displayCode": "u8", "resultCode": "u8"}


def shape(field, reader):
    if reader.get("opaque"):
        return "opaque"
    if reader["kind"] == "varint":
        return "id" if reader.get("objectId") else f"u{8 * reader['width']}"
    if reader["kind"] == "fixed":
        return field.get("type") or f"u{8 * reader['size']}"
    return reader["kind"]


def bind(role, schema, offsets, flag=None, candidates=False):
    fields = schema["fields"]
    wanted = ROLES[role].copy()
    if role == "display":
        wanted.update({k: v for k, v in EXTRA_DISPLAY.items() if k in offsets})
    if offsets.keys() - wanted.keys():
        raise ValueError(f"Unknown binding in {role}: {offsets}")
    names = {}
    if candidates:
        for i, f in enumerate(fields):
            kinds = {shape(f, r) for r in f["readers"]}
            if len(kinds) == 1 and kinds <= set(ROLES[role].values()):
                name = str(f["object"][0])
                names[i] = name
                wanted[name] = kinds.pop()
    else:
        for name, kind in wanted.items():
            matches = [i for i, f in enumerate(fields)
                       if {shape(f, r) for r in f["readers"]} == {kind}
                       and (name not in offsets or f.get("object", [None])[0] == offsets[name])]
            if len(matches) != 1 or matches[0] in names:
                choices = [f.get("object", [None])[0] for f in fields if {shape(f, r) for r in f["readers"]} == {kind}]
                raise ValueError(f"{role}.{name}: expected one {kind} binding. Candidate object offsets: {choices}")
            names[matches[0]] = name

    layout = []
    for i, f in enumerate(fields):
        if not f["readers"]:
            if flag and f.get("object", [None])[0] == flag["offset"]:
                stored = [c["stored"] for c in f["cases"]]
                if len(set(stored)) != 2 or flag["true"] not in stored:
                    raise ValueError("Unrecognized turret state constants")
                layout.append({"bits": f["bits"], "name": "destroyed", "readers": [],
                               "cases": [v == flag["true"] for v in stored]})
            continue
        if any(r["kind"] not in ("bytes", "fixed", "varint", "varints", "struct", "structs") for r in f["readers"]):
            raise ValueError(f"Unresolved {role} reader at bits {f['bits']}")
        field = {"bits": f["bits"], "readers": f["readers"]}
        if i in names:
            field.update(name=names[i], type=wanted[names[i]])
        field["cases"] = []
        for c in f["cases"]:
            if "read" in c:
                field["cases"].append({"read": c["read"]})
            elif (i not in names or wanted[names[i]] in ("bytes", "varints", "struct", "structs")
                  or (role == "turret" and names[i] in ("destroyedTime", "stateTime"))):
                field["cases"].append(None)
            else:
                raw = bytes.fromhex(c["value"])
                default = struct.unpack("<f", raw)[0] if wanted[names[i]] == "float" else int.from_bytes(raw, "little")
                field["cases"].append(default)
        layout.append(field)
    if role == "turret" and not any(f.get("name") == "destroyed" for f in layout):
        raise ValueError("Missing turret state binding")
    return {"flagBytes": schema["flagBytes"], "fields": layout}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("binary", "recipe", "output"):
        parser.add_argument(arg, type=Path)
    parser.add_argument("--replay", type=Path, help="infer spawn model and display fields from a matching full replay")
    parser.add_argument("--batch-only", action="store_true", help="generate only the batch reader for offline packet inventory")
    args = parser.parse_args()
    recipe = json.loads(args.recipe.read_text())
    binary = MachO(args.binary)
    if binary.sha256 != recipe["sha256"]:
        parser.error("The binary SHA-256 differs from the build recipe")
    emulator = Emulator(binary)
    ids = recipe["ids"]
    if args.batch_only:
        owner = owner_table(emulator, ids["batch"])
        layout = bind("batch", describe(emulator, ids["batch"], owner), {})
        profile = {"build": recipe["build"], "sha256": binary.sha256, "ids": {"batch": ids["batch"]},
                   "partial": True, "owner": bytes(owner).hex(), "layouts": {"batch": layout}}
        write_profile(profile, args.output)
        return
    required = (set(ROLES) - {"entry", "detail", "turret"}) | {"recapOwner", "ownerAction"}
    if (required - ids.keys() or any(type(i) is not int or i < 0 or i > 1530 for i in ids.values())
            or len(set(v for k, v in ids.items() if k != "ownerAction")) != len(ids) - 1):
        parser.error("Missing, duplicate or invalid role IDs")
    if recipe.get("modes") and any(not m["mayhem"] for m in recipe["modes"]) and "turret" not in ids:
        parser.error("Rift scoreboard modes require a verified turret ID")
    owner = owner_table(emulator, ids["combat"])
    profile = {k: recipe[k] for k in ("build", "sha256", "secondaryTimestamp", "ids")}
    if recipe.get("hotfixes"):
        profile["hotfixBuilds"] = list(recipe["hotfixes"])
    profile.update(owner=bytes(owner).hex(), layouts={})
    if "modes" in recipe:
        profile["modes"] = recipe["modes"]
    schemas = dict(zip(("recap", "entry", "detail"), describe_recap(emulator, ids["recap"], owner)))
    if args.replay:
        for role in ("heroStats", "heroSpawn", "display"):
            schemas[role] = describe(emulator, ids[role], owner)
        layouts = {role: bind(role, schemas[role], {}, candidates=role != "heroStats")
                   for role in ("heroStats", "heroSpawn", "display")}
        result = subprocess.run(["node", Path(__file__).with_name("inferLiveBindings.mjs"), args.replay],
                                input=json.dumps({**profile, "layouts": layouts}), text=True,
                                stdout=subprocess.PIPE, check=True)
        inferred = json.loads(result.stdout)
        print("Replay-verified offsets:", inferred)
        for role, bindings in inferred.items():
            offsets = recipe["offsets"].setdefault(role, {})
            if any(name in offsets and offsets[name] != offset for name, offset in bindings.items()):
                raise ValueError(f"Replay contradicts the supplied {role} bindings")
            offsets.update(bindings)
    for role in ROLES:
        if role == "turret" and role not in ids:
            continue
        schema = schemas.get(role) or describe(emulator, ids[role], owner)
        profile["layouts"][role] = bind(role, schema, recipe["offsets"].get(role, {}),
                                       recipe.get("turretFlag") if role == "turret" else None)
    write_profile(profile, args.output)


def write_profile(profile, output):
    with NamedTemporaryFile(dir=output.parent, delete=False) as temp:
        temp.write((json.dumps(profile, indent=1) + "\n").encode())
    Path(temp.name).replace(output)


if __name__ == "__main__":
    main()
