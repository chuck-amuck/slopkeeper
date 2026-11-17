"""The voices added in the bot's web UI. The bot sends their list to POST /models, and this keeps their models in the models
folder, downloading what's missing in the background, one at a time, and deleting what's no longer listed.

The list is saved with the models, so a restart keeps it without the bot. Each voice's files are named voice-<id>-<hash of where
they came from>.onnx, so a voice whose address changes gets new files rather than ones Piper's server already has loaded under
the old name. GET /models says each voice's state for the web UI, and the file the bot asks for once it's ready.

A model is capped at MOST_BYTES, so a wrong link can't fill the disk, and its settings are fetched first and must be a Piper
voice's, so a link to a web page fails at once. Hashes are checked when the bot gives them.
"""

import hashlib
import json
import os
import re
import threading
import urllib.error
import urllib.parse
import urllib.request

PREFIX = "voice-"
# What the CUSTOM_VOICES list downloaded, before voices were added in the web UI
OLD_PREFIX = "custom-"
LIST_FILE = "managed.json"
MOST_BYTES = 500 * 1024 * 1024
CHUNK = 1024 * 1024
ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}")
SHA = re.compile(r"[0-9a-f]{64}")


def config_url(model):
    """A Piper model's settings sit beside it, at its address plus .json"""
    parts = urllib.parse.urlsplit(model)
    return urllib.parse.urlunsplit(parts._replace(path=parts.path + ".json"))


def checked(entry):
    """The entry with only what this needs, or a reason it can't be used. The bot has checked it already"""
    if not isinstance(entry, dict):
        return None, "isn't an object"
    voice_id, model = entry.get("id"), entry.get("model")
    if not isinstance(voice_id, str) or not ID.fullmatch(voice_id):
        return None, "has no usable id"
    config = entry.get("config") or (config_url(model) if isinstance(model, str) else None)
    if not all(isinstance(url, str) and url.startswith("https://") for url in (model, config)):
        return None, "needs https:// addresses"
    hashes = {key: entry.get(key) for key in ("sha256", "configSha256")}
    if any(v is not None and not (isinstance(v, str) and SHA.fullmatch(v.lower())) for v in hashes.values()):
        return None, "has hashes that aren't 64 hex digits"
    return {"id": voice_id, "model": model, "config": config, **{k: v and v.lower() for k, v in hashes.items()}}, None


def file_for(voice):
    """The name its files take, which changes with where they come from"""
    source = "\n".join([voice["model"], voice["config"], voice["sha256"] or "", voice["configSha256"] or ""])
    return f"{PREFIX}{voice['id']}-{hashlib.sha256(source.encode()).hexdigest()[:12]}"


def speakers_in(settings):
    """A model's speakers by name, in their order, or none for a model with one"""
    names = settings.get("speaker_id_map") or {}
    if (settings.get("num_speakers") or 1) <= 1 or not isinstance(names, dict):
        return []
    return [{"id": number, "name": name} for name, number in sorted(names.items(), key=lambda item: item[1]) if isinstance(number, int)]


