import { type Client, type Guild } from 'discord.js';
import { createReadStream, statSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { logActivity } from '../activity.ts';
import { feeds } from '../changes.ts';
import { config } from '../config.ts';
import * as discordBoard from '../discordSounds.ts';
import { musicState } from '../features/music.ts';
import { phrases, previewSpeech, removePhrase, savePhrase, say, serverVoice, TooSoon, voiceGroup, VOICES } from '../features/say.ts';
import { addGroup, addSound, addToDiscord, BIN_DAYS, changeEmoji, deleteGroup, fillGroup, moveGroup, placeSound, renameGroup, soundGroups, deletedSounds, eraseDeleted, expiresAt, favourites, findSound, listSounds, parseEmoji, playCounts, removeSound, renameSound, restoreDeleted, restoreSound, saveFromDiscord, setFavourite, setSoundVolume, type Sound, soundLevels, soundVolumes, swapOnDiscord, syncToDiscord, takeOffDiscord, trimmedSounds, trimProblem, trimSound, untaken, uploadProblem, volumeProblem } from '../features/soundLibrary.ts';
import { joinSounds, setJoinSound } from '../features/joinSounds.ts';
import { playDiscordSound, playFromWeb, playingNow, stopPlayback, stopPlayingOne } from '../features/voiceAudio.ts';
import { postPanel, refreshPanels } from '../features/soundPanel.ts';
import { setting } from '../settings.ts';
import { type Ask, Refused, by, cantDo, cantPost, memberList, nameOf, plain, postingChannel, readBody, readJson, refuse, untilGone, voiceChannelFor } from './common.ts';

// The management API for the sound library, Discord’s soundboard, the bin, join sounds, panels, what’s playing and speech

const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
};

// ffprobe per sound is slow, and a sound only changes by being replaced
const durations = new Map<string, { mtimeMs: number; seconds: number | null }>();

async function durationOf(file: string, mtimeMs: number): Promise<number | null> {
  const known = durations.get(file);
  if (known?.mtimeMs === mtimeMs) return known.seconds;
  const seconds = await discordBoard.durationOf(file).catch(() => null);
  durations.set(file, { mtimeMs, seconds });
  return seconds;
}

async function soundList(guild: Guild) {
  const sounds = [];
  const onDiscord = await discordBoard.board(guild).catch(() => null);
  const starred = favourites(guild.id);
  const plays = playCounts(guild.id);
  const levels = soundLevels(guild.id);
  const volumes = soundVolumes(guild.id);
  const trimmed = trimmedSounds(guild.id);
  const listed = listSounds(guild.id);
  // ffprobe is the slow part, so a few run at once
  const stats = listed.map((s) => statSync(s.file));
  const lengths: (number | null)[] = [];
  for (let n = 0; n < listed.length; n += 8) {
    lengths.push(...(await Promise.all(listed.slice(n, n + 8).map((s, k) => durationOf(s.file, stats[n + k].mtimeMs)))));
  }
  for (const [n, sound] of listed.entries()) {
    const { size } = stats[n];
    const seconds = lengths[n];
    const { volume, loudness } = volumes(sound.name);
    sounds.push({
      name: sound.name,
      emoji: sound.emoji ?? null,
      onDiscord: sound.onDiscord,
      bytes: size,
      seconds,
      fitsDiscord: seconds !== null && discordBoard.fits(seconds),
      favourite: starred.has(sound.name),
      plays: plays.get(sound.name) ?? 0,
      gainDb: levels.get(sound.name)?.gainDb ?? null,
      percent: levels.get(sound.name)?.percent ?? 100,
      volume,
      loudness,
      trimmed: trimmed.has(sound.name),
    });
  }
  return {
    sounds,
    // In their order, each with its sounds in order. Sounds in none come after, most played first
    groups: soundGroups(guild.id, new Set(listed.map((s) => s.name))),
    evenVolume: setting(guild.id, 'evenVolume'),
    slots: onDiscord && { used: onDiscord.used, total: onDiscord.total },
    discordSounds: onDiscord?.sounds.map(({ url: _, ...sound }) => sound) ?? [],
    emojis: guild.emojis.cache.map((e) => ({ id: e.id, name: e.name, animated: e.animated, code: e.toString() })),
    clipSeconds: discordBoard.CLIP_SECONDS,
  };
}

export function joinSoundList(guild: Guild) {
  return {
    joinSounds: joinSounds(guild.id).map((r) => ({ id: r.user_id, who: nameOf(guild, r.user_id), name: r.name })),
    members: memberList(guild),
    sounds: listSounds(guild.id).map((s) => s.name),
  };
}

