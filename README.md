<img src="assets/logo.png" width="160" align="right" alt="Slopkeeper logo">

# Slopkeeper

Keeper of the slop. A Discord bot for friends servers that helps people get together, figure out what to play once they're there, and remember the night afterwards. One running bot can serve several servers, each with its own settings and data.

- **Getting together:** pings people who opted in when a voice channel fills up, with per-game pings for the games being played, and plans game nights people can RSVP to.
- **Picking a game:** knows everyone's Steam library and picks a multiplayer game that the people in voice all own.
- **Getting games:** posts when a game the group wants goes on sale, on Steam or cheaper on another official store, pinging whoever still needs it, and when a game is free to keep on Steam, Epic or GOG.
- **Remembering the night:** recaps each voice session, keeps a weekly leaderboard, tracks what everyone plays, per person and for the whole server, and posts a recap of each month.
- **Messing around:** a soundboard that layers different sounds like Discord's own and restarts a spammed one without a gap, with short clips mirrored into Discord's soundboard, and text to speech.

Everything happens through slash commands (type `/` in any channel, or run `/help`), a few **Apps** on messages and members (right-click, or press and hold on a phone), and automatic posts in each server's announce channel.

**Contents**

- [A typical night](#a-typical-night)
- [Getting started](#getting-started-for-everyone-in-the-server)
- [Getting together](#getting-together): [hop-on pings](#hop-on-pings) · [game pings](#game-pings) · [game nights](#game-nights)
- [Playing games](#playing-games): [Steam accounts](#steam-accounts) · [What do we play?](#what-do-we-play) · [Game library](#game-library) · [Sale alerts](#sale-alerts) · [Free games](#free-games)
- [Stats](#stats): [session recaps](#session-recaps) · [voice leaderboards](#voice-leaderboards) · [game stats](#game-stats) · [comparing two people](#comparing-two-people) · [monthly recap](#monthly-recap)
- [Soundboard](#soundboard): [playing sounds](#playing-sounds) · [managing sounds](#managing-sounds) · [text to speech](#text-to-speech) · [who can change sounds](#who-can-change-sounds) · [even volume](#even-volume) · [soundboard volume](#soundboard-volume) · [looping sound room](#looping-sound-room) · [Discord's soundboard](#discords-soundboard)
- [Music](#music)
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

When a voice channel reaches 2 people, the bot posts in the announce channel. The post names who's there and what they're playing, and pings the hop-on role (set with [`/setup hopon-role`](#server-settings)) plus the [game ping](#game-pings) role of each game being played. It fires once as the channel reaches that number, not on every join after. It then waits 2 hours before pinging again, so a busy evening doesn't spam. The AFK channel and bots don't count. Both numbers can be changed with `/setup hopon`. The post has a **Join** button that opens the voice channel, and **On my way**, which adds your name to the post (press it again to take it off).

| Command | What it does |
| --- | --- |
| `/notify` | Turns hop-on pings on for you by giving you the hop-on role. Run it again to turn them off. Only you see the reply. If the server doesn't let the bot hand out that role, it says a server admin will have to give it to you (or take it off). |

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
- **Edit** (host, or anyone with Manage Events) opens a form to change the game, time or details. The card and the Discord event follow, and if the time moves, everyone who's **In** or **Maybe** is told and reminded again before the new time. A night that has started keeps its time.
- **Cancel night** (host, or anyone with Manage Events) asks first, privately, then greys out the card, deletes the event and lets the people who were in know.

**Repeating nights:** add `repeat` to plan a night every week or every 2 weeks. The bot posts each new card, with its own Discord event and game role ping, 6 days before that night, so a weekly night's next card goes up the day after the last one. It stays at the same local time when the clocks change.

**Edit** and **Cancel night** change only that night. To end the whole series, press **Stop repeating** on any of its cards (host, or anyone with Manage Events), and confirm.

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
| `/steam link profile [user]` | Links a Steam account and immediately reads its library. `profile` can be a profile URL (`https://steamcommunity.com/id/samplays`), a vanity name (`samplays`) or a 17-digit SteamID64. Use `user` to link it for someone else. A **Link my Steam** button does the same with a form, on `/steam list` and on a `/whatdoweplay` card when someone in voice isn't counted. |
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

`/setup patch-notes` posts patch notes for games with a Steam ID that were played in the server in the last 30 days. **Each one** posts them as they're found, and **weekly digest** posts them together on the weekly leaderboard's day and hour, even if the leaderboard post is off, or when the bot is back up to a day later. Notes found after a week's digest wait for the next one. They go to the announce channel, or the channel you pick, and never ping anyone. It's off by default.

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
- **Not counted:** people in voice whose games the bot doesn't know: no Steam link and no games marked, or a private Steam profile it has never seen the games of. They're left out instead of blocking every game, and it says which. Someone in a Steam family whose games the bot has seen still counts, and a profile made private keeps the games seen before.

Buttons:
- **🎲 Reroll** picks again from the games that qualify. It's greyed out when only one game qualifies.
- **🗳️ Vote** starts a 1-minute `/gamevote`. It's greyed out when only one game qualifies.
- **Never suggest this** hides a game from future picks, and tells whoever pressed it how to undo it: `/game unhide`, or the web UI's Games page.

**🎲 Reroll** keeps to the `type` and `deck` you chose, and to the people in the channel it was picked for, so anyone can press it, even someone not in voice. **🗳️ Vote** covers every game that qualifies.

How a vote works:
- The ballot has up to 10 games from the same list: the 5 you've played most, then a random mix of the rest.
- Everyone in the voice channel gets one vote and can change it until the vote closes. People outside the channel can't vote.
- The card shows how many have voted and who it's waiting on. It closes as soon as everyone in the channel has voted, or when time runs out. A tie is settled at random, and the result says so.
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
| `/game want name` | Pings you when a game goes on sale. Takes a library game, a name or a Steam store link, and adds a new game to the library. Run it again, or press **Undo** on the reply, to take it back. |
| `/game own name [user]` | Marks a game as owned by you, or by `user`, for non-Steam games and Family Sharing. Run it again, or press **Undo**, to unmark it. It's not needed if Steam already shows the person owning the game. |
| `/game list` | Shows every library game, its player cap, who owns it and who still needs it, with ◀ ▶ buttons once it's too long for one page. |
| `/game remove name` | Removes a game from the library, along with its manual ownership marks. **Undo** on the reply puts it back as it was, for 15 minutes. |
| `/game unhide name` | Lets `/whatdoweplay` suggest a game that was hidden with **Never suggest this**. |

Examples:
```
/game add name:Deep Rock Galactic steam:https://store.steampowered.com/app/548430 max_players:4
/game add name:Minecraft
/game own name:Minecraft
/game own name:Minecraft user:@Alex
```

### Sale alerts

Every `SALE_CHECK_HOURS` (default 6), the bot checks Steam prices, and [other stores'](#other-stores) with an IsThereAnyDeal key, for what this server cares about:

- **Played:** games played in voice here in the past 180 days, found by matching the name to a Steam title. Games not on Steam are skipped, and `/game add` with a Steam ID covers a game whose name doesn't match.
- **Wanted:** games someone asked for with `/game want`.
- **Steam wishlists:** games on a linked member's Steam wishlist, if their profile lets the bot see it. A server can turn these off.
- **Library:** games added with a Steam ID.

Prices are checked through the day, so `/sales` and the web UI stay current, but it posts once a day: at 18:00 in the server's time zone by default (`/setup sale-alerts post_hour:`), with everything that's new since the last post, in the announce channel or the channel from `/setup sale-alerts`. That post checks prices again first. If the bot is down at that hour, it posts when it's back that day. A sale that starts and ends between two posts isn't posted, but shows in `/sales` while it's on. Up to 10 games are listed, most wanted first, and the rest are in `/sales`:

> 💸 **3 games on sale**
> **Deep Rock Galactic**: 60% off, $11.99, was $29.99. Lowest price yet. Played 14h · Needs it: @Sam, @Alex
> **Hades**: 50% off, $12.49, was $24.99. Lowest ever $6.24. Wanted by @Jo
> **Portal 2**: $1.99 as a Steam key from Fanatical, 80% under Steam’s $9.99. Lowest ever $0.99. On @Alex’s Steam wishlist

Under the post, **Everything on sale** and **Just mine** show whoever presses them the full list, or only what they want or wishlisted, without posting it for everyone.

A game is posted at 25% off or more by default, then again only if the same sale gets at least 10 points deeper.

#### Other stores

With an [IsThereAnyDeal](https://isthereanydeal.com) API key (`ITAD_API_KEY`), the same check also asks IsThereAnyDeal what other official stores charge, such as Humble, Fanatical, Green Man Gaming or GamesPlanet. Only copies that are Steam keys count: GOG, Epic and other launchers' copies, and stores that don't say what they sell, are left out. When a store sells a Steam key for less than Steam does, the post gives that price and store, how far it is under Steam's normal price and, if Steam has a sale too, Steam's price. The store's name links to the deal.

How far under Steam's normal price counts as the discount: the smallest sale worth posting and the 10 points deeper apply to it the same way. A server can leave other stores out (`/setup sale-alerts other_stores:False`). Without a key, only Steam is checked.

With a [gg.deals](https://gg.deals) API key as well (`GGDEALS_API_KEY`), a game that's posted or listed also shows the cheapest key reseller, such as G2A or Kinguin, when it's under every official price: "Key resellers from $7.50 on gg.deals". gg.deals only gives that one price, without saying whether it's a Steam key or an account or which regions it works in, so it never posts a game by itself. Check the offer on gg.deals before buying.

The lowest price ever is the lowest a Steam key has had on Steam or the stores above, from IsThereAnyDeal, in the server's own money. Without a key there's no lowest price. A region IsThereAnyDeal or gg.deals doesn't cover gets Steam's prices only.

Only the people a sale matters to are pinged:

- Whoever wanted it, or has it on their wishlist, until they own it.
- For played and library games, everyone in the group who doesn't have it. A library game that was added by `/game want` only pings the people who wanted it.
- Not anyone who has played it in voice here, as they must have it somehow.
- Not anyone whose Steam library is private, unless they asked for the game, as nobody can tell what they own.

#### Bundles

With an IsThereAnyDeal key, the bot also looks through the Humble Bundle, Fanatical and Green Man Gaming bundles running now, once a day at the same hour as sales. The day's new bundles share one post of their own, in the same channel as sales. A bundle is in it once, when it has:

- **A game this server cares about:** one it would post a sale for, as above. The post names the game, the cheapest tier that has it and why, and pings whoever wants it or has it on their Steam wishlist.
- **A game like what you play:** one sharing at least 4 Steam tags with one of the 10 games played most here in the past 180 days, that someone with a linked Steam account doesn't already have. Tags that mean much the same, like Rogue-like, Rogue-lite and Action Roguelike, count once. When most of those 10 games are multiplayer or co-op, the bundle game has to be too. These don't ping anyone.

> 📦 **Resident Evil: Biohazard Unleashed Bundle**
> **Resident Evil 4** in the $18.00 tier: On @Jo’s Steam wishlist
> **Resident Evil 7 Biohazard** in the $10.00 tier: Like Phasmophobia (Horror, Survival Horror, Psychological Horror, First-Person)
> Ends in 5 days
> *Humble Bundle · from $10.00*

DLC and soundtracks are left out, and a bundle with nothing for this server isn't posted, but is looked at again the next day in case someone wants one of its games by then. A post holds up to 10 bundles, as many as fit in Discord's 6,000 characters, and the rest wait for the next day. A server can turn bundles off (`/setup sale-alerts bundles:False`), or keep only the ones with a game it cares about (`bundles_like_we_play:False`).

Games hidden with **Never suggest this** aren't watched for being played or wishlisted, only if someone asked for them. A game nobody needs isn't posted.

The "group" here is the server's members who have linked Steam or marked at least one game as owned. Prices use the server's Steam store region (`/setup steam-region`, default `us`).

| Command | What it does |
| --- | --- |
| `/sales [mine]` | Shows what this server plays or wants that was on sale at the last check, including sales too small to post. A long list has ◀ ▶ buttons to turn the pages. `mine:True` shows only games you want or have on your Steam wishlist. |

The web UI's [Deals](#web-ui) tab has all of it in one place, as of the bot's last checks.

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

A game is also hidden if everyone here with a linked Steam account already owns it. Ratings and tags come from [SteamSpy](https://steamspy.com), and tags from Steam's store for games too new for SteamSpy to have any. They're kept for a month, or a day for a game neither had tags for. A hidden game is looked at again at each check, so loosening a filter can still catch it while it's free. If the lookup fails, the game waits for the next check.

The web UI's Settings page lists what's free right now, with the reason each game is posted or hidden.

---

## Stats

### Session recaps

The bot tracks each voice channel as a session. It records who was there, for how long, and which games Discord showed them playing. A session ends once the channel has been empty for 5 minutes, so a quick disconnect doesn't split the night in two.

A session of at least 15 minutes is recorded, even with one person in it, so time alone counts towards voice stats. With 2 or more people, the bot also posts a recap with each person's time and the games played. Shorter sessions aren't recorded. Both times can be changed with `/setup sessions`, and `/setup sessions recaps:False` stops the recap posts while still recording sessions. A bot restart, such as an update, doesn't split a session: if it's back within 10 minutes, the session carries on, counting the time in between, and gets one recap at the end.

### Voice leaderboards

| Command | What it does |
| --- | --- |
| `/stats [period]` | Voice leaderboard for the past week (default), past month or all time. Shows the top 10 by time in voice, how many nights each person showed up, and the most-played games by game time, as `/gamestats` does. |

Every Sunday at 8 PM, in the server's time zone, the bot posts the past week's leaderboard to the announce channel. If it was down then, it posts when it's back, up to a day late, still covering the week up to 8 PM that Sunday. Moving the day never posts two within six days. Change the day and hour with `/setup leaderboard`, or turn the post off with `/setup leaderboard enabled:false`. `/stats` still works when it's off.

### Game stats

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

#### Voice, music and speech history

From November 2026 the bot also notes when each person joins and leaves a voice channel (not the AFK channel, and not bots), for Stats to show when in the week people are on. Before that, only people playing a game Discord shows were noted. It also notes, for Stats → **Sounds & music**, each song heard from its start (its title, artist and link, where it came from, who added it or Autoplay, and how far it got, or that it was skipped) and each line said aloud (who asked, the voice, how many characters and whether it was said, read out from the speech channel or an announcement). The words of a line are never kept.

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
| **Compare with me** (Apps menu) | Right-click a member, or press and hold on a phone, then **Apps → Compare with me**: the same, just for you. |

It shows, over all time:
- how long the two played the same game in the same voice channel, and which games most;
- how many voice sessions they shared. The time shown is a maximum, because the bot keeps each person's total for a session, not when each of them was there;
- each person's total game time;
- games they both own: anything in the library, plus Steam games tagged multiplayer.

### Monthly recap

On the 1st of each month, the bot posts last month's highlights to the announce channel, at the same hour as the weekly leaderboard. If it was down then, it posts when it's back. Months with nothing to report are skipped, and a server's first recap comes after its first full month.

The recap covers total game and voice time, the top games, biggest gamers, most time in voice, the longest session, top sounds and who played the most of them, and game nights held. Months follow the server's time zone.

Top sounds counts sounds played through the bot (its panels, `/sound play` and the web UI) and sounds people play from Discord's own soundboard in the voice channel the bot is in at the time. Discord doesn't report plays anywhere else. A sound on Discord that's a copy of a library sound counts as that sound, also for the web UI's most-played order, and Discord's built-in sounds aren't counted.

| Command | What it does |
| --- | --- |
| `/recap [month]` | Shows last month's recap, or this month's so far. |

Turn the monthly post off with `/setup monthly-recap`. `/recap` keeps working.

---

## Soundboard

The bot holds a library of uploaded sounds and plays them in your voice channel. Different sounds layer like Discord's own soundboard: clicking one while another is playing mixes it in instead of cutting the other off. Clicking a sound that's already playing restarts it from the top, with no gap and no jump in volume, so spamming one button rapid-fires it instead of stacking copies. Up to 12 sounds play at once; past that, the oldest is dropped. A sound that's played to the end is kept in memory (up to 24 MB of sounds, ten seconds each at most), so playing it again starts straight away. The bot leaves voice after 5 minutes of silence, or as soon as everyone else has left.

### Playing sounds

| Command | What it does |
| --- | --- |
| `/sound panel` | Posts a button grid in the current channel: 20 sounds per page in the order set in the web UI's **Manage** (its groups first, named under the buttons, then the rest, most played first), ◀ ▶ to flip pages, ⏹ **Stop** to silence every sound and line of speech (the music carries on). The bot keeps every panel it posts up to date as sounds change, so post one in a handy channel and pin it. |
| `/sound play name` | Plays one sound in your voice channel. The name autocompletes. |
| `/sound stop` | Stops the sounds and speech, like the Stop button, and makes the bot leave voice. If music is playing, it carries on and the bot stays: music has its own controls and [DJ role](#music). The reply is in the channel, so people can see who stopped it. |
| `/sound join [name]` | Picks a sound that plays when you join voice. Leave `name` empty to stop having one. |

You have to be in a voice channel to play a sound. The bot joins whichever channel you're in.

**⚙️ Settings** on a panel changes sounds without leaving Discord. Everything it opens is only visible to you. Pick a sound from the panel's current page, or turn its own pages to reach the rest without moving the panel for everyone, to change its volume, test it, put it on or take it off Discord's soundboard, set its emoji, rename it or delete it. **Add a sound** opens a form with a file picker, a name (left empty, it's made from the file's name, so `Air Horn.mp3` becomes `air-horn`) and an emoji; the same rules and the same question about a taken name apply as for `/sound add`, and the channel sees what was added. People with **Manage Server** also get switches for even volume and join sounds. Trimming and picking part of a long sound are on the web UI, or in the commands below.

**Join sounds** are opt-in: nothing plays until someone picks one with `/sound join`, or it's set for them on the web UI's Settings page. When you connect to voice the bot joins straight away, then waits half a second before playing, so the sound clears Discord's joining noises. Nothing plays if you leave during that wait. It doesn't play when you switch channels, or again until the cooldown is up (10 minutes unless `/setup sounds` says otherwise). If the bot is already in a different channel, it stays there rather than leaving the people using it. They don't count towards the monthly recap's top sounds.

### Managing sounds

| Command | What it does |
| --- | --- |
| `/sound add name file [emoji]` | Uploads a sound. Names use lowercase letters, numbers, `-` and `_` (up to 32 characters). The file can be mp3, ogg, wav, m4a, opus, webm or flac, up to 5 MB, and the bot turns it down if it can't find audio in it. Using an existing name asks first: **Replace it** (the old sound goes to Recently deleted and the emoji stays unless you give a new one), **Keep both** (the new one gets the next free name, like `airhorn-2`) or **Cancel**. The question lasts 5 minutes. |
| `/sound emoji name [emoji]` | Sets the emoji on a sound's button. Leave `emoji` empty to clear it. Custom emoji have to be from this server. |
| `/sound remove name` | Deletes a sound from the bot, and from Discord's soundboard if it's there. It stays in a bin for 30 days. |
| `/sound restore name` | Brings back a sound from the bin with its emoji, volume, group and untrimmed original. If the name's been taken, it comes back numbered, like `horn-2`. It isn't put back on Discord's soundboard, and anyone who had it as a join sound has to pick it again. |
| `/sound volume name percent` | Sets how loud one sound plays, from 25 to 200, where 100 is normal. |

The web UI's **Manage** can also trim a sound, and so can the [management API](#management-api). The bot keeps the first version, so it can be restored until the sound is replaced. A copy on Discord's soundboard stays as it is until it's added again.

#### Adding a sound from a link

In the web UI's **Manage**, paste a link to a YouTube video or Short, a TikTok, an Instagram Reel or a SoundCloud track under the drop zone and press **Get**. The [music container](#the-music-container) downloads it, up to 20 minutes long, and an editor opens with the video (or the track's player) above its waveform:

- Drag either end of the waveform, type the start and end, or play to a moment and press **Start here** or **End here**. Moving an end shows that moment in the video.
- **Preview** plays just that part. It can be up to 3 minutes long.
- The name starts as the video's title. A taken name asks **Replace it** or **Keep both**, as an upload does.
- **Also add to Discord's soundboard** is shared with uploads. Discord takes 5 seconds at most, so a longer part stays on the bot's soundboard, and a 5-second piece can be added to Discord afterwards.
- **Save and cut another** saves the part and keeps the editor open on the same video, starting the next part where this one ended, so one video can be chopped into several sounds with one download.

The part becomes an mp3 like any upload: levelled, trimmable and playable everywhere. Its row says **from a link**. Its **Trim** has **Pick again from the link**, which downloads the video again and opens the editor at the part picked before, so a different or longer part can replace it (the old one goes to Recently deleted). Renaming keeps the link; uploading a file over the sound, or deleting it, forgets it.

The music container doesn't sign in anywhere. Without signing in, Instagram turns down many Reels and sends some without their sound; the editor says so instead of saving silence. TikTok now and then refuses a video to some internet connections. YouTube and SoundCloud work as they do for music.

Examples:
```
/sound add name:airhorn file:<airhorn.mp3> emoji:📯
/sound emoji name:bruh emoji:💀
/sound remove name:old-meme
```

The web UI's Soundboard tab, under **Manage**, also shows everything on Discord's soundboard, including sounds people added there themselves. You can play or preview any of them, save them to the library, and swap one for a library sound. Nothing is lost: a sound that comes off and isn't in the library is saved there first.

### Text to speech

`/say text [voice]` has the bot read something out in your voice channel, joining it first if it has to. There's a **Say something** box on the web UI's Soundboard tab too. **Save** there keeps a line as a one-click button, up to 25 per server, and `/say saved:` picks one in Discord. A saved line is said in the voice picked next to the box, or in Discord in `voice` or else the server's default voice. Saved lines follow the same rules as typed ones.

- **Say this aloud:** right-click a message, or press and hold it on a phone, then **Apps → Say this aloud** to have it read out in your voice channel, in the server's voice, starting with whose message it is. Spoilers and code blocks are skipped, and it follows the same rules as `/say`.
- Lines wait their turn, while sounds still layer on top. **Stop** ends the line and clears anything waiting.
- Mentions are read as names, custom emoji as their name, and links as "link". A line break after a heading or a line with no full stop is a short pause, so a pasted paragraph doesn't run its headings into the next sentence.
- A line can be a whole paragraph: up to 4,000 characters by default (about 5 minutes) and 6,000 at most (Discord's limit for `/say`). On the web UI the box grows as you type and keeps a paste's line breaks; **Enter** says it and **Shift+Enter** starts a new line. A long line takes a few seconds to start, and the headphones preview plays only its first sentences.
- Every line goes in the Activity tab with who said it, a long one cut to its first 200 characters.
- The bot keeps the lines it made lately (up to 24 MB, until it restarts), so a saved line, a greeting or a line just previewed in the web UI plays straight away when it's said again in the same voice and speed.
- The voices, all novelty ones:
  - **Characters:** **GLaDOS**, **HAL 9000**, **Bender**, **Optimus Prime**, **Kronk**, **TikTok** (the TikTok text-to-speech lady, and the default), **JARVIS**, **Rocket Raccoon**, **Death** (the wolf from *Puss in Boots: The Last Wish*), **BMO**, the **Counter-Strike announcer**, **Bobby**, **Carl** and **Patrick**.
  - **Accents:** **Scottish**, **Northern English**, **Southern English** (a woman and a man), **Irish (Jenny)** and **Australian** (a man and a woman) are English voices with those accents. **Russian**, **Spanish** and **German** read English with that accent, and **State broadcast** is a Korean announcer over an old loudspeaker. Russian typed in Cyrillic and Korean in Hangul are read in their own language. Spanish and German read everything as English.
  - **Effect styles:** **Demon**, **Helium**, **Giant**, **Robot**, **Alien**, **Walkie-talkie**, **Phone call**, **Megaphone**, **Stadium PA**, **Newsreel** (a 1940s film reel), **Cathedral**, **Underwater**, **Ghost** and **Trailer narrator**.

  The accents are ordinary Piper voices and the styles are made with effects: neither imitates a known person. A deployment can add [its own voices](#your-own-voices). Each voice talks at the server's speed, a few a little slower or quicker than that so they sound right. In Discord, `voice` is searched as you type. A server whose default voice has been removed talks in the bot's default voice.
- `/setup speech` sets whether it's on, how fast and how loud it talks, the longest line and how long each person waits between lines. The default voice is picked in the web UI's Settings. `/setup speech-role` limits it to a role, plus people with **Manage Server**. The web UI isn't limited by the role, and counts as one person for the wait.

It needs the [voice container](#the-voice-container).

**Greetings:** with `greet` on in `/setup speech`, the bot says who joined voice, using the **Greeting** setting with `{name}` for the person. Someone with a join sound hears that instead. Greetings follow the join sound rules: the same cooldown and delay, nothing for moving channels, bots or the AFK channel, and the bot won't leave another channel for one.

**Announcements:** `night_reminders` says game night reminders in the night's voice channel when they're posted, and `hop_on` says hop-on pings in the channel they're about. Both only play where people are, and won't pull the bot away from another channel. What gets posted doesn't change.

**Reading a channel aloud:** `/setup speech-channel` or Settings picks a text channel, and the bot reads out what people type there, starting with who said it. It plays in the writer's voice channel, or else the one the bot is in, or else the busiest one, and reads nothing if nobody's in voice. `who` limits it to people in voice.

It skips bots, images, links with no words and anything over the longest line, and leaves out spoilers and code blocks. There's no wait between messages, but if 5 lines are already waiting, new ones are skipped so it can't fall behind. The role limit applies, and these lines aren't logged in Activity.

### Who can change sounds

Everyone can, until a role is set with `/setup sound-managers`. Then only people with that role or **Manage Server** can use `/sound add`, `emoji`, `remove`, `restore`, `volume`, `discord-add`, `discord-remove` and `discord-sync`, or the changes under a panel's **⚙️ Settings**. Everyone else can still play and test sounds, stop playback, post a panel and set their own join sound. If the role is deleted, only people with **Manage Server** can change sounds until a new one is set.

The web UI isn't limited by the role: anyone with its password can change everything, even when [Pangolin](#signing-in-through-pangolin) says who they are.

### Even volume

Every sound is measured when it's added, so a whisper and an air horn play about as loud as each other. Your file isn't changed: the bot stores how much to turn each sound up or down and applies that as it plays, so turning it off with `/setup sounds` puts everything back. A quiet sound with one loud spike only comes up until the spike would clip, and no sound is boosted by more than 12 dB, so very quiet sounds can still need `/sound volume`.

Sounds from before this existed are measured when the bot starts. Copies on Discord's soundboard are levelled using Discord's own volume for each sound, which can only go up to 1, so a sound that needs a big boost stays quieter there than on the bot.

### Soundboard volume

**Soundboard volume** turns every sound up or down at once, including join sounds and the looping sound, and changes sounds that are already playing. It's the **Sounds** slider on the web UI's Soundboard and behind the **Volume** button on every page, in Settings, and `volume` in `/setup sounds`. Speech has its own volume: **Speech volume**, the **Speech** slider beside it and behind **Volume**, also in Settings and `volume` in `/setup speech`. It changes a line being said too.

The web UI's volume sliders, for the soundboard, music and each sound, work like a media player's: the first three quarters run from 0 to 100%, the tick marks 100%, and the last quarter, in orange, turns it up past 100% to the most it goes. The box beside each takes an exact percentage, and the arrow keys move a slider 5% at a time (Page Up and Page Down 20%).

### Looping sound room

Pick a voice channel and a sound with `/setup loop-room` or in Settings, and the bot plays that sound over and over, without a gap, while anyone's in the channel. It leaves when the last person does. It's off until the channel and a sound or speech are set. `/setup loop-room` with no options shows how it's set, and `off:True` turns it off.

Discord lets a bot be in one voice channel per server, so the room shares the bot with everything else, and the points about Stop and giving way below are about that. With the [loop bot](#the-loop-bot) set up, a second bot plays the room instead: both play at once, the room never gives way, and the soundboard's **Stop** leaves the room alone. Settings shows the loop bot's state at the top of the room's settings.

- Other sounds, join sounds and speech play on top. Playing the looping sound by hand plays a second copy.
- **Stop** silences it until someone else joins the room.
- The room gives way: if the bot is busy in another channel with people in it, the room waits until that channel empties or the bot has been idle for 5 minutes. Playing something in another channel takes the bot there, and the loop comes back the same way.
- **Loop volume** is the sound's and **Looping speech volume** the speech's, and both start at half, as they never stop. Renaming the sound keeps it, and removing it turns the loop off.
- **Looping speech** says some words over and over too, up to 500 characters, in a **Looping speech voice** of its own (the default voice until one's picked in Settings) at the speech speed. It plays alongside the sound, or alone with no sound set. **Speech every** spaces it out the way Loop every does for the sound. The voice container makes the speech once and the bot reuses it, so Settings warns straight away if it can't be made.
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

- `/music play [song] [next] [shuffle]` adds a song, album or playlist by search or Spotify link, a song by YouTube or SoundCloud link, or a YouTube or SoundCloud playlist, and starts the music in your voice channel. `next` puts it after the song playing instead of at the end, and `shuffle` adds 100 of an album's or playlist's songs at random instead of the first 100. With no song, it carries on where it paused. Any public Spotify playlist link works. Its suggestions list the Spotify account's matching playlists first, when it's signed in.
- **YouTube and SoundCloud playlists:** a `youtube.com/playlist?list=…` or YouTube Music playlist link adds its first 100 videos in order, or with `shuffle` (or **Shuffle** on the Music tab) 100 picked at random from its first 500. Private, deleted, live and over-20-minute videos are left out, and the reply says how many. A link to one video in a playlist, as YouTube's **Share** gives it, adds just that video. A SoundCloud playlist or album (a `/sets/` link) works the same way, shuffling from all of it, and takes a few seconds longer, as each track is read. Tracks SoundCloud locks, which includes many in its own curated playlists, are left out and counted. Channels and profiles can't be added.
- `/music pause`, `/music skip` and `/music stop` are said in the channel, so everyone can see who did it. **Stop** clears the queue too.
- `/music play` answers with a music card: the song playing with its cover, when it ends, and a page of what's next, with **Play/Pause**, **Skip**, **Shuffle**, **Stop**, **Refresh** and **Autoplay** buttons, and pages for a long queue. The card keeps up as songs change, also after the bot restarts, and a newer `/music play` card takes over from it. **Stop** asks first, then says in the channel who stopped it. The buttons follow the same DJ role as the commands; anyone can turn the pages.
- `/music queue` shows the same card, just to you.
- `/music remove song` takes a song out of the queue. It suggests the queue as you type, numbered as the card shows it. Taking out the song playing skips it.
- `/music shuffle` puts the songs waiting in a random order, leaving the one playing alone and Autoplay's songs at the end. It's said in the channel too.
- `/music autoplay [on]` turns **Autoplay** on or off (leave out `on` to switch it), as the card's **Autoplay** button and the switch on the Music tab's **Up next** do. While it's on, three songs wait at the end of the queue, from YouTube, like the last song in the queue that someone added, under an **Autoplay, like …** heading, and more come as they play, so the music carries on in that style. Songs people add always go ahead of them. Once another song is last (added to the end, moved there, or shuffled there), the ones waiting are swapped for songs like it straight away; **Play next** leaves them be. Autoplay's songs don't move; on the Music tab, **+** on one keeps it, as if you'd queued it at the end, and **✕** takes it out. Turning it off takes out the songs it added that haven't played. It's off until someone turns it on.
- The web UI's **Music** tab has the same, plus search results to pick from, each with **Play next** or **Add to end** (with nothing queued, **Play next** plays it straight away in the channel picked in **Play in**; a pasted link gets the same choice, and **Shuffle** for a Spotify album or playlist), a progress bar you can click or drag to jump within the song (or move 10 seconds with the arrow keys), a volume slider, and **Shuffle** on **Up next**. Its **My playlists** switch lists the account's playlists to add, in order or shuffled. **Upload** inside the search box (there until something's typed), or a file dropped anywhere on **Add music**, uploads an audio file (up to 60 MB and 20 minutes) and offers **Play next** and **Add to end** for it, as for a link. From then on it plays, jumps and moves like any song, named by its own tags or else its file name. It's deleted once it has played, when the queue is cleared, or an hour after it's taken out (so Undo can put it back). It plays even while the music container is down. Each server's uploads take up to 500 MB, and one not added within an hour is deleted. Drag songs to reorder them, or use the arrows on a phone; the arrow to a line (**Play next**) moves a song to the top.

How it plays:

- **Queue:** the bot keeps its own queue for each server, kept across restarts, up to 500 songs. An album or playlist adds up to its first 100 songs, or 100 at random from up to its first 1,000 when shuffled. When the queue runs out the music stops, unless Autoplay is on. A restart or redeploy carries the music on from the same second, in the same channel, once the bot and the music player are back (usually 10–20 seconds; an uploaded file doesn't wait for the music player), as long as someone is still in that channel and it was less than 10 minutes. Paused music stays paused at its place.
- **Finding songs:** each Spotify song is matched by name and length, trying YouTube Music's official audio first, then YouTube, then SoundCloud. Live versions, covers and remixes are passed over unless that's what the Spotify song is. The first two songs in the queue are fetched as soon as they're queued, and each next one while a song plays, so they start without a wait. A song none of them has is skipped, and the Music tab says so. So is one whose file won't play, but a second in a row pauses the music, since something wider is wrong. If the bot can't see the music player's files (`MUSIC_AUDIO_DIR`), the music pauses and says so, rather than skipping every song.
- **Autoplay** reads YouTube Music's mix for the last song in the queue that someone added, the one playing included (the one YouTube radio would play after it; once those have all played, the last of them) and picks songs not played or offered since the music started, between 1 and 10 minutes long, and not live versions, covers or remixes. Once that mix runs out, or YouTube won't give it, it goes on from the latest song played instead. A song it offered isn't picked again, even once taken out or swapped, and what played is remembered through a restart. If the last song ends before Autoplay has found any, it waits up to 30 seconds, or until someone adds a song. It needs the song to have come from YouTube: a Spotify song is matched there, and SoundCloud songs can't be followed. If it finds nothing new, the Music tab and the card say the music stops after the song playing. Spotify's own suggestions aren't open to new apps, so it doesn't use them.
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
| `/setup show` | Lists every setting in the same groups as the web UI's Settings, with its current value. A changed setting says where it comes from: **set here** (with `/setup`) or **host default** (the host's `.env`). Anything stopping the bot is listed first: a missing announce channel, a channel that's gone or where the bot is missing a permission it needs, a role that's gone or above the bot's, and a post Discord refused when the bot can't tell why (until the next one goes out, it's turned off, or two days have passed). |
| `/setup announce-channel channel` | Sets where hop-on pings, session recaps, the weekly leaderboard, the monthly recap and sale alerts are posted, and free games unless they have their own channel. Until it's set, the bot works but posts nothing. It checks that it can post in the channel and tells you which permission is missing if not. |
| `/setup hopon-role [role] [off]` | Sets the role that hop-on pings ping, which `/notify` hands out. `off:True` posts hop-on pings without pinging a role. It warns you if its own role is below this one, since Discord then won't let it hand the role out. |
| `/setup hopon [min_people] [cooldown_minutes]` | How many people a voice channel needs before a hop-on ping, and how long to wait before the next one. |
| `/setup sessions [recaps] [recap_min_minutes] [grace_minutes]` | Whether a recap is posted when a session ends (sessions count in stats either way). The shortest session that counts: shorter ones get no recap and aren't in stats or leaderboards. Also how long a channel stays empty before its session ends. |
| `/setup leaderboard [enabled] [day] [hour]` | Whether and when the weekly voice leaderboard is posted. |
| `/setup timezone [zone]` | The server's time zone, used for the weekly post, counting "nights" on leaderboards, and reading game night times. Autocompletes, e.g. `America/Chicago`, `Europe/London`. |
| `/setup steam-region [country]` | Steam store region for sale prices, as a two-letter country code. |
| `/setup free-game-filters [min_rating] [like_what_we_play] [multiplayer_only] [not_on_steam]` | Chooses which free games are worth posting. See [Free games](#free-games). |
| `/setup sale-alerts [min_discount] [post_hour] [steam_wishlists] [other_stores] [bundles] [bundles_like_we_play] [channel]` | Sets the smallest sale worth posting, the hour of the day's sale post, whether Steam wishlists count, whether other stores' prices count, whether bundles are posted and whether ones only like what the server plays count, and a channel of their own. See [Sale alerts](#sale-alerts) and [Bundles](#bundles). |
| `/setup free-games [enabled] [channel]` | Turns free game posts on or off. `channel` gives them their own channel; without it they go to the announce channel. To move them back to the announce channel, use `/setup reset setting:Free games channel`. |
| `/setup gamenight-reminder [minutes]` | How long before a game night to remind the people who are in. `0` turns reminders off. |
| `/setup monthly-recap [enabled]` | Turns the post on the 1st of each month on or off. |
| `/setup patch-notes [mode] [channel]` | Posts patch notes for games played here: `each` as they come out, `digest` once a week, or `off`. `channel` gives them their own channel. |
| `/setup steam-status [enabled]` | Whether what linked members in voice are playing on Steam counts when Discord doesn't show it. |
| `/setup sounds [even_volume] [join_sounds] [join_cooldown_minutes] [join_delay_ms] [volume]` | Turns [even volume](#even-volume) and join sounds on or off, and sets how often one person's join sound can play and how long the bot waits after connecting before it plays. `volume` sets how loud every sound plays. |
| `/setup loop-room [channel] [off] [sound] [volume] …` | Plays a sound, and speech if you like, nonstop while anyone's in a voice channel. `off:True` turns it off and keeps the rest of its settings. See [looping sound room](#looping-sound-room). |
| `/setup music [volume] [autoplay] [dj_role] [everyone]` | How loud music plays, whether Autoplay adds similar songs once the queue runs out, and who can control it. `everyone:True` takes the role limit off. See [Music](#music). |
| `/setup sound-managers [role] [everyone]` | Limits changing sounds to a role, plus people with **Manage Server**. `everyone:True` lets everyone change them again, which is the default. See [who can change sounds](#who-can-change-sounds). |
| `/setup speech [enabled] [speed] [volume] …` | Text to speech: on or off, its speed, the limits on `/say`, and what the bot says aloud by itself. See [Text to speech](#text-to-speech). |
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
2. the host's default, from an environment variable (see [Configuration](#configuration));
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
| Default voice | web UI only | `TTS_VOICE` (a voice's id from `VOICES` in `src/features/say.ts`, like `glados` or `demon`) | `tiktok` |
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

**Choosing which servers can use it:** with `ALLOWED_GUILD_IDS` set, the bot leaves any server that isn't on the list as soon as it's added. Without it, anyone with the invite link can add the bot. Set it if the bot is public (see [Setup](#setup)).

## Web UI

A page in [`web/`](web) that runs as a second container next to the bot, for your home network or behind a sign-in proxy like [Pangolin](#signing-in-through-pangolin):

- **Play in:** beside the server in the header of every page, the voice channel that sounds, speech and music play in, with who's in each. One choice serves every page; when its channel empties, the next one with people in it takes over. On a phone the server and **Play in** share the top row.
- **Stop sounds:** while a sound or line of speech is playing, a red button in the bottom corner of every page silences them all, with what's playing above it to stop one at a time. The music carries on: it has its own controls on the Music tab, and while it plays the toast after Stop offers **Pause music**.
- **Music player:** while music plays or is paused, every page but Music has the song in a card at the bottom, in the middle (above a phone's tabs): its cover, title, artist and channel, which open Music, with **Pause** or **Play** and **Skip** in the middle of the card, and a line along its bottom for how far into the song it is. **Play** plays on in the channel picked in **Play in**, as the Music tab does; while nobody's in voice it's grey, and pressing it says so. **+** opens a box above it to add a song: search Spotify or paste a link, then **Play next** or **Add to end** (with nothing queued, Play next plays it straight away), or **Shuffle** for an album or playlist link; uploads and the account's own playlists are on the Music tab. A press anywhere else or **Escape** closes it. **✕** hides the player until the music stops, wherever it's stopped (with **Undo**), and Settings → **On this device** turns it off for that browser.
- **Sounds:** beside **Volume** on every page but the Soundboard, a button that opens the server's sounds over the page: **Volume** (the sounds', speech's and music's volumes for everyone, folded until opened on that device), a line to say with its voice and the headphones preview beside **Say** (one choice of voice on each device, shared with the Soundboard), a search (**Enter** plays the first match), and the sounds in their groups, folded as on the Soundboard, which play in the channel picked in **Play in** and light up while they play. On a wide screen it stays open while you use the page and from tab to tab, keeping its search and where it's scrolled to, until the button, **✕** or **Escape** closes it; on a phone a tap anywhere else closes it. Opening it closes **Volume**, and the other way round. Settings → **On this device** turns the button off for that browser.
- **Pop out:** on a desktop browser that can (Chrome or Edge 116 and later, Firefox 151 and later, over HTTPS), a button in the Sounds panel, on the music player and beside the Soundboard's search opens a small window that stays on top of everything, a game included: the song playing with Pause or Play and Skip, and **+** to add a song (it stays there with nothing playing, so + can start the music), the music's volume, **Up next** (the songs after it, people's then Autoplay's, each with **✕**, folded or open as last left on that device), **Play in**, the sounds' and speech's volumes, a line to say with its voice, the search and the sounds, and **Stop** while something's playing. Typing anywhere in it goes to the search. It keeps up while the tab is hidden, follows the tab to another server, and opens at the size it was last closed at. The tab's Sounds button and music player step aside while it's open. It closes with the tab, or when the tab reloads.
- **Volume:** the button in the bottom corner of every page opens the volumes of sounds, speech and music in one place (the looping room's are in Settings). They're for everyone in the server, and every slider, here or on another tab or device, moves with a change from any of them.
- **What's playing:** above the red button, every page lists the sounds and speech playing as they start and end, including join sounds and the looping room's, and marks them on the Soundboard with how far through they are. One sound on its own is named on the red button instead. On a phone, two or more fold into one **N playing** chip until it's tapped. Tap one to stop just that one; stopping the room's loop keeps it quiet until someone else joins, as Stop does. Sounds played from Discord's own soundboard, and the loop bot's, don't show: they don't go through the bot, and Discord only says that one started, not how long it plays.
- **Undo:** removing a song from the queue, deleting a sound or a saved phrase, taking a sound off Discord, **Never suggest this** and a setting's **Reset** each show a toast with **Undo** for 8 seconds, longer while the pointer or focus is on it.
- **On a phone:** the tabs are a bar along the bottom (Sounds, Music, Games, Nights and **More**, which has Pick a game, Deals, Stats, Activity, Settings, who you are and Log out), and buttons and fields are fingertip-sized on any touch screen.
- **Always current:** the music, the queue, the channels to play in, what's playing, the volumes, the sounds (with their groups, the bin and Discord's soundboard), game nights, the activity log and Deals change on the page the moment they change, whoever changed them and wherever, through one request per tab that the bot answers when something it shows changes. On Play, new sounds join the end of their section and the rest stay where they are, and playing a sound changes nothing. A change waits while you're typing, choosing or about to confirm something it would redraw, such as a rename in Manage, and lands once you're done. A tab in the background stops asking until it's shown again.
- **When the bot can't be reached:** the page says so and tries again by itself, sooner with **Retry now**, and a red strip across the top says when it loses touch partway through.
- **After an update:** a page left open offers **Reload** once the web UI has a newer version. Browsers keep the page's scripts and styles until they change, so it opens without fetching them again, and larger answers from the bot come compressed. While its login lasts, the Soundboard opens straight away with the sounds as that browser last saw them, then catches up with any changes a moment later (a sound deleted since can still show for that moment). **Log out** clears what the browser kept.
- **Links and the home screen:** each tab has its own address (like `#music`), so Back, bookmarks and shared links open it, and a phone can add the page to its home screen to open it like an app.
- **Soundboard:** **Play** has, from the top, the sounds' and speech's volumes, **Speech** (a box for having the bot say something, with the voice and its headphones preview beside **Say**, and the saved lines under it), a search, and then big buttons that play in voice, in their groups and then the rest, most played first. **Speech** and each group fold away with their headings, a folded group saying how many sounds it has; that's remembered on each device, and a search shows every group. The star puts a sound in **Favourites**. Groups are made and sorted in **Manage**. On a wide screen the volumes and **Speech** stay in a column on the left while the sounds scroll beside them, the search sits beside **Play | Manage**, and the buttons are smaller, with the emoji beside the name; an empty star shows when the pointer is on its button. **/** goes to the search (on a wide screen, so does just typing), **Enter** plays the first match and **Escape** clears it. When nobody's in voice the sounds and **Say** are grey, and pressing one says so. The sounds' and speech's volumes are for everyone in the server. The voice is remembered on each device, grouped into characters, accents and effects, and the headphones button plays the typed line (or a sample) in that voice just for you. Saved lines are one tap to say; **+** beside **Say** saves what's typed, and **Edit** removes them. **Manage** lists the sounds in their groups, in the order Play and Discord's panels show them, then the rest, most played first. **New group** makes a group; a group's name renames it, its arrows move it up or down, and its bin deletes it, which puts its sounds back among the rest with a way to undo it. Drag a sound by the handle at the start of its row to move it, or tap or click the handle for a list of groups; with a keyboard, Space picks it up, the arrow keys move it and Space puts it down. Manage also uploads files or whole folders, adds a sound from part of a [YouTube, TikTok, Instagram or SoundCloud link](#adding-a-sound-from-a-link), previews, renames and deletes sounds, sets a sound's volume, trims it with a way back to the original, and chooses what's on Discord's soundboard, with a waveform for picking part of a long sound. **Cut another** (the overlapping squares) cuts a new sound from the same video, if the sound came from a link, or from all of the sound itself, before any trim; the new sound goes next to it in its group and the sound itself is left as it is. **Download** (the arrow) saves a sound as a file, as it plays now. On a phone, a sound's volume, trim, Cut another, Download, rename, group and delete are under **⋯**. A file named like an existing sound waits until you choose **Replace it** or **Keep both**. **Recently deleted** restores a deleted or replaced sound, or erases it for good. The tab opens on whichever was used last on that device.
- **Music:** what's playing, Spotify search, and the queue to add to, reorder and clear. See [Music](#music).
- **Game nights:** plan a night, see what's coming up and who still needs to add each other on Steam, answer **In**, **Maybe** or **Can't**, edit or cancel one, or stop a repeating one. Editing there can also change the voice channel. Times are in your own time zone with how long until, plus the server's time when that's different. Someone the page doesn't know picks who they're answering as once, and that's remembered on the device. Cancelling says how many people who are in will be told.
- **Games:** the game library, with who has each game, who needs it, who wants it and any sale. Add games from a searchable list of what members own on Steam, or by name or store link. **Steam accounts** links, changes and unlinks anyone's Steam account, says who shares a Steam family, and refreshes libraries. Each game's **Manage** has its details (player limit and Steam link, kept with **Save**), **Never suggest this** to hide it from `/whatdoweplay` or let it back in, and who owns or wants it, which saves as you tick, with **Remove game** at the bottom. Ownership from a Steam library is locked. Sort by **Recently played** (the default) or **Most played**, which go by time in voice here as Stats counts it, or **A–Z**. Games nobody has played go last, and each played game says how long and when it was last played. The order is remembered on each device.
- **Deals:** what this server plays or wants that's on sale, with how the price compares with the lowest a Steam key has ever sold for (with an IsThereAnyDeal key); the running [bundles](#bundles) with a game for this server, which tier has it and why, looked through every `SALE_CHECK_HOURS`, including ones already posted (none when the server turned bundles off); and what's [free](#free-games) right now that passes the server's filters. When the web UI knows who you are, **Just mine** keeps only what you want or have on your Steam wishlist, remembered on each device. It changes on the page after each price check.
- **Pick a game:** choose a voice channel, or tick people to plan before anyone's in voice (only people whose games the bot knows are listed, as anyone else would block every game), and see the games everyone owns and those one purchase away, using the same rules as `/whatdoweplay`. Each game shows time played here, Steam hours, its last two weeks on Steam and when it was last played, in total and per person, plus who'd play on a family copy. Opening one shows how many are playing it on Steam right now and its latest patch, and **Achievements** compares everyone's progress with goals nobody has yet. Sort them, with **Hot right now** for the last two weeks, search them, or filter to co-op, PvP or Steam Deck. **Pick for us** chooses one at random, and **Start a vote** posts the usual `/gamevote` card in a channel. Both go by the search and filters, so a vote offers only the games shown. Anyone in a joinable Steam lobby shows at the top with a link to join.
- **Stats:** a range bar picks what each view covers: presets, **Pick dates…** for any days on a calendar, and on Health **Compare with before**, which draws the stretch of the same length just before, faint and dashed. The range is kept in the page's address, so a link or a reload opens the same one. **Overview** starts with game time, games played, people playing, time in voice, sounds played and game nights, each with how it moved from the stretch of the same length before (▲ and ▼, or New) and a small line of how it went over the range. Below are game time over time with the top five games stacked in their own colours and the rest in grey (drag across it to look closer, then **Back**), **Days in voice** (for two weeks to a year, without a game picked: each day on a calendar, shaded by everyone's time in voice added up, or the person picked's; tap a day to look at just it), **When people are on** (for 7 days or more: how many people were on at once, on average, at each weekday and hour), the top games and people with their change, and **Trending** (for 7 to 92 days: the three games played most more and most less than before). Pick a person or a game to see just theirs, with sessions, rank and when it was last played. The range bar stays at the top while scrolling. **Sounds & music** has sounds played, songs played, music heard and lines said, with the same ▲ and ▼ (each only once its records cover the stretch before), how they went over time, the top sounds and who played most, the top songs and artists with what was skipped and where songs came from, who put music on (Autoplay included), and the voices used and who said most. It says when songs and speech started being noted, and never shows what was said. People who've left the server aren't listed. **Compare** is `/compare` with every game two people both own and their achievements in any of them, between people with time in voice or a game played there, and **Monthly recap** is `/recap`. **Health** shows how the bot and its containers are doing: see [Health](#health).
- **Discord's soundboard:** on Soundboard → Manage, see what fills the slots, play or save any sound, and swap sounds between Discord and the library.
- **Merging games:** on Stats, Merge games puts different spellings of a game together, and Separate on a clicked game takes one back out. A clicked game can also be marked **Not a game**, with Undo, and **Not games** lists those with a way back.
- **Activity:** a history of changes to sounds, games, pings, Steam accounts, music, settings and game nights, made here or in Discord, and who made them.
- **Settings:** everything in `/setup`, for each server, game ping roles, everyone's join sounds, which free games are being posted or hidden and why, and what's on sale now. Anything that needs fixing comes first, as in `/setup show`, each with **Go to setting**, and says so under the setting too; the channel pickers mark channels the bot can't post in, and the hop-on role picker roles above the bot's. **On this device** holds what's just for that browser: the music player at the bottom and the Sounds button. **Find a setting** narrows them by name or description and **Jump to** goes to a group. The looping room and free games are folded, saying what they're set to, and so are the previews of what's free and on sale. A setting left at its default says nothing; a changed one says **Changed** with **Reset to** its default, and **Saved** shows beside a field when it's saved. **Who gets pinged** changes anyone's hop-on and game pings, as `/notify` and `/pings` do.
- **Posting to Discord:** **Post panel** on Soundboard → Manage is `/sound panel`, and **Post Choose games button** on Settings is `/gamerole menu`.

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

Use the `ghcr.io/chuck-amuck/slopkeeper-web` image (the reference [`docker-compose.yml`](docker-compose.yml) has it), or build it from `web/Dockerfile`. It serves plain HTTP, so keep it on your home network or put it behind a proxy that adds HTTPS.

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
| `SALE_CHECK_HOURS` | 6 | How often Steam prices are checked, for every server at once. Posts go out once a day, at each server's sale post time |
| `ITAD_API_KEY` | none | An [IsThereAnyDeal](https://isthereanydeal.com) API key, for [other stores' Steam keys](#other-stores) and the lowest price ever in sale alerts, and for [bundles](#bundles). Sign in, register an app under your account's apps page, and copy its API key |
| `GGDEALS_API_KEY` | none | A [gg.deals](https://gg.deals) API key, from your gg.deals account settings, for the cheapest [key reseller](#other-stores) beside a sale. Your account's email address must be confirmed |
| `TZ` | UTC | The container's time zone, and every server's default time zone |
| `API_TOKEN` | off | Turns on the [management API](#management-api) and is the token that unlocks it |
| `API_PORT` | 8787 | Port for the management API |
| `DATA_DIR` | `./data`, `/data` in the image | Where the database, sounds and backups are kept |
| `VOICE_URL` | off | Where the [voice container](#the-voice-container) is. Unset turns `/say` off |
| `CUSTOM_VOICES` | none | [Your own voices](#your-own-voices), as JSON. Set it on the voice container too |
| `MUSIC_URL` | off | Where the [music container](#the-music-container) is. Unset turns music off |
| `LOOP_BOT_URL` | off | Where the [loop bot](#the-loop-bot) is. Unset plays the looping room on this bot |
| `LOOP_TOKEN` | none | Same value as the loop bot's `LOOP_TOKEN` |
| `LOOP_PORT` | 8788 | The loop bot's port, set in its own container |
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
| `GET /guilds/:id/sounds` | Lists sounds, Discord slots, the sound groups in order and the server's emoji. A sound cut from a link has `link` (`url`, `title`, `start`, `end`), and `links` is null when there's no music container to add from links |
| `POST /guilds/:id/sound-links` | Downloads a video or track to cut a sound from: `{ "url": "https://..." }`. Returns its `id`, `title`, `artist`, `seconds` and whether it has `video`. The bot forgets it after an hour unused, or on a restart |
| `GET /guilds/:id/sound-links/:download/media` | Sends the downloaded video or track |
| `GET /guilds/:id/sound-links/:download/wave` | Its waveform, as about 2,000 peaks from 0 to 1 |
| `PUT /guilds/:id/sound-links/:download` | Saves part of it as a sound: `{ "name": "...", "start": 2, "end": 4.5, "discord": true }`, up to 3 minutes. A taken name gets 409 unless `"replace": true` or `"keep": true`, as for uploads |
| `PUT /guilds/:id/sounds/:name?file=<filename>` | Adds a sound; the body is the file. A taken name gets 409 unless `&replace=1`, which moves the old sound to Recently deleted, or `&keep=1`, which adds it under the next free name. The reply gives the name it's under. `&discord=0` keeps a new sound off Discord's soundboard |
| `PATCH /guilds/:id/sounds/:name` | Renames it, sets its emoji, volume or star (the Favourites group), or moves it: `{ "name": "..." }`, `{ "emoji": "..." }`, `{ "volume": 50 }`, `{ "favourite": true }`, `{ "place": { "group": 3, "before": "airhorn" } }` (leave out `before` for the end of the group; `"group": null` takes it out of every group). A move answers with the groups as they are now |
| `POST /guilds/:id/sound-groups` | Makes a group at the bottom: `{ "name": "Reactions" }`. It answers with the groups as they are now, as do the two below |
| `PATCH /guilds/:id/sound-groups/:group` | Renames a group or moves it: `{ "name": "..." }`, `{ "to": 0 }` (its place, counting from 0 at the top) |
| `DELETE /guilds/:id/sound-groups/:group` | Deletes a group. Its sounds go back among the rest |
| `DELETE /guilds/:id/sounds/:name` | Moves it to the bin for 30 days. Returns `binId`, its id in the bin |
| `GET /guilds/:id/sounds/:name/audio` | Downloads its audio |
| `POST /guilds/:id/sounds/:name/play` | Plays it in a voice channel with people in it: `{ "channelId": "..." }` |
| `GET /guilds/:id/deleted-sounds` | Lists what's in the bin, newest first |
| `POST /guilds/:id/deleted-sounds/:deleted/restore` | Brings it back, and says what it's called now |
| `DELETE /guilds/:id/deleted-sounds/:deleted` | Erases it for good |
| `GET /guilds/:id/game-names` | Every game with what else it's been called |
| `POST /guilds/:id/game-names/merge` | Merges games: `{ "names": ["A", "B"], "into": "A" }` |
| `POST /guilds/:id/game-names/separate` | Puts a spelling back as its own game: `{ "name": "B" }` |
| `POST /guilds/:id/game-names/not-a-game` | Leaves a game out of everything, as not a game: `{ "name": "launcher" }` |
| `POST /guilds/:id/game-names/a-game` | Counts a game marked as not a game again: `{ "name": "launcher" }` |
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
| `GET /guilds/:id/deals` | The Deals tab: what's on sale with how it compares with the lowest price ever (`lowest`: `yet` and `text`) and who wants or wishlisted each (`people`), and the bundles with games for the server as last worked out (`bundles` and `bundlesAt`; null before the first look, or with `bundlesOff` saying `no-key` or `off`) |
| `GET /guilds/:id/games` | Lists the game library with owners, who needs each game, who wants it, any sale and `played` (time in voice here and when it last was, or null), plus the server's members |
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
| `GET /guilds/:id/volumes` | The volumes the web UI's sliders show: `sounds`, `speech`, `music`, `loopSound` and `loopSpeech`, each null when that part isn't set up |
| `POST /guilds/:id/stop` | Stops every sound and any spoken lines waiting, leaving the music playing. Returns `musicPlaying` |
| `GET /guilds/:id/playing` | The sounds and speech playing, not the music: `version` and `playing` (`id`, `name`, `kind` sound or speech, `loop`, `started` once it's heard, `elapsedMs`). With `?after=<version>` it waits up to 25 s for a change |
| `POST /guilds/:id/playing/:playingId/stop` | Stops one of them. 404 if it's already finished |
| `GET /guilds/:id/updates?playing=&music=&voice=&nights=&activity=&sounds=&volumes=&health=&deals=` | Waits up to 25 s until any part asked for has a version other than the one given (empty for none yet), then answers with only those that changed, each with its new `version`: `playing` as from `/playing`, `music` as from `/music`, `voice` as from `/voice`, `nights` as from `/game-nights`, `activity` as the newest page of `/activity`, `sounds` as from `/sounds` with the bin from `/deleted-sounds` as `bin`, `volumes` as from `/volumes`, and `health` with only its `version`, which changes as each minute of [performance numbers](#performance-numbers) is kept, and `deals` likewise, which changes after each price check and each look through the bundles. Ask for any of them. Answers `{}` if nothing changed. The page keeps up through this, one request per tab |
| `GET /guilds/:id/say` | Whether text to speech is `on`, the `voices` (each with its `group`: Characters, Accents or Effects), the default `voice`, the `longest` line and the saved `phrases`. The speech volume is in `/volumes` |
| `GET /guilds/:id/say/preview?voice=<id>&text=<text>` | The line in that voice as a WAV file, for the page to play to whoever asked; a blank `text` has the voice say its name. At most one every 2 seconds and 12 a minute per server |
| `POST /guilds/:id/say` | Reads out `text` in `channelId`, with an optional `voice`. Answers once the line starts |
| `POST /guilds/:id/phrases` | Saves `text`, and answers with the `phrases` |
| `DELETE /guilds/:id/phrases/:id` | Removes a saved line, and answers with the `phrases` |
| `GET /guilds/:id/music` | What's playing, how far in, the queue, the music volume and why music can't play, if it can't. `since` is when the music started, the same through pauses, skips and restarts until it stops. It and every music control's answer carry the `version` that `/updates` counts, so a page can tell an older answer from a newer one |
| `GET /guilds/:id/music/search?q=<words>` | Up to 10 songs from Spotify |
| `POST /guilds/:id/music/queue` | Adds a search result `{ "track": {...} }`, what's typed `{ "query": "<words or link>" }` or an upload `{ "file": "<id>" }`, at the end or `"next": true`. With nothing queued, `"next": true` plays it now in `"channelId"` if anyone's there |
| `POST /guilds/:id/music/file?name=<filename>` | Uploads an audio file to add; the body is the file. Up to 60 MB and 20 minutes, and 500 MB of uploads for each server. Answers with the `file` (`id`, `title`, `artist`, `durationMs`) for `POST music/queue`, which has an hour to add it |
| `DELETE /guilds/:id/music/file/:file` | Throws away an upload that hasn't been added |
| `POST /guilds/:id/music/queue/:song/move` | Moves a song: `{ "to": 2 }`, counting from 0. The song playing stays first, people's songs stay ahead of Autoplay's, and Autoplay's don't move |
| `POST /guilds/:id/music/queue/:song/keep` | Keeps one of Autoplay's songs, as if it had been queued: it goes after people's songs, and Autoplay follows it |
| `DELETE /guilds/:id/music/queue/:song` | Takes a song out, skipping it if it's playing |
| `DELETE /guilds/:id/music/queue` | Empties the queue, apart from the song playing |
| `POST /guilds/:id/music/play` | Starts or carries on in a voice channel: `{ "channelId": "..." }` |
| `POST /guilds/:id/music/pause`, `skip` and `stop` | As `/music` does. Stop clears the queue |
| `GET /guilds/:id/game-nights` | Lists upcoming game nights and repeating series, and what a new night can be set to |
| `POST /guilds/:id/game-nights` | Plans a night as `/gamenight plan` does: `{ "game", "when", "channelId", "hostId", "voiceChannelId", "details", "repeat" }`, where `repeat` is 7, 14 or null |
| `GET /guilds/:id/game-nights/:night/friends` | Who's going but isn't Steam friends yet, with profile links: `strangers`, `unknown` where both lists are private, and `unlinked` |
| `GET /guilds/:id/game-nights/when?text=<time>` | Says how a typed time reads, without planning anything |
| `POST /guilds/:id/game-nights/:night/rsvp` | Answers `{ "answer": "in" \| "maybe" \| "out", "userId" }` as the card's buttons do, and redraws the card. Someone signed in who has said who they are always answers for themselves |
| `PATCH /guilds/:id/game-nights/:night` | Changes a night as its Edit button does: any of `{ "game", "when", "details", "voiceChannelId" }`, where null clears details or the voice channel. Returns what `changed`, an `eventNote` if the Discord event couldn't follow, and the `night` as listed. The listing's `when` is the night's time in a form that reads back exactly |
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
| `GET /guilds/:id/pick/options` | Lists the members, voice channels and text channels to choose from, and `pickable`: the members whose games the bot knows |
| `POST /guilds/:id/votes` | Starts a vote: `{ "voiceChannelId", "channelId", "minutes", "games" }`, with 1 to 10 minutes. `games`, a list of names, narrows it to those games |
| `GET /guilds/:id/compare?a=<id>&b=<id>` | Compares two people, as `/compare` does |
| `GET /guilds/:id/compare/people` | Lists the members with time in voice or a game played there, to compare |
| `GET /guilds/:id/recap?month=<last\|this>` | A month's highlights, as `/recap` shows them |
| `GET /guilds/:id/members/:user/pings` | Lists the hop-on and game ping roles, and which someone has |
| `PUT /guilds/:id/members/:user/pings` | Turns one on or off: `{ "roleId": "...", "on": true }`. Other roles can't be changed |
| `POST /guilds/:id/sound-panels` | Posts a soundboard panel: `{ "channelId": "..." }` |
| `POST /guilds/:id/game-pings/menu` | Posts the Choose games button: `{ "channelId": "..." }` |
| `GET /guilds/:id/activity?before=<id>` | The last year of changes to sounds, settings and game nights, 50 at a time, newest first |
| `GET /guilds/:id/me` | Who's signed in through Pangolin, and which member they said they are |
| `PUT /guilds/:id/me` | Says which member the signed-in person is: `{ "userId": "..." }` |
| `DELETE /guilds/:id/me` | Unlinks them |
| `GET /guilds/:id/stats?period=<today\|week\|month\|quarter\|year\|thisYear\|all>&user=<id>&game=<name>` | Game and voice totals with sounds and game nights, the same for the stretch just before (`previous`, null when the records don't reach back that far, or for all time), game time over the period with the top five games apart (`activity`), people, voice time and sounds per step (`series`), when people are on by weekday and hour (`when`, for 7 days or more), each day's time in voice (`calendar`, for 14 to 400 days without a game: `day`, `start`, `end` and `ms`) and the games that moved most (`trending`), plus sessions, rank and when it was last played where a person or game is chosen. `recordsFrom` and `voiceFrom` say when the server's records, and its full voice records, start. Instead of `period`, `fromDate` and `toDate` (`YYYY-MM-DD`, both included, in the server's time zone) or `from` and `to` (milliseconds) pick any range; `since` and `until` in the answer say what was counted |
| `GET /guilds/:id/stats/sounds?period=…` | Stats → Sounds & music, over the same ranges as `/stats`: `totals` (sounds, songs, `listenedMs`, `skipped`, lines) and `previous` (each null until its records cover the stretch before), counts per step (`activity`), the top ten `sounds`, `soundPeople`, `songs`, `artists`, `djs` (Autoplay as `autoplay`), `sources`, `voices` and `speakers`, the ways lines were said (`kinds`) and when each kind of record starts (`from`). Only current members are listed, and what was said isn't kept |
| `GET /guilds/:id/settings` | Lists settings, the `groups` they're shown in (as in `/setup show`), channels (with `canPost`), roles (with `canGive`), time zones, and `problems`: `{ key, text, at? }` for anything stopping the bot, `key` being the setting that fixes it |
| `PUT /guilds/:id/settings/:key` | Changes a setting: `{ "value": ... }` |
| `DELETE /guilds/:id/settings/:key` | Puts a setting back to its default |
| `GET /guilds/:id/health?range=<1h\|24h\|7d\|30d>` | What the [Health](#health) view shows over the range (24 h if left out): each part judged `fine`, `slow`, `bad` or `quiet`, what held things back (`verdict`), the machine, every container, the points of each chart (`start`, `step` and `points` say when), and this server's slow list. Instead of `range`, `fromDate` and `toDate` (`YYYY-MM-DD`) or `from` and `to` (milliseconds) pick any stretch of the last 30 days, with a point every 1, 5 or 15 minutes, or every 1, 3 or 6 hours, whichever keeps it to 240 points |
| `GET /metrics` | The [performance numbers](#performance-numbers), in Prometheus's text format |
| `POST /perf/web` | The web UI's report of itself every 30 seconds: `{ "memoryBytes": ..., "memoryLimitBytes": ..., "cpuSeconds": ..., "stallSeconds": { "cpu": ..., "memory": ..., "io": ... }, "cpuPeriods": ..., "throttledPeriods": ..., "oomKills": ..., "requests": { "2xx": 40 }, "botUnreachable": 0 }`. The voice, music and loop containers answer `GET /stats` with the same usage |
| `POST /perf/browser` | A browser's timings, which the web UI passes on about once a minute per open tab: `{ "via": "home" or "away", "device": "phone" or "computer", "requests": [["action" or "load", seconds, bot's seconds]], "page": { "firstByte": ..., "shown": ... }, "responses": [seconds], "quickResponses": 3 }` |

### Performance numbers

The bot keeps track of how it and its containers are doing, so a slow moment can be traced to where it came from. It needs nothing set up, and keeps everything in its own database.

- **Discord:** whether the bot is connected, the gateway's heartbeat round trip and reconnects, and how long each command, button and menu takes to get its first answer to Discord. Discord gives up after 3 seconds, and answers that came too late are counted.
- **Playing:** how long a sound, a line of speech or a song takes from being asked for to being heard, including joining voice. A line is timed step by step: waiting behind other lines, the voice container saying it (and loading the voice, if it wasn't in memory), levelling and effects, and starting. A song is timed through its download, and whether the music container had it already. Also how long joining voice takes, joins that time out, voice connections that drop, and audio mixed late, which people hear as a stutter. The loop bot's joins that time out and connections that drop are counted too, labelled `bot="loop"`, from its `GET /stats`.
- **The bot itself:** how late its timers run (event loop delay, where an idle bot reads about 0), how busy it is, its JavaScript memory, and its garbage collection pauses.
- **Every container:** memory as `docker stats` counts it, its limit, CPU, the time something in it waited for CPU, memory or the disk (Linux's pressure stall information), how often its own CPU limit held it back (the share of its 100 ms CPU periods it was throttled in), and processes killed for going over its memory limit. The bot asks the voice, music and loop containers on `GET /stats` every 30 seconds, and the web UI reports itself to the bot. A container that doesn't answer for 90 seconds is marked down.
- **The machine they run on:** every 15 seconds the bot reads `/proc`, which a container shares with the machine: how busy its CPUs are, time spent waiting on the disk, CPU time the hypervisor gave to other machines, memory in use, swap in use and pages swapped a second, the time anything on it waited for CPU, memory or the disk, and the free space on the disk holding the bot's data. It covers every app on the machine, not just these containers.
- **People's browsers:** each open web UI tab times how long taps take to be answered (split into the bot's part, from the `Server-Timing` header the web UI adds, and the network's), how long the page takes to open (its largest content, or the load event in Safari), and how long the page takes to visibly react to a tap or key press (Chrome, Edge and Firefox). It sends them about once a minute while it's seen, and once more as it closes. The web UI adds whether it came through Pangolin (away) or not (home), and the tab says phone or computer. Nothing in them says who it was. Live updates and uploads aren't timed.
- **The web UI and the API:** the web UI's answers by status, requests the bot didn't answer, and how long the management API takes to answer, by area. Requests that wait for a change on purpose (live updates) are counted but not timed.

They're kept a minute at a time for 2 days, then 15 minutes at a time for 30 days, about 25 MB in all. The [daily backups](#hosting-the-bot) leave them out. Anything slow is kept for 30 days with how long each step took, up to the newest 500: a command that took 2 seconds or more to answer, a sound 2 seconds to start, a line 4 (plus 3 for each 1,000 characters), a song 8, or a page's data 2. Time spent waiting behind other lines doesn't count toward that. Speech keeps its voice and length, never its words.

`GET /metrics` answers in Prometheus's text format, for Prometheus and Grafana if you run them, though nothing needs them. Every name starts with `slopkeeper_`, in seconds and bytes. Speech making is timed by `length`: `short` (300 characters or fewer) or `long`; before that label it was one series. A Prometheus on the same container network can scrape it with the API token:

```yaml
scrape_configs:
  - job_name: slopkeeper
    authorization:
      credentials: <API_TOKEN>
    static_configs:
      - targets: ["slopkeeper:8787"]
```

#### Health

Stats → **Health** in the web UI shows these numbers to anyone who can open it, over the last hour, 24 hours, 7 days or 30 days, or any days of the last 30 picked on a calendar. Dragging across a chart with a mouse looks closer at that stretch, and **Back** returns to the range before. A preset keeps up as each minute is kept. Everything but the slow list covers the whole bot, which every server it's in shares.

- **What held it back?:** whether the machine was short of CPU, memory or disk, a container reached its own CPU or memory limit, or garbage collection paused the bot. If none of those, but something people waited on was slow, it says so: that's the bot's own work or what it waited on, like YouTube or Discord, and Slowest recently shows which step.
- **Summary:** Discord, commands and buttons, sounds, speech, music, stutter, the bot, the web UI, and the web UI as people see it in their browsers, at home and away and on phones and computers, each marked **Fine**, **Slow** or **Bad** over the range. Speech is judged by lines of 300 characters or fewer, as a paragraph takes seconds more to make.
- **Containers:** each one's memory against its limit, CPU, waiting for resources, time held back by its CPU limit, processes killed for memory, and any time it didn't answer.
- **The machine it runs on:** its cores, memory, swap and disk, with charts of its CPU (busy, waiting on the disk and taken by the host), memory in use, time waiting for each resource, and swapping.
- **Web UI as people see it:** taps answered and the page opening, at home and away.
- **Charts:** the 95th percentile of commands answered, sounds starting, speech made and songs starting, each with a dashed line where it stops being fine, then memory, CPU and waiting for resources by container, Discord's ping with time away shaded, and the bot's lag. Point at one, or use the arrow keys, to read every line at that time, and **Show as a table** lists them. The charts are drawn by [Apache ECharts](https://echarts.apache.org) (Apache 2.0), and the calendar is [Cally](https://wicky.nillia.ms/cally/) (MIT), both built into `web/public` by `scripts/build-vendor.sh` with their licences in `web/vendor-licences`.
- **Slowest recently:** this server's slow ones, slowest or newest first. Each shows its steps, with time spent waiting behind others in grey and left out of the ranking.

| | Fine below | Bad from |
|---|---|---|
| Commands answered, 95% within | 1.5 s | 3 s |
| Sounds start, 95% within | 1 s | 3 s |
| Speech made (300 characters or fewer), 95% within | 2.5 s | 5 s |
| Music starts, 95% within | 8 s | 15 s |
| Stutter: audio mixed late | 0.5% | 2% |
| Bot lag, at its worst point | 100 ms | 500 ms |
| A container's memory now, of its limit | 80% | 90% |
| Web UI answers that failed or found the bot gone | 1% | 5% |
| Taps answered in people's browsers, 95% within | 500 ms | 1.5 s |
| The page opening, 95% within | 3 s | 6 s |
| The page reacting to a tap, 95% within | 200 ms | 500 ms |
| The machine's CPU busy, at its worst point | 80% | 95% |
| The machine's CPU taken by the host, at its worst point | 5% | 15% |
| The machine's memory in use, at its worst point | 85% | 95% |
| Pages swapped a second, at its worst point | 100 | 1,000 |
| Time something waited for CPU, at its worst point | 10% | 25% |
| Time something waited for memory, at its worst point | 2% | 10% |
| Time something waited for the disk, at its worst point | 10% | 30% |
| The data disk, full | 85% | 95% |
| A container held back by its CPU limit, at its worst point | 5% | 20% |
| The bot paused for garbage collection, at its worst point | 3% | 10% |

Between the two is **Slow**. A worst point is the worst of the chart's points, each an average over its minute, 15 minutes, hour or 6 hours. Discord is **Slow** after 2 minutes away in the range, and **Bad** while it's away. A container is **Bad** while it isn't answering or if a process in it was killed for memory, and **Slow** if it went down, its memory reached 90% at any point in the range, or its CPU limit held it back. A process killed for memory is counted only while the container keeps running: when it's the container's main process, the container restarts and shows as down instead. Commands are **Slow** if any failed or came too late, and speech if any line failed.

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
        memory: 2048M
  volumes:
    - slopkeeper-voice:/voices
```

Set `VOICE_URL=http://voice:5000` on the bot, and don't publish the port. On first start it downloads twenty-five models (about 1.7 GB) into its volume, and after that it needs no internet:

- `en_US-libritts_r-medium` (79 MB, CC BY 4.0) holds 904 voices. The effect styles are built on three of them, with ffmpeg effects added by the bot.
- The character voices are community models, 61 to 109 MB each, fetched at a fixed version and checked against their hashes. If one can't be fetched, its voice talks with the first model until the container restarts.
  - [GLaDOS](https://huggingface.co/NullPoExc/piper-glados) (no license given)
  - [HAL 9000](https://huggingface.co/OccultAI/HAL-9000-Piper-TTS) (Apache 2.0)
  - [Bender](https://huggingface.co/Schmalvis/bender-tts-model) (no license given)
  - [Optimus Prime](https://huggingface.co/crazygiscool/optimus-piper-voice) by crazygiscool (CC BY-NC 4.0: non-commercial use only)
  - [Kronk](https://huggingface.co/russdill/kronk) (no license given)
  - TikTok, from cosycove's BeefStew, which is no longer online, via a copy in [fox3000foxy/piper-voices-collection](https://huggingface.co/fox3000foxy/piper-voices-collection) (no license given)
  - [JARVIS](https://huggingface.co/vishalrao8/piper-jarvis-high) (MIT)
  - [Rocket Raccoon](https://huggingface.co/AkumaVenom/RocketRacoon-Piper-US-Medium) (no license given)
  - [Death](https://huggingface.co/drewThomasson/piper_tts_finetune_death_from_puss_and_boots) (MIT)
  - [BMO](https://huggingface.co/ziadnotme/bmo-tts-piper) (no license given)
  - [Counter-Strike announcer](https://huggingface.co/RoxasYTB/piper-checkpoints-css-announcer-en) (no license given). Its settings list seven speakers though the model takes none, so the container treats any model like that as having one
  - Bobby, Carl and Patrick, from simoniz0r's piper-voice-models, which is no longer online, via the same collection (no license given)
- The English accents are Piper models trained on English readers, 61 to 74 MB each.
  - Scottish is [`en_GB-alba-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_GB/alba/medium) (CC BY 4.0).
  - Northern English is [`en_GB-northern_english_male-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_GB/northern_english_male/medium) and the Southern English woman [`en_GB-southern_english_female-low`](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_GB/southern_english_female/low) (both CC BY-SA 4.0). The woman is only made in low quality.
  - The Southern English man is the first speaker of [`en_GB-southern_english_male-medium`](https://huggingface.co/csukuangfj/vits-piper-en_GB-southern_english_male-medium), packaged for sherpa-onnx (Apache 2.0), as Piper's own list has only the woman.
  - Irish is Jenny (Dioco), [`en_GB-jenny_dioco-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_GB/jenny_dioco/medium), whose [recordings' license](https://github.com/dioco-group/jenny-tts-dataset) asks for the voice to be called Jenny.
  - Australian is two of the ten LibriVox readers in [`en_AU-librivox-medium`](https://huggingface.co/DataCraftsmanAustralia/piper-en_AU-librivox-medium) (CC BY 4.0), the lowest and highest voiced.
- The accents are official Piper models in other languages, 63 to 77 MB each. A model reads English as noise or by its own spelling, so `voice/accent.py` turns English into the nearest sounds of its language first, with the habits that make the accent.
  - State broadcast is [`ko_KR-kss-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/ko/ko_KR/kss/medium) (CC BY-NC-SA 4.0: non-commercial use only), with a loudspeaker's narrow, compressed sound and echo added by the bot.
  - Russian is [`ru_RU-dmitri-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU/dmitri/medium) (CC0).
  - Spanish is [`es_ES-davefx-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/es/es_ES/davefx/medium) (CC0).
  - German is the neutral speaker of [`de_DE-thorsten_emotional-medium`](https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/thorsten_emotional/medium) (CC0), which also has amused, angry, disgusted, drunk, sleepy, surprised and whispering speakers.

`VOICES` in `src/features/say.ts` lists the built-in voices. Each model loads the first time it's used, and a model other than the first one that hasn't spoken for 30 minutes is let go again, so the next line in that voice takes about a second longer. `VOICE_IDLE_MINUTES` in the container's `environment` changes the 30 minutes, and `0` keeps every model loaded. At most ten models besides the first stay loaded: past that, the one that spoke longest ago is let go. `VOICE_MAX_MODELS` changes the ten, and `0` takes the limit off. With eleven loaded it uses about 1.3 GB, and a long line at the slowest speed briefly takes it near 1.7 GB; with only the first one it's about 200 MB. A larger custom model takes more, so with several of those lower `VOICE_MAX_MODELS` or raise the memory limit. It makes a short line in about a second on two CPU cores.

#### Your own voices

`CUSTOM_VOICES` adds voices from any [Piper](https://github.com/OHF-Voice/piper1-gpl) model without changing the code, such as ones from [Hugging Face](https://huggingface.co/models?other=piper). It's a JSON list on one line, set on the bot in `.env` and on the voice container (the reference `docker-compose.yml` passes it on from `.env`):

```sh
CUSTOM_VOICES=[{"id":"narrator","name":"Narrator","model":"https://huggingface.co/<owner>/<repo>/resolve/<commit>/<file>.onnx"}]
```

| Field | Meaning |
| --- | --- |
| `id` | Required. 1 to 32 lowercase letters, digits, `-` or `_`, and not a built-in voice's id |
| `name` | Required. Up to 40 characters, as the voice lists show it |
| `model` | Required. The `https://` address of the model's `.onnx` file. A Hugging Face download link works; with a commit in place of `main` it always gets the same file |
| `config` | The model's settings. By default, the model's address with `.json` added |
| `sha256`, `configSha256` | The files' hashes, checked when given. Without them, the voice container logs the hashes it got, ready to paste in |
| `group` | `Characters` (the default) or `Accents` |
| `speaker` | For a model with several speakers, which one, from 0 |
| `volume` | dB from -20 to 20, to make it as loud as the other voices. Levelling squeezes loud speech, so a cut lowers it by about half as much |
| `pace` | 0.5 to 2. Multiplies how long it takes to talk, for a voice that sounds rushed: 1.1 is 10% slower |
| `noise` | Two numbers from 0 to 2, Piper's `noise_scale` and `noise_w_scale`. Lower ones give a steadier voice and timing |

The voice container downloads each model when it starts, once, and again only when its address changes, and deletes one that's no longer listed. A voice whose model couldn't be fetched talks with the first model, and an entry that can't be used is skipped, with the reason in the logs of the bot and the voice container. A server whose voice was removed from the list goes back to its default voice.

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

YouTube changes often and old yt-dlp versions stop working, so the container updates yt-dlp when it starts and daily after that. Each song is about 3 to 9 MB. The container keeps the most recently played songs, up to `MUSIC_CACHE_MB` (1024 by default), so songs played again start at once. It also downloads videos for [adding a sound from a link](#adding-a-sound-from-a-link), at 480p or less, into the volume's `clips` folder, and deletes each an hour after it was last asked for. Those don't count toward `MUSIC_CACHE_MB`. It uses about 100 MB of memory, and more for a moment while a song downloads. Settings and the Music tab say if yt-dlp isn't working. The bot reads the audio from `MUSIC_AUDIO_DIR`, `/music/audio` by default, which is the volume's `audio` folder.

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

Local dev (Node 24+): `npm install && npm run dev`. `npm run typecheck` runs tsc, and `npm test` runs the tests (the audio ones need ffmpeg and are skipped without it). GitHub Actions runs them on every push, with the same static ffmpeg as the image, and each image is only built once its own checks pass.

Data (SQLite DB and uploaded sounds) lives in the `slopkeeper-data` volume at `/data`, with each server's sounds in `sounds/<server id>/`, and the first version of any trimmed sound in `originals/` inside that. The bot copies its database to `backups/` in that volume once a day, beside the bot rather than holding it up, and keeps the last 7 copies, leaving out the [performance numbers](#performance-numbers). Those guard against a bad update or a damaged database, not against losing the disk, and they don't include sounds, so back the volume up elsewhere too.

Voice sessions in progress are saved when the bot stops, without a recap, so a restart mid-session splits it in two. A crash loses them. Game stats are saved every 5 minutes and when the bot stops, so a crash loses at most a few minutes of them.

### Adding the bot to a server

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

Then tell people to run `/steam link`, `/notify` and `/pings` (see [Getting started](#getting-started-for-everyone-in-the-server)), and post a `/sound panel` somewhere handy.
