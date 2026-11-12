import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type VoiceBasedChannel,
} from 'discord.js';
import { db } from '../db.ts';
import type { Feature } from '../types.ts';
import { humansIn } from '../util.ts';
import { candidatesFor, NOBODY_COUNTED, type Candidate } from './games.ts';

/** Two rows of buttons; the rest of Discord's five rows would just be more to read */
const MAX_OPTIONS = 10;
/** Slots that go to the most-played games. The rest are random, so games nobody has played yet get a look in */
const TOP_PLAYED = 5;

interface Option {
  name: string;
  appid: number | null;
}

interface Vote {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  voice_channel_id: string;
  options: string;
  note: string | null;
  closes_at: number;
}

export function chooseOptions(ready: Candidate[]): Option[] {
  const sorted = [...ready].sort((a, b) => b.playtime - a.playtime);
  const picks = sorted.slice(0, TOP_PLAYED);
  const rest = sorted.slice(TOP_PLAYED);
  while (picks.length < MAX_OPTIONS && rest.length) picks.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
  return picks.map(({ name, appid }) => ({ name, appid }));
}

const getVote = (id: number) => db.prepare('SELECT * FROM game_votes WHERE id = ?').get(id) as Vote | undefined;
const optionsOf = (vote: Vote) => JSON.parse(vote.options) as Option[];

/** Who voted for each option, in option order */
function votersFor(vote: Vote): string[][] {
  const rows = db.prepare('SELECT user_id, choice FROM game_vote_ballots WHERE vote_id = ? ORDER BY rowid').all(vote.id) as { user_id: string; choice: number }[];
  return optionsOf(vote).map((_, idx) => rows.filter((r) => r.choice === idx).map((r) => r.user_id));
}

const tallyLines = (options: Option[], voters: string[][], order: number[]) =>
  order.map((idx) => `**${options[idx].name}** · ${voters[idx].length}${voters[idx].length ? ` · ${voters[idx].map((id) => `<@${id}>`).join(' ')}` : ''}`);

function view(vote: Vote) {
  const options = optionsOf(vote);
  const voters = votersFor(vote);
  const intro = `Everyone in <#${vote.voice_channel_id}> gets one vote. Closes <t:${Math.ceil(vote.closes_at / 1000)}:R>, or as soon as everyone’s voted.`;
  const embed = new EmbedBuilder()
    .setTitle('🗳️ What do we play?')
    .setColor(0xeb459e)
    .setDescription([intro, vote.note, '', ...tallyLines(options, voters, [...options.keys()])].filter((line) => line !== null).join('\n'));
  const buttons = options.map((option, idx) =>
    new ButtonBuilder().setCustomId(`vote:${vote.id}:${idx}`).setLabel(`${option.name.slice(0, 70)} (${voters[idx].length})`).setStyle(ButtonStyle.Secondary),
  );
  const rows = [];
  for (let idx = 0; idx < buttons.length; idx += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(idx, idx + 5)));
  return { embeds: [embed], components: rows };
}

/** Ends the vote and returns what its message should now say. Ties are settled at random */
export function finish(vote: Vote) {
  const options = optionsOf(vote);
  const voters = votersFor(vote);
  db.prepare('DELETE FROM game_votes WHERE id = ?').run(vote.id);

  const total = voters.reduce((sum, v) => sum + v.length, 0);
  const embed = new EmbedBuilder().setColor(0x57f287);
  if (!total) return { embeds: [embed.setTitle('🗳️ Nobody voted').setDescription('Try `/whatdoweplay` for a random pick.')], components: [] };

  const most = Math.max(...voters.map((v) => v.length));
  const leaders = [...options.keys()].filter((idx) => voters[idx].length === most);
  const winner = leaders[Math.floor(Math.random() * leaders.length)];
  const others = leaders.filter((idx) => idx !== winner).map((idx) => options[idx].name);
  const order = [...options.keys()].filter((idx) => voters[idx].length).sort((a, b) => voters[b].length - voters[a].length);
  embed
    .setTitle(`🏆 ${options[winner].name}`)
    .setDescription(
      [`${most} of ${total} ${total === 1 ? 'vote' : 'votes'}.${others.length ? ` Tied with ${others.join(', ')}, so I picked at random.` : ''}`, vote.note, '', ...tallyLines(options, voters, order)]
        .filter((line) => line !== null)
        .join('\n'),
    );
  if (options[winner].appid) embed.setURL(`https://store.steampowered.com/app/${options[winner].appid}`);
  return { embeds: [embed], components: [] };
}

/** Closes votes whose time is up, including any that ran out while the bot was down */
export async function tick(client: Client<true>) {
  const due = db.prepare('SELECT * FROM game_votes WHERE closes_at <= ?').all(Date.now()) as unknown as Vote[];
  for (const vote of due) {
    const result = finish(vote);
    if (!vote.message_id) continue;
    const channel = await client.channels.fetch(vote.channel_id).catch(() => null);
    if (channel?.isSendable()) await channel.messages.edit(vote.message_id, result).catch((err) => console.error(`Closing vote ${vote.id}:`, err));
  }
}

