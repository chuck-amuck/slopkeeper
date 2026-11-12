"""English read by a Korean, Russian, Spanish or German model, in that accent.

A model fed English as it is makes noise, or reads it by its own language's rules, as it never learned English sounds. So
English is phonemized as English, then each sound becomes the nearest one a speaker of the model's language would use,
with the habits that make the accent:

- Korean adds a short ɯ after a consonant it wouldn't end a syllable on, as Korean speakers say English loanwords.
- Russian rolls its r's, says v for w and kh for h, and devoices a consonant at the end of a word.
- Spanish says "e" before s and a consonant, ch for sh, b for v and y for j, and softens b, d and g between vowels.
- German says z for th and v for w, and devoices a consonant at the end of a word.

Korean in Hangul and Russian in Cyrillic are phonemized in their own language, as usual, so a line can mix the two. Spanish
and German share English's alphabet, so everything typed for those is read as English.
"""

import re

from piper import voice as piper_voice
from piper.phonemize_espeak import EspeakPhonemizer


def _run_of(letters: str):
    """A stretch of the model's own language, with the spaces and punctuation inside it and the punctuation that ends it"""
    return re.compile(rf"([{letters}]+(?:[\s\d.,!?'\"-]+[{letters}]+)*[.,!?]*)")


NATIVE = {"ko": _run_of("ᄀ-ᇿ㄰-㆏가-힯"), "ru": _run_of("Ѐ-ӿ")}
MARKS = ("ˈ", "ˌ", " ", ",", ".", "!", "?", ";", ":")
STRESS = ("ˈ", "ˌ")
SENTENCE_ENDS = (".", "!", "?")


def _next_sound(ph: list[str], i: int) -> str:
    """The sound after position i, past stress marks, which espeak puts after a stressed syllable's first consonants"""
    for p in ph[i + 1 :]:
        if p not in STRESS:
            return p
    return " "


def _prev_sound(ph: list[str], i: int) -> str:
    for p in reversed(ph[:i]):
        if p not in STRESS:
            return p
    return " "


# Korean

KO_VOWELS = {
    "æ": ["ɛ"], "ɑ": ["ɐ"], "a": ["ɐ"], "ɐ": ["ʌ"], "ʌ": ["ʌ"], "ə": ["ʌ"], "ɚ": ["ʌ"], "ɜ": ["ʌ"], "ɛ": ["e"], "e": ["e"],
    "ɪ": ["i"], "i": ["i"], "ᵻ": ["i"], "ɔ": ["o"], "o": ["o"], "ɒ": ["o"], "ʊ": ["u"], "u": ["u"],
}  # fmt: skip
KO_CONSONANTS = {
    "p": ["p", "h"], "t": ["t", "h"], "k": ["k", "h"], "b": ["b"], "d": ["d"], "ɡ": ["ɡ"], "f": ["p", "h"], "v": ["b"],
    "θ": ["s"], "ð": ["d"], "s": ["s"], "z": ["d", "ʑ"], "ʃ": ["ʃ"], "ʒ": ["d", "ʑ"], "h": ["h"], "m": ["m"], "n": ["n"],
    "ŋ": ["ŋ"], "l": ["l"], "ɹ": ["ɾ"], "r": ["ɾ"], "ɾ": ["ɾ"], "w": ["w"], "j": ["j"], "ʔ": [],
}  # fmt: skip
KO_SOUNDS = {v for sounds in KO_VOWELS.values() for v in sounds}
# Korean ends syllables on these without an extra vowel
CODA_OK = {"m", "n", "ŋ", "l", "w", "j", "h"}


def _korean_sounds(sentence: list[str]) -> list[str]:
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
        elif p in KO_VOWELS:
            out += KO_VOWELS[p]
            i += 1
            continue
        elif p in KO_CONSONANTS:
            # An r after a vowel and before a consonant or the end goes, as in British English, which Korean loanwords follow
            if p == "ɹ" and out and out[-1] in KO_SOUNDS and _next_sound(ph, i) not in KO_VOWELS:
                i += 1
                continue
            out += KO_CONSONANTS[p]
            if not KO_CONSONANTS[p]:  # a glottal stop: nothing said, so no vowel after it either
                i += 1
                continue
        else:
            i += 1
            continue
        after = _next_sound(ph, i)
        if p not in CODA_OK and after not in KO_VOWELS and after not in ("j", "w"):
            out.append("i" if p in ("ʃ", "tʃ", "dʒ", "ʒ") else "ɯ")
        i += 1
    return out


