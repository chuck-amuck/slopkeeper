# Soundboard

Sounds anyone can play in voice, from Discord or the web UI. Text to speech has [its own page](speech.md).

The bot holds a library of uploaded sounds and plays them in your voice channel. Different sounds layer like Discord's own soundboard: clicking one while another is playing mixes it in instead of cutting the other off. Clicking a sound that's already playing restarts it from the top, with no gap and no jump in volume, so spamming one button rapid-fires it instead of stacking copies. Up to 12 sounds play at once; past that, the oldest is dropped. A sound that's played to the end is kept in memory (up to 24 MB of sounds, ten seconds each at most), so playing it again starts straight away. The bot leaves voice after 5 minutes of silence, or as soon as everyone else has left.

## Playing sounds

| Command | What it does |
| --- | --- |
| `/sound panel` | Posts a button grid in the current channel: 20 sounds per page in the order set in the web UI's **Manage** (its groups first, named under the buttons, then the rest, most played first), ◀ ▶ to flip pages, ⏹ **Stop** to silence every sound and line of speech (the music carries on). The bot keeps every panel it posts up to date as sounds change, so post one in a handy channel and pin it. |
| `/sound play name` | Plays one sound in your voice channel. The name autocompletes. |
| `/sound stop` | Stops the sounds and speech, like the Stop button, and makes the bot leave voice. If music is playing, it carries on and the bot stays: music has its own controls and [DJ role](music.md). The reply is in the channel, so people can see who stopped it. |
| `/sound join [name]` | Picks a sound that plays when you join voice. Leave `name` empty to stop having one. |

You have to be in a voice channel to play a sound. The bot joins whichever channel you're in.

**⚙️ Settings** on a panel changes sounds without leaving Discord. Everything it opens is only visible to you. Pick a sound from the panel's current page, or turn its own pages to reach the rest without moving the panel for everyone, to change its volume, test it, put it on or take it off Discord's soundboard, set its emoji, rename it or delete it. **Add a sound** opens a form with a file picker, a name (left empty, it's made from the file's name, so `Air Horn.mp3` becomes `air-horn`) and an emoji; the same rules and the same question about a taken name apply as for `/sound add`, and the channel sees what was added. People with **Manage Server** also get switches for even volume and join sounds. Trimming and picking part of a long sound are on the web UI, or in the commands below.

**Join sounds** are opt-in: nothing plays until someone picks one with `/sound join`, or it's set for them on the web UI's Settings page. When you connect to voice the bot joins straight away, then waits half a second before playing, so the sound clears Discord's joining noises. Nothing plays if you leave during that wait. It doesn't play when you switch channels, or again until the cooldown is up (10 minutes unless `/setup sounds` says otherwise). If the bot is already in a different channel, it stays there rather than leaving the people using it. They don't count towards the monthly recap's top sounds.

## Managing sounds

| Command | What it does |
| --- | --- |
| `/sound add name file [emoji]` | Uploads a sound. Names use lowercase letters, numbers, `-` and `_` (up to 32 characters). The file can be mp3, ogg, wav, m4a, opus, webm or flac, up to 5 MB, and the bot turns it down if it can't find audio in it. Using an existing name asks first: **Replace it** (the old sound goes to Recently deleted and the emoji stays unless you give a new one), **Keep both** (the new one gets the next free name, like `airhorn-2`) or **Cancel**. The question lasts 5 minutes. |
| `/sound emoji name [emoji]` | Sets the emoji on a sound's button. Leave `emoji` empty to clear it. Custom emoji have to be from this server. |
| `/sound remove name` | Deletes a sound from the bot, and from Discord's soundboard if it's there. It stays in a bin for 30 days. |
| `/sound restore name` | Brings back a sound from the bin with its emoji, volume, group and untrimmed original. If the name's been taken, it comes back numbered, like `horn-2`. It isn't put back on Discord's soundboard, and anyone who had it as a join sound has to pick it again. |
| `/sound volume name percent` | Sets how loud one sound plays, from 25 to 200, where 100 is normal. |

The web UI's **Manage** can also trim a sound, and so can the [management API](api.md#management-api). The bot keeps the first version, so it can be restored until the sound is replaced. A copy on Discord's soundboard stays as it is until it's added again.

### Adding a sound from a link

In the web UI's **Manage**, paste a link to a YouTube video or Short, a TikTok, an Instagram Reel or a SoundCloud track under the drop zone and press **Get**. The [music container](self-hosting.md#the-music-container) downloads it, up to 20 minutes long, and an editor opens with the video (or the track's player) above its waveform:

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

