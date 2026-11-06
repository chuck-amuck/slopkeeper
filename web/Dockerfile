FROM node:24-bookworm-slim

WORKDIR /app
COPY src ./src
COPY public ./public
COPY package.json ./

ENV NODE_ENV=production
USER node
CMD ["node", "src/index.ts"]
