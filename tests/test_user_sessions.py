"""Tests for per-user session recording."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import user_sessions as us
from chat3 import WORKSPACE_DIR


class UserSessionsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.workspace_dir = Path(self._tmpdir.name) / "workspace"
        self.workspace_dir.mkdir(parents=True)

    def _patch_workspace(self):
        return patch.object(us, "WORKSPACE_DIR", self.workspace_dir)

    def test_record_and_archive_on_clear(self) -> None:
        user_id = 7
        ws_id = 3
        ws_name = "Demo"
        messages = [{"id": "1", "role": "user", "content": "hello"}]

        with self._patch_workspace():
            us.record_user_session(user_id, ws_id, ws_name, messages)
            current = us._project_current_path(user_id, ws_id)
            self.assertTrue(current.is_file())
            saved = json.loads(current.read_text(encoding="utf-8"))
            self.assertEqual(saved["workspace_name"], ws_name)
            self.assertEqual(len(saved["messages"]), 1)

            us.record_user_session(user_id, ws_id, ws_name, [])
            archive_dir = us.user_sessions_root(user_id) / "archive"
            archives = list(archive_dir.glob("*.json"))
            self.assertEqual(len(archives), 1)
            archived = json.loads(archives[0].read_text(encoding="utf-8"))
            self.assertEqual(archived["message_count"], 1)

            index = json.loads(us._sessions_index_path(user_id).read_text(encoding="utf-8"))
            self.assertEqual(len(index["archives"]), 1)
            self.assertEqual(index["projects"][0]["message_count"], 0)

    def test_sync_from_workspace_chat_messages(self) -> None:
        user_id = 2
        ws_id = 5
        chat_path = self.workspace_dir / "users" / "2" / "w" / "5" / "chat_messages.json"
        chat_path.parent.mkdir(parents=True)
        chat_path.write_text(
            json.dumps({"messages": [{"id": "a", "role": "user", "content": "sync me"}]}),
            encoding="utf-8",
        )

        class FakeWs:
            id = ws_id
            name = "Imported"

        with self._patch_workspace(), patch("user_db.list_workspaces", return_value=[FakeWs()]):
            us.sync_user_sessions_from_workspaces(user_id)

        current = us._project_current_path(user_id, ws_id)
        self.assertTrue(current.is_file())
        payload = json.loads(current.read_text(encoding="utf-8"))
        self.assertEqual(payload["messages"][0]["content"], "sync me")


if __name__ == "__main__":
    unittest.main()
