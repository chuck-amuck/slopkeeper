FROM node:24-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp, with Deno for YouTube's player checks, in an environment the node user owns, so it can update itself as YouTube changes
RUN python3 -m venv /opt/ytdlp \
  && /opt/ytdlp/bin/pip install --no-cache-dir --quiet 'yt-dlp[default,deno]' \
  && chown -R node:node /opt/ytdlp
ENV PATH=/opt/ytdlp/bin:$PATH

WORKDIR /app
COPY bridge.mjs youtube.mjs fetch.py ./

ENV DATA_DIR=/data
# Named volumes inherit this ownership on first creation, so the node user can write to them
RUN mkdir -p /data/audio && chown -R node:node /data
VOLUME /data
USER node
CMD ["node", "bridge.mjs"]
