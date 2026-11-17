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
fetch jarvis vishalrao8/piper-jarvis-high cfef54cd400ee23f06a7992decc1c597d8d007ae \
  en_GB-jarvis-high.onnx 6cc4ace257f80b04e222ee669f7cd8285e3edbee3c31d40ae7a75f2b8a2a970a \
  en_GB-jarvis-high.onnx.json 8a9d54e6f67a4ee433bf35025d5ad50197ca459fcb4ec3a5b8f140492884dce0
fetch death drewThomasson/piper_tts_finetune_death_from_puss_and_boots bfd49135f21f8063f5e30992eda8b1d71005ecc1 \
  en_US-death-high_onnx/en_US-death-high.onnx 5c95b0fb97522385bc507a0421bcc17cbc957cde66276648b3e4d7cb0dd8d1ea \
  en_US-death-high_onnx/en_US-death-high.onnx.json 85aca75ec63f93968748bac2ea3cd201b642604b65caedb8be71b5dae866aac9
fetch bmo ziadnotme/bmo-tts-piper 98649fd42055535111330f015fc7754beb14ae14 \
  en_US-bmo_voice.onnx 2b323dfdd76efb36b096b93ef8a6f0a60a26886aaaeeba97e691c13641611fb8 \
  en_US-bmo_voice.onnx.json 0786c36ebf1ffc2b6979391941d64bd2ed0279bd0114654d980ad957ec914776
fetch rocket AkumaVenom/RocketRacoon-Piper-US-Medium cd0709c9d4b68771c63816d1dc59528c76f5e091 \
  rocket_racoon.onnx f47cc8322363a7c8e8a8d03b71c219c3e2adfe46bd11ee7a93649af7a8caede7 \
  rocket_racoon.onnx.json 108c16883ad72e74f8c1894dd75b045fc955d4c3b338e4a501737cf6c85ce99e
# Its settings list 7 speakers, though the model takes none, which serve.py works around
fetch announcer RoxasYTB/piper-checkpoints-css-announcer-en 4ac3941cee53f1ce56ce1b337d72b504ed8c9c4f \
  css-announcer-en.onnx 37fb11446b4c898916eacc24a69af53085edc1270b04eea54452c585019d3c05 \
  css-announcer-en.onnx.json 3cf98638b5139e1e55376845606ae52d50d6e2e768e9348d95ae80baa8eaed93
# The Bobby, Carl and Patrick models' own repo is gone, so they come from the same collection as TikTok
fetch bobby fox3000foxy/piper-voices-collection d7b6505a32653648cc09da0244fd1f79e732a336 \
  simoniz0r--piper-voice-models/en_US-bobby-medium.onnx.onnx a97094cc9fbc2626c7ef95cbe025bb4bbbf7a19dd49cda28890b5c334337c715 \
  simoniz0r--piper-voice-models/en_US-bobby-medium.onnx.onnx.json 683b7b410f9b45b58f94e55deb369ba8ae9f6a033b967179d9dff5aff5b0f257
fetch carl fox3000foxy/piper-voices-collection d7b6505a32653648cc09da0244fd1f79e732a336 \
  simoniz0r--piper-voice-models/en_US-carl-medium.onnx.onnx 30f9cd2e3b769decf00a0e0b25f749d1ef4776fc8d8266a06e40bce7d8387873 \
  simoniz0r--piper-voice-models/en_US-carl-medium.onnx.onnx.json a889eb297afbd3453f3d98ab9f87f388ac4f93dfbe937d68f623b049d234a735
fetch patrick fox3000foxy/piper-voices-collection d7b6505a32653648cc09da0244fd1f79e732a336 \
  simoniz0r--piper-voice-models/en_US-patrick-medium.onnx.onnx 8671d5f3259d9d20dd92463676c9f657a629a0951cfb49dc3d5b57ae520f39c7 \
  simoniz0r--piper-voice-models/en_US-patrick-medium.onnx.onnx.json 0a23ba28d3e68e9e9d390412198eebdeeb4aa214673b2de700d5f705926a84dd
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
