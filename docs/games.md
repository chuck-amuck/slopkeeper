# Playing games

Linking Steam, picking a game everyone in voice owns, and the server's game library.

## What do we play?

| Command | What it does |
| --- | --- |
| `/whatdoweplay [type] [deck]` | Run it in voice. It picks a random game everyone in your channel can play. `type` keeps to co-op or PvP games and `deck` to Steam Deck ones, both from Steam's store. |
| `/gamevote [minutes]` | Run it in voice. Everyone in your channel votes on the games they all own. It's open 1 minute by default, up to 10. |

[Chat](chat.md#what-it-can-do) does both too: "just pick one", "reroll", "start a vote on what to play".

A game qualifies if Steam tags it multiplayer, co-op or PvP, or it's in the [game library](#game-library). A library game with a player cap is skipped when there are more people than that, and games hidden with **Never suggest this** are skipped.

The answer also shows **Also works** (other games everyone owns, most played first), **One purchase away** (games all but one person owns, and who needs to buy them) and **Not counted** (people whose games the bot doesn't know, left out rather than blocking every game: no Steam link and no games marked, or a private profile it has never seen the games of; a profile made private keeps the games seen before).

- **🎲 Reroll** picks again, for the same people and options. Anyone can press it.
- **🗳️ Vote** starts a 1-minute vote on up to 10 of the games: the 5 played most here, then a random mix. Everyone in the channel gets one vote, it closes when they've all voted, and a tie is settled at random.
- **Never suggest this** hides the game from future picks. `/game unhide` or the web UI's Games page brings it back.

## Steam accounts

The bot knows who owns what from linked Steam libraries, which sync every 6 hours (and again before a pick, if more than an hour old), and from games marked with `/game own`.

| Command | What it does |
| --- | --- |
| `/steam link profile [user]` | Links a Steam account by profile URL, vanity name or SteamID64, for you or `user`. **Link my Steam** buttons on `/steam list` and `/whatdoweplay` do the same. |
| `/steam unlink [user]` | Removes a link and forgets that library. |
| `/steam list` | Everyone who's linked. 🔒 means their game details are private, so the bot can't see their games. |
| `/steam family with [user]` | Says you (or `user`) share a Steam family with `with`. |
| `/steam unfamily [user]` | Takes someone out of their family. |
| `/steam friends` | Run it in voice: who there still needs to add each other on Steam. |
| `/steam lobbies` | Who's in a joinable Steam lobby right now. |
| `/steam refresh` | Re-reads every linked library now, say right after someone buys a game. |

The web UI's Games page does all of this for anyone, under **Steam accounts**.

**Steam families:** Steam doesn't say who's in a family, so you tell the bot (up to 6 people, in every server). Someone in a family counts as owning a game a family member owns, if Steam tags it for Family Sharing. Each person playing at once needs their own copy, so two people sharing one copy show as one short. The bot can't see whether an owner outside the group is using their copy, and games only marked by hand don't count for the family.

**Steam status:** every minute, the bot checks what linked members in voice are playing on Steam. When Discord shows no game for someone, their Steam game counts for game time, recaps and hop-on pings. It needs public game details, and `/setup steam-status` turns it off.

## Game library

The library is the group's list of games it cares about. Add a game when you want sale alerts for it, it has a player cap, it isn't on Steam, or Steam doesn't tag it multiplayer but you play it together.

| Command | What it does |
| --- | --- |
| `/game add name [steam] [max_players]` | Adds a game. `steam` takes the store URL or app ID, for sale alerts and Steam ownership. `max_players` is the most one lobby holds. |
| `/game want name` | Pings you when a game goes on sale, and adds it to the library. Takes a name or a Steam store link. |
| `/game own name [user]` | Marks a game as owned by you or `user`, for games that aren't on Steam or that someone plays through Family Sharing. |
| `/game list` | Every library game, its player cap, who owns it and who still needs it. |
| `/game remove name` | Removes a game and its marks. **Undo** puts it back for 15 minutes. |
| `/game unhide name` | Lets `/whatdoweplay` suggest a hidden game again. |

Running `/game want` or `/game own` again, or pressing **Undo**, takes it back.

```
/game add name:Deep Rock Galactic steam:https://store.steampowered.com/app/548430 max_players:4
/game own name:Minecraft user:@Alex
```

## Achievements

| Command | What it does |
| --- | --- |
| `/achievements game [with]` | Steam achievement progress for you and `with`, or everyone in your voice channel, plus goals nobody there has yet. Hidden achievements aren't named, in case they're spoilers. |

## Patch notes

`/setup patch-notes` posts Steam patch notes for games with a Steam ID played here in the past 30 days, either as they come out or as a **weekly digest** on the leaderboard's day and hour (even with the leaderboard post off). They go to the announce channel or one you pick, never ping anyone, and it's off by default. Turning it on doesn't post a backlog, and games whose developers don't tag their patch notes on Steam are missed.
