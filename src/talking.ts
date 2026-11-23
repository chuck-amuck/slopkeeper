/**
 * Who's talking in a voice call. Music drops while anyone is, as it does under the bot's own speech. Someone starts and
 * stops as Discord says they start and stop sending audio, or, unless "What counts as talking" is any sound, as their
 * measured loudness says (talkLevel.ts)
 */

// The music stays down this long after the last person stops, as a conversation has gaps between sentences
export const HOLD_MS = 1_500;
// Discord sends nonstop from a microphone left open with no voice activity threshold. Someone counted as talking this long
// without a pause is one of those, or a microphone picking up a TV, and stops counting until they do pause
export const OPEN_MIC_MS = 30_000;

export class Talking {
  /** Who's talking now, each with the timer that gives up on them as an open microphone */
  private readonly people = new Map<string, NodeJS.Timeout>();
  private hold: NodeJS.Timeout | undefined;
  private talking = false;

  private readonly counts: (userId: string) => boolean;
  private readonly changed: (talking: boolean) => void;

  /** `counts` says whether someone's talking counts (not a bot); `changed` hears whether anyone is, each time that changes */
  constructor(counts: (userId: string) => boolean, changed: (talking: boolean) => void) {
    this.counts = counts;
    this.changed = changed;
  }

  start(userId: string) {
    if (this.people.has(userId) || !this.counts(userId)) return;
    const openMic = setTimeout(() => {
      this.people.delete(userId);
      this.update();
    }, OPEN_MIC_MS).unref();
    this.people.set(userId, openMic);
    this.update();
  }

  end(userId: string) {
    const openMic = this.people.get(userId);
    if (!openMic) return;
    clearTimeout(openMic);
    this.people.delete(userId);
    this.update();
  }

  /** Whether anyone is talking, counting the moment after the last one stops */
  get on() {
    return this.talking;
  }

  /** Forgets everyone, say when the bot leaves or stops listening */
  stop() {
    for (const openMic of this.people.values()) clearTimeout(openMic);
    this.people.clear();
    clearTimeout(this.hold);
    this.hold = undefined;
    if (this.talking) {
      this.talking = false;
      this.changed(false);
    }
  }

  private update() {
    if (this.people.size) {
      clearTimeout(this.hold);
      this.hold = undefined;
      if (!this.talking) {
        this.talking = true;
        this.changed(true);
      }
      return;
    }
    if (!this.talking || this.hold) return;
    this.hold = setTimeout(() => {
      this.hold = undefined;
      this.talking = false;
      this.changed(false);
    }, HOLD_MS).unref();
  }
}
