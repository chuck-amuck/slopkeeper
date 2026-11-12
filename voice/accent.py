"""English read by a Korean model, in a Korean accent.

A Korean model fed English as it is makes noise, as it never learned English sounds. So English is phonemized as English,
then each sound becomes the nearest one Korean has, and a short ɯ follows a consonant Korean wouldn't end a syllable on,
as Korean speakers say English loanwords. Hangul is phonemized as Korean, as usual, so a line can mix the two.
"""

import re

from piper import voice as piper_voice
from piper.phonemize_espeak import EspeakPhonemizer

# A stretch of Korean, with the spaces and punctuation inside it and the punctuation that ends it
HANGUL = re.compile(r"([ᄀ-ᇿ㄰-㆏가-힯]+(?:[\s\d.,!?'\"-]+[ᄀ-ᇿ㄰-㆏가-힯]+)*[.,!?]*)")
MARKS = ("ˈ", "ˌ", " ", ",", ".", "!", "?", ";", ":")
SENTENCE_ENDS = (".", "!", "?")

VOWELS = {
    "æ": ["ɛ"], "ɑ": ["ɐ"], "a": ["ɐ"], "ɐ": ["ʌ"], "ʌ": ["ʌ"], "ə": ["ʌ"], "ɚ": ["ʌ"], "ɜ": ["ʌ"], "ɛ": ["e"], "e": ["e"],
    "ɪ": ["i"], "i": ["i"], "ᵻ": ["i"], "ɔ": ["o"], "o": ["o"], "ɒ": ["o"], "ʊ": ["u"], "u": ["u"],
}  # fmt: skip
CONSONANTS = {
    "p": ["p", "h"], "t": ["t", "h"], "k": ["k", "h"], "b": ["b"], "d": ["d"], "ɡ": ["ɡ"], "f": ["p", "h"], "v": ["b"],
    "θ": ["s"], "ð": ["d"], "s": ["s"], "z": ["d", "ʑ"], "ʃ": ["ʃ"], "ʒ": ["d", "ʑ"], "h": ["h"], "m": ["m"], "n": ["n"],
    "ŋ": ["ŋ"], "l": ["l"], "ɹ": ["ɾ"], "r": ["ɾ"], "ɾ": ["ɾ"], "w": ["w"], "j": ["j"], "ʔ": [],
}  # fmt: skip
KOREAN_VOWELS = {v for sounds in VOWELS.values() for v in sounds}
# Korean ends syllables on these without an extra vowel
CODA_OK = {"m", "n", "ŋ", "l", "w", "j", "h"}

def _next_sound(ph: list[str], i: int) -> str:
    """The sound after position i, past stress marks, which espeak puts after a stressed syllable's first consonants"""
    for p in ph[i + 1 :]:
        if p not in ("ˈ", "ˌ"):
            return p
    return " "


def _korean_sounds(sentence: list[str], known) -> list[str]:
    out: list[str] = []
    ph = [p for p in sentence if p != "ː"]
    i = 0
    while i < len(ph):
        p = ph[i]
        nxt = ph[i + 1] if i + 1 < len(ph) else " "
        if p in MARKS:
            out.append(p)
            i += 1
            continue
        if p == "t" and nxt == "ʃ":  # ch
            out += ["t", "ɕ", "h"]
            i += 1
            p = "tʃ"
        elif p == "d" and nxt == "ʒ":  # j
            out += ["d", "ʑ"]
            i += 1
            p = "dʒ"
        elif p in VOWELS:
            out += VOWELS[p]
            i += 1
            continue
        elif p in CONSONANTS:
            # An r after a vowel and before a consonant or the end goes, as in British English, which Korean loanwords follow
            if p == "ɹ" and out and out[-1] in KOREAN_VOWELS and _next_sound(ph, i) not in VOWELS:
                i += 1
                continue
            out += CONSONANTS[p]
            if not CONSONANTS[p]:  # a glottal stop: nothing said, so no vowel after it either
                i += 1
                continue
        else:
            i += 1
            continue
        after = _next_sound(ph, i)
        if p not in CODA_OK and after not in VOWELS and after not in ("j", "w"):
            out.append("i" if p in ("ʃ", "tʃ", "dʒ", "ʒ") else "ɯ")
        i += 1
    return [p for p in out if p in known]


def _english_sentences(voice, text: str) -> list[list[str]]:
    # Piper's own espeak and lock, as espeak keeps one state for the whole process
    with piper_voice._ESPEAK_PHONEMIZER_LOCK:
        if piper_voice._ESPEAK_PHONEMIZER is None:
            piper_voice._ESPEAK_PHONEMIZER = EspeakPhonemizer(voice.espeak_data_dir)
        return piper_voice._ESPEAK_PHONEMIZER.phonemize("en-us", text)


def phonemize(voice, text: str, korean) -> list[list[str]]:
    """Phonemes grouped by sentence, with Hangul phonemized by `korean` and everything else given the accent"""
    known = voice.config.phoneme_id_map
    sentences: list[list[str]] = []
    for n, run in enumerate(HANGUL.split(text)):
        if not run.strip():
            continue
        part = korean(voice, run) if n % 2 else [_korean_sounds(s, known) for s in _english_sentences(voice, run)]
        part = [s for s in part if s]
        # A run that doesn't end a sentence carries on into the next one
        if sentences and part and sentences[-1][-1] not in SENTENCE_ENDS:
            sentences[-1] += [" ", *part[0]]
            part = part[1:]
        sentences += part
    return sentences
