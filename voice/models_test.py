"""Tests for models.py. Run with: python3 -m unittest discover -s voice -p '*_test.py'"""

import hashlib
import io
import json
import os
import tempfile
import unittest
import urllib.error
import urllib.request

import models

MODEL = "https://huggingface.co/someone/voice/resolve/main/voice.onnx"
ONNX = b"model bytes"
CONFIG = json.dumps({"phoneme_id_map": {}, "num_speakers": 2, "speaker_id_map": {"b": 1, "a": 0}}).encode()


class Response(io.BytesIO):
    def __init__(self, data, length=True):
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data))} if length else {}


def opener(files, length=True):
    asked = []

    def open_url(url, timeout):
        asked.append(url)
        if url not in files:
            raise OSError("404")
        return Response(files[url], length)

    return open_url, asked


def voice(**fields):
    return {"id": "x", "model": MODEL, **fields}


class Checked(unittest.TestCase):
    def test_the_config_defaults_to_the_model_address_plus_json(self):
        got, problem = models.checked(voice(model=MODEL + "?download=true"))
        self.assertIsNone(problem)
        self.assertEqual(got["config"], MODEL + ".json?download=true")

    def test_bad_entries_say_why(self):
        for entry in ("text", {"id": "Bad Id", "model": MODEL}, voice(model="http://example.com/v.onnx"), voice(sha256="a" * 63)):
            self.assertIsNone(models.checked(entry)[0])
        self.assertEqual(models.checked(voice(sha256="A" * 64))[0]["sha256"], "a" * 64)

    def test_the_file_name_changes_with_where_it_comes_from(self):
        one = models.file_for(models.checked(voice())[0])
        self.assertTrue(one.startswith("voice-x-"))
        self.assertNotEqual(one, models.file_for(models.checked(voice(model=MODEL + "2"))[0]))
        self.assertNotEqual(one, models.file_for(models.checked(voice(sha256="a" * 64))[0]))


