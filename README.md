<img src="assets/logo.png" width="160" align="right" alt="Slopkeeper logo">

# Slopkeeper

Keeper of the slop. A Discord bot for a friends server that helps people get together, figure out what to play once they're there, and remember the night afterwards.

- **Getting together:** pings people who opted in when a voice channel fills up.
- **Picking a game:** knows everyone's Steam library and picks a multiplayer game that the people in voice all own.
- **Buying games:** posts when a game the group wants goes on sale, and pings whoever still needs it.
- **Remembering the night:** recaps each voice session and keeps a weekly leaderboard.
- **Messing around:** a soundboard that layers sounds like Discord's own, with short clips mirrored into Discord's soundboard.

Everything happens through slash commands (type `/` in any channel) and through automatic posts in one announce channel.

## A typical night

1. Sam joins voice at 9 PM. Alex joins a minute later, and the channel now has 2 people. Slopkeeper posts in the announce channel:
   > @hop-on 🎮 **Sam** and **Alex** are in #general-voice, playing **Deep Rock Galactic**. Hop on!

   Everyone who ran `/notify` gets pinged, and two more people join.
2. Nobody can agree on a game, so someone runs `/whatdoweplay`. The bot checks the Steam libraries of the 4 people in voice and replies:
   > 🎲 **Lethal Company**. All 4 of you own it.
   > **Also works (6):** Deep Rock Galactic, Valheim, …
   > **One purchase away:** Helldivers 2 · needs @Jordan

   **Reroll** picks another game; **Never suggest this** hides one for good.
3. Throughout the night, people spam the soundboard panel.
4. Everyone leaves at 1 AM. Five minutes after the channel empties, the bot posts a recap: the session lasted 4h, Sam was there for 4h, Alex for 3h 40m, and so on, plus the games people were playing.
5. On Sunday evening, the bot posts the week's voice leaderboard.
6. Days later, Helldivers 2 goes 40% off. The bot posts the sale and pings Jordan, the only one who doesn't own it.

## Getting started (for everyone in the server)

1. **`/steam link profile:<your Steam profile URL>`** so the picker knows your games. In Steam, set **Profile → Edit Profile → Privacy Settings → Game details** to **Public**; otherwise the bot can't see your library.
2. **`/notify`** if you want a ping when people hop in voice.
3. That's it. The rest works on its own or when someone runs a command.

---

## Getting together

### Hop-on pings

When a voice channel reaches `HOPON_MIN_PEOPLE` people (default 2), the bot posts in the announce channel. The post names who's there and what they're playing, and pings the hop-on role. It fires once as the channel reaches that number, not on every join after. It then waits `HOPON_COOLDOWN_MIN` (default 2 hours) before pinging again, so a busy evening doesn't spam. The AFK channel and bots don't count.

| Command | What it does |
| --- | --- |
| `/notify` | Turns hop-on pings on for you by giving you the hop-on role. Run it again to turn them off. Only you see the reply. |

---

## Playing games

The bot builds a picture of who owns what from two sources:
- **Linked Steam libraries.** These sync every 6 hours. Before a pick, anyone in voice whose data is more than an hour old is synced again.
- **Manual marks** from `/game own`, for games that aren't on Steam or that someone plays through Family Sharing.

### Steam accounts

| Command | What it does |
| --- | --- |
| `/steam link profile [user]` | Links a Steam account and immediately reads its library. `profile` can be a profile URL (`https://steamcommunity.com/id/samplays`), a vanity name (`samplays`) or a 17-digit SteamID64. Use `user` to link it for someone else. |
| `/steam unlink [user]` | Removes a link and forgets that library. Defaults to you. |
| `/steam list` | Shows everyone who's linked, with a profile link and game count. 🔒 means their game details are private. |
| `/steam refresh` | Re-reads every linked library now. Useful right after someone buys a game, or after fixing their privacy setting. |

### What do we play?

| Command | What it does |
| --- | --- |
| `/whatdoweplay` | Run it while you're in voice. It picks a random game that everyone in your channel owns. |

