# Chat

@mention the bot (or its role), or reply to one of its answers, and it answers in character. It also does what you ask, in plain English: "queue the strokes", "play the wall", "skip this", "play the airhorn", "say happy birthday in the GLaDOS voice". It needs an Anthropic API key on the host (see [Setting it up](#setting-it-up)).

## What it can do

- **[Music](music.md):** finds songs, albums and artists on Spotify by name and adds them to the queue, starting the music in your voice channel if nothing is playing. An artist adds up to 10 of their best-known songs, and "their new album" looks up their albums by date, so it finds one newer than the model knows of. It also takes links, and skips, pauses, resumes, shuffles and turns Autoplay on or off. "Stop the music" pauses it; it only empties the queue when you ask for that.
- **[Sounds](soundboard.md):** plays a sound from the library in your voice channel, finding it by name.
- **[Speech](speech.md):** says something in your voice channel, in any voice and effect.

It does these as you: only what you could do yourself. With a DJ role set, people without it can't control the music through it either, the text to speech role and cooldown still apply, and sounds and speech need you in a voice channel. Activity shows what you asked, as "Asked in chat", and what it did, under your name.

Anything else, it just answers. It sees the channel's last 20 messages, what's playing, and whether you're in voice, so it can follow along. It doesn't remember earlier conversations past that, and it doesn't read messages that don't @mention it or reply to one of its answers. Replies to its other posts, like hop-on pings and recaps, are left to people.

## Settings

The **Chat** card in the web UI's Settings has them all, and says how many answers it gave this month and roughly what they cost:

- **Answer in chat:** on or off for the server.
- **Personality:** who the bot is when it answers, in a few sentences. It starts as a robot butler with impeccable manners and no brakes.
- **Model:** **Claude Haiku 5.5**, the default, or **Claude Opus 5.5**, which follows messy requests better and banters better, at about 40 times the cost.
- **Answer in voice:** says each answer in the server's default voice when the person asking is in a voice channel and can use speech. **Text and voice** posts it too; **Voice only** just reacts 🔊, and remembers what it said so it can follow on. It's posted instead when it can't be said: they aren't in voice, it's over the longest line, the bot is busy in another voice channel, or it has just said something for them. Off by default.
- **Answers a day:** 200 by default, in the server's time zone. After that it says once that it's done for the day. Each person also waits 10 seconds between answers; asking sooner gets a ⏳.

## Privacy and cost

Each answer sends the message, the channel's last 20 messages (with people's display names), what's playing and the server's name to [Anthropic's API](https://www.anthropic.com/legal/commercial-terms). Nothing is sent for messages that don't @mention the bot or reply to one of its answers, so tell people in the server what @mentioning it does.

With Haiku, an answer costs about a twentieth of a cent, or roughly $1.50 a month at 100 answers a day. With Opus it's about 1–2 cents, or roughly $50 a month at that rate.

## Setting it up

1. Make an account at [console.anthropic.com](https://console.anthropic.com), add some credit, and create an API key.
2. Set `ANTHROPIC_API_KEY` on the bot (see [Self-hosting](self-hosting.md#configuration)) and restart it. Music needs the [music container](self-hosting.md#the-music-container), with Spotify for finding things by name, and speech the [voice container](self-hosting.md#the-voice-container).
3. The bot answers in channels where it has **Send Messages** and **Read Message History** (an answer is a reply, and it reads what came before). Private channels mentioned in a message are sent as "a channel", not by name.