class Syncing(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.logged = []

    def models(self, files, **kw):
        open_url, asked = opener(files, **kw)
        return models.Models(self.folder, open_url, self.logged.append), asked

    def test_downloads_what_is_listed_and_says_its_speakers(self):
        m, asked = self.models({MODEL: ONNX, MODEL + ".json": CONFIG})
        self.assertEqual(m.set([voice()], "v1")["voices"]["x"], {"state": "waiting"})
        m.run_once()
        state = m.report()["voices"]["x"]
        self.assertEqual(state["state"], "ready")
        self.assertEqual(state["speakers"], [{"id": 0, "name": "a"}, {"id": 1, "name": "b"}])
        with open(os.path.join(self.folder, f"{state['file']}.onnx"), "rb") as file:
            self.assertEqual(file.read(), ONNX)
        # The config first, so a link to something else fails before the big download
        self.assertEqual(asked, [MODEL + ".json", MODEL])
        self.assertNotIn(".part", "".join(os.listdir(self.folder)))

    def test_a_restart_keeps_the_list_and_what_was_downloaded(self):
        m, _ = self.models({MODEL: ONNX, MODEL + ".json": CONFIG})
        m.set([voice()], "v1")
        m.run_once()
        again, asked = self.models({})
        self.assertEqual(again.report()["version"], "v1")
        self.assertEqual(again.report()["voices"]["x"]["state"], "ready")
        again.run_once()
        self.assertEqual(asked, [])

    def test_a_wrong_hash_a_page_or_a_missing_file_fails_with_a_reason_and_keeps_nothing(self):
        cases = [
            ({MODEL: ONNX, MODEL + ".json": CONFIG}, voice(sha256="0" * 64), "sha256"),
            ({MODEL: ONNX, MODEL + ".json": b"<html>"}, voice(), "isn't a Piper voice"),
            ({MODEL: ONNX, MODEL + ".json": b"{}"}, voice(), "isn't a Piper voice"),
            ({MODEL + ".json": CONFIG}, voice(), "Couldn't download"),
        ]
        for files, entry, reason in cases:
            m, _ = self.models(files)
            m.set([entry], "v")
            m.run_once()
            state = m.report()["voices"]["x"]
            self.assertEqual(state["state"], "failed", reason)
            self.assertIn(reason, state["error"])
            self.assertEqual(sorted(os.listdir(self.folder)), ["managed.json"])

    def test_too_big_stops_without_reading_the_rest(self):
        old = models.MOST_BYTES
        models.MOST_BYTES = 4
        try:
            for length in (True, False):
                m, _ = self.models({MODEL: ONNX, MODEL + ".json": CONFIG}, length=length)
                m.set([voice()], "v")
                m.run_once()
                self.assertIn("MB", m.report()["voices"]["x"]["error"])
        finally:
            models.MOST_BYTES = old

    def test_unlisted_voices_are_deleted_and_built_in_models_kept(self):
        m, _ = self.models({MODEL: ONNX, MODEL + ".json": CONFIG})
        m.set([voice()], "v1")
        m.run_once()
        open(os.path.join(self.folder, "glados.onnx"), "w").close()
        m.set([], "v2")
        self.assertEqual(sorted(os.listdir(self.folder)), ["glados.onnx", "managed.json"])

    def test_a_changed_link_downloads_new_files_and_drops_the_old(self):
        moved = "https://example.com/other.onnx"
        m, _ = self.models({MODEL: ONNX, MODEL + ".json": CONFIG, moved: ONNX, moved + ".json": CONFIG})
        m.set([voice()], "v1")
        m.run_once()
        first = m.report()["voices"]["x"]["file"]
        m.set([voice(model=moved)], "v2")
        m.run_once()
        second = m.report()["voices"]["x"]["file"]
        self.assertNotEqual(first, second)
        self.assertEqual(sorted(os.listdir(self.folder)), sorted(["managed.json", f"{second}.onnx", f"{second}.onnx.json"]))

    def test_a_pinned_hash_that_matches_is_kept(self):
        sha = hashlib.sha256(ONNX).hexdigest()
        m, _ = self.models({MODEL: ONNX, MODEL + ".json": CONFIG})
        m.set([voice(sha256=sha)], "v")
        m.run_once()
        self.assertEqual(m.report()["voices"]["x"]["state"], "ready")

    def test_sending_the_list_again_doesnt_retry_a_failure_or_restart_a_download(self):
        m, asked = self.models({MODEL: ONNX})
        m.set([voice()], "v1")
        m.run_once()
        self.assertEqual(m.report()["voices"]["x"]["state"], "failed")
        m.status["x"] = {"state": "failed", "error": "kept"}
        other = voice(id="y", model="https://example.com/y.onnx")
        report = m.set([voice(), other], "v2")
        self.assertEqual(report["voices"]["x"], {"state": "failed", "error": "kept"})
        m.status["y"] = {"state": "downloading", "percent": 50}
        self.assertEqual(m.set([voice(), other], "v3")["voices"]["y"]["percent"], 50)
        # A new link tries again
        self.assertEqual(m.set([voice(model=MODEL + "2"), other], "v4")["voices"]["x"]["state"], "waiting")

    def test_what_custom_voices_downloaded_is_deleted(self):
        m, _ = self.models({})
        for name in ("custom-old.onnx", "custom-old.source", "kss.onnx"):
            open(os.path.join(self.folder, name), "w").close()
        m.set([], "v")
        self.assertEqual(sorted(os.listdir(self.folder)), ["kss.onnx", "managed.json"])

    def test_a_redirect_is_followed_only_to_https(self):
        handler = models._HttpsOnly()
        request = urllib.request.Request("https://example.com/v.onnx")
        with self.assertRaises(urllib.error.HTTPError):
            handler.redirect_request(request, None, 302, "Found", {}, "http://10.0.0.1/v.onnx")
        self.assertEqual(handler.redirect_request(request, None, 302, "Found", {}, "https://cdn.example.com/v.onnx").full_url, "https://cdn.example.com/v.onnx")

    def test_an_entry_it_cant_use_shows_as_failed(self):
        m, _ = self.models({})
        report = m.set([voice(model="http://plain"), "junk"], "v")
        self.assertEqual(report["voices"]["x"]["state"], "failed")
        self.assertEqual(list(report["voices"]), ["x"])


if __name__ == "__main__":
    unittest.main()
