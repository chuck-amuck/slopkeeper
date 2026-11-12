import { getVoiceConnections } from '@discordjs/voice';
import { Events, MessageFlags, SlashCommandBuilder, type Guild } from 'discord.js';
import path from 'node:path';
import { logActivity } from '../activity.ts';
import { db } from '../db.ts';
import { feeds } from '../changes.ts';
import * as discordBoard from '../discordSounds.ts';
import { isAllowed, setting } from '../settings.ts';
import type { Feature } from '../types.ts';
import { servedGuilds } from '../util.ts';
import { commandMention } from '../commandIds.ts';
import { BIN_DAYS, DAY, type Sound, VOLUME_PERCENT, addToDiscord, applyLevels, changeEmoji, clearBin, deletedSounds, dropMissingEmoji, findSound, levelLibrary, listSounds, parseEmoji, recordDiscordPlay, recordPlay, removeSound, renameSound, restoreDeleted, setSoundVolume, soundGain, syncToDiscord, uploadProblem } from './soundLibrary.ts';
import { applyMusicVolume, applySoundVolume, applySpeechVolume, leaveIfAlone, leaveVoice, musicOn, play, stopPlayback } from './voiceAudio.ts';
import { autoplayChanged } from './music.ts';
import { affectsLoopRoom, checkLoopRoom, noteLoopRoom, refreshLoopRoom, startLoopRoom, stopLoopRoom } from './loopRoom.ts';
import { playJoinSound, setJoinSound } from './joinSounds.ts';
import { INPUT, NEXT, PREV, SETTINGS, SOUND_GONE, STOP, UPLOAD, answerUpload, askAboutUpload, canChangeSounds, editPanel, isSetting, managersOnly, onSetting, pageCount, panel, refreshPanels, settingsMenu, soundSettings, storeUpload, submitUpload, trackPanel } from './soundPanel.ts';

/** The /sound subcommands that don't change any sound. Anything else needs the sound managers role, if there is one */
const OPEN_TO_ALL = new Set(['play', 'stop', 'join', 'panel']);

