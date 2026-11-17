"""Runs Piper's HTTP server with ONNX Runtime's memory pool off, and English in a Korean, Russian, Spanish or German model given an accent.

The pool keeps the most a model ever needed, which grows with the longest line it's said, and each model has its own. With it on,
one long slow line takes the default model past 500 MB, and three models past 1 GB. With it off, memory goes back after each line.

A Korean, Russian, Spanish or German model reads English as noise or by its own spelling, so accent.py turns English into the nearest
sounds of that language first (see there).

Piper keeps every model it has loaded for good, about 135 MB each, so a call that tried every voice would hold several GB. A model
other than the default one that hasn't spoken for VOICE_IDLE_MINUTES (30 by default, 0 to keep them all) is let go, and loaded again
the next time it's asked for, which adds about a second to that line. Past VOICE_MAX_MODELS loaded besides the default one (10 by
default, 0 for no limit), the one that spoke longest ago is let go too.

Some community models' settings list speakers the model doesn't take. Piper would pass it a speaker and fail, so such a model is
treated as having one speaker.

The voices added in the web UI are kept by models.py: the bot sends their list to POST /models, and GET /models says how each
one's download is going. /stats carries the list's version, so the bot sends it again if the container lost it.

For the bot's health numbers, each line's answer says in a Server-Timing header how long went on loading a model, turning the words
into sounds and saying them, and GET /stats says how much memory and CPU the container uses and how many models it holds.
"""

import ctypes
import gc
import logging
import os
import resource
import runpy
import sys
import threading
import time

import flask
import onnxruntime
from piper import PiperVoice

import accent
import models

_Session = onnxruntime.InferenceSession


def _session(*args, sess_options=None, **kwargs):
    options = sess_options or onnxruntime.SessionOptions()
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    return _Session(*args, sess_options=options, **kwargs)


# Each request's times so far, by step, while one is being answered on this thread
_timing = threading.local()


def _took(step, seconds):
    times = getattr(_timing, "times", None)
    if times is not None:
        times[step] = times.get(step, 0.0) + seconds


_phonemize = PiperVoice.phonemize


def _phonemize_accented(self, text):
    started = time.monotonic()
    try:
        # Piper's [[ raw phonemes ]] go through as they are, as they do for the other voices
        if not accent.accented(self.config.espeak_voice) or "[[" in text:
            return _phonemize(self, text)
        return accent.phonemize(self, text, _phonemize)
    finally:
        _took("phonemize", time.monotonic() - started)


def _number(name, default, kind=float):
    # A typo shouldn't stop every voice, so it falls back to the default
    try:
        return max(0, kind(os.environ.get(name) or default))
    except ValueError:
        print(f"{name} isn't a {'whole ' if kind is int else ''}number, so it's {default}", flush=True)
        return kind(default)


IDLE_S = _number("VOICE_IDLE_MINUTES", 30) * 60
MAX_MODELS = _number("VOICE_MAX_MODELS", 10, int)
_load = PiperVoice.load
_to_audio = PiperVoice.phoneme_ids_to_audio
# Guards the counts and the list. Never held while a model loads, so other voices carry on meanwhile
_lock = threading.Lock()
# One model loads at a time, and two first requests for the same one share it rather than loading it twice
_loading = threading.Lock()
_by_path = {}
# Every model loaded after the default one, which the effect styles all use, so it stays
_evictable = []
try:
    _trim = ctypes.CDLL("libc.so.6").malloc_trim
except OSError:
    _trim = None


def _name(voice):
    load_args, load_kwargs = voice._reload
    return os.path.basename(str(load_args[0] if load_args else load_kwargs.get("model_path"))).removesuffix(".onnx")


def _released(names, why):
    gc.collect()
    # Freed memory otherwise stays with the process for the next allocation, rather than going back
    if _trim:
        _trim(0)
    print(f"Let go of {why} voice models: {', '.join(names)}", flush=True)


def _make_room(keep):
    """Lets go of the models that spoke longest ago while more than MAX_MODELS are loaded besides the default one, never one speaking"""
    if MAX_MODELS <= 0:
        return
    freed = []
    with _lock:
        loaded = sorted((v for v in _evictable if v.session is not None and v is not keep), key=lambda v: v._used)
        over = len(loaded) + 1 - MAX_MODELS
        for voice in loaded:
            if over <= 0:
                break
            if voice._users == 0:
                voice.session = None
                freed.append(_name(voice))
                over -= 1
    if freed:
        _released(freed, "the least used")


def _fix_speakers(voice):
    if voice.config.num_speakers > 1 and "sid" not in {i.name for i in voice.session.get_inputs()}:
        voice.config.num_speakers = 1


