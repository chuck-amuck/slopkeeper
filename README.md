# discord-bot

Bot for the friends server: hop-on pings, voice session recaps and leaderboards, a shared game library with a "what do we play" picker, Steam sale alerts, and a soundboard.

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
| `/sound play/add/remove/stop/panel` | Soundboard. `panel` posts clickable buttons |

Automatic posts in `ANNOUNCE_CHANNEL_ID`:
- **Hop-on ping** when a voice channel reaches `HOPON_MIN_PEOPLE` (cooldown `HOPON_COOLDOWN_MIN`).
- **Session recap** once a channel has been empty for `SESSION_GRACE_MIN`, if the session lasted at least `RECAP_MIN_MINUTES` with 2+ people.
- **Weekly leaderboard** on `WEEKLY_POST_DAY` at `WEEKLY_POST_HOUR` (local `TZ`).
- **Sale alert** when a library game with a Steam ID goes on sale (or gets a deeper discount) and someone in the group doesn't own it yet. The group is everyone who has marked at least one game as owned.

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
docker compose logs -f
```

Local dev (Node 24+): `npm install && npm run dev`. `npm run typecheck` runs tsc.

Data (SQLite DB and uploaded sounds) lives in the `discord-bot-data` volume at `/data`. In-progress voice sessions are kept in memory, so restarting the bot mid-session drops that session's stats.
