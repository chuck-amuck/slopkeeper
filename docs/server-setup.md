# Setting up a server

For server admins: adding the bot, `/setup`, and every setting with its default.

## Adding the bot to a server

For the server admin. You need the **Manage Server** permission in the server.

1. **Add the bot.** Open the invite link from the host, pick your server, leave every permission ticked and click **Authorize**. If the bot is running, it posts a short hello in your server's system channel.
   - **Manage Roles** lets `/notify` hand out the hop-on role, and `/gamerole` make and hand out game roles. Without it, or with the role above the bot's, `/notify`, `/pings` and the web UI tell people a server admin will have to give them the role, and the Settings page marks such roles "an admin hands it out". Nothing else needs it.
   - **Create Expressions** lets the bot copy sounds into the server's soundboard.
   - **Manage Expressions** lets it swap out or take off sounds other people added there. Everything else works without it.
   - **Create Events** lets game nights show up in the server's Events list.

   If the bot was added with an older invite link, its role may be missing **Create Events** or **Manage Expressions**. Either open the new link again (it updates the permissions without removing the bot), or tick them on the bot's role in **Server Settings → Roles**.
2. **Pick the announce channel:** `/setup announce-channel channel:#somewhere`. This is where hop-on pings, session recaps, the weekly leaderboard and sale alerts are posted. If the bot can't post there, it tells you which permission to give its role.
3. **Make the hop-on role** (optional, for `/notify`).
   - In **Server Settings → Roles**, create a role such as `hop-on`, and drag the bot's role (**Slopkeeper**) **above** it so `/notify` can hand it out: Discord only lets a bot hand out roles below its own. If you'd rather it didn't manage roles, skip that, and `/notify` tells people to ask an admin for the role.
   - Then run `/setup hopon-role role:@hop-on`.
4. **Set the time zone** if it isn't the host's: `/setup timezone zone:Europe/London`.
   Want free game posts? They're off until you run `/setup free-games enabled:True`, optionally with `channel:#free-games`.
5. **Add game pings** (optional) for the games your server plays: `/gamerole add game:Valheim`, and so on. Then `/gamerole menu` in a channel people will see, so they can pick theirs.
6. **Check voice channels.** The bot needs **Connect** and **Speak** in any voice channel you want the soundboard in. That's automatic unless the channel overrides permissions. If a channel blocks it, a sound click tells you which permission is missing.
7. **Check it:** `/setup show`. Anything you haven't set uses a default, which is listed there.

