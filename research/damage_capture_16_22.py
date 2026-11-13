"""Inspect a local 16.22 capture for damage events and measure capture gaps.

The original r3d log supplies private session material locally. Reports contain
no keys, endpoint addresses, account names, raw packets or raw network IDs.
"""
import argparse
import bisect
import collections
import hashlib
import heapq
import json
import math
import struct
from pathlib import Path

import zstandard
from unicorn import UcError
from damage_oracle_16_22 import MachO, MacOracle
from ff_live_16_20 import (read_session, game_log_version, pcap_records, udp_frame,
                          decode_transport, unpack_messages, application_type,
                          Fragments, timestamp, utc_string, acknowledgment_gaps)


class DamageClock:
    def __init__(self, file):
        self.anchors = []
        with Path(file).open(encoding="utf-8") as stream:
            for line in stream:
                row = json.loads(line)
                if row.get("kind") != "sample":
                    continue
                value = row.get("gameTime")
                if not isinstance(value, (int, float)) or not math.isfinite(value):
                    continue
                start, end = timestamp(row["requestedAt"]), timestamp(row["at"])
                if end >= start:
                    self.anchors.append(((start + end) / 2, value, (end - start) * 1000))
        self.anchors.sort()
        self.times = [a[0] for a in self.anchors]

    def align(self, utc):
        i = bisect.bisect_left(self.times, utc)
        choices = self.anchors[max(0, i - 1):i + 1]
        if choices:
            anchor, value, latency = min(choices, key=lambda a: abs(utc - a[0]))
            if abs(utc - anchor) < 5:
                return {"gameTimeEstimate": round(value + utc - anchor, 6),
                        "anchorDistanceSeconds": round(abs(utc - anchor), 6),
                        "anchorRequestDurationMs": round(latency, 3)}
        return {"gameTimeEstimate": None}


def application_packets(payload, oracle, counts, path=()):
    """Yield exact packet boundaries, including explicitly decoded batches."""
    try:
        packet_id, offset = application_type(payload)
    except ValueError:
        counts['applicationTypeRejected'] += 1
        return
    if packet_id != 1045:
        yield packet_id, payload[offset:], path
        return
    if len(path) >= 2:
        counts['batchDepthLimit'] += 1
        return
    try:
        children = oracle.unpack_batch(payload[offset:])
    except (ValueError, UcError):
        counts['batchRejected'] += 1
        return
    counts['batchDecoded'] += 1
    for i, child in enumerate(children):
        yield from application_packets(child, oracle, counts, path + (i,))