# Russian, Spanish and German: each English sound's replacement. "off" is the second half of a diphthong, by itself or
# after a given vowel; "devoice" is what a consonant becomes at the end of a word; "soft" is Spanish's b, d and g between vowels

EN_VOWELS = set("ɪiɛæaɑʌəɚɜɐʊuɔoeᵻɒ")
TABLES = {
    "ru": {
        "vowels": {"ɪ": ["i"], "i": ["i"], "ᵻ": ["i"], "ɛ": ["e"], "æ": ["e"], "a": ["a"], "ɑ": ["a"], "ʌ": ["a"], "ə": ["ʌ"],
                   "ɐ": ["ʌ"], "ɚ": ["ʌ", "r"], "ɜ": ["ɵ", "r"], "ʊ": ["u"], "u": ["u"], "ɔ": ["o"], "o": ["o"], "e": ["e"], "ɒ": ["o"]},
        "off": {"ɪ": ["j"], "ʊ": ["u"], ("o", "ʊ"): []},
        "cons": {"p": ["p"], "t": ["t"], "k": ["k"], "b": ["b"], "d": ["d"], "ɡ": ["ɡ"], "f": ["f"], "v": ["v"], "θ": ["s"],
                 "ð": ["z"], "s": ["s"], "z": ["z"], "ʃ": ["ʃ"], "ʒ": ["ʒ"], "h": ["x"], "m": ["m"], "n": ["n"], "ŋ": ["n", "ɡ"],
                 "l": ["ɭ"], "ɹ": ["r"], "r": ["r"], "ɾ": ["t"], "w": ["v"], "j": ["j"], "ʔ": []},
        "tʃ": ["t", "ʃ", "ʲ"], "dʒ": ["d", "ʒ"],
        "devoice": {"b": "p", "d": "t", "ɡ": "k", "v": "f", "z": "s", "ʒ": "ʃ"},
    },
    "es": {
        "vowels": {"ɪ": ["i"], "i": ["i"], "ᵻ": ["i"], "ɛ": ["e"], "æ": ["a"], "a": ["a"], "ɑ": ["a"], "ʌ": ["a"], "ə": ["a"],
                   "ɐ": ["a"], "ɚ": ["e", "ɾ"], "ɜ": ["e", "ɾ"], "ʊ": ["u"], "u": ["u"], "ɔ": ["o"], "o": ["o"], "e": ["e"], "ɒ": ["o"]},
        "off": {"ɪ": ["i"], "ʊ": ["u"], ("o", "ʊ"): []},
        # Spain's Spanish has th, so its speakers keep it
        "cons": {"p": ["p"], "t": ["t"], "k": ["k"], "b": ["b"], "d": ["d"], "ɡ": ["ɡ"], "f": ["f"], "v": ["b"], "θ": ["θ"],
                 "ð": ["d"], "s": ["s"], "z": ["s"], "ʃ": ["t", "ʃ"], "ʒ": ["ʝ"], "h": ["x"], "m": ["m"], "n": ["n"], "ŋ": ["n"],
                 "l": ["l"], "ɹ": ["ɾ"], "r": ["ɾ"], "ɾ": ["t"], "w": ["w"], "j": ["j"], "ʔ": []},
        "tʃ": ["t", "ʃ"], "dʒ": ["ʝ"],
        "soft": {"b": "β", "d": "ð", "ɡ": "ɣ"},
    },
    "de": {
        "vowels": {"ɪ": ["ɪ"], "i": ["i", "ː"], "ᵻ": ["ɪ"], "ɛ": ["ɛ"], "æ": ["ɛ"], "a": ["a"], "ɑ": ["a", "ː"], "ʌ": ["a"],
                   "ə": ["ə"], "ɐ": ["a"], "ɚ": ["ɜ"], "ɜ": ["œ", "ɾ"], "ʊ": ["ʊ"], "u": ["u", "ː"], "ɔ": ["ɔ"], "o": ["o", "ː"],
                   "e": ["e", "ː"], "ɒ": ["ɔ"]},
        "off": {"ɪ": ["ɪ"], "ʊ": ["ʊ"], ("e", "ɪ"): [], ("o", "ʊ"): [], ("ɔ", "ɪ"): ["ʏ"]},
        "cons": {"p": ["p"], "t": ["t"], "k": ["k"], "b": ["b"], "d": ["d"], "ɡ": ["ɡ"], "f": ["f"], "v": ["v"], "θ": ["s"],
                 "ð": ["z"], "s": ["s"], "z": ["z"], "ʃ": ["ʃ"], "ʒ": ["ʃ"], "h": ["h"], "m": ["m"], "n": ["n"], "ŋ": ["ŋ"],
                 "l": ["l"], "ɹ": ["r"], "r": ["r"], "ɾ": ["t"], "w": ["v"], "j": ["j"], "ʔ": []},
        "tʃ": ["t", "ʃ"], "dʒ": ["t", "ʃ"],
        "devoice": {"b": "p", "d": "t", "ɡ": "k", "v": "f", "z": "s"},
    },
}  # fmt: skip


