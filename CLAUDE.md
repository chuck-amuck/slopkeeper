# slopkeeper

A Discord bot for friends' servers (hop-on pings, game picks, sales, stats, a soundboard, text to speech, music and
a looping room), with a web UI in `web/`, Piper text to speech in `voice/` and yt-dlp playback in `music/`. Node 24
runs the TypeScript directly, with no build step. README.md is the short start; the user guide is in `docs/`, a page
per feature, with server setup, self-hosting and the API on pages of their own.

## Commands

There's no npm on the development machine, so run the bot's checks in the image's own `base` stage: Node 24 plus the
same static ffmpeg as the image and CI. Without ffmpeg the audio tests skip silently and the run looks green.

- Build that once, and again when the Dockerfile's ffmpeg changes: `docker build -q --target base -t sk-test .`
- Bot typecheck and tests (about 20 s):
  `docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/npm -v "$PWD":/app -w /app sk-test sh -c 'npx tsc -p . && npm test'`
- One file, in the same container: `node --disable-warning=ExperimentalWarning --test test/<name>.test.ts` (add
  `--test-name-pattern="<name>"` for one test).
- Web: `cd web && node --test 'test/*.test.ts'` works with the host's node; typecheck with `npx tsc -p .` in the
  container.
- Music container: `node --test 'music/*.test.mjs'`. `voice/` has syntax checks and tests, which CI runs too:
  `python3 -m py_compile voice/*.py`, `python3 -m unittest discover -s voice -p '*_test.py'` and `sh -n voice/start.sh`.
- Voice image: `docker build -q -t sk-voice-test voice && sh voice/smoke.sh sk-voice-test /tmp/voice-models` makes it
  say a line with the default and Spanish models, and with one whose settings list speakers it doesn't take (about
  140 MB, kept in that folder). CI runs it before pushing.
- Its Python packages are pinned with hashes in `voice/requirements.txt`, from `voice/requirements.in`. To update them:
  `docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/voice":/v -w /v python:3.12-slim-bookworm sh -c 'pip install -q --user uv && /tmp/.local/bin/uv pip compile requirements.in --upgrade --universal --generate-hashes --python-version 3.12 --no-header --no-annotate -o requirements.txt'`,
  then run the smoke test and listen to every voice before shipping it.
- Front end: `for f in web/public/*.js; do node --check "$f"; done`.
- Charts and the calendar are ECharts and Cally, built into `web/public/vendor-*.js` by `scripts/build-vendor.sh` (the
  command is at its top). Don't edit those files; change a version there and build again.
- Every web UI page in headless Chromium, at computer and phone widths (about 20 s), on the host, since sk-test has no
  browser and skips it: `node --disable-warning=ExperimentalWarning --test test/webui.test.ts` (`CHROME` names another
  browser). CI requires it.
- Web UI by hand: run `web/src/index.ts` against a fake bot (`BOT_URL`) and drive `chromium --headless=new` over CDP.
  Non-GET calls need the header `x-slopkeeper: 1`.

## Shipping a change

1. Run `/code-review low` on the diff (medium for a big or risky one) and fix real findings.
2. Push once the typecheck and tests pass. Never chain `commit && push` after a red or partial run. Break checks
   (deliberate mutations) cover only the riskiest changes and run after the release.
3. `git fetch` before pushing: other sessions push here too.
4. CI (`.github/workflows/image.yml`) runs the bot, web and music tests and builds four images: the bot (which also
   runs the loop bot), web, voice and music. If a run stalls (say.test.ts has hung),
   `gh run cancel <id>`, then `gh run rerun <id>`.
5. A web-only change ships as its own image. Browser tabs opened before the redeploy keep the old page, and offer
   Reload once an answer carries a different `x-slopkeeper-version`. How the deployment picks up images is in
   CLAUDE.local.md.

## Rules

- Never bump `SCHEMA_VERSION` in src/db.ts: an older database with a `games` table makes the bot refuse to start.
  Add tables with `CREATE TABLE IF NOT EXISTS` and columns with the `pragma_table_info` + `ALTER TABLE` pattern.
- Every setting is editable in the web UI. `/setup` (src/features/setup.ts) is optional: the owner is fine with a
  setting living only in the web UI (the default and looping speech voices do), marked "web UI only" in the
  "Settings and defaults" table in docs/server-setup.md. A new per-server setting touches src/settings.ts DEFAULTS
  (an env var only sets the default), web/public/settings.js, `.env.example`, that table and the tests.
- Rules live in the bot (src/features, src/api.ts and its areas in src/api/). `web/` stores nothing and proxies to
  the management API.
- Spotify stays search-only: no `SPOTIFY_REFRESH_TOKEN` in the deployment and no personal playlists. Soloist
  playback was removed in fec6b23; bring it back only if asked.
- `test/helpers.ts` is the first import in every test file: it sets DATA_DIR, DISCORD_TOKEN and TZ before db.ts
  opens the database.
- Tests must let the process exit: `.unref()` idle timers, mock timers and stop audio loops in `t.after`. A hung
  file stalls CI.
- Each user-visible change updates its page in `docs/`, and `.env.example` for a new variable. Links between the
  pages are checked by test/docs.test.ts. Commit subjects read
  "<Area>: <what people get>".
- This repo and three of its images are public. Keep LAN addresses, hostnames, deployment IDs, server names,
  emails and personal details out of code, tests, docs and commits.
- Never publish or proxy the management API port. Identity headers count only with a matching `PROXY_SECRET`.
- Offer only the voices from `voices()` (src/features/say.ts): the built-in ones and those added in the web UI
  (src/features/voices.ts, downloaded by voice/models.py). Speech speed follows a measured curve, not a proportional
  one. Added voices are measured by src/features/voiceTuning.ts; a built-in model still needs measuring by hand and the
  nearest curve picked, within about 5%.
- The voices' effects run through the Dockerfile's pinned static ffmpeg. Before changing its version, render every
  voice with both and compare them: rubberband and other filters can change between versions.
- Music resumes at the same second after a restart if people are still in the channel and it was under 10 minutes
  ago, so redeploying during playback is fine.
- Public playlists come from the Spotify embed page's `__NEXT_DATA__` (first 100 songs) and covers from oEmbed. If
  playlists break, check that page's shape first.

## Where to look

- docs/server-setup.md: "Settings and defaults". docs/self-hosting.md: "Configuration" (the env table) and the
  containers. docs/api.md: the management API table.
- `.env.example`: every variable with its default.
- `docker-compose.yml`: a reference stack with the optional voice, loop and music services.