def _load_tracked(*args, **kwargs):
    path = str(args[0] if args else kwargs.get("model_path"))
    with _loading:
        if path in _by_path:
            return _by_path[path]
        started = time.monotonic()
        voice = _load(*args, **kwargs)
        _fix_speakers(voice)
        _took("load", time.monotonic() - started)
        voice._reload = (args, kwargs)
        voice._reloading = threading.Lock()
        voice._users = 0
        voice._used = time.monotonic()
        with _lock:
            evictable = bool(_by_path)
            if evictable:
                _evictable.append(voice)
        _by_path[path] = voice
    if evictable:
        _make_room(voice)
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
                    started = time.monotonic()
                    load_args, load_kwargs = self._reload
                    self.session = _load(*load_args, **load_kwargs).session
                    _took("load", time.monotonic() - started)
                    if any(v is self for v in _evictable):
                        _make_room(self)
        started = time.monotonic()
        try:
            return _to_audio(self, *args, **kwargs)
        finally:
            _took("synth", time.monotonic() - started)
    finally:
        if tracked:
            with _lock:
                self._users -= 1
                self._used = time.monotonic()


def _let_go_of_idle():
    while True:
        time.sleep(min(60, max(1, IDLE_S / 4)))
        now = time.monotonic()
        freed = []
        with _lock:
            for voice in _evictable:
                if voice.session is not None and voice._users == 0 and now - voice._used > IDLE_S:
                    voice.session = None
                    freed.append(_name(voice))
        if freed:
            _released(freed, "idle")


def _container_usage():
    """This container's memory and CPU from its cgroup, as `docker stats` counts them, or this process's outside one"""

    def read(name):
        with open(f"/sys/fs/cgroup/{name}", encoding="utf-8") as file:
            return file.read()

    def stat(text, key):
        for line in text.splitlines():
            name, _, value = line.partition(" ")
            if name == key:
                return int(value)
        return 0

    def optional(fn):
        try:
            return fn()
        except (OSError, ValueError):
            return None

    def stalled(name):
        # Seconds some task waited for the resource, as a running total
        def total():
            for line in read(name).splitlines():
                if line.startswith("some "):
                    for part in line.split():
                        if part.startswith("total="):
                            return int(part[6:]) / 1e6
            return None

        return optional(total)

    try:
        limit = read("memory.max").strip()
        cpu_stat = read("cpu.stat")
        return {
            "memoryBytes": max(0, int(read("memory.current")) - stat(read("memory.stat"), "inactive_file")),
            "memoryLimitBytes": None if limit == "max" else int(limit),
            "cpuSeconds": stat(cpu_stat, "usage_usec") / 1e6,
            "stallSeconds": {"cpu": stalled("cpu.pressure"), "memory": stalled("memory.pressure"), "io": stalled("io.pressure")},
            "cpuPeriods": stat(cpu_stat, "nr_periods"),
            "throttledPeriods": stat(cpu_stat, "nr_throttled"),
            "oomKills": optional(lambda: stat(read("memory.events"), "oom_kill")),
        }
    except (OSError, ValueError):
        # The most it has used, which is the nearest this has
        usage = resource.getrusage(resource.RUSAGE_SELF)
        return {"memoryBytes": usage.ru_maxrss * 1024, "memoryLimitBytes": None, "cpuSeconds": usage.ru_utime + usage.ru_stime}


def _data_dir(argv):
    """Where Piper looks for models, which is where the added voices go too"""
    for i, arg in enumerate(argv):
        if arg == "--data-dir" and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith("--data-dir="):
            return arg.split("=", 1)[1]
    return "/voices"


_models = models.Models(_data_dir(sys.argv[1:]), log=lambda text: print(text, flush=True))


def _stats():
    # A snapshot, as a model may be loading meanwhile
    loaded = sum(1 for voice in list(_by_path.values()) if voice.session is not None)
    return {**_container_usage(), "modelsLoaded": loaded, "modelsVersion": _models.report()["version"]}


def _models_route():
    if flask.request.method == "POST":
        body = flask.request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            return {"error": "Send {version, voices}."}, 400
        return _models.set(body.get("voices"), body.get("version"))
    return _models.report()


class _QuietStats(logging.Filter):
    """The bot asks for /stats every 30 seconds, and the web UI for /models while a voice downloads, which would bury everything
    else in the log"""

    def filter(self, record):
        message = record.getMessage()
        return " /stats " not in message and "GET /models " not in message


_run = flask.Flask.run


def _run_measured(self, *args, **kwargs):
    """Adds the timings and GET /stats to Piper's own server, which it makes and runs in one go"""

    @self.before_request
    def _start_timing():
        _timing.times = {}
        _timing.started = time.monotonic()

    @self.after_request
    def _server_timing(response):
        times = getattr(_timing, "times", None)
        if times is not None and flask.request.path == "/synthesize":
            times["total"] = time.monotonic() - _timing.started
            response.headers["Server-Timing"] = ", ".join(f"{step};dur={seconds * 1000:.1f}" for step, seconds in times.items())
        _timing.times = None
        return response

    self.add_url_rule("/stats", "stats", _stats)
    self.add_url_rule("/models", "models", _models_route, methods=["GET", "POST"])
    logging.getLogger("werkzeug").addFilter(_QuietStats())
    return _run(self, *args, **kwargs)


onnxruntime.InferenceSession = _session
PiperVoice.phonemize = _phonemize_accented
PiperVoice.load = staticmethod(_load_tracked)
PiperVoice.phoneme_ids_to_audio = _to_audio_tracked
flask.Flask.run = _run_measured
if IDLE_S > 0:
    threading.Thread(target=_let_go_of_idle, daemon=True).start()
_models.start()
runpy.run_module("piper.http_server", run_name="__main__", alter_sys=True)