class _HttpsOnly(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to another https:// address, as the links are checked to be"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith("https://"):
            raise urllib.error.HTTPError(newurl, code, "It redirects to an address that isn't https://.", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_open = urllib.request.build_opener(_HttpsOnly).open


class Models:
    def __init__(self, folder, opener=_open, log=print):
        self.folder = folder
        self.opener = opener
        self.log = log
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.version = ""
        self.voices = []
        self.status = {}
        try:
            with open(os.path.join(folder, LIST_FILE), encoding="utf-8") as file:
                saved = json.load(file)
            self.version = str(saved.get("version", ""))
            self.voices = [voice for voice in (checked(entry)[0] for entry in saved.get("voices", [])) if voice]
        except (OSError, ValueError, AttributeError):
            pass
        for voice in self.voices:
            self.status[voice["id"]] = self._state_on_disk(voice)

    def _path(self, name):
        return os.path.join(self.folder, name)

    def _state_on_disk(self, voice):
        name = file_for(voice)
        if os.path.exists(self._path(f"{name}.onnx")) and os.path.exists(self._path(f"{name}.onnx.json")):
            try:
                with open(self._path(f"{name}.onnx.json"), encoding="utf-8") as file:
                    speakers = speakers_in(json.load(file))
            except (OSError, ValueError):
                speakers = []
            return {"state": "ready", "file": name, "speakers": speakers}
        return {"state": "waiting"}

    def set(self, voices, version):
        """Takes the bot's list: keeps it, deletes what's no longer listed, and starts on what's missing. Returns the report"""
        kept, problems = [], {}
        for entry in voices if isinstance(voices, list) else []:
            voice, problem = checked(entry)
            if voice and all(voice["id"] != other["id"] for other in kept):
                kept.append(voice)
            elif problem and isinstance(entry, dict) and isinstance(entry.get("id"), str):
                problems[entry["id"]] = problem
        with self.lock:
            before = {voice["id"]: voice for voice in self.voices}
            # A voice listed as it was keeps its state: a download under way carries on, and one that failed isn't tried
            # again until its link changes or the container restarts
            self.status = {
                voice["id"]: self.status[voice["id"]]
                if before.get(voice["id"]) == voice and self.status.get(voice["id"], {}).get("state") in ("downloading", "failed")
                else self._state_on_disk(voice)
                for voice in kept
            }
            self.voices = kept
            self.version = str(version or "")
            for voice_id, problem in problems.items():
                self.status[voice_id] = {"state": "failed", "error": f"The voice {problem}."}
            try:
                with open(self._path(f"{LIST_FILE}.part"), "w", encoding="utf-8") as file:
                    json.dump({"version": self.version, "voices": kept}, file)
                os.replace(self._path(f"{LIST_FILE}.part"), self._path(LIST_FILE))
            except OSError as err:
                self.log(f"Couldn't save the list of added voices: {err}")
        self._forget_unlisted()
        self.wake.set()
        return self.report()

    def report(self):
        with self.lock:
            return {"version": self.version, "voices": {voice_id: dict(state) for voice_id, state in self.status.items()}}

    def _forget_unlisted(self):
        with self.lock:
            keep = {file_for(voice) for voice in self.voices}
        for name in os.listdir(self.folder):
            if name.startswith(OLD_PREFIX) or (name.startswith(PREFIX) and name.split(".", 1)[0] not in keep):
                try:
                    os.remove(self._path(name))
                except OSError:
                    pass

    def _download(self, url, local, sha, voice_id, share):
        """Streams a file to local.part, capped and hashed, and only then puts it in place. `share` is its part of the percentage"""
        digest = hashlib.sha256()
        got = 0
        with self.opener(url, timeout=60) as res:
            length = int(res.headers.get("Content-Length") or 0) if getattr(res, "headers", None) else 0
            if length > MOST_BYTES:
                raise ValueError(f"It's {length // (1024 * 1024)} MB, and the most is {MOST_BYTES // (1024 * 1024)} MB.")
            with open(f"{local}.part", "wb") as file:
                while chunk := res.read(CHUNK):
                    got += len(chunk)
                    if got > MOST_BYTES:
                        raise ValueError(f"It's over {MOST_BYTES // (1024 * 1024)} MB, the most a model can be.")
                    digest.update(chunk)
                    file.write(chunk)
                    if length and share:
                        with self.lock:
                            state = self.status.get(voice_id)
                            if state and state.get("state") == "downloading":
                                state["percent"] = min(99, share[0] + round(share[1] * got / length))
        if sha and digest.hexdigest() != sha:
            raise ValueError(f"The file at {url} isn't the one its sha256 says.")
        return digest.hexdigest()

    def _fetch(self, voice):
        name = file_for(voice)
        config_path, model_path = self._path(f"{name}.onnx.json"), self._path(f"{name}.onnx")
        try:
            # The settings first: they're small, and a link to anything but a Piper voice fails here
            self._download(voice["config"], config_path, voice["configSha256"], voice["id"], None)
            try:
                with open(f"{config_path}.part", encoding="utf-8") as file:
                    settings = json.load(file)
            except ValueError:
                settings = None
            if not isinstance(settings, dict) or "phoneme_id_map" not in settings:
                raise ValueError("Its settings file isn't a Piper voice's. Check the link is to the model's .onnx file.")
            self._download(voice["model"], model_path, voice["sha256"], voice["id"], (0, 100))
            os.replace(f"{model_path}.part", model_path)
            os.replace(f"{config_path}.part", config_path)
            return {"state": "ready", "file": name, "speakers": speakers_in(settings)}
        except Exception as err:  # noqa: BLE001 - a failed voice says why, and the rest carry on
            for path in (config_path, model_path):
                try:
                    os.remove(f"{path}.part")
                except OSError:
                    pass
            message = str(err) if isinstance(err, ValueError) else f"Couldn't download it: {err}"
            self.log(f"Couldn't fetch the added voice {voice['id']}: {message}")
            return {"state": "failed", "error": message}

    def run_once(self):
        """Fetches every listed voice that isn't there yet, one at a time"""
        while True:
            with self.lock:
                waiting = next((v for v in self.voices if self.status.get(v["id"], {}).get("state") == "waiting"), None)
                if not waiting:
                    return
                self.status[waiting["id"]] = {"state": "downloading", "percent": 0}
            result = self._fetch(waiting)
            with self.lock:
                # The list may have changed meanwhile: only a voice still listed the same way takes the result
                if any(v == waiting for v in self.voices):
                    self.status[waiting["id"]] = result
                    if result["state"] == "ready":
                        self.log(f"Fetched the added voice {waiting['id']}")
            self._forget_unlisted()

    def start(self):
        def loop():
            while True:
                self.run_once()
                self.wake.wait()
                self.wake.clear()

        threading.Thread(target=loop, daemon=True).start()
