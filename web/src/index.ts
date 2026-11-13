import { createWeb } from './server.ts';
import { reportEvery } from './stats.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const port = Number(process.env.PORT || 8080);
const apiToken = required('API_TOKEN');
const botUrl = process.env.BOT_URL || 'http://slopkeeper:8787';
const server = createWeb({
  password: required('WEB_PASSWORD'),
  apiToken,
  botUrl,
  proxySecret: process.env.PROXY_SECRET || undefined,
});

server.listen(port, () => console.log(`Listening on port ${port}`));
// How the web UI is doing, for the bot's health numbers
reportEvery(botUrl, apiToken);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
