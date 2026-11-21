# Soundboard

Sounds anyone can play in voice, from Discord or the web UI. Text to speech has [its own page](speech.md).

Sounds layer like Discord's own soundboard: playing one while another plays mixes them, and playing a sound that's already going restarts it. The bot joins your voice channel to play, and leaves after 5 minutes of quiet or once everyone else has gone.

## Playing sounds

`/sound panel` posts a grid of buttons, 20 to a page, with ◀ ▶ to turn the pages and ⏹ **Stop** to silence every sound and line of speech (music carries on). The bot keeps every panel up to date as sounds change, so post one in a handy channel and pin it. The web UI's Soundboard does the same with search and groups. **Discord** → **Posted panels…**, on the web UI's **Manage**, lists where each one is, with a link to it, and **Take down** deletes one (or **Take all down**, every one), so the bot stops keeping it up to date.

On the panel, **blue** buttons are also on [Discord's soundboard](#discords-soundboard) and **gray** ones are only on the bot.

| Command | What it does |
| --- | --- |
| `/sound panel` | Posts the button grid in this channel, in the order set in the web UI's **Manage**. |
| `/sound play name` | Plays one sound in your voice channel. |
| `/sound stop` | Stops sounds and speech and makes the bot leave, unless music is playing ([music](music.md) has its own controls). The reply is public, so people see who stopped it. |
| `/sound join [name]` | Picks a sound that plays when you join voice. Leave `name` empty to stop. |

You have to be in a voice channel to play a sound.

**Join sounds** play only for people who picked one, with `/sound join` or in the web UI's Settings. They don't play when you switch channels, or again within the cooldown (10 minutes unless `/setup sounds` says otherwise). If the bot is already busy in another channel, it stays there.

## Adding and changing sounds

| Command | What it does |
| --- | --- |
| `/sound add name file [emoji]` | Uploads a sound: mp3, ogg, wav, m4a, opus, webm or flac, up to 5 MB, with audio in it. Names are up to 32 lowercase letters, numbers, `-` and `_`. |
| `/sound emoji name [emoji]` | Sets or clears a sound's emoji. Custom emoji have to be from this server. |
| `/sound volume name percent` | How loud one sound plays, from 25 to 200 (100 is normal). |
| `/sound remove name` | Deletes a sound, from Discord's soundboard too. It stays in the bin for 30 days. |
| `/sound restore name` | Brings a sound back from the bin, with its settings, numbered (like `horn-2`) if its name was taken. It isn't put back on Discord's soundboard, and join sounds have to be picked again. |

```
/sound add name:airhorn file:<airhorn.mp3> emoji:📯
/sound remove name:old-meme
```

Adding a sound under a name that's taken asks first, for 5 minutes: **Replace it** (the old one goes to the bin), **Keep both** (the new one becomes `airhorn-2`) or **Cancel**.

**⚙️ Settings** under a panel does all of this without leaving Discord, and only you see it: pick a sound to test, rename, change its volume or emoji, put it on Discord's soundboard or delete it, or **Add a sound** from a file.

The web UI's **Manage** can also trim a sound. The bot keeps the original, so a trim can be undone until the sound is replaced.

### Adding a sound from a link

In the web UI's **Manage**, paste a link to a YouTube video or Short, a TikTok, an Instagram Reel or a SoundCloud track and press **Get**. Once it's downloaded (up to 20 minutes long), an editor opens with the video above its waveform:

- Drag the ends of the waveform, type the times, or play to a moment and press **Start here** or **End here**.
- **Preview** plays the part, which can be up to 3 minutes long.
- The name starts as the video's title. **Also add to Discord's soundboard** works for a part of 5 seconds or less.
- **Save and cut another** keeps the editor open on the same video, starting where the last part ended, so one video makes several sounds.

The sound's **Trim** later has **Pick again from the link**, to choose a different part of the same video. Instagram turns down many Reels without signing in, and TikTok sometimes refuses a video; the editor says so. This needs the host's [music container](self-hosting.md#the-music-container).

With [chat](chat.md) on, you can also ask the bot: "@Slopkeeper make a sound called bonk from <link>, 0:05 to 0:12". It downloads the link and adds that part, and posts when it's done. It's for the same people who can change sounds here.

## Who can change sounds

Everyone can, until a role is set with `/setup sound-managers`. Then only that role and people with **Manage Server** can add, change, remove or restore sounds, or change Discord's soundboard. Everyone else can still play and test sounds, stop them, post a panel and pick their own join sound.

The web UI isn't limited by the role: anyone with its password can change everything, even when [Pangolin](web-ui.md#signing-in-through-pangolin) says who they are.

## Volume

**Even volume** makes a whisper and an air horn play about as loud as each other. Each sound is measured when it's added and turned up or down as it plays, so your file isn't changed. A sound is boosted by 12 dB at most, so a very quiet one can still need `/sound volume`. It's on by default; `/setup sounds` turns it off.

**Soundboard volume** turns every sound up or down at once, including join sounds and the looping room, even mid-sound. Speech has its own **Speech volume**. Both are on the **Volume** button on every page of the web UI, in Settings, and in `/setup sounds` and `/setup speech`.

## Looping sound room

Pick a voice channel and a sound with `/setup loop-room` or in Settings, and the bot plays that sound on repeat while anyone's in the channel. It can also say some words on repeat, alone or over the sound. `/setup loop-room` on its own shows how it's set, and `off:True` turns it off.

| Setting | What it does |
| --- | --- |
| Loop volume, Looping speech volume | How loud the sound and the speech are. Both start at half, as they never stop. |
| Loop every | 0 loops without a gap. A number of seconds, like 0.5, starts a fresh copy that often on top of the last, up to 8 at once. |
| Looping speech | Up to 500 characters, said over and over in its own voice (web UI only) at the speech speed. **Speech every** spaces it out. |
| Intro sound | Plays once before the loop, **Intro delay** after someone comes in (250 ms by default). **Sound delay after intro** and **Speech delay after intro** hold each back after it. |

Other sounds and speech play on top. **Stop** silences the room until someone else joins, and join sounds and greetings don't play there. Removing the looping sound turns the room off, and renaming it keeps it.

Discord lets a bot be in one voice channel per server, so the room shares the bot: if the bot is busy elsewhere with people, the room waits until that channel empties or the bot has been idle for 5 minutes. If the host sets up the [loop bot](self-hosting.md#the-loop-bot), a second bot plays the room instead, so it never waits and **Stop** leaves it alone. Settings shows the loop bot's state at the top of the room's settings.

## Discord's soundboard

Bot buttons lock for about half a second after each click, while Discord sends the click to the bot and back. Discord's own soundboard, the speaker button in a voice call, has no lock, and its sounds play from you, not the bot.

So the bot keeps the full library and copies what fits onto Discord's soundboard. Each sound there can be 5 seconds at most, and a server has 8, 24, 36 or 48 slots at boost level 0, 1, 2 or 3, shared with sounds people upload there themselves.

| Command | What it does |
| --- | --- |
| `/sound discord-add name [start]` | Copies a sound to Discord's soundboard. For a longer sound, `start` picks where its 5 seconds begin. |
| `/sound discord-remove name` | Takes a sound off Discord's soundboard to free a slot. It stays on the bot. |
| `/sound discord-sync` | Copies every short bot-only sound to Discord until the slots run out, and lists what didn't fit. |

```
/sound discord-add name:rickroll start:43      # the chorus, 0:43 to 0:48
```

`/sound add` copies a short sound to Discord on its own when a slot is free. Removing a sound or changing its emoji updates Discord's copy, and a copy someone deletes in Discord turns the sound back to bot-only. Sounds people added to Discord's soundboard themselves are changed only when someone asks in **Manage**: taking one off or swapping it out saves it to the library first, so it isn't lost.

The web UI's **Manage** shows everything on Discord's soundboard, including sounds people added there themselves, to play, save to the library, take off or swap for a library sound.
