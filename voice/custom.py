"""Fetches the deployment's own voices, listed in CUSTOM_VOICES, into the models folder. The bot reads the same list to offer them.

CUSTOM_VOICES is a JSON list of {"id", "name", "model"} and optional fields (see the README). Only "id" and "model" matter here:
"model" is the address of a Piper .onnx model, and "config" its settings, which default to the same address plus ".json".
"sha256" and "configSha256" are checked when they're given; without them the hashes it got are logged, to pin them with.

Each is kept as custom-<id>.onnx, with a note of where it came from, so it's fetched again only when its address or hashes
change. One that's no longer listed is deleted, unless something in the list couldn't be read, as a typo would otherwise delete
them all. A voice that can't be fetched yet speaks with the default model, as the built-in ones do.

The entries are checked as the bot checks them (src/features/say.ts), so both take the same one when an id is listed twice.
"""

import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request

ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
SHA = re.compile(r"^[0-9a-f]{64}$")
# A Hugging Face address with a commit in it, which always serves the same file
PINNED = re.compile(r"/resolve/[0-9a-f]{40}/")
PREFIX = "custom-"


def config_url(model):
    parts = urllib.parse.urlsplit(model)
    return urllib.parse.urlunsplit(parts._replace(path=parts.path + ".json"))


def entries(raw):
    """The voices worth fetching, as dicts of id, model, config, sha256 and configSha256, and a reason for each one skipped"""
    if not raw or not raw.strip():
        return [], []
    try:
        listed = json.loads(raw)
    except ValueError as err:
        return [], [f"CUSTOM_VOICES isn't valid JSON ({err})"]
    if not isinstance(listed, list):
        return [], ["CUSTOM_VOICES isn't a list"]
    voices, skipped, seen = [], [], set()
    for i, entry in enumerate(listed, 1):
        if not isinstance(entry, dict):
            skipped.append(f"entry {i} isn't an object")
            continue
        voice_id = entry.get("id")
        if not isinstance(voice_id, str) or not ID.fullmatch(voice_id):
            skipped.append(f"entry {i}'s id isn't 1 to 32 lowercase letters, digits, - or _")
            continue
        if voice_id in seen:
            skipped.append(f"{voice_id} is listed twice")
            continue
        # Taken even if the rest is wrong, so a later entry with the same id is skipped
        seen.add(voice_id)
        name = entry.get("name")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 40:
            skipped.append(f"{voice_id}'s name needs 1 to 40 characters")
            continue
        model = entry.get("model")
        config = entry.get("config") or (config_url(model) if isinstance(model, str) else None)
        if not all(isinstance(url, str) and url.startswith("https://") for url in (model, config)):
            skipped.append(f"{voice_id}'s model and config need https:// addresses")
            continue
        hashes = {key: entry.get(key) for key in ("sha256", "configSha256")}
        if any(value is not None and not (isinstance(value, str) and SHA.fullmatch(value.lower())) for value in hashes.values()):
            skipped.append(f"{voice_id}'s sha256 and configSha256 need to be 64 hex digits")
            continue
        voices.append({"id": voice_id, "model": model, "config": config, **{k: v and v.lower() for k, v in hashes.items()}})
    return voices, skipped


def fetch(voice, folder, opener=urllib.request.urlopen):
    """Downloads a voice unless it's already there from the same addresses. Returns what it did, for the log"""
    base = os.path.join(folder, PREFIX + voice["id"])
    # The hashes too, so pinning one later checks the files
    source = f"{voice['model']}\n{voice['config']}\n{voice['sha256'] or ''}\n{voice['configSha256'] or ''}\n"
    try:
        with open(f"{base}.source", encoding="utf-8") as file:
            if file.read() == source and os.path.exists(f"{base}.onnx") and os.path.exists(f"{base}.onnx.json"):
                return None
    except OSError:
        pass
    got = []
    for url, sha, local in ((voice["model"], voice["sha256"], f"{base}.onnx"), (voice["config"], voice["configSha256"], f"{base}.onnx.json")):
        with opener(url, timeout=300) as res:
            data = res.read()
        digest = hashlib.sha256(data).hexdigest()
        if sha and digest != sha:
            raise ValueError(f"{url} has the sha256 {digest}, not the one given")
        got.append((local, data, digest))
    if b'"phoneme_id_map"' not in got[1][1]:
        raise ValueError(f"{voice['config']} isn't a Piper voice's settings")
    for local, data, _ in got:
        with open(f"{local}.part", "wb") as file:
            file.write(data)
        os.replace(f"{local}.part", local)
    with open(f"{base}.source", "w", encoding="utf-8") as file:
        file.write(source)
    note = f"Fetched the custom voice {voice['id']}"
    if not voice["sha256"] or not voice["configSha256"]:
        note += f'. To pin it, add "sha256": "{got[0][2]}", "configSha256": "{got[1][2]}"'
    if not PINNED.search(voice["model"]):
        note += ". Its address has no commit in it, so a fresh volume could get a different file"
    return note


def forget_unlisted(voices, folder):
    """Deletes the custom voices no longer listed. Returns their ids"""
    keep = {PREFIX + voice["id"] for voice in voices}
    gone = set()
    for name in os.listdir(folder):
        if not name.startswith(PREFIX):
            continue
        stem = name.split(".", 1)[0]
        if stem not in keep:
            os.remove(os.path.join(folder, name))
            gone.add(stem.removeprefix(PREFIX))
    return sorted(gone)


def main(folder="/voices"):
    voices, skipped = entries(os.environ.get("CUSTOM_VOICES"))
    for reason in skipped:
        print(f"Skipped a custom voice: {reason}", file=sys.stderr, flush=True)
    if skipped:
        print("Kept every custom voice already fetched, as something in CUSTOM_VOICES couldn't be read", file=sys.stderr, flush=True)
    else:
        for voice_id in forget_unlisted(voices, folder):
            print(f"Deleted the custom voice {voice_id}, as it's no longer listed", flush=True)
    for voice in voices:
        try:
            note = fetch(voice, folder)
        except Exception as err:  # noqa: BLE001 - one voice's failure shouldn't stop the rest
            print(f"Couldn't fetch the custom voice {voice['id']}, so it uses the default model: {err}", file=sys.stderr, flush=True)
            continue
        if note:
            print(note, flush=True)


if __name__ == "__main__":
    main()
