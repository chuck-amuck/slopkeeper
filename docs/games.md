# Playing games

Linking Steam, picking a game everyone in voice owns, and the server's game library.

The bot builds a picture of who owns what from two sources:
- **Linked Steam libraries.** These sync every 6 hours. Before a pick, anyone in voice whose data is more than an hour old is synced again.
- **Manual marks** from `/game own`, for games that aren't on Steam or that someone plays through Family Sharing.

## Steam accounts

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

## Patch notes

`/setup patch-notes` posts patch notes for games with a Steam ID that were played in the server in the last 30 days. **Each one** posts them as they're found, and **weekly digest** posts them together on the weekly leaderboard's day and hour, even if the leaderboard post is off, or when the bot is back up to a day later. Notes found after a week's digest wait for the next one. They go to the announce channel, or the channel you pick, and never ping anyone. It's off by default.

It starts from the latest notes, so turning it on doesn't post a backlog. Steam only marks a post as patch notes if the developer tags it, so some games will be missed.

## Achievements

| Command | What it does |
| --- | --- |
| `/achievements game [with]` | Shows Steam achievement progress for you and `with`, or else everyone in your voice channel, plus goals: what nobody there has yet, the most common first. |

Hidden achievements count towards the total, but aren't named as goals in case they're spoilers. Anyone with private game details, no Steam link or no copy of the game is left out, and it says so.

## What do we play?

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

## Game library

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
