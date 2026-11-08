// Signs the Spotify account in once, so the bot can read its playlists, and prints SPOTIFY_REFRESH_TOKEN for .env.
// Run it where SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are set: docker compose exec -it slopkeeper node src/spotify-sign-in.ts
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

// The search app's redirect URI. Nothing listens there: the browser fails to load it, and its address carries the answer
export const REDIRECT = 'http://127.0.0.1:8888/callback';
const SCOPES = 'playlist-read-private playlist-read-collaborative';

export const signInLink = (clientId: string, state: string) =>
  `https://accounts.spotify.com/authorize?${new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES, state, show_dialog: 'true' })}`;

/** The code in the address Spotify sent the browser to, if it answers this sign-in */
export function codeFrom(pasted: string, state: string): string {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new Error('That isn’t an address. Copy the whole address from the browser’s address bar, starting with http://127.0.0.1:8888/callback.');
  }
  if (url.searchParams.get('error')) throw new Error(`Spotify said no: ${url.searchParams.get('error')}.`);
  const code = url.searchParams.get('code');
  if (!code) throw new Error('That address has no code in it. Copy the address the browser went to after you agreed, not the sign-in link.');
  if (url.searchParams.get('state') !== state) throw new Error('That address is from a different sign-in. Run this again and use the new link.');
  return code;
}

if (import.meta.main) {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) {
    console.error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET need setting first.');
    process.exit(1);
  }
  const state = randomBytes(12).toString('hex');
  console.log(`1. Open this link, signed in to Spotify as the account the bot plays with, and agree:\n\n${signInLink(id, state)}\n`);
  console.log('2. The browser then goes to a page that doesn’t load. Copy that page’s whole address.\n');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const pasted = await prompt.question('3. Paste it here: ');
  prompt.close();
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: codeFrom(pasted, state), redirect_uri: REDIRECT }),
    });
    const body = (await res.json()) as { refresh_token?: string; error_description?: string };
    if (!body.refresh_token) throw new Error(`Spotify turned the sign-in down: ${body.error_description ?? `HTTP ${res.status}`}. Run this again for a new link.`);
    console.log(`\nPut this in .env and restart the bot. Keep it secret: it reads this account's playlists.\n\nSPOTIFY_REFRESH_TOKEN=${body.refresh_token}`);
  } catch (err) {
    console.error(`\n${(err as Error).message}`);
    process.exit(1);
  }
}
