# Setting up a server

For server admins: adding the bot, `/setup`, and every setting with its default.

## Adding the bot to a server

You need the **Manage Server** permission in the server.

1. **Add the bot.** Open the invite link from the host, pick your server, leave every permission ticked and click **Authorize**. It posts a short hello in the system channel.
   - **Manage Roles** lets `/notify` and `/gamerole` hand out roles below the bot's own. Without it, or for a role above the bot's, people are told to ask an admin, and Settings marks the role "an admin hands it out".
   - **Create Expressions** lets it copy sounds to the server's soundboard. **Manage Expressions** is only for swapping out or removing sounds other people added there.
   - **Create Events** lets game nights show in the server's Events list.
   - **Change Nickname** lets a chat [profile](chat.md#profiles) with a nickname rename it. @everyone usually has it anyway.

   A bot added with an older invite link may be missing **Create Events**, **Manage Expressions** or **Change Nickname**. Open the new link again (it keeps the bot), or tick them on the bot's role.
2. **Pick the announce channel:** `/setup announce-channel channel:#somewhere`, where hop-on pings, recaps, leaderboards and sale alerts go. If the bot can't post there, it says which permission is missing.
3. **Make a hop-on role** (optional): create a role such as `hop-on` in **Server Settings → Roles**, drag the bot's role above it (Discord only lets a bot hand out roles below its own), and run `/setup hopon-role role:@hop-on`.
4. **Set the time zone** if it isn't the host's: `/setup timezone zone:Europe/London`. Free game posts are off until `/setup free-games enabled:True`.
5. **Add game pings** (optional): `/gamerole add game:Valheim` for each game, then `/gamerole menu` where people will see it.
6. **Check voice channels:** the bot needs **Connect** and **Speak** in any channel the soundboard is used in. A sound click says if one is missing.
7. **Check it:** `/setup show` lists every setting, and anything that needs fixing first.

Then tell people to run `/steam link`, `/notify` and `/pings` (see [Getting started](../README.md#getting-started-for-everyone-in-the-server)), and post a `/sound panel` somewhere handy.

## Server settings

`/setup` is for people with **Manage Server**, and its replies are only shown to you. Other roles can be allowed in **Server Settings → Integrations → Slopkeeper**. Every setting has a default, so only the announce channel needs setting, and every setting can also be changed in the web UI's Settings.

| Command | What it does |
| --- | --- |
| `/setup show` | Every setting and where it comes from (**set here** or **host default**), with anything that needs fixing first: a missing announce channel, a channel or role that's gone, a role above the bot's, a missing permission, or a post Discord refused (until the next one goes out, or for two days). |
| `/setup announce-channel channel` | Where hop-on pings, recaps, leaderboards and sale alerts go, and free games unless they have their own channel. Until it's set, the bot posts nothing. |
| `/setup hopon-role [role] [off]` | The role hop-on pings ping and `/notify` hands out. `off:True` posts them without a ping. |
| `/setup hopon [min_people] [cooldown_minutes]` | How many people a channel needs for a hop-on ping, and the wait before the next. |
| `/setup sessions [recaps] [recap_min_minutes] [grace_minutes]` | Whether recaps are posted, the shortest session counted, and how long a channel stays empty before its session ends. |
| `/setup leaderboard [enabled] [day] [hour]` | Whether and when the weekly leaderboard is posted. |
| `/setup timezone [zone]` | The server's time zone, for posts, leaderboards and game night times. |
| `/setup steam-region [country]` | The Steam store region for sale prices, as a two-letter country code. |
| `/setup sale-alerts …` | The smallest sale, the post hour, wishlists, other stores, bundles and a channel. See [Sale alerts](deals.md#sale-alerts). |
| `/setup free-games [enabled] [channel]` | Free game posts on or off, and their own channel. `/setup reset setting:Free games channel` moves them back. |
| `/setup free-game-filters …` | Which free games are worth posting. See [Free games](deals.md#free-games). |
| `/setup gamenight-reminder [minutes]` | How long before a game night to remind people. `0` turns it off. |
| `/setup monthly-recap [enabled]` | The post on the 1st of each month. |
| `/setup patch-notes [mode] [channel]` | Patch notes `each` as they come out, as a weekly `digest`, or `off`. |
| `/setup steam-status [enabled]` | Whether Steam's "playing" counts when Discord shows nothing. |
| `/setup sounds …` | [Even volume](soundboard.md#volume), join sounds with their cooldown and delay, and the soundboard volume. |
| `/setup loop-room …` | The [looping sound room](soundboard.md#looping-sound-room). `off:True` turns it off and keeps its settings. |
| `/setup music [volume] [autoplay] [dj_role] [everyone]` | Music volume, Autoplay, and who can control it. See [Music](music.md). |
| `/setup sound-managers [role] [everyone]` | Limits changing sounds to a role, plus **Manage Server**. See [who can change sounds](soundboard.md#who-can-change-sounds). |
| `/setup speech …` | Text to speech: on or off, speed, volume, limits, and what it says by itself. See [Text to speech](speech.md). |
| `/setup speech-role [role] [everyone]` | Limits speech to a role, plus **Manage Server**. |
| `/setup speech-channel [channel] [off] [who]` | A text channel read aloud. `who` limits it to people in voice, and `off:True` stops it. |
| `/setup reset setting` | Puts one setting back to its default. |

Only the options you fill in change, and with none the reply shows how those settings are now.

```
/setup hopon min_people:3 cooldown_minutes:60
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
| Only multiplayer sales | `sale-alerts` | `SALE_MULTIPLAYER` (`true` to turn on) | off |
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
| Looping speech effect | web UI only | | the default effect |
| Speech every | `loop-room` | `LOOP_TEXT_EVERY` | 0 seconds, saying it again straight away |
| Intro sound | `loop-room` | | off |
| Intro delay | `loop-room` | `LOOP_INTRO_DELAY_MS` | 250 ms |
| Looping speech volume | `loop-room` | `LOOP_TEXT_VOLUME` | 50% |
| Sound delay after intro | `loop-room` | `LOOP_SOUND_DELAY_MS` | 0 ms |
| Speech delay after intro | `loop-room` | `LOOP_TEXT_DELAY_MS` | 0 ms |
| Music volume | `music` | `MUSIC_VOLUME` | 20% |
| Even music volume | web UI only | `EVEN_MUSIC` (`false` to turn off) | on |
| Autoplay | `music`, or `/music autoplay` | `MUSIC_AUTOPLAY` | off |
| Who can control music | `music` | | everyone |
| Music search | web UI only | `MUSIC_SEARCH` (`spotify` or `youtube-music`) | Spotify |
| Fall back to the other | web UI only | `MUSIC_SEARCH_FALLBACK` (`false` to turn off) | on |
| Answer in chat | web UI only | `CHAT` (`false` to turn off) | on, with an `ANTHROPIC_API_KEY` |
| Profile | web UI only | `CHAT_PERSONALITY` sets the Robot butler's personality | the Robot butler, a robot butler with impeccable manners and no brakes (see [Profiles](chat.md#profiles)). A profile with a nickname renames the bot in the server |
| Model | web UI only | `CHAT_MODEL` (`haiku`, `sonnet` or `opus`) | `haiku` |
| Search the web | web UI only | `CHAT_WEB_SEARCH` (`false` to turn off) | on |
| Take actions | web UI only | `CHAT_ACTIONS` (`false` to turn off) | on |
| Roast rude people | web UI only | `CHAT_ROASTS` (`false` to turn off) | on |
| Lines on automatic posts | web UI only | `CHAT_POST_LINES` (`false` to turn off) | on |
| Answer in voice | web UI only | `CHAT_VOICE` (`off`, `also` or `only`) | off |
| Answers a day | web UI only | `CHAT_DAILY_LIMIT` | 200 |
| Text to speech | `speech` | `TTS` (`false` to turn off) | on |
| Default voice | web UI only | `TTS_VOICE` (a voice's id, such as `scottish`, `american-deep` or one added in the web UI) | `southern-man` |
| Default effect | web UI only | `TTS_EFFECT` (an effect's id, such as `robot`, or `none`) | `none` |
| Speech speed | `speech` | `TTS_SPEED` | 85% of the voice's natural speed |
| Pause between sentences | `speech` | `TTS_PAUSE_MS` | 200 ms |
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

**Choosing which servers can use it:** with `ALLOWED_GUILD_IDS` set, the bot leaves any server that isn't on the list as soon as it's added. Without it, anyone with the invite link can add the bot. Set it if the bot is public (see [Self-hosting](self-hosting.md#configuration)).
