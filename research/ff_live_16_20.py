"""Offline surrender research; see docs/ff-live-decoding-2026-10-18.md.

Reads session material only from the owner's original local r3d log. Reports
contain no keys, auth tokens, endpoints, names, raw packets or account IDs.
This is a build-specific research tool, not a live or enemy-vote detector.
"""

import argparse
import base64
import bisect
import collections
import datetime as dt
import hashlib
import ipaddress
import json
import math
import re
import struct
from dataclasses import dataclass, field
from pathlib import Path

from Crypto.Cipher import Blowfish
import zstandard
from unicorn import UcError

from ff_oracle_16_20 import BUILD_SHA256, MachO, MacOracle


@dataclass(repr=False)
class Session:
    key: bytes = field(repr=False)
    player: int = field(repr=False)
    server: bytes = field(repr=False)
    port: int = field(repr=False)


def read_session(path):
    # Do not propagate exceptions containing a launch line or failed token.
    try:
        with Path(path).open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                if "Command" not in line:
                    continue
                for quoted in re.findall(r'"([^"\r\n]+)"', line):
                    fields = quoted.split()
                    if len(fields) != 4 or not re.fullmatch(r"[0-9.]+", fields[0]):
                        continue
                    server = ipaddress.IPv4Address(fields[0]).packed
                    port, player = int(fields[1]), int(fields[3])
                    key = base64.b64decode(fields[2], validate=True)
                    if not 4 <= len(key) <= 56 or not 0 < port < 65536 or not 0 <= player < 2**64:
                        raise ValueError()
                    return Session(key, player, server, port)
    except (ValueError, OSError):
        raise ValueError("Cannot read valid session material from the local r3d log") from None
    raise ValueError("No original game launch session found; redacted exports cannot supply it")


def cfb_pass(data, key, encrypt=False):
    length = len(data) // 8 * 8
    cipher = Blowfish.new(key, Blowfish.MODE_CFB, iv=bytes(8), segment_size=64)
    transform = cipher.encrypt if encrypt else cipher.decrypt
    return transform(data[:length]) + data[length:]


def decrypt(data, key):
    return cfb_pass(cfb_pass(data, key)[::-1], key)


def checksum(sequence, player, ack, payload, table):
    data = struct.pack("<HQ", sequence, player) + ack + payload
    value = int.from_bytes(data[:4], "big") ^ 0xc704dd7b
    for byte in data[4:]:
        value = (((value << 8) & 0xffffffff) | byte) ^ table[value >> 24]
    return int.from_bytes(((~value) & 0xffffffff).to_bytes(4, "big"), "little")


def decode_transport(wire, direction, session, table):
    offset = 4 if direction == "in" else 12
    if len(wire) < offset + 7:
        raise ValueError("short-transport")
    plain = decrypt(wire[offset:], session.key)
    seq, check, flags = struct.unpack_from("<HIB", plain)
    ack = plain[7:15] if seq & 0x8000 else b"\xff" * 8
    payload = plain[15:] if seq & 0x8000 else plain[7:]
    if len(ack) != 8 or checksum(seq, session.player, ack, payload, table) != check:
        raise ValueError("checksum-failure")
    return seq, flags, payload


def unpack_messages(body):
    # Caller 0x1005edbb0 zero-initializes the previous-message context.
    cursor, last_channel, last_seq = 0, 0, 0

    def take(size):
        nonlocal cursor
        if cursor + size > len(body):
            raise ValueError("message-overrun")
        result = body[cursor:cursor + size]
        cursor += size
        return result

    messages = []
    while cursor < len(body):
        header = int.from_bytes(take(2), "little")
        channel = last_channel if header & 16 else take(1)[0]
        seq = (last_seq + 1) & 65535 if header & 8 else int.from_bytes(take(2), "little")
        fragment = tuple(take(2)) if header & 4 else None
        if fragment and not 0 <= fragment[1] < fragment[0]:
            raise ValueError("invalid-fragment-index")
        field_value, extra = header & 3, None
        if field_value == 3:
            value = 0
            for shift in range(0, 35, 7):
                byte = take(1)[0]
                if shift == 28 and byte > 15:
                    raise ValueError("message-varint-overflow")
                value |= (byte & 127) << shift
                if byte < 128:
                    break
            else:
                raise ValueError("message-varint-overflow")
            extra, field_value = value & 1, (value >> 1) + (0 if value & 1 else 3)
        messages.append({"channel": channel, "sequence": seq, "fragment": fragment,
                         "field": field_value, "extraFlag": extra,
                         "flag5": bool(header & 32), "payload": take(header >> 6)})
        last_channel, last_seq = channel, seq
    return messages


