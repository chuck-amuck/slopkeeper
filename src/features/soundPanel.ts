import { ActionRowBuilder, ButtonBuilder, ButtonStyle, DiscordAPIError, escapeMarkdown, FileUploadBuilder, LabelBuilder, ModalBuilder, PermissionFlagsBits, RESTJSONErrorCodes, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle, type BaseInteraction, type ButtonInteraction, type Client, type Guild, type GuildTextBasedChannel, type ModalMessageModalSubmitInteraction } from 'discord.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { logActivity } from '../activity.ts';
import { db } from '../db.ts';
import * as discordBoard from '../discordSounds.ts';
import { idSetting, setSetting, setting } from '../settings.ts';
import { requestTimeout } from '../util.ts';
import { commandMention } from '../commandIds.ts';
import { BIN_DAYS, EVERYTHING_ELSE, EXTENSIONS, type Sound, VOLUME_PERCENT, addSound, addToDiscord, applyLevels, findSound, nameFromFile, orderedSounds, soundGroups, parseEmoji, removeSound, setSoundVolume, soundGain, soundLevels, untaken, uploadProblem } from './soundLibrary.ts';
import { play } from './voiceAudio.ts';

// The soundboard panel posted in Discord, its settings menu, and adding a sound from it or from /sound add

const PAGE_SIZE = 20; // 4 rows of 5 buttons; the fifth row holds the controls

// Control button ids use '#', which sound names can't contain
export const PREV = 'sb:#prev';

export const NEXT = 'sb:#next';

export const STOP = 'sb:#stop';

/** The buttons on the question /sound add asks when the name is taken: sb:#upload:<id>:<choice> */
export const UPLOAD = 'sb:#upload:';

/** How long that question waits for an answer */
const UPLOAD_WAIT_MS = 5 * 60_000;

export const SETTINGS = 'sb:#settings';

const VOLUME_STEP = 25;

export const INPUT = 'value';

const UPLOAD_FILE = 'file';

const UPLOAD_EMOJI = 'emoji';

interface Upload {
  name: string;
  ext: string;
  url: string;
  fileName: string;
  emoji?: string;
}

/** Uploads from /sound add waiting on whether to replace the sound of that name, by the id on their buttons */
const pendingUploads = new Map<string, Upload & { offered: string; timer: NodeJS.Timeout }>();

/** Asks what to do about an upload whose name is taken, as replacing a sound by accident is easy */
export function askAboutUpload(guildId: string, upload: Upload) {
  const id = randomUUID().slice(0, 8);
  const timer = setTimeout(() => pendingUploads.delete(id), UPLOAD_WAIT_MS).unref();
  const offered = untaken(guildId, upload.name);
  pendingUploads.set(id, { ...upload, offered, timer });
  const button = (choice: string, label: string, style: ButtonStyle) => new ButtonBuilder().setCustomId(`${UPLOAD}${id}:${choice}`).setLabel(label).setStyle(style);
  return {
    content: `There’s already a sound called **${upload.name}**. Replace it, or keep both and call the new one **${offered}**?\n-# A replaced sound stays in Recently deleted for ${BIN_DAYS} days.`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button('replace', 'Replace it', ButtonStyle.Danger),
        button('keep', 'Keep both', ButtonStyle.Primary),
        button('cancel', 'Cancel', ButtonStyle.Secondary),
      ),
    ],
  };
}

export async function answerUpload(i: ButtonInteraction<'cached'>) {
  const [id, choice] = i.customId.slice(UPLOAD.length).split(':');
  const pending = pendingUploads.get(id);
  if (!pending) return i.update({ content: 'That upload timed out. Run /sound add again.', components: [] });
  clearTimeout(pending.timer);
  pendingUploads.delete(id);
  if (choice === 'cancel') return i.update({ content: `Left **${pending.name}** as it was.`, components: [] });
  await i.update({ content: 'Adding it…', components: [] });
  // The name it offered, unless that's been taken since
  const name = choice === 'keep' ? untaken(i.guildId, pending.offered) : pending.name;
  try {
    // The question was private, but the result goes to everyone, as it does without a question
    await i.followUp(await storeUpload(i.guild, i.user.id, { ...pending, name }));
  } catch (err) {
    await i.editReply('That didn’t work. Try `/sound add` again.').catch(() => {});
    throw err;
  }
  await i.deleteReply().catch(() => {});
  return refreshPanels(i.client, i.guildId);
}

