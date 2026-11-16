FROM node:24-bookworm-slim

WORKDIR /app
COPY src ./src
COPY public ./public
# The licences of the charts and calendar built into public/vendor-*.js
COPY vendor-licences ./vendor-licences
COPY package.json ./

ENV NODE_ENV=production
USER node
CMD ["node", "src/index.ts"]
