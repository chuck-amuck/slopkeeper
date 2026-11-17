# Getting together

Pings for when people hop in voice or start a game, and game nights people can say they're coming to.

## Hop-on pings

When a voice channel reaches 2 people, the bot posts in the announce channel. The post names who's there and what they're playing, and pings the hop-on role (set with [`/setup hopon-role`](server-setup.md#server-settings)) plus the [game ping](#game-pings) role of each game being played. It fires once as the channel reaches that number, not on every join after. It then waits 2 hours before pinging again, so a busy evening doesn't spam. The AFK channel and bots don't count. Both numbers can be changed with `/setup hopon`. The post has a **Join** button that opens the voice channel, and **On my way**, which adds your name to the post (press it again to take it off).

| Command | What it does |
| --- | --- |
| `/notify` | Turns hop-on pings on for you by giving you the hop-on role. Run it again to turn them off. Only you see the reply. If the server doesn't let the bot hand out that role, it says a server admin will have to give it to you (or take it off). |

## Game pings

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

## Game nights

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
