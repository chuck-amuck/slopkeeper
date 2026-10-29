<img src="assets/logo.png" width="160" align="right" alt="Slopkeeper logo">

# Slopkeeper

Keeper of the slop. Discord bot for the friends server: hop-on pings, voice session recaps and leaderboards, a shared game library with a "what do we play" picker, Steam sale alerts, and a soundboard.

## Commands

| Command | What it does |
| --- | --- |
| `/notify` | Toggle the hop-on ping role for yourself |
| `/stats [period]` | Voice leaderboard (week / month / all time) |
| `/steam link profile [user]` | Link a Steam account (profile URL, vanity name or SteamID64) |
| `/steam unlink [user]` / `/steam list` / `/steam refresh` | Manage linked accounts |
| `/whatdoweplay` | Random multiplayer game everyone in your voice channel owns, with Reroll / Never suggest buttons |
| `/game add name [steam] [max_players]` | Library entry: wishlist for sale alerts, player cap, or a non-Steam game |
| `/game own name [user]` | Mark ownership by hand (non-Steam games, Steam Family Sharing) |
| `/game list` | Library, who owns what, who still needs it |
| `/game remove name` / `/game unhide name` | Remove a game / undo "Never suggest" |
| `/sound play/add/emoji/remove/stop/panel` | Soundboard. `panel` posts clickable buttons that update themselves as sounds change |
| `/sound discord-add name [start]` / `discord-remove` / `discord-sync` | Copy sounds into Discord's own soundboard, take them out again, or fill its free slots |

Automatic posts in `ANNOUNCE_CHANNEL_ID`:
- **Hop-on ping** when a voice channel reaches `HOPON_MIN_PEOPLE` (cooldown `HOPON_COOLDOWN_MIN`).
- **Session recap** once a channel has been empty for `SESSION_GRACE_MIN`, if the session lasted at least `RECAP_MIN_MINUTES` with 2+ people.
- **Weekly leaderboard** on `WEEKLY_POST_DAY` at `WEEKLY_POST_HOUR` (local `TZ`).
- **Sale alert** when a library game with a Steam ID goes on sale (or gets a deeper discount) and someone in the group doesn't own it yet. The group is everyone who has marked at least one game as owned.

## Soundboard

`/sound panel` posts a grid of buttons, 20 per page with ◀ ▶ to flip pages and ⏹ to stop. The bot remembers every panel it posts and edits them whenever a sound is added, removed or given an emoji, so there's no need to re-post one. Pin it if you want it easy to find.

The bot holds the full library, and Discord's own soundboard (the speaker button in a voice call) holds whichever of those fit. Discord's buttons play straight from the Discord app with no round trip through the bot, so they can be spammed, and the sound comes from whoever pressed it. Its limits: about 5 seconds per sound, and 8 / 24 / 36 / 48 slots at boost level 0–3, shared with sounds people upload there themselves.

- `/sound add` copies a sound to Discord's soundboard when it's short enough and a slot is free; otherwise it stays bot-only.
- `/sound discord-add` copies one over by hand. For longer sounds, `start:` picks the 5 seconds to use.
- `/sound discord-remove` frees a slot; the sound stays in the bot and can go back later.
- `/sound discord-sync` fills free slots with every short bot-only sound.
- Blue panel buttons are on both soundboards. Removing a sound, or changing its emoji, updates both. Deleting one in Discord's UI turns it back to bot-only.
- The bot's role needs **Create Expressions** to upload. The bot never touches sounds it didn't upload.

Sounds layer like Discord's own soundboard: clicking while something is playing mixes the new sound in instead of cutting the old one off, up to 12 at once (past that the oldest is dropped). Give a sound a button emoji with `/sound add ... emoji:` or `/sound emoji`; custom emoji have to be from this server.

## How the picker works

Ownership = linked Steam library (synced every 6h, and again for anyone in voice whose data is over an hour old) plus manual `/game own` marks. Candidates are games everyone in voice owns that Steam tags Multi-player, Online Co-op or Online PvP, or that are in the library. A library `max_players` excludes the game when too many people are in voice. People in voice with no Steam link and no manual marks are left out of the calculation and listed in the reply.

Each friend's Steam profile needs **Privacy Settings → Game details: Public**, or the bot can't see their games.

## Discord setup

1. https://discord.com/developers/applications → New Application.
2. **Bot** tab: Reset Token → copy into `.env` as `DISCORD_TOKEN`. Enable **Presence Intent** and **Server Members Intent**.
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; permissions View Channels, Send Messages, Embed Links, Connect, Speak, Manage Roles. Open the URL and add the bot to the server.
4. Create a role (e.g. `hop-on`) and drag the bot's role **above** it so `/notify` can assign it.
5. Get a Steam Web API key at https://steamcommunity.com/dev/apikey (any domain name works) and set `STEAM_API_KEY`.
6. Discord settings → Advanced → Developer Mode, then right-click to copy the server, channel and role IDs into `.env`.

## Run

```sh
cp .env.example .env   # fill it in
docker compose up -d --build
docker compose logs -f slopkeeper
```

Local dev (Node 24+): `npm install && npm run dev`. `npm run typecheck` runs tsc.

Data (SQLite DB and uploaded sounds) lives in the `slopkeeper-data` volume at `/data`. In-progress voice sessions are kept in memory, so restarting the bot mid-session drops that session's stats.
