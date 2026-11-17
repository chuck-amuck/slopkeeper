"""Tests for custom.py. Run with: python3 -m unittest discover -s voice -p '*_test.py'"""

import hashlib
import io
import json
import os
import tempfile
import unittest

import custom

MODEL = "https://huggingface.co/someone/voice/resolve/0123456789abcdef0123456789abcdef01234567/voice.onnx"
ONNX = b"model bytes"
CONFIG = b'{"phoneme_id_map": {}}'


def opener(files):
    asked = []

    def open_url(url, timeout):
        asked.append(url)
        return io.BytesIO(files[url])

    return open_url, asked


class Entries(unittest.TestCase):
    def test_unset_or_empty_is_no_voices(self):
        for raw in (None, "", "  "):
            self.assertEqual(custom.entries(raw), ([], []))

    def test_the_config_defaults_to_the_model_address_plus_json(self):
        voices, skipped = custom.entries(json.dumps([{"id": "x", "name": "X", "model": MODEL + "?download=true"}]))
        self.assertEqual(skipped, [])
        self.assertEqual(voices[0]["config"], MODEL + ".json?download=true")
        self.assertIsNone(voices[0]["sha256"])

    def test_bad_entries_are_skipped_with_a_reason_and_the_rest_kept(self):
        raw = json.dumps(
            [
                {"id": "Bad Id", "name": "X", "model": MODEL},
                {"id": "newline\n", "name": "X", "model": MODEL},
                {"id": "plain", "name": "X", "model": "http://example.com/v.onnx"},
                {"id": "hash", "name": "X", "model": MODEL, "sha256": "a" * 64 + "\n"},
                {"id": "nameless", "model": MODEL},
                "text",
                {"id": "good", "name": "Good", "model": MODEL, "sha256": "A" * 64, "config": ""},
                {"id": "good", "name": "Again", "model": MODEL},
                # The first entry with an id is the one, even when it can't be used, as the bot takes the first too
                {"id": "nameless", "name": "Fixed", "model": MODEL},
            ]
        )
        voices, skipped = custom.entries(raw)
        self.assertEqual([v["id"] for v in voices], ["good"])
        self.assertEqual(voices[0]["sha256"], "a" * 64)
        self.assertEqual(voices[0]["config"], MODEL + ".json")
        self.assertEqual(len(skipped), 8)

    def test_not_json_or_not_a_list_says_so(self):
        self.assertIn("isn't valid JSON", custom.entries("[{")[1][0])
        self.assertIn("isn't a list", custom.entries('{"id": "x"}')[1][0])


class Fetch(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.voice = custom.entries(json.dumps([{"id": "x", "name": "X", "model": MODEL}]))[0][0]

    def test_fetches_once_and_again_only_when_the_address_changes(self):
        open_url, asked = opener({MODEL: ONNX, MODEL + ".json": CONFIG})
        note = custom.fetch(self.voice, self.folder, open_url)
        self.assertIn(hashlib.sha256(ONNX).hexdigest(), note)
        self.assertNotIn("no commit", note)
        with open(os.path.join(self.folder, "custom-x.onnx"), "rb") as file:
            self.assertEqual(file.read(), ONNX)
        self.assertIsNone(custom.fetch(self.voice, self.folder, open_url))
        self.assertEqual(len(asked), 2)
        moved = {**self.voice, "model": "https://example.com/main/v.onnx", "config": "https://example.com/main/v.onnx.json"}
        open_url, asked = opener({moved["model"]: ONNX, moved["config"]: CONFIG})
        self.assertIn("no commit", custom.fetch(moved, self.folder, open_url))
        self.assertEqual(len(asked), 2)

    def test_a_wrong_hash_or_a_file_thats_not_a_voice_keeps_nothing(self):
        open_url, _ = opener({MODEL: ONNX, MODEL + ".json": CONFIG})
        with self.assertRaisesRegex(ValueError, "not the one given"):
            custom.fetch({**self.voice, "sha256": "0" * 64}, self.folder, open_url)
        open_url, _ = opener({MODEL: ONNX, MODEL + ".json": b"<html>"})
        with self.assertRaisesRegex(ValueError, "isn't a Piper voice"):
            custom.fetch(self.voice, self.folder, open_url)
        self.assertEqual(os.listdir(self.folder), [])

    def test_pinning_a_hash_later_checks_the_files_again(self):
        open_url, asked = opener({MODEL: ONNX, MODEL + ".json": CONFIG})
        custom.fetch(self.voice, self.folder, open_url)
        with self.assertRaisesRegex(ValueError, "not the one given"):
            custom.fetch({**self.voice, "sha256": "0" * 64}, self.folder, open_url)
        self.assertEqual(len(asked), 3)

    def test_a_list_with_a_problem_deletes_nothing(self):
        open(os.path.join(self.folder, "custom-old.onnx"), "w").close()
        os.environ["CUSTOM_VOICES"] = "[{"
        try:
            custom.main(self.folder)
        finally:
            del os.environ["CUSTOM_VOICES"]
        self.assertEqual(os.listdir(self.folder), ["custom-old.onnx"])

    def test_a_pinned_voice_logs_no_hashes(self):
        open_url, _ = opener({MODEL: ONNX, MODEL + ".json": CONFIG})
        pinned = {**self.voice, "sha256": hashlib.sha256(ONNX).hexdigest(), "configSha256": hashlib.sha256(CONFIG).hexdigest()}
        self.assertEqual(custom.fetch(pinned, self.folder, open_url), "Fetched the custom voice x")

    def test_voices_no_longer_listed_are_deleted_and_others_kept(self):
        for name in ("custom-x.onnx", "custom-old.onnx", "custom-old.onnx.json", "custom-old.source", "glados.onnx"):
            open(os.path.join(self.folder, name), "w").close()
        self.assertEqual(custom.forget_unlisted([self.voice], self.folder), ["old"])
        self.assertEqual(sorted(os.listdir(self.folder)), ["custom-x.onnx", "glados.onnx"])


if __name__ == "__main__":
    unittest.main()
