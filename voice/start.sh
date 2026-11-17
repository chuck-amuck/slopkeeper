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
# English models with British, Irish and Australian accents
fetch alba rhasspy/piper-voices ae9d8352b73c1b1750748843e753a504b00e05b0 \
  en/en_GB/alba/medium/en_GB-alba-medium.onnx 1f9da809b6da1ef4190bb5dd6cce4f4af803274539e9cf9e0693085150bac3d7 \
  en/en_GB/alba/medium/en_GB-alba-medium.onnx.json 6214603a0dd60e9dcd05502e23ef07fbe3d9af36d3189c8cc3eb129e1a099d6f
fetch northern rhasspy/piper-voices ae9d8352b73c1b1750748843e753a504b00e05b0 \
  en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx 57a219ae8e638873db7d18893304be5069c42868f392bb95c3ff17f0690d0689 \
  en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx.json 69557ed3d974463453e9b0c09dd99a7ed0e52b8b87b64b357dbeeb2540a97d47
fetch southern_female rhasspy/piper-voices ae9d8352b73c1b1750748843e753a504b00e05b0 \
  en/en_GB/southern_english_female/low/en_GB-southern_english_female-low.onnx f2f37aed1b3a093476f719d1379ba0c0b1b1cf6f1ef99288e2ebf502971a07c3 \
  en/en_GB/southern_english_female/low/en_GB-southern_english_female-low.onnx.json a1af43310f8756161506e849a2863d342a98b0853af9e2437581d39e9922d0e5
fetch jenny rhasspy/piper-voices ae9d8352b73c1b1750748843e753a504b00e05b0 \
  en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx 62ba183a504cfcd8816ec1b50ee856ed318ccc9dd22fd0bedd7d839c95dfa20e \
  en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx.json e489b3990e455d6378f12dbb4afa11e8e692a0168f1ed8e5c285dd2f08547567
fetch australian DataCraftsmanAustralia/piper-en_AU-librivox-medium 7f35faf19fe1789ece4b14233448f7c04e35a84f \
  en_AU-librivox-medium.onnx f34849bce64d803d0fe90087766d5d6f2a8215a12edad43e486d77072df7dd41 \
  en_AU-librivox-medium.onnx.json e0d8d381bf3eedeb7483cfa4ab5333d45284d30822bbc93f39fd10dc2935c1c1
# Piper's own list has only the Southern English woman, so the man comes from a Piper model packaged for sherpa-onnx
fetch southern_male csukuangfj/vits-piper-en_GB-southern_english_male-medium 46e268d5bc67ad287d129689366e49d80f314e34 \
  en_GB-southern_english_male-medium.onnx dd2ae134ac765f9609b96f9a4deed09af112f2594b87acf039780615a7b4816b \
  en_GB-southern_english_male-medium.onnx.json 620c11f6c75020dbd1e279bf752676a8857c44ee6e558d8592b803dac938fced
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
