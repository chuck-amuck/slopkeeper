#!/bin/sh
# Starts a built voice image and has it say a line with the default model, with the Spanish accent, with a model whose
# settings list speakers it doesn't take and with a voice added through /models, checking that real speech comes back. CI runs it before pushing the image: serve.py patches onnxruntime's and Piper's insides, so a
# new version of either can break it in ways a syntax check can't see.
#   sh voice/smoke.sh <image> <models folder, kept between runs>
set -eu
image=$1 models=$2
here=$(dirname "$0")
name=sk-voice-smoke-$$
mkdir -p "$models"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

# Only the two models it needs, rather than every voice start.sh fetches. The Spanish one comes from the commit and
# hashes start.sh pins
set -- $(sed -n '/^fetch davefx /,/json /p' "$here/start.sh" | tr -d '\\' | tr -s ' \n' ' ')
docker run --rm --user "$(id -u):$(id -g)" -v "$(realpath "$models")":/voices "$image" sh -c '
  set -e
  [ -f /voices/en_US-libritts_r-medium.onnx ] || python3 -m piper.download_voices --data-dir /voices en_US-libritts_r-medium
  python3 - "$@" <<EOF
import hashlib, os, sys, urllib.request
_, name, repo, commit, model, model_sha, config, config_sha = sys.argv
for remote, sha, local in ((model, model_sha, f"/voices/{name}.onnx"), (config, config_sha, f"/voices/{name}.onnx.json")):
    if os.path.exists(local):
        continue
    data = urllib.request.urlopen(f"https://huggingface.co/{repo}/resolve/{commit}/{remote}", timeout=300).read()
    if hashlib.sha256(data).hexdigest() != sha:
        sys.exit(f"{remote} isn\x27t the file start.sh checks for")
    open(local, "wb").write(data)
# The Spanish model again, with settings that say it has speakers, as some community models do
import json
settings = json.load(open(f"/voices/{name}.onnx.json"))
settings.update(num_speakers=7, speaker_id_map={"normal": 0})
json.dump(settings, open("/voices/smoke-speakers.onnx.json", "w"))
if not os.path.lexists("/voices/smoke-speakers.onnx"):
    os.symlink(f"{name}.onnx", "/voices/smoke-speakers.onnx")
# And as a voice added in the web UI, already downloaded under the name models.py gives it, so it needs no download
sys.path.insert(0, "/")
import models
added = models.file_for(models.checked({"id": "smoke", "model": "https://example.com/smoke.onnx"})[0])
for suffix in (".onnx", ".onnx.json"):
    if not os.path.lexists(f"/voices/{added}{suffix}"):
        os.symlink(f"{name}{suffix}", f"/voices/{added}{suffix}")
EOF
' sh "$2" "$3" "$4" "$5" "$6" "$7" "$8"

docker run -d --name "$name" --user "$(id -u):$(id -g)" -p 127.0.0.1::5000 -v "$(realpath "$models")":/voices "$image" \
  python3 /serve.py --host 0.0.0.0 --port 5000 --data-dir /voices -m en_US-libritts_r-medium >/dev/null
port=$(docker port "$name" 5000 | head -1 | sed 's/.*://')

python3 - "$port" <<'EOF'
import io, json, sys, time, urllib.error, urllib.request, wave

base = f"http://127.0.0.1:{sys.argv[1]}"
url = f"{base}/synthesize"
line = "Testing, one two three. The bot can still speak."
ADDED = {"id": "smoke", "model": "https://example.com/smoke.onnx"}


def ask(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(f"{base}{path}", data, {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as res:
        return json.load(res)


def say(**extra):
    body = json.dumps({"text": line, **extra}).encode()
    request = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as res:
        return res.read(), res.headers.get("Server-Timing", "")


# The server takes a moment to load the default model
for _ in range(60):
    try:
        audio, timing = say()
        break
    except (urllib.error.URLError, ConnectionError):
        time.sleep(1)
else:
    sys.exit("The voice container never answered")

# The bot sends the added voices' list, and the container says each one's state
added = ask("/models", {"version": "smoke", "voices": [ADDED]})["voices"]["smoke"]
if added.get("state") != "ready" or ask("/stats").get("modelsVersion") != "smoke":
    sys.exit(f"The added voice isn't ready: {added}")

for label, extra in (("default", {}), ("Spanish accent", {"voice": "davefx"}), ("listed speakers", {"voice": "smoke-speakers", "speaker_id": 0}), ("added voice", {"voice": added["file"]})):
    audio, timing = say(**extra)
    with wave.open(io.BytesIO(audio)) as w:
        seconds = w.getnframes() / w.getframerate()
        frames = w.readframes(w.getnframes())
    # Silence is all zeroes; speech isn't
    loud = sum(1 for i in range(0, len(frames) - 1, 2) if abs(int.from_bytes(frames[i : i + 2], "little", signed=True)) > 500)
    print(f"{label}: {seconds:.1f} s, {w.getframerate()} Hz, {loud} loud samples, Server-Timing: {timing}")
    if not 1.5 < seconds < 15 or loud < 1000 or "synth" not in timing:
        sys.exit(f"The {label} line doesn't sound like speech")
# A voice no longer listed is deleted
if ask("/models", {"version": "smoke-2", "voices": []})["voices"] or ask("/models")["version"] != "smoke-2":
    sys.exit("The added voice wasn't let go")
print("The voice image speaks")
EOF
