"""Runs Piper's HTTP server with ONNX Runtime's memory pool off.

The pool keeps the most a model ever needed, which grows with the longest line it's said, and each model has its own. With it on,
one long slow line takes the default model past 500 MB, and three models past 1 GB. With it off, memory goes back after each line.
"""

import runpy

import onnxruntime

_Session = onnxruntime.InferenceSession


def _session(*args, sess_options=None, **kwargs):
    options = sess_options or onnxruntime.SessionOptions()
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    return _Session(*args, sess_options=options, **kwargs)


onnxruntime.InferenceSession = _session
runpy.run_module("piper.http_server", run_name="__main__", alter_sys=True)