Then tell people to run `/steam link`, `/notify` and `/pings` (see [Getting started](../README.md#getting-started-for-everyone-in-the-server)), and post a `/sound panel` somewhere handy.

## Server settings

Server admins (anyone with **Manage Server**) set the bot up for their server from Discord with `/setup`. Nobody else sees it. To let other roles use it, go to **Server Settings → Integrations → Slopkeeper**.

Every setting has a sensible default, so only the announce channel needs setting. Replies to `/setup` are only shown to you.

| Command | What it does |
| --- | --- |
| `/setup show` | Lists every setting in the same groups as the web UI's Settings, with its current value. A changed setting says where it comes from: **set here** (with `/setup`) or **host default** (the host's `.env`). Anything stopping the bot is listed first: a missing announce channel, a channel that's gone or where the bot is missing a permission it needs, a role that's gone or above the bot's, and a post Discord refused when the bot can't tell why (until the next one goes out, it's turned off, or two days have passed). |
| `/setup announce-channel channel` | Sets where hop-on pings, session recaps, the weekly leaderboard, the monthly recap and sale alerts are posted, and free games unless they have their own channel. Until it's set, the bot works but posts nothing. It checks that it can post in the channel and tells you which permission is missing if not. |
| `/setup hopon-role [role] [off]` | Sets the role that hop-on pings ping, which `/notify` hands out. `off:True` posts hop-on pings without pinging a role. It warns you if its own role is below this one, since Discord then won't let it hand the role out. |
| `/setup hopon [min_people] [cooldown_minutes]` | How many people a voice channel needs before a hop-on ping, and how long to wait before the next one. |
| `/setup sessions [recaps] [recap_min_minutes] [grace_minutes]` | Whether a recap is posted when a session ends (sessions count in stats either way). The shortest session that counts: shorter ones get no recap and aren't in stats or leaderboards. Also how long a channel stays empty before its session ends. |
| `/setup leaderboard [enabled] [day] [hour]` | Whether and when the weekly voice leaderboard is posted. |
| `/setup timezone [zone]` | The server's time zone, used for the weekly post, counting "nights" on leaderboards, and reading game night times. Autocompletes, e.g. `America/Chicago`, `Europe/London`. |
| `/setup steam-region [country]` | Steam store region for sale prices, as a two-letter country code. |
| `/setup free-game-filters [min_rating] [like_what_we_play] [multiplayer_only] [not_on_steam]` | Chooses which free games are worth posting. See [Free games](deals.md#free-games). |
| `/setup sale-alerts [min_discount] [post_hour] [steam_wishlists] [other_stores] [bundles] [bundles_like_we_play] [channel]` | Sets the smallest sale worth posting, the hour of the day's sale post, whether Steam wishlists count, whether other stores' prices count, whether bundles are posted and whether ones only like what the server plays count, and a channel of their own. See [Sale alerts](deals.md#sale-alerts) and [Bundles](deals.md#bundles). |
| `/setup free-games [enabled] [channel]` | Turns free game posts on or off. `channel` gives them their own channel; without it they go to the announce channel. To move them back to the announce channel, use `/setup reset setting:Free games channel`. |
| `/setup gamenight-reminder [minutes]` | How long before a game night to remind the people who are in. `0` turns reminders off. |
| `/setup monthly-recap [enabled]` | Turns the post on the 1st of each month on or off. |
| `/setup patch-notes [mode] [channel]` | Posts patch notes for games played here: `each` as they come out, `digest` once a week, or `off`. `channel` gives them their own channel. |
| `/setup steam-status [enabled]` | Whether what linked members in voice are playing on Steam counts when Discord doesn't show it. |
| `/setup sounds [even_volume] [join_sounds] [join_cooldown_minutes] [join_delay_ms] [volume]` | Turns [even volume](soundboard.md#even-volume) and join sounds on or off, and sets how often one person's join sound can play and how long the bot waits after connecting before it plays. `volume` sets how loud every sound plays. |
| `/setup loop-room [channel] [off] [sound] [volume] …` | Plays a sound, and speech if you like, nonstop while anyone's in a voice channel. `off:True` turns it off and keeps the rest of its settings. See [looping sound room](soundboard.md#looping-sound-room). |
| `/setup music [volume] [autoplay] [dj_role] [everyone]` | How loud music plays, whether Autoplay adds similar songs once the queue runs out, and who can control it. `everyone:True` takes the role limit off. See [Music](music.md). |
| `/setup sound-managers [role] [everyone]` | Limits changing sounds to a role, plus people with **Manage Server**. `everyone:True` lets everyone change them again, which is the default. See [who can change sounds](soundboard.md#who-can-change-sounds). |
| `/setup speech [enabled] [speed] [volume] …` | Text to speech: on or off, its speed, the limits on `/say`, and what the bot says aloud by itself. See [Text to speech](speech.md). |
| `/setup speech-role [role] [everyone]` | Limits `/say` and having messages read out to a role, plus people with **Manage Server**. `everyone:True` lets everyone again. |
| `/setup speech-channel [channel] [off] [who]` | Reads out what people type in a channel. `off:True` stops it. |
| `/setup reset setting` | Puts one setting back to its default. |

Only the options you fill in change. Give none and the reply shows how those settings are now, without changing anything.

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
2. the host's default, from an environment variable (see [Configuration](self-hosting.md#configuration));
3. the built-in default.

So the host can change a default for every server at once, and each server can still override it.

Each setting goes by the name `/setup show` and `/setup reset` use. A few are set only in the web UI's Settings, marked "web UI only".

| Setting | `/setup` command | Host default variable | Built-in default |
| --- | --- | --- | --- |
| Announce channel | `announce-channel` | | none, nothing is posted |
| Hop-on role | `hopon-role` | | none |
| Hop-on ping at | `hopon` | `HOPON_MIN_PEOPLE` | 2 people |
| Hop-on cooldown | `hopon` | `HOPON_COOLDOWN_MIN` | 120 minutes |
| Session recaps | `sessions` | `SESSION_RECAP` (`false` to turn off) | on |
| Shortest session counted | `sessions` | `RECAP_MIN_MINUTES` | 15 minutes |
| Session ends after empty for | `sessions` | `SESSION_GRACE_MIN` | 5 minutes |
| Weekly leaderboard | `leaderboard` | `WEEKLY_LEADERBOARD` (`false` to turn off) | on |
| Weekly leaderboard day | `leaderboard` | `WEEKLY_POST_DAY` (0 is Sunday) | Sunday |
| Weekly leaderboard hour | `leaderboard` | `WEEKLY_POST_HOUR` | 20:00 |
| Time zone | `timezone` | `TZ` | UTC |
| Steam price region | `steam-region` | `STEAM_CC` | `us` |
| Free game alerts | `free-games` | `FREE_GAMES` (`true` to turn on) | off |
| Free games channel | `free-games` | | the announce channel |
| Lowest Steam rating | `free-game-filters` | `FREE_GAMES_MIN_RATING` | 70% positive |
| Only games like what you play | `free-game-filters` | `FREE_GAMES_TASTE` (`false` to turn off) | on |
| Only multiplayer games | `free-game-filters` | `FREE_GAMES_MULTIPLAYER` (`true` to turn on) | off |
| Games not on Steam | `free-game-filters` | `FREE_GAMES_UNLISTED` (`true` to show them) | hidden |
| Smallest sale worth posting | `sale-alerts` | `SALE_MIN_DISCOUNT` | 25% off |
| Sale post time | `sale-alerts` | `SALE_POST_HOUR` | 18:00 |
| Steam wishlists in sale alerts | `sale-alerts` | `SALE_STEAM_WISHLISTS` (`false` to turn off) | on |
| Other stores in sale alerts | `sale-alerts` | `SALE_OTHER_STORES` (`false` to turn off) | on, with an `ITAD_API_KEY` (key resellers with a `GGDEALS_API_KEY`) |
| Bundle alerts | `sale-alerts` | `BUNDLE_ALERTS` (`false` to turn off) | on, with an `ITAD_API_KEY` |
| Bundles like what you play | `sale-alerts` | `BUNDLES_LIKE_WE_PLAY` (`false` to turn off) | on |
| Sale alerts channel | `sale-alerts` | | announce channel |
| Games from Steam status | `steam-status` | `STEAM_STATUS` (`false` to turn off) | on |
| Patch notes | `patch-notes` | `PATCH_NOTES` (`off`, `each` or `digest`) | off |
| Patch notes channel | `patch-notes` | | announce channel |
| Game night reminder | `gamenight-reminder` | `GAMENIGHT_REMINDER_MIN` | 15 minutes before |
| Monthly recap | `monthly-recap` | `MONTHLY_RECAP` (`false` to turn off) | on |
| Even volume | `sounds` | `EVEN_VOLUME` (`false` to turn off) | on |
| Join sounds | `sounds` | `JOIN_SOUNDS` (`false` to turn off) | on |
| Join sound cooldown | `sounds` | `JOIN_SOUND_COOLDOWN_MIN` | 10 minutes |
| Join sound delay | `sounds` | `JOIN_SOUND_DELAY_MS` | 500 ms after the bot connects |
| Soundboard volume | `sounds` | `SOUND_VOLUME` | 100% |
| Sound managers | `sound-managers` | | everyone |
| Looping sound room | `loop-room` | | off |
| Looping sound | `loop-room` | | not set |
| Loop volume | `loop-room` | `LOOP_VOLUME` | 50% |
| Loop every | `loop-room` | `LOOP_EVERY` | 0 seconds, looping without a gap |
| Looping speech | `loop-room` | | off |
| Looping speech voice | web UI only | | the default voice |
| Speech every | `loop-room` | `LOOP_TEXT_EVERY` | 0 seconds, saying it again straight away |
| Intro sound | `loop-room` | | off |
| Intro delay | `loop-room` | `LOOP_INTRO_DELAY_MS` | 250 ms |
| Looping speech volume | `loop-room` | `LOOP_TEXT_VOLUME` | 50% |
| Sound delay after intro | `loop-room` | `LOOP_SOUND_DELAY_MS` | 0 ms |
| Speech delay after intro | `loop-room` | `LOOP_TEXT_DELAY_MS` | 0 ms |
| Music volume | `music` | `MUSIC_VOLUME` | 40% |
| Autoplay | `music`, or `/music autoplay` | `MUSIC_AUTOPLAY` | off |
| Who can control music | `music` | | everyone |
| Text to speech | `speech` | `TTS` (`false` to turn off) | on |
| Default voice | web UI only | `TTS_VOICE` (a voice's id, such as `glados`, `demon` or one added in the web UI) | `tiktok` |
| Speech speed | `speech` | `TTS_SPEED` | 85% of the voice's natural speed |
| Speech volume | `speech` | `TTS_VOLUME` | 100%, about as loud as a sound with even volume on |
| Longest spoken line | `speech` | `TTS_MAX_CHARS` (up to 6000) | 4000 characters |
| Wait between spoken lines | `speech` | `TTS_COOLDOWN_SEC` | 5 seconds |
| Who can use text to speech | `speech-role` | | everyone |
| Say who joined | `speech` | `TTS_GREET` | off |
| Greeting | `speech` | `TTS_GREETING` | `{name} joined` |
| Say game night reminders | `speech` | `TTS_NIGHT_REMINDERS` | off |
| Say hop-on pings | `speech` | `TTS_HOP_ON` | off |
| Read chat aloud | `speech-channel` | | off |
| Whose messages are read | `speech-channel` | `TTS_CHANNEL_WHO` (`everyone` or `voice`) | everyone |

## Multiple servers

One running bot can serve several servers. Each server gets its own:
- settings (`/setup`),
- game library, ownership marks and hidden games,
- game ping roles and game nights,
- voice sessions, recaps, leaderboards and game stats,
- sounds, emoji, panels and Discord soundboard sync,
- hop-on cooldown, sale alerts and free game posts.

**Steam links are shared.** Your Steam account is the same everywhere, so you link it once with `/steam link` and every server you're in can use it. In each server, the bot only counts people who are members there. Someone in another server never shows up in your picker, game list, sale pings or stats.

**Choosing which servers can use it:** with `ALLOWED_GUILD_IDS` set, the bot leaves any server that isn't on the list as soon as it's added. Without it, anyone with the invite link can add the bot. Set it if the bot is public (see [Setup](self-hosting.md)).
