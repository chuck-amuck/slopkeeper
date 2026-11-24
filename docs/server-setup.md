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
3. **Make a hop-on role** (optional): create a role such as `hop-on` in **Server Settings → Roles**, drag the bot's role above it (Discord only lets a bot hand out roles below its own), and pick it as **Hop-on role** in the web UI's Settings, under **Voice and pings**.
4. **Set the time zone** if it isn't the host's: `/setup timezone zone:Europe/London`. Free game posts are off until they're turned on in Settings, under **Deals**.
5. **Add game pings** (optional): `/gamerole add game:Valheim` for each game, then `/gamerole menu` where people will see it.
6. **Check voice channels:** the bot needs **Connect** and **Speak** in any channel the soundboard is used in. A sound click says if one is missing.
7. **Check it:** `/setup show` lists every setting, and anything that needs fixing first.

Then tell people to run `/steam link`, `/notify` and `/pings` (see [Getting started](../README.md#getting-started-for-everyone-in-the-server)), and post a `/sound panel` somewhere handy.

## Server settings

`/setup` is for people with **Manage Server**, and its replies are only shown to you. Other roles can be allowed in **Server Settings → Integrations → Slopkeeper**. It sets the basics a server needs to get going: where posts go, the time zone, and who can use what. Every setting, the basics included, is in the [web UI](web-ui.md)'s Settings. Every setting has a default, so only the announce channel needs setting. Settings keeps up without a reload: a change made with `/setup` or in another tab shows at once, except in a field you're typing in.

| Command | What it does |
| --- | --- |
| `/setup show` | Every setting and where it comes from (**set here** or **host default**), with anything that needs fixing first: a missing announce channel, a channel or role that's gone, a role above the bot's, a missing permission, or a post Discord refused (until the next one goes out, or for two days). |
| `/setup announce-channel channel` | Where hop-on pings, recaps, leaderboards and sale alerts go, and free games unless they have their own channel. Until it's set, the bot posts nothing. |
| `/setup timezone [zone]` | The server's time zone, for posts, leaderboards and game night times. |
| `/setup sound-managers [role] [everyone]` | Limits changing sounds to a role, plus **Manage Server**. See [who can change sounds](soundboard.md#who-can-change-sounds). |
| `/setup music-role [role] [everyone]` | Limits controlling music to a role, plus **Manage Server**. See [Music](music.md). |
| `/setup speech-role [role] [everyone]` | Limits speech to a role, plus **Manage Server**. |

With nothing filled in, the reply shows how that setting is now. `everyone:True` lifts a role limit.

```
/setup timezone zone:America/Chicago
/setup music-role role:@DJ
/setup speech-role everyone:True
```

### Settings and defaults

Each setting comes from the first of these that's set:
1. the server's own value, from Settings or `/setup`;
2. the host's default, from an environment variable (see [Configuration](self-hosting.md#configuration));
3. the built-in default.

So the host can change a default for every server at once, and each server can still override it.

Each setting goes by the name Settings and `/setup show` use. They're listed here under the sections of the web UI's Settings, in the same order. The **Basics** can be set with `/setup` too, and the rest only in Settings.

**Basics**

| Setting | `/setup` command | Host default variable | Built-in default |
| --- | --- | --- | --- |
| Announce channel | `announce-channel` | | none, nothing is posted |
| Time zone | `timezone` | `TZ` | the host's own time zone, or UTC |
| Sound managers | `sound-managers` | | everyone |
| Who can control music | `music-role` | | everyone |
| Who can use text to speech | `speech-role` | | everyone |

**Voice and pings**

| Setting | Host default variable | Built-in default |
| --- | --- | --- |
| Hop-on role | | none |
| Hop-on ping at | `HOPON_MIN_PEOPLE` | 2 people |
| Hop-on cooldown | `HOPON_COOLDOWN_MIN` | 120 minutes |
| Say hop-on pings | `TTS_HOP_ON` | off |
| Session recaps | `SESSION_RECAP` (`false` to turn off) | on |
| Shortest session counted | `RECAP_MIN_MINUTES` | 15 minutes |
| Session ends after empty for | `SESSION_GRACE_MIN` | 5 minutes |
| Weekly leaderboard | `WEEKLY_LEADERBOARD` (`false` to turn off) | on |
| Weekly leaderboard day | `WEEKLY_POST_DAY` (0 is Sunday) | Sunday |
| Weekly leaderboard hour | `WEEKLY_POST_HOUR` | 20:00 |
| Monthly recap | `MONTHLY_RECAP` (`false` to turn off) | on |

**Games**

| Setting | Host default variable | Built-in default |
| --- | --- | --- |
| Game night reminder | `GAMENIGHT_REMINDER_MIN` | 15 minutes before |
| Say game night reminders | `TTS_NIGHT_REMINDERS` | off |
| Steam price region | `STEAM_CC` | `us` |
| Games from Steam status | `STEAM_STATUS` (`false` to turn off) | on |
| Patch notes | `PATCH_NOTES` (`off`, `each` or `digest`) | off |
| Patch notes channel | | announce channel |

**Deals**

| Setting | Host default variable | Built-in default |
| --- | --- | --- |
| Smallest sale worth posting | `SALE_MIN_DISCOUNT` | 25% off |
| Sale post time | `SALE_POST_HOUR` | 18:00 |
| Steam wishlists in sale alerts | `SALE_STEAM_WISHLISTS` (`false` to turn off) | on |
| Other stores in sale alerts | `SALE_OTHER_STORES` (`false` to turn off) | on, with an `ITAD_API_KEY` (key resellers with a `GGDEALS_API_KEY`) |
| Only multiplayer sales | `SALE_MULTIPLAYER` (`true` to turn on) | off |
| Sale alerts channel | | announce channel |
| Bundle alerts | `BUNDLE_ALERTS` (`false` to turn off) | on, with an `ITAD_API_KEY` |
| Bundles like what you play | `BUNDLES_LIKE_WE_PLAY` (`false` to turn off) | on |
| Free game alerts | `FREE_GAMES` (`true` to turn on) | off |
| Free games channel | | the announce channel |
| Lowest Steam rating | `FREE_GAMES_MIN_RATING` | 70% positive |
| Only games like what you play | `FREE_GAMES_TASTE` (`false` to turn off) | on |
| Only multiplayer games | `FREE_GAMES_MULTIPLAYER` (`true` to turn on) | off |
| Games not on Steam | `FREE_GAMES_UNLISTED` (`true` to show them) | hidden |

**Soundboard**

| Setting | Host default variable | Built-in default |
| --- | --- | --- |
| Soundboard volume | `SOUND_VOLUME` | 60% |
| Even volume | `EVEN_VOLUME` (`false` to turn off) | on |
| Join sounds | `JOIN_SOUNDS` (`false` to turn off) | on |
| Say who joined | `TTS_GREET` | off |
| Greeting | `TTS_GREETING` | `{name} joined` |
| Join sound delay | `JOIN_SOUND_DELAY_MS` | 500 ms after the bot connects |
| Join sound cooldown | `JOIN_SOUND_COOLDOWN_MIN` | 10 minutes |

**Music**

| Setting | Host default variable | Built-in default |
| --- | --- | --- |
| Music volume | `MUSIC_VOLUME` | 100%, well under the bot's speech |
| Music drops while people talk | `MUSIC_DUCKS_FOR_PEOPLE` (`false` to turn off) | on |
| What counts as talking | `MUSIC_DUCKS_FOR` (`talking`, `loud` or `any`) | talking, not background noise |
| Autoplay (also `/music autoplay`) | `MUSIC_AUTOPLAY` | off |
| Even music volume | `EVEN_MUSIC` (`false` to turn off) | on |
| Music search | `MUSIC_SEARCH` (`spotify` or `youtube-music`) | Spotify |
| Fall back to the other | `MUSIC_SEARCH_FALLBACK` (`false` to turn off) | on |

**Speech**

| Setting | Host default variable | Built-in default |
| --- | --- | --- |
| Text to speech | `TTS` (`false` to turn off) | on |
| Default voice | `TTS_VOICE` (a voice's id, such as `scottish`, `american-deep` or one added in the web UI) | `southern-man` |
| Default effect | `TTS_EFFECT` (an effect's id, such as `robot`, or `none`) | `none` |
| Speech volume | `TTS_VOLUME` | 100%, a little louder than a sound with even volume on |
| Speech speed | `TTS_SPEED` | 85% of the voice's natural speed |
| Pause between sentences | `TTS_PAUSE_MS` | 200 ms |
| Longest spoken line | `TTS_MAX_CHARS` (up to 6000) | 4000 characters |
| Wait between spoken lines | `TTS_COOLDOWN_SEC` | 5 seconds |
| Read chat aloud | | off |
| Whose messages are read | `TTS_CHANNEL_WHO` (`everyone` or `voice`) | everyone |

**Chat**

| Setting | Host default variable | Built-in default |
| --- | --- | --- |
| Answer in chat | `CHAT` (`false` to turn off) | on, with an `ANTHROPIC_API_KEY` |
| Model | `CHAT_MODEL` (`haiku`, `sonnet` or `opus`) | `haiku` |
| Answer in voice | `CHAT_VOICE` (`off`, `also` or `only`) | off |
| Search the web | `CHAT_WEB_SEARCH` (`false` to turn off) | on |
| Take actions | `CHAT_ACTIONS` (`false` to turn off) | on |
| Roast rude people | `CHAT_ROASTS` (`false` to turn off) | on |
| Lines on automatic posts | `CHAT_POST_LINES` (`false` to turn off) | on |
| Answers a day | `CHAT_DAILY_LIMIT` | 200 |
| Profile | `CHAT_PERSONALITY` sets the Robot butler's personality | the Robot butler, a robot butler with impeccable manners and no brakes (see [Profiles](chat.md#profiles)). A profile with a nickname renames the bot in the server, and one with a photo gives it that photo there. Also picked from the photo in the web UI's header |

**Looping room**

| Setting | Host default variable | Built-in default |
| --- | --- | --- |
| Looping sound room | | off |
| Looping sound | | not set |
| Loop volume | `LOOP_VOLUME` | 50% |
| Loop every | `LOOP_EVERY` | 0 seconds, looping without a gap |
| Intro sound | | off |
| Intro delay | `LOOP_INTRO_DELAY_MS` | 250 ms |
| Sound delay after intro | `LOOP_SOUND_DELAY_MS` | 0 ms |
| Looping speech | | off |
| Looping speech voice | | the default voice |
| Looping speech effect | | the default effect |
| Looping speech volume | `LOOP_TEXT_VOLUME` | 50% |
| Speech every | `LOOP_TEXT_EVERY` | 0 seconds, saying it again straight away |
| Speech delay after intro | `LOOP_TEXT_DELAY_MS` | 0 ms |

## Multiple servers

One running bot can serve several servers. Each server gets its own:
- settings,
- game library, ownership marks and hidden games,
- game ping roles and game nights,
- voice sessions, recaps, leaderboards and game stats,
- sounds, emoji, panels and Discord soundboard sync,
- hop-on cooldown, sale alerts and free game posts.

**Steam links are shared.** Your Steam account is the same everywhere, so you link it once with `/steam link` and every server you're in can use it. In each server, the bot only counts people who are members there. Someone in another server never shows up in your picker, game list, sale pings or stats.

**Choosing which servers can use it:** with `ALLOWED_GUILD_IDS` set, the bot leaves any server that isn't on the list as soon as it's added. Without it, anyone with the invite link can add the bot. Set it if the bot is public (see [Self-hosting](self-hosting.md#configuration)).
