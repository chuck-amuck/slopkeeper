# Getting together

Pings when people hop in voice or start a game, and game nights people can say they're coming to.

## Hop-on pings

When a voice channel reaches 2 people, the bot posts in the announce channel who's there and what they're playing. It pings the hop-on role, plus the [game ping](#game-pings) role of each game being played. **Join** opens the voice channel, and **On my way** adds your name to the post.

It posts once as the channel fills, then waits 2 hours before pinging again, so a busy evening doesn't spam. The AFK channel and bots don't count. Settings, under **Voice and pings**, changes both numbers and picks the role.

| Command | What it does |
| --- | --- |
| `/notify` | Turns hop-on pings on or off for you, by giving or taking the hop-on role. |

## Game pings

Game pings are opt-in roles for each game, like **@Valheim**. People pick the games they care about and get pinged when a hop-on ping goes out while that game is being played, or when someone plans a game night for it. They're ordinary mentionable roles, so anyone can ping one by hand too.

| Command | What it does |
| --- | --- |
| `/pings` | A menu of the hop-on role and the game roles, with yours ticked. Only you see it. |
| `/gamerole add game [role]` | **Manage Roles only.** Makes a role for a game, or reuses `role`. Use the name Discord shows under "Playing", so hop-on pings match it. |
| `/gamerole remove game` | **Manage Roles only.** Stops offering a game, and deletes its role if the bot made it. |
| `/gamerole menu` | **Manage Roles only.** Posts a **Choose games** button that opens `/pings` for whoever clicks it. Pin it in a roles channel. |

```
/gamerole add game:Valheim
/gamerole add game:Lethal Company role:@lethal
```

The web UI's Settings page can add and remove game roles too. It only asks for its password, so anyone who has it can do this without **Manage Roles**, though it never makes a role with permissions.

## Game nights

`/gamenight plan` posts an RSVP card and adds the night to the server's **Events**. You can also [ask the bot in chat](chat.md#what-it-can-do): "plan Valheim friday at 9". The card shows the time in everyone's own time zone, the host, the voice channel and who's **In**, **Maybe** or **Can't**.

- The game's ping role is pinged when the night is planned.
- 15 minutes before the start, the bot pings everyone who's **In** or **Maybe** (Settings' **Game night reminder** changes or turns this off).
- The Discord event goes live at the start, and ends 3 hours later or once its voice channel empties, whichever is later.
- **Edit** and **Cancel night** are for the host and anyone with Manage Events. If the time moves, everyone who's **In** or **Maybe** is told and reminded again. Cancelling tells them too.

**Repeating nights:** `repeat` plans one every week or every 2 weeks. Each night gets its own card, event and ping, posted 6 days ahead, at the same local time when the clocks change. **Edit** and **Cancel night** change one night; **Stop repeating** on any card ends the series.

| Command | What it does |
| --- | --- |
| `/gamenight plan game when [voice] [details] [repeat]` | Plans a game night. `when` takes `fri 8pm`, `tomorrow 20:30`, `next sat 9`, `nov 3 7:30pm` or `2026-11-03 19:00`, in the server's time zone. A bare hour like `fri 9` means 9 PM, and the suggestion shows exactly when it'll be before you send. |
| `/gamenight list` | Upcoming game nights, with how many are in. Repeating ones show 🔁. |

```
/gamenight plan game:Valheim when:fri 9pm voice:#gaming
/gamenight plan game:Deep Rock Galactic when:thu 9pm repeat:Every week
```
