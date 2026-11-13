import copy
from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from collector.publisher import Publisher


class Api:
    def __init__(self):
        self.observations = []
        self.events = []

    def post(self, path, **kwargs):
        if path == "/api/observations":
            self.observations.append(copy.deepcopy(kwargs["json"]))
            return {"events": self.events}
        return {}


def obs(seconds, label=None, camera="iowa-cbtv51"):
    return {"camera_id": camera, "frame_id": str(seconds),
            "captured_at": datetime.fromtimestamp(1800000000 + seconds, timezone.utc).isoformat(),
            "model": "test-fixture", "clock": "collector_arrival",
            "detections": [] if label is None else [{"label": label, "score": .95, "box": [.1, .1, .2, .2]}]}


class PublicationTests(unittest.TestCase):
    def test_quiet_day_spends_96_not_17280_records(self):
        with tempfile.TemporaryDirectory() as d:
            api = Api(); p = Publisher(api, Path(d) / "ledger.json")
            # Start at UTC midnight so the sample remains in one quota day.
            start = obs(0); base = datetime.fromisoformat(start["captured_at"]).replace(hour=0, minute=0, second=0).timestamp()
            for i in range(17280):
                o = obs(i * 5); o["captured_at"] = datetime.fromtimestamp(base + i * 5, timezone.utc).isoformat()
                p.handle(o, b"jpeg")
            self.assertEqual(len(api.observations), 96)

    def test_pair_requires_fresh_distinct_same_camera_frames(self):
        for gap, camera, count in [(5, 'iowa-cbtv51', 2), (7, 'iowa-cbtv51', 0), (5, 'other', 0), (0, 'iowa-cbtv51', 0)]:
            with self.subTest(gap=gap, camera=camera), tempfile.TemporaryDirectory() as d:
                api = Api(); p = Publisher(api, Path(d) / 'ledger.json')
                p.handle(obs(0, 'fire'), b'a'); p.handle(obs(gap, 'fire', camera), b'b')
                self.assertEqual(len(api.observations), count)
                if count: self.assertEqual(api.observations[0]['detections'][0]['label'], 'fire')

    def test_restart_preserves_budget_and_cooldown(self):
        with tempfile.TemporaryDirectory() as d:
            api = Api(); path = Path(d) / 'ledger.json'
            p = Publisher(api, path); p.handle(obs(0, 'fire'), b'a'); p.handle(obs(5, 'fire'), b'b')
            p = Publisher(api, path); p.handle(obs(10, 'fire'), b'c'); p.handle(obs(15, 'fire'), b'd')
            self.assertEqual(p.state['records'], 2)
            self.assertEqual(len(api.observations), 2)

    def test_record_cap_fails_before_partial_pair_and_reserves_network_failures(self):
        with tempfile.TemporaryDirectory() as d:
            api = Api(); path = Path(d) / 'ledger.json'; p = Publisher(api, path, daily_records=2)
            p.handle(obs(0), b'a'); p.handle(obs(5, 'fire'), b'b')
            with self.assertRaisesRegex(RuntimeError, 'confirmation pair'): p.handle(obs(10, 'fire'), b'c')
            self.assertEqual(len(api.observations), 1)
            def fail(*args, **kwargs): raise ConnectionError('fixture')
            api.post = fail
            with self.assertRaises(ConnectionError): p.handle(obs(1000), b'c')
            self.assertEqual(Publisher(api, path).state['records'], 2)


if __name__ == '__main__': unittest.main(verbosity=2)
