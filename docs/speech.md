# Text to speech

The bot reads out what people type, in a voice they pick. It needs the host's [voice container](self-hosting.md#the-voice-container).

`/say text [voice] [effect]` reads a line in your voice channel, joining it first if it has to. The web UI's Soundboard has a **Say something** box too, where **Save** keeps a line as a one-click button (up to 25 per server); `/say saved:` says one from Discord.

**Say this aloud:** right-click a message, or press and hold it on a phone, then **Apps → Say this aloud** to have it read out, starting with whose message it is.

- Lines wait their turn, while sounds layer on top. **Stop** ends the line and clears the rest.
- Mentions are read as names, custom emoji by name, and links as "link". Spoilers and code blocks are skipped when reading a message.
- There's a short pause between sentences, 0.2 seconds by default.
- A drawn-out word is held: "nooooo" holds the o, and "yesss" the s. Three letters hold it for 0.6 seconds and each one more adds 0.2, up to 1.5 seconds, longer when the speech is slower.
- Some text is tidied first, as the voices read it oddly: "$5.50" is said "5 dollars 50" (pounds and euros too), "..." is a pause, and "Dr." and "Mr." don't end a sentence. Text in brackets is read as it's typed: the voices can't act out a stage direction like "(whispers)".
- A line can be up to 4,000 characters by default (about 5 minutes), and 6,000 at most. A long line takes a few seconds to start.
- Every line goes in the Activity tab with who said it, cut to its first 200 characters.
- A line said again within half an hour, in the same voice, effect, speed and pause, plays straight away.

## Voices

- **Accents:** **American** (a man, a woman and a deep man), **Scottish**, **Northern English**, **Southern English** (a woman, and a man, who's the default), **Irish (Jenny)** and **Australian** (a man and a woman) are English voices. **Russian**, **Spanish** and **German** read English with that accent, and **State broadcast** is a Korean announcer over an old loudspeaker. Russian in Cyrillic and Korean in Hangul are read in their own language.
- **Characters**, and any other Piper voice, are [added in the web UI](#adding-voices).

Neither the accents nor the effects imitate a known person. In Discord, `voice` and `effect` are searched as you type. If a server's default voice is removed or still downloading, it talks in the bot's default voice, and Settings says so.

## Effects

Any voice can be said through an effect, picked beside the voice: **Demon**, **Helium**, **Giant**, **Robot**, **Alien**, **Walkie-talkie**, **Phone call**, **Megaphone**, **Stadium PA**, **Newsreel**, **Cathedral**, **Underwater**, **Ghost**, **Trailer narrator** and **Old loudspeaker**. Pitch effects change the pace too: Helium is quicker, and Giant and Demon slower.

- An effect changes some voices' loudness far more than others', so each voice and effect pair is measured once, in the background, to be as loud as the voice is without it. Until then a pair uses the effect's usual correction.
- The server's **Default effect**, in Settings, is used when nobody picks one, including for messages read out, greetings and announcements. **No effect** is a pick of its own.
- The effects used to be voices, on three American voices. A server, the looping room or a device that had picked one now has the American voice it was made on, with that effect.

## Settings

`/setup speech` sets whether it's on, how fast and loud it talks, the pause between sentences, the longest line, and how long each person waits between lines. The default voice and effect are picked in the web UI's Settings. `/setup speech-role` limits speech to a role, plus people with **Manage Server**, and that covers reading a channel aloud too. The web UI isn't limited by the role, and counts as one person for the wait.

**Greetings:** with `greet` on, the bot says who joined voice, using the **Greeting** setting with `{name}` for the person. It follows the join sound rules: the same cooldown, nothing for moving channels, the bot won't leave another channel for one, and someone with a join sound hears that instead.

**Announcements:** `night_reminders` says game night reminders in the night's voice channel, and `hop_on` says hop-on pings in the channel they're about, where people are and the bot isn't busy elsewhere.

**Reading a channel aloud:** `/setup speech-channel` picks a text channel, and the bot reads out what people type there, starting with who said it. It plays in the writer's voice channel, or else the bot's, or else the busiest, and `who` limits it to people in voice. It skips bots, images, links on their own and anything over the longest line. If 5 lines are already waiting, new ones are skipped so it can't fall behind. These lines aren't logged in Activity.

## Adding voices

The web UI's Settings has a **Voices** card for adding any [Piper](https://github.com/OHF-Voice/piper1-gpl) model, such as ones on [Hugging Face](https://huggingface.co/models?other=piper). Added voices are for every server on the bot, and anyone who can open the web UI can change them.

- **Add a voice:** paste the link to the model's `.onnx` file (a Hugging Face page's link works too), name it and pick Characters or Accents. The voice container downloads it, up to 500 MB, and it shows in the voice lists once it's ready.
- **Measuring:** once it's downloaded, the bot times how the voice stretches at five speeds to pick its speed curve, and finds the loudness that makes it as loud as the default voices. It takes a minute or two, one voice at a time, and waits while lines are being said. The card shows "measuring" meanwhile. A voice added without a loudness or curve uses what's measured, and it's measured again when its link, speaker or steadiness changes.
- **Edit** changes the name, group and link, and once it's downloaded:
  - **Measured** shows the curve and loudness found. Changing the loudness or curve yourself keeps yours; **Use measured** goes back to the measured values, and **Measure again** starts over. A loose fit (over 5% off every curve) is worth checking by ear.
  - **Speaker**, for a model with several.
  - **Loudness**, in dB, to match the other voices. Levelling squeezes loud speech, so a cut lowers it by about half as much.
  - **Pace**: above 1 is slower. 1.1 is 10% slower.
  - **Steadiness**: steadier timing and sound for a voice that wobbles in long lines.
  - **Speed curve**: how it follows the speed setting. Character suits most community models.
  - **Preview** plays it with these settings, just for you, through the **Preview effect** if one is picked.
- **Remove** deletes it, and servers that picked it go back to their default voice.
- **Export** saves every added voice as `slopkeeper-voices.json`. **Import** takes that file, matches voices by id or name, and shows what it would add, change and skip before it does. **Replace all** removes added voices the file doesn't have.

An export entry has `name` and `model`, and only what differs from the defaults: `id`, `group` (`Characters` or `Accents`), `config` (the settings' address, by default the model's with `.json` added), `sha256` and `configSha256` (checked when given), `speaker`, `volume` (dB, -20 to 20), `pace` (0.5 to 2), `noise` (Piper's `noise_scale` and `noise_w_scale`, from 0 to 2), `curve` (`character`, `default`, `middle` or `low`) and `tune`. Exports always write `tune`: `auto` takes the measured curve and loudness, `manual` keeps the entry's own. An entry without `tune` is `auto` if it gives neither `volume` nor `curve`.
