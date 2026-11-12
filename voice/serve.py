"""Runs Piper's HTTP server with ONNX Runtime's memory pool off, and English in a Korean, Russian, Spanish or German model given an accent.

The pool keeps the most a model ever needed, which grows with the longest line it's said, and each model has its own. With it on,
one long slow line takes the default model past 500 MB, and three models past 1 GB. With it off, memory goes back after each line.

A Korean, Russian, Spanish or German model reads English as noise or by its own spelling, so accent.py turns English into the nearest
sounds of that language first (see there).
"""

import runpy

import onnxruntime
from piper import PiperVoice

import accent

_Session = onnxruntime.InferenceSession


def _session(*args, sess_options=None, **kwargs):
    options = sess_options or onnxruntime.SessionOptions()
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    return _Session(*args, sess_options=options, **kwargs)


_phonemize = PiperVoice.phonemize


def _phonemize_accented(self, text):
    # Piper's [[ raw phonemes ]] go through as they are, as they do for the other voices
    if not accent.accented(self.config.espeak_voice) or "[[" in text:
        return _phonemize(self, text)
    return accent.phonemize(self, text, _phonemize)


onnxruntime.InferenceSession = _session
PiperVoice.phonemize = _phonemize_accented
runpy.run_module("piper.http_server", run_name="__main__", alter_sys=True)
