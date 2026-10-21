"""Offline surrender-vote timeline from a League replay (.rofl, ROFL2).

See docs/ff-replay-vote-routing-2026-10-21.md. Replays store the spectator
stream as zstd-compressed observer blocks. Surrender packet IDs change every
patch, so this tool identifies them structurally instead of by number:

- eligibility (Riot's SetCanSurrender flag): one-byte per-player messages,
  one per player when surrender unlocks;
- vote start/update (TeamSurrenderVote): player-independent messages logged
  once per recipient, always at the same instant as one player's flag change;
- announcement (TeamSurrenderStatus): one per vote window, at its final vote
  or timeout.

Payload fields stay obfuscated; yes/no counts are not decoded here. Reports
contain no names, PUUIDs, summoner IDs or raw payloads.
"""

import argparse
import collections
import json
import struct
from pathlib import Path

import zstandard

ZSTD = bytes.fromhex("28b52ffd")
MAX_FRAME = 64 * 1024 * 1024
VOTE_WINDOW_SECONDS = 30


def read_replay(path):
    data = Path(path).read_bytes()
    if data[:6] != b"RIOT\x02\x00" or len(data) < 16:
        raise ValueError("Expected a ROFL2 replay")
    version = data[15:15 + data[14]].decode("ascii")
    frames, at, dc = [], 15 + data[14], zstandard.ZstdDecompressor()
    # Entry: u32 id, u32 aux, u8 kind (1 chunk, 2 keyframe, 3 startup),
    # u32 size, u32 compressed size, zstd frame, then a short trailer.
    while (j := data.find(ZSTD, at)) >= 17:
        cid, _, kind, size, csize = struct.unpack_from("<IIBII", data, j - 17)
        if kind not in (1, 2, 3) or size > MAX_FRAME or j + csize > len(data):
            at = j + 4
            continue
        blob = dc.decompress(data[j:j + csize], max_output_size=size)
        if len(blob) != size:
            raise ValueError("Replay frame size mismatch")
        frames.append((cid, kind, blob))
        at = j + csize
    start = data.find(b'{"gameLength"', at)
    if start < 0:
        raise ValueError("Replay metadata missing")
    metadata = json.JSONDecoder().raw_decode(data[start:].decode("utf-8", "replace"))[0]
    return version, frames, metadata


def iter_blocks(buf):
    cursor, clock, last_id, last_param = 0, 0.0, 0, 0

    def take(fmt):
        nonlocal cursor
        size = struct.calcsize(fmt)
        if cursor + size > len(buf):
            raise ValueError("Truncated observer block")
        value = struct.unpack_from(fmt, buf, cursor)[0]
        cursor += size
        return value

    while cursor < len(buf):
        marker = take("<B")
        clock = clock + take("<B") / 1000 if marker & 0x80 else take("<f")
        length = take("<B") if marker & 0x10 else take("<I")
        packet = last_id if marker & 0x40 else take("<H")
        # Relative parameters are signed: unsigned deltas yield non-existent
        # 0x400001xx hero IDs where 0x400000xx players are meant.
        param = (last_param + take("<b")) & 0xffffffff if marker & 0x20 else take("<I")
        if cursor + length > len(buf):
            raise ValueError("Observer block exceeds frame")
        yield clock, packet, param, buf[cursor:cursor + length]
        cursor += length
        last_id, last_param = packet, param


def chunk_rows(frames):
    # Keyframes are state snapshots; only chunks carry the message stream.
    rows = []
    for _, kind, blob in frames:
        if kind == 1:
            rows.extend(iter_blocks(blob))
    rows.sort(key=lambda row: row[0])
    return rows


def players(metadata):
    stats = json.loads(metadata.get("statsJson") or "[]")
    teams = [str(p.get("TEAM", "")) for p in stats]
    return [{"team": int(team) if team.isdigit() else None,
             "win": p.get("WIN") == "Win",
             "surrenderEnded": str(p.get("GAME_ENDED_IN_SURRENDER", "0")) == "1"}
            for p, team in zip(stats, teams)]


def instant(value):
    return round(value, 3)


def find_surrender_types(rows, player_count):
    """Return (eligibility, vote, unlockValue, heroes) or raise ValueError."""
    by_type = collections.defaultdict(list)
    for row in rows:
        by_type[row[1]].append(row)
    team_size = player_count // 2
    eligibility = []
    for pid, items in by_type.items():
        if len(items) > 1000 or any(len(r[3]) != 1 for r in items):
            continue
        for _, group in groupby_instant(items).items():
            if (len({r[2] for r in group}) == player_count == len(group)
                    and len({r[3] for r in group}) == 1):
                eligibility.append((pid, group[0][3], sorted(r[2] for r in group)))
                break
    pairs = []
    for e_pid, unlock, heroes in eligibility:
        changes = {instant(r[0]) for r in by_type[e_pid]
                   if r[3] != unlock and r[2] in heroes}
        for v_pid, items in by_type.items():
            if v_pid == e_pid or any(r[2] or not 4 <= len(r[3]) <= 64 for r in items):
                continue
            groups = groupby_instant(items)
            # Accept one copy per player too, so broadcast routing is reported.
            sizes = {len(g) for g in groups.values()}
            if (groups and sizes in ({team_size}, {player_count})
                    and set(groups) <= changes):
                pairs.append((e_pid, v_pid, unlock, heroes))
    if len(pairs) > 1:
        raise ValueError(f"Ambiguous surrender packet types: {[(p[0], p[1]) for p in pairs]}")
    if pairs:
        return pairs[0]
    if len(eligibility) == 1:
        return eligibility[0][0], None, eligibility[0][1], eligibility[0][2]
    # Without votes, several one-byte per-player types can look like an unlock.
    return None, None, None, []


