<img src="assets/logo.png" width="160" align="right" alt="Slopkeeper logo">

# Slopkeeper

Keeper of the slop. A Discord bot for friends servers that helps people get together, figure out what to play once they're there, and remember the night afterwards. One running bot can serve several servers, each with its own settings and data.

- **Getting together:** pings people who opted in when a voice channel fills up, with per-game pings for the games being played, and plans game nights people can RSVP to.
- **Picking a game:** knows everyone's Steam library and picks a multiplayer game that the people in voice all own.
- **Getting games:** posts when a game the group wants goes on sale, pinging whoever still needs it, and when a game is free to keep on Steam, Epic or GOG.
- **Remembering the night:** recaps each voice session, keeps a weekly leaderboard, and tracks what everyone plays, per person and for the whole server.
- **Messing around:** a soundboard that layers sounds like Discord's own, with short clips mirrored into Discord's soundboard.

Everything happens through slash commands (type `/` in any channel, or run `/help`) and through automatic posts in each server's announce channel.

**Contents**

- [A typical night](#a-typical-night)
- [Getting started](#getting-started-for-everyone-in-the-server)
- [Getting together](#getting-together): [hop-on pings](#hop-on-pings) · [game pings](#game-pings) · [game nights](#game-nights)
- [Playing games](#playing-games): [Steam accounts](#steam-accounts) · [What do we play?](#what-do-we-play) · [Game library](#game-library) · [Sale alerts](#sale-alerts) · [Free games](#free-games)
- [Stats](#stats): [session recaps](#session-recaps) · [voice leaderboards](#voice-leaderboards) · [game stats](#game-stats)
- [Soundboard](#soundboard): [playing sounds](#playing-sounds) · [managing sounds](#managing-sounds) · [Discord's soundboard](#discords-soundboard)
- [Server settings](#server-settings): [settings and defaults](#settings-and-defaults)
- [Multiple servers](#multiple-servers)
- [Configuration](#configuration)
- [Setup](#setup): [hosting the bot](#hosting-the-bot) · [adding the bot to a server](#adding-the-bot-to-a-server)

## A typical night

1. On Tuesday, Sam runs `/gamenight plan game:Valheim when:fri 9pm`. The bot posts an RSVP card with **In / Maybe / Can't** buttons, pings the **Valheim** game role, and adds a Discord event to the server's event list. Four people click **In**.
2. On Friday at 8:45, the bot reminds the four of them. At 9 PM, Sam joins voice. Alex joins a minute later, and the channel now has 2 people. Slopkeeper posts in the announce channel:
   > @hop-on 🎮 **Sam** and **Alex** are in #general-voice, playing **Deep Rock Galactic**. Hop on!

   Everyone who ran `/notify` gets pinged, along with the Deep Rock Galactic game role, and two more people join.
3. Nobody can agree on a game, so someone runs `/whatdoweplay`. The bot checks the Steam libraries of the 4 people in voice and replies:
   > 🎲 **Lethal Company**. All 4 of you own it.
   > **Also works (6):** Deep Rock Galactic, Valheim, …
   > **One purchase away:** Helldivers 2 · needs @Jordan

   **Reroll** picks another game; **Never suggest this** hides one for good.
4. Throughout the night, people spam the soundboard panel.
5. Everyone leaves at 1 AM. Five minutes after the channel empties, the bot posts a recap: the session lasted 4h, Sam was there for 4h, Alex for 3h 40m, and so on, plus the games people were playing.
6. On Sunday evening, the bot posts the week's voice leaderboard. `/gamestats` shows the server put 31 hours into Lethal Company this month, and `/gamestats user:@Alex` shows where Alex's evenings went.
7. Days later, Helldivers 2 goes 40% off. The bot posts the sale and pings Jordan, the only one who doesn't own it. The same week, it posts in #free-games that a game is free to keep on Epic.

## Getting started (for everyone in the server)

1. **`/steam link profile:<your Steam profile URL>`** so the picker knows your games. In Steam, set **Profile → Edit Profile → Privacy Settings → Game details** to **Public**; otherwise the bot can't see your library.
2. **`/notify`** if you want a ping when people hop in voice.
3. **`/pings`** to pick the games you want pings for (when people play them, or plan a game night for them).
4. That's it. The rest works on its own or when someone runs a command. `/help` lists every command.

---

## Getting together

### Hop-on pings

When a voice channel reaches 2 people, the bot posts in the announce channel. The post names who's there and what they're playing, and pings the hop-on role (set with [`/setup hopon-role`](#server-settings)) plus the [game ping](#game-pings) role of each game being played. It fires once as the channel reaches that number, not on every join after. It then waits 2 hours before pinging again, so a busy evening doesn't spam. The AFK channel and bots don't count. Both numbers can be changed with `/setup hopon`.

| Command | What it does |
| --- | --- |
| `/notify` | Turns hop-on pings on for you by giving you the hop-on role. Run it again to turn them off. Only you see the reply. |

### Game pings

Game pings are opt-in roles per game, like **@Valheim** or **@Lethal Company**. People pick the games they care about, and get pinged when:
- a hop-on ping goes out while people are playing that game, or
- someone plans a game night for it.

Game roles are normal mentionable roles, so anyone can also ping one by hand (`@Valheim anyone up?`).

| Command | What it does |
| --- | --- |
| `/pings` | Opens a menu of the server's game roles with yours ticked. Tick or untick games to change your pings. Only you see it. |
| `/gamerole add game [role]` | **Manage Roles only.** Makes a mentionable role for a game. The name autocompletes from the game library and from games people have played. Use `role` to reuse a role you already have. The name should match what Discord shows under "Playing", so hop-on pings can match it. |
| `/gamerole remove game` | **Manage Roles only.** Stops offering pings for a game. Deletes the role too, if the bot made it. |
| `/gamerole menu` | **Manage Roles only.** Posts a **Choose games** button in the current channel that opens the `/pings` menu for whoever clicks it. Pin it in a roles channel. |

Examples:
```
/gamerole add game:Valheim
/gamerole add game:Lethal Company role:@lethal
/gamerole menu
```

### Game nights

`/gamenight plan` posts an RSVP card in the current channel and creates a matching event in the server's **Events** list, so it also shows up at the top of the channel list with Discord's own "Interested" button.

The card shows the time in everyone's own time zone, the host, the voice channel, and who's **In**, **Maybe** or **Can't**. The host is marked **In** automatically. Clicking a button changes your answer.

What happens after that:
- The game's [ping role](#game-pings) is pinged when the night is planned.
- 15 minutes before the start, the bot replies to the card and pings everyone who's **In** or **Maybe**. Change or turn this off with `/setup gamenight-reminder`.
- At the start time, the Discord event goes live. It ends 3 hours later, or once its voice channel empties, whichever is later.
- **Cancel night** (host, or anyone with Manage Events) greys out the card, deletes the event and lets the people who were in know.

| Command | What it does |
| --- | --- |
| `/gamenight plan game when [voice] [details]` | Plans a game night. `when` takes things like `fri 8pm`, `tomorrow 20:30`, `next sat 9`, `nov 3 7:30pm` or `2026-11-03 19:00`, in the server's time zone (`/setup timezone`). A bare hour like `fri 9` means 9 PM. While you type, the suggestion shows exactly when it'll be, so you can check before sending. |
| `/gamenight list` | Upcoming game nights, with how many are in and a link to each card. |

Examples:
```
/gamenight plan game:Valheim when:fri 9pm voice:#gaming
/gamenight plan game:Jackbox when:sat 8 details:Bring snacks. Phones out.
```

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

The "group" here is the server's members who have linked Steam or marked at least one game as owned. Prices use the server's Steam store region (`/setup steam-region`, default `us`).

### Free games

Every 3 hours, the bot checks [GamerPower](https://www.gamerpower.com) for full games that are free to keep on Steam, Epic Games Store or GOG, and posts each new one once. Each post has the store link, what the game normally costs and when the offer ends. DLC, betas and in-game loot are left out.

It's **off by default**. A server admin turns it on with `/setup free-games enabled:True`, optionally with `channel:#free-games` to keep the posts out of the announce channel. Without a channel, they go to the announce channel. When it's first turned on, the bot posts whatever is free at that moment (up to 5), then only new ones.

| Command | What it does |
| --- | --- |
| `/freegames` | Shows everything that's free to keep right now. |

---

## Stats

### Session recaps

The bot tracks each voice channel as a session. It records who was there, for how long, and which games Discord showed them playing. A session ends once the channel has been empty for 5 minutes, so a quick disconnect doesn't split the night in two.

If a session lasted at least 15 minutes and had 2 or more people, the bot posts a recap with each person's time and the games played. Shorter or solo sessions aren't recorded. Both times can be changed with `/setup sessions`.

### Voice leaderboards

| Command | What it does |
| --- | --- |
| `/stats [period]` | Voice leaderboard for the past week (default), past month or all time. Shows the top 10 by time in voice, how many nights each person showed up, and the most-played games. |

Every Sunday at 8 PM, in the server's time zone, the bot posts the past week's leaderboard to the announce channel. Change the day and hour with `/setup leaderboard`.

### Game stats

The bot records how long each person plays each game, from the "Playing" status Discord shows on their profile. It counts every game Discord sees, in voice or not, and keeps the record per server. Anyone who doesn't want this can turn off **Settings → Activity Privacy → Share my activity** in Discord. Plays under a minute (launchers, crashes) aren't kept.

| Command | What it does |
| --- | --- |
| `/gamestats` | The whole server: hours played, the 10 most played games with how many people play them, and the 10 people who play the most. |
| `/gamestats user` | One person: their total and their top games, with when they last played each. |
| `/gamestats game` | One game: the server's total and who plays it most. The name autocompletes from what's been played. |
| `/gamestats user game` | One person and one game: their hours, number of sessions, and where they rank among the server's players. |

Every form takes `period`: past week, past month (default), past year or all time.

Examples:
```
/gamestats
/gamestats user:@Sam period:All time
/gamestats game:Valheim
/gamestats user:@Alex game:Lethal Company
```

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

## Server settings

Server admins (anyone with **Manage Server**) set the bot up for their server from Discord with `/setup`. Nobody else sees it. To let other roles use it, go to **Server Settings → Integrations → Slopkeeper**.

Every setting has a sensible default, so only the announce channel needs setting. Replies to `/setup` are only shown to you.

| Command | What it does |
| --- | --- |
| `/setup show` | Lists every setting, its current value and where it comes from: **set here** (with `/setup`), **host default** (the host's `.env`) or **default**. |
| `/setup announce-channel channel` | Sets where hop-on pings, session recaps, the weekly leaderboard and sale alerts are posted, and free games unless they have their own channel. Until it's set, the bot works but posts nothing. It checks that it can post in the channel and tells you which permission is missing if not. |
| `/setup hopon-role [role]` | Sets the role that hop-on pings ping, which `/notify` hands out. Leave `role` empty to post hop-on pings without pinging that role. It warns you if its own role is below this one, since Discord then won't let it hand the role out. |
| `/setup hopon [min_people] [cooldown_minutes]` | How many people a voice channel needs before a hop-on ping, and how long to wait before the next one. |
| `/setup sessions [recap_min_minutes] [grace_minutes]` | The shortest session that gets a recap, and how long a channel stays empty before its session ends. |
| `/setup leaderboard [day] [hour]` | When the weekly voice leaderboard is posted. |
| `/setup timezone zone` | The server's time zone, used for the weekly post, counting "nights" on leaderboards, and reading game night times. Autocompletes, e.g. `America/Chicago`, `Europe/London`. |
| `/setup steam-region country` | Steam store region for sale prices, as a two-letter country code. |
| `/setup free-games enabled [channel]` | Turns free game posts on or off. `channel` gives them their own channel; without it they go to the announce channel. To move them back to the announce channel, use `/setup reset setting:Free games channel`. |
| `/setup gamenight-reminder minutes` | How long before a game night to remind the people who are in. `0` turns reminders off. |
| `/setup reset setting` | Puts one setting back to its default. |

For the commands with several options, only the options you fill in change.

Examples:
```
/setup announce-channel channel:#bot-stuff
/setup hopon-role role:@hop-on
/setup hopon min_people:3 cooldown_minutes:60
/setup timezone zone:Europe/London
/setup free-games enabled:True channel:#free-games
/setup leaderboard day:Friday hour:22
/setup reset setting:Hop-on cooldown
```

### Settings and defaults

Each setting comes from the first of these that's set:
1. the server's own value, from `/setup`;
2. the host's default, from an environment variable (see [Configuration](#configuration));
3. the built-in default.

So the host can change a default for every server at once, and each server can still override it.

| Setting | `/setup` command | Host default variable | Built-in default |
| --- | --- | --- | --- |
| Announce channel | `announce-channel` | | none, nothing is posted |
| Hop-on role | `hopon-role` | | none |
| People before a hop-on ping | `hopon` | `HOPON_MIN_PEOPLE` | 2 |
| Minutes between hop-on pings | `hopon` | `HOPON_COOLDOWN_MIN` | 120 |
| Shortest recapped session (minutes) | `sessions` | `RECAP_MIN_MINUTES` | 15 |
| Minutes empty before a session ends | `sessions` | `SESSION_GRACE_MIN` | 5 |
| Weekly leaderboard day (0 = Sunday) | `leaderboard` | `WEEKLY_POST_DAY` | 0 |
| Weekly leaderboard hour | `leaderboard` | `WEEKLY_POST_HOUR` | 20 |
| Time zone | `timezone` | `TZ` | UTC |
| Steam store region | `steam-region` | `STEAM_CC` | `us` |
| Free game posts | `free-games` | `FREE_GAMES` (`true` to turn on) | off |
| Free games channel | `free-games` | | the announce channel |
| Game night reminder (minutes before) | `gamenight-reminder` | `GAMENIGHT_REMINDER_MIN` | 15 |

## Multiple servers

One running bot can serve several servers. Each server gets its own:
- settings (`/setup`),
- game library, ownership marks and hidden games,
- game ping roles and game nights,
- voice sessions, recaps, leaderboards and game stats,
- sounds, emoji, panels and Discord soundboard sync,
- hop-on cooldown, sale alerts and free game posts.

**Steam links are shared.** Your Steam account is the same everywhere, so you link it once with `/steam link` and every server you're in can use it. In each server, the bot only counts people who are members there. Someone in another server never shows up in your picker, game list, sale pings or stats.

**Choosing which servers can use it:** with `ALLOWED_GUILD_IDS` set, the bot leaves any server that isn't on the list as soon as it's added. Without it, anyone with the invite link can add the bot. Set it if the bot is public (see [Setup](#setup)).

## Configuration

Set in `.env` (see `.env.example`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | required | Bot token |
| `STEAM_API_KEY` | none | Needed for `/steam` and the picker's Steam data |
| `ALLOWED_GUILD_IDS` | any server | Comma-separated server IDs allowed to use the bot; it leaves any other server |
| `SALE_CHECK_HOURS` | 6 | How often Steam prices are checked, for every server at once |
| `TZ` | UTC | The container's time zone, and every server's default time zone |

Everything else is a per-server setting. Servers set their own with `/setup`; the variables in [Settings and defaults](#settings-and-defaults) change the default for servers that haven't. For example, `HOPON_MIN_PEOPLE=3` makes every server wait for 3 people unless it ran `/setup hopon`.

**Upgrading from a single-server version:** older versions took `GUILD_ID`, `ANNOUNCE_CHANNEL_ID` and `HOPON_ROLE_ID` from `.env`. Keep them for the first start of the new version. The bot then:
- saves a copy of the database as `bot.db.pre-multiserver`,
- moves all existing data and sounds to the `GUILD_ID` server,
- turns the channel and role into that server's `/setup` settings.

After that they're ignored and can be removed.

## Setup

Setting up involves two people, who can be the same person:

- **The host** runs the bot. They own the Discord application, keep its token and Steam key, and run the container.
- **The server admin** adds the bot to their server and runs `/setup` there.

The two parts can happen in either order. The bot sets up any server it's added to, whether it's already running or not.

### Hosting the bot

For whoever runs the bot.

1. **Create the application.** Go to https://discord.com/developers/applications → **New Application**. Then, on the **Bot** tab:
   - **Reset Token** and copy it into `.env` as `DISCORD_TOKEN`. Keep it secret: anyone with the token can control the bot.
   - Enable **Presence Intent** and **Server Members Intent**. The bot crashes on startup with `Used disallowed intents` without them.
   - If someone else is adding the bot to their server, turn **Public Bot** on. Otherwise only you can add it. Leave **Requires OAuth2 Code Grant** off.
2. **Get a Steam Web API key** at https://steamcommunity.com/dev/apikey (any domain name works) and set `STEAM_API_KEY`.
3. **Fill in `.env`** (`cp .env.example .env`). If **Public Bot** is on, set `ALLOWED_GUILD_IDS` to the servers you expect. Server admins can send you their server ID (right-click the server icon → **Copy Server ID**, with Developer Mode on).
4. **Start it:**
   ```sh
   docker compose up -d --build
   docker compose logs -f slopkeeper
   ```
   The log lists each server it registered commands in, then `Logged in as Slopkeeper#1234 in N servers`.
5. **Send the invite link** to each server admin. Either use **OAuth2 → URL Generator** with scopes `bot` + `applications.commands` and the permissions View Channels, Send Messages, Embed Links, Connect, Speak, Manage Roles, Create Expressions and Create Events, or fill your application ID (from **General Information**) into this link:
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=26388550667264
   ```

Local dev (Node 24+): `npm install && npm run dev`. `npm run typecheck` runs tsc.

Data (SQLite DB and uploaded sounds) lives in the `slopkeeper-data` volume at `/data`, with each server's sounds in `sounds/<server id>/`. Back that volume up if you move the bot. In-progress voice sessions are kept in memory, so restarting the bot mid-session drops that session's stats. Game stats are saved every 5 minutes and when the bot stops, so a crash loses at most a few minutes of them.

### Adding the bot to a server

For the server admin. You need the **Manage Server** permission in the server.

1. **Add the bot.** Open the invite link from the host, pick your server, leave every permission ticked and click **Authorize**. If the bot is running, it posts a short hello in your server's system channel.
   - **Manage Roles** lets `/notify` hand out the hop-on role, and `/gamerole` make and hand out game roles.
   - **Create Expressions** lets the bot copy sounds into the server's soundboard.
   - **Create Events** lets game nights show up in the server's Events list.

   If the bot was added with an older invite link, its role is missing **Create Events**. Either open the new link again (it updates the permissions without removing the bot), or tick **Create Events** on the bot's role in **Server Settings → Roles**.
2. **Pick the announce channel:** `/setup announce-channel channel:#somewhere`. This is where hop-on pings, session recaps, the weekly leaderboard and sale alerts are posted. If the bot can't post there, it tells you which permission to give its role.
3. **Make the hop-on role** (optional, for `/notify`).
   - In **Server Settings → Roles**, create a role such as `hop-on`, and drag the bot's role (**Slopkeeper**) **above** it. Discord only lets a bot hand out roles below its own.
   - Then run `/setup hopon-role role:@hop-on`.
4. **Set the time zone** if it isn't the host's: `/setup timezone zone:Europe/London`.
   Want free game posts? They're off until you run `/setup free-games enabled:True`, optionally with `channel:#free-games`.
5. **Add game pings** (optional) for the games your server plays: `/gamerole add game:Valheim`, and so on. Then `/gamerole menu` in a channel people will see, so they can pick theirs.
6. **Check voice channels.** The bot needs **Connect** and **Speak** in any voice channel you want the soundboard in. That's automatic unless the channel overrides permissions.
7. **Check it:** `/setup show`. Anything you haven't set uses a default, which is listed there.

Then tell people to run `/steam link`, `/notify` and `/pings` (see [Getting started](#getting-started-for-everyone-in-the-server)), and post a `/sound panel` somewhere handy.
