"""Synthetic ROFL2 tests; no real replay content is included."""

import json
import struct
import tempfile
import unittest
from pathlib import Path

import zstandard

from ff_replay_votes import analyze, iter_blocks, read_replay

HEROES = [0x400000ae + i for i in range(10)]
YES, UNLOCK = b"\xfe", b"\xff"


def block(time, packet, param, payload):
    return struct.pack("<BfIHI", 0, time, len(payload), packet, param) + payload


def replay(blocks, roster, length=1130.0):
    body = b"".join(block(*b) for b in blocks)
    frame = zstandard.ZstdCompressor().compress(body)
    entry = struct.pack("<IIBII", 1, 2, 1, len(body), len(frame)) + frame + bytes(34)
    version = b"16.14.794.5912"
    meta = {"gameLength": int(length * 1000), "lastGameChunkId": 1, "lastKeyFrameId": 0,
            "statsJson": json.dumps(roster)}
    return b"RIOT\x02\x00" + bytes(8) + bytes([len(version)]) + version + entry + json.dumps(meta).encode()


def roster(loser, surrendered):
    return [{"TEAM": str(team), "WIN": "Fail" if team == loser else "Win",
             "GAME_ENDED_IN_SURRENDER": "1" if surrendered else "0", "NAME": "hidden"}
            for team in [100] * 5 + [200] * 5]


def vote(time, actor, copies=5):
    return [(time, 891, 0, bytes([i]) * 12) for i in range(copies)] + [(time, 765, actor, YES)]


def game(copies=5):
    rows = [(900.02, 765, hero, UNLOCK) for hero in HEROES]
    rows += [(t, 556, 0, b"tick" * 6) for t in (903.66, 904.762, 1118.07, 1120.375)]
    rows += vote(903.66, HEROES[6], copies) + vote(904.762, HEROES[7], copies)
    rows += [(928.68, 568, 0, b"fail00"), (928.68, 765, HEROES[5], YES)]
    rows += vote(1118.07, HEROES[8], copies) + vote(1120.375, HEROES[9], copies)
    rows += [(1120.375, 568, 0, b"agreed!"), (1125.4, 696, HEROES[0], b"\x01")]
    return sorted(rows, key=lambda r: r[0])


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp.cleanup()

    def write(self, data):
        path = Path(self.temp.name) / "EUW1-1.rofl"
        path.write_bytes(data)
        return path

    def test_relative_block_fields_and_signed_param_delta(self):
        data = (struct.pack("<BfIHI", 0, 10.0, 1, 765, 0x400000b6) + b"\xff" +
                bytes([0xf0, 5, 1, 0xfd]) + b"\xfe")
        rows = list(iter_blocks(data))
        self.assertEqual([(r[1], r[2], r[3]) for r in rows],
                         [(765, 0x400000b6, b"\xff"), (765, 0x400000b3, b"\xfe")])
        self.assertAlmostEqual(rows[1][0], 10.005)

    def test_truncated_block_is_rejected(self):
        with self.assertRaises(ValueError):
            list(iter_blocks(struct.pack("<BfIHI", 0, 1.0, 9, 1, 0) + b"short"))

    def test_reads_frames_and_metadata(self):
        version, frames, meta = read_replay(self.write(replay(game(), roster(200, True))))
        self.assertEqual(version, "16.14.794.5912")
        self.assertEqual([(cid, kind) for cid, kind, _ in frames], [(1, 1)])
        self.assertEqual(meta["gameLength"], 1130000)

    def test_identifies_vote_routing_and_outcomes(self):
        report = analyze(self.write(replay(game(), roster(200, True))))
        self.assertEqual(report["packetTypes"], {"eligibility": 765, "vote": 891, "announcement": 568})
        self.assertEqual(report["surrenderUnlockGameTime"], 900.02)
        self.assertEqual(report["recipientCopiesPerVoteMessage"], [5])
        windows = report["voteWindows"]
        self.assertEqual([(w["team"], w["outcome"], w["announcementAt"]) for w in windows],
                         [(200, "failed", 928.68), (200, "accepted", 1120.375)])
        self.assertEqual(windows[0]["messages"][0]["eligibilityChangedFor"], ["team200-p2"])
        self.assertAlmostEqual(windows[1]["acceptedToGameEndSeconds"], 9.625)
        self.assertIn("no copies for the opposing team", report["interpretation"])
        self.assertNotIn("hidden", json.dumps(report))

    def test_broadcast_copy_count_is_not_misreported_as_team_only(self):
        report = analyze(self.write(replay(game(copies=10), roster(200, True))))
        self.assertEqual(report["packetTypes"]["vote"], 891)
        self.assertEqual(report["recipientCopiesPerVoteMessage"], [10])
        self.assertIn("opponents receive them", report["interpretation"])

    def test_game_without_votes(self):
        rows = [(480.03, 765, hero, UNLOCK) for hero in HEROES] + [(500.0, 556, 0, b"x" * 20)]
        report = analyze(self.write(replay(rows, roster(100, False), 990.0)))
        self.assertEqual(report["packetTypes"]["eligibility"], 765)
        self.assertEqual(report["interpretation"], "No surrender vote messages in this replay.")


if __name__ == "__main__":
    unittest.main()