Which games qualify:
- Steam games tagged **Multi-player**, **Online Co-op** or **Online PvP**, plus any game in the library, even one Steam doesn't tag as multiplayer.
- A library game with a `max_players` is skipped when there are more people in voice than that.
- Games hidden with **Never suggest this** are skipped.

The reply also shows:
- **Also works:** other games everyone owns, most-played first.
- **One purchase away:** games everyone but one person owns, and who needs to buy them.
- **Not counted:** people in voice who haven't linked Steam or marked any games. They're left out instead of blocking every game.

Buttons:
- **🎲 Reroll** picks again from the games that qualify. It's greyed out when only one game qualifies.
- **Never suggest this** hides a game from future picks. Undo it with `/game unhide`.

### Game library

The library is the group's shared list of games it cares about. Add a game to the library when:
- you want **sale alerts** for it,
- it has a **player cap** the picker should respect,
- it **isn't on Steam**, so ownership has to be marked by hand, or
- Steam doesn't tag it as multiplayer but you still play it together.

| Command | What it does |
| --- | --- |
| `/game add name [steam] [max_players]` | Adds a game. `steam` takes the store URL or app ID and turns on sale alerts and automatic Steam ownership. `max_players` is the most people one lobby holds. |
| `/game own name [user]` | Marks a game as owned by you, or by `user`, for non-Steam games and Family Sharing. Run it again to unmark it. It's not needed if Steam already shows the person owning the game. |
| `/game list` | Shows every library game, its player cap, who owns it and who still needs it. |
| `/game remove name` | Removes a game from the library, along with its manual ownership marks. |
| `/game unhide name` | Lets `/whatdoweplay` suggest a game that was hidden with **Never suggest this**. |

Examples:
```
/game add name:Deep Rock Galactic steam:https://store.steampowered.com/app/548430 max_players:4
/game add name:Minecraft
/game own name:Minecraft
/game own name:Minecraft user:@Alex
```

### Sale alerts

Every `SALE_CHECK_HOURS` (default 6), the bot checks the Steam price of every library game that has a Steam ID. It posts in the announce channel when a game goes on sale, or when an ongoing sale gets a deeper discount. The post shows the discount, the old and new price, and the store link, and pings the people who don't own the game yet. Games everyone already owns are skipped.

The "group" here is everyone who has linked Steam or marked at least one game as owned. Prices use the `STEAM_CC` store region (default `us`).

---

## Voice stats

### Session recaps

The bot tracks each voice channel as a session. It records who was there, for how long, and which games Discord showed them playing. A session ends once the channel has been empty for `SESSION_GRACE_MIN` (default 5 minutes), so a quick disconnect doesn't split the night in two.

If a session lasted at least `RECAP_MIN_MINUTES` (default 15) and had 2 or more people, the bot posts a recap with each person's time and the games played. Shorter or solo sessions aren't recorded.

### Leaderboards

| Command | What it does |
| --- | --- |
| `/stats [period]` | Voice leaderboard for the past week (default), past month or all time. Shows the top 10 by time in voice, how many nights each person showed up, and the most-played games. |

Every week on `WEEKLY_POST_DAY` at `WEEKLY_POST_HOUR` (default Sunday, 8 PM in `TZ`), the bot posts the past week's leaderboard to the announce channel.

---

## Soundboard

The bot holds a library of uploaded sounds and plays them in your voice channel. Sounds layer like Discord's own soundboard: clicking while something is playing mixes the new sound in instead of cutting the old one off. That includes spamming the same button. Up to 12 sounds play at once; past that, the oldest is dropped. The bot leaves voice after 5 minutes of silence.

### Playing sounds

| Command | What it does |
| --- | --- |
| `/sound panel` | Posts a button grid in the current channel: 20 sounds per page, ◀ ▶ to flip pages, ⏹ **Stop** to silence everything. The bot keeps every panel it posts up to date as sounds change, so post one in a handy channel and pin it. |
| `/sound play name` | Plays one sound in your voice channel. The name autocompletes. |
| `/sound stop` | Stops everything and makes the bot leave voice. |

You have to be in a voice channel to play a sound. The bot joins whichever channel you're in.

### Managing sounds

