# Stats

Recaps of voice sessions, leaderboards, game stats and the monthly recap.

## Session recaps

The bot tracks each voice channel as a session. It records who was there, for how long, and which games Discord showed them playing. A session ends once the channel has been empty for 5 minutes, so a quick disconnect doesn't split the night in two.

A session of at least 15 minutes is recorded, even with one person in it, so time alone counts towards voice stats. With 2 or more people, the bot also posts a recap with each person's time and the games played. Shorter sessions aren't recorded. Both times can be changed with `/setup sessions`, and `/setup sessions recaps:False` stops the recap posts while still recording sessions. A bot restart, such as an update, doesn't split a session: if it's back within 10 minutes, the session carries on, counting the time in between, and gets one recap at the end.

## Voice leaderboards

| Command | What it does |
| --- | --- |
| `/stats [period]` | Voice leaderboard for the past week (default), past month or all time. Shows the top 10 by time in voice, how many nights each person showed up, and the most-played games by game time, as `/gamestats` does. |

Every Sunday at 8 PM, in the server's time zone, the bot posts the past week's leaderboard to the announce channel. If it was down then, it posts when it's back, up to a day late, still covering the week up to 8 PM that Sunday. Moving the day never posts two within six days. Change the day and hour with `/setup leaderboard`, or turn the post off with `/setup leaderboard enabled:false`. `/stats` still works when it's off.

## Game stats

The bot records how long each person plays each game while they're in a voice channel, from the "Playing" status Discord shows on their profile. They don't need anyone else there, but games played outside voice, or in the AFK channel, aren't recorded at all. It keeps the record per server. Anyone who doesn't want this can turn off **Settings → Activity Privacy → Share my activity** in Discord. Plays under a minute (launchers, crashes) aren't kept.

A game's time is how long anyone was playing it, so two people playing for the same hour add one hour to the game and one hour each to themselves. That's why the players of a game can add up to more than the game itself. If the same game is running in two voice channels at once, it still only counts once.

Different spellings of a game count as one. Discord can report a game several ways, so spellings that only differ by case, spaces or punctuation match by themselves: `slaythespire2` joins "Slay the Spire 2". So does a Roman numeral from II to IX in capitals at the end of a name: "Slay the Spire II" joins too. For anything else, like "StS 2", use **Merge games** on the web UI's Stats page. Merges apply to past stats, ping roles and new plays. Nothing stored is changed, so **Separate** puts a spelling back at any time.

Discord on Linux often shows a game by its program's name, and sometimes with stray escape codes. Names are cleaned of those as they come in (and were cleaned once where they were already kept). A program's name joins its game without the platform it was built for, so `streetsofroguelinux.x86_64` is Streets of Rogue, and one known only by its program goes by Steam's title for it when someone here owns it, so `doomthedarkages` shows as DOOM: The Dark Ages. When Discord shows a program's name while that person's linked Steam says they're playing a game spelled with its letters (`swzerocompany` and STAR WARS Zero Company), the program becomes that game from then on, where Steam status is on. These are automatic, so **Separate** undoes them, and a merge someone chose always wins.

Launchers and other programs that aren't games (`launcher`, `crashpad_handler`, `steamwebhelper`, and Moonlight, which streams whatever's on the PC) aren't recorded. Anything else can be marked **Not a game** on the game's Stats page: it's left out of Stats, game nights, game roles and session recaps, and its time is kept, so **Not games** beside **Merge games** lists them, each with **It's a game** to count it again.

Game time from before this rule is an estimate: the bot kept what fell inside saved voice sessions, up to each person's time in that session.

| Command | What it does |
| --- | --- |
| `/gamestats` | The whole server: how long games were played, the 10 most played with how many people play them, and the 10 people who play the most. |
| `/gamestats user` | One person: their total and their top games, with when they last played each. |
| `/gamestats game` | One game: how long it was played, and how long each person played it. The name autocompletes from what's been played. |
| `/gamestats user game` | One person and one game: their hours, number of sessions, and where they rank among the server's players. |
| **Game stats** (Apps menu) | Right-click a member, or press and hold on a phone, then **Apps → Game stats**: their past month, as `/gamestats user` shows it, just for you. |

Every form takes `period`: past week, past month (default), past year or all time. The web UI's Stats → Overview also offers today, 90 days and this year, counted from midnight in the server's time zone, or any dates picked on a calendar.

### Voice, music and speech history

From November 2026 the bot also notes when each person joins and leaves a voice channel (not the AFK channel, and not bots), for Stats to show when in the week people are on. Before that, only people playing a game Discord shows were noted. It also notes, for Stats → **Sounds & music**, each song heard from its start (its title, artist and link, where it came from, who added it or Autoplay, and how far it got, or that it was skipped) and each line said aloud (who asked, the voice, how many characters and whether it was said, read out from the speech channel or an announcement). The words of a line are never kept.

Examples:
```
/gamestats
/gamestats user:@Sam period:All time
/gamestats game:Valheim
/gamestats user:@Alex game:Lethal Company
```

## Comparing two people

| Command | What it does |
| --- | --- |
| `/compare user [with]` | Compares someone with you, or with whoever you pick in `with`. |
| **Compare with me** (Apps menu) | Right-click a member, or press and hold on a phone, then **Apps → Compare with me**: the same, just for you. |

It shows, over all time:
- how long the two played the same game in the same voice channel, and which games most;
- how many voice sessions they shared. The time shown is a maximum, because the bot keeps each person's total for a session, not when each of them was there;
- each person's total game time;
- games they both own: anything in the library, plus Steam games tagged multiplayer.

## Monthly recap

On the 1st of each month, the bot posts last month's highlights to the announce channel, at the same hour as the weekly leaderboard. If it was down then, it posts when it's back. Months with nothing to report are skipped, and a server's first recap comes after its first full month.

The recap covers total game and voice time, the top games, biggest gamers, most time in voice, the longest session, top sounds and who played the most of them, and game nights held. Months follow the server's time zone.

Top sounds counts sounds played through the bot (its panels, `/sound play` and the web UI) and sounds people play from Discord's own soundboard in the voice channel the bot is in at the time. Discord doesn't report plays anywhere else. A sound on Discord that's a copy of a library sound counts as that sound, also for the web UI's most-played order, and Discord's built-in sounds aren't counted.

| Command | What it does |
| --- | --- |
| `/recap [month]` | Shows last month's recap, or this month's so far. |

Turn the monthly post off with `/setup monthly-recap`. `/recap` keeps working.