def application_type(payload):
    if not payload or (payload[0] >= 251 and len(payload) < 2):
        raise ValueError("short-application-type")
    return ((payload[0], 1) if payload[0] < 251 else
            (251 + (payload[0] - 251) * 256 + payload[1], 2))


def options(data, endian):
    at = 0
    while at < len(data):
        if at + 4 > len(data):
            raise ValueError("Truncated PCAPNG option")
        code, length = struct.unpack_from(endian + "HH", data, at)
        at += 4
        if code == 0:
            return
        if at + length > len(data):
            raise ValueError("PCAPNG option exceeds block")
        yield code, data[at:at + length]
        at += (length + 3) & ~3


def pcap_records(path, counts):
    """Stream bounded PCAPNG blocks; respect section endian and IDB time units."""
    endian, interfaces, record = None, [], 0
    with Path(path).open("rb") as stream:
        while True:
            prefix = stream.read(12)
            if not prefix:
                return
            if len(prefix) != 12:
                raise ValueError("Truncated PCAPNG block header")
            section = prefix[:4] == b"\x0a\x0d\x0d\x0a"
            if section:
                endian = {b"\x4d\x3c\x2b\x1a": "<", b"\x1a\x2b\x3c\x4d": ">"}.get(prefix[8:12])
                interfaces = []
            if endian is None:
                raise ValueError("Missing PCAPNG section byte order")
            kind, length = struct.unpack_from(endian + "II", prefix)
            if length < 12 or length % 4 or length > 16 * 1024 * 1024:
                raise ValueError("Invalid or excessive PCAPNG block length")
            rest = stream.read(length - 12)
            block = prefix + rest
            if len(block) != length or struct.unpack_from(endian + "I", block, length - 4)[0] != length:
                raise ValueError("Truncated or inconsistent PCAPNG block")
            if section:
                if length < 28:
                    raise ValueError("Short PCAPNG section")
            elif kind == 1:
                if length < 20:
                    raise ValueError("Short PCAPNG interface")
                link, _, snap = struct.unpack_from(endian + "HHI", block, 8)
                scale, offset = 1e-6, 0
                for code, value in options(block[16:-4], endian):
                    if code == 9 and len(value) == 1:
                        scale = (2.0 ** -(value[0] & 127) if value[0] & 128 else 10.0 ** -value[0])
                    elif code == 14 and len(value) == 8:
                        offset = struct.unpack(endian + "q", value)[0]
                interfaces.append((link, snap, scale, offset))
            elif kind == 6:
                record += 1
                counts["pcapRecords"] += 1
                if length < 32:
                    raise ValueError("Short PCAPNG packet")
                interface, high, low, cap, original = struct.unpack_from(endian + "5I", block, 8)
                if interface >= len(interfaces) or 28 + ((cap + 3) & ~3) > length - 4 or cap > original:
                    raise ValueError("Invalid PCAPNG packet bounds")
                link, snap, scale, offset = interfaces[interface]
                if cap < original:
                    counts["truncatedRecords"] += 1
                    continue
                if link != 1:
                    counts["unsupportedLinkRecords"] += 1
                    continue
                yield record, ((high << 32) | low) * scale + offset, block[28:28 + cap]
            elif kind in (2, 3):
                counts["unsupportedPacketBlocks"] += 1