export async function setJoinSoundFromWeb(guild: Guild, req: IncomingMessage, userId: string) {
  const person = guild.members.cache.get(userId);
  if (!person || person.user.bot) throw new Refused(404, 'They aren’t in this server.');
  const { name } = await readJson(req);
  const sound = typeof name === 'string' ? findSound(guild.id, name) : undefined;
  if (!sound) throw new Refused(404, 'No sound by that name.');
  setJoinSound(guild.id, userId, sound.name);
  logActivity(guild.id, by(), `Set ${person.displayName}’s join sound to **${sound.name}**`);
  return { warning: setting(guild.id, 'joinSounds') ? null : 'Join sounds are turned off in this server for now, so it won’t play until they’re turned back on.' };
}

const soundOf = (guild: Guild, name: string): Sound => {
  const sound = findSound(guild.id, name);
  if (!sound) throw new Refused(404, 'No sound by that name.');
  return sound;
};

/** The sound with this id on this server's soundboard, so no other address can be asked for */
async function discordSoundOf(guild: Guild, id: unknown) {
  const sound = (await discordBoard.board(guild)).sounds.find((s) => s.id === id);
  if (!sound) throw new Refused(404, 'That sound isn’t on Discord’s soundboard any more.');
  return sound;
}

export async function handleDiscordSound(client: Client<true>, guild: Guild, req: IncomingMessage, res: ServerResponse, id: string, part?: string) {
  const sound = await discordSoundOf(guild, id);
  const key = `${req.method} ${part ?? ''}`;
  if (key === 'GET audio') {
    const { data, ext } = await discordBoard.download(sound);
    res.writeHead(200, { 'content-type': AUDIO_TYPES[ext], 'content-length': data.length, 'cache-control': 'no-store' });
    res.end(data);
    return null;
  }
  if (key === 'POST play') {
    refuse(guild, await playDiscordSound(voiceChannelFor(guild, (await readJson(req)).channelId), sound));
    return {};
  }
  if (key === 'POST save') {
    const name = await saveFromDiscord(guild, sound).catch(cantDo);
    if (!sound.library) logActivity(guild.id, by(), `Saved **${sound.name}** from Discord’s soundboard as **${name}**`);
    await refreshPanels(client, guild.id);
    return { name };
  }
  if (key === 'DELETE ') {
    const name = await takeOffDiscord(guild, sound).catch(cantDo);
    logActivity(guild.id, by(), `Took **${sound.name}** off Discord’s soundboard`);
    await refreshPanels(client, guild.id);
    // The library name, so the page can put it back
    return { name };
  }
  throw new Refused(404, 'Not found.');
}

