"""backup unit tests — stdlib only, no network, mirroring test_plaid's style.

The claim worth pinning is that the export covers EVERYTHING. A backup that quietly
skips a collection is discovered during a restore, which is the worst possible moment.
"""
import unittest

import backup


class OutputUri(unittest.TestCase):
    def test_one_dated_folder_per_day(self):
        self.assertEqual(
            backup.output_uri("my-bucket", "2026-08-08"),
            "gs://my-bucket/firestore-backups/2026-08-08")

    def test_rerunning_a_day_overwrites_rather_than_growing_a_second_copy(self):
        a = backup.output_uri("b", "2026-08-08")
        b = backup.output_uri("b", "2026-08-08")
        self.assertEqual(a, b)


class ExportBody(unittest.TestCase):
    def test_defaults_to_the_whole_database(self):
        body = backup.export_body("b", "2026-08-08")
        # No collectionIds at all means "everything". Naming them would create a second
        # list to keep in step with USER_SUBCOLLECTIONS, and a collection missing from
        # that list would be missing from every backup, silently.
        self.assertNotIn("collectionIds", body)
        self.assertEqual(body["outputUriPrefix"], "gs://b/firestore-backups/2026-08-08")

    def test_named_collections_are_honoured_when_given(self):
        body = backup.export_body("b", "2026-08-08", ["users"])
        self.assertEqual(body["collectionIds"], ["users"])


class RunBackup(unittest.TestCase):
    def test_posts_to_the_export_endpoint_and_returns_the_operation(self):
        seen = {}

        def fake_post(url, body, token, timeout=120):
            seen.update(url=url, body=body, token=token)
            return {"name": "projects/p/operations/op123"}

        out = backup.run_backup("p", "b", "2026-08-08",
                                post=fake_post, token=lambda: "tok")

        self.assertTrue(seen["url"].endswith("/v1/projects/p/databases/(default):exportDocuments"))
        self.assertEqual(seen["token"], "tok")
        self.assertEqual(out["operation"], "projects/p/operations/op123")
        self.assertEqual(out["outputUriPrefix"], "gs://b/firestore-backups/2026-08-08")

    def test_failure_propagates_so_the_invocation_is_marked_failed(self):
        def failing_post(url, body, token, timeout=120):
            raise RuntimeError("PERMISSION_DENIED")

        # A backup that quietly stopped running is worse than no backup: it is a
        # restore point you believe you have.
        with self.assertRaises(RuntimeError):
            backup.run_backup("p", "b", "2026-08-08",
                              post=failing_post, token=lambda: "tok")


if __name__ == "__main__":
    unittest.main()
