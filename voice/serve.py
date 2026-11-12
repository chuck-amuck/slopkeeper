"""Runs Piper's HTTP server with ONNX Runtime's memory pool off, and English in a Korean, Russian, Spanish or German model given an accent.

The pool keeps the most a model ever needed, which grows with the longest line it's said, and each model has its own. With it on,
one long slow line takes the default model past 500 MB, and three models past 1 GB. With it off, memory goes back after each line.

A Korean, Russian, Spanish or German model reads English as noise or by its own spelling, so accent.py turns English into the nearest
sounds of that language first (see there).

Piper keeps every model it has loaded for good, about 135 MB each, so after a call that tried every voice it holds about 1.5 GB. A
model other than the default one that hasn't spoken for VOICE_IDLE_MINUTES (30 by default, 0 to keep them all) is let go, and loaded
again the next time it's asked for, which adds about a second to that line.
"""

import ctypes
import gc
import os
import runpy
import threading
import time

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


def _idle_minutes():
    # A typo shouldn't stop every voice, so it falls back to the default
    try:
        return float(os.environ.get("VOICE_IDLE_MINUTES") or 30)
    except ValueError:
        print("VOICE_IDLE_MINUTES isn't a number, so it's 30", flush=True)
        return 30.0


IDLE_S = _idle_minutes() * 60
_load = PiperVoice.load
_to_audio = PiperVoice.phoneme_ids_to_audio
# Guards the counts and the list. Never held while a model loads, so other voices carry on meanwhile
_lock = threading.Lock()
# One model loads at a time, and two first requests for the same one share it rather than loading it twice
_loading = threading.Lock()
_by_path = {}
# Every model loaded after the default one, which the effect styles all use, so it stays
_evictable = []


def _load_tracked(*args, **kwargs):
    path = str(args[0] if args else kwargs.get("model_path"))
    with _loading:
        if path in _by_path:
            return _by_path[path]
        voice = _load(*args, **kwargs)
        voice._reload = (args, kwargs)
        voice._reloading = threading.Lock()
        voice._users = 0
        voice._used = time.monotonic()
        with _lock:
            if _by_path:
                _evictable.append(voice)
        _by_path[path] = voice
    return voice


def _to_audio_tracked(self, *args, **kwargs):
    tracked = hasattr(self, "_users")
    if tracked:
        # Counted first, so it can't be let go between loading and speaking
        with _lock:
            self._users += 1
    try:
        if tracked and self.session is None:
            with self._reloading:
                if self.session is None:
                    load_args, load_kwargs = self._reload
                    self.session = _load(*load_args, **load_kwargs).session
        return _to_audio(self, *args, **kwargs)
    finally:
        if tracked:
            with _lock:
                self._users -= 1
                self._used = time.monotonic()


def _let_go_of_idle():
    try:
        trim = ctypes.CDLL("libc.so.6").malloc_trim
    except OSError:
        trim = None
    while True:
        time.sleep(min(60, max(1, IDLE_S / 4)))
        now = time.monotonic()
        freed = []
        with _lock:
            for voice in _evictable:
                if voice.session is not None and voice._users == 0 and now - voice._used > IDLE_S:
                    voice.session = None
                    freed.append(os.path.basename(str(voice._reload[0][0] if voice._reload[0] else voice._reload[1].get("model_path"))).removesuffix(".onnx"))
        if freed:
            gc.collect()
            # Freed memory otherwise stays with the process for the next allocation, rather than going back
            if trim:
                trim(0)
            print(f"Let go of idle voice models: {', '.join(freed)}", flush=True)


onnxruntime.InferenceSession = _session
PiperVoice.phonemize = _phonemize_accented
if IDLE_S > 0:
    PiperVoice.load = staticmethod(_load_tracked)
    PiperVoice.phoneme_ids_to_audio = _to_audio_tracked
    threading.Thread(target=_let_go_of_idle, daemon=True).start()
runpy.run_module("piper.http_server", run_name="__main__", alter_sys=True)
