#!/bin/sh
set -e

# The default model, whose speakers the effect styles are built on. It's fetched here instead of being built into the image, as the image is public
MODEL=en_US-libritts_r-medium
[ -f "/voices/$MODEL.onnx" ] || python3 -m piper.download_voices --data-dir /voices "$MODEL"

# Every other voice's model, pinned to a commit and checked against their hashes. One that can't be fetched
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
fetch bender Schmalvis/bender-tts-model c35c0bbdd6cd2eb0fe8c1b1d0b1d87e7cca6ed33 \
  bender-v2.onnx 6167fe149434dfa5937da41d27209ae8fbc21d7f6e28f522dec2d137afc79424 \
  bender-v2.onnx.json 6d131604279f4ee08004583e4cbd05864aa6e15df2c8f0fc667c8757072fb704
fetch optimus crazygiscool/optimus-piper-voice cbd038a6ddd21a58bd50b0e7cd1c4e14b40c77c0 \
  optimus-final.onnx 0f52de2f01bac922dcd5815f6c367681766457cbb2f07a83bf2129aef5917585 \
  optimus-final.onnx.json a08cf76c01428751a15b5db0f9303af04ca7bbf08317123c6241ed06d8beb328
fetch kronk russdill/kronk 9403433305b256e73bc0fe1c685a80dbd88a1f87 \
  en/en_US/kronk/medium/kronk-medium.onnx 957a7ee834fc34664868ae93412b46046e8bf708ceff851fa791d2ab27fd9820 \
  en/en_US/kronk/medium/kronk-medium.onnx.json 500dfed0cc937b002b09ee8d7eea059b0250504addf7ad73fbff959c00282cb9
# The TikTok voice's own repo is gone, so it comes from a collection that kept a copy
fetch tiktok fox3000foxy/piper-voices-collection 0ce0fe21f3dfc87a8e318030b28b753cacfbbcf3 \
  cosycove--BeefStew/src_data_tts_voices_tiktok_lady.onnx.onnx 8f329dc194051481ff141153444098975c052dfef6fa39f376fbcf0748c7a32c \
  cosycove--BeefStew/src_data_tts_voices_tiktok_lady.onnx.onnx.json 108c16883ad72e74f8c1894dd75b045fc955d4c3b338e4a501737cf6c85ce99e
# Official Piper models in other languages, which serve.py has read English with an accent (see accent.py)
fetch kss rhasspy/piper-voices ae9d8352b73c1b1750748843e753a504b00e05b0 \
  ko/ko_KR/kss/medium/ko_KR-kss-medium.onnx 624fd774e26895f24bebae1bd9a3379e3394baeade4b584924f83e414096e2c9 \
  ko/ko_KR/kss/medium/ko_KR-kss-medium.onnx.json 153b5619d0580f824a59108d83ca19434de410eb8e4fe80325b58684fdc8a1df
fetch dmitri rhasspy/piper-voices ae9d8352b73c1b1750748843e753a504b00e05b0 \
  ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx f073356ebc4bd0f80c5af58df2953a5988bd5bdab1eb38635ce960b071fbefcb \
  ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx.json 667ef3117bc642c2892dff7690d8bdc8ca4228aeaa783b2dc1416df632855e0d
fetch davefx rhasspy/piper-voices ae9d8352b73c1b1750748843e753a504b00e05b0 \
  es/es_ES/davefx/medium/es_ES-davefx-medium.onnx d2c9224e122321aac3c33343957fff4d0f465226cb74c66b0f520ca3f8c0dd07 \
  es/es_ES/davefx/medium/es_ES-davefx-medium.onnx.json 531c4051502e1acbc10b42437f11679bfce9e3919e1796e51fabd73e01e7fd2e
fetch thorsten rhasspy/piper-voices ae9d8352b73c1b1750748843e753a504b00e05b0 \
  de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx c1764e652266cd6dcebf1b95c61973df5970a5f5272e94b655ff1ddf9a99d1ff \
  de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx.json 92895b9e99f7cfc13f4a9879da615c3d6e0baa4d660e26d7b685abdd27a6d1d3

# serve.py is piper.http_server with less memory kept between lines
exec python3 /serve.py --host 0.0.0.0 --port 5000 --data-dir /voices -m "$MODEL"
