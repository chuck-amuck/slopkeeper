import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
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
  MessageFlags,
  SlashCommandBuilder,
  type VoiceBasedChannel,
} from 'discord.js';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import type { Feature } from '../types.ts';

const SOUND_DIR = path.join(config.dataDir, 'sounds');
const EXTENSIONS = ['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.webm', '.flac'];
const MAX_BYTES = 5 * 1024 * 1024;
const VOLUME = 0.5;
const IDLE_LEAVE_MS = 5 * 60_000;
const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

mkdirSync(SOUND_DIR, { recursive: true });

function listSounds(): { name: string; file: string }[] {
  return readdirSync(SOUND_DIR)
    .filter((f) => EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .map((f) => ({ name: path.parse(f).name, file: path.join(SOUND_DIR, f) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const findSound = (name: string) => listSounds().find((s) => s.name === name);

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
  const resource = createAudioResource(file, { inlineVolume: true });
  resource.volume?.setVolume(VOLUME);
  player.play(resource);
}

function panel() {
  const sounds = listSounds().slice(0, 25); // Discord limit: 5 rows x 5 buttons
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let idx = 0; idx < sounds.length; idx += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        sounds.slice(idx, idx + 5).map((s) => new ButtonBuilder().setCustomId(`sb:${s.name}`).setLabel(s.name).setStyle(ButtonStyle.Secondary)),
      ),
    );
  }
  return rows;
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
            .addAttachmentOption((o) => o.setName('file').setDescription('mp3, ogg, wav, m4a, opus, webm or flac').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Delete a sound')
            .addStringOption((o) => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) => s.setName('stop').setDescription('Stop playback and leave voice'))
        .addSubcommand((s) => s.setName('panel').setDescription('Post a button panel of sounds in this channel')),
      async autocomplete(i) {
        const query = i.options.getFocused().toLowerCase();
        return i.respond(
          listSounds()
            .filter((s) => s.name.includes(query))
            .slice(0, 25)
            .map((s) => ({ name: s.name, value: s.name })),
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
          const name = i.options.getString('name', true).toLowerCase();
          const file = i.options.getAttachment('file', true);
          const ext = path.extname(file.name).toLowerCase();
          if (!NAME_PATTERN.test(name)) return i.reply({ content: 'Name can only use lowercase letters, numbers, - and _.', ...ephemeral });
          if (!EXTENSIONS.includes(ext)) return i.reply({ content: `Unsupported file type. Use one of: ${EXTENSIONS.join(', ')}`, ...ephemeral });
          if (file.size > MAX_BYTES) return i.reply({ content: 'File is over 5 MB.', ...ephemeral });

          await i.deferReply();
          const res = await fetch(file.url);
          if (!res.ok) return i.editReply(`Download failed (HTTP ${res.status}).`);
          const existing = findSound(name);
          if (existing) rmSync(existing.file);
          writeFileSync(path.join(SOUND_DIR, name + ext), Buffer.from(await res.arrayBuffer()));
          return i.editReply(`${existing ? '♻️ Replaced' : '➕ Added'} sound **${name}**.`);
        }

        if (sub === 'remove') {
          const sound = findSound(i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          rmSync(sound.file);
          return i.reply(`🗑️ Removed sound **${sound.name}**.`);
        }

        if (sub === 'stop') {
          player.stop(true);
          getVoiceConnection(config.guildId)?.destroy();
          return i.reply({ content: '⏹️ Stopped.', ...ephemeral });
        }

        const count = listSounds().length;
        if (!count) return i.reply({ content: 'No sounds yet. Add one with `/sound add`.', ...ephemeral });
        return i.reply({
          content: count > 25 ? `🔊 Soundboard (first 25 of ${count}; use \`/sound play\` for the rest)` : '🔊 Soundboard',
          components: panel(),
        });
      },
    },
  ],
  buttonPrefix: 'sb',
  async onButton(i) {
    const sound = findSound(i.customId.slice('sb:'.length));
    if (!sound) return i.reply({ content: 'That sound was removed.', flags: MessageFlags.Ephemeral });
    if (!i.inCachedGuild() || !i.member.voice.channel) {
      return i.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }
    await i.deferUpdate();
    await play(i.member.voice.channel, sound.file);
  },
};
