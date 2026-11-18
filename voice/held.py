"""Finds the sound to hold in a drawn-out word, like the o of "nooooo", among a sentence's phonemes as Piper aligned them.

Piper can't hold a sound itself: it reads "nooo" as "noo-oh". So the bot sends the plain word ("no"), which time it's said in the
line, and which sound to hold, and serve.py says where in the audio that sound is, for the bot to stretch with rubberband.
Piper's alignments give each phoneme's length in samples, with stress marks as phonemes of their own.
"""

STRESS = {"ˈ", "ˌ"}
LENGTH = "ː"
VOWELS = set("aeiouyæɑɒɐəɚɛɜɝɞɘɵɤɯɨʉɪʊʌɔøœɶᵻ")
# A stop can't be held, so a word ending in one holds its vowel
STOPS = set("pbtdkɡgʔ")
# What can stand between words in a sentence's phonemes
BETWEEN = set(" ^$.,!?;:…—-")


def occurrences(sentence, word):
    """Each place `word` (its phonemes said alone) is said in `sentence` (a list of phonemes, one per alignment) as a word of
    its own. Returns the sentence without stress marks, as (index in the sentence, phoneme), and the places as (start, end)
    indexes into it"""
    kept = [(i, p) for i, p in enumerate(sentence) if p not in STRESS]
    target = [p for p in word if p not in STRESS and p != " "]
    if not target:
        return kept, []
    plain = [p for _, p in kept]
    spans = []
    for start in range(len(plain) - len(target) + 1):
        end = start + len(target)
        if plain[start:end] == target and (start == 0 or plain[start - 1] in BETWEEN) and (end == len(plain) or plain[end] in BETWEEN):
            spans.append((start, end))
    return kept, spans


def _vowel_runs(plain, start, end):
    """The vowel sounds in plain[start:end], each a diphthong and its length mark included, as (start, end) indexes"""
    runs = []
    i = start
    while i < end:
        if plain[i] in VOWELS:
            first = i
            while i < end and (plain[i] in VOWELS or plain[i] == LENGTH):
                i += 1
            runs.append((first, i))
        else:
            i += 1
    return runs


def held_sound(kept, span, sound, vowel=-1):
    """The sound to hold in the word at `span`: its `vowel`th vowel sound (-1 for the last) for "vowel", or its last sound for
    "end", unless that's a stop or a vowel, when it's the last vowel sound. Returns (start, end) indexes into the sentence, or
    None when the word has no such sound"""
    plain = [p for _, p in kept]
    start, end = span
    last = plain[end - 1]
    if sound == "end" and last not in STOPS and last not in VOWELS and last != LENGTH:
        found = (end - 1, end)
    else:
        runs = _vowel_runs(plain, start, end)
        if not runs:
            return None
        found = runs[vowel] if -len(runs) <= vowel < len(runs) else runs[-1]
    return kept[found[0]][0], kept[found[1] - 1][0] + 1
