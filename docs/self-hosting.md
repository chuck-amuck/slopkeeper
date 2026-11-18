# Self-hosting

For whoever runs the bot: the Discord application, the containers and their settings.

The host runs the bot and keeps its tokens; each server's admin then adds it and runs `/setup` (see [Setting up a server](server-setup.md)). The two can happen in either order, and can be the same person.

## Hosting the bot

1. **Create the application.** Go to https://discord.com/developers/applications → **New Application**. Then, on the **Bot** tab:
   - **Reset Token** and copy it into `.env` as `DISCORD_TOKEN`. Keep it secret: anyone with the token can control the bot.
   - Enable **Presence Intent**, **Server Members Intent** and **Message Content Intent**. The bot crashes on startup with `Used disallowed intents` without them.
   - If someone else is adding the bot to their server, turn **Public Bot** on. Otherwise only you can add it. Leave **Requires OAuth2 Code Grant** off.
2. **Get a Steam Web API key** at https://steamcommunity.com/dev/apikey (any domain name works) and set `STEAM_API_KEY`.
3. **Fill in `.env`** (`cp .env.example .env`). If **Public Bot** is on, set `ALLOWED_GUILD_IDS` to the servers you expect. Server admins can send you their server ID (right-click the server icon → **Copy Server ID**, with Developer Mode on).
4. **Start it:**
   ```sh
   docker compose up -d --build
   docker compose logs -f slopkeeper
   ```
   The log lists each server it registered commands in, then `Logged in as Slopkeeper#1234 in N servers`.
5. **Send the invite link** to each server admin. Either use **OAuth2 → URL Generator** with scopes `bot` + `applications.commands` and the permissions View Channels, Send Messages, Embed Links, Connect, Speak, Manage Roles, Create Expressions, Manage Expressions and Create Events, or fill your application ID (from **General Information**) into this link:
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=26389624409088
   ```

Local dev (Node 24+): `npm install && npm run dev`. `npm run typecheck` runs tsc, and `npm test` runs the tests (the audio ones need ffmpeg and are skipped without it). GitHub Actions runs them on every push, with the same static ffmpeg as the image, and each image is only built once its own checks pass.

Data (SQLite DB and uploaded sounds) lives in the `slopkeeper-data` volume at `/data`, with each server's sounds in `sounds/<server id>/`, and the first version of any trimmed sound in `originals/` inside that. The bot copies its database to `backups/` in that volume once a day and keeps the last 7 copies, leaving out the [performance numbers](api.md#performance-numbers). Those guard against a bad update or a damaged database, not against losing the disk, and they don't include sounds, so back the volume up elsewhere too.

Voice sessions in progress are saved when the bot stops, and carry on if it's back within 10 minutes. A crash loses them. Game stats are saved every 5 minutes and when the bot stops, so a crash loses at most a few minutes of them.

## Configuration

Set in `.env` (see `.env.example`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | required | Bot token |
| `STEAM_API_KEY` | none | Needed for `/steam` and the picker's Steam data |
| `ALLOWED_GUILD_IDS` | any server | Comma-separated server IDs allowed to use the bot; it leaves any other server |
| `SALE_CHECK_HOURS` | 6 | How often Steam prices are checked, for every server at once. Posts go out once a day, at each server's sale post time |
| `ITAD_API_KEY` | none | An [IsThereAnyDeal](https://isthereanydeal.com) API key, for [other stores' Steam keys](deals.md#other-stores) and the lowest price ever in sale alerts, and for [bundles](deals.md#bundles). Sign in, register an app under your account's apps page, and copy its API key |
| `GGDEALS_API_KEY` | none | A [gg.deals](https://gg.deals) API key, from your gg.deals account settings, for the cheapest [key reseller](deals.md#other-stores) beside a sale. Your account's email address must be confirmed |
| `TZ` | UTC | The container's time zone, and every server's default time zone |
| `API_TOKEN` | off | Turns on the [management API](api.md#management-api) and is the token that unlocks it |
| `API_PORT` | 8787 | Port for the management API |
| `DATA_DIR` | `./data`, `/data` in the image | Where the database, sounds and backups are kept |
| `VOICE_URL` | off | Where the [voice container](#the-voice-container) is. Unset turns `/say` off |
| `MUSIC_URL` | off | Where the [music container](#the-music-container) is. Unset turns music off |
| `LOOP_BOT_URL` | off | Where the [loop bot](#the-loop-bot) is. Unset plays the looping room on this bot |
| `LOOP_TOKEN` | none | Same value as the loop bot's `LOOP_TOKEN` |
| `LOOP_PORT` | 8788 | The loop bot's port, set in its own container |
| `MUSIC_TOKEN` | none | Same value as the music container's `MUSIC_TOKEN` |
| `MUSIC_AUDIO_DIR` | `/music/audio` | Where the bot reads the songs the music container downloads, from its volume |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | none | A Spotify app's, for Spotify search. Without one, search uses YouTube Music, and Spotify links are read from Spotify's public player. See [the music container](#the-music-container) |
| `SPOTIFY_REFRESH_TOKEN` | none | From the Spotify account signing in once, so the bot can read its own playlists. See [the music container](#the-music-container) |
| `SPOTIFY_MARKET` | `US` | The country whose Spotify catalogue search uses |
| `ANTHROPIC_API_KEY` | none | An [Anthropic](https://console.anthropic.com) API key, for [answering in chat](chat.md). Unset, the bot doesn't answer |

Everything else is a per-server setting. Servers set their own with `/setup`; the variables in [Settings and defaults](server-setup.md#settings-and-defaults) change the default for servers that haven't. For example, `HOPON_MIN_PEOPLE=3` makes every server wait for 3 people unless it ran `/setup hopon`.

## The voice container

Text to speech runs [Piper](https://github.com/OHF-Voice/piper1-gpl) in a third container, built from [`voice/`](../voice). It stays on the host, so nothing typed leaves your network.

```yaml
voice:
  image: ghcr.io/chuck-amuck/slopkeeper-voice:latest
  restart: unless-stopped
  init: true
  deploy:
    resources:
      limits:
        memory: 2048M
  volumes:
    - slopkeeper-voice:/voices
