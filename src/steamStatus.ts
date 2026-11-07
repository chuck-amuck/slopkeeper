export interface SteamGame {
  appid: number;
  name: string;
  /** A Steam lobby they can be joined in, for games that have them */
  lobby: string | null;
}

const playing = new Map<string, SteamGame>();
const listeners: (() => void)[] = [];

/** What Steam last said someone in voice is playing */
export const steamGame = (userId: string) => playing.get(userId);

/** There's no Discord event for this, so anything that follows presence has to ask */
export const onSteamChange = (listener: () => void) => void listeners.push(listener);

const snapshot = (games: Map<string, SteamGame>) => JSON.stringify([...games].sort(([a], [b]) => a.localeCompare(b)));

/** Replaces what's known, about everyone or just the people in `among` */
export function setSteamGames(games: Map<string, SteamGame>, among?: string[]) {
  const before = snapshot(playing);
  for (const id of among ?? [...playing.keys()]) playing.delete(id);
  for (const [id, game] of games) playing.set(id, game);
  if (snapshot(playing) !== before) for (const listener of listeners) listener();
}