def udp_frame(frame, session):
    # IPv6/fragmented IP are explicitly excluded; no partial UDP is decoded.
    if len(frame) < 14:
        raise ValueError("short-ethernet")
    at, ether = 14, int.from_bytes(frame[12:14], "big")
    for _ in range(2):
        if ether not in (0x8100, 0x88a8):
            break
        if len(frame) < at + 4:
            raise ValueError("short-vlan")
        ether, at = int.from_bytes(frame[at + 2:at + 4], "big"), at + 4
    if ether != 0x800:
        return None, "non-ipv4"
    ip = frame[at:]
    if len(ip) < 20 or ip[0] >> 4 != 4:
        raise ValueError("invalid-ipv4")
    ihl, total = (ip[0] & 15) * 4, int.from_bytes(ip[2:4], "big")
    if ihl < 20 or total < ihl or total > len(ip):
        raise ValueError("invalid-ipv4-length")
    if int.from_bytes(ip[6:8], "big") & 0x3fff:
        return None, "fragmented-ipv4"
    if ip[9] != 17:
        return None, "non-udp"
    if total < ihl + 8:
        raise ValueError("short-udp")
    source, destination, length = struct.unpack_from(">HHH", ip, ihl)
    if length < 8 or ihl + length != total:
        raise ValueError("invalid-udp-length")
    incoming = ip[12:16] == session.server and source == session.port
    outgoing = ip[16:20] == session.server and destination == session.port
    if incoming == outgoing:
        return None, "different-flow"
    return ("in" if incoming else "out", ip[ihl + 8:ihl + length],
            destination if incoming else source), None


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def utc_string(value):
    return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def file_identity(path):
    digest, size = hashlib.sha256(), 0
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return {"sha256": digest.hexdigest(), "bytes": size}


class Clock:
    def __init__(self, path):
        self.anchors, self.api_ends, teams, modes = [], [], set(), set()
        with Path(path).open(encoding="utf-8") as stream:
            for line in stream:
                row = json.loads(line)
                data = row.get("data") or {}
                if row.get("kind") == "sample":
                    anchor = data.get("clockAnchor") or {}
                    value = anchor.get("gameTime", row.get("gameTime"))
                    if isinstance(value, (int, float)) and math.isfinite(value) and value > 1 and anchor.get("requestedAt") and anchor.get("receivedAt"):
                        start, end = timestamp(anchor["requestedAt"]), timestamp(anchor["receivedAt"])
                        if end >= start:
                            self.anchors.append(((start + end) / 2, value, (end - start) * 1000))
                    if data.get("localTeam") in ("ORDER", "CHAOS"):
                        teams.add(data["localTeam"])
                    mode = (data.get("game") or {}).get("gameMode")
                    if mode in ("CLASSIC", "ARAM", "KIWI", "CHERRY", "URF", "ONEFORALL", "TUTORIAL", "PRACTICETOOL"):
                        modes.add(mode)
                if row.get("kind") == "event" and data.get("EventName") == "GameEnd":
                    self.api_ends.append({"stage": "api-game-end", "gameTime": data.get("EventTime"),
                                          "receivedAtUtc": row.get("receivedAt")})
        self.anchors.sort()
        self.times = [a[0] for a in self.anchors]
        self.local_team = {"ORDER": 100, "CHAOS": 200}.get(next(iter(teams))) if len(teams) == 1 else None
        self.modes = sorted(modes)

    def align(self, utc):
        index = bisect.bisect_left(self.times, utc)
        choices = self.anchors[max(0, index - 1):index + 1]
        if choices:
            anchor, value, latency = min(choices, key=lambda a: abs(a[0] - utc))
            distance = abs(utc - anchor)
            if distance < 5:
                return {"gameTimeEstimate": round(value + utc - anchor, 6),
                        "anchorDistanceSeconds": round(distance, 6),
                        "anchorRequestDurationMs": round(latency, 3)}
        return {"gameTimeEstimate": None}


class Fragments:
    def __init__(self, counts):
        self.groups, self.counts = {}, counts

    def expire(self, utc):
        for key, group in list(self.groups.items()):
            if utc - group["first"] > 5:
                self.counts["incompleteFragmentGroups"] += 1
                del self.groups[key]

    def feed(self, message, direction, utc, record):
        self.expire(utc)
        if not message["fragment"]:
            return message["payload"], [record]
        self.counts["fragmentOccurrences"] += 1
        count, index = message["fragment"]
        key = direction, message["channel"], message["sequence"], count
        group = self.groups.setdefault(key, {"first": utc, "parts": {}, "records": []})
        if index in group["parts"] and group["parts"][index] != message["payload"]:
            self.counts["conflictingFragmentGroups"] += 1
            del self.groups[key]
            return None
        group["parts"][index] = message["payload"]
        group["records"].append(record)
        if len(group["parts"]) == count:
            payload = b"".join(group["parts"][i] for i in range(count))
            del self.groups[key]
            self.counts["reassembledMessages"] += 1
            return payload, group["records"]
        return None


