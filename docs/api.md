# Management API and performance numbers

For hosts and tools: the API the web UI uses, and how the bot keeps track of how it's doing.

## Management API

With `API_TOKEN` set, the bot serves an HTTP API for managing sounds and settings, for the [web UI](web-ui.md) to use. It's off by default, and the bot works the same without it.

It applies the same rules as `/sound` and `/setup`, and every request needs an `Authorization: Bearer <token>` header. The web UI adds `x-slopkeeper-email` and `x-slopkeeper-name`, URL-encoded, for someone signed in through Pangolin, and changes are credited to them. It has no other login, so keep it on the container network: don't publish the port or put it behind a proxy.

| Request | What it does |
| --- | --- |
| `GET /guilds` | Lists servers |
| `GET /guilds/:id/sounds` | Lists sounds, Discord slots, the sound groups in order and the server's emoji. A sound cut from a link has `link` (`url`, `title`, `start`, `end`), and `links` is null when there's no music container to add from links |
| `POST /guilds/:id/sound-links` | Downloads a video or track to cut a sound from: `{ "url": "https://..." }`. Returns its `id`, `title`, `artist`, `seconds` and whether it has `video`. The bot forgets it after an hour unused, or on a restart |
| `GET /guilds/:id/sound-links/:download/media` | Sends the downloaded video or track |
| `GET /guilds/:id/sound-links/:download/wave` | Its waveform, as about 2,000 peaks from 0 to 1 |
| `PUT /guilds/:id/sound-links/:download` | Saves part of it as a sound: `{ "name": "...", "start": 2, "end": 4.5, "discord": true }`, up to 3 minutes. A taken name gets 409 unless `"replace": true` or `"keep": true`, as for uploads |
| `PUT /guilds/:id/sounds/:name?file=<filename>` | Adds a sound; the body is the file. A taken name gets 409 unless `&replace=1`, which moves the old sound to Recently deleted, or `&keep=1`, which adds it under the next free name. The reply gives the name it's under. `&discord=0` keeps a new sound off Discord's soundboard |
| `PATCH /guilds/:id/sounds/:name` | Renames it, sets its emoji, volume or star (the Favourites group), or moves it: `{ "name": "..." }`, `{ "emoji": "..." }`, `{ "volume": 50 }`, `{ "favourite": true }`, `{ "place": { "group": 3, "before": "airhorn" } }` (leave out `before` for the end of the group; `"group": null` takes it out of every group). A move answers with the groups as they are now |
| `POST /guilds/:id/sound-groups` | Makes a group at the bottom: `{ "name": "Reactions" }`. It answers with the groups as they are now, as do the two below |
| `PATCH /guilds/:id/sound-groups/:group` | Renames a group or moves it: `{ "name": "..." }`, `{ "to": 0 }` (its place, counting from 0 at the top) |
| `DELETE /guilds/:id/sound-groups/:group` | Deletes a group. Its sounds go back among the rest |
| `DELETE /guilds/:id/sounds/:name` | Moves it to the bin for 30 days. Returns `binId`, its id in the bin |
| `GET /guilds/:id/sounds/:name/audio` | Downloads its audio |
| `POST /guilds/:id/sounds/:name/play` | Plays it in a voice channel with people in it: `{ "channelId": "..." }` |
| `GET /guilds/:id/deleted-sounds` | Lists what's in the bin, newest first |
| `POST /guilds/:id/deleted-sounds/:deleted/restore` | Brings it back, and says what it's called now |
| `DELETE /guilds/:id/deleted-sounds/:deleted` | Erases it for good |
| `GET /guilds/:id/game-names` | Every game with what else it's been called |
| `POST /guilds/:id/game-names/merge` | Merges games: `{ "names": ["A", "B"], "into": "A" }` |
| `POST /guilds/:id/game-names/separate` | Puts a spelling back as its own game: `{ "name": "B" }` |
| `POST /guilds/:id/game-names/not-a-game` | Leaves a game out of everything, as not a game: `{ "name": "launcher" }` |
| `POST /guilds/:id/game-names/a-game` | Counts a game marked as not a game again: `{ "name": "launcher" }` |
| `POST /guilds/:id/sounds/:name/trim` | Keeps only part of it, in seconds: `{ "start": 1.5, "end": 4 }` |
| `POST /guilds/:id/sounds/:name/restore` | Puts a trimmed sound back as it was |
| `PUT /guilds/:id/sounds/:name/discord` | Copies it to Discord's soundboard: `{ "start": 12.5 }` picks a part of a long sound, `{ "replacing": "<sound id>" }` swaps out a sound there |
| `DELETE /guilds/:id/sounds/:name/discord` | Takes it off Discord's soundboard |
| `POST /guilds/:id/discord-sync` | Copies every sound that fits to Discord's soundboard |
| `GET /guilds/:id/discord-sounds/:soundId/audio` | Downloads the audio of a sound on Discord's soundboard |
| `POST /guilds/:id/discord-sounds/:soundId/play` | Plays it in a voice channel: `{ "channelId": "..." }` |
| `POST /guilds/:id/discord-sounds/:soundId/save` | Saves it to the library and links the two |
| `DELETE /guilds/:id/discord-sounds/:soundId` | Takes it off Discord's soundboard, saving it to the library first. Returns its library `name` |
| `GET /guilds/:id/sales` | Lists what's watched and on sale, from the last check, with why |
| `GET /guilds/:id/deals` | The Deals tab: what's on sale with how it compares with the lowest price ever (`lowest`: `yet` and `text`) and who wants or wishlisted each (`people`), and the bundles with games for the server as last worked out (`bundles` and `bundlesAt`; null before the first look, or with `bundlesOff` saying `no-key` or `off`) |
| `GET /guilds/:id/games` | Lists the game library with owners, who needs each game, who wants it, any sale and `played` (time in voice here and when it last was, or null), plus the server's members |
| `GET /guilds/:id/steam-links` | Lists the server's members with their linked Steam account, if any, and whether Steam is set up |
| `PUT /guilds/:id/steam-links/:user` | Links or changes someone's account: `{ "profile": "<link, custom URL name or SteamID64>" }` |
| `DELETE /guilds/:id/steam-links/:user` | Unlinks them and forgets their library |
| `POST /guilds/:id/steam-refresh` | Re-reads every linked library |
| `GET /guilds/:id/games/owned` | Lists Steam games members own that aren't in the library, those the most people have first |
| `POST /guilds/:id/games` | Adds a game: `{ "name": "..." }` takes a name or Steam store link, `{ "appid": 620 }` takes one from the owned list |
| `PATCH /guilds/:id/games/:game` | Sets its details: `{ "maxPlayers": 4 }`, `{ "steam": "<link or app ID>" }`, with null or an empty link to clear |
| `DELETE /guilds/:id/games/:game` | Removes it and its marks |
| `PATCH /guilds/:id/games/:game/members/:user` | Marks someone: `{ "owns": true }`, `{ "wants": true }`. Owning clears wanting, and Steam ownership can't be changed |
| `PUT /guilds/:id/steam-links/:user/family` | Puts someone in another person's Steam family: `{ "with": "<user id>" }` |
| `DELETE /guilds/:id/steam-links/:user/family` | Takes someone out of their Steam family |
| `GET /guilds/:id/free-games` | Lists what's free right now, with whether each game is posted and why |
| `GET /guilds/:id/voice` | Lists voice channels with people in them, busiest first |
| `GET /guilds/:id/volumes` | The volumes the web UI's sliders show: `sounds`, `speech`, `music`, `loopSound` and `loopSpeech`, each null when that part isn't set up |
| `POST /guilds/:id/volumes/:volume/preview` | Plays what's playing at `{ "value": 25 }` percent while a slider (`sounds`, `speech` or `music`) is dragged, within the setting's limits, without saving or logging it. Saving the setting keeps it; otherwise the saved volume comes back after 5 seconds |
| `POST /guilds/:id/stop` | Stops every sound and any spoken lines waiting, leaving the music playing. Returns `musicPlaying` |
| `GET /guilds/:id/playing` | The sounds and speech playing, not the music: `version` and `playing` (`id`, `name`, `kind` sound or speech, `loop`, `started` once it's heard, `elapsedMs`). With `?after=<version>` it waits up to 25 s for a change |
| `POST /guilds/:id/playing/:playingId/stop` | Stops one of them. 404 if it's already finished |
| `GET /guilds/:id/updates?playing=&music=&voice=&nights=&activity=&sounds=&volumes=&health=&deals=` | Waits up to 25 s until any part asked for has a version other than the one given (empty for none yet), then answers with only those that changed, each with its new `version`: `playing` as from `/playing`, `music` as from `/music`, `voice` as from `/voice`, `nights` as from `/game-nights`, `activity` as the newest page of `/activity`, `sounds` as from `/sounds` with the bin from `/deleted-sounds` as `bin`, `volumes` as from `/volumes`, and `health` with only its `version`, which changes as each minute of [performance numbers](#performance-numbers) is kept, and `deals` likewise, which changes after each price check and each look through the bundles. Ask for any of them. Answers `{}` if nothing changed. The page keeps up through this, one request per tab |
| `GET /guilds/:id/say` | Whether text to speech is `on`, the `voices` (each with its `group`: Characters or Accents), the default `voice`, the `effects`, the default `effect` (`none` for none), `oldVoices` (the effects' old voice ids, each with the `voice` and `effect` it became), the `longest` line and the saved `phrases`. The speech volume is in `/volumes` |
| `GET /guilds/:id/say/preview?voice=<id>&effect=<id>&text=<text>` | The line in that voice and effect as a WAV file, for the page to play to whoever asked; a blank `text` has the voice say its name. At most one every 2 seconds and 12 a minute per server |
| `POST /guilds/:id/say` | Reads out `text` in `channelId`, with an optional `voice` and `effect` (`none` for none; left out, the server's default). Answers once the line starts |
| `POST /guilds/:id/phrases` | Saves `text`, and answers with the `phrases` |
| `DELETE /guilds/:id/phrases/:id` | Removes a saved line, and answers with the `phrases` |
| `GET /guilds/:id/voices` | The voices added in the web UI, for every server, each with its settings and download `state`, whether it's being measured (`tuning`), the last measurement (`measured`: `curve`, `fit`, `volume`, `at`, or null) and `tune`, `most`, how many there can be, and the `effects` for previews. 409 without `VOICE_URL`, as for the routes below |
| `POST /guilds/:id/voices` | Adds a voice: `{ "name": "...", "model": "<.onnx link>" }`, plus any of the fields in an [export entry](speech.md#adding-voices). The voice container downloads it |
| `PUT /guilds/:id/voices/:voice` | Changes a voice, with only the fields given. A new `volume` or `curve` makes it `manual` unless `tune` is given too; `"tune": "auto"` puts the measured values back |
| `POST /guilds/:id/voices/:voice/measure` | Forgets a voice's measurement and measures it again. 409 until it's downloaded |
| `DELETE /guilds/:id/voices/:voice` | Removes a voice and its model. Returns `picks`, how many servers' picks of it went back to their default |
| `POST /guilds/:id/voices/:voice/preview` | The voice saying `text` (or a sample) as a WAV file, with any changed settings given beside it, before they're saved, and through `effect` if given. 409 until it's downloaded |
| `GET /guilds/:id/voices/export` | Every added voice as `slopkeeper-voices.json` |
| `POST /guilds/:id/voices/import` | `{ "voices": [...], "replace": false, "dryRun": true }`, the `voices` being an export's list. Returns what it would add, change, leave, remove and skip; only `"dryRun": false` does it |
| `GET /guilds/:id/music` | What's playing, how far in, the queue, the music volume and why music can't play, if it can't. `since` is when the music started, the same through pauses, skips and restarts until it stops. It and every music control's answer carry the `version` that `/updates` counts, so a page can tell an older answer from a newer one |
| `GET /guilds/:id/music/search?q=<words>` | Up to 10 songs from Spotify |
| `POST /guilds/:id/music/queue` | Adds a search result `{ "track": {...} }`, what's typed `{ "query": "<words or link>" }` or an upload `{ "file": "<id>" }`, at the end or `"next": true`. With nothing queued, `"next": true` plays it now in `"channelId"` if anyone's there |
| `POST /guilds/:id/music/file?name=<filename>` | Uploads an audio file to add; the body is the file. Up to 60 MB and 20 minutes, and 500 MB of uploads for each server. Answers with the `file` (`id`, `title`, `artist`, `durationMs`) for `POST music/queue`, which has an hour to add it |
| `DELETE /guilds/:id/music/file/:file` | Throws away an upload that hasn't been added |
| `POST /guilds/:id/music/queue/:song/move` | Moves a song: `{ "to": 2 }`, counting from 0. The song playing stays first, people's songs stay ahead of Autoplay's, and Autoplay's don't move |
| `POST /guilds/:id/music/queue/:song/keep` | Keeps one of Autoplay's songs, as if it had been queued: it goes after people's songs, and Autoplay follows it |
| `DELETE /guilds/:id/music/queue/:song` | Takes a song out, skipping it if it's playing |
| `DELETE /guilds/:id/music/queue` | Empties the queue, apart from the song playing |
| `POST /guilds/:id/music/play` | Starts or carries on in a voice channel: `{ "channelId": "..." }` |
| `POST /guilds/:id/music/pause`, `skip` and `stop` | As `/music` does. Stop clears the queue |
| `GET /guilds/:id/game-nights` | Lists upcoming game nights and repeating series, and what a new night can be set to |
| `POST /guilds/:id/game-nights` | Plans a night as `/gamenight plan` does: `{ "game", "when", "channelId", "hostId", "voiceChannelId", "details", "repeat" }`, where `repeat` is 7, 14 or null |
| `GET /guilds/:id/game-nights/:night/friends` | Who's going but isn't Steam friends yet, with profile links: `strangers`, `unknown` where both lists are private, and `unlinked` |
| `GET /guilds/:id/game-nights/when?text=<time>` | Says how a typed time reads, without planning anything |
| `POST /guilds/:id/game-nights/:night/rsvp` | Answers `{ "answer": "in" \| "maybe" \| "out", "userId" }` as the card's buttons do, and redraws the card. Someone signed in who has said who they are always answers for themselves |
| `PATCH /guilds/:id/game-nights/:night` | Changes a night as its Edit button does: any of `{ "game", "when", "details", "voiceChannelId" }`, where null clears details or the voice channel. Returns what `changed`, an `eventNote` if the Discord event couldn't follow, and the `night` as listed. The listing's `when` is the night's time in a form that reads back exactly |
| `POST /guilds/:id/game-nights/:night/cancel` | Cancels a night, as its Cancel button does |
| `DELETE /guilds/:id/game-night-series/:series` | Stops a series; nights already posted stay on |
| `GET /guilds/:id/join-sounds` | Lists who has a join sound |
| `PUT /guilds/:id/join-sounds/:user` | Sets someone's join sound: `{ "name": "airhorn" }`. `warning` is set if join sounds are turned off |
| `DELETE /guilds/:id/join-sounds/:user` | Removes someone's join sound |
| `GET /guilds/:id/chat-notes` | What [chat](chat.md) remembers about people: `{ notes: [{ userId, name, note, at }] }` |
| `DELETE /guilds/:id/chat-notes/:user` | Has it forget what it remembers about someone |
| `GET /guilds/:id/chat-reminders` | Reminders set in chat, soonest first: `{ reminders: [{ id, at, when, text, by, people, channel }] }` |
| `DELETE /guilds/:id/chat-reminders/:id` | Cancels one |
| `GET /guilds/:id/chat-try` | What the web UI's [Chat tab](chat.md#trying-it-in-the-web-ui) starts from: `{ ready, note, chatOn, members, channels, me, botName, speech, inDiscord }` |
| `POST /guilds/:id/chat-try` | The bot's answer to `{ "text": "roast @Sam", "as": userId, "channelId": id, "history": [{ from, text, at, as }] }` (`from` is `you` or `bot`), with nothing done or posted: `{ answer, pings, asked, aloud, quiet, heard, would, looked, model, seconds, cost }`. It counts toward the day's answers. 429 within 10 seconds of the last one, or past the day's limit |
| `POST /guilds/:id/chat-try/speech` | `{ text, voice, effect }` said as a WAV, as it would be in voice |
| `GET /guilds/:id/game-pings` | Lists games with ping roles, plus the games and roles that can be added |
| `POST /guilds/:id/game-pings` | Adds pings for a game: `{ "game": "Valheim", "roleId": "..." }`. Leave out `roleId` to make a new role |
| `DELETE /guilds/:id/game-pings/:role` | Stops pings for a game, and deletes the role if the bot made it |
| `GET /guilds/:id/hidden-games` | Lists games hidden from `/whatdoweplay` |
| `PUT /guilds/:id/hidden-games/:appid` | Hides a game from `/whatdoweplay`. `{ "name": "..." }` names a Steam game that isn't in the library |
| `DELETE /guilds/:id/hidden-games/:appid` | Lets a hidden game be suggested again |
| `GET /guilds/:id/pick?channel=<id>` or `?users=<id>,<id>` | Games those people could play, as `/whatdoweplay` works out, with time played, Steam hours and game facts for each |
| `GET /guilds/:id/lobbies` | Who's in a joinable Steam lobby now, with a `steam://` link |
| `GET /guilds/:id/steam-apps/:appid` | How many are playing a game on Steam now, kept for 10 minutes, and its latest `patch`. `players` is null if Steam won't say |
| `GET /guilds/:id/achievements?appid=<id>&users=<id>,<id>` | Achievement progress for those people, with `goals` nobody has yet and who was `skipped` |
| `GET /guilds/:id/pick/options` | Lists the members, voice channels and text channels to choose from, and `pickable`: the members whose games the bot knows |
| `POST /guilds/:id/votes` | Starts a vote: `{ "voiceChannelId", "channelId", "minutes", "games" }`, with 1 to 10 minutes. `games`, a list of names, narrows it to those games |
| `GET /guilds/:id/compare?a=<id>&b=<id>` | Compares two people, as `/compare` does |
| `GET /guilds/:id/compare/people` | Lists the members with time in voice or a game played there, to compare |
| `GET /guilds/:id/recap?month=<last\|this>` | A month's highlights, as `/recap` shows them |
| `GET /guilds/:id/members/:user/pings` | Lists the hop-on and game ping roles, and which someone has |
| `PUT /guilds/:id/members/:user/pings` | Turns one on or off: `{ "roleId": "...", "on": true }`. Other roles can't be changed |
| `POST /guilds/:id/sound-panels` | Posts a soundboard panel: `{ "channelId": "..." }` |
| `POST /guilds/:id/game-pings/menu` | Posts the Choose games button: `{ "channelId": "..." }` |
| `GET /guilds/:id/activity?before=<id>` | The last year of changes to sounds, settings and game nights, 50 at a time, newest first |
| `GET /guilds/:id/me` | Who's signed in through Pangolin, and which member they said they are |
| `PUT /guilds/:id/me` | Says which member the signed-in person is: `{ "userId": "..." }` |
| `DELETE /guilds/:id/me` | Unlinks them |
| `GET /guilds/:id/stats?period=<today\|week\|month\|quarter\|year\|thisYear\|all>&user=<id>&game=<name>` | Game and voice totals with sounds and game nights, the same for the stretch just before (`previous`, null when the records don't reach back that far, or for all time), game time over the period with the top five games apart (`activity`), people, voice time and sounds per step (`series`), when people are on by weekday and hour (`when`, for 7 days or more), each day's time in voice (`calendar`, for 14 to 400 days without a game: `day`, `start`, `end` and `ms`) and the games that moved most (`trending`), plus sessions, rank and when it was last played where a person or game is chosen. `recordsFrom` and `voiceFrom` say when the server's records, and its full voice records, start. Instead of `period`, `fromDate` and `toDate` (`YYYY-MM-DD`, both included, in the server's time zone) or `from` and `to` (milliseconds) pick any range; `since` and `until` in the answer say what was counted |
| `GET /guilds/:id/stats/sounds?period=…` | Stats → Sounds & music, over the same ranges as `/stats`: `totals` (sounds, songs, `listenedMs`, `skipped`, lines) and `previous` (each null until its records cover the stretch before), counts per step (`activity`), the top ten `sounds`, `soundPeople`, `songs`, `artists`, `djs` (Autoplay as `autoplay`), `sources`, `voices`, `effects` and `speakers`, the ways lines were said (`kinds`) and when each kind of record starts (`from`). Only current members are listed, and what was said isn't kept |
| `GET /guilds/:id/settings` | Lists settings, the `groups` they're shown in (as in `/setup show`), channels (with `canPost`), roles (with `canGive`), time zones, and `problems`: `{ key, text, at? }` for anything stopping the bot, `key` being the setting that fixes it, and `chat`: `{ ok, note, notes }`, whether there's an API key for answering in chat, this month's answers and cost, and what it remembers about people |
| `PUT /guilds/:id/settings/:key` | Changes a setting: `{ "value": ... }` |
| `DELETE /guilds/:id/settings/:key` | Puts a setting back to its default |
| `GET /guilds/:id/health?range=<1h\|24h\|7d\|30d>` | What the [Health](#health) view shows over the range (24 h if left out): each part judged `fine`, `slow`, `bad` or `quiet`, what held things back (`verdict`), the machine, every container, the points of each chart (`start`, `step` and `points` say when), and this server's slow list. Instead of `range`, `fromDate` and `toDate` (`YYYY-MM-DD`) or `from` and `to` (milliseconds) pick any stretch of the last 30 days, with a point every 1, 5 or 15 minutes, or every 1, 3 or 6 hours, whichever keeps it to 240 points |
| `GET /metrics` | The [performance numbers](#performance-numbers), in Prometheus's text format |
| `POST /perf/web` | The web UI's report of itself every 30 seconds: `{ "memoryBytes": ..., "memoryLimitBytes": ..., "cpuSeconds": ..., "stallSeconds": { "cpu": ..., "memory": ..., "io": ... }, "cpuPeriods": ..., "throttledPeriods": ..., "oomKills": ..., "requests": { "2xx": 40 }, "botUnreachable": 0 }`. The voice, music and loop containers answer `GET /stats` with the same usage |
| `POST /perf/browser` | A browser's timings, which the web UI passes on about once a minute per open tab: `{ "via": "home" or "away", "device": "phone" or "computer", "requests": [["action" or "load", seconds, bot's seconds]], "page": { "firstByte": ..., "shown": ... }, "responses": [seconds], "quickResponses": 3 }` |

## Performance numbers

The bot keeps track of how it and its containers are doing, so a slow moment can be traced to where it came from. It needs nothing set up, and keeps everything in its own database.

- **Discord:** whether the bot is connected, the gateway's heartbeat round trip and reconnects, and how long each command, button and menu takes to get its first answer to Discord. Discord gives up after 3 seconds, and answers that came too late are counted.
- **Playing:** how long a sound, a line of speech or a song takes from being asked for to being heard, including joining voice. A line is timed step by step: waiting behind other lines, the voice container saying it (and loading the voice, if it wasn't in memory), levelling and effects, and starting. A song is timed through its download, and whether the music container had it already. Also how long joining voice takes, joins that time out, voice connections that drop, and audio mixed late, which people hear as a stutter. The loop bot's joins that time out and connections that drop are counted too, labelled `bot="loop"`, from its `GET /stats`.
- **The bot itself:** how late its timers run (event loop delay, where an idle bot reads about 0), how busy it is, its JavaScript memory, and its garbage collection pauses.
- **Every container:** memory as `docker stats` counts it, its limit, CPU, the time something in it waited for CPU, memory or the disk (Linux's pressure stall information), how often its own CPU limit held it back (the share of its 100 ms CPU periods it was throttled in), and processes killed for going over its memory limit. The bot asks the voice, music and loop containers on `GET /stats` every 30 seconds, and the web UI reports itself to the bot. A container that doesn't answer for 90 seconds is marked down.
- **The machine they run on:** every 15 seconds the bot reads `/proc`, which a container shares with the machine: how busy its CPUs are, time spent waiting on the disk, CPU time the hypervisor gave to other machines, memory in use, swap in use and pages swapped a second, the time anything on it waited for CPU, memory or the disk, and the free space on the disk holding the bot's data. It covers every app on the machine, not just these containers.
- **People's browsers:** each open web UI tab times how long taps take to be answered (split into the bot's part, from the `Server-Timing` header the web UI adds, and the network's), how long the page takes to open (its largest content, or the load event in Safari), and how long the page takes to visibly react to a tap or key press (Chrome, Edge and Firefox). It sends them about once a minute while it's seen, and once more as it closes. The web UI adds whether it came through Pangolin (away) or not (home), and the tab says phone or computer. Nothing in them says who it was. Live updates and uploads aren't timed.
- **The web UI and the API:** the web UI's answers by status, requests the bot didn't answer, and how long the management API takes to answer, by area. Requests that wait for a change on purpose (live updates) are counted but not timed.

They're kept a minute at a time for 2 days, then 15 minutes at a time for 30 days, about 25 MB in all. The [daily backups](self-hosting.md#hosting-the-bot) leave them out. Anything slow is kept for 30 days with how long each step took, up to the newest 500: a command that took 2 seconds or more to answer, a sound 2 seconds to start, a line 4 (plus 3 for each 1,000 characters), a song 8, or a page's data 2. Time spent waiting behind other lines doesn't count toward that. Speech keeps its voice and length, never its words.

`GET /metrics` answers in Prometheus's text format, for Prometheus and Grafana if you run them, though nothing needs them. Every name starts with `slopkeeper_`, in seconds and bytes. Speech making is timed by `length`: `short` (300 characters or fewer) or `long`; before that label it was one series. A Prometheus on the same container network can scrape it with the API token:

```yaml
scrape_configs:
  - job_name: slopkeeper
    authorization:
      credentials: <API_TOKEN>
    static_configs:
      - targets: ["slopkeeper:8787"]
```

### Health

Stats → **Health** in the web UI shows these numbers to anyone who can open it, over the last hour, 24 hours, 7 days or 30 days, or any days of the last 30 picked on a calendar. Dragging across a chart with a mouse looks closer at that stretch, and **Back** returns to the range before. A preset keeps up as each minute is kept. Everything but the slow list covers the whole bot, which every server it's in shares.

- **What held it back?:** whether the machine was short of CPU, memory or disk, a container reached its own CPU or memory limit, or garbage collection paused the bot. If none of those, but something people waited on was slow, it says so: that's the bot's own work or what it waited on, like YouTube or Discord, and Slowest recently shows which step.
- **Summary:** Discord, commands and buttons, sounds, speech, music, stutter, the bot, the web UI, and the web UI as people see it in their browsers, at home and away and on phones and computers, each marked **Fine**, **Slow** or **Bad** over the range. Speech is judged by lines of 300 characters or fewer, as a paragraph takes seconds more to make.
- **Containers:** each one's memory against its limit, CPU, waiting for resources, time held back by its CPU limit, processes killed for memory, and any time it didn't answer.
- **The machine it runs on:** its cores, memory, swap and disk, with charts of its CPU (busy, waiting on the disk and taken by the host), memory in use, time waiting for each resource, and swapping.
- **Web UI as people see it:** taps answered and the page opening, at home and away.
- **Charts:** the 95th percentile of commands answered, sounds starting, speech made and songs starting, each with a dashed line where it stops being fine, then memory, CPU and waiting for resources by container, Discord's ping with time away shaded, and the bot's lag. Point at one, or use the arrow keys, to read every line at that time, and **Show as a table** lists them. The charts are drawn by [Apache ECharts](https://echarts.apache.org) (Apache 2.0), and the calendar is [Cally](https://wicky.nillia.ms/cally/) (MIT), both built into `web/public` by `scripts/build-vendor.sh` with their licences in `web/vendor-licences`.
- **Slowest recently:** this server's slow ones, slowest or newest first. Each shows its steps, with time spent waiting behind others in grey and left out of the ranking.

| | Fine below | Bad from |
|---|---|---|
| Commands answered, 95% within | 1.5 s | 3 s |
| Sounds start, 95% within | 1 s | 3 s |
| Speech made (300 characters or fewer), 95% within | 2.5 s | 5 s |
| Music starts, 95% within | 8 s | 15 s |
| Stutter: audio mixed late | 0.5% | 2% |
| Bot lag, at its worst point | 100 ms | 500 ms |
| A container's memory now, of its limit | 80% | 90% |
| Web UI answers that failed or found the bot gone | 1% | 5% |
| Taps answered in people's browsers, 95% within | 500 ms | 1.5 s |
| The page opening, 95% within | 3 s | 6 s |
| The page reacting to a tap, 95% within | 200 ms | 500 ms |
| The machine's CPU busy, at its worst point | 80% | 95% |
| The machine's CPU taken by the host, at its worst point | 5% | 15% |
| The machine's memory in use, at its worst point | 85% | 95% |
| Pages swapped a second, at its worst point | 100 | 1,000 |
| Time something waited for CPU, at its worst point | 10% | 25% |
| Time something waited for memory, at its worst point | 2% | 10% |
| Time something waited for the disk, at its worst point | 10% | 30% |
| The data disk, full | 85% | 95% |
| A container held back by its CPU limit, at its worst point | 5% | 20% |
| The bot paused for garbage collection, at its worst point | 3% | 10% |

Between the two is **Slow**. A worst point is the worst of the chart's points, each an average over its minute, 15 minutes, hour or 6 hours. Discord is **Slow** after 2 minutes away in the range, and **Bad** while it's away. A container is **Bad** while it isn't answering or if a process in it was killed for memory, and **Slow** if it went down, its memory reached 90% at any point in the range, or its CPU limit held it back. A process killed for memory is counted only while the container keeps running: when it's the container's main process, the container restarts and shows as down instead. Commands are **Slow** if any failed or came too late, and speech if any line failed.
