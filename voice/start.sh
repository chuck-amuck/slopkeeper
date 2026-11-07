#!/bin/sh
set -e

# One model holds every voice the bot offers. It's fetched here instead of being built into the image, as the image is public
MODEL=en_US-libritts_r-medium
[ -f "/voices/$MODEL.onnx" ] || python3 -m piper.download_voices --data-dir /voices "$MODEL"
exec python3 -m piper.http_server --host 0.0.0.0 --port 5000 --data-dir /voices -m "$MODEL"