/** Puts changed settings into effect where they don't follow by themselves, from /setup and the web UI alike */
export async function afterSettingsChanged(guild: Guild, keys: string[]) {
  // Discord's copies of the sounds, and audio already playing, have their own volume
  if (keys.includes('evenVolume')) await applyLevels(guild);
  if (keys.includes('soundVolume')) {
    applySoundVolume(guild.id);
    // The volume beside Play in shows it
    feeds.voice.changed(guild.id);
  }
  if (keys.includes('ttsVolume')) applySpeechVolume(guild.id);
  if (keys.includes('musicVolume')) {
    applyMusicVolume(guild.id);
    // The music page shows it
    feeds.music.changed(guild.id);
  }
  if (keys.includes('musicAutoplay')) autoplayChanged(guild.id);
  if (keys.some(affectsLoopRoom)) await refreshLoopRoom(guild);
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
            .setName('restore')
            .setDescription(`Bring back a sound deleted in the last ${BIN_DAYS} days`)
            .addStringOption((o) => o.setName('name').setDescription('Deleted sound').setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('volume')
            .setDescription('Set how loud one sound plays, for any that even volume doesn’t get right')
            .addStringOption((o) => o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true))
            .addIntegerOption((o) => o.setName('percent').setDescription('100 is normal').setRequired(true).setMinValue(VOLUME_PERCENT[0]).setMaxValue(VOLUME_PERCENT[1])),
        )
        .addSubcommand((s) =>
          s
            .setName('join')
            .setDescription('Pick a sound that plays when you join voice')
            .addStringOption((o) => o.setName('name').setDescription('Leave empty to stop having one').setAutocomplete(true)),
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
        .addSubcommand((s) => s.setName('stop').setDescription('Stop sounds and speech, and leave voice unless music is playing'))
        .addSubcommand((s) => s.setName('panel').setDescription('Post a soundboard panel in this channel; it updates itself as sounds change')),
      async autocomplete(i) {
        if (!i.guildId) return i.respond([]);
        const query = i.options.getFocused().toLowerCase();
        if (i.options.getSubcommand() === 'restore') {
          return i.respond(
            deletedSounds(i.guildId)
              .filter((s) => s.name.includes(query))
              .slice(0, 25)
              .map((s) => ({ name: s.name, value: String(s.id) })),
          );
        }
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
        if (!OPEN_TO_ALL.has(sub) && !canChangeSounds(i)) return i.reply({ content: managersOnly(i.guildId), ...ephemeral });

        if (sub === 'play') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          if (!i.member.voice.channel) return i.reply({ content: 'Join a voice channel first.', ...ephemeral });
          await i.deferReply(ephemeral);
          const problem = await play(i.member.voice.channel, sound.file, soundGain(i.guildId, sound.name));
          if (!problem) recordPlay(i.guildId, i.user.id, sound.name);
          return i.editReply(problem ?? `🔊 ${sound.name}`);
        }

        if (sub === 'add') {
          const name = i.options.getString('name', true).toLowerCase();
          const file = i.options.getAttachment('file', true);
          const emojiInput = i.options.getString('emoji');
          const ext = path.extname(file.name).toLowerCase();
          const problem = uploadProblem(name, ext, file.size);
          if (problem) return i.reply({ content: problem, ...ephemeral });
          const emoji = emojiInput ? await parseEmoji(i.guild, emojiInput) : null;
          if (emoji && 'error' in emoji) return i.reply({ content: emoji.error, ...ephemeral });

          const upload = { name, ext, url: file.url, fileName: file.name, emoji: emoji?.emoji };
          if (findSound(i.guildId, name)) return i.reply({ ...askAboutUpload(i.guildId, upload), ...ephemeral });
          await i.deferReply();
          await i.editReply(await storeUpload(i.guild, i.user.id, upload));
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'emoji') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          // Changing it on Discord's soundboard too can take longer than the 3 s Discord waits for an answer
          await i.deferReply(ephemeral);
          const emojiInput = i.options.getString('emoji');
          const emoji = emojiInput ? await parseEmoji(i.guild, emojiInput) : null;
          if (emoji && 'error' in emoji) return i.editReply(emoji.error);
          await changeEmoji(i.guild, sound.name, emoji?.emoji ?? null);
          logActivity(i.guildId, i.user.id, emoji ? `Set the emoji on **${sound.name}**` : `Cleared the emoji on **${sound.name}**`);
          await i.editReply(emoji ? `${emoji.emoji} set on **${sound.name}**.` : `Cleared the emoji on **${sound.name}**.`);
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'remove') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          // Taking it off Discord's soundboard too can take longer than the 3 s Discord waits for an answer
          await i.deferReply();
          const { problem } = await removeSound(i.guild, sound);
          logActivity(i.guildId, i.user.id, `Removed sound **${sound.name}**`);
          await i.editReply(`🗑️ Removed sound **${sound.name}**. Bring it back within ${BIN_DAYS} days with ${commandMention(i.guildId, 'sound restore')}.${problem ? `\nCouldn’t remove it from Discord’s soundboard: ${problem}.` : ''}`);
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'restore') {
          const input = i.options.getString('name', true);
          const deleted = deletedSounds(i.guildId).find((s) => String(s.id) === input || s.name === input);
          const name = deleted && restoreDeleted(i.guildId, deleted.id);
          if (!name) return i.reply({ content: `No deleted sound by that name. They’re kept for ${BIN_DAYS} days.`, ...ephemeral });
          logActivity(i.guildId, i.user.id, `Restored sound **${name}**`);
          await i.reply(`♻️ Restored **${name}**${name === deleted.name ? '' : `, as **${deleted.name}** is taken`}. It’s not on Discord’s soundboard until it’s added again.`);
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'volume') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          const percent = i.options.getInteger('percent', true);
          await i.deferReply(ephemeral);
          await setSoundVolume(i.guild, sound.name, percent);
          logActivity(i.guildId, i.user.id, `Set the volume of **${sound.name}** to ${percent}%`);
          return i.editReply(`🔉 **${sound.name}** plays at ${percent}% now.`);
        }

        if (sub === 'join') {
          const name = i.options.getString('name');
          if (!name) {
            setJoinSound(i.guildId, i.user.id, null);
            logActivity(i.guildId, i.user.id, 'Cleared their join sound');
            return i.reply({ content: 'You don’t have a join sound any more.', ...ephemeral });
          }
          const sound = findSound(i.guildId, name);
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          setJoinSound(i.guildId, i.user.id, sound.name);
          logActivity(i.guildId, i.user.id, `Set their join sound to **${sound.name}**`);
          const off = setting(i.guildId, 'joinSounds') ? '' : ' Join sounds are turned off in this server for now, so it won’t play until an admin turns them on.';
          return i.reply({ content: `🚪 **${sound.name}** plays when you join voice.${off}`, ...ephemeral });
        }

        if (sub === 'discord-add') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          await i.deferReply();
          const problem = await addToDiscord(i.guild, sound, i.options.getNumber('start') ?? undefined);
          if (problem) return i.editReply(`Couldn’t add **${sound.name}** to Discord’s soundboard: ${problem}.`);
          logActivity(i.guildId, i.user.id, `Added **${sound.name}** to Discord’s soundboard`);
          const { used, total } = await discordBoard.board(i.guild);
          await i.editReply(`🟦 **${sound.name}** is on Discord’s soundboard (${used}/${total} slots used).`);
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'discord-remove') {
          const sound = findSound(i.guildId, i.options.getString('name', true));
          if (!sound) return i.reply({ content: 'No sound by that name.', ...ephemeral });
          if (!sound.onDiscord) return i.reply({ content: `**${sound.name}** isn’t on Discord’s soundboard.`, ...ephemeral });
          await i.deferReply();
          await discordBoard.remove(i.guild, sound.name);
          logActivity(i.guildId, i.user.id, `Took **${sound.name}** off Discord’s soundboard`);
          const { used, total } = await discordBoard.board(i.guild);
          await i.editReply(`Took **${sound.name}** off Discord’s soundboard; it’s still on the bot’s (${used}/${total} slots used).`);
          return refreshPanels(i.client, i.guildId);
        }

        if (sub === 'discord-sync') {
          await i.deferReply();
          const { added, tooLong, failed, waiting, blocker } = await syncToDiscord(i.guild);
          if (added.length) logActivity(i.guildId, i.user.id, `Copied ${added.length} sound${added.length === 1 ? '' : 's'} to Discord’s soundboard`);
          const { used, total } = await discordBoard.board(i.guild);
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
          // Music has its own controls and DJ role, so like the panel's Stop this leaves it playing
          const music = musicOn(i.guildId);
          if (music) stopPlayback(i.guildId, true);
          else leaveVoice(i.guildId);
          // Said in the channel, like /music stop, so people in voice can see who stopped it
          return i.reply({
            content: music ? `⏹️ Stopped the sounds and speech. The music carries on: ${commandMention(i.guildId, 'music pause')} pauses it.` : '⏹️ Stopped the sounds.',
            allowedMentions: { parse: [] },
          });
        }

        const reply = await i.reply({ ...panel(i.guildId, 0), withResponse: true });
        const message = reply.resource?.message;
        if (!message) return;
        trackPanel(message.id, i.guildId, message.channelId, 0);
        // Slash commands work in channels the bot can't see, but it can't keep a panel up to date there
        await editPanel(i.client, i.guildId, { message_id: message.id, channel_id: message.channelId, page: 0 }).catch(() =>
          i.followUp({ content: 'This panel works, but it can’t update itself when sounds change, because I can’t see this channel. If it’s private, add me to it under **Edit Channel → Permissions**.', ...ephemeral }),
        );
      },
    },
  ],
  async setup(client) {
    startLoopRoom(client);
    const sweep = () => {
      try {
        clearBin();
      } catch (err) {
        console.error('Clearing the sound bin failed:', err);
      }
    };
    sweep();
    setInterval(sweep, DAY);
    for (const guild of servedGuilds(client)) {
      await discordBoard.reconcile(guild).catch((err) => console.error(`Soundboard reconcile failed in ${guild.name}:`, err.message));
      dropMissingEmoji(guild);
      await refreshPanels(client, guild.id);
    }
    client.on(Events.GuildEmojiDelete, (emoji) => {
      if (isAllowed(emoji.guild.id) && dropMissingEmoji(emoji.guild)) void refreshPanels(client, emoji.guild.id);
    });
    client.on(Events.VoiceStateUpdate, (old, state) => {
      if (!isAllowed(state.guild.id)) return;
      leaveIfAlone(state.guild);
      noteLoopRoom(old, state);
      void playJoinSound(old, state).catch(console.error);
      void checkLoopRoom(state.guild).catch(console.error);
    });
    client.on(Events.VoiceChannelEffectSend, (effect) => {
      if (isAllowed(effect.guild.id) && effect.soundId !== null) recordDiscordPlay(effect.guild, effect.userId, String(effect.soundId));
    });
    client.on(Events.GuildSoundboardSoundDelete, (sound) => {
      if (discordBoard.forget(sound.soundId) && sound.guildId) void refreshPanels(client, sound.guildId);
    });
    // Not waited for: a whole library takes a while the first time, and nothing else depends on it
    void levelLibrary(client).catch(console.error);
  },
  shutdown() {
    stopLoopRoom();
    for (const guildId of getVoiceConnections().keys()) leaveVoice(guildId);
  },
  componentPrefix: 'sb',
  async onButton(i) {
    if (!i.inCachedGuild()) return;
    if (i.customId.startsWith(UPLOAD)) return answerUpload(i);
    if (isSetting(i.customId)) return onSetting(i);
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

    // Like the web UI's Stop, this leaves the music alone, as it has its own controls
    if (i.customId === STOP) return stopPlayback(i.guildId, true);

    if (i.customId === SETTINGS) {
      const { page } = db.prepare('SELECT page FROM sound_panels WHERE message_id = ?').get(i.message.id) as { page: number };
      return i.reply({ ...settingsMenu(i, page), flags: MessageFlags.Ephemeral });
    }

    const sound = findSound(i.guildId, i.customId.slice('sb:'.length));
    if (!sound) return i.followUp({ content: 'That sound was removed.', flags: MessageFlags.Ephemeral });
    if (!i.member.voice.channel) {
      return i.followUp({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }
    const problem = await play(i.member.voice.channel, sound.file, soundGain(i.guildId, sound.name));
    if (problem) return i.followUp({ content: problem, flags: MessageFlags.Ephemeral });
    recordPlay(i.guildId, i.user.id, sound.name);
  },
  async onSelect(i) {
    if (!i.inCachedGuild()) return;
    const page = Number(i.customId.split(':')[2]);
    const sound = findSound(i.guildId, i.values[0]);
    return i.update(sound ? soundSettings(i, sound, page) : SOUND_GONE);
  },
  async onModal(i) {
    if (!i.inCachedGuild() || !i.isFromMessage()) return;
    const [action, pageText, name] = i.customId.slice('sb:#'.length).split(':');
    const page = Number(pageText);
    if (action === 'add') return submitUpload(i, page);
    const sound = findSound(i.guildId, name);
    if (!sound) return i.update(SOUND_GONE);
    if (!canChangeSounds(i)) return i.update(soundSettings(i, sound, page));
    await i.deferUpdate();
    const value = i.fields.getTextInputValue(INPUT).trim();
    const done = async (shown: Sound, note?: string) => {
      await refreshPanels(i.client, i.guildId);
      return i.editReply(soundSettings(i, shown, page, note));
    };

    if (action === 'emoji') {
      const emoji = value ? await parseEmoji(i.guild, value) : null;
      if (emoji && 'error' in emoji) return i.editReply(soundSettings(i, sound, page, emoji.error));
      await changeEmoji(i.guild, sound.name, emoji?.emoji ?? null);
      logActivity(i.guildId, i.user.id, emoji ? `Set the emoji on **${sound.name}**` : `Cleared the emoji on **${sound.name}**`);
      return done(findSound(i.guildId, sound.name)!);
    }

    if (value === sound.name) return i.editReply(soundSettings(i, sound, page));
    const problem = await renameSound(i.guild, sound, value);
    if (problem) return i.editReply(soundSettings(i, sound, page, problem));
    logActivity(i.guildId, i.user.id, `Renamed **${sound.name}** to **${value}**`);
    return done(findSound(i.guildId, value)!);
  },
};