/** Downloads a /sound add file and stores it. Returns what to tell the channel */
export async function storeUpload(guild: Guild, userId: string, upload: Upload): Promise<string> {
  const res = await fetch(upload.url, { signal: requestTimeout() });
  if (!res.ok) return `Download failed (HTTP ${res.status}).`;
  const added = await addSound(guild, upload.name, upload.ext, Buffer.from(await res.arrayBuffer()), upload.emoji);
  if (!added) return `**${upload.fileName}** doesn’t have any audio I can read, so I didn’t save it.`;
  logActivity(guild.id, userId, `${added.replaced ? 'Replaced' : 'Added'} sound **${upload.name}**`);
  const note = added.problem ? `\nBot soundboard only: ${added.problem}.` : '\n🟦 Also added to Discord’s soundboard.';
  const binned = added.replaced ? `\n-# The old one is in Recently deleted for ${BIN_DAYS} days.` : '';
  return `${added.replaced ? '♻️ Replaced' : '➕ Added'} sound ${upload.emoji ? upload.emoji + ' ' : ''}**${upload.name}**.${note}${binned}`;
}

export const pageCount = (sounds: Sound[]) => Math.max(1, Math.ceil(sounds.length / PAGE_SIZE));

/** A page of sounds in the order people arranged them, packed from one group into the next to fit as many as can be */
export function panel(guildId: string, page: number) {
  const sounds = orderedSounds(guildId);
  if (!sounds.length) return { content: `🔊 No sounds yet. Add one with ${commandMention(guildId, 'sound add')}.`, components: [] };
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
  controls.addComponents(
    new ButtonBuilder().setCustomId(STOP).setEmoji('⏹️').setLabel('Stop').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(SETTINGS).setEmoji('⚙️').setLabel('Settings').setStyle(ButtonStyle.Secondary),
  );
  rows.push(controls);

  const title = pages > 1 ? `🔊 **Soundboard** · page ${page + 1} of ${pages}` : '🔊 **Soundboard**';
  // The groups on this page, in order, since the buttons can't show where one ends
  const groups = soundGroups(guildId, new Set(shown.map((s) => s.name))).filter((g) => g.sounds.length);
  const grouped = new Set(groups.flatMap((g) => g.sounds));
  // Group names are typed freely on the web UI, so they're shown as typed, never as formatting
  const names = [...groups.map((g) => escapeMarkdown(g.name)), ...(groups.length && shown.some((s) => !grouped.has(s.name)) ? [EVERYTHING_ELSE] : [])];
  const legend = [names.length && names.join(' · '), sounds.some((s) => s.onDiscord) && 'Blue sounds are also in Discord’s own soundboard, for instant spamming'].filter(Boolean).map((line) => `\n-# ${line}`).join('');
  // A group named like a mention mustn't ping anyone each time a panel is posted
  return { content: title + legend, components: rows, allowedMentions: { parse: [] } };
}

export function trackPanel(messageId: string, guildId: string, channelId: string, page: number) {
  db.prepare(
    'INSERT INTO sound_panels (message_id, guild_id, channel_id, page) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET page = excluded.page',
  ).run(messageId, guildId, channelId, page);
}

/** Posts a panel from outside Discord */
export async function postPanel(channel: GuildTextBasedChannel) {
  const message = await channel.send(panel(channel.guild.id, 0));
  trackPanel(message.id, channel.guild.id, channel.id, 0);
}

/** Sound names can't contain ':', so these split cleanly into action, page and sound */
const settingId = (action: string, page: number, name = '') => `sb:#${action}:${page}:${name}`;

export const isSetting = (customId: string) => customId.split(':').length === 4;

function actionButton(action: string, page: number, name: string, label: string, emoji: string, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(settingId(action, page, name)).setLabel(label).setEmoji(emoji).setStyle(style);
}

/** With a sound managers role set, changing sounds takes that role or Manage Server. Anyone can still play them */
export function canChangeSounds(i: BaseInteraction<'cached'>) {
  const role = idSetting(i.guildId, 'soundManagerRole');
  return !role || i.memberPermissions.has(PermissionFlagsBits.ManageGuild) || i.member.roles.cache.has(role);
}

export const managersOnly = (guildId: string) => `Only <@&${idSetting(guildId, 'soundManagerRole')}> and people with **Manage Server** can change sounds.`;

