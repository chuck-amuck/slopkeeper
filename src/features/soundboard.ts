import {
  AudioPlayerStatus,
  type AudioPlayer,
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
  Events,
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
import * as discordBoard from '../discordSounds.ts';
import { Mixer } from '../mixer.ts';
import type { Feature } from '../types.ts';
import { servedGuilds } from '../util.ts';

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

/** Each server has its own sounds, in sounds/<server id>/ */
function soundDir(guildId: string): string {
  const dir = path.join(config.dataDir, 'sounds', guildId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface Sound {
  name: string;
  file: string;
  emoji?: string;
  onDiscord: boolean;
}

function listSounds(guildId: string): Sound[] {
  const dir = soundDir(guildId);
  const onDiscord = discordBoard.synced(guildId);
  const emojis = new Map(
    (db.prepare('SELECT name, emoji FROM sound_emoji WHERE guild_id = ?').all(guildId) as { name: string; emoji: string }[]).map((r) => [
      r.name,
      r.emoji,
    ]),
  );
  return readdirSync(dir)
    .filter((f) => EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .map((f) => {
      const name = path.parse(f).name;
      return { name, file: path.join(dir, f), emoji: emojis.get(name), onDiscord: onDiscord.has(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const findSound = (guildId: string, name: string) => listSounds(guildId).find((s) => s.name === name);

function setEmoji(guildId: string, name: string, emoji: string | null) {
  if (emoji) {
    db.prepare('INSERT INTO sound_emoji (guild_id, name, emoji) VALUES (?, ?, ?) ON CONFLICT(guild_id, name) DO UPDATE SET emoji = excluded.emoji').run(
      guildId,
      name,
      emoji,
    );
  } else db.prepare('DELETE FROM sound_emoji WHERE guild_id = ? AND name = ?').run(guildId, name);
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

interface GuildAudio {
  player: AudioPlayer;
  mixer?: Mixer;
  idleTimer?: NodeJS.Timeout;
}

/** Server id → its audio; the bot can be in a voice channel in every server at once */
const audio = new Map<string, GuildAudio>();

function audioFor(guildId: string): GuildAudio {
  const existing = audio.get(guildId);
  if (existing) return existing;
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
  const a: GuildAudio = { player };
  player.on('error', (err) => console.error('Audio player error:', err.message));
  player.on(AudioPlayerStatus.Idle, () => {
    clearTimeout(a.idleTimer);
    a.idleTimer = setTimeout(() => getVoiceConnection(guildId)?.destroy(), IDLE_LEAVE_MS);
  });
  audio.set(guildId, a);
  return a;
}

async function play(channel: VoiceBasedChannel, file: string) {
  const a = audioFor(channel.guild.id);
  clearTimeout(a.idleTimer);
  let connection = getVoiceConnection(channel.guild.id);
  if (connection?.joinConfig.channelId !== channel.id) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    connection.subscribe(a.player);
  }
  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  // Layer onto whatever is already playing (or restart this sound if it's one of them); a fresh mixer is only needed once the last one has gone quiet
  if (a.mixer && !a.mixer.finished) return a.mixer.add(file);
  a.mixer = new Mixer(VOLUME, MAX_VOICES);
  a.mixer.add(file);
  a.player.play(createAudioResource(a.mixer, { inputType: StreamType.Raw }));
}

function stopPlayback(guildId: string) {
  const a = audio.get(guildId);
  a?.mixer?.stopAll();
  a?.player.stop(true);
}

const pageCount = (sounds: Sound[]) => Math.max(1, Math.ceil(sounds.length / PAGE_SIZE));

function panel(guildId: string, page: number) {
  const sounds = listSounds(guildId);
  if (!sounds.length) return { content: '🔊 No sounds yet. Add one with `/sound add`.', components: [] };
  const pages = pageCount(sounds);
  page = Math.min(Math.max(page, 0), pages - 1);

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const shown = sounds.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  for (let idx = 0; idx < shown.length; idx += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        shown.slice(idx, idx + 5).map((s) => {
          const button = new ButtonBuilder()
            .setCustomId(`sb:${s.name}`)
            .setLabel(s.name)
            .setStyle(s.onDiscord ? ButtonStyle.Primary : ButtonStyle.Secondary);
          return s.emoji ? button.setEmoji(s.emoji) : button;
        }),
      ),
    );
  }

  const controls = new ActionRowBuilder<ButtonBuilder>();
  if (pages > 1) {
    controls.addComponents(
      new ButtonBuilder().setCustomId(PREV).setEmoji('◀️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(NEXT).setEmoji('▶️').setStyle(ButtonStyle.Secondary),
    );
  }
  controls.addComponents(new ButtonBuilder().setCustomId(STOP).setEmoji('⏹️').setLabel('Stop').setStyle(ButtonStyle.Danger));
  rows.push(controls);

  const title = pages > 1 ? `🔊 **Soundboard** · page ${page + 1} of ${pages}` : '🔊 **Soundboard**';
  const legend = sounds.some((s) => s.onDiscord) ? '\n-# Blue sounds are also in Discord’s own soundboard, for instant spamming' : '';
  return { content: title + legend, components: rows };
}

function trackPanel(messageId: string, guildId: string, channelId: string, page: number) {
  db.prepare(
    'INSERT INTO sound_panels (message_id, guild_id, channel_id, page) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET page = excluded.page',
  ).run(messageId, guildId, channelId, page);
}

/** Re-renders a server's posted panels after its sound list changes */
async function refreshPanels(client: Client, guildId: string) {
  const panels = db.prepare('SELECT message_id, channel_id, page FROM sound_panels WHERE guild_id = ?').all(guildId) as {
    message_id: string;
    channel_id: string;
    page: number;
  }[];
  for (const p of panels) {
    try {
      const channel = await client.channels.fetch(p.channel_id);
      if (!channel?.isTextBased()) throw new Error(`channel ${p.channel_id} is not text-based`);
      // Editing by id avoids fetching the message, which would need Read Message History
      await channel.messages.edit(p.message_id, panel(guildId, p.page));
    } catch (err) {
      const gone =
        err instanceof DiscordAPIError && (err.code === RESTJSONErrorCodes.UnknownMessage || err.code === RESTJSONErrorCodes.UnknownChannel);
      if (gone) db.prepare('DELETE FROM sound_panels WHERE message_id = ?').run(p.message_id);
      else console.error(`Soundboard panel ${p.message_id} refresh failed:`, err instanceof Error ? err.message : err);
    }
  }
}

export const soundboard: Feature = {
  title: 'Soundboard',
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
        .addSubcommand((s) =>
          s
            .setName('discord-add')
            .setDescription('Copy a sound into Discord’s own soundboard')
            .addStringOption((o) => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true))
            .addNumberOption((o) =>
              o.setName('start').setDescription(`For sounds over ${discordBoard.CLIP_SECONDS} s: second to start the clip at`).setMinValue(0),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('discord-remove')
            .setDescription('Take a sound out of Discord’s soundboard (the bot keeps it)')
            .addStringOption((o) => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) => s.setName('discord-sync').setDescription('Copy every short sound into Discord’s soundboard while there are free slots'))
        .addSubcommand((s) => s.setName('stop').setDescription('Stop playback and leave voice'))
        .addSubcommand((s) => s.setName('panel').setDescription('Post a soundboard panel in this channel; it updates itself as sounds change')),
      async autocomplete(i) {
        if (!i.guildId) return i.respond([]);
        const query = i.options.getFocused().toLowerCase();
        return i.respond(
          listSounds(i.guildId)
            .filter((s) => s.name.includes(query))
            .slice(0, 25)
            .map((s) => ({
              name: `${s.emoji && !s.emoji.startsWith('<') ? `${s.emoji} ` : ''}${s.name}${s.onDiscord ? ' (on Discord’s soundboard)' : ''}`,
              value: s.name,
            })),
        );
      },
      async run(i) {
        const ephemeral = { flags: MessageFlags.Ephemeral } as const;
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', ...ephemeral });
        const sub = i.options.getSubcommand();

        if (sub === 'play') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          if (!i.member.voice.channel) return i.reply({ content: 'Join a voice channel first.', ...ephemeral });
          await i.deferReply(ephemeral);
          await play(i.member.voice.channel, sound.file);
          return i.editReply(`🔊 ${sound.name}`);
        }

        if (sub === 'add') {
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
          const existing = findSound(i.guildId, name);
          if (existing) rmSync(existing.file);
          writeFileSync(path.join(soundDir(i.guildId), name + ext), Buffer.from(await res.arrayBuffer()));
          // Replacing a sound keeps its emoji unless a new one was given
          if (emoji) setEmoji(i.guildId, name, emoji.emoji);

          const sound = findSound(i.guildId, name)!;
          const problem = await discordBoard.upload(i.guild, sound, VOLUME);
          // A replaced sound that no longer fits mustn't leave the old audio on Discord's soundboard
          if (problem) await discordBoard.remove(i.guild, name).catch(() => {});
          const note = problem ? `\nBot soundboard only: ${problem}.` : '\n🟦 Also added to Discord’s soundboard.';
          await i.editReply(`${existing ? '♻️ Replaced' : '➕ Added'} sound ${emoji ? emoji.emoji + ' ' : ''}**${name}**.${note}`);
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'emoji') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          const emojiInput = i.options.getString('emoji');
          const emoji = emojiInput ? await parseEmoji(i, emojiInput) : null;
          if (emoji && 'error' in emoji) return i.reply({ content: emoji.error, ...ephemeral });
          setEmoji(i.guildId, sound.name, emoji?.emoji ?? null);
          await discordBoard.setEmoji(i.guild, sound.name, emoji?.emoji ?? null);
          await i.reply({ content: emoji ? `${emoji.emoji} set on **${sound.name}**.` : `Cleared the emoji on **${sound.name}**.`, ...ephemeral });
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'remove') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          const problem = await discordBoard.remove(i.guild, sound.name).then(
            () => null,
            (err: Error) => err.message,
          );
          rmSync(sound.file);
          setEmoji(i.guildId, sound.name, null);
          await i.reply(`🗑️ Removed sound **${sound.name}**.${problem ? `\nCouldn’t remove it from Discord’s soundboard: ${problem}.` : ''}`);
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'discord-add') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          await i.deferReply();
          const problem = await discordBoard.upload(i.guild, sound, VOLUME, i.options.getNumber('start') ?? undefined);
          if (problem) return i.editReply(`Couldn’t add **${sound.name}** to Discord’s soundboard: ${problem}.`);
          const { used, total } = await discordBoard.slots(i.guild);
          await i.editReply(`🟦 **${sound.name}** is on Discord’s soundboard (${used}/${total} slots used).`);
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'discord-remove') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          if (!sound.onDiscord) return i.reply({ content: `**${sound.name}** isn’t on Discord’s soundboard.`, ...ephemeral });
          await i.deferReply();
          await discordBoard.remove(i.guild, sound.name);
          const { used, total } = await discordBoard.slots(i.guild);
          await i.editReply(`Took **${sound.name}** off Discord’s soundboard; it’s still on the bot’s (${used}/${total} slots used).`);
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'discord-sync') {
          await i.deferReply();
          await discordBoard.reconcile(i.guild);
          const added: string[] = [];
          const tooLong: string[] = [];
          const failed: string[] = [];
          const waiting: string[] = [];
          let blocker: string | null = null;
          for (const sound of listSounds(i.guildId).filter((s) => !s.onDiscord)) {
            if (blocker) {
              waiting.push(sound.name);
              continue;
            }
            if (!discordBoard.fits(await discordBoard.durationOf(sound.file).catch(() => Infinity))) {
              tooLong.push(sound.name);
              continue;
            }
            const problem = await discordBoard.upload(i.guild, sound, VOLUME);
            if (!problem) added.push(sound.name);
            else if (problem === discordBoard.FULL || problem === discordBoard.NO_PERMISSION) {
              blocker = problem;
              waiting.push(sound.name);
            } else failed.push(`${sound.name} (${problem})`);
          }

          const { used, total } = await discordBoard.slots(i.guild);
          const lines = [
            added.length ? `🟦 Added to Discord’s soundboard: ${added.join(', ')}` : 'Nothing new to add to Discord’s soundboard.',
            blocker && `Stopped because ${blocker}. Still bot-only: ${waiting.join(', ')}`,
            tooLong.length && `Over ${discordBoard.CLIP_SECONDS} s, so bot-only unless you pick a part with \`/sound discord-add start:\`: ${tooLong.join(', ')}`,
            failed.length && `Failed: ${failed.join(', ')}`,
            `${used}/${total} Discord soundboard slots used.`,
          ];
          await i.editReply(lines.filter(Boolean).join('\n'));
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'stop') {
          stopPlayback(i.guildId);
          getVoiceConnection(i.guildId)?.destroy();
          return i.reply({ content: '⏹️ Stopped.', ...ephemeral });
        }

        const reply = await i.reply({ ...panel(i.guildId, 0), withResponse: true });
        const message = reply.resource?.message;
        if (message) trackPanel(message.id, i.guildId, message.channelId, 0);
      },
    },
  ],
  async setup(client) {
    for (const guild of servedGuilds(client)) {
      await discordBoard.reconcile(guild).catch((err) => console.error(`Soundboard reconcile failed in ${guild.name}:`, err.message));
      await refreshPanels(client, guild.id);
    }
    client.on(Events.GuildSoundboardSoundDelete, (sound) => {
      if (discordBoard.forget(sound.soundId) && sound.guildId) void refreshPanels(client, sound.guildId);
    });
  },
  componentPrefix: 'sb',
  async onButton(i) {
    if (!i.inCachedGuild()) return;
    // Discord greys the button out until the click is acknowledged, so do that before anything else
    if (!i.customId.startsWith('sb:#') || i.customId === STOP) await i.deferUpdate();

    // Adopt panels posted before tracking existed, so they update on the next change too
    db.prepare('INSERT INTO sound_panels (message_id, guild_id, channel_id) VALUES (?, ?, ?) ON CONFLICT(message_id) DO NOTHING').run(
      i.message.id,
      i.guildId,
      i.channelId,
    );

    if (i.customId === PREV || i.customId === NEXT) {
      const row = db.prepare('SELECT page FROM sound_panels WHERE message_id = ?').get(i.message.id) as { page: number };
      const pages = pageCount(listSounds(i.guildId));
      const page = (Math.min(row.page, pages - 1) + (i.customId === NEXT ? 1 : pages - 1)) % pages;
      trackPanel(i.message.id, i.guildId, i.channelId, page);
      return i.update(panel(i.guildId, page));
    }

    if (i.customId === STOP) return stopPlayback(i.guildId);

    const sound = findSound(i.guildId, i.customId.slice('sb:'.length));
    if (!sound) return i.followUp({ content: 'That sound was removed.', flags: MessageFlags.Ephemeral });
    if (!i.member.voice.channel) {
      return i.followUp({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }
    await play(i.member.voice.channel, sound.file);
  },
};