def groupby_instant(items):
    groups = collections.defaultdict(list)
    for row in items:
        groups[instant(row[0])].append(row)
    return groups


def analyze(path):
    version, frames, metadata = read_replay(path)
    rows, roster = chunk_rows(frames), players(metadata)
    e_pid, v_pid, unlock, heroes = find_surrender_types(rows, len(roster) or 10)
    team_size = (len(heroes) or len(roster)) // 2
    # Heroes are allocated in roster order; statsJson lists team 100 first.
    labels, team_of = {}, {}
    if len(roster) == len(heroes) and len({p["team"] for p in roster[:team_size]}) == 1:
        for index, (hero, player) in enumerate(zip(heroes, roster)):
            team_of[hero] = player["team"]
            labels[hero] = f"team{player['team']}-p{index % team_size + 1}"
    else:
        labels = {hero: f"player-{i + 1}" for i, hero in enumerate(heroes)}
    unlock_at = min((instant(r[0]) for r in rows if r[1] == e_pid and r[3] == unlock), default=None)
    changes = collections.defaultdict(list)
    for t, pid, param, payload in rows:
        if pid == e_pid and payload != unlock and param in heroes:
            changes[instant(t)].append(param)
    windows = []
    if v_pid is not None:
        for t, group in sorted(groupby_instant([r for r in rows if r[1] == v_pid]).items()):
            if not windows or t - windows[-1]["start"] > VOTE_WINDOW_SECONDS:
                windows.append({"start": t, "messages": []})
            windows[-1]["messages"].append({
                "gameTime": t, "recipientCopies": len(group),
                "payloadLengths": sorted({len(r[3]) for r in group}),
                "eligibilityChangedFor": [labels[h] for h in changes[t]],
                "teams": sorted({team_of.get(h) for h in changes[t]}, key=str)})
    announcement = find_announcement(rows, windows, {e_pid, v_pid})
    length = metadata["gameLength"] / 1000
    losers = {p["team"] for p in roster if not p["win"]}
    surrendered = any(p["surrenderEnded"] for p in roster)
    for window in windows:
        teams = {team for m in window["messages"] for team in m["teams"]}
        window["team"] = teams.pop() if len(teams) == 1 else None
    for index, window in enumerate(windows):
        if announcement:
            window["announcementAt"] = next(instant(r[0]) for r in rows if r[1] == announcement
                                            and window["start"] <= r[0] <= window["start"] + 27)
        later = any(w["team"] == window["team"] for w in windows[index + 1:])
        accepted = surrendered and window["team"] in losers and not later
        window["outcome"] = "accepted" if accepted else "failed"
        if accepted and "announcementAt" in window:
            window["acceptedToGameEndSeconds"] = round(length - window["announcementAt"], 3)
    copies = sorted({m["recipientCopies"] for w in windows for m in w["messages"]})
    return {"schema": "ff-replay-votes-v1", "replay": Path(path).name, "version": version,
            "gameLengthSeconds": length, "playersPerTeam": team_size,
            "winnerTeams": sorted({p["team"] for p in roster if p["win"]}, key=str),
            "endedInSurrender": surrendered,
            "packetTypes": {"eligibility": e_pid, "vote": v_pid, "announcement": announcement},
            "surrenderUnlockGameTime": unlock_at,
            "voteWindows": windows,
            "recipientCopiesPerVoteMessage": copies,
            "interpretation": interpret(windows, copies, team_size),
            "limitations": [
                "Packet types are identified structurally; payload fields remain obfuscated.",
                "Accepted/failed is inferred from the final match result and window order.",
                "Recipient copies show spectator-stream logging, not a direct capture of each client.",
            ]}


def find_announcement(rows, windows, exclude):
    if not windows:
        return None
    counts = collections.defaultdict(list)
    for t, pid, param, _ in rows:
        if pid not in exclude and not param:
            counts[pid].append(t)
    matches = []
    for pid, times in counts.items():
        if len(times) > 2 * len(windows):
            continue
        # The announcement closes a window: at its final vote, or at timeout.
        # A failure can be followed by a second notice (seen 30 ms later).
        hits = [[t for t in times if w["start"] <= t <= w["start"] + 27] for w in windows]
        if (all(hit and min(hit) >= w["messages"][-1]["gameTime"] - .0005
                for hit, w in zip(hits, windows)) and sum(map(len, hits)) == len(times)):
            matches.append(pid)
    return matches[0] if len(matches) == 1 else None


def interpret(windows, copies, team_size):
    if not windows:
        return "No surrender vote messages in this replay."
    if copies == [team_size]:
        return (f"Every vote start/update was logged exactly {team_size} times: once per member of "
                "the voting team, with no copies for the opposing team.")
    if copies == [2 * team_size]:
        return "Vote starts/updates were logged once per player on both teams: opponents receive them."
    return "Vote message copy counts vary; routing cannot be inferred from this replay."


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("replays", type=Path, nargs="+")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    reports = []
    for path in args.replays:
        try:
            reports.append(analyze(path))
        except (ValueError, OSError, zstandard.ZstdError) as exc:
            reports.append({"replay": path.name, "error": str(exc)})
    text = json.dumps(reports, indent=2)
    if args.output:
        # Exclusive creation protects earlier reports.
        with args.output.open("x", encoding="utf-8") as stream:
            stream.write(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
