"""Fetch the exact public macOS build named in a game log.

python research/fetch_live_build.py 16.23.839.6405 [--output DIRECTORY]
Requires CDTB (pip install cdtb). Outputs only the binary and build metadata.
"""
import argparse
import hashlib
import io
import json
import re
from collections import defaultdict
from pathlib import Path
from tempfile import NamedTemporaryFile

import requests
from cdtb.patcher import PatcherManifest
from cdtb.tools import zstd_decompress

CDN = "https://lol.dyn.riotcdn.net/channels/public"
REGISTRY = "https://raw.githubusercontent.com/Morilli/riot-manifests/master/LoL/EUW1/macos/lol-game-client"


def fetch(session, url, **kwargs):
    response = session.get(url, timeout=60, **kwargs)
    response.raise_for_status()
    return response


def extract(session, file, destination):
    if destination.is_file() and destination.stat().st_size == file.size:
        return
    # Download adjacent selected chunks together. Keep their original file
    # positions, since a binary can span several bundles.
    bundles = defaultdict(list)
    position = 0
    for chunk in file.chunks:
        bundles[chunk.bundle.bundle_id].append((chunk, position))
        position += chunk.target_size
    if position != file.size:
        raise ValueError("Inconsistent manifest file size")
    with NamedTemporaryFile(dir=destination.parent, delete=False) as target:
        temp = Path(target.name)
    try:
        with temp.open("wb") as out:
            for bundle, parts in bundles.items():
                ranges = []
                for c, pos in sorted(parts, key=lambda p: p[0].offset):
                    if not ranges or c.offset - ranges[-1][-1][0].offset - ranges[-1][-1][0].size > 131072:
                        ranges.append([])
                    ranges[-1].append((c, pos))
                for group in ranges:
                    first, last = group[0][0], group[-1][0]
                    start, end = first.offset, last.offset + last.size
                    res = fetch(session, f"{CDN}/bundles/{bundle:016X}.bundle",
                                headers={"Range": f"bytes={start}-{end - 1}"})
                    if res.status_code == 206:
                        if not res.headers.get("Content-Range", "").startswith(f"bytes {start}-{end - 1}/"):
                            raise ValueError("CDN returned a different bundle range")
                        data = res.content
                    else:
                        data = res.content[start:end]
                    if len(data) != end - start:
                        raise ValueError("Incomplete bundle range")
                    for chunk, pos in group:
                        offset = chunk.offset - start
                        raw = zstd_decompress(data[offset:offset + chunk.size])
                        if len(raw) != chunk.target_size:
                            raise ValueError("Incorrect decompressed chunk size")
                        out.seek(pos)
                        out.write(raw)
        temp.replace(destination)
    finally:
        temp.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build", help="exact log version, e.g. 16.23.839.6405")
    parser.add_argument("--output", type=Path, default=Path(".local-research/official-builds"))
    args = parser.parse_args()
    parts = args.build.split(".")
    if len(parts) not in (3, 4) or not all(re.fullmatch(r"[0-9]+", p) for p in parts):
        parser.error("Expected an exact build including hotfix digits")
    compact = ".".join([*parts[:2], "".join(parts[2:])])
    args.output.mkdir(exist_ok=True, parents=True)
    with requests.Session() as session:
        pointer = fetch(session, f"{REGISTRY}/{compact}.txt").text.strip()
        match = re.fullmatch(r"https://lol\.(?:secure\.)?dyn\.riotcdn\.net/channels/public/releases/([0-9A-F]{16})\.manifest", pointer)
        if not match:
            raise ValueError("Unrecognized manifest reference")
        mid = match[1]
        manifest = PatcherManifest()
        manifest.parse_rman(io.BytesIO(fetch(session, f"{CDN}/releases/{mid}.manifest").content))
        for suffix in ("code-metadata.json", "LeagueofLegends.app/Contents/MacOS/LeagueofLegends"):
            file, = [f for f in manifest.files.values() if f.name == suffix or f.name.endswith("/" + suffix)]
            path = args.output / (mid + "-" + Path(suffix).name)
            extract(session, file, path)
            if suffix == "code-metadata.json" and json.loads(path.read_bytes())["version"].split("+")[0] != compact:
                raise ValueError("Metadata version differs from requested build")
            print(path, hashlib.sha256(path.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
