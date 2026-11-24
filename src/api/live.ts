import { Events, type Client, type Guild, type VoiceBasedChannel } from 'discord.js';
import { anyChange, type FeedName, feeds } from '../changes.ts';
import { activeProfile, profiles } from '../features/chatProfiles.ts';
import { photos } from '../features/profilePhotos.ts';
import { PREVIEWED, playingNow, previewVolume } from '../features/voiceAudio.ts';
import { checkSetting } from '../features/setup.ts';
import { config } from '../config.ts';
import { idSetting, setting } from '../settings.ts';
import { humansIn } from '../util.ts';
import { type Ask, Refused, plain, readJson, untilGone } from './common.ts';
import { musicList } from './music.ts';
import { nightList } from './nights.ts';
import { activityList } from './server.ts';
import { deletedList, soundList, speechOffer } from './sounds.ts';

// Who’s in voice, and the one request a page keeps open to hear what changes

/** Channels with people in them, busiest first */
export function voiceList(guild: Guild) {
  const channels = [...guild.channels.cache.values()].filter((c): c is VoiceBasedChannel => c.isVoiceBased() && c.id !== guild.afkChannelId && humansIn(c).length > 0);
  return {
    channels: channels
      .map((c) => ({ id: c.id, name: c.name, people: humansIn(c).map((m) => m.displayName) }))
      .sort((a, b) => b.people.length - a.people.length),
  };
}

/** What /updates answers with for each feed that changed, at its new version */
export const updates: Record<FeedName, (guild: Guild) => object | Promise<object>> = {
  playing: (guild) => ({ playing: playingNow(guild.id) }),
  music: (guild) => musicList(guild),
  voice: (guild) => voiceList(guild),
  nights: (guild) => nightList(guild),
  // The newest page: a page that has seen less than all of it starts again from there
  activity: (guild) => activityList(guild),
  sounds: (guild) => soundsNow(guild),
  volumes: (guild) => volumesOf(guild),
  // Only that there's more: the Health tab asks for the range it shows
  health: () => ({}),
  // Likewise: the Deals tab asks for the lot again
  deals: () => ({}),
  profile: (guild) => profilePicks(guild),
  speech: (guild) => speechOffer(guild),
};

/** The profiles to pick from in the header, with their photos, and the server's */
export function profilePicks(guild: Guild) {
  const hashes = photos();
  return { profiles: profiles().map((p) => ({ id: p.id, name: p.name, photo: hashes.get(p.id) ?? '' })), active: activeProfile(guild.id).id };
}

/** How loud the bot plays each thing, for everyone in the server. Null for what isn't set up, so there's no slider for it */
export function volumesOf(guild: Guild) {
  const id = guild.id;
  const speech = Boolean(config.voiceUrl);
  const loop = idSetting(id, 'loopRoom') !== null;
  return {
    sounds: setting(id, 'soundVolume'),
    speech: speech && setting(id, 'tts') ? setting(id, 'ttsVolume') : null,
    music: config.musicUrl ? setting(id, 'musicVolume') : null,
    loopSound: loop && setting(id, 'loopSound') ? setting(id, 'loopVolume') : null,
    loopSpeech: loop && speech && setting(id, 'loopText') ? setting(id, 'loopTextVolume') : null,
  };
}

/**
 * The library, its groups and Discord's soundboard, as /sounds has them, with the bin. Every tab open on the soundboard
 * asks at once when it changes, so each version is worked out once
 */
const soundsAt = new Map<string, { version: string; answer: Promise<object> }>();
function soundsNow(guild: Guild) {
  const version = feeds.sounds.version(guild.id);
  const known = soundsAt.get(guild.id);
  if (known?.version === version) return known.answer;
  const answer = soundList(guild).then((list) => ({ ...list, bin: deletedList(guild) }));
  soundsAt.set(guild.id, { version, answer });
  // A failure isn't kept, so the next ask tries again
  answer.catch(() => soundsAt.get(guild.id)?.answer === answer && soundsAt.delete(guild.id));
  return answer;
}

/**
 * Tells pages keeping up with who's in voice when people come and go, a channel is renamed or someone changes their
 * name. The music page shows channel names and who queued each song too
 */
export function followVoice(client: Client) {
  client.on(Events.VoiceStateUpdate, (old, state) => {
    if (old.channelId === state.channelId) return;
    feeds.voice.changed(state.guild.id);
    // The music page shows where the bot is, which a sound played elsewhere moves it from
    if (state.id === client.user?.id) feeds.music.changed(state.guild.id);
  });
  client.on(Events.ChannelUpdate, (old, channel) => {
    if (channel.isDMBased() || !channel.isVoiceBased() || ('name' in old && old.name === channel.name)) return;
    feeds.voice.changed(channel.guild.id);
    feeds.music.changed(channel.guild.id);
  });
  client.on(Events.GuildMemberUpdate, (old, member) => {
    if (!old.partial && old.displayName === member.displayName) return;
    if (member.voice.channelId) feeds.voice.changed(member.guild.id);
    feeds.music.changed(member.guild.id);
  });
}

export async function liveRoutes({ client, guild, req, res, url, section, rest }: Ask) {
  if (section === 'voice' && !rest.length && req.method === 'GET') return voiceList(guild);
  if (section === 'volumes' && !rest.length && req.method === 'GET') return { version: feeds.volumes.version(guild.id), ...volumesOf(guild) };
  // A slider being dragged, heard on what's playing but not saved or logged: saving the setting is what keeps it
  if (section === 'volumes' && rest.length === 2 && rest[1] === 'preview') {
    if (req.method !== 'POST') throw new Refused(405, 'Not here.');
    const name = rest[0];
    if (!Object.hasOwn(PREVIEWED, name)) throw new Refused(404, 'No such volume.');
    const previewed = name as keyof typeof PREVIEWED;
    const checked = checkSetting(guild, PREVIEWED[previewed].key, (await readJson(req)).value);
    if ('error' in checked) throw new Refused(400, plain(guild, checked.error));
    previewVolume(guild.id, previewed, checked.value as number);
    return {};
  }
  if (section === 'updates' && !rest.length && req.method === 'GET') {
    // One request per page for all it keeps up with: ?playing=&music=&sounds=… with the version it has of each it wants (empty
    // for none yet). It waits until one changes, then answers with only those that did, or with nothing after a while
    const asked: Partial<Record<FeedName, string>> = {};
    for (const name of Object.keys(feeds) as FeedName[]) {
      const version = url.searchParams.get(name);
      if (version !== null) asked[name] = version;
    }
    const names = Object.keys(asked) as FeedName[];
    if (!names.length) throw new Refused(400, `Ask for any of ${Object.keys(feeds).join(', ')}.`);
    const { gone, signal } = untilGone(req, res);
    await anyChange(guild.id, asked, signal);
    if (gone.aborted) return;
    const answer: Partial<Record<FeedName, object>> = {};
    for (const name of names) {
      const version = feeds[name].version(guild.id);
      if (version === asked[name]) continue;
      // One part that can't be worked out leaves the rest to go, and is asked for again
      try {
        answer[name] = { version, ...(await updates[name](guild)) };
      } catch (err) {
        console.error(`Live ${name} for ${guild.name}:`, err);
      }
    }
    return answer;
  }
  throw new Refused(404, 'Not found.');
}
