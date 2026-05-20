"""Tests for token-efficient prompt assembly."""

from __future__ import annotations

import unittest

from prompt_optimization import (
    attachment_priority,
    build_diagnose_followup_digest,
    expand_user_message_with_workspace,
    sort_workspace_files,
    workspace_files_manifest,
)


class PromptOptimizationTests(unittest.TestCase):
    def test_attachment_priority_logs_first(self) -> None:
        paths = sort_workspace_files(
            [
                "users/1/w/1/uploads/readme.txt",
                "users/1/w/1/diagnostics/host/nginx_logs.txt",
                "users/1/w/1/issue_analysis.html",
            ]
        )
        self.assertEqual(paths[0], "users/1/w/1/issue_analysis.html")
        self.assertTrue(any("diagnostics" in p for p in paths[1:]))
        self.assertGreater(attachment_priority(paths[0]), attachment_priority(paths[-1]))

    def test_expand_respects_char_budget(self) -> None:
        def fake_expand(rel: str, _uid: int) -> str:
            return f"BLOCK:{rel}:" + ("x" * 12_000)

        out = expand_user_message_with_workspace(
            "hello",
            [f"users/1/w/1/f{i}.log" for i in range(30)],
            1,
            fake_expand,
        )
        self.assertIn("hello", out)
        self.assertIn("Additional workspace files", out)
        self.assertLessEqual(out.count("BLOCK:"), 20)

    def test_manifest_omits_expansion(self) -> None:
        m = workspace_files_manifest("prior question", ["users/1/w/1/a.log", "users/1/w/1/b.log"])
        self.assertIn("earlier message", m)
        self.assertNotIn("Local analysis", m)

    def test_diagnose_digest_compact(self) -> None:
        activity = [f"step {i}" for i in range(200)]
        activity.append("[Reasoning] Critical database lock detected")
        attached = [
            {
                "diagnostics": True,
                "name": "prod",
                "host": "10.0.0.1",
                "port": 22,
                "username": "ubuntu",
                "status": "ok",
                "findings": ["Odoo logs contain 3 error keywords"],
                "artifact_paths": ["users/1/w/1/diagnostics/prod/nginx_logs.txt"],
            }
        ]
        digest = build_diagnose_followup_digest("app slow", attached, activity)
        self.assertIn("Top 5 findings", digest)
        self.assertIn("Critical database lock", digest)
        self.assertNotIn("step 0", digest)
        self.assertIn("nginx_logs.txt", digest)


if __name__ == "__main__":
    unittest.main()
