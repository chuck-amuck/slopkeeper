# Stats

Recaps of voice sessions, leaderboards, game stats and the monthly recap. The web UI's Stats page charts most of it.

## Session recaps

The bot tracks each voice channel as a session, with who was there, for how long and what they played. A session ends once the channel has been empty for 5 minutes, so a quick disconnect doesn't split the night. A bot restart doesn't either, if it's back within 10 minutes.

Sessions of 15 minutes or more are recorded, even alone, so time on your own counts towards voice stats. With 2 or more people, the bot also posts a recap with each person's time and the games played. `/setup sessions` changes both times, and `recaps:False` stops the posts while still recording.

## Voice leaderboards

| Command | What it does |
| --- | --- |
| `/stats [period]` | The top 10 by time in voice for the past week (default), month or all time, how many nights each showed up, and the most played games. |

Every Sunday at 8 PM in the server's time zone, the bot posts the week's leaderboard. If it was down then, it posts when it's back, up to a day late. `/setup leaderboard` changes the day and hour or turns the post off.

## Game stats

The bot records how long each person plays each game while they're in voice (not the AFK channel), from the "Playing" status Discord shows. Games played outside voice aren't recorded, and nor are plays under a minute. Anyone who'd rather not be counted can turn off **Settings → Activity Privacy → Share my activity** in Discord.

A game's time is how long anyone was playing it, so two people playing for the same hour add one hour to the game and an hour each to themselves. That's why a game's players can add up to more than the game.

| Command | What it does |
| --- | --- |
| `/gamestats` | The whole server: total game time, the 10 most played games and the 10 people who play the most. |
| `/gamestats user` | One person's total and top games, with when they last played each. |
| `/gamestats game` | One game: its total and each person's time. |
| `/gamestats user game` | One person and one game: their hours, sessions and rank. |
| **Game stats** (Apps menu) | Right-click a member (or press and hold on a phone) → **Apps → Game stats**: their past month, just for you. |

Each takes `period`: past week, past month (default), past year or all time. The web UI's Stats → Overview adds today, 90 days, this year and any dates on a calendar.

```
/gamestats user:@Sam period:All time
/gamestats user:@Alex game:Lethal Company
```

### Game names

Discord can report one game several ways. Names that differ only in case, spaces, punctuation or a Roman numeral (`slaythespire2`, "Slay the Spire II") count as one game. So do Linux program names (`streetsofroguelinux.x86_64` is Streets of Rogue), which take Steam's title when someone here owns the game. For anything else, like "StS 2", use **Merge games** on the web UI's Stats page. Merges change nothing stored, so **Separate** undoes them, automatic ones included.

Launchers and helpers like `steamwebhelper`, and Moonlight, aren't counted. Anything else can be marked **Not a game** on its Stats page, which leaves it out of stats, game nights, roles and recaps until **It's a game** counts it again.

### Voice, music and speech history

Since November 2026, the bot also notes when people join and leave voice, so Stats can show when in the week people are on. For Stats → **Sounds & music**, it notes each song played (who added it and how far it got) and each line said aloud (who, in which voice and how long). The words of a line are never kept.

## Comparing two people

| Command | What it does |
| --- | --- |
| `/compare user [with]` | Compares someone with you, or with `with`. |
| **Compare with me** (Apps menu) | The same from a member's **Apps** menu, just for you. |

It shows, over all time, how long the two played the same game in the same channel, the voice sessions they shared, each one's total game time, and the multiplayer games they both own.

## Monthly recap

On the 1st of each month, at the leaderboard's hour, the bot posts last month's highlights: total game and voice time, top games, biggest gamers, most time in voice, the longest session, top sounds and game nights. Months with nothing to report are skipped. `/setup monthly-recap` turns the post off.

Top sounds counts the bot's sounds, and sounds played from Discord's own soundboard in the channel the bot is in, as Discord doesn't report plays anywhere else. Discord's built-in sounds don't count.

| Command | What it does |
| --- | --- |
| `/recap [month]` | Last month's recap, or this month's so far. |