/** The first step of ⚙️ Settings: the sounds on a panel's page, and the server's switches for those allowed them */
export function settingsMenu(i: BaseInteraction<'cached'>, page: number, note?: string) {
  const { guildId } = i;
  // In the panel's order, so each page has the same sounds as the panel's
  const sounds = orderedSounds(guildId);
  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  page = Math.min(Math.max(page, 0), Math.max(pageCount(sounds) - 1, 0));
  const shown = sounds.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  if (shown.length) {
    const options = shown.map((s) => {
      const option = new StringSelectMenuOptionBuilder().setLabel(s.name).setValue(s.name);
      return s.emoji ? option.setEmoji(s.emoji) : option;
    });
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`sb:#pick:${page}`).setPlaceholder('Pick a sound').addOptions(options)));
  }
  if (i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
    const toggle = (action: string, label: string, on: boolean) =>
      new ButtonBuilder().setCustomId(settingId(action, page)).setLabel(`${label}: ${on ? 'on' : 'off'}`).setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        toggle('even', 'Even volume', setting(guildId, 'evenVolume')),
        toggle('joins', 'Join sounds', setting(guildId, 'joinSounds')),
      ),
    );
  }
  // Its own pages, so a sound on another page of the panel is reachable without moving the panel for everyone
  const pages = pageCount(sounds);
  const last = new ActionRowBuilder<ButtonBuilder>();
  if (canChangeSounds(i)) last.addComponents(actionButton('add', page, '', 'Add a sound', '➕', ButtonStyle.Primary));
  if (pages > 1) {
    const turn = (to: number, label: string, emoji: string) => actionButton('back', to, '', label, emoji).setDisabled(to < 0 || to >= pages);
    last.addComponents(turn(page - 1, 'Earlier sounds', '◀️'), turn(page + 1, 'Later sounds', '▶️'));
  }
  if (last.components.length) rows.push(last);
  const prompt = canChangeSounds(i) ? '⚙️ Pick a sound to change.' : `⚙️ Pick a sound to test. ${managersOnly(guildId)}`;
  const where = pages > 1 ? ` (page ${page + 1} of ${pages})` : '';
  const empty = canChangeSounds(i) ? '🔊 No sounds yet. Add one with the button below.' : `🔊 No sounds yet. ${managersOnly(guildId)}`;
  return { content: [note, shown.length ? `${prompt}${where}` : empty].filter(Boolean).join('\n'), components: rows };
}

/** Everything that can be changed about one sound, for those allowed to */
export function soundSettings(i: BaseInteraction<'cached'>, sound: Sound, page: number, note?: string) {
  const { guildId } = i;
  const percent = soundLevels(guildId).get(sound.name)?.percent ?? 100;
  const [lowest, highest] = VOLUME_PERCENT;
  const volume = (action: string, emoji: string, disabled: boolean) => new ButtonBuilder().setCustomId(settingId(action, page, sound.name)).setEmoji(emoji).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  const heading = `${sound.emoji ? `${sound.emoji} ` : ''}**${sound.name}** · ${percent}% volume · ${sound.onDiscord ? 'on Discord’s soundboard' : 'bot only'}`;
  if (!canChangeSounds(i)) {
    return {
      content: [note, heading, managersOnly(guildId)].filter(Boolean).join('\n'),
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(actionButton('test', page, sound.name, 'Test', '▶️'), actionButton('back', page, '', 'Back', '◀️'))],
    };
  }
  return {
    content: [note, heading].filter(Boolean).join('\n'),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        volume('down', '➖', percent <= lowest),
        volume('up', '➕', percent >= highest),
        actionButton('test', page, sound.name, 'Test', '▶️'),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        actionButton('discord', page, sound.name, sound.onDiscord ? 'Take off Discord' : 'Put on Discord', '🟦', sound.onDiscord ? ButtonStyle.Primary : ButtonStyle.Secondary),
        actionButton('emoji', page, sound.name, 'Emoji', '😀'),
        actionButton('rename', page, sound.name, 'Rename', '✏️'),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        actionButton('delete', page, sound.name, 'Delete', '🗑️', ButtonStyle.Danger),
        actionButton('back', page, '', 'Back', '◀️'),
      ),
    ],
  };
}

function askFor(id: string, title: string, label: string, value: string | undefined, required: boolean) {
  const input = new TextInputBuilder().setCustomId(INPUT).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(100);
  return new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(value ? input.setValue(value) : input));
}

