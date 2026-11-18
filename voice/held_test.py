import unittest

import held

# "Oh no, not again." as Piper aligned it with the default model, stress marks as phonemes of their own
SENTENCE = list("^ˈoʊ nˈoʊ, nˌɑːt ɐɡˈɛn.$")


def hold(sentence, word, sound, vowel=-1, nth=0):
    kept, spans = held.occurrences(sentence, list(word))
    if nth >= len(spans):
        return None
    span = held.held_sound(kept, spans[nth], sound, vowel)
    return span and "".join(sentence[span[0] : span[1]])


class HeldTest(unittest.TestCase):
    def test_holds_the_vowel_of_a_word(self):
        kept, spans = held.occurrences(SENTENCE, list("nˈoʊ"))
        self.assertEqual(len(spans), 1)
        start, end = held.held_sound(kept, spans[0], "vowel")
        self.assertEqual("".join(SENTENCE[start:end]), "oʊ")
        self.assertEqual(start, SENTENCE.index("n") + 2, "after the stress mark, which isn't held")

    def test_only_the_word_on_its_own_and_each_time_its_said(self):
        # "no" inside "not" isn't it
        sentence = list("^nˈoʊ nˌɑːt nˈoʊ$")
        kept, spans = held.occurrences(sentence, list("nˈoʊ"))
        self.assertEqual(len(spans), 2)
        start, end = held.held_sound(kept, spans[1], "vowel")
        self.assertEqual((start, end), (14, 16))

    def test_a_long_vowel_keeps_its_length_mark(self):
        self.assertEqual(hold(list("^plˈiːz$"), "plˈiːz", "vowel"), "iː")

    def test_the_vowel_asked_for_in_a_word_with_several(self):
        sentence = list("^bˈeɪbi$")
        self.assertEqual(hold(sentence, "bˈeɪbi", "vowel", vowel=0), "eɪ")
        self.assertEqual(hold(sentence, "bˈeɪbi", "vowel"), "i")
        self.assertEqual(hold(sentence, "bˈeɪbi", "vowel", vowel=5), "i", "the last when there aren't that many")

    def test_a_word_ending_in_a_sound_that_can_be_held_holds_it(self):
        sentence = list("^jˈɛs jˈɛs$")
        self.assertEqual(hold(sentence, "jˈɛs", "end"), "s")
        kept, spans = held.occurrences(sentence, list("jˈɛs"))
        self.assertEqual(held.held_sound(kept, spans[1], "end"), (9, 10))

    def test_a_word_ending_in_a_stop_holds_its_vowel(self):
        self.assertEqual(hold(list("^ɡˈʊd$"), "ɡˈʊd", "end"), "ʊ")

    def test_what_isnt_there(self):
        self.assertIsNone(hold(SENTENCE, "jˈɛs", "vowel"))
        self.assertEqual(held.occurrences(SENTENCE, [])[1], [])
        self.assertIsNone(hold(list("^hm$"), "hm", "vowel"), "no vowel to hold")


if __name__ == "__main__":
    unittest.main()
