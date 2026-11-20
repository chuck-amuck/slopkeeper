# Music

The bot plays music in voice from a queue everyone shares. Songs are found on Spotify or YouTube Music and played from YouTube Music, YouTube or SoundCloud, so no Spotify account plays anything. It needs the host's [music container](self-hosting.md#the-music-container). A Spotify app is optional: it adds Spotify search. Spotify links work without one. You can also [ask the bot in chat](chat.md), like "queue the strokes".

## Commands

| Command | What it does |
| --- | --- |
| `/music play [song] [next] [shuffle]` | Adds a song, album or playlist, by search or by a Spotify, YouTube or SoundCloud link, and starts the music in your voice channel. `next` puts it after the song playing, and `shuffle` adds an album or playlist in random order. With no song, it carries on where it paused. |
| `/music pause`, `skip`, `stop` | Said in the channel, so everyone sees who did it. **Stop** clears the queue too. |
| `/music queue` | The music card, just for you. |
| `/music panel` | Posts a music panel in this channel, which stays and keeps up with the music. Anyone can post one. |
| `/music remove song` | Takes a song out of the queue, numbered as the card shows it. |
| `/music shuffle` | Shuffles the songs waiting, leaving the one playing and Autoplay's songs alone. |
| `/music autoplay [on]` | Turns Autoplay on or off. |

`/music play` answers with a music card: the song playing, when it ends and what's next, with **Play/Pause**, **Skip**, **Shuffle**, **Stop**, **Refresh** and **Autoplay** buttons, and 🔉 **Quieter** and 🔊 **Louder**, which change the music volume 5% at a time. It keeps up as songs change, and a newer card takes over from it.

A **music panel** is the same card posted to stay: put one in a handy channel and pin it, and it keeps up with the music, whoever plays it and from wherever. Post one with `/music panel`, or **Post panel** on the web UI's Music tab, which asks for the channel. **Posted panels** there lists them, with a link to each, and **Take down** deletes one so the bot stops keeping it up to date. The buttons on a panel are for the DJ role, as everywhere else.

The web UI's **Music** tab has all of this, plus search results to pick from, a progress bar to jump within a song, a volume slider and drag to reorder. Its **Upload** adds an audio file of up to 60 MB and 20 minutes, which plays like any song, even while the music container is down, and is deleted once it has played.

## Playlists and links

- **Spotify:** a song or album link adds it, read with the host's Spotify app, or from Spotify's public player when there's no app, or the app is being made to wait or failing. A link to any public playlist (yours, someone else's or Spotify's own) adds its first 100 songs. They're read from Spotify's public embed player, so covers fill in a few seconds later. Private playlists can't be read. If the host has [signed in a Spotify account](self-hosting.md#the-music-container), its own playlists are read in full and listed first.
- **YouTube:** a playlist link adds its first 100 videos, or with `shuffle`, 100 picked from its first 500. Private, deleted, live and over-20-minute videos are left out, and the reply says how many. A link to one video in a playlist adds just that video.
- **SoundCloud:** a playlist or album (`/sets/` link) works the same way, but slower. Tracks SoundCloud locks are left out.

Channels and profiles can't be added.

## Autoplay

When **Autoplay** is on, three songs wait at the end of the queue, picked from YouTube Music's mix for the last song someone added, so the music carries on in that style. Songs people add always go ahead of them, and they change when a different song becomes last. They're 1 to 10 minutes long, never live versions, covers or remixes, and never a song played, queued or offered since the music started, even another upload of it. Songs are told apart by name, so another artist's song with the same name is passed over too.

On the Music tab, **+** keeps one of Autoplay's songs and **✕** takes it out. Turning Autoplay off takes out the ones that haven't played. It's off until someone turns it on, and it can't follow a song from SoundCloud.

## How it plays

- **Queue:** each server has its own, up to 500 songs. When it runs out, the music stops unless Autoplay is on.
- **Searching:** words are looked up on Spotify or YouTube Music, as the web UI's **Music search** setting picks. It's Spotify unless the host changed it, and a bot without a Spotify app always searches YouTube Music. With **Fall back to the other** on, as it is unless turned off, the other is asked when the first fails, is making the bot wait, or finds nothing. `/music play`'s suggestions as you type come from the first.
- **Finding songs:** a song found on YouTube Music plays as found. Each Spotify song is matched by name and length on YouTube Music, then YouTube, then SoundCloud, passing over live versions, covers and remixes unless that's what the song is. The next songs are fetched ahead, so they start without a wait. A song that can't be found or won't play is skipped, and so is one YouTube turns down twice; a second in a row pauses the music, in case YouTube is turning every song away.
- **Restarts:** after a restart or update, the music carries on from the same second in the same channel, if someone's still there and it was under 10 minutes ago. Paused music stays paused.
- **Even music volume:** each song plays about as loud as a typical one, so a quiet old recording and a loud new one don't need the volume changed between them. Each song is measured once, when it's first fetched (well under a second), and turned up or down as it plays, without changing the file. A quiet song comes up by at most 12 dB, and only as far as it can without distorting at the server's music volume. It's on unless the web UI's **Even music volume** setting turns it off, which takes effect from the next song.
- **With sounds and speech:** they play on top, and music drops to under a third while the bot talks.
- **While people talk:** music drops the same way while anyone in the call is talking. A second and a half after the last one stops, it comes back up over about a second. For this the bot isn't deafened in the call: it notices when someone starts and stops talking, and never decodes, records or keeps what anyone says. Other bots, and a microphone left open for over 30 seconds, don't count. `/setup music drop_for_people:False`, or the web UI's **Music drops while people talk**, turns it off and deafens the bot again.
- **Everyone leaving** pauses the music and keeps the queue. The soundboard's **Stop** leaves music playing. While music plays, the bot doesn't leave for being idle, and the looping room waits.
- **Who can control it:** everyone, until `/setup music dj_role:` sets a role. Then only that role and people with **Manage Server** can add, pause, skip, shuffle and stop. Anyone can see the queue, and the web UI isn't limited by the role.
- **Activity** shows what was added, removed and skipped, and by whom.