| Command | What it does |
| --- | --- |
| `/sound add name file [emoji]` | Uploads a sound. Names use lowercase letters, numbers, `-` and `_` (up to 32 characters). The file can be mp3, ogg, wav, m4a, opus, webm or flac, up to 5 MB. Using an existing name replaces that sound and keeps its emoji unless you give a new one. |
| `/sound emoji name [emoji]` | Sets the emoji on a sound's button. Leave `emoji` empty to clear it. Custom emoji have to be from this server. |
| `/sound remove name` | Deletes a sound from the bot, and from Discord's soundboard if it's there. |

Examples:
```
/sound add name:airhorn file:<airhorn.mp3> emoji:📯
/sound emoji name:bruh emoji:💀
/sound remove name:old-meme
```

### Discord's soundboard

Bot buttons have a short lock after each click (roughly half a second). That's how long Discord takes to send the click to the bot and back, and the bot can't shorten it. Discord's own soundboard, the speaker button in a voice call, has no lock, because its sounds play straight from your Discord app. Its sounds also play *from you* rather than from the bot.

So the bot keeps the **full library**, and mirrors whichever sounds fit into Discord's soundboard. Discord's limits:
- each sound can be about 5 seconds at most;
- the server has 8 / 24 / 36 / 48 slots at boost level 0 / 1 / 2 / 3;
- slots are shared with sounds people upload to Discord directly.

| Command | What it does |
| --- | --- |
| `/sound discord-add name [start]` | Copies a sound into Discord's soundboard. For sounds over 5 seconds, `start` picks where the 5-second clip begins; the full sound stays on the bot. |
| `/sound discord-remove name` | Takes a sound out of Discord's soundboard to free a slot. It stays on the bot and can go back any time. |
| `/sound discord-sync` | Copies every short bot-only sound into Discord's soundboard until the slots run out, then lists what didn't fit and why. |

How it stays in sync:
- `/sound add` copies the sound to Discord's soundboard automatically when it's short enough and a slot is free. The reply says whether it did.
- On the panel, **blue** buttons are on both soundboards and **gray** ones are bot-only.
- Removing a sound, or changing its emoji, updates Discord's copy too.
- If someone deletes a mirrored sound in Discord itself, it turns back to bot-only.
- The bot never touches sounds it didn't upload.

Examples:
```
/sound discord-sync
/sound discord-add name:rickroll start:43      # the chorus, 0:43 to 0:48
/sound discord-remove name:airhorn             # free a slot for something else
```

---

## Configuration

Set in `.env` (see `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | required | Bot token |
| `GUILD_ID` | required | The server the bot runs in |
| `ANNOUNCE_CHANNEL_ID` | required | Where hop-on pings, recaps, leaderboards and sale alerts go |
| `HOPON_ROLE_ID` | none | Role pinged by hop-on alerts; `/notify` toggles it |
| `STEAM_API_KEY` | none | Needed for `/steam` and the picker's Steam data |
| `HOPON_MIN_PEOPLE` | 2 | People in a channel before the hop-on ping |
| `HOPON_COOLDOWN_MIN` | 120 | Minutes between hop-on pings |
| `RECAP_MIN_MINUTES` | 15 | Shortest session that gets a recap |
| `SESSION_GRACE_MIN` | 5 | Minutes a channel stays empty before its session ends |
| `SALE_CHECK_HOURS` | 6 | How often Steam prices are checked |
| `STEAM_CC` | `us` | Steam store region for prices |
| `WEEKLY_POST_DAY` | 0 | Day of the weekly leaderboard (0 = Sunday) |
| `WEEKLY_POST_HOUR` | 20 | Hour of the weekly leaderboard |
| `TZ` | | Time zone for the weekly post, e.g. `America/Chicago` |

## Discord setup

1. https://discord.com/developers/applications → New Application.
2. **Bot** tab: Reset Token → copy into `.env` as `DISCORD_TOKEN`. Enable **Presence Intent** and **Server Members Intent**.
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; permissions View Channels, Send Messages, Embed Links, Connect, Speak, Manage Roles, Create Expressions (for syncing to Discord's soundboard). Open the URL and add the bot to the server.
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
