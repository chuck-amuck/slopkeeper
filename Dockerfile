FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

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