def acknowledgment_gaps(transport, clock):
    observed = collections.defaultdict(list)
    for record, utc, direction, seq in transport:
        if not seq & 0x8000:
            observed[(direction, seq)].append(utc)
    for times in observed.values():
        times.sort()
    gaps, reported = [], {}
    for record, utc, direction, seq in transport:
        if not seq & 0x8000:
            continue
        # A negative signed sequence is the negated acknowledged sequence,
        # not a positive sequence with its top bit merely cleared.
        peer, sequence = ("in" if direction == "out" else "out"), (-seq) & 0xffff
        times = observed[(peer, sequence)]
        at = bisect.bisect_left(times, utc - 5)
        if at < len(times) and times[at] <= utc + 5:
            continue
        key = peer, sequence
        if utc - reported.get(key, -math.inf) < 5:
            continue
        reported[key] = utc
        gaps.append({"ackRecord": record, "utc": utc_string(utc), **clock.align(utc),
                     "unobservedDirection": peer, "sequence": sequence})
    return gaps


def analyze(pcap, debug_log, game_log, binary_path):
    binary = MachO(binary_path)  # SHA gate before any code execution
    oracle = MacOracle(binary)
    session, clock = read_session(game_log), Clock(debug_log)
    table = struct.unpack("<256I", binary.get(0x102337ec0, 1024))
    counts, errors, events, transport = collections.Counter(), [], [], []
    channels, seen, event_seen, actors = collections.Counter(), {}, {}, {}
    fragments = Fragments(counts)
    local_ports, dc, last_prune = set(), zstandard.ZstdDecompressor(), -math.inf
    for record, utc, frame in pcap_records(pcap, counts):
        # Same-frame observations <2ms apart are often PktMon duplicates. This
        # heuristic never rewrites originals or substitutes for TCP/IP semantics.
        digest = hashlib.sha256(frame).digest()
        old, seen[digest] = seen.get(digest), utc
        if old is not None and 0 <= utc - old <= .002:
            counts["duplicateRecordsHeuristic"] += 1
            continue
        if utc - last_prune > 2:
            seen = {key: value for key, value in seen.items() if utc - value <= 2}
            last_prune = utc
        base = {"record": record, "utc": utc_string(utc), **clock.align(utc)}
        try:
            parsed, excluded = udp_frame(frame, session)
            if parsed is None:
                counts["excluded:" + excluded] += 1
                continue
            direction, wire, local_port = parsed
            local_ports.add(local_port)
            if len(local_ports) > 1:
                raise RuntimeError("Multiple local sockets match the game log; isolate one game flow")
            counts["udpObservations"] += 1
            seq, flags, payload = decode_transport(wire, direction, session, table)
        except ValueError as exc:
            # These messages are fixed codes only, never tokens or raw input.
            counts[str(exc)] += 1
            errors.append({**base, "reason": str(exc)})
            continue
        counts["checksumPass"] += 1
        if len(wire) - (4 if direction == "in" else 12) >= 8:
            counts["encryptedDatagramsVerified"] += 1
        transport.append((record, utc, direction, seq))
        if flags & 128:
            try:
                declared = zstandard.frame_content_size(payload)
                if declared != zstandard.CONTENTSIZE_UNKNOWN and declared > 65536:
                    raise ValueError("decompressed-size-limit")
                payload = dc.decompress(payload, max_output_size=65536, allow_extra_data=False)
                if len(payload) > 65536:
                    raise ValueError("decompressed-size-limit")
                counts["zstdPass"] += 1
            except (ValueError, zstandard.ZstdError):
                counts["zstdFailure"] += 1
                errors.append({**base, "reason": "zstd-failure"})
                continue
        try:
            messages = unpack_messages(payload)
        except ValueError as exc:
            counts["framingFailure"] += 1
            errors.append({**base, "reason": str(exc)})
            continue
        counts["framingPass"] += 1
        for message in messages:
            counts["messageOccurrences"] += 1
            channels[f"{direction}:{message['channel']}"] += 1
            whole = fragments.feed(message, direction, utc, record)
            if whole is None or message["channel"] != 1:
                continue
            payload, records = whole
            try:
                pid, size = application_type(payload)
            except ValueError:
                counts["shortApplicationType"] += 1
                continue
            if not ((direction == "in" and pid in (662, 668, 673, 738)) or
                    (direction == "out" and pid == 1062)):
                continue
            duplicate = direction, message["channel"], message["sequence"], hashlib.sha256(payload).digest()
            if utc - event_seen.get(duplicate, -math.inf) <= 5:
                counts["repeatedCandidateMessages"] += 1
                continue
            event_seen[duplicate] = utc
            event_base = {**base, "packetRecords": records, "direction": direction,
                          "channel": message["channel"], "messageSequence": message["sequence"], "packetType": pid}
            if pid == 1062:
                fields = {"stage": "local-surrender-request", "teamRelation": "own",
                          "validation": "type-identified-in-command-sender-payload-not-decoded"}
            else:
                try:
                    fields = oracle.surrender(pid, payload[size:])
                except (ValueError, UcError):
                    counts["semanticRejections"] += 1
                    errors.append({**event_base, "reason": "exact-deserialization-or-consumer-rejected"})
                    continue
                if "teamId" in fields:
                    team = fields["teamId"]
                    fields["teamRelation"] = ("unknown" if clock.local_team is None or team not in (100, 200)
                                              else "own" if team == clock.local_team else "opponent")
                if "actorNetId" in fields:
                    actor = fields.pop("actorNetId")
                    fields["actor"] = actors.setdefault(actor, f"player-{len(actors) + 1}")
            events.append({**event_base, **fields})
    fragments.expire(math.inf)
    if not counts["encryptedDatagramsVerified"]:
        raise ValueError("No verified game datagrams; check capture, original log and supported build")
    gaps = acknowledgment_gaps(transport, clock)
    counts["acknowledgedSequencesNotObservedWithin5s"] = len(gaps)
    return {"schema": "ff-offline-16.20-v1", "binarySha256": BUILD_SHA256,
            "inputs": {"pcap": file_identity(pcap), "debugLog": file_identity(debug_log)},
            "gameModes": clock.modes, "localTeamId": clock.local_team,
            "alignment": "nearest API request midpoint within 5s; estimated game time, not chat time",
            "counts": dict(counts), "channels": dict(channels), "events": events,
            "apiGameEndEvents": clock.api_ends, "rejections": errors,
            "acknowledgmentCoverageGaps": gaps,
            "limitations": ["Only this exact macOS build is accepted; observed Windows compatibility is not universal.",
                            "Own-team evidence does not establish enemy-team visibility.",
                            "No automatic surrender action or live app decoder is enabled.",
                            "IPv6, IP fragments, unsupported packet blocks and incomplete message fragments are not decoded.",
                            "Packet duplication and 5-second fragment/ack windows are explicit analysis heuristics.",
                            "A missing decoded event is not evidence that the server did not send it.",
                            "Clock estimates may differ from chat or human timestamps; anchor latency is not a complete error bound."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pcap", type=Path, required=True)
    parser.add_argument("--debug-log", type=Path, required=True)
    parser.add_argument("--game-log", type=Path, required=True)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    inputs = (args.pcap, args.debug_log, args.game_log, args.binary)
    if args.output.resolve() in {p.resolve() for p in inputs}:
        parser.error("Output must not overwrite an input file")
    try:
        report = analyze(*inputs)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive creation protects original evidence and previous reports.
        with args.output.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2, allow_nan=False)
            stream.write("\n")
    except (ValueError, OSError, RuntimeError, UcError):
        parser.exit(1, "Analysis failed. Check input format, matching build/session, and an unused output path. Input contents withheld.\n")
    print(json.dumps({"counts": report["counts"], "eventStages": dict(collections.Counter(e["stage"] for e in report["events"]))}))


if __name__ == "__main__":
    main()
