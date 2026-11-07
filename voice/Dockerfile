FROM python:3.12-slim-bookworm

RUN pip install --no-cache-dir --root-user-action=ignore 'piper-tts[http]==1.8.0'

COPY start.sh /start.sh

# Named volumes inherit this ownership on first creation, so this user can write to them
RUN useradd --create-home piper && mkdir /voices && chown piper:piper /voices
VOLUME /voices
USER piper
CMD ["sh", "/start.sh"]