/** The form behind Add a sound: a file, and optionally its name and emoji */
function uploadForm(page: number) {
  const text = (id: string, placeholder: string, max: number) =>
    new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(max).setPlaceholder(placeholder);
  return new ModalBuilder()
    .setCustomId(settingId('add', page))
    .setTitle('Add a sound')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Sound file')
        .setDescription(`${EXTENSIONS.map((e) => e.slice(1)).join(', ')}, up to 5 MB`)
        .setFileUploadComponent(new FileUploadBuilder().setCustomId(UPLOAD_FILE).setMinValues(1).setMaxValues(1).setRequired(true)),
      new LabelBuilder().setLabel('Name').setDescription('Lowercase letters, numbers, - and _. Leave empty to use the file’s name').setTextInputComponent(text(INPUT, 'airhorn', 32)),
      new LabelBuilder().setLabel('Emoji').setDescription('Shown on its button').setTextInputComponent(text(UPLOAD_EMOJI, '📯', 100)),
    );
}

/** Add a sound's form, sent: stores the file, or asks first if the name's taken, as /sound add does */
export async function submitUpload(i: ModalMessageModalSubmitInteraction<'cached'>, page: number) {
  if (!canChangeSounds(i)) return i.update(settingsMenu(i, page, managersOnly(i.guildId)));
  const file = i.fields.getUploadedFiles(UPLOAD_FILE, true).first()!;
  const name = i.fields.getTextInputValue(INPUT).trim().toLowerCase() || nameFromFile(file.name);
  const ext = path.extname(file.name).toLowerCase();
  const problem = uploadProblem(name, ext, file.size);
  if (problem) return i.update(settingsMenu(i, page, `⚠️ ${problem}`));
  const emojiInput = i.fields.getTextInputValue(UPLOAD_EMOJI).trim();
  const emoji = emojiInput ? await parseEmoji(i.guild, emojiInput) : null;
  if (emoji && 'error' in emoji) return i.update(settingsMenu(i, page, `⚠️ ${emoji.error}`));
  const upload = { name, ext, url: file.url, fileName: file.name, emoji: emoji?.emoji };
  if (findSound(i.guildId, name)) return i.update(askAboutUpload(i.guildId, upload));
  await i.deferUpdate();
  // The result goes to everyone, as it does from /sound add
  await i.followUp(await storeUpload(i.guild, i.user.id, upload));
  await refreshPanels(i.client, i.guildId);
  return i.editReply(settingsMenu(i, page));
}

export const SOUND_GONE = { content: 'That sound was removed.', components: [] };

