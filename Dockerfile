# A static ffmpeg starts in a few milliseconds rather than tens, which every sound and line of speech pays
FROM mwader/static-ffmpeg:9.0.2-1@sha256:f5d100184884eb3e82b0eb14bb5ebf98da99826ac824989720297fb9ef21c822 AS ffmpeg

# Node and that ffmpeg: the tests run in this stage too (see CLAUDE.md), so they hear what the bot does
FROM node:24-bookworm-slim AS base
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/

FROM base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV NODE_ENV=production DATA_DIR=/data
# Named volumes inherit this ownership on first creation, so the node user can write to them
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
