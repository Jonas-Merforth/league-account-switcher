"""Build and publish a static live-profile feed from finished recordings and replays.

Run periodically on a machine with access to the maintainer's recording folders.
Only the output JSON belongs in the web root.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from build_live_profile import bind, write_profile
from check_live_hotfix import cached_build
from liveproto.emulator import Emulator
from liveproto.macho import MachO
from liveproto.probe import describe, owner_table
from liveproto.recap import describe_recap

HERE = Path(__file__).resolve().parent
RECIPES = HERE / "liveproto/builds"
PROFILES = HERE.parent / "src/core/protocols"
BUILD = re.compile(r"\b\d+\.\d+\.\d+\.\d+\b")


def read(path):
    return json.loads(path.read_bytes())


def run(script, *args, capture=False):
    engine = sys.executable if script.endswith(".py") else "node"
    return subprocess.run([engine, HERE / script, *args], check=True, text=True,
                          stdout=subprocess.PIPE if capture else None)


@contextmanager
def writer_lock(path):
    with path.open("a+b") as stream:
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def inventory(recordings, replays):
    games = defaultdict(dict)
    for log in sorted(recordings.glob("*/original-r3dlog.txt")):
        folder = log.parent
        if not all((folder / n).is_file() for n in ("summary.json", "raw-ipv4.pcapng", "observations.jsonl")):
            continue
        try:
            summary = read(folder / "summary.json")
        except (ValueError, OSError):
            continue  # The recorder may still be finishing its summary.
        if summary.get("busy") or summary.get("samples", 0) < 2 or not summary.get("originalLogSaved"):
            continue
        with log.open("rb") as f:
            header = f.read(65536).decode(errors="replace")
        build = next((m[0] for line in header.splitlines()[:200] if "version" in line.lower() and (m := BUILD.search(line))), None)
        game = re.search(r'(?:GameStartData::GameID=|"-GameID=)(\d+)', header)
        if build and game:
            # Multiple starts in the same match are one piece of evidence. Prefer the longest capture.
            old = games[build].get(game[1])
            if old is None or (folder / "raw-ipv4.pcapng").stat().st_size > (old / "raw-ipv4.pcapng").stat().st_size:
                games[build][game[1]] = folder
    playback = defaultdict(list)
    for path in sorted(replays.glob("*.rofl")):
        with path.open("rb") as stream:
            header = stream.read(15)
            if len(header) == 15 and header[:4] == b"RIOT" and header[4:6] == b"\x02\x00":
                build = stream.read(header[14]).decode("ascii", errors="replace")
                if BUILD.fullmatch(build):
                    playback[build].append(path)
    return games, playback


def corpus(root, build, destination, modes, recordings, replays):
    patch = ".".join(build.split(".")[:2])
    seen = set()
    destination.mkdir()
    available = {r.name.lower(): r for r in replays}
    paired = []
    for i, folder in enumerate(recordings):
        match = read(folder / "summary.json").get("replayMetadata") or {}
        name = f"{match.get('platformId')}-{match.get('gameId')}.rofl".lower()
        if name in available and any(match.get("queueId") in m["queues"] for m in modes):
            run("replayEvidenceFrames.mjs", folder, available[name], destination / f"paired-{i}", build)
            paired.append(available[name])
            seen.add(match["queueId"])
    for manifest in sorted(root.glob("*/manifest.json")) if root else []:
        meta = read(manifest)
        if meta.get("build") not in (build, patch):
            continue
        queue = meta.get("queueId")
        if not any(queue in mode["queues"] for mode in modes):
            continue
        frames = list(manifest.parent.glob("keyframe-*.bin"))
        if not frames:
            continue
        out = destination / manifest.parent.name
        out.mkdir(parents=True)
        for file in [manifest, *frames]:
            try:
                os.link(file, out / file.name)
            except OSError:
                shutil.copyfile(file, out / file.name)
        seen.add(queue)
    if not modes or any(not seen.intersection(mode["queues"]) for mode in modes):
        raise ValueError("Need scoreboard frames for each configured mode family")
    return paired


def regular(build, binary, recordings, replays, args, work):
    if len(recordings) < 2 or not replays:
        raise ValueError("Waiting for a replay and two complete recordings of different games")
    modes = read(args.policy)["modes"]
    frames = work / "frames"
    paired = corpus(args.frames, build, frames, modes, recordings, replays)
    # With Match History metadata, only probe replays from the supported queues.
    # Older recordings use the explicitly supplied corpus and exact-build replays.
    replays = paired or replays
    recipe_path = work / "recipe.json"
    # A full replay must reconstruct every final player total. Other replays are also checked below.
    required = {"batch", "combat", "marker", "replication", "recap", "heroStats", "heroSpawn", "display", "turret"}
    for folder in sorted(recordings, key=lambda f: (f / "raw-ipv4.pcapng").stat().st_size, reverse=True):
        try:
            run("discover_live_replay.py", binary, replays[0], recipe_path, "--recording", folder, "--rift-frames", frames)
        except subprocess.CalledProcessError:
            continue
        recipe = read(recipe_path)
        if required <= recipe["ids"].keys():
            break
    else:
        raise ValueError("No recording resolved all required packet roles")
    emu = Emulator(MachO(binary))
    owner = owner_table(emu, recipe["ids"]["combat"])
    layouts = {role: bind(role, describe(emu, recipe["ids"][role], owner), recipe["offsets"].get(role, {}))
               for role in ("batch", "combat", "heroSpawn")}
    schemas = describe_recap(emu, recipe["ids"]["recap"], owner)
    layouts.update({role: bind(role, schema, {}, candidates=True)
                    for role, schema in zip(("recap", "entry", "detail"), schemas)})
    candidate = work / "candidate.json"
    write_profile({**recipe, "partial": True, "owner": bytes(owner).hex(), "layouts": layouts}, candidate)
    pairs = []
    for i, folder in enumerate(recordings):
        dump = work / f"dump-{i}.json"
        run("dumpAllLivePackets.mjs", folder, dump, "1000000", candidate)
        pairs.extend((dump, folder))
    bindings = json.loads(run("inferLiveClientBindings.mjs", candidate, *pairs, capture=True).stdout)
    recipe["ids"].update(bindings["ids"])
    recipe["offsets"].update(bindings["offsets"])
    recipe["modes"] = modes
    write_profile(recipe, recipe_path)
    profile = work / (build + ".json")
    run("build_live_profile.py", binary, recipe_path, profile, "--replay", replays[0])
    run("teamChunks16_22.mjs", "--profile", profile, *replays)
    run("verifyLivePatch.mjs", sys.executable, "--profile", recipe_path, profile, binary, frames)
    return recipe, read(profile)


def process(build, games, replays, args, catalog, work):
    patch = ".".join(build.split(".")[:2])
    saved = args.state / (patch + ".json")
    version = lambda s: tuple(map(int, s.split(".")))
    available = [p for p in (RECIPES / saved.name, saved, *sorted(args.state.glob(patch + ".*.*.json"))) if p.is_file()]
    bases = {data["build"]: (path, data) for path in available if (data := read(path)) and version(data["build"]) <= version(build)}
    reference, base = bases[max(bases, key=version)] if bases else (None, None)
    shipped = PROFILES / (build + ".json")
    if base and build == base["build"] and shipped.is_file() and not args.rebuild:
        return base, read(shipped)
    binary, metadata = cached_build(build, args.cache)
    if base and build != base["build"]:
        base_build = base["build"]
        previous = next((p for p in catalog if p["build"] == base_build), None)
        source = work / "reference-profile.json"
        write_profile(previous or read(PROFILES / (base_build + ".json")), source)
        original, _ = cached_build(base_build, args.cache)
        ready = work / "ready"
        # A deathless or late recording need not prevent a later complete one from verifying the alias.
        for game in games:
            try:
                run("check_live_hotfix.py", reference, source, original, binary, metadata, build,
                    "--recording", game, "--prepare-dir", ready)
                return read(ready / reference.name), read(ready / source.name)
            except subprocess.CalledProcessError:
                continue
        print("No unchanged hotfix layout verified. Trying full discovery for this exact build.", flush=True)
    recipe, profile = regular(build, binary, games, replays, args, work)
    if shipped.is_file():
        # Existing users already have this canonical decoder. The discovered
        # death witness can differ while observing the same local deaths.
        canonical = read(shipped)
        for key in ("owner", "layouts", "modes", "secondaryTimestamp", "sha256"):
            if profile[key] != canonical[key]:
                raise ValueError(f"Rediscovery contradicts bundled {key}")
        if any(v != canonical["ids"][k] for k, v in profile["ids"].items() if k != "recapOwner"):
            raise ValueError("Rediscovery contradicts bundled roles")
        return base, canonical
    if base and base["build"] == build and base.get("hotfixes"):
        recipe["hotfixes"] = base["hotfixes"]
        profile["hotfixBuilds"] = list(base["hotfixes"])
    return recipe, profile


def update(args):
    for folder in (args.recordings, args.replays, args.frames):
        if folder is not None and not folder.is_dir():
            raise ValueError(f"Waiting for input folder: {folder}")
    games, replays = inventory(args.recordings, args.replays)
    failed = False
    with writer_lock(args.output.with_suffix(".lock")):
        feed = read(args.output) if args.output.exists() else {"version": 1, "profiles": []}
        if feed.get("version") != 1 or not isinstance(feed.get("profiles"), list):
            raise ValueError("Unrecognized existing feed")
        minimum = tuple(map(int, read(args.policy)["build"].split(".")))
        targets = [args.build] if args.build else [b for b in games if tuple(map(int, b.split("."))) >= minimum]
        for build in sorted(targets, key=lambda s: tuple(map(int, s.split(".")))):
            if not args.rebuild and any(build in [p["build"], *p.get("hotfixBuilds", [])] for p in feed["profiles"]):
                continue
            try:
                with TemporaryDirectory(dir=args.state) as tmp:
                    recipe, profile = process(build, list(games[build].values()), replays[build], args, feed["profiles"], Path(tmp))
                    previous = next((p for p in feed["profiles"] if p["build"] == profile["build"]), None)
                    if previous:
                        if any(previous.get(k) != profile.get(k) for k in previous.keys() | profile.keys() if k != "hotfixBuilds"):
                            raise ValueError("Generated layout differs from the previously published build")
                        aliases = list(dict.fromkeys(previous.get("hotfixBuilds", []) + profile.get("hotfixBuilds", [])))
                        if aliases:
                            if any(v not in recipe.get("hotfixes", {}) for v in aliases):
                                raise ValueError("Missing binary pin for a previously published hotfix")
                            profile["hotfixBuilds"] = aliases
                    updated = [p for p in feed["profiles"] if p["build"] != profile["build"]] + [profile]
                    result = {"version": 1, "profiles": updated}
                    staged = Path(tmp) / "feed.json"
                    write_profile(result, staged)
                    run("checkLiveFeed.mjs", staged)
                    write_profile(recipe, args.state / (recipe["build"] + ".json"))
                    write_profile(result, args.output, mode=0o644 if os.name != "nt" else None)
                    feed = result
                    print(f"Published {build} to {args.output}", flush=True)
            except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
                print(f"{build} pending: {error}", file=sys.stderr)
                failed = True
    return int(failed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("recordings", "replays", "state", "output"):
        parser.add_argument("--" + name, type=Path)
    parser.add_argument("--local", action="store_true", help="use the Windows switcher's default recording and feed locations")
    parser.add_argument("--watch", action="store_true", help="keep checking the input folders every five minutes")
    parser.add_argument("--frames", type=Path, help="optional saved scoreboard corpus for games without a paired replay")
    parser.add_argument("--cache", type=Path, default=HERE.parent / ".local-research/official-builds")
    parser.add_argument("--policy", type=Path, default=RECIPES / "16.23.json", help="source of mode/queue/delay settings only")
    parser.add_argument("--build", help="limit the run to one exact version")
    parser.add_argument("--rebuild", action="store_true", help="rediscover a bundled base from recordings for regression testing")
    args = parser.parse_args()
    if args.build and not BUILD.fullmatch(args.build):
        parser.error("Expected four-part build")
    if args.local:
        if os.name != "nt":
            parser.error("--local expects Windows; supply the server input and output paths explicitly")
        app = Path(os.environ["APPDATA"]) / "league-account-switcher"
        args.recordings = args.recordings or app / "damage-research"
        args.output = args.output or app / "live-profiles.json"
        if not args.replays:
            docs = subprocess.check_output(["powershell.exe", "-NoProfile", "-Command",
                                            "[Environment]::GetFolderPath('MyDocuments')"], text=True).strip()
            args.replays = Path(docs) / "League of Legends/Replays"
    if not all((args.recordings, args.replays, args.output)):
        parser.error("Supply --recordings, --replays and --output, or --local")
    args.state = args.state or HERE.parent / ".local-research/live-feed-worker"
    args.state.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            status = update(args)
        except (ValueError, OSError) as error:
            print(error, file=sys.stderr)
            status = 1
        if not args.watch:
            return status
        time.sleep(300)


if __name__ == "__main__":
    sys.exit(main())