## Who can change sounds

Everyone can, until a role is set with `/setup sound-managers`. Then only people with that role or **Manage Server** can use `/sound add`, `emoji`, `remove`, `restore`, `volume`, `discord-add`, `discord-remove` and `discord-sync`, or the changes under a panel's **⚙️ Settings**. Everyone else can still play and test sounds, stop playback, post a panel and set their own join sound. If the role is deleted, only people with **Manage Server** can change sounds until a new one is set.

The web UI isn't limited by the role: anyone with its password can change everything, even when [Pangolin](web-ui.md#signing-in-through-pangolin) says who they are.

## Even volume

Every sound is measured when it's added, so a whisper and an air horn play about as loud as each other. Your file isn't changed: the bot stores how much to turn each sound up or down and applies that as it plays, so turning it off with `/setup sounds` puts everything back. A quiet sound with one loud spike only comes up until the spike would clip, and no sound is boosted by more than 12 dB, so very quiet sounds can still need `/sound volume`.

Sounds from before this existed are measured when the bot starts. Copies on Discord's soundboard are levelled using Discord's own volume for each sound, which can only go up to 1, so a sound that needs a big boost stays quieter there than on the bot.

## Soundboard volume

**Soundboard volume** turns every sound up or down at once, including join sounds and the looping sound, and changes sounds that are already playing. It's the **Sounds** slider on the web UI's Soundboard and behind the **Volume** button on every page, in Settings, and `volume` in `/setup sounds`. Speech has its own volume: **Speech volume**, the **Speech** slider beside it and behind **Volume**, also in Settings and `volume` in `/setup speech`. It changes a line being said too.

The web UI's volume sliders, for the soundboard, music and each sound, work like a media player's: the first three quarters run from 0 to 100%, the tick marks 100%, and the last quarter, in orange, turns it up past 100% to the most it goes. The box beside each takes an exact percentage, and the arrow keys move a slider 5% at a time (Page Up and Page Down 20%).

## Looping sound room

Pick a voice channel and a sound with `/setup loop-room` or in Settings, and the bot plays that sound over and over, without a gap, while anyone's in the channel. It leaves when the last person does. It's off until the channel and a sound or speech are set. `/setup loop-room` with no options shows how it's set, and `off:True` turns it off.

Discord lets a bot be in one voice channel per server, so the room shares the bot with everything else, and the points about Stop and giving way below are about that. With the [loop bot](self-hosting.md#the-loop-bot) set up, a second bot plays the room instead: both play at once, the room never gives way, and the soundboard's **Stop** leaves the room alone. Settings shows the loop bot's state at the top of the room's settings.

- Other sounds, join sounds and speech play on top. Playing the looping sound by hand plays a second copy.
- **Stop** silences it until someone else joins the room.
- The room gives way: if the bot is busy in another channel with people in it, the room waits until that channel empties or the bot has been idle for 5 minutes. Playing something in another channel takes the bot there, and the loop comes back the same way.
- **Loop volume** is the sound's and **Looping speech volume** the speech's, and both start at half, as they never stop. Renaming the sound keeps it, and removing it turns the loop off.
- **Looping speech** says some words over and over too, up to 500 characters, in a **Looping speech voice** of its own (the default voice until one's picked in Settings) at the speech speed. It plays alongside the sound, or alone with no sound set. **Speech every** spaces it out the way Loop every does for the sound. The voice container makes the speech once and the bot reuses it, so Settings warns straight away if it can't be made.
- **Join sounds and greetings** don't play in the room, as they'd only talk over it.
- **Intro sound** plays once before the loop starts, at its own level and the soundboard volume, **Intro delay** after someone comes in (250 ms by default). The loop starts when it ends. Someone else coming in stops the loop and starts again from the intro. **Sound delay after intro** and **Speech delay after intro** hold each back that long after the intro ends, or after the loop starts with no intro, so one can come in after the other. Changing a loop setting doesn't replay the intro or the delays. Renaming its sound keeps it, and removing the sound turns the intro off.
- **Loop every** layers it instead: a fresh copy starts that many seconds after the last, like 0.5 or 1, on top of the copies still playing. Up to 8 play at once, and the oldest fades out as the next starts. A sound shorter than the gap plays, goes quiet, then plays again. At 0, the default, it loops without a gap.

## Discord's soundboard

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
