# Text to speech

The bot reading out what people type, in a voice they pick.

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

  The accents are ordinary Piper voices and the styles are made with effects: neither imitates a known person. More can be [added in the web UI](#adding-voices). Each voice talks at the server's speed, a few a little slower or quicker than that so they sound right. In Discord, `voice` is searched as you type. A server whose default voice has been removed, or is still downloading, talks in the bot's default voice, and Settings says so.
- `/setup speech` sets whether it's on, how fast and how loud it talks, the longest line and how long each person waits between lines. The default voice is picked in the web UI's Settings. `/setup speech-role` limits it to a role, plus people with **Manage Server**. The web UI isn't limited by the role, and counts as one person for the wait.

It needs the [voice container](self-hosting.md#the-voice-container).

**Greetings:** with `greet` on in `/setup speech`, the bot says who joined voice, using the **Greeting** setting with `{name}` for the person. Someone with a join sound hears that instead. Greetings follow the join sound rules: the same cooldown and delay, nothing for moving channels, bots or the AFK channel, and the bot won't leave another channel for one.

**Announcements:** `night_reminders` says game night reminders in the night's voice channel when they're posted, and `hop_on` says hop-on pings in the channel they're about. Both only play where people are, and won't pull the bot away from another channel. What gets posted doesn't change.

**Reading a channel aloud:** `/setup speech-channel` or Settings picks a text channel, and the bot reads out what people type there, starting with who said it. It plays in the writer's voice channel, or else the one the bot is in, or else the busiest one, and reads nothing if nobody's in voice. `who` limits it to people in voice.

It skips bots, images, links with no words and anything over the longest line, and leaves out spoilers and code blocks. There's no wait between messages, but if 5 lines are already waiting, new ones are skipped so it can't fall behind. The role limit applies, and these lines aren't logged in Activity.

## Adding voices

Settings in the web UI has a **Voices** card, under Text to speech, for adding voices from any [Piper](https://github.com/OHF-Voice/piper1-gpl) model without changing the code, such as ones on [Hugging Face](https://huggingface.co/models?other=piper). Added voices are for every server on the bot, and anyone who can open the web UI can add, change and remove them.

- **Add a voice:** paste the link to the model's `.onnx` file, give it a name and pick Characters or Accents. A Hugging Face page's link works too. Its settings are the same address with `.json` added. The voice container downloads it (500 MB at most), and it shows in the voice lists once it's ready. The card shows how far along a download is, or why it failed.
- **Edit:** the name, group and link (a new link downloads it again), and once it's downloaded:
  - **Speaker**, for a model with several, by the names its settings give them.
  - **Loudness**, in dB, to make it as loud as the other voices. Levelling squeezes loud speech, so a cut lowers it by about half as much.
  - **Pace**: above 1 is slower, for a voice that sounds rushed. 1.1 is 10% slower.
  - **Steadiness**: the model's own, or steadier timing and sound for one that wobbles in long lines.
  - **Speed curve**: how its speed follows the speed setting. Character suits most community models.
  - **Preview** plays it with these settings, saved or not, just for you.
- **Remove** deletes its model, and servers that picked it go back to their default voice.
- **Export** saves every added voice as `slopkeeper-voices.json`. **Import** takes that file, or a list in the same shape, matching voices by id or name, and says what it would add, change, leave and skip, with why, before it does it. **Replace all** removes the added voices the file doesn't have.

Each export entry has `name` and `model`, and only what's changed from the defaults of the rest: `id`, `group` (`Characters` or `Accents`), `config` (the settings' address), `sha256` and `configSha256` (checked when given), `speaker`, `volume` (dB, -20 to 20), `pace` (0.5 to 2), `noise` (Piper's `noise_scale` and `noise_w_scale`, two numbers from 0 to 2) and `curve` (`character`, `default`, `middle` or `low`).

The voice container keeps the added voices' models and their list in its volume, and gets the list again from the bot if it loses it.
