<img src="assets/logo.png" width="160" align="right" alt="Slopkeeper logo">

# Slopkeeper

Keeper of the slop. A Discord bot for friends servers that helps people get together, figure out what to play once they're there, and remember the night afterwards. One running bot can serve several servers, each with its own settings and data.

- **Getting together:** pings people who opted in when a voice channel fills up, with per-game pings for the games being played, and plans game nights people can RSVP to.
- **Picking a game:** knows everyone's Steam library and picks a multiplayer game that the people in voice all own.
- **Getting games:** posts when a game the group wants goes on sale, pinging whoever still needs it, and when a game is free to keep on Steam, Epic or GOG.
- **Remembering the night:** recaps each voice session, keeps a weekly leaderboard, tracks what everyone plays, per person and for the whole server, and posts a recap of each month.
- **Messing around:** a soundboard that layers different sounds like Discord's own and restarts a spammed one without a gap, with short clips mirrored into Discord's soundboard, and text to speech.

Everything happens through slash commands (type `/` in any channel, or run `/help`) and through automatic posts in each server's announce channel.

**Contents**

- [A typical night](#a-typical-night)
- [Getting started](#getting-started-for-everyone-in-the-server)
- [Getting together](#getting-together): [hop-on pings](#hop-on-pings) · [game pings](#game-pings) · [game nights](#game-nights)
- [Playing games](#playing-games): [Steam accounts](#steam-accounts) · [What do we play?](#what-do-we-play) · [Game library](#game-library) · [Sale alerts](#sale-alerts) · [Free games](#free-games)
- [Stats](#stats): [session recaps](#session-recaps) · [voice leaderboards](#voice-leaderboards) · [game stats](#game-stats) · [comparing two people](#comparing-two-people) · [monthly recap](#monthly-recap)
- [Soundboard](#soundboard): [playing sounds](#playing-sounds) · [managing sounds](#managing-sounds) · [text to speech](#text-to-speech) · [even volume](#even-volume) · [Discord's soundboard](#discords-soundboard)
- [Server settings](#server-settings): [settings and defaults](#settings-and-defaults)
- [Multiple servers](#multiple-servers)
- [Web UI](#web-ui)
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
7. Days later, Helldivers 2 goes 40% off. They've been playing it, so the bot posts the sale and pings Jordan, the only one who doesn't have it. The same week, it posts in #free-games that a game is free to keep on Epic.

## Getting started (for everyone in the server)

1. **`/steam link profile:<your Steam profile URL>`** so the picker knows your games. In Steam, set **Profile → Edit Profile → Privacy Settings → Game details** to **Public**; otherwise the bot can't see your library.
2. **`/pings`** to pick what you get pinged for: people hopping in voice, and each game you play (when people play it, or plan a game night for it). `/notify` turns just the hop-on pings on or off.
3. That's it. The rest works on its own or when someone runs a command. `/help` lists every command.

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

They can be added and removed on the web UI's Settings page too. That page only asks for its password, so anyone who has it can create and delete these roles without **Manage Roles**. They can't make a role with any permissions.

| Command | What it does |
| --- | --- |
| `/pings` | Opens a menu of the hop-on role and the server's game roles, with yours ticked. Tick or untick them to change your pings. Only you see it. |
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
- 15 minutes before the start, the bot posts in the same channel, with a link to the card, and pings everyone who's **In** or **Maybe**. Change or turn this off with `/setup gamenight-reminder`.
- At the start time, the Discord event goes live. It ends 3 hours later, or once its voice channel empties, whichever is later.
- **Cancel night** (host, or anyone with Manage Events) asks first, privately, then greys out the card, deletes the event and lets the people who were in know.

**Repeating nights:** add `repeat` to plan a night every week or every 2 weeks. The bot posts each new card, with its own Discord event and game role ping, 6 days before that night, so a weekly night's next card goes up the day after the last one. It stays at the same local time when the clocks change.

**Cancel night** only skips that night. To end the whole series, press **Stop repeating** on any of its cards (host, or anyone with Manage Events), and confirm.

| Command | What it does |
| --- | --- |
| `/gamenight plan game when [voice] [details] [repeat]` | Plans a game night. `when` takes things like `fri 8pm`, `tomorrow 20:30`, `next sat 9`, `nov 3 7:30pm` or `2026-11-03 19:00`, in the server's time zone (`/setup timezone`). A bare hour like `fri 9` means 9 PM. While you type, the suggestion shows exactly when it'll be, so you can check before sending. |
| `/gamenight list` | Upcoming game nights, with how many are in and a link to each card. Repeating ones show 🔁. |

Examples:
```
/gamenight plan game:Valheim when:fri 9pm voice:#gaming
/gamenight plan game:Jackbox when:sat 8 details:Bring snacks. Phones out.
/gamenight plan game:Deep Rock Galactic when:thu 9pm repeat:Every week
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
| `/steam list` | Shows everyone who's linked, with a profile link, game count and family. 🔒 means their game details are private. |
| `/steam family with [user]` | Says who shares a Steam library. `user` joins the family of `with`, and defaults to you. |
| `/steam unfamily [user]` | Takes someone out of their family. Defaults to you. |
| `/steam friends` | Run it while you're in voice. Lists anyone there who still needs to add each other on Steam. |
| `/steam lobbies` | Shows who's in a joinable Steam lobby right now, with a link to their profile. |
| `/steam refresh` | Re-reads every linked library now. Useful right after someone buys a game, or after fixing their privacy setting. |

All of this can also be done for anyone from **Steam accounts** on the web UI's Games page.

Every minute, the bot checks what linked members in voice are playing on Steam. If Discord shows no game for someone, that game counts for game time, session recaps and hop-on pings. If Discord shows one, Discord wins, so nothing counts twice. It needs public game details, and shows nothing for someone who's invisible on Steam. `/setup steam-status` turns it off.

`/steam friends` only needs one of two people to have a public friends list. If both are private, it says it can't tell. `/steam lobbies` only finds games that use Steam lobbies. Discord won't open `steam://` links, so it links to their profile, while the web UI links straight to the lobby.

Steam doesn't tell the bot who's in a Steam family, so you say. A family holds up to 6 people, and applies in every server, as links do. Someone in a family counts as owning a game if a family member owns it on Steam and Steam tags it for Family Sharing, even if that member isn't in the server. Each person playing at once needs their own copy, so two people in a family with one copy show as one short. The bot can't see whether an owner outside the group is using their copy. Games only marked by hand don't count, as there's no way to know if they're shareable.

### Patch notes

`/setup patch-notes` posts patch notes for games with a Steam ID that were played in the server in the last 30 days. **Each one** posts them as they're found, and **weekly digest** posts them together on the weekly leaderboard's day and hour, even if the leaderboard post is off. They go to the announce channel, or the channel you pick, and never ping anyone. It's off by default.

It starts from the latest notes, so turning it on doesn't post a backlog. Steam only marks a post as patch notes if the developer tags it, so some games will be missed.

### Achievements

| Command | What it does |
| --- | --- |
| `/achievements game [with]` | Shows Steam achievement progress for you and `with`, or else everyone in your voice channel, plus goals: what nobody there has yet, the most common first. |

Hidden achievements count towards the total, but aren't named as goals in case they're spoilers. Anyone with private game details, no Steam link or no copy of the game is left out, and it says so.

### What do we play?

| Command | What it does |
| --- | --- |
| `/whatdoweplay [type] [deck]` | Run it while you're in voice. It picks a random game that everyone in your channel can play. `type` keeps to co-op or PvP games, and `deck` to games that work on Steam Deck. Those come from Steam's store, so they leave out games with no Steam link, and Steam doesn't list a game's player limit. |
| `/gamevote [minutes]` | Run it while you're in voice. Everyone in your channel votes on the games they all own. It stays open for 1 minute by default, up to 10. |

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
- **🗳️ Vote** starts a 1-minute `/gamevote`. It's greyed out when only one game qualifies.
- **Never suggest this** hides a game from future picks, and tells whoever pressed it how to undo it: `/game unhide`, or the web UI's Games page.

**🎲 Reroll** keeps to the `type` and `deck` you chose. **🗳️ Vote** covers every game that qualifies.

How a vote works:
- The ballot has up to 10 games from the same list: the 5 you've played most, then a random mix of the rest.
- Everyone in the voice channel gets one vote and can change it until the vote closes. People outside the channel can't vote.
- It closes as soon as everyone in the channel has voted, or when time runs out. A tie is settled at random, and the result says so.
- Each voice channel can only have one vote open at a time.

### Game library

The library is the group's shared list of games it cares about. Add a game to the library when:
- you want **sale alerts** for it,
- it has a **player cap** the picker should respect,
- it **isn't on Steam**, so ownership has to be marked by hand, or
- Steam doesn't tag it as multiplayer but you still play it together.

| Command | What it does |
| --- | --- |
| `/game add name [steam] [max_players]` | Adds a game. `steam` takes the store URL or app ID and turns on sale alerts and automatic Steam ownership. `max_players` is the most people one lobby holds. |
| `/game want name` | Pings you when a game goes on sale. Takes a library game, a name or a Steam store link, and adds a new game to the library. Run it again to take it back. |
| `/game own name [user]` | Marks a game as owned by you, or by `user`, for non-Steam games and Family Sharing. Run it again to unmark it. It's not needed if Steam already shows the person owning the game. |
| `/game list` | Shows every library game, its player cap, who owns it and who still needs it, with ◀ ▶ buttons once it's too long for one page. |
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

Every `SALE_CHECK_HOURS` (default 6), the bot checks Steam prices for what this server cares about:

- **Played:** games played in voice here in the past 180 days, found by matching the name to a Steam title. Games not on Steam are skipped, and `/game add` with a Steam ID covers a game whose name doesn't match.
- **Wanted:** games someone asked for with `/game want`.
- **Steam wishlists:** games on a linked member's Steam wishlist, if their profile lets the bot see it. A server can turn these off.
- **Library:** games added with a Steam ID.

It posts once per check in the announce channel, or the channel from `/setup sale-alerts`, however many games are on sale. Up to 10 games are listed, most wanted first, and the rest are in `/sales`:

> 💸 **2 games on sale**
> **Deep Rock Galactic**: 60% off, $11.99, was $29.99. Lowest price yet. Played 14h · Needs it: @Sam, @Alex
> **Hades**: 50% off, $12.49, was $24.99. Lowest ever $6.24. Wanted by @Jo

A game is posted at 25% off or more by default, then again only if the same sale gets at least 10 points deeper. The lowest price comes from [CheapShark](https://www.cheapshark.com), covers all stores, is in US dollars, and so only appears for servers using the `us` region.

Only the people a sale matters to are pinged:

- Whoever wanted it, or has it on their wishlist, until they own it.
- For played and library games, everyone in the group who doesn't have it. A library game that was added by `/game want` only pings the people who wanted it.
- Not anyone who has played it in voice here, as they must have it somehow.
- Not anyone whose Steam library is private, unless they asked for the game, as nobody can tell what they own.

Games hidden with **Never suggest this** aren't watched for being played or wishlisted, only if someone asked for them. A game nobody needs isn't posted.

The "group" here is the server's members who have linked Steam or marked at least one game as owned. Prices use the server's Steam store region (`/setup steam-region`, default `us`).

| Command | What it does |
| --- | --- |
| `/sales` | Shows what this server plays or wants that was on sale at the last check, including sales too small to post. A long list stops at what fits in one message and says how many more there are. |

### Free games

Every 3 hours, the bot checks [GamerPower](https://www.gamerpower.com) for full games that are free to keep on Steam, Epic Games Store or GOG, and posts each new one once. Each post has the store link, what the game normally costs and when the offer ends. DLC, betas and in-game loot are left out.

It's **off by default**. A server admin turns it on with `/setup free-games enabled:True`, optionally with `channel:#free-games` to keep the posts out of the announce channel. Without a channel, they go to the announce channel. When it's first turned on, the bot posts whatever is free at that moment (up to 5), then only new ones.

| Command | What it does |
| --- | --- |
| `/freegames [all]` | Shows what's free to keep right now and passes this server's filters. `all` includes the ones they hide. |

Most giveaways are filler, so a game is only posted if it looks worth having. Each post says why it got through.

| Filter | Default | What it does |
| --- | --- | --- |
| Lowest Steam rating | 70% | Needs this share of positive Steam reviews, from at least 50 reviews. 0 turns it off. |
| Only games like what you play | on | Needs 2 tags in common with the 10 games this server played most in the past 6 months. It's skipped until 3 of those games are on Steam. Tags on nearly everything, like Singleplayer and Indie, don't count. |
| Only multiplayer games | off | Needs a multiplayer or co-op tag. |
| Games not on Steam | hidden | A game with no Steam page can't be rated, so it's hidden unless you show these. |

A game is also hidden if everyone here with a linked Steam account already owns it. Ratings and tags come from [SteamSpy](https://steamspy.com) and are kept for a month. A hidden game is looked at again at each check, so loosening a filter can still catch it while it's free. If the lookup fails, the game waits for the next check.

The web UI's Settings page lists what's free right now, with the reason each game is posted or hidden.

---

## Stats

### Session recaps

The bot tracks each voice channel as a session. It records who was there, for how long, and which games Discord showed them playing. A session ends once the channel has been empty for 5 minutes, so a quick disconnect doesn't split the night in two.

A session of at least 15 minutes is recorded, even with one person in it, so time alone counts towards voice stats. With 2 or more people, the bot also posts a recap with each person's time and the games played. Shorter sessions aren't recorded. Both times can be changed with `/setup sessions`, and `/setup sessions recaps:False` stops the recap posts while still recording sessions.

### Voice leaderboards

| Command | What it does |
| --- | --- |
| `/stats [period]` | Voice leaderboard for the past week (default), past month or all time. Shows the top 10 by time in voice, how many nights each person showed up, and the most-played games by game time, as `/gamestats` does. |

Every Sunday at 8 PM, in the server's time zone, the bot posts the past week's leaderboard to the announce channel. Change the day and hour with `/setup leaderboard`, or turn the post off with `/setup leaderboard enabled:false`. `/stats` still works when it's off.

### Game stats

The bot records how long each person plays each game while they're in a voice channel, from the "Playing" status Discord shows on their profile. They don't need anyone else there, but games played outside voice, or in the AFK channel, aren't recorded at all. It keeps the record per server. Anyone who doesn't want this can turn off **Settings → Activity Privacy → Share my activity** in Discord. Plays under a minute (launchers, crashes) aren't kept.

A game's time is how long anyone was playing it, so two people playing for the same hour add one hour to the game and one hour each to themselves. That's why the players of a game can add up to more than the game itself. If the same game is running in two voice channels at once, it still only counts once.

Different spellings of a game count as one. Discord can report a game several ways, so spellings that only differ by case, spaces or punctuation match by themselves: `slaythespire2` joins "Slay the Spire 2". So does a Roman numeral from II to IX in capitals at the end of a name: "Slay the Spire II" joins too. For anything else, like "StS 2", use **Merge games** on the web UI's Stats page. Merges apply to past stats, ping roles and new plays. Nothing stored is changed, so **Separate** puts a spelling back at any time.

Game time from before this rule is an estimate: the bot kept what fell inside saved voice sessions, up to each person's time in that session.

| Command | What it does |
| --- | --- |
| `/gamestats` | The whole server: how long games were played, the 10 most played with how many people play them, and the 10 people who play the most. |
| `/gamestats user` | One person: their total and their top games, with when they last played each. |
| `/gamestats game` | One game: how long it was played, and how long each person played it. The name autocompletes from what's been played. |
| `/gamestats user game` | One person and one game: their hours, number of sessions, and where they rank among the server's players. |

Every form takes `period`: past week, past month (default), past year or all time.

Examples:
```
/gamestats
/gamestats user:@Sam period:All time
/gamestats game:Valheim
/gamestats user:@Alex game:Lethal Company
```

### Comparing two people

| Command | What it does |
| --- | --- |
| `/compare user [with]` | Compares someone with you, or with whoever you pick in `with`. |

It shows, over all time:
- how long the two played the same game in the same voice channel, and which games most;
- how many voice sessions they shared. The time shown is a maximum, because the bot keeps each person's total for a session, not when each of them was there;
- each person's total game time;
- games they both own: anything in the library, plus Steam games tagged multiplayer.

### Monthly recap

On the 1st of each month, the bot posts last month's highlights to the announce channel, at the same hour as the weekly leaderboard. If it was down then, it posts when it's back. Months with nothing to report are skipped, and a server's first recap comes after its first full month.

The recap covers total game and voice time, the top games, biggest gamers, most time in voice, the longest session, top sounds and who played the most of them, and game nights held. Months follow the server's time zone.

Top sounds only counts sounds played through the bot, with its panels or `/sound play`. Discord doesn't tell bots about sounds played from its own soundboard.

| Command | What it does |
| --- | --- |
| `/recap [month]` | Shows last month's recap, or this month's so far. |

Turn the monthly post off with `/setup monthly-recap`. `/recap` keeps working.

---

## Soundboard

The bot holds a library of uploaded sounds and plays them in your voice channel. Different sounds layer like Discord's own soundboard: clicking one while another is playing mixes it in instead of cutting the other off. Clicking a sound that's already playing restarts it from the top, with no gap, so spamming one button rapid-fires it instead of stacking copies. Up to 12 sounds play at once; past that, the oldest is dropped. The bot leaves voice after 5 minutes of silence, or as soon as everyone else has left.

### Playing sounds

| Command | What it does |
| --- | --- |
| `/sound panel` | Posts a button grid in the current channel: 20 sounds per page, ◀ ▶ to flip pages, ⏹ **Stop** to silence every sound and line of speech (the music carries on). The bot keeps every panel it posts up to date as sounds change, so post one in a handy channel and pin it. |
| `/sound play name` | Plays one sound in your voice channel. The name autocompletes. |
| `/sound stop` | Stops everything and makes the bot leave voice. The reply is in the channel, so people can see who stopped it. |
| `/sound join [name]` | Picks a sound that plays when you join voice. Leave `name` empty to stop having one. |

You have to be in a voice channel to play a sound. The bot joins whichever channel you're in.

**⚙️ Settings** on a panel changes sounds without leaving Discord. Everything it opens is only visible to you. Pick a sound from the panel's current page to change its volume, test it, put it on or take it off Discord's soundboard, set its emoji, rename it or delete it. People with **Manage Server** also get switches for even volume and join sounds. Trimming, picking part of a long sound and uploading are on the web UI, or in the commands below.

**Join sounds** are opt-in: nothing plays until someone picks one with `/sound join`, or it's set for them on the web UI's Settings page. When you connect to voice the bot joins straight away, then waits half a second before playing, so the sound clears Discord's joining noises. Nothing plays if you leave during that wait. It doesn't play when you switch channels, or again until the cooldown is up (10 minutes unless `/setup sounds` says otherwise). If the bot is already in a different channel, it stays there rather than leaving the people using it. They don't count towards the monthly recap's top sounds.

### Managing sounds

| Command | What it does |
| --- | --- |
| `/sound add name file [emoji]` | Uploads a sound. Names use lowercase letters, numbers, `-` and `_` (up to 32 characters). The file can be mp3, ogg, wav, m4a, opus, webm or flac, up to 5 MB, and the bot turns it down if it can't find audio in it. Using an existing name asks first: **Replace it** (the old sound goes to Recently deleted and the emoji stays unless you give a new one), **Keep both** (the new one gets the next free name, like `airhorn-2`) or **Cancel**. The question lasts 5 minutes. |
| `/sound emoji name [emoji]` | Sets the emoji on a sound's button. Leave `emoji` empty to clear it. Custom emoji have to be from this server. |
| `/sound remove name` | Deletes a sound from the bot, and from Discord's soundboard if it's there. It stays in a bin for 30 days. |
| `/sound restore name` | Brings back a sound from the bin with its emoji, volume, star and untrimmed original. If the name's been taken, it comes back numbered, like `horn-2`. It isn't put back on Discord's soundboard, and anyone who had it as a join sound has to pick it again. |
| `/sound volume name percent` | Sets how loud one sound plays, from 25 to 200, where 100 is normal. |

The [management API](#management-api) can also trim a sound. The bot keeps the first version, so it can be restored until the sound is replaced. A copy on Discord's soundboard stays as it is until it's added again.

Examples:
```
/sound add name:airhorn file:<airhorn.mp3> emoji:📯
/sound emoji name:bruh emoji:💀
/sound remove name:old-meme
```

The web UI's Sounds tab also shows everything on Discord's soundboard, including sounds people added there themselves. You can play or preview any of them, save them to the library, and swap one for a library sound. Nothing is lost: a sound that comes off and isn't in the library is saved there first.

### Text to speech

`/say text [voice]` has the bot read something out in your voice channel, joining it first if it has to. There's a **Say something** box on the web UI's Soundboard tab too. **Save** there keeps a line as a one-click button, up to 25 per server, and `/say saved:` picks one in Discord. A saved line is said in the voice picked next to the box, or in Discord in `voice` or else the server's default voice. Saved lines follow the same rules as typed ones.

- Lines wait their turn, while sounds still layer on top. **Stop** ends the line and clears anything waiting.
- Mentions are read as names, custom emoji as their name, and links as "link".
- Every line goes in the Activity tab with who said it.
- The voices are **Voice 1**, **2**, **5** and **9**, plus characters: **GLaDOS**, **HAL 9000**, **Bender**, **Optimus Prime**, **Kronk** and **TikTok** (the TikTok text-to-speech lady). Each talks at the server's speed. A server whose default voice has been removed talks in the bot's default voice.
- `/setup speech` sets whether it's on, the default voice, how fast and how loud it talks, the longest line and how long each person waits between lines. `/setup speech-role` limits it to a role, plus people with **Manage Server**. The web UI isn't limited by the role, and counts as one person for the wait.

It needs the [voice container](#the-voice-container).

**Greetings:** with `greet` on in `/setup speech`, the bot says who joined voice, using the **Greeting** setting with `{name}` for the person. Someone with a join sound hears that instead. Greetings follow the join sound rules: the same cooldown and delay, nothing for moving channels, bots or the AFK channel, and the bot won't leave another channel for one.

**Announcements:** `night_reminders` says game night reminders in the night's voice channel when they're posted, and `hop_on` says hop-on pings in the channel they're about. Both only play where people are, and won't pull the bot away from another channel. What gets posted doesn't change.

**Reading a channel aloud:** `/setup speech-channel` or Settings picks a text channel, and the bot reads out what people type there, starting with who said it. It plays in the writer's voice channel, or else the one the bot is in, or else the busiest one, and reads nothing if nobody's in voice. `who` limits it to people in voice.

It skips bots, images, links with no words and anything over the longest line, and leaves out spoilers and code blocks. There's no wait between messages, but if 5 lines are already waiting, new ones are skipped so it can't fall behind. The role limit applies, and these lines aren't logged in Activity.

### Who can change sounds

Everyone can, until a role is set with `/setup sound-managers`. Then only people with that role or **Manage Server** can use `/sound add`, `emoji`, `remove`, `restore`, `volume`, `discord-add`, `discord-remove` and `discord-sync`, or the changes under a panel's **⚙️ Settings**. Everyone else can still play and test sounds, stop playback, post a panel and set their own join sound. If the role is deleted, only people with **Manage Server** can change sounds until a new one is set.

The web UI isn't limited by the role, because it doesn't know who's using it. Anyone with its password can change everything.

### Even volume

Every sound is measured when it's added, so a whisper and an air horn play about as loud as each other. Your file isn't changed: the bot stores how much to turn each sound up or down and applies that as it plays, so turning it off with `/setup sounds` puts everything back. A quiet sound with one loud spike only comes up until the spike would clip, and no sound is boosted by more than 12 dB, so very quiet sounds can still need `/sound volume`.

Sounds from before this existed are measured when the bot starts. Copies on Discord's soundboard are levelled using Discord's own volume for each sound, which can only go up to 1, so a sound that needs a big boost stays quieter there than on the bot.

### Soundboard volume

**Soundboard volume** turns every sound up or down at once, including join sounds and the looping sound, and changes sounds that are already playing. It's the slider next to **Play in** on the web UI, in Settings, and `volume` in `/setup sounds`. Speech has its own volume.

The web UI's volume sliders, for the soundboard, music and each sound, follow loudness rather than the percentage, so moving one sounds about as big a change anywhere along it, and 100% sits at the tick about 70% of the way along. The box beside each takes an exact percentage.

### Looping sound room

Pick a voice channel and a sound with `/setup loop-room` or in Settings, and the bot plays that sound over and over, without a gap, while anyone's in the channel. It leaves when the last person does. It's off until the channel and a sound or speech are set. `/setup loop-room` with no options shows how it's set, and `off:True` turns it off.

Discord lets a bot be in one voice channel per server, so the room shares the bot with everything else, and the points about Stop and giving way below are about that. With the [loop bot](#the-loop-bot) set up, a second bot plays the room instead: both play at once, the room never gives way, and the soundboard's **Stop** leaves the room alone. Settings shows the loop bot's state at the top of the room's settings.

- Other sounds, join sounds and speech play on top. Playing the looping sound by hand plays a second copy.
- **Stop** silences it until someone else joins the room.
- The room gives way: if the bot is busy in another channel with people in it, the room waits until that channel empties or the bot has been idle for 5 minutes. Playing something in another channel takes the bot there, and the loop comes back the same way.
- **Loop volume** is the sound's and **Looping speech volume** the speech's, and both start at half, as they never stop. Renaming the sound keeps it, and removing it turns the loop off.
- **Looping speech** says some words over and over too, up to 500 characters, in a **Looping speech voice** of its own (the default voice until one's picked) at the speech speed. It plays alongside the sound, or alone with no sound set. **Speech every** spaces it out the way Loop every does for the sound. The voice container makes the speech once and the bot reuses it, so Settings warns straight away if it can't be made.
- **Join sounds and greetings** don't play in the room, as they'd only talk over it.
- **Intro sound** plays once before the loop starts, at its own level and the soundboard volume, **Intro delay** after someone comes in (250 ms by default). The loop starts when it ends. Someone else coming in stops the loop and starts again from the intro. **Sound delay after intro** and **Speech delay after intro** hold each back that long after the intro ends, or after the loop starts with no intro, so one can come in after the other. Changing a loop setting doesn't replay the intro or the delays. Renaming its sound keeps it, and removing the sound turns the intro off.
- **Loop every** layers it instead: a fresh copy starts that many seconds after the last, like 0.5 or 1, on top of the copies still playing. Up to 8 play at once, and the oldest fades out as the next starts. A sound shorter than the gap plays, goes quiet, then plays again. At 0, the default, it loops without a gap.

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

## Music

The bot plays music in voice, from a queue everyone shares. Songs are found on Spotify, and played from YouTube Music, YouTube or SoundCloud, so the Spotify account isn't used to play anything. It needs a Spotify app for search and the [music container](#the-music-container).

- `/music play [song] [next] [shuffle]` adds a song, album or playlist by search or Spotify link, or a song by YouTube or SoundCloud link, and starts the music in your voice channel. `next` puts it after the song playing instead of at the end, and `shuffle` adds 100 of an album's or playlist's songs at random instead of the first 100. With no song, it carries on where it paused. Any public Spotify playlist link works. Its suggestions list the Spotify account's matching playlists first, when it's signed in.
- `/music pause`, `/music skip` and `/music stop` are said in the channel, so everyone can see who did it. **Stop** clears the queue too.
- `/music queue` shows what's playing and the next 10 songs.
- `/music shuffle` puts the songs waiting in a random order, leaving the one playing alone. It's said in the channel too.
- The web UI's **Music** tab has the same, plus search results to pick from, a progress bar you can click or drag to jump within the song (or move 10 seconds with the arrow keys), a volume slider, and **Shuffle** on **Up next**. Its **My playlists** switch lists the account's playlists to add, in order or shuffled. **Play a file** plays an audio file once in the chosen channel, up to 60 MB and 20 minutes, pausing the music meanwhile. Its progress bar jumps within it the same way. It isn't kept: it's deleted once it ends or is stopped, and pressing Resume stops it. Drag songs to reorder them, or use the arrows on a phone.

How it plays:

- **Queue:** the bot keeps its own queue for each server, kept across restarts, up to 500 songs. An album or playlist adds up to its first 100 songs, or 100 at random from up to its first 1,000 when shuffled. When the queue runs out the music stops, with no suggested songs. A restart or redeploy carries the music on from the same second, in the same channel, once the bot and the music player are back (usually 10–20 seconds), as long as someone is still in that channel and it was less than 10 minutes. Paused music stays paused at its place.
- **Finding songs:** each Spotify song is matched by name and length, trying YouTube Music's official audio first, then YouTube, then SoundCloud. Live versions, covers and remixes are passed over unless that's what the Spotify song is. The first two songs in the queue are fetched as soon as they're queued, and each next one while a song plays, so they start without a wait. A song none of them has is skipped, and the Music tab says so.
- **Several servers** can play at once, each with its own queue.
- **Playlists:** a link to any public playlist (yours, someone else's, or Spotify's own, like Today's Top Hits) adds its first 100 songs, or those 100 in random order when shuffled. They're read from Spotify's public embed player, which needs no sign-in but lists no more than 100 songs and no album covers. The covers fill in a few seconds later, the next songs first, from Spotify's public oEmbed (also no sign-in). Private playlists can't be read. If the Spotify account has [signed in](#the-music-container), playlists it made or collaborates on are read through it instead, which reaches the whole playlist and shows covers.
- **Sounds and speech** play on top. Music drops to under a third while the bot talks.
- **Everyone leaving** pauses the music and keeps the queue. **Stop** on the soundboard panel and the web UI's red Stop leave the music playing. Music counts as the bot being busy, so it doesn't leave for being idle and the looping room waits.
- **Who can control it:** everyone, until `/setup music dj_role:` sets a role. Then only that role and people with **Manage Server** can add, pause, skip, shuffle and stop. Anyone can see the queue. The web UI isn't limited by the role.
- **Activity** shows what was added, removed and skipped, and by whom.

## Server settings

Server admins (anyone with **Manage Server**) set the bot up for their server from Discord with `/setup`. Nobody else sees it. To let other roles use it, go to **Server Settings → Integrations → Slopkeeper**.

Every setting has a sensible default, so only the announce channel needs setting. Replies to `/setup` are only shown to you.

| Command | What it does |
| --- | --- |
| `/setup show` | Lists every setting, its current value and where it comes from: **set here** (with `/setup`), **host default** (the host's `.env`) or **default**. |
| `/setup announce-channel channel` | Sets where hop-on pings, session recaps, the weekly leaderboard, the monthly recap and sale alerts are posted, and free games unless they have their own channel. Until it's set, the bot works but posts nothing. It checks that it can post in the channel and tells you which permission is missing if not. |
| `/setup hopon-role [role]` | Sets the role that hop-on pings ping, which `/notify` hands out. Leave `role` empty to post hop-on pings without pinging that role. It warns you if its own role is below this one, since Discord then won't let it hand the role out. |
| `/setup hopon [min_people] [cooldown_minutes]` | How many people a voice channel needs before a hop-on ping, and how long to wait before the next one. |
| `/setup sessions [recaps] [recap_min_minutes] [grace_minutes]` | Whether a recap is posted when a session ends (sessions count in stats either way). The shortest session that counts: shorter ones get no recap and aren't in stats or leaderboards. Also how long a channel stays empty before its session ends. |
| `/setup leaderboard [enabled] [day] [hour]` | Whether and when the weekly voice leaderboard is posted. |
| `/setup timezone zone` | The server's time zone, used for the weekly post, counting "nights" on leaderboards, and reading game night times. Autocompletes, e.g. `America/Chicago`, `Europe/London`. |
| `/setup steam-region country` | Steam store region for sale prices, as a two-letter country code. |
| `/setup free-game-filters [min_rating] [like_what_we_play] [multiplayer_only] [not_on_steam]` | Chooses which free games are worth posting. See [Free games](#free-games). |
| `/setup sale-alerts [min_discount] [steam_wishlists] [channel]` | Sets the smallest sale worth posting, whether Steam wishlists count, and a channel of their own. See [Sale alerts](#sale-alerts). |
| `/setup free-games enabled [channel]` | Turns free game posts on or off. `channel` gives them their own channel; without it they go to the announce channel. To move them back to the announce channel, use `/setup reset setting:Free games channel`. |
| `/setup gamenight-reminder minutes` | How long before a game night to remind the people who are in. `0` turns reminders off. |
| `/setup monthly-recap enabled` | Turns the post on the 1st of each month on or off. |
| `/setup patch-notes [mode] [channel]` | Posts patch notes for games played here: `each` as they come out, `digest` once a week, or `off`. `channel` gives them their own channel. |
| `/setup steam-status enabled` | Whether what linked members in voice are playing on Steam counts when Discord doesn't show it. |
| `/setup sounds [even_volume] [join_sounds] [join_cooldown_minutes] [join_delay_ms] [volume]` | Turns [even volume](#even-volume) and join sounds on or off, and sets how often one person's join sound can play and how long the bot waits after connecting before it plays. `volume` sets how loud every sound plays. |
| `/setup loop-room [channel] [off] [sound] [volume] …` | Plays a sound, and speech if you like, nonstop while anyone's in a voice channel. `off:True` turns it off and keeps the rest of its settings. See [looping sound room](#looping-sound-room). |
| `/setup music [volume] [dj_role] [everyone]` | How loud music plays, and who can control it. `everyone:True` takes the role limit off. See [Music](#music). |
| `/setup sound-managers [role]` | Limits changing sounds to a role, plus people with **Manage Server**. Leave `role` empty to let everyone change them, which is the default. See [who can change sounds](#who-can-change-sounds). |
| `/setup speech [enabled] [voice] [speed] [volume] …` | Text to speech: on or off, the default voice and speed, the limits on `/say`, and what the bot says aloud by itself. See [Text to speech](#text-to-speech). |
| `/setup speech-role [role]` | Limits `/say` and having messages read out to a role, plus people with **Manage Server**. Leave `role` empty to let everyone. |
| `/setup speech-channel [channel] [off] [who]` | Reads out what people type in a channel. `off:True` stops it. |
| `/setup reset setting` | Puts one setting back to its default. |

For the commands with several options, only the options you fill in change. Give none and the reply shows how those settings are now.

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

Each setting goes by the name `/setup show` and `/setup reset` use.

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
| Steam wishlists in sale alerts | `sale-alerts` | `SALE_STEAM_WISHLISTS` (`false` to turn off) | on |
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
| Looping speech voice | `loop-room` | | the default voice |
| Speech every | `loop-room` | `LOOP_TEXT_EVERY` | 0 seconds, saying it again straight away |
| Intro sound | `loop-room` | | off |
| Intro delay | `loop-room` | `LOOP_INTRO_DELAY_MS` | 250 ms |
| Looping speech volume | `loop-room` | `LOOP_TEXT_VOLUME` | 50% |
| Sound delay after intro | `loop-room` | `LOOP_SOUND_DELAY_MS` | 0 ms |
| Speech delay after intro | `loop-room` | `LOOP_TEXT_DELAY_MS` | 0 ms |
| Music volume | `music` | `MUSIC_VOLUME` | 40% |
| Who can control music | `music` | | everyone |
| Text to speech | `speech` | `TTS` (`false` to turn off) | on |
| Default voice | `speech` | `TTS_VOICE` (`1`, `2`, `5`, `9`, `glados`, `hal`, `bender`, `optimus`, `kronk` or `tiktok`) | 5 |
| Speech speed | `speech` | `TTS_SPEED` | 85% of the voice's natural speed |
| Speech volume | `speech` | `TTS_VOLUME` | 100%, about as loud as a sound with even volume on |
| Longest spoken line | `speech` | `TTS_MAX_CHARS` | 200 characters |
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

**Choosing which servers can use it:** with `ALLOWED_GUILD_IDS` set, the bot leaves any server that isn't on the list as soon as it's added. Without it, anyone with the invite link can add the bot. Set it if the bot is public (see [Setup](#setup)).

## Web UI

A page in [`web/`](web) that runs as a second container next to the bot, for your home network or behind a sign-in proxy like [Pangolin](#signing-in-through-pangolin):

- **Stop sounds:** the red button in the bottom corner of every page silences every sound and line of speech. The music carries on: it has its own controls on the Music tab, and while it plays the toast after Stop offers **Pause music**.
- **Undo:** removing a song from the queue, deleting a sound or a saved phrase, taking a sound off Discord, **Never suggest this** and a setting's **Reset** each show a toast with **Undo** for 8 seconds, longer while the pointer or focus is on it.
- **Soundboard:** big buttons that play in voice, with favourites first and then whatever gets played most, and a box for having the bot say something.
- **Music:** what's playing, Spotify search, and the queue to add to, reorder and clear. See [Music](#music).
- **Sounds:** upload files or whole folders, preview, rename and delete sounds, set a sound's volume, trim it with a way back to the original, and choose what's on Discord's soundboard, with a waveform for picking part of a long sound. A file named like an existing sound waits until you choose **Replace it** or **Keep both**. **Recently deleted** restores a deleted or replaced sound, or erases it for good.
- **Game nights:** plan a night, see what's coming up and who still needs to add each other on Steam, cancel one or stop a repeating one.
- **Games:** the game library, with who has each game, who needs it, who wants it and any sale. Add games from a searchable list of what members own on Steam, or by name or store link. **Steam accounts** links, changes and unlinks anyone's Steam account, says who shares a Steam family, and refreshes libraries. Remove games, set player limits and Steam links, tick who owns or wants what, and hide a game from `/whatdoweplay` or let it back in. Ownership from a Steam library is locked.
- **Pick a game:** choose a voice channel, or tick people to plan before anyone's in voice, and see the games everyone owns and those one purchase away, using the same rules as `/whatdoweplay`. Each game shows time played here, Steam hours, its last two weeks on Steam and when it was last played, in total and per person, plus who'd play on a family copy. Opening one shows how many are playing it on Steam right now and its latest patch, and **Achievements** compares everyone's progress with goals nobody has yet. Sort them, with **Hot right now** for the last two weeks, search them, or filter to co-op, PvP or Steam Deck. **Pick for us** chooses one at random, and **Start a vote** posts the usual `/gamevote` card in a channel. Both go by the search and filters, so a vote offers only the games shown. Anyone in a joinable Steam lobby shows at the top with a link to join.
- **Stats:** **Overview** has game and voice time, overall or for one person or game, with sessions, rank and when it was last played. **Compare** is `/compare` with every game two people both own and their achievements in any of them, and **Monthly recap** is `/recap`.
- **Discord's soundboard:** on Sounds, see what fills the slots, play or save any sound, and swap sounds between Discord and the library.
- **Merging games:** on Stats, Merge games puts different spellings of a game together, and Separate on a clicked game takes one back out.
- **Activity:** a history of changes to sounds, games, pings, Steam accounts, music, settings and game nights, made here or in Discord, and who made them.
- **Settings:** everything in `/setup`, for each server, game ping roles, everyone's join sounds, which free games are being posted or hidden and why, and what's on sale now. **Who gets pinged** changes anyone's hop-on and game pings, as `/notify` and `/pings` do.
- **Posting to Discord:** **Post panel** on Soundboard is `/sound panel`, and **Post Choose games button** on Settings is `/gamerole menu`.

Anything that shows information stays on the page. Only a vote, a panel and the Choose games button post to Discord. Anyone with the password can change anyone's pings, as with Steam accounts.

It holds no data of its own. The bot does everything through its [management API](#management-api), so the rules are the same as for the slash commands, and a change here updates the bot's posted soundboard panels too.

```
browser → web UI (password, session cookie) → bot API (token) → database and sounds
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_PASSWORD` | required | The password for the page. Changing it logs everyone out |
| `API_TOKEN` | required | Same value as the bot's `API_TOKEN`. It turns the bot's API on, and never reaches the browser |
| `BOT_URL` | `http://slopkeeper:8787` | Where the bot's API is |
| `PROXY_SECRET` | off | Turns on [signing in through Pangolin](#signing-in-through-pangolin) |
| `PORT` | 8080 | Port inside the container |

Build the image from `web/Dockerfile`. It serves plain HTTP, so keep it on your home network or put it behind a proxy that adds HTTPS.

### Signing in through Pangolin

Behind [Pangolin](https://github.com/fosrl/pangolin) with SSO, the page knows who's using it. Pangolin adds `Remote-Email` and `Remote-Name` headers after someone signs in, and the page trusts them only when the request also carries `PROXY_SECRET` in an `x-slopkeeper-proxy-secret` header, so nobody can send them straight to the port. To set it up, set `PROXY_SECRET` to a long random value (`openssl rand -hex 32`) and add it to the resource in Pangolin as a custom request header. Keep the resource SSO-only: a PIN, password or share link forwards no identity.

The password is still asked for. Once someone is signed in:

- Their name shows in the header, and their changes show under it in **Activity**. Changes from anywhere that skips Pangolin still show as **Web UI**.
- Clicking their name lets them say which Discord member they are. Their changes then show under that name, and planning a night, **Who gets pinged**, join sounds and **Compare** start on them. One sign-in per Discord member, and linking is recorded in **Activity**.
- Wrong passwords lock out only them for a minute, not everyone.

There are no runtime dependencies. In `web/`, `npm test` runs the tests with Node 24, and `npm run typecheck` needs `npm ci` first.

- `src/server.ts`: login, sessions and passing requests to the bot.
- `public/`: the page, plain JavaScript with no build step. `app.js` is the frame, and each tab has its own file.

## Configuration

Set in `.env` (see `.env.example`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | required | Bot token |
| `STEAM_API_KEY` | none | Needed for `/steam` and the picker's Steam data |
| `ALLOWED_GUILD_IDS` | any server | Comma-separated server IDs allowed to use the bot; it leaves any other server |
| `SALE_CHECK_HOURS` | 6 | How often Steam prices are checked, for every server at once |
| `TZ` | UTC | The container's time zone, and every server's default time zone |
| `API_TOKEN` | off | Turns on the [management API](#management-api) and is the token that unlocks it |
| `API_PORT` | 8787 | Port for the management API |
| `VOICE_URL` | off | Where the [voice container](#the-voice-container) is. Unset turns `/say` off |
| `MUSIC_URL` | off | Where the [music container](#the-music-container) is. Unset turns music off |
| `LOOP_BOT_URL` | off | Where the [loop bot](#the-loop-bot) is. Unset plays the looping room on this bot |
| `LOOP_TOKEN` | none | Same value as the loop bot's `LOOP_TOKEN` |
| `MUSIC_TOKEN` | none | Same value as the music container's `MUSIC_TOKEN` |
| `MUSIC_AUDIO_DIR` | `/music/audio` | Where the bot reads the songs the music container downloads, from its volume |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | none | A Spotify app's, for search and links. See [the music container](#the-music-container) |
| `SPOTIFY_REFRESH_TOKEN` | none | From the Spotify account signing in once, so the bot can read its own playlists. See [the music container](#the-music-container) |
| `SPOTIFY_MARKET` | `US` | The country whose Spotify catalogue search uses |

Everything else is a per-server setting. Servers set their own with `/setup`; the variables in [Settings and defaults](#settings-and-defaults) change the default for servers that haven't. For example, `HOPON_MIN_PEOPLE=3` makes every server wait for 3 people unless it ran `/setup hopon`.

### Management API

With `API_TOKEN` set, the bot serves an HTTP API for managing sounds and settings, for the [web UI](#web-ui) to use. It's off by default, and the bot works the same without it.

It applies the same rules as `/sound` and `/setup`, and every request needs an `Authorization: Bearer <token>` header. The web UI adds `x-slopkeeper-email` and `x-slopkeeper-name`, URL-encoded, for someone signed in through Pangolin, and changes are credited to them. It has no other login, so keep it on the container network: don't publish the port or put it behind a proxy.

| Request | What it does |
| --- | --- |
| `GET /guilds` | Lists servers |
| `GET /guilds/:id/sounds` | Lists sounds, Discord slots and the server's emoji |
| `PUT /guilds/:id/sounds/:name?file=<filename>` | Adds a sound; the body is the file. A taken name gets 409 unless `&replace=1`, which moves the old sound to Recently deleted, or `&keep=1`, which adds it under the next free name. The reply gives the name it's under. `&discord=0` keeps a new sound off Discord's soundboard |
| `PATCH /guilds/:id/sounds/:name` | Renames it, sets its emoji, volume or star: `{ "name": "..." }`, `{ "emoji": "..." }`, `{ "volume": 50 }`, `{ "favourite": true }` |
| `DELETE /guilds/:id/sounds/:name` | Moves it to the bin for 30 days. Returns `binId`, its id in the bin |
| `GET /guilds/:id/sounds/:name/audio` | Downloads its audio |
| `POST /guilds/:id/sounds/:name/play` | Plays it in a voice channel with people in it: `{ "channelId": "..." }` |
| `GET /guilds/:id/deleted-sounds` | Lists what's in the bin, newest first |
| `POST /guilds/:id/deleted-sounds/:deleted/restore` | Brings it back, and says what it's called now |
| `DELETE /guilds/:id/deleted-sounds/:deleted` | Erases it for good |
| `GET /guilds/:id/game-names` | Every game with what else it's been called |
| `POST /guilds/:id/game-names/merge` | Merges games: `{ "names": ["A", "B"], "into": "A" }` |
| `POST /guilds/:id/game-names/separate` | Puts a spelling back as its own game: `{ "name": "B" }` |
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
| `GET /guilds/:id/games` | Lists the game library with owners, who needs each game, who wants it and any sale, plus the server's members |
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
| `POST /guilds/:id/stop` | Stops every sound and any spoken lines waiting, leaving the music playing. Returns `musicPlaying` |
| `GET /guilds/:id/say` | Whether text to speech is `on`, the `voices`, the default `voice`, the `longest` line and the saved `phrases` |
| `POST /guilds/:id/say` | Reads out `text` in `channelId`, with an optional `voice`. Answers once the line starts |
| `POST /guilds/:id/phrases` | Saves `text`, and answers with the `phrases` |
| `DELETE /guilds/:id/phrases/:id` | Removes a saved line, and answers with the `phrases` |
| `GET /guilds/:id/music` | What's playing, how far in, the queue, the music volume and why music can't play, if it can't |
| `GET /guilds/:id/music/search?q=<words>` | Up to 10 songs from Spotify |
| `POST /guilds/:id/music/queue` | Adds a search result `{ "track": {...} }` or what's typed `{ "query": "<words or link>" }`, at the end or `"next": true` |
| `POST /guilds/:id/music/queue/:song/move` | Moves a song: `{ "to": 2 }`, counting from 0. The song playing stays first |
| `DELETE /guilds/:id/music/queue/:song` | Takes a song out, skipping it if it's playing |
| `DELETE /guilds/:id/music/queue` | Empties the queue, apart from the song playing |
| `POST /guilds/:id/music/play` | Starts or carries on in a voice channel: `{ "channelId": "..." }` |
| `POST /guilds/:id/music/pause`, `skip` and `stop` | As `/music` does. Stop clears the queue |
| `GET /guilds/:id/game-nights` | Lists upcoming game nights and repeating series, and what a new night can be set to |
| `POST /guilds/:id/game-nights` | Plans a night as `/gamenight plan` does: `{ "game", "when", "channelId", "hostId", "voiceChannelId", "details", "repeat" }`, where `repeat` is 7, 14 or null |
| `GET /guilds/:id/game-nights/:night/friends` | Who's going but isn't Steam friends yet, with profile links: `strangers`, `unknown` where both lists are private, and `unlinked` |
| `GET /guilds/:id/game-nights/when?text=<time>` | Says how a typed time reads, without planning anything |
| `POST /guilds/:id/game-nights/:night/cancel` | Cancels a night, as its Cancel button does |
| `DELETE /guilds/:id/game-night-series/:series` | Stops a series; nights already posted stay on |
| `GET /guilds/:id/join-sounds` | Lists who has a join sound |
| `PUT /guilds/:id/join-sounds/:user` | Sets someone's join sound: `{ "name": "airhorn" }`. `warning` is set if join sounds are turned off |
| `DELETE /guilds/:id/join-sounds/:user` | Removes someone's join sound |
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
| `GET /guilds/:id/pick/options` | Lists the members, voice channels and text channels to choose from |
| `POST /guilds/:id/votes` | Starts a vote: `{ "voiceChannelId", "channelId", "minutes", "games" }`, with 1 to 10 minutes. `games`, a list of names, narrows it to those games |
| `GET /guilds/:id/compare?a=<id>&b=<id>` | Compares two people, as `/compare` does |
| `GET /guilds/:id/recap?month=<last\|this>` | A month's highlights, as `/recap` shows them |
| `GET /guilds/:id/members/:user/pings` | Lists the hop-on and game ping roles, and which someone has |
| `PUT /guilds/:id/members/:user/pings` | Turns one on or off: `{ "roleId": "...", "on": true }`. Other roles can't be changed |
| `POST /guilds/:id/sound-panels` | Posts a soundboard panel: `{ "channelId": "..." }` |
| `POST /guilds/:id/game-pings/menu` | Posts the Choose games button: `{ "channelId": "..." }` |
| `GET /guilds/:id/activity?before=<id>` | The last year of changes to sounds, settings and game nights, 50 at a time, newest first |
| `GET /guilds/:id/me` | Who's signed in through Pangolin, and which member they said they are |
| `PUT /guilds/:id/me` | Says which member the signed-in person is: `{ "userId": "..." }` |
| `DELETE /guilds/:id/me` | Unlinks them |
| `GET /guilds/:id/stats?period=<week\|month\|year\|all>&user=<id>&game=<name>` | Game and voice totals, with game time over the period, plus sessions, rank and when it was last played where a person or game is chosen |
| `GET /guilds/:id/settings` | Lists settings, channels, roles and time zones |
| `PUT /guilds/:id/settings/:key` | Changes a setting: `{ "value": ... }` |
| `DELETE /guilds/:id/settings/:key` | Puts a setting back to its default |

## Setup

Setting up involves two people, who can be the same person:

- **The host** runs the bot. They own the Discord application, keep its token and Steam key, and run the container.
- **The server admin** adds the bot to their server and runs `/setup` there.

The two parts can happen in either order. The bot sets up any server it's added to, whether it's already running or not.

### The voice container

Text to speech runs [Piper](https://github.com/OHF-Voice/piper1-gpl) in a third container, built from [`voice/`](voice). It stays on the host, so nothing typed leaves your network.

```yaml
voice:
  image: ghcr.io/chuck-amuck/slopkeeper-voice:latest
  restart: unless-stopped
  init: true
  deploy:
    resources:
      limits:
        memory: 1280M
  volumes:
    - slopkeeper-voice:/voices
```

Set `VOICE_URL=http://voice:5000` on the bot, and don't publish the port. On first start it downloads seven models into its volume, and after that it needs no internet:

- `en_US-libritts_r-medium` (79 MB, CC BY 4.0) holds 904 voices. Voices 1, 2, 5 and 9 are four of them.
- The character voices are community models, 64 MB each, fetched at a fixed version and checked against their hashes. If one can't be fetched, its voice talks with the first model until the container restarts.
  - [GLaDOS](https://huggingface.co/NullPoExc/piper-glados) (no license given)
  - [HAL 9000](https://huggingface.co/OccultAI/HAL-9000-Piper-TTS) (Apache 2.0)
  - [Bender](https://huggingface.co/Schmalvis/bender-tts-model) (no license given)
  - [Optimus Prime](https://huggingface.co/crazygiscool/optimus-piper-voice) by crazygiscool (CC BY-NC 4.0: non-commercial use only)
  - [Kronk](https://huggingface.co/russdill/kronk) (no license given)
  - TikTok, from cosycove's BeefStew, which is no longer online, via a copy in [fox3000foxy/piper-voices-collection](https://huggingface.co/fox3000foxy/piper-voices-collection) (no license given)

`VOICES` in `src/features/say.ts` lists the voices offered. Each model loads the first time it's used. With all seven loaded it uses about 700 to 800 MB, and a long line at a slow speed briefly takes it near 1 GB. It makes a short line in about a second on two CPU cores.

### The music container

Music needs a container built from [`music/`](music). It finds songs and downloads their audio with [yt-dlp](https://github.com/yt-dlp/yt-dlp). Spotify is only used to search and to read links: every song plays from YouTube or SoundCloud, and one neither has is skipped.

**Read this first.** Downloading from YouTube and SoundCloud is against their terms of service, and playing into a Discord channel for others may be too. It's for a few friends in a private server; YouTube can slow down or block an address that downloads a lot. yt-dlp never signs in to anything.

1. **Search app:** sign in to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), create an app with any name, the redirect URI `http://127.0.0.1:8888/callback` (only step 4 uses it) and only **Web API** ticked, then copy its Client ID and Client Secret from its settings. On its own it only reads the catalogue. Step 4 adds an account's playlists. Since February 2026 these apps need a Premium owner.
2. **Add the container,** and don't publish its port. The bot reads the downloaded audio from the same volume:
   ```yaml
   slopkeeper:
     volumes:
       - slopkeeper-data:/data
       - slopkeeper-music:/music:ro
   music:
     image: ghcr.io/chuck-amuck/slopkeeper-music:latest
     restart: unless-stopped
     init: true
     environment:
       MUSIC_TOKEN: ${MUSIC_TOKEN}
     volumes:
       - slopkeeper-music:/data
     deploy:
       resources:
         limits:
           memory: 512M
   ```
3. **Set on the bot:** `MUSIC_URL=http://music:7700`, `MUSIC_TOKEN` (any long random value, the same on both), `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`.
4. **Playlists (optional):** the Music tab's **My playlists** only shows once this is done. With the bot running, sign in once as the Spotify account whose playlists you want. The search app must belong to that account:
   ```sh
   docker compose exec -it slopkeeper node src/spotify-sign-in.ts
   ```
   It prints a link to open and agree to, then asks for the address the browser ends up on. That page doesn't load, which is expected. It prints `SPOTIFY_REFRESH_TOKEN=...` for `.env`. Restart the bot to use it. It only lets the bot read that account's playlists. If Spotify ever turns it down, the Music tab says so: run the script again and replace it.

YouTube changes often and old yt-dlp versions stop working, so the container updates yt-dlp when it starts and daily after that. Each song is about 3 to 9 MB. The container keeps the most recently played songs, up to `MUSIC_CACHE_MB` (1024 by default), so songs played again start at once. It uses about 100 MB of memory, and more for a moment while a song downloads. Settings and the Music tab say if yt-dlp isn't working. The bot reads the audio from `MUSIC_AUDIO_DIR`, `/music/audio` by default, which is the volume's `audio` folder.

### The loop bot

A second Discord bot that only plays the [looping sound room](#looping-sound-room), so the main bot is free to play everywhere else. It runs from the same image, with a different command, and reads the sounds and speech the main bot prepares from the data volume, read-only. It has no commands or settings of its own: the main bot sends it what to play over a private connection inside the stack.

1. **Make the bot:** in the [Discord developer portal](https://discord.com/developers/applications), create a new application, say "Slopkeeper Loop", and copy its bot token from the **Bot** page. It needs no privileged intents.
2. **Invite it:** under **OAuth2 → URL Generator**, tick the `bot` scope and the **View Channels**, **Connect** and **Speak** permissions, then open the URL and pick the server.
3. **Add the container,** and don't publish its port:
   ```yaml
   loop:
     image: ghcr.io/chuck-amuck/slopkeeper:latest
     command: ["node", "--disable-warning=ExperimentalWarning", "src/loopBotMain.ts"]
     restart: unless-stopped
     init: true
     environment:
       LOOP_BOT_TOKEN: ${LOOP_BOT_TOKEN}
       LOOP_TOKEN: ${LOOP_TOKEN}
       ALLOWED_GUILD_IDS: ${ALLOWED_GUILD_IDS:-}
     volumes:
       - slopkeeper-data:/data:ro
   ```
4. **Point the bot at it:** add `LOOP_BOT_URL: http://loop:8788` and `LOOP_TOKEN: ${LOOP_TOKEN}` to the bot's environment. `LOOP_TOKEN` is any long random value, the same for both.

With `LOOP_BOT_URL` set, the main bot never plays the room itself, and if the loop bot is down the room stays quiet until it's back. The main bot sends the room again on every voice change and once a minute, so a restarted loop bot picks it up by itself. The loop bot leaves a room that's been empty for 30 seconds even if it isn't told to, and leaves any server not in `ALLOWED_GUILD_IDS`.

### Hosting the bot

For whoever runs the bot.

1. **Create the application.** Go to https://discord.com/developers/applications → **New Application**. Then, on the **Bot** tab:
   - **Reset Token** and copy it into `.env` as `DISCORD_TOKEN`. Keep it secret: anyone with the token can control the bot.
   - Enable **Presence Intent**, **Server Members Intent** and **Message Content Intent**. The bot crashes on startup with `Used disallowed intents` without them.
   - If someone else is adding the bot to their server, turn **Public Bot** on. Otherwise only you can add it. Leave **Requires OAuth2 Code Grant** off.
2. **Get a Steam Web API key** at https://steamcommunity.com/dev/apikey (any domain name works) and set `STEAM_API_KEY`.
3. **Fill in `.env`** (`cp .env.example .env`). If **Public Bot** is on, set `ALLOWED_GUILD_IDS` to the servers you expect. Server admins can send you their server ID (right-click the server icon → **Copy Server ID**, with Developer Mode on).
4. **Start it:**
   ```sh
   docker compose up -d --build
   docker compose logs -f slopkeeper
   ```
   The log lists each server it registered commands in, then `Logged in as Slopkeeper#1234 in N servers`.
5. **Send the invite link** to each server admin. Either use **OAuth2 → URL Generator** with scopes `bot` + `applications.commands` and the permissions View Channels, Send Messages, Embed Links, Connect, Speak, Manage Roles, Create Expressions, Manage Expressions and Create Events, or fill your application ID (from **General Information**) into this link:
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=26389624409088
   ```

Local dev (Node 24+): `npm install && npm run dev`. `npm run typecheck` runs tsc, and `npm test` runs the tests (the audio ones need ffmpeg and are skipped without it). GitHub Actions runs both on every push, and the image is only built if they pass.

Data (SQLite DB and uploaded sounds) lives in the `slopkeeper-data` volume at `/data`, with each server's sounds in `sounds/<server id>/`, and the first version of any trimmed sound in `originals/` inside that. The bot copies its database to `backups/` in that volume once a day and keeps the last 7 copies. Those guard against a bad update or a damaged database, not against losing the disk, and they don't include sounds, so back the volume up elsewhere too.

Voice sessions in progress are saved when the bot stops, without a recap, so a restart mid-session splits it in two. A crash loses them. Game stats are saved every 5 minutes and when the bot stops, so a crash loses at most a few minutes of them.

### Adding the bot to a server

For the server admin. You need the **Manage Server** permission in the server.

1. **Add the bot.** Open the invite link from the host, pick your server, leave every permission ticked and click **Authorize**. If the bot is running, it posts a short hello in your server's system channel.
   - **Manage Roles** lets `/notify` hand out the hop-on role, and `/gamerole` make and hand out game roles.
   - **Create Expressions** lets the bot copy sounds into the server's soundboard.
   - **Manage Expressions** lets it swap out or take off sounds other people added there. Everything else works without it.
   - **Create Events** lets game nights show up in the server's Events list.

   If the bot was added with an older invite link, its role may be missing **Create Events** or **Manage Expressions**. Either open the new link again (it updates the permissions without removing the bot), or tick them on the bot's role in **Server Settings → Roles**.
2. **Pick the announce channel:** `/setup announce-channel channel:#somewhere`. This is where hop-on pings, session recaps, the weekly leaderboard and sale alerts are posted. If the bot can't post there, it tells you which permission to give its role.
3. **Make the hop-on role** (optional, for `/notify`).
   - In **Server Settings → Roles**, create a role such as `hop-on`, and drag the bot's role (**Slopkeeper**) **above** it. Discord only lets a bot hand out roles below its own.
   - Then run `/setup hopon-role role:@hop-on`.
4. **Set the time zone** if it isn't the host's: `/setup timezone zone:Europe/London`.
   Want free game posts? They're off until you run `/setup free-games enabled:True`, optionally with `channel:#free-games`.
5. **Add game pings** (optional) for the games your server plays: `/gamerole add game:Valheim`, and so on. Then `/gamerole menu` in a channel people will see, so they can pick theirs.
6. **Check voice channels.** The bot needs **Connect** and **Speak** in any voice channel you want the soundboard in. That's automatic unless the channel overrides permissions. If a channel blocks it, a sound click tells you which permission is missing.
7. **Check it:** `/setup show`. Anything you haven't set uses a default, which is listed there.

Then tell people to run `/steam link`, `/notify` and `/pings` (see [Getting started](#getting-started-for-everyone-in-the-server)), and post a `/sound panel` somewhere handy.
