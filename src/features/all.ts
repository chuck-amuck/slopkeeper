import { webApi } from '../api.ts';
import { backups } from '../backup.ts';
import type { Feature } from '../types.ts';
import { achievements } from './achievements.ts';
import { freeGames } from './freegames.ts';
import { gameNights } from './gamenight.ts';
import { gamePings } from './gameroles.ts';
import { games } from './games.ts';
import { health } from './health.ts';
import { gameStats } from './gamestats.ts';
import { gameVotes } from './gamevote.ts';
import { help } from './help.ts';
import { hopOn } from './hopon.ts';
import { music } from './music.ts';
import { patchNotes } from './patchnotes.ts';
import { recap } from './recap.ts';
import { sales } from './sales.ts';
import { speak } from './say.ts';
import { sessions } from './sessions.ts';
import { setup } from './setup.ts';
import { soundboard } from './soundboard.ts';
import { steam } from './steam.ts';

/** Every feature, in /help order, with /help itself first */
export const features: Feature[] = [hopOn, gamePings, gameNights, sessions, gameStats, recap, games, gameVotes, steam, achievements, patchNotes, freeGames, sales, soundboard, speak, music, setup, backups, webApi, health];
features.unshift(help(features));

/**
 * The order features start in: health first, to measure everything from the start, then text to speech, since the
 * soundboard's looping room needs its speaker when it starts
 */
export const startOrder: Feature[] = [health, speak, ...features.filter((f) => f !== speak && f !== health)];