def _accented_sounds(sentence: list[str], lang: str) -> list[str]:
    t = TABLES[lang]
    ph = [p for p in sentence if p not in ("ː", "̩")]
    out: list[str] = []
    i = 0
    while i < len(ph):
        p = ph[i]
        nxt, prev = _next_sound(ph, i), _prev_sound(ph, i)
        if p in MARKS:
            out.append(p)
        elif (p, nxt) in (("t", "ʃ"), ("d", "ʒ")):  # ch and j
            out += t[p + nxt]
            i += 1
            while ph[i] != nxt:  # past a stress mark between them
                i += 1
        elif p in ("ɪ", "ʊ") and i > 0 and ph[i - 1] in ("a", "e", "ɔ", "o"):  # straight after the first half
            out += t["off"].get((prev, p), t["off"][p])
        elif p in EN_VOWELS:
            out += t["vowels"][p]
        elif p == "ɹ" and i > 0 and ph[i - 1] in ("ɚ", "ɜ"):
            pass  # the vowel before it already has its r
        elif p in t["cons"]:
            sounds = list(t["cons"][p])
            word_start, word_end = prev in MARKS, nxt in MARKS
            if lang == "es":
                if p == "s" and word_start and nxt not in EN_VOWELS and nxt not in MARKS:
                    out.append("e")  # "estop"
                if p == "ɹ" and word_start:
                    sounds = ["r"]  # rolled at the start of a word
                if p == "w" and word_start and nxt in EN_VOWELS:
                    sounds = ["ɡ", "w"]
                if p == "j" and word_start:
                    sounds = ["ʝ"]
                if sounds and sounds[0] in t["soft"] and prev in EN_VOWELS and nxt in EN_VOWELS:
                    sounds = [t["soft"][sounds[0]]]
            if lang == "de" and p == "ɹ" and nxt not in EN_VOWELS:
                sounds = ["ɜ"]  # an r that isn't before a vowel is said as one, as German does
            if word_end and "devoice" in t:
                sounds = [t["devoice"].get(s, s) for s in sounds]
            out += sounds
        i += 1
    return out


def _english_sentences(voice, text: str) -> list[list[str]]:
    # Piper's own espeak and lock, as espeak keeps one state for the whole process
    with piper_voice._ESPEAK_PHONEMIZER_LOCK:
        if piper_voice._ESPEAK_PHONEMIZER is None:
            piper_voice._ESPEAK_PHONEMIZER = EspeakPhonemizer(voice.espeak_data_dir)
        return piper_voice._ESPEAK_PHONEMIZER.phonemize("en-us", text)


def accented(lang: str) -> bool:
    """Whether a model of this espeak language reads English through here"""
    return lang == "ko" or lang in TABLES


def phonemize(voice, text: str, native) -> list[list[str]]:
    """Phonemes grouped by sentence, with the model's own script phonemized by `native` and everything else given the accent"""
    lang = voice.config.espeak_voice
    known = voice.config.phoneme_id_map
    convert = _korean_sounds if lang == "ko" else lambda s: _accented_sounds(s, lang)
    runs = NATIVE[lang].split(text) if lang in NATIVE else [text]
    sentences: list[list[str]] = []
    for n, run in enumerate(runs):
        if not run.strip():
            continue
        if n % 2:
            part = native(voice, run)
        else:
            part = [[p for p in convert(s) if p in known] for s in _english_sentences(voice, run)]
        part = [s for s in part if s]
        # A run that doesn't end a sentence carries on into the next one
        if sentences and part and sentences[-1][-1] not in SENTENCE_ENDS:
            sentences[-1] += [" ", *part[0]]
            part = part[1:]
        sentences += part
    return sentences
