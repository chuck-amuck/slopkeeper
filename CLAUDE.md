# slopkeeper

A Discord bot for friends' servers (hop-on pings, game picks, sales, stats, a soundboard, text to speech, music and
a looping room), with a web UI in `web/`, Piper text to speech in `voice/` and yt-dlp playback in `music/`. Node 24
runs the TypeScript directly, with no build step. README.md is the user guide, grouped by feature.

## Commands

There's no npm on the development machine, so run the bot's checks in a container that matches CI: Node 24 plus
ffmpeg. Without ffmpeg the audio tests skip silently and the run looks green.

- Bot typecheck and tests (about 90 s plus the apt step):
  `docker run --rm -v "$PWD":/app -w /app node:24-trixie-slim sh -c "apt-get update -qq >/dev/null && apt-get install -y -qq ffmpeg >/dev/null 2>&1; npx tsc -p . && npm test"`
- One file, in the same container: `node --disable-warning=ExperimentalWarning --test test/<name>.test.ts` (add
  `--test-name-pattern="<name>"` for one test).
- Web: `cd web && node --test 'test/*.test.ts'` works with the host's node; typecheck with `npx tsc -p .` in the
  container.
- Music container: `node --test 'music/*.test.mjs'`. `voice/` has no tests.
- Front end: `for f in web/public/*.js; do node --check "$f"; done`.
- Web UI by hand: run `web/src/index.ts` against a fake bot (`BOT_URL`) and drive `chromium --headless=new` over CDP.
  Non-GET calls need the header `x-slopkeeper: 1`.

## Shipping a change

1. Run `/code-review low` on the diff (medium for a big or risky one) and fix real findings.
2. Push once the typecheck and tests pass. Never chain `commit && push` after a red or partial run. Break checks
   (deliberate mutations) cover only the riskiest changes and run after the release.
3. `git fetch` before pushing: other sessions push here too.
4. CI (`.github/workflows/image.yml`) runs the bot, web and music tests and builds four images: the bot (which also
   runs the loop bot), web, voice and music. If a run stalls (the ffmpeg apt step and say.test.ts have hung),
   `gh run cancel <id>`, then `gh run rerun <id>`.
5. A web-only change ships as its own image. Browser tabs opened before the redeploy keep the old page until
   they're refreshed. How the deployment picks up images is in CLAUDE.local.md.

## Rules

- Never bump `SCHEMA_VERSION` in src/db.ts: an older database with a `games` table makes the bot refuse to start.
  Add tables with `CREATE TABLE IF NOT EXISTS` and columns with the `pragma_table_info` + `ALTER TABLE` pattern.
- Every setting is editable in the web UI. `/setup` (src/features/setup.ts) is optional: the owner is fine with a
  setting living only in the web UI (the default and looping speech voices do), marked "web UI only" in the README
  "Settings and defaults" table. A new per-server setting touches src/settings.ts DEFAULTS (an env var only sets the
  default), web/public/settings.js, `.env.example`, that README table and the tests.
- Rules live in the bot (src/features, src/api.ts). `web/` stores nothing and proxies to the management API.
- Spotify stays search-only: no `SPOTIFY_REFRESH_TOKEN` in the deployment and no personal playlists. Soloist
  playback was removed in fec6b23; bring it back only if asked.
- `test/helpers.ts` is the first import in every test file: it sets DATA_DIR, DISCORD_TOKEN and TZ before db.ts
  opens the database.
- Tests must let the process exit: `.unref()` idle timers, mock timers and stop audio loops in `t.after`. A hung
  file stalls CI.
- Each user-visible change updates its README section, and `.env.example` for a new variable. Commit subjects read
  "<Area>: <what people get>".
- This repo and three of its images are public. Keep LAN addresses, hostnames, deployment IDs, server names,
  emails and personal details out of code, tests, docs and commits.
- Never publish or proxy the management API port. Identity headers count only with a matching `PROXY_SECRET`.
- Offer only the voices in `VOICES` (src/features/say.ts). Speech speed follows a measured curve, not a
  proportional one.
- Music resumes at the same second after a restart if people are still in the channel and it was under 10 minutes
  ago, so redeploying during playback is fine.
- Public playlists come from the Spotify embed page's `__NEXT_DATA__` (first 100 songs) and covers from oEmbed. If
  playlists break, check that page's shape first.

## Where to look

- README.md: "Settings and defaults", "Configuration" (env and management API tables) and "Setup".
- `.env.example`: every variable with its default.
- `docker-compose.yml`: a reference stack with the optional voice, loop and music services.
