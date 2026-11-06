import { createWeb } from './server.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const port = Number(process.env.PORT || 8080);
const server = createWeb({
  password: required('WEB_PASSWORD'),
  apiToken: required('API_TOKEN'),
  botUrl: process.env.BOT_URL || 'http://slopkeeper:8787',
});

server.listen(port, () => console.log(`Listening on port ${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
