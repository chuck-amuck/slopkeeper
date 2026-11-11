#!/bin/sh
set -e

# One model holds every numbered voice the bot offers. It's fetched here instead of being built into the image, as the image is public
MODEL=en_US-libritts_r-medium
[ -f "/voices/$MODEL.onnx" ] || python3 -m piper.download_voices --data-dir /voices "$MODEL"

# Community models for single character voices, pinned to a commit and checked against their hashes. One that can't be fetched
# leaves its voice speaking with the default model, so the rest still start
fetch() {
  name=$1 repo=$2 commit=$3 model=$4 model_sha=$5 config=$6 config_sha=$7
  [ -f "/voices/$name.onnx" ] && [ -f "/voices/$name.onnx.json" ] && return
  python3 - "$name" "https://huggingface.co/$repo/resolve/$commit" "$model" "$model_sha" "$config" "$config_sha" <<'EOF' || echo "Couldn't fetch the $name voice. It'll use the default model until the next start" >&2
import hashlib, os, sys, urllib.request
name, base, model, model_sha, config, config_sha = sys.argv[1:]
for remote, sha, local in ((model, model_sha, f"/voices/{name}.onnx"), (config, config_sha, f"/voices/{name}.onnx.json")):
    if os.path.exists(local):
        continue
    data = urllib.request.urlopen(f"{base}/{remote}", timeout=300).read()
    if hashlib.sha256(data).hexdigest() != sha:
        sys.exit(f"{remote} from {base} isn't the file that was checked")
    with open(f"{local}.part", "wb") as f:
        f.write(data)
    os.replace(f"{local}.part", local)
EOF
}
fetch glados NullPoExc/piper-glados b5eea11fb38bc8705b54102437fb6a553a54ec4d \
  en_US-glados-medium.onnx d07baf291367306bf25b8013a488e40a6f663a5da9154926b5f9160286364147 \
  config.json 108c16883ad72e74f8c1894dd75b045fc955d4c3b338e4a501737cf6c85ce99e
fetch hal OccultAI/HAL-9000-Piper-TTS 22f9ba2c6229614a4c186a08578d9cc80e2c653b \
  hal.onnx 0e08c82dc027bc72b8b839324801709e205e8c201ccae171b92e37a664d94361 \
  hal.onnx.json cb6f82c03fc9e6db1f3b6978b9601bab9854f92c40d3a0681501944b8c26745e

# serve.py is piper.http_server with less memory kept between lines
exec python3 /serve.py --host 0.0.0.0 --port 5000 --data-dir /voices -m "$MODEL"
