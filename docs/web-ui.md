# Web UI

A web page for everything the bot does, running as a second container next to it, for your home network or behind a sign-in proxy like [Pangolin](#signing-in-through-pangolin). It has tabs for the Soundboard, Music, Games, Nights, Pick a game, Deals, Stats, Activity and Settings. On a phone they're a bar along the bottom, with the rest under **More**.

## On every page

- **Play in:** beside the server in the header, the voice channel sounds, speech and music play in, with who's in each. When that channel empties, the next one with people takes over.
- **Stop:** while sounds or speech play, a red button in the bottom corner stops them, with what's playing listed above it to stop one at a time. Music carries on, but the toast after Stop offers **Pause music**.
- **Music player:** while music plays, a card at the bottom shows the song with **Pause**, **Skip** and **+** to add a song.
- **Sounds:** a button that opens the server's sounds, the volumes and a line to say over any page.
- **Volume:** the sounds', speech's and music's volumes, for everyone in the server. Sliders run to 100% at the tick, and the orange last quarter goes past it. The box beside each takes an exact number, and the arrow keys move 5% at a time.
- **Pop out:** in Chrome or Edge 116+, or Firefox 151+, over HTTPS, the Sounds panel and the music player can pop out into a small window that stays on top of everything, a game included.
- **Undo:** removing a song, deleting a sound or saved line, taking a sound off Discord, **Never suggest this** and **Reset** on a setting each offer **Undo** for a few seconds.

Everything updates live, whoever changed it and wherever, and a change waits while you're typing in something it would redraw. If the bot can't be reached, the page says so and retries by itself. After an update, a page left open offers **Reload**. Each tab has its own address, like `#music`, and a phone can add the page to its home screen. Settings → **On this device** hides the music player or the Sounds button in that browser.

## Tabs

**Soundboard:** **Play** has the volumes, a box to say something (with saved lines and a preview in headphones), a search, and the sounds as big buttons in their groups. **/** or typing jumps to the search and **Enter** plays the first match. The star adds a sound to **Favourites**. **Manage** is where sounds are added, from files, folders or [a link](soundboard.md#adding-a-sound-from-a-link), and renamed, grouped, trimmed, turned up or down, downloaded, deleted and put on Discord's soundboard. **Cut another** makes a new sound from another part of the same video or sound. **Recently deleted** brings sounds back. Drag the handle at the start of a row to move a sound, or use Space and the arrow keys. **Post panel** posts a `/sound panel`.

**Music:** what's playing, Spotify search and the queue. See [Music](music.md).

**Game nights:** plan a night, answer **In**, **Maybe** or **Can't**, edit or cancel one, or stop a repeating one. Times show in your time zone, and in the server's when that's different.

**Games:** the game library with who owns, needs and wants each game, and any sale. Add games from what members own on Steam, by name or by store link. **Steam accounts** links, changes and unlinks anyone's account and sets Steam families. Each game's **Manage** has its player limit, Steam link, **Never suggest this** and who owns it.

**Pick a game:** pick a voice channel, or tick people to plan before anyone's on, and see the games everyone owns or is one purchase away from, as `/whatdoweplay` does. Each game shows time played here and on Steam, and opening one shows who's playing it now, its latest patch and **Achievements**. Filter to co-op, PvP or Steam Deck, then **Pick for us** or **Start a vote** in a channel.

**Deals:** what's on sale that this server plays or wants, compared with the lowest price ever, plus running [bundles](deals.md#bundles) and [free games](deals.md#free-games). **Just mine** keeps only what you want or wishlisted, once the page knows who you are.

**Stats:** pick a range, from presets or dates on a calendar. **Overview** has game time, games, people, voice time, sounds and game nights, each compared with the stretch before, then charts of game time, days in voice, when people are on, the top games and people, and what's trending. Pick a person or game to see just theirs. **Sounds & music** has the sounds, songs and speech, never what was said. **Compare** and **Monthly recap** match `/compare` and `/recap`, and **Health** shows how the bot is doing (see [Health](api.md#health)). **Merge games** and **Not a game** fix how games are counted (see [Stats](stats.md#game-names)).

**Activity:** who changed what, from here or Discord: sounds, games, pings, Steam accounts, music, settings and game nights.

**Settings:** everything in `/setup`, plus game ping roles, everyone's join sounds and pings, and what's free and on sale now. Anything that needs fixing is listed first, with **Go to setting**. **Find a setting** searches them, a changed setting offers **Reset**, and **Post Choose games button** posts a `/gamerole menu`.

Only a vote, a panel and the Choose games button post to Discord. Anyone with the password can change anyone's pings and Steam accounts.

## Running it

The web UI stores nothing. It passes everything to the bot's [management API](api.md#management-api), so the rules are the same as for the slash commands.

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

Use the `ghcr.io/chuck-amuck/slopkeeper-web` image (the reference [`docker-compose.yml`](../docker-compose.yml) has it), or build it from [`web/`](../web). It serves plain HTTP, so keep it on your home network or behind a proxy that adds HTTPS.

## Signing in through Pangolin

Behind [Pangolin](https://github.com/fosrl/pangolin) with SSO, the page knows who's using it. Pangolin adds `Remote-Email` and `Remote-Name` headers after someone signs in, and the page trusts them only when the request also carries `PROXY_SECRET` in an `x-slopkeeper-proxy-secret` header, so nobody can send them straight to the port. Set `PROXY_SECRET` to a long random value (`openssl rand -hex 32`) and add it to the resource in Pangolin as a custom request header. Keep the resource SSO-only: a PIN, password or share link forwards no identity.

The password is still asked for. Once someone is signed in:

- Their name shows in the header and on their changes in **Activity**. Changes that skip Pangolin show as **Web UI**.
- Clicking their name links them to their Discord member, so their changes show under that name, and planning a night, pings, join sounds and **Compare** start on them.
- Wrong passwords lock out only them for a minute, not everyone.
