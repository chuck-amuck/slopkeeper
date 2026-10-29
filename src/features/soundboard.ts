import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  MessageFlags,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type VoiceBasedChannel,
} from 'discord.js';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { Mixer } from '../mixer.ts';
import type { Feature } from '../types.ts';

const SOUND_DIR = path.join(config.dataDir, 'sounds');
const EXTENSIONS = ['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.webm', '.flac'];
const MAX_BYTES = 5 * 1024 * 1024;
const VOLUME = 0.5;
const MAX_VOICES = 12;
const IDLE_LEAVE_MS = 5 * 60_000;
const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
const PAGE_SIZE = 20; // 4 rows of 5 buttons; the fifth row holds the controls
const CUSTOM_EMOJI = /^<a?:\w{2,32}:(\d{17,20})>$/;
const UNICODE_EMOJI = /^\p{RGI_Emoji}$/v;
// Control button ids use '#', which sound names can't contain
const PREV = 'sb:#prev';
const NEXT = 'sb:#next';
const STOP = 'sb:#stop';

mkdirSync(SOUND_DIR, { recursive: true });

interface Sound {
  name: string;
  file: string;
  emoji?: string;
}

function listSounds(): Sound[] {
  const emojis = new Map(
    (db.prepare('SELECT name, emoji FROM sound_emoji').all() as { name: string; emoji: string }[]).map((r) => [r.name, r.emoji]),
  );
  return readdirSync(SOUND_DIR)
    .filter((f) => EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .map((f) => {
      const name = path.parse(f).name;
      return { name, file: path.join(SOUND_DIR, f), emoji: emojis.get(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const findSound = (name: string) => listSounds().find((s) => s.name === name);

function setEmoji(name: string, emoji: string | null) {
  if (emoji) db.prepare('INSERT INTO sound_emoji (name, emoji) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET emoji = excluded.emoji').run(name, emoji);
  else db.prepare('DELETE FROM sound_emoji WHERE name = ?').run(name);
}

/** Returns the emoji to store, or an error message for the user */
async function parseEmoji(i: ChatInputCommandInteraction<'cached'>, input: string): Promise<{ emoji: string } | { error: string }> {
  const trimmed = input.trim();
  if (UNICODE_EMOJI.test(trimmed)) return { emoji: trimmed };
  const custom = CUSTOM_EMOJI.exec(trimmed);
  if (!custom) return { error: 'That isn’t a single emoji. Pick one from the emoji picker.' };
  // Bots can only show custom emoji from servers they're in
  const found = await i.guild.emojis.fetch(custom[1]).catch(() => null);
  return found ? { emoji: trimmed } : { error: 'Custom emoji have to be from this server.' };
}

let mixer: Mixer | undefined;
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
player.on('error', (err) => console.error('Audio player error:', err.message));

let idleTimer: NodeJS.Timeout | undefined;
player.on(AudioPlayerStatus.Idle, () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => getVoiceConnection(config.guildId)?.destroy(), IDLE_LEAVE_MS);
});

async function play(channel: VoiceBasedChannel, file: string) {
  clearTimeout(idleTimer);
  let connection = getVoiceConnection(channel.guild.id);
  if (connection?.joinConfig.channelId !== channel.id) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    connection.subscribe(player);
  }
  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  // Layer onto whatever is already playing; a fresh mixer is only needed once the last one has gone quiet
  if (mixer && !mixer.finished) return mixer.add(file);
  mixer = new Mixer(VOLUME, MAX_VOICES);
  mixer.add(file);
  player.play(createAudioResource(mixer, { inputType: StreamType.Raw }));
}

function stopPlayback() {
  mixer?.stopAll();
  player.stop(true);
}

const pageCount = (sounds: Sound[]) => Math.max(1, Math.ceil(sounds.length / PAGE_SIZE));

function panel(page: number) {
  const sounds = listSounds();
  if (!sounds.length) return { content: '🔊 No sounds yet. Add one with `/sound add`.', components: [] };
  const pages = pageCount(sounds);
  page = Math.min(Math.max(page, 0), pages - 1);

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const shown = sounds.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  for (let idx = 0; idx < shown.length; idx += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        shown.slice(idx, idx + 5).map((s) => {
          const button = new ButtonBuilder().setCustomId(`sb:${s.name}`).setLabel(s.name).setStyle(ButtonStyle.Secondary);
          return s.emoji ? button.setEmoji(s.emoji) : button;
        }),
      ),
    );
  }

  const controls = new ActionRowBuilder<ButtonBuilder>();
  if (pages > 1) {
    controls.addComponents(
      new ButtonBuilder().setCustomId(PREV).setEmoji('◀️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(NEXT).setEmoji('▶️').setStyle(ButtonStyle.Primary),
    );
  }
  controls.addComponents(new ButtonBuilder().setCustomId(STOP).setEmoji('⏹️').setLabel('Stop').setStyle(ButtonStyle.Danger));
  rows.push(controls);

  return { content: pages > 1 ? `🔊 **Soundboard** · page ${page + 1} of ${pages}` : '🔊 **Soundboard**', components: rows };
}

function trackPanel(messageId: string, channelId: string, page: number) {
  db.prepare('INSERT INTO sound_panels (message_id, channel_id, page) VALUES (?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET page = excluded.page').run(
    messageId,
    channelId,
    page,
  );
}

/** Re-renders every posted panel after the sound list changes */
async function refreshPanels(client: Client) {
  const panels = db.prepare('SELECT message_id, channel_id, page FROM sound_panels').all() as { message_id: string; channel_id: string; page: number }[];
  for (const p of panels) {
    try {
      const channel = await client.channels.fetch(p.channel_id);
      if (!channel?.isTextBased()) throw new Error(`channel ${p.channel_id} is not text-based`);
      // Editing by id avoids fetching the message, which would need Read Message History
      await channel.messages.edit(p.message_id, panel(p.page));
    } catch (err) {
      const gone =
        err instanceof DiscordAPIError && (err.code === RESTJSONErrorCodes.UnknownMessage || err.code === RESTJSONErrorCodes.UnknownChannel);
      if (gone) db.prepare('DELETE FROM sound_panels WHERE message_id = ?').run(p.message_id);
      else console.error(`Soundboard panel ${p.message_id} refresh failed:`, err instanceof Error ? err.message : err);
    }
  }
}

export const soundboard: Feature = {
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('sound')
        .setDescription('Bot soundboard')
        .addSubcommand((s) =>
          s
            .setName('play')
            .setDescription('Play a sound in your voice channel')
            .addStringOption((o) => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Upload a sound (max 5 MB)')
            .addStringOption((o) => o.setName('name').setDescription('Lowercase letters, numbers, - and _').setRequired(true).setMaxLength(32))
            .addAttachmentOption((o) => o.setName('file').setDescription('mp3, ogg, wav, m4a, opus, webm or flac').setRequired(true))
            .addStringOption((o) => o.setName('emoji').setDescription('Emoji shown on its button')),
        )
        .addSubcommand((s) =>
          s
            .setName('emoji')
            .setDescription('Set or clear the emoji on a sound’s button')
            .addStringOption((o) => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true))
            .addStringOption((o) => o.setName('emoji').setDescription('Leave empty to clear')),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Delete a sound')
            .addStringOption((o) => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) => s.setName('stop').setDescription('Stop playback and leave voice'))
        .addSubcommand((s) => s.setName('panel').setDescription('Post a soundboard panel in this channel; it updates itself as sounds change')),
      async autocomplete(i) {
        const query = i.options.getFocused().toLowerCase();
        return i.respond(
          listSounds()
            .filter((s) => s.name.includes(query))
            .slice(0, 25)
            .map((s) => ({ name: s.emoji && !s.emoji.startsWith('<') ? `${s.emoji} ${s.name}` : s.name, value: s.name })),
        );
      },
      async run(i) {
        const sub = i.options.getSubcommand();
        const ephemeral = { flags: MessageFlags.Ephemeral } as const;

        if (sub === 'play') {
          const sound = findSound(i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          if (!i.inCachedGuild() || !i.member.voice.channel) return i.reply({ content: 'Join a voice channel first.', ...ephemeral });
          await i.deferReply(ephemeral);
          await play(i.member.voice.channel, sound.file);
          return i.editReply(`🔊 ${sound.name}`);
        }

        if (sub === 'add') {
          if (!i.inCachedGuild()) return i.reply({ content: 'Use this in the server.', ...ephemeral });
          const name = i.options.getString('name', true).toLowerCase();
          const file = i.options.getAttachment('file', true);
          const emojiInput = i.options.getString('emoji');
          const ext = path.extname(file.name).toLowerCase();
          if (!NAME_PATTERN.test(name)) return i.reply({ content: 'Name can only use lowercase letters, numbers, - and _.', ...ephemeral });
          if (!EXTENSIONS.includes(ext)) return i.reply({ content: `Unsupported file type. Use one of: ${EXTENSIONS.join(', ')}`, ...ephemeral });
          if (file.size > MAX_BYTES) return i.reply({ content: 'File is over 5 MB.', ...ephemeral });
          const emoji = emojiInput ? await parseEmoji(i, emojiInput) : null;
          if (emoji && 'error' in emoji) return i.reply({ content: emoji.error, ...ephemeral });

          await i.deferReply();
          const res = await fetch(file.url);
          if (!res.ok) return i.editReply(`Download failed (HTTP ${res.status}).`);
          const existing = findSound(name);
          if (existing) rmSync(existing.file);
          writeFileSync(path.join(SOUND_DIR, name + ext), Buffer.from(await res.arrayBuffer()));
          // Replacing a sound keeps its emoji unless a new one was given
          if (emoji) setEmoji(name, emoji.emoji);
          await i.editReply(`${existing ? '♻️ Replaced' : '➕ Added'} sound ${emoji ? emoji.emoji + ' ' : ''}**${name}**.`);
          return refreshPanels(i.client);
        }

        if (sub === 'emoji') {
          if (!i.inCachedGuild()) return i.reply({ content: 'Use this in the server.', ...ephemeral });
          const sound = findSound(i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          const emojiInput = i.options.getString('emoji');
          const emoji = emojiInput ? await parseEmoji(i, emojiInput) : null;
          if (emoji && 'error' in emoji) return i.reply({ content: emoji.error, ...ephemeral });
          setEmoji(sound.name, emoji?.emoji ?? null);
          await i.reply({ content: emoji ? `${emoji.emoji} set on **${sound.name}**.` : `Cleared the emoji on **${sound.name}**.`, ...ephemeral });
          return refreshPanels(i.client);
        }

        if (sub === 'remove') {
          const sound = findSound(i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          rmSync(sound.file);
          setEmoji(sound.name, null);
          await i.reply(`🗑️ Removed sound **${sound.name}**.`);
          return refreshPanels(i.client);
        }

        if (sub === 'stop') {
          stopPlayback();
          getVoiceConnection(config.guildId)?.destroy();
          return i.reply({ content: '⏹️ Stopped.', ...ephemeral });
        }

        const reply = await i.reply({ ...panel(0), withResponse: true });
        const message = reply.resource?.message;
        if (message) trackPanel(message.id, message.channelId, 0);
      },
    },
  ],
  buttonPrefix: 'sb',
  async onButton(i) {
    const receivedAt = Date.now();
    const isSound = !i.customId.startsWith('sb:#');
    // Discord greys the button out until the click is acknowledged, so do that before anything else
    if (isSound || i.customId === STOP) await i.deferUpdate();
    const ackedAt = Date.now();

    // Adopt panels posted before tracking existed, so they update on the next change too
    db.prepare('INSERT INTO sound_panels (message_id, channel_id) VALUES (?, ?) ON CONFLICT(message_id) DO NOTHING').run(i.message.id, i.channelId);

    if (i.customId === PREV || i.customId === NEXT) {
      const row = db.prepare('SELECT page FROM sound_panels WHERE message_id = ?').get(i.message.id) as { page: number };
      const pages = pageCount(listSounds());
      const page = (Math.min(row.page, pages - 1) + (i.customId === NEXT ? 1 : pages - 1)) % pages;
      trackPanel(i.message.id, i.channelId, page);
      return i.update(panel(page));
    }

    if (i.customId === STOP) return stopPlayback();

    const sound = findSound(i.customId.slice('sb:'.length));
    if (!sound) return i.followUp({ content: 'That sound was removed.', flags: MessageFlags.Ephemeral });
    if (!i.inCachedGuild() || !i.member.voice.channel) {
      return i.followUp({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }
    await play(i.member.voice.channel, sound.file);
    // Temporary timing log for button lag: click→bot is Discord delivering the click (from the interaction's
    // snowflake timestamp, so it includes any clock skew), ack is the deferUpdate round trip
    console.log(
      `Sound click ${sound.name}: click→bot ${receivedAt - i.createdTimestamp} ms, ack ${ackedAt - receivedAt} ms, ` +
        `ack→playing ${Date.now() - ackedAt} ms`,
    );
  },
};
