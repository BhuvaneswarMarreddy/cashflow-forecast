"""The scheduled sync must be able to START. Stdlib-only (CI does not install
requirements.txt), so this pins the one dependency version that decides it."""
import pathlib
import re
import unittest


class SchedulerRuntime(unittest.TestCase):
    def test_firebase_functions_parses_cloud_schedulers_fractional_seconds(self):
        # firebase-functions 0.4.x parsed X-CloudScheduler-ScheduleTime with
        # '%Y-%m-%dT%H:%M:%S%z'. Cloud Scheduler sends microseconds
        # ('2026-09-15T11:00:03.317201-07:00'), so EVERY scheduled run of plaid_sync,
        # monarch_sync and firestore_backup raised ValueError inside the wrapper,
        # before our code ran: no scheduled bank pull, no backup, and a newly linked
        # Schwab Item never synced. 0.5.0 parses it with datetime.fromisoformat.
        text = (pathlib.Path(__file__).parent / "requirements.txt").read_text()
        m = re.search(r"^firebase-functions==(\d+)\.(\d+)\.(\d+)$", text, re.M)
        self.assertIsNotNone(m, "firebase-functions must stay pinned exactly")
        self.assertGreaterEqual(tuple(int(x) for x in m.groups()), (0, 5, 0))


if __name__ == "__main__":
    unittest.main()