const voteIn = (voice: VoiceBasedChannel) => db.prepare('SELECT * FROM game_votes WHERE voice_channel_id = ?').get(voice.id) as Vote | undefined;

/**
 * Opens a vote on what the people in a voice channel all own, or returns why there's nothing to vote on. `only`
 * narrows it to those games, as the web UI's filters do; they still have to be owned by everyone.
 */
async function open(guild: Guild, channelId: string, voice: VoiceBasedChannel, minutes: number, only?: string[]) {
  const found = await candidatesFor(guild, humansIn(voice).map((m) => m.id));
  if (!found) return NOBODY_COUNTED;
  const wanted = only && new Set(only);
  const ready = found.candidates.filter((c) => c.missing.length === 0 && (!wanted || wanted.has(c.name)));
  if (ready.length < 2) {
    return ready.length ? `**${ready[0].name}** is the only game that fits, so there’s nothing to vote on.` : 'No game fits everyone here, so there’s nothing to vote on.';
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO game_votes (guild_id, channel_id, voice_channel_id, options, note, closes_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(guild.id, channelId, voice.id, JSON.stringify(chooseOptions(ready)), found.notes.join('\n') || null, Date.now() + minutes * 60_000);
  return getVote(Number(lastInsertRowid))!;
}

const attach = (vote: Vote, messageId: string) => db.prepare('UPDATE game_votes SET message_id = ? WHERE id = ?').run(messageId, vote.id);

/** Posts a vote from outside Discord, on only the games named if it's given some. Returns why it couldn't, or null */
export async function postVote(channel: GuildTextBasedChannel, voice: VoiceBasedChannel, minutes: number, only?: string[]): Promise<string | null> {
  if (voteIn(voice)) return `There’s already a vote going in ${voice}.`;
  const vote = await open(channel.guild, channel.id, voice, minutes, only);
  if (typeof vote === 'string') return vote;
  try {
    attach(vote, (await channel.send(view(vote))).id);
  } catch (err) {
    // A vote with no card can't be voted on, and it would block the next one
    db.prepare('DELETE FROM game_votes WHERE id = ?').run(vote.id);
    throw err;
  }
  return null;
}

async function start(i: ChatInputCommandInteraction<'cached'> | ButtonInteraction<'cached'>, minutes: number) {
  const voice = i.member.voice.channel;
  if (!voice) return i.reply({ content: 'Join a voice channel first, then I can check what everyone owns.', flags: MessageFlags.Ephemeral });
  const running = voteIn(voice);
  if (running) {
    const link = running.message_id ? ` [Jump to it](https://discord.com/channels/${running.guild_id}/${running.channel_id}/${running.message_id}).` : '';
    return i.reply({ content: `There’s already a vote going in ${voice}.${link}`, flags: MessageFlags.Ephemeral });
  }

  await i.deferReply();
  const vote = await open(i.guild, i.channelId, voice, minutes);
  if (typeof vote === 'string') return i.editReply(vote);
  attach(vote, (await i.editReply(view(vote))).id);
}

export const gameVotes: Feature = {
  title: 'Game votes',
  componentPrefix: 'vote',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('gamevote')
        .setDescription('Vote on what to play, from the games everyone in your voice channel owns')
        .addIntegerOption((o) => o.setName('minutes').setDescription('How long the vote stays open (default: 1)').setMinValue(1).setMaxValue(10)),
      async run(i) {
        if (!i.inCachedGuild()) return i.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
        return start(i, i.options.getInteger('minutes') ?? 1);
      },
    },
  ],
  async onButton(i) {
    if (!i.inCachedGuild()) return;
    const [, target, choice] = i.customId.split(':');
    if (target === 'start') return start(i, 1);

    const vote = getVote(Number(target));
    if (!vote) return i.update({ components: [] });
    if (i.member.voice.channelId !== vote.voice_channel_id) {
      return i.reply({ content: `Only people in <#${vote.voice_channel_id}> can vote on this.`, flags: MessageFlags.Ephemeral });
    }
    db.prepare('INSERT INTO game_vote_ballots (vote_id, user_id, choice) VALUES (?, ?, ?) ON CONFLICT(vote_id, user_id) DO UPDATE SET choice = excluded.choice').run(
      vote.id,
      i.user.id,
      Number(choice),
    );
    const voted = new Set(votersFor(vote).flat());
    const channel = i.guild.channels.cache.get(vote.voice_channel_id);
    const everyone = channel?.isVoiceBased() && humansIn(channel).every((m) => voted.has(m.id));
    return i.update(everyone ? finish(vote) : view(vote));
  },
  setup(client) {
    setInterval(() => void tick(client).catch(console.error), 5_000);
  },
};