```

Set `VOICE_URL=http://voice:5000` on the bot, and don't publish the port. On first start it downloads eleven models (about 750 MB) into its volume, and after that it needs no internet. Voices [added in the web UI](speech.md#adding-voices) download into the same volume when they're added. A model that can't be fetched leaves its voice talking with the first model until the container restarts:

- `en_US-libritts_r-medium` (79 MB, CC BY 4.0) holds 904 voices. Three of them are the American voices, and the effects are ffmpeg filters the bot runs on any voice.
- The English accents are Piper models trained on English readers, 61 to 74 MB each.
  - Scottish is [`en_GB-alba-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_GB/alba/medium) (CC BY 4.0).
  - Northern English is [`en_GB-northern_english_male-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_GB/northern_english_male/medium) and the Southern English woman [`en_GB-southern_english_female-low`](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_GB/southern_english_female/low) (both CC BY-SA 4.0). The woman is only made in low quality.
  - The Southern English man is the first speaker of [`en_GB-southern_english_male-medium`](https://huggingface.co/csukuangfj/vits-piper-en_GB-southern_english_male-medium), packaged for sherpa-onnx (Apache 2.0), as Piper's own list has only the woman.
  - Irish is Jenny (Dioco), [`en_GB-jenny_dioco-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_GB/jenny_dioco/medium), whose [recordings' license](https://github.com/dioco-group/jenny-tts-dataset) asks for the voice to be called Jenny.
  - Australian is two of the ten LibriVox readers in [`en_AU-librivox-medium`](https://huggingface.co/DataCraftsmanAustralia/piper-en_AU-librivox-medium) (CC BY 4.0), the lowest and highest voiced.
- The accents are official Piper models in other languages, 63 to 77 MB each. A model reads English as noise or by its own spelling, so `voice/accent.py` turns English into the nearest sounds of its language first, with the habits that make the accent.
  - State broadcast is [`ko_KR-kss-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/ko/ko_KR/kss/medium) (CC BY-NC-SA 4.0: non-commercial use only), with a loudspeaker's narrow, compressed sound and echo added by the bot.
  - Russian is [`ru_RU-dmitri-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU/dmitri/medium) (CC0).
  - Spanish is [`es_ES-davefx-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/es/es_ES/davefx/medium) (CC0).
  - German is the neutral speaker of [`de_DE-thorsten_emotional-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/thorsten_emotional/medium) (CC0), which also has amused, angry, disgusted, drunk, sleepy, surprised and whispering speakers.

`BUILT_IN` and `STYLES` in `src/features/say.ts` list the built-in voices. Each model loads the first time it's used, and one other than the first is let go after 30 minutes unused (`VOICE_IDLE_MINUTES` in the container's environment, `0` to keep them), so the next line in that voice takes about a second longer. At most ten besides the first stay loaded (`VOICE_MAX_MODELS`, `0` for no limit). With eleven loaded it uses about 1.3 GB, briefly near 1.7 GB for a long line at the slowest speed, and about 200 MB with only the first. Larger added models take more, so lower `VOICE_MAX_MODELS` or raise the memory limit if you add several. A short line takes about a second on two CPU cores.

## The music container

Music needs a container built from [`music/`](../music). It finds songs and downloads their audio with [yt-dlp](https://github.com/yt-dlp/yt-dlp), and searches YouTube Music with [ytmusicapi](https://github.com/sigma67/ytmusicapi). Spotify is optional, to search Spotify (its links work without it): every song plays from YouTube or SoundCloud, and one neither has is skipped. Each server picks where searching looks in its settings.

**Read this first.** Downloading from YouTube and SoundCloud is against their terms of service, and playing into a Discord channel for others may be too. It's for a few friends in a private server; YouTube can slow down or block an address that downloads a lot. yt-dlp never signs in to anything.

1. **Spotify app (optional):** without one, searching uses YouTube Music, and Spotify song, album and playlist links are read from Spotify's public player. Sign in to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), create an app with any name, the redirect URI `http://127.0.0.1:8888/callback` (only step 4 uses it) and only **Web API** ticked, then copy its Client ID and Client Secret from its settings. On its own it only reads the catalogue. Step 4 adds an account's playlists. Since February 2026 these apps need a Premium owner.
2. **Add the container,** and don't publish its port. The bot reads the downloaded audio from the same volume:
   ```yaml
   slopkeeper:
     volumes:
       - slopkeeper-data:/data
       - slopkeeper-music:/music:ro
   music:
     image: ghcr.io/chuck-amuck/slopkeeper-music:latest
     restart: unless-stopped
     init: true
     environment:
       MUSIC_TOKEN: ${MUSIC_TOKEN}
     volumes:
       - slopkeeper-music:/data
     deploy:
       resources:
         limits:
           memory: 512M
   ```
3. **Set on the bot:** `MUSIC_URL=http://music:7700`, `MUSIC_TOKEN` (any long random value, the same on both), and with a Spotify app, `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`.
4. **Playlists (optional):** the Music tab's **My playlists** only shows once this is done. With the bot running, sign in once as the Spotify account whose playlists you want. The Spotify app must belong to that account:
   ```sh
   docker compose exec -it slopkeeper node src/spotify-sign-in.ts
   ```
   It prints a link to open and agree to, then asks for the address the browser ends up on. That page doesn't load, which is expected. It prints `SPOTIFY_REFRESH_TOKEN=...` for `.env`. Restart the bot to use it. It only lets the bot read that account's playlists. If Spotify ever turns it down, the Music tab says so: run the script again and replace it.

YouTube changes often and old yt-dlp versions stop working, so the container updates yt-dlp when it starts and daily after that. Each song is about 3 to 9 MB. The container keeps the most recently played songs, up to `MUSIC_CACHE_MB` (1024 by default), so songs played again start at once. It also downloads videos for [adding a sound from a link](soundboard.md#adding-a-sound-from-a-link), at 480p or less, into the volume's `clips` folder, and deletes each an hour after it was last asked for. Those don't count toward `MUSIC_CACHE_MB`. It uses about 100 MB of memory, and more for a moment while a song downloads. Settings and the Music tab say if yt-dlp isn't working. The bot reads the audio from `MUSIC_AUDIO_DIR`, `/music/audio` by default, which is the volume's `audio` folder.

## The loop bot

A second Discord bot that only plays the [looping sound room](soundboard.md#looping-sound-room), so the main bot is free to play everywhere else. It runs from the same image, with a different command, and reads the sounds and speech the main bot prepares from the data volume, read-only. It has no commands or settings of its own: the main bot sends it what to play over a private connection inside the stack.

1. **Make the bot:** in the [Discord developer portal](https://discord.com/developers/applications), create a new application, say "Slopkeeper Loop", and copy its bot token from the **Bot** page. It needs no privileged intents.
2. **Invite it:** under **OAuth2 → URL Generator**, tick the `bot` scope and the **View Channels**, **Connect** and **Speak** permissions, then open the URL and pick the server.
3. **Add the container,** and don't publish its port:
   ```yaml
   loop:
     image: ghcr.io/chuck-amuck/slopkeeper:latest
     command: ["node", "--disable-warning=ExperimentalWarning", "src/loopBotMain.ts"]
     restart: unless-stopped
     init: true
     environment:
       LOOP_BOT_TOKEN: ${LOOP_BOT_TOKEN}
       LOOP_TOKEN: ${LOOP_TOKEN}
       ALLOWED_GUILD_IDS: ${ALLOWED_GUILD_IDS:-}
     volumes:
       - slopkeeper-data:/data:ro
   ```
4. **Point the bot at it:** add `LOOP_BOT_URL: http://loop:8788` and `LOOP_TOKEN: ${LOOP_TOKEN}` to the bot's environment. `LOOP_TOKEN` is any long random value, the same for both.

With `LOOP_BOT_URL` set, the main bot never plays the room itself, and if the loop bot is down the room stays quiet until it's back. The main bot sends the room again on every voice change and once a minute, so a restarted loop bot picks it up by itself. The loop bot leaves a room that's been empty for 30 seconds even if it isn't told to, and leaves any server not in `ALLOWED_GUILD_IDS`.
