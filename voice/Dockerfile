FROM python:3.12-slim-bookworm

# Every package pinned and checked against its hash, as serve.py patches onnxruntime's and Piper's insides
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --root-user-action=ignore --require-hashes --no-deps -r /tmp/requirements.txt && rm /tmp/requirements.txt

COPY start.sh serve.py accent.py held.py models.py /

# Named volumes inherit this ownership on first creation, so this user can write to them
RUN useradd --create-home piper && mkdir /voices && chown piper:piper /voices
VOLUME /voices
USER piper
CMD ["sh", "/start.sh"]
