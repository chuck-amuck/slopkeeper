# Soloist needs a newer C library than bookworm's
FROM node:24-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends pulseaudio libatomic1 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY bridge.mjs ./

ENV DATA_DIR=/data
# Named volumes inherit this ownership on first creation, so the node user can write to them
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
CMD ["node", "bridge.mjs"]
