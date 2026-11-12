import { Events, type Client, type Guild, type VoiceBasedChannel } from 'discord.js';
import { anyChange, type FeedName, feeds } from '../changes.ts';
import { playingNow } from '../features/soundboard.ts';
import { setting } from '../settings.ts';
import { humansIn } from '../util.ts';
import { type Ask, Refused, untilGone } from './common.ts';
import { musicList } from './music.ts';

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
export const updates: Record<FeedName, (guild: Guild) => object> = {
  playing: (guild) => ({ playing: playingNow(guild.id) }),
  music: (guild) => musicList(guild),
  voice: (guild) => ({ ...voiceList(guild), soundVolume: setting(guild.id, 'soundVolume') }),
};

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
  if (section === 'voice' && !rest.length && req.method === 'GET') return { ...voiceList(guild), soundVolume: setting(guild.id, 'soundVolume') };
  if (section === 'updates' && !rest.length && req.method === 'GET') {
    // One request per page for all it keeps up with: ?playing=&music=&voice= with the version it has of each it wants (empty
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
      if (version !== asked[name]) answer[name] = { version, ...updates[name](guild) };
    }
    return answer;
  }
  throw new Refused(404, 'Not found.');
}