/** The buttons under ⚙️ Settings, which live on a private message rather than the panel */
export async function onSetting(i: ButtonInteraction<'cached'>) {
  const [action, pageText, name] = i.customId.slice('sb:#'.length).split(':');
  const page = Number(pageText);
  const notify = () => refreshPanels(i.client, i.guildId);

  if (action === 'back') return i.update(settingsMenu(i, page));
  if (action === 'add') return canChangeSounds(i) ? i.showModal(uploadForm(page)) : i.update(settingsMenu(i, page, managersOnly(i.guildId)));

  if (action === 'even' || action === 'joins') {
    if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return i.update(settingsMenu(i, page, 'You need **Manage Server** for that.'));
    await i.deferUpdate();
    const [key, label] = action === 'even' ? (['evenVolume', 'Even volume'] as const) : (['joinSounds', 'Join sounds'] as const);
    const on = !setting(i.guildId, key);
    setSetting(i.guildId, key, on);
    if (action === 'even') await applyLevels(i.guild);
    logActivity(i.guildId, i.user.id, `Set ${label} to ${on ? 'on' : 'off'}`);
    return i.editReply(settingsMenu(i, page));
  }

  const sound = findSound(i.guildId, name);
  if (!sound) return i.update(SOUND_GONE);
  const show = (note?: string) => i.editReply(soundSettings(i, findSound(i.guildId, sound.name) ?? sound, page, note));

  if (action === 'open') return i.update(soundSettings(i, sound, page));
  // A button or box opened before the role was set, or taken away, still arrives here
  if (action !== 'test' && !canChangeSounds(i)) return i.update(soundSettings(i, sound, page));
  if (action === 'emoji') return i.showModal(askFor(settingId('emoji', page, sound.name), `Emoji for ${sound.name}`, 'Emoji, or leave empty to clear it', sound.emoji, false));
  if (action === 'rename') return i.showModal(askFor(settingId('rename', page, sound.name), `Rename ${sound.name}`, 'New name', sound.name, true));
  if (action === 'delete') {
    return i.update({
      content: `Delete **${sound.name}**? You can get it back for ${BIN_DAYS} days with ${commandMention(i.guildId, 'sound restore')}.`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          actionButton('confirm', page, sound.name, 'Yes, delete it', '🗑️', ButtonStyle.Danger),
          actionButton('open', page, sound.name, 'Keep it', '◀️'),
        ),
      ],
    });
  }

  await i.deferUpdate();
  if (action === 'confirm') {
    const { problem } = await removeSound(i.guild, sound);
    logActivity(i.guildId, i.user.id, `Removed sound **${sound.name}**`);
    await notify();
    const removed = `🗑️ Removed **${sound.name}**. Bring it back within ${BIN_DAYS} days with ${commandMention(i.guildId, 'sound restore')}.${problem ? ` Couldn’t remove it from Discord’s soundboard: ${problem}.` : ''}`;
    return i.editReply(settingsMenu(i, page, removed));
  }
  if (action === 'test') {
    if (!i.member.voice.channel) return show('Join a voice channel first.');
    const problem = await play(i.member.voice.channel, sound.file, soundGain(i.guildId, sound.name));
    return show(problem ?? undefined);
  }
  if (action === 'down' || action === 'up') {
    const current = soundLevels(i.guildId).get(sound.name)?.percent ?? 100;
    // Lands on a whole step, as the web UI's slider can leave it between two
    const next = action === 'up' ? (Math.floor(current / VOLUME_STEP) + 1) * VOLUME_STEP : (Math.ceil(current / VOLUME_STEP) - 1) * VOLUME_STEP;
    const percent = Math.min(Math.max(next, VOLUME_PERCENT[0]), VOLUME_PERCENT[1]);
    await setSoundVolume(i.guild, sound.name, percent);
    logActivity(i.guildId, i.user.id, `Set the volume of **${sound.name}** to ${percent}%`);
    return show();
  }
  if (action === 'discord') {
    if (sound.onDiscord) {
      const problem = await discordBoard.remove(i.guild, sound.name).then(() => null, (err: Error) => err.message);
      if (problem) return show(`Couldn’t take it off Discord’s soundboard: ${problem}.`);
      logActivity(i.guildId, i.user.id, `Took **${sound.name}** off Discord’s soundboard`);
    } else {
      const problem = await addToDiscord(i.guild, sound);
      if (problem) return show(`Couldn’t add it to Discord’s soundboard: ${problem}.`);
      logActivity(i.guildId, i.user.id, `Added **${sound.name}** to Discord’s soundboard`);
    }
    await notify();
    return show();
  }
}

/** Sends a panel's current state to Discord, which needs the bot to be able to see its channel */
export async function editPanel(client: Client, guildId: string, p: { message_id: string; channel_id: string; page: number }) {
  const channel = await client.channels.fetch(p.channel_id);
  if (!channel?.isTextBased()) throw new Error(`channel ${p.channel_id} is not text-based`);
  // Editing by id avoids fetching the message, which would need Read Message History
  await channel.messages.edit(p.message_id, panel(guildId, p.page));
}

/** Why each panel last couldn't be updated, so a sound change doesn't log the same thing every time */
const stuckPanels = new Map<string, string>();

/** Re-renders a server's posted panels after its sound list changes */
export async function refreshPanels(client: Client, guildId: string) {
  const panels = db.prepare('SELECT message_id, channel_id, page FROM sound_panels WHERE guild_id = ?').all(guildId) as {
    message_id: string;
    channel_id: string;
    page: number;
  }[];
  for (const p of panels) {
    try {
      await editPanel(client, guildId, p);
      stuckPanels.delete(p.message_id);
    } catch (err) {
      const gone =
        err instanceof DiscordAPIError && (err.code === RESTJSONErrorCodes.UnknownMessage || err.code === RESTJSONErrorCodes.UnknownChannel);
      if (gone) db.prepare('DELETE FROM sound_panels WHERE message_id = ?').run(p.message_id);
      else {
        const reason = err instanceof Error ? err.message : String(err);
        if (stuckPanels.get(p.message_id) !== reason) console.error(`Soundboard panel ${p.message_id} in channel ${p.channel_id} can’t be updated:`, reason);
        stuckPanels.set(p.message_id, reason);
      }
    }
  }
}