def analyze(pcap, observations, game_log, binary_path, raw_pcap=None):
    binary = MachO(binary_path)
    oracle = MacOracle(binary)
    if game_log_version(game_log) != oracle.version:
        raise ValueError("Original game log must match the exact 16.22 decoder build")
    session, clock = read_session(game_log), DamageClock(observations)
    table = struct.unpack("<256I", binary.get(oracle.checksum_table, 1024))
    counts, packet_types = collections.Counter(), collections.Counter()
    flows, seen, events, stat_events, actors = {}, {}, [], [], {}
    known_targets = {}
    rejection_samples = []
    dc = zstandard.ZstdDecompressor()
    last_prune = -math.inf
    frames = pcap_records(pcap, counts)
    if raw_pcap is not None:
        raw_frames = ((-record, utc, frame) for record, utc, frame in pcap_records(raw_pcap, counts))
        frames = heapq.merge(frames, raw_frames, key=lambda row: row[1])
    for record, utc, frame in frames:
        if utc - last_prune > 5:
            seen = {k: v for k, v in seen.items() if utc - v <= 5}
            last_prune = utc
        try:
            parsed, excluded = udp_frame(frame, session)
            if parsed is None:
                counts['excluded:' + excluded] += 1
                continue
            direction, wire, port = parsed
            flow = flows.setdefault(port, {"id": f"flow-{len(flows) + 1}",
                                          "fragments": Fragments(counts), "transport": []})
            seq, flags, body = decode_transport(wire, direction, session, table)
            counts['checksumPass'] += 1
            counts['checksumPassRawIp' if record < 0 else 'checksumPassPrimary'] += 1
            flow['transport'].append((record, utc, direction, seq))
            if len(wire) - (4 if direction == 'in' else 12) >= 8:
                counts['encryptedDatagramsVerified'] += 1
            duplicate = (port, direction, seq, hashlib.sha256(wire).digest())
            if utc - seen.get(duplicate, -math.inf) <= 5:
                counts['duplicateDatagramsWithin5s'] += 1
                continue
            seen[duplicate] = utc
            if flags & 128:
                declared = zstandard.frame_content_size(body)
                if declared != zstandard.CONTENTSIZE_UNKNOWN and declared > 65536:
                    raise ValueError('decompression-limit')
                body = dc.decompress(body, max_output_size=65536, allow_extra_data=False)
                if len(body) > 65536:
                    raise ValueError('decompression-limit')
            messages = unpack_messages(body)
        except (ValueError, zstandard.ZstdError) as error:
            counts['transportOrFramingRejected'] += 1
            reason = 'zstdRejected' if isinstance(error, zstandard.ZstdError) else str(error)
            counts[reason] += 1
            if len(rejection_samples) < 20:
                rejection_samples.append({'record': record, 'reason': reason, **clock.align(utc)})
            continue
        for message in messages:
            whole = flow['fragments'].feed(message, direction, utc, record)
            if whole is None:
                continue
            payload, records = whole
            if direction != 'in':
                continue
            identity = (port, direction, message['channel'], message['sequence'], hashlib.sha256(payload).digest())
            if utc - seen.get(identity, -math.inf) <= 5:
                counts['duplicateMessagesWithin5s'] += 1
                continue
            seen[identity] = utc
            for packet_id, data, batch_path in application_packets(payload, oracle, counts):
                packet_types[f"{direction}:{message['channel']}:{packet_id}"] += 1
                if packet_id in (43, 1193):
                    try:
                        if packet_id == 43:
                            target = oracle.spawned_practice_dummy(data)
                            kind = 'practice-dummy'
                        else:
                            target = oracle.spawned_wolf(data)
                            kind = 'neutral-wolf'
                        if target:
                            known_targets[target] = kind
                    except (ValueError, UcError):
                        counts['targetSpawnRejected'] += 1
                if packet_id not in (393, 743):
                    continue
                try:
                    fields = oracle.candidate_damage(data) if packet_id == 393 else oracle.damage_stat_event(data)
                except (ValueError, UcError):
                    counts['candidateRejected' if packet_id == 393 else 'statEventRejected'] += 1
                    continue
                if fields is None:
                    counts['unrelatedStatEvent'] += 1
                    continue
                for name in ('candidateSourceNetId', 'candidateTargetNetId'):
                    value = fields.pop(name)
                    fields[name.replace('NetId', '')] = actors.setdefault(value, f"unit-{len(actors) + 1}") if value else None
                event = {"record": record, "packetRecords": records, "utc": utc_string(utc),
                         **clock.align(utc), "flow": flow['id'], "channel": message['channel'],
                         "batchPath": batch_path, **fields}
                (events if packet_id == 393 else stat_events).append(event)
                if len(events) + len(stat_events) > 200000:
                    raise ValueError('Candidate limit exceeded')
    for flow in flows.values():
        flow['fragments'].expire(math.inf)
    if not counts['encryptedDatagramsVerified']:
        raise ValueError('No verified encrypted game datagrams in this capture')
    gaps = [{**gap, "flow": f['id']} for f in flows.values()
            for gap in acknowledgment_gaps(f['transport'], clock)]
    missing_by_direction = collections.Counter(gap['unobservedDirection'] for gap in gaps)
    return {"schema": "damage-candidates-v2", "decoderVersion": oracle.version,
            "binarySha256": binary.sha256, "sourceValidated": False,
            "counts": dict(counts), "packetTypes": dict(packet_types), "candidates": events,
            "damageStatEvents": stat_events,
            "observedTargetKinds": {actors[target]: kind for target, kind in known_targets.items() if target in actors},
            "acknowledgedSequencesNotObserved": dict(missing_by_direction),
            "acknowledgmentCoverageGaps": gaps,
            "transportRejectionSamples": rejection_samples,
            "limitations": ["Candidate fields require independent visible damage ground truth.",
                            "Practice dummies and Rift wolves can be identified from their spawn. General target and local-player ownership are unverified.",
                            "Physical and magic damage matched the controlled tests. True damage, shields, overkill and result codes need separate validation.",
                            "Timestamps use nearest API request midpoint within five seconds; not server combat timestamps.",
                            "Five-second deduplication/fragment windows are heuristics; retransmissions outside them can remain.",
                            "Unsupported IP/link formats and missing fragments are coverage gaps.",
                            "This report must not be presented as a damage total or evidence of full team coverage."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--session', type=Path, required=True)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    capture_source = parser.add_mutually_exclusive_group()
    capture_source.add_argument('--raw-pcap', type=Path, help='Merge an IP-layer capture from the same session')
    capture_source.add_argument('--raw-only', action='store_true', help='Analyze only the IP-layer capture')
    args = parser.parse_args()
    primary = args.session / ('raw-ipv4.pcapng' if args.raw_only else 'observations.packets/packets.pcapng')
    report = analyze(primary,
                     args.session / 'observations.jsonl', args.session / 'original-r3dlog.txt', args.binary, args.raw_pcap)
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
    print(json.dumps({"candidateCount": len(report['candidates']), "damageStatEventCount": len(report['damageStatEvents']),
                      "acknowledgedSequencesNotObserved": report['acknowledgedSequencesNotObserved'],
                      "counts": report['counts'], "sourceValidated": False}))


if __name__ == '__main__':
    main()
