#!/bin/sh
# Starts a built voice image and has it say a line with the default model and with the Spanish accent, checking that
# real speech comes back. CI runs it before pushing the image: serve.py patches onnxruntime's and Piper's insides, so a
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
EOF
' sh "$2" "$3" "$4" "$5" "$6" "$7" "$8"

docker run -d --name "$name" --user "$(id -u):$(id -g)" -p 127.0.0.1::5000 -v "$(realpath "$models")":/voices "$image" \
  python3 /serve.py --host 0.0.0.0 --port 5000 --data-dir /voices -m en_US-libritts_r-medium >/dev/null
port=$(docker port "$name" 5000 | head -1 | sed 's/.*://')

python3 - "$port" <<'EOF'
import io, json, sys, time, urllib.error, urllib.request, wave

url = f"http://127.0.0.1:{sys.argv[1]}/synthesize"
line = "Testing, one two three. The bot can still speak."


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

for label, extra in (("default", {}), ("Spanish accent", {"voice": "davefx"})):
    audio, timing = say(**extra)
    with wave.open(io.BytesIO(audio)) as w:
        seconds = w.getnframes() / w.getframerate()
        frames = w.readframes(w.getnframes())
    # Silence is all zeroes; speech isn't
    loud = sum(1 for i in range(0, len(frames) - 1, 2) if abs(int.from_bytes(frames[i : i + 2], "little", signed=True)) > 500)
    print(f"{label}: {seconds:.1f} s, {w.getframerate()} Hz, {loud} loud samples, Server-Timing: {timing}")
    if not 1.5 < seconds < 15 or loud < 1000 or "synth" not in timing:
        sys.exit(f"The {label} line doesn't sound like speech")
print("The voice image speaks")
EOF