export async function handleSounds(client: Client<true>, guild: Guild, req: IncomingMessage, res: ServerResponse, url: URL, name?: string, part?: string) {
  const method = req.method!;
  // Everything but reading changes what the posted panels show
  const refresh = () => refreshPanels(client, guild.id);
  const note = (action: string) => logActivity(guild.id, by(), action);

  if (name === undefined) {
    if (method === 'GET') return soundList(guild);
    throw new Refused(405, 'Not here.');
  }

  if (part === 'audio' && method === 'GET') {
    const { file } = soundOf(guild, name);
    res.writeHead(200, {
      'content-type': AUDIO_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': statSync(file).size,
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
    return null;
  }

  if (part === 'play' && method === 'POST') {
    const sound = soundOf(guild, name);
    refuse(guild, await playFromWeb(voiceChannelFor(guild, (await readJson(req)).channelId), sound));
    return {};
  }

  if (part === 'trim' && method === 'POST') {
    const sound = soundOf(guild, name);
    const { start, end } = await readJson(req);
    refuse(guild, trimProblem(start, end, await discordBoard.durationOf(sound.file).catch(() => NaN)));
    const [from, to] = [start as number, end as number];
    if (!(await trimSound(guild, sound, from, to))) throw new Refused(400, 'That sound couldn’t be cut, so it wasn’t changed.');
    note(`Trimmed **${sound.name}** to ${(to - from).toFixed(1)} s`);
    return {};
  }

  if (part === 'restore' && method === 'POST') {
    const sound = soundOf(guild, name);
    if (!(await restoreSound(guild, sound))) throw new Refused(400, 'That sound hasn’t been trimmed.');
    note(`Restored the original **${sound.name}**`);
    return {};
  }

  if (part === 'discord') {
    const sound = soundOf(guild, name);
    if (method === 'PUT') {
      const { start, replacing } = await readJson(req);
      if (start !== undefined && (typeof start !== 'number' || !(start >= 0))) throw new Refused(400, 'Start has to be a number of seconds.');
      if (replacing !== undefined) {
        const outgoing = await discordSoundOf(guild, replacing);
        refuse(guild, await swapOnDiscord(guild, outgoing, sound, start).catch(cantDo));
        note(`Swapped **${outgoing.name}** for **${sound.name}** on Discord’s soundboard`);
      } else {
        refuse(guild, await addToDiscord(guild, sound, start));
        note(`Added **${sound.name}** to Discord’s soundboard`);
      }
    } else if (method === 'DELETE') {
      await discordBoard.remove(guild, sound.name);
      note(`Took **${sound.name}** off Discord’s soundboard`);
    } else throw new Refused(405, 'Not here.');
    await refresh();
    return {};
  }
  if (part !== undefined) throw new Refused(404, 'Not found.');

  if (method === 'PUT') {
    const ext = path.extname(url.searchParams.get('file') ?? '').toLowerCase();
    refuse(guild, uploadProblem(name, ext, Number(req.headers['content-length'] ?? 0)));
    // Read first, as a proxy can turn an answer sent mid-upload into a dropped connection
    const data = await readBody(req);
    // Replacing has to be asked for, so a name picked by accident can't cost anyone a sound. keep=1 picks a free name
    const taken = findSound(guild.id, name);
    if (taken && url.searchParams.get('replace') !== '1' && url.searchParams.get('keep') !== '1') throw new Refused(409, `There’s already a sound called ${name}.`);
    const saveAs = taken && url.searchParams.get('keep') === '1' ? untaken(guild.id, name) : name;
    const added = await addSound(guild, saveAs, ext, data, undefined, url.searchParams.get('discord') !== '0');
    if (!added) throw new Refused(400, 'That file doesn’t have any audio the bot can read, so it wasn’t saved.');
    note(`${added.replaced ? 'Replaced' : 'Added'} sound **${saveAs}**`);
    await refresh();
    return { name: saveAs, replaced: added.replaced, discordProblem: added.problem && plain(guild, added.problem) };
  }

  if (method === 'PATCH') {
    const sound = soundOf(guild, name);
    const body = await readJson(req);
    if ('emoji' in body) {
      if (body.emoji !== null && typeof body.emoji !== 'string') throw new Refused(400, 'Emoji has to be text.');
      const emoji = body.emoji ? await parseEmoji(guild, body.emoji) : null;
      if (emoji && 'error' in emoji) throw new Refused(400, emoji.error);
      await changeEmoji(guild, sound.name, emoji?.emoji ?? null);
      note(emoji ? `Set the emoji on **${sound.name}**` : `Cleared the emoji on **${sound.name}**`);
    }
    if ('favourite' in body) setFavourite(guild.id, sound.name, body.favourite === true);
    if ('place' in body) placeFromWeb(guild, sound.name, body.place);
    if ('volume' in body) {
      refuse(guild, volumeProblem(body.volume));
      await setSoundVolume(guild, sound.name, body.volume as number);
      note(`Set the volume of **${sound.name}** to ${body.volume as number}%`);
    }
    if ('name' in body) {
      refuse(guild, await renameSound(guild, sound, String(body.name)));
      note(`Renamed **${sound.name}** to **${String(body.name)}**`);
    }
    await refresh();
    // Moving or starring one changes the groups, which the page shows as they are now
    return 'place' in body || 'favourite' in body ? { groups: soundGroups(guild.id) } : {};
  }

  if (method === 'DELETE') {
    const { problem, binId } = await removeSound(guild, soundOf(guild, name));
    note(`Removed sound **${name}**`);
    await refresh();
    // The bin id lets the page undo it
    return { discordProblem: problem, binId };
  }
  throw new Refused(405, 'Not here.');
}

export function deletedList(guild: Guild) {
  return { days: BIN_DAYS, sounds: deletedSounds(guild.id).map((s) => ({ id: s.id, name: s.name, emoji: s.emoji, deletedAt: s.deleted_at, expiresAt: expiresAt(s) })) };
}

export async function handleDeleted(client: Client<true>, guild: Guild, req: IncomingMessage, id: string, action?: string) {
  const sound = deletedSounds(guild.id).find((s) => String(s.id) === id);
  if (!sound) throw new Refused(404, 'That sound isn’t in the bin any more.');
  if (action === 'restore' && req.method === 'POST') {
    const name = restoreDeleted(guild.id, sound.id);
    if (!name) throw new Refused(404, 'That sound isn’t in the bin any more.');
    logActivity(guild.id, by(), `Restored sound **${name}**`);
    await refreshPanels(client, guild.id);
    return { name };
  }
  if (action === undefined && req.method === 'DELETE') {
    eraseDeleted(guild.id, sound.id);
    logActivity(guild.id, by(), `Erased deleted sound **${sound.name}**`);
    return {};
  }
  throw new Refused(405, 'Not here.');
}

/** Moves a sound into a group, before one of its sounds or at the end, or with group null out of every group */
function placeFromWeb(guild: Guild, name: string, place: unknown) {
  const { group, before } = (place ?? {}) as { group?: unknown; before?: unknown };
  if (group !== null && !Number.isInteger(group)) throw new Refused(400, 'Say which group, or null for none.');
  if (before !== undefined && before !== null && typeof before !== 'string') throw new Refused(400, 'Before has to be a sound’s name.');
  const groups = soundGroups(guild.id);
  const from = groups.find((g) => g.sounds.includes(name));
  const to = groups.find((g) => g.id === group);
  if (group !== null && !to) throw new Refused(404, 'That group is gone.');
  refuse(guild, placeSound(guild.id, name, group as number | null, (before as string | null | undefined) ?? null));
  // Moving within a group isn't worth a line each time
  if (to && to !== from) logActivity(guild.id, by(), `Moved **${name}** to the sound group **${to.name}**`);
  else if (!to && from) logActivity(guild.id, by(), `Took **${name}** out of the sound group **${from.name}**`);
}

/**
 * The groups sounds are sorted into. POST makes one (with `sounds` and `at` to put back one that was deleted), PATCH renames or
 * moves one, DELETE deletes one, its sounds going back among the rest. Each answers with the groups as they are now
 */
async function handleGroups(client: Client<true>, guild: Guild, req: IncomingMessage, id?: string) {
  const note = (action: string) => logActivity(guild.id, by(), action);
  const done = async () => {
    await refreshPanels(client, guild.id);
    return { groups: soundGroups(guild.id) };
  };
  if (id === undefined) {
    if (req.method !== 'POST') throw new Refused(405, 'Not here.');
    const { name, sounds, at } = await readJson(req);
    if (typeof name !== 'string') throw new Refused(400, 'Give the group a name.');
    const made = addGroup(guild.id, name);
    if ('error' in made) throw new Refused(400, made.error);
    if (Array.isArray(sounds)) fillGroup(guild.id, made.id, sounds.filter((s): s is string => typeof s === 'string'));
    if (Number.isInteger(at)) moveGroup(guild.id, made.id, at as number);
    note(`Made the sound group **${name.trim()}**`);
    return done();
  }
  const group = soundGroups(guild.id).find((g) => g.id === Number(id));
  if (!group) throw new Refused(404, 'That group is gone.');
  if (req.method === 'PATCH') {
    const { name, to } = await readJson(req);
    if (name !== undefined) {
      if (typeof name !== 'string') throw new Refused(400, 'Give the group a name.');
      refuse(guild, renameGroup(guild.id, group.id, name));
      if (name.trim() !== group.name) note(`Renamed the sound group **${group.name}** to **${name.trim()}**`);
    }
    if (to !== undefined) {
      if (!Number.isInteger(to)) throw new Refused(400, 'Say where to move it.');
      moveGroup(guild.id, group.id, to as number);
    }
    return done();
  }
  if (req.method === 'DELETE') {
    deleteGroup(guild.id, group.id);
    note(`Deleted the sound group **${group.name}**`);
    return done();
  }
  throw new Refused(405, 'Not here.');
}

export async function soundRoutes({ client, guild, req, res, url, section, rest }: Ask) {
  if (section === 'sound-groups' && rest.length <= 1) return handleGroups(client, guild, req, rest[0]);
  if (section === 'sounds' && rest.length <= 2) return handleSounds(client, guild, req, res, url, rest[0], rest[1]);
  if (section === 'deleted-sounds' && !rest.length && req.method === 'GET') return deletedList(guild);
  if (section === 'deleted-sounds' && (rest.length === 1 || rest.length === 2)) return handleDeleted(client, guild, req, rest[0], rest[1]);
  if (section === 'sound-panels' && !rest.length && req.method === 'POST') {
    const channel = postingChannel(guild, (await readJson(req)).channelId);
    await postPanel(channel).catch(cantPost);
    logActivity(guild.id, by(), `Posted a soundboard panel in <#${channel.id}>`);
    return {};
  }
  if (section === 'discord-sounds' && (rest.length === 1 || rest.length === 2)) return handleDiscordSound(client, guild, req, res, rest[0], rest[1]);
  if (section === 'join-sounds' && !rest.length && req.method === 'GET') return joinSoundList(guild);
  if (section === 'join-sounds' && rest.length === 1 && req.method === 'PUT') return setJoinSoundFromWeb(guild, req, rest[0]);
  if (section === 'join-sounds' && rest.length === 1 && req.method === 'DELETE') {
    const who = joinSounds(guild.id).find((r) => r.user_id === rest[0]);
    if (!who) throw new Refused(404, 'They don’t have a join sound.');
    setJoinSound(guild.id, who.user_id, null);
    logActivity(guild.id, by(), `Removed ${nameOf(guild, who.user_id)}’s join sound`);
    return {};
  }
  if (section === 'say' && !rest.length && req.method === 'GET') {
    return { on: Boolean(config.voiceUrl) && setting(guild.id, 'tts'), voices: VOICES.map((v) => ({ id: v.id, name: v.name, group: voiceGroup(v) })), voice: serverVoice(guild.id).id, volume: setting(guild.id, 'ttsVolume'), longest: setting(guild.id, 'ttsMaxChars'), phrases: phrases(guild.id) };
  }
  if (section === 'say' && rest.length === 1 && rest[0] === 'preview' && req.method === 'GET') {
    if (!config.voiceUrl || !setting(guild.id, 'tts')) throw new Refused(409, 'Text to speech is off for this server.');
    const audio = await previewSpeech(guild, (url.searchParams.get('text') ?? '').slice(0, 2000), url.searchParams.get('voice') ?? '').catch((err: unknown) => {
      if (err instanceof TooSoon) throw new Refused(429, err.message);
      if (err instanceof Error && err.message.startsWith('There’s nothing')) throw new Refused(400, err.message);
      console.error(`Web UI: a voice preview in ${guild.name} failed:`, err);
      throw new Refused(502, 'The voice container isn’t answering. Try again in a moment.');
    });
    // Only whoever asked hears it, in their browser
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length, 'cache-control': 'no-store' });
    res.end(audio);
    return null;
  }
  if (section === 'say' && !rest.length && req.method === 'POST') {
    const { channelId, text, voice } = await readJson(req);
    if (typeof text !== 'string') throw new Refused(400, 'Type something to say.');
    refuse(guild, await say(voiceChannelFor(guild, channelId), text, typeof voice === 'string' ? voice : undefined, by()));
    return {};
  }
  if (section === 'phrases' && !rest.length && req.method === 'POST') {
    const { text } = await readJson(req);
    if (typeof text !== 'string') throw new Refused(400, 'Type something to save.');
    const known = phrases(guild.id).length;
    refuse(guild, savePhrase(guild, text));
    const saved = phrases(guild.id);
    if (saved.length > known) logActivity(guild.id, by(), `Saved the line “${saved.at(-1)!.text}”`);
    return { phrases: saved };
  }
  if (section === 'phrases' && rest.length === 1 && req.method === 'DELETE') {
    const phrase = phrases(guild.id).find((p) => p.id === Number(rest[0]));
    if (!phrase) throw new Refused(404, 'That saved line is gone.');
    removePhrase(guild.id, phrase.id);
    logActivity(guild.id, by(), `Removed the saved line “${phrase.text}”`);
    return { phrases: phrases(guild.id) };
  }
  if (section === 'stop' && !rest.length && req.method === 'POST') {
    // Sounds and speech only: the music has its own controls
    stopPlayback(guild.id, true);
    return { musicPlaying: musicState(guild.id).phase === 'playing' };
  }
  if (section === 'playing' && !rest.length && req.method === 'GET') {
    // With ?after=<version>, waits for a change, so the page hears of a one-second sound as it plays rather than polling for it
    const after = url.searchParams.get('after');
    if (after !== null) {
      const { gone, signal } = untilGone(req, res);
      await feeds.playing.next(guild.id, after, signal);
      if (gone.aborted) return;
    }
    return { version: feeds.playing.version(guild.id), playing: playingNow(guild.id) };
  }
  if (section === 'playing' && rest.length === 2 && rest[1] === 'stop' && req.method === 'POST') {
    if (!stopPlayingOne(guild.id, Number(rest[0]))) throw new Refused(404, 'That’s already finished.');
    return { playing: playingNow(guild.id) };
  }
  if (section === 'discord-sync' && !rest.length && req.method === 'POST') {
    const result = await syncToDiscord(guild);
    await refreshPanels(client, guild.id);
    if (result.added.length) logActivity(guild.id, by(), `Copied ${result.added.length} sound${result.added.length === 1 ? '' : 's'} to Discord’s soundboard`);
    return { ...result, failed: result.failed.map((f) => plain(guild, f)), blocker: result.blocker && plain(guild, result.blocker) };
  }
  throw new Refused(404, 'Not found.');
}
