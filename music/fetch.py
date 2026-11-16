# Finds a song on YouTube Music, YouTube or SoundCloud and downloads its audio, or reads what a pasted link is.
# Reads one JSON request on stdin and writes one JSON answer on stdout:
#   {"title", "artist", "durationMs", "dir"}  a song from Spotify, matched by name and length, then downloaded
#   {"url", "dir"}                            a YouTube or SoundCloud link, downloaded
#   {"url", "info": true, "count"}            what a link is, without downloading it: a song, or up to `count` songs of a YouTube playlist
#   {"similar"}                               songs like a YouTube video, from YouTube Music's mix for it
#   {"url", "clip": true, "dir"}              a video or track to cut a soundboard sound from, downloaded with its picture
import json
import os
import re
import sys
from urllib.parse import quote, urlparse

# A match can be this many seconds longer or shorter than Spotify says
SLACK = 5
# Longer than this is a mix or an album, not a song
LONGEST = 20 * 60
# How many of YouTube Music's results have their length looked up, which takes a request each
LOOKED_UP = 2
OTHER_VERSIONS = re.compile(r'\b(live|en vivo|cover|karaoke|instrumental|remix|sped up|slowed|8d|reverb|demo|session|acoustic|acústico)\b', re.I)
LINK = re.compile(r'^https?://((www|m|music)\.)?(youtube\.com|youtu\.be|soundcloud\.com)/', re.I)
VIDEO = re.compile(r'^https://(?:(?:www|m|music)\.)?(?:youtube\.com/watch\?(?:.*&)?v=|youtu\.be/)(?P<video>[\w-]{11})')
# How much of a mix is read. Its first songs are the closest, and reading more takes no longer
MIX_LENGTH = 40
# The most songs read from a playlist: enough for shuffle to pick from, and YouTube lists 500 in about 2 seconds
PLAYLIST_READ = 500
# Where a soundboard sound can come from, including any subdomain, like m.youtube.com or vm.tiktok.com
CLIP_HOSTS = ('youtube.com', 'youtu.be', 'soundcloud.com', 'tiktok.com', 'instagram.com')
# The editor shows the video, so it's downloaded small, and only in a format that has the sound in it too, as there's no ffmpeg
# here to join a separate picture and sound. Without one, it's the sound alone, as from SoundCloud
CLIP_FORMAT = 'b[height<=?480]/b/ba'
CLIP_MAX_BYTES = 200 * 1024 * 1024
# What a video's title says besides the song, like (Official Video) or [4K Remaster]
EXTRAS = re.compile(r'\s*[(\[][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|remaster(ed)?|hd|4k|mv)\b[^)\]]*[)\]]', re.I)


def other_version(found, wanted):
    """Whether a result is a live, remixed or otherwise different version that the song asked for isn't"""
    return any(word.lower() not in wanted.lower() for word in OTHER_VERSIONS.findall(found or ''))


def close_enough(seconds, wanted_ms):
    return bool(seconds) and abs(seconds - wanted_ms / 1000) <= SLACK


def pick_listed(entries, song):
    """The first search result of the right length that isn't another version"""
    for e in entries:
        if close_enough(e.get('duration'), song['durationMs']) and not other_version(e.get('title'), song['title']):
            return e
    return None


def ydl(extra=None):
    import yt_dlp

    return yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True, 'noprogress': True, **(extra or {})})


def listed(url, count=5):
    with ydl({'extract_flat': 'in_playlist', 'playlistend': count}) as y:
        info = y.extract_info(url, download=False)
    return [e for e in (info.get('entries') or []) if e]


def find(song):
    """The best upload of a Spotify song: YouTube Music's official audio, then YouTube, then SoundCloud"""
    artist = song['artist'].split(',')[0].strip()
    words = f"{artist} {song['title']}"
    # YouTube Music lists the official recording first, but without lengths, so the first few that aren't another version are looked up
    looked = 0
    for e in listed(f'https://music.youtube.com/search?q={quote(words)}#songs'):
        if not e.get('title') or '/watch' not in (e.get('url') or '') or other_version(e['title'], song['title']):
            continue
        looked += 1
        if looked > LOOKED_UP:
            break
        with ydl() as y:
            info = y.extract_info(e['url'], download=False, process=False)
        if close_enough(info.get('duration'), song['durationMs']):
            return 'youtube', e['url']
    for source, query in [('youtube', f"ytsearch5:{artist} - {song['title']} audio"), ('soundcloud', f'scsearch5:{words}')]:
        found = pick_listed(listed(query), song)
        if found:
            return source, found.get('url') or found.get('webpage_url')
    return None, None


def download(url, folder):
    def short_enough(info, *, incomplete):
        if (info.get('duration') or 0) > LONGEST:
            return f'it’s over {LONGEST // 60} minutes long'
        return None

    with ydl({'format': 'bestaudio/best', 'outtmpl': f'{folder}/%(extractor)s-%(id)s.%(ext)s', 'match_filter': short_enough, 'noplaylist': True}) as y:
        info = y.extract_info(url, download=True)
        if not info or not info.get('requested_downloads'):
            raise ValueError(f'It’s over {LONGEST // 60} minutes long.')
        return info, info['requested_downloads'][0]['filepath']


def about(info, url):
    """What a link is, for the queue"""
    thumbnails = [t for t in info.get('thumbnails') or [] if t.get('url', '').startswith('https://')]
    return {
        'url': info.get('webpage_url') or url,
        'title': info.get('track') or info.get('title') or 'Untitled',
        'artist': info.get('artist') or info.get('uploader') or info.get('channel') or '',
        'durationMs': round((info.get('duration') or 0) * 1000),
        'cover': thumbnails[-1]['url'] if thumbnails else None,
    }


def plain_name(name):
    return re.sub(r'\W|official|vevo|topic|music', '', name.lower())


def same_name(a, b):
    """Whether two names are the same artist, as Linkin Park and LinkinParkOfficial are"""
    return bool(plain_name(a)) and plain_name(a) == plain_name(b)


def song_from(entry):
    """A song in a mix as the queue shows it: "Artist - Title (Official Video)" read as the artist and the title"""
    title = EXTRAS.sub('', entry.get('title') or '').strip()
    channel = re.sub(r'\s*(- Topic|VEVO)$', '', entry.get('channel') or entry.get('uploader') or '').strip()
    parts = re.split(r'\s+[-–—]\s+', title, maxsplit=1)
    if len(parts) == 2 and all(parts):
        artist, title = parts
        # Some put the song first, as "Title - Artist"
        if same_name(title, channel) and not same_name(artist, channel):
            artist, title = title, artist
    else:
        artist = channel
    return {
        'url': f"https://www.youtube.com/watch?v={entry['id']}",
        'title': title or entry.get('title') or 'Untitled',
        'artist': artist,
        'durationMs': round(entry['duration'] * 1000),
        'cover': f"https://i.ytimg.com/vi/{entry['id']}/hqdefault.jpg",
    }


def similar(url):
    """
    Songs like a YouTube video, from YouTube Music's mix for it, or YouTube's own when that has too few. Leaves out the video itself
    and live versions, covers and remixes
    """
    found = VIDEO.match(url)
    if not found:
        return {'error': 'Only a YouTube video has similar songs.', 'missing': True}
    video = found.group('video')
    songs, problem = [], None
    for mix in (f'https://music.youtube.com/watch?v={video}&list=RDAMVM{video}', f'https://www.youtube.com/watch?v={video}&list=RD{video}'):
        try:
            entries = listed(mix, MIX_LENGTH)
        except Exception as err:
            problem = err
            continue
        seed = next((e.get('title') or '' for e in entries if e.get('id') == video), '')
        these = [song_from(e) for e in entries if e.get('id') and e['id'] != video and e.get('duration') and not other_version(e.get('title'), seed)]
        if len(these) > len(songs):
            songs = these
        if len(songs) >= 2:
            break
    if not songs and problem:
        raise problem
    return {'songs': songs}


def youtube_playlist(url):
    """Whether a link is to a YouTube or YouTube Music playlist itself, not to a video in one or to a channel"""
    parts = urlparse(url)
    return (parts.hostname or '').lower().endswith('youtube.com') and parts.path.rstrip('/') == '/playlist' and 'list=' in parts.query


def playlist(url, count):
    """Up to `count` songs from a YouTube playlist, in its order, leaving out private, deleted, live and over-long videos"""
    count = min(max(int(count), 1), PLAYLIST_READ)
    with ydl({'extract_flat': 'in_playlist', 'playlistend': count}) as y:
        info = y.extract_info(url, download=False)
    entries = [e for e in info.get('entries') or [] if e]
    songs = [song_from(e) for e in entries if e.get('id') and e.get('duration') and e['duration'] <= LONGEST]
    return {
        'playlist': True,
        'title': info.get('title') or 'A YouTube playlist',
        'artist': info.get('uploader') or info.get('channel') or '',
        'songs': songs,
        'skipped': len(entries) - len(songs),
        'more': len(entries) >= count,
    }


def lookup(url, count):
    """What a link is: a song, or a YouTube playlist's songs"""
    if youtube_playlist(url):
        return playlist(url, count)
    # A video in a playlist, as YouTube's Share button gives it, is that video alone
    video = VIDEO.match(url)
    if video:
        url = f"https://{'music' if '//music.' in url else 'www'}.youtube.com/watch?v={video.group('video')}"
    with ydl({'noplaylist': True}) as y:
        info = y.extract_info(url, download=False, process=False)
    if info.get('_type') == 'playlist':
        if 'soundcloud.com' in url and '/sets/' in url:
            return {'error': 'SoundCloud playlists can’t be added yet. Add their songs one at a time.', 'missing': True}
        return {'error': 'That’s a channel or profile, not a playlist. Use a link to a playlist, or to one video or track.', 'missing': True}
    if (info.get('duration') or 0) > LONGEST:
        return {'error': f'That’s over {LONGEST // 60} minutes long.', 'missing': True}
    return about(info, url)


def clip_link(url):
    """Whether a link is from somewhere a soundboard sound can come from"""
    try:
        parts = urlparse(url)
    except ValueError:
        return False
    host = (parts.hostname or '').lower()
    return parts.scheme == 'https' and any(host == h or host.endswith(f'.{h}') for h in CLIP_HOSTS)


def plain_error(err):
    """yt-dlp's error for a link, without its label, colour codes and advice for the command line"""
    message = re.sub(r'\x1b\[[0-9;]*m', '', str(err)).replace('ERROR: ', '').strip()
    if re.search(r'instagram', message, re.I) and re.search(r'log(ged)?[ -]?in|cookies|empty media', message, re.I):
        return 'Instagram wouldn’t share that one without signing in. Some public Reels work, but not this one.'
    if re.search(r'IP address is blocked', message, re.I):
        return 'That site won’t share this one with the bot’s internet connection.'
    # "[TikTok] 1234: Video unavailable" is just "Video unavailable"
    return re.sub(r'^\[[^\]]+\]\s*[^:]*:\s*', '', message)[:300] or type(err).__name__


def clip(url, folder):
    """A video or track, downloaded small for the soundboard's editor. A problem with the link is an answer, not an error"""
    try:
        return download_clip(url, folder)
    except Exception as err:
        return {'error': plain_error(err), 'missing': True}


def download_clip(url, folder):
    if not clip_link(url):
        return {'error': 'Use a link to a YouTube video or Short, a TikTok, an Instagram Reel or a SoundCloud track.', 'missing': True}
    options = {
        'format': CLIP_FORMAT,
        'outtmpl': f'{folder}/%(extractor_key)s-%(id)s.%(ext)s',
        'restrictfilenames': True,
        'noplaylist': True,
        'max_filesize': CLIP_MAX_BYTES,
        # A short link only says how long it is once it's followed
        'match_filter': lambda info, *, incomplete: 'too long' if (info.get('duration') or 0) > LONGEST else None,
    }
    with ydl(options) as y:
        # Read first without downloading, so a playlist is turned down rather than every video in it downloaded
        info = y.extract_info(url, download=False, process=False)
        if info.get('_type') == 'playlist':
            return {'error': 'That’s a playlist. Use a link to one video or track.', 'missing': True}
        if (info.get('duration') or 0) > LONGEST:
            return {'error': f'That’s over {LONGEST // 60} minutes long.', 'missing': True}
        info = y.process_ie_result(info, download=True)
    downloads = (info or {}).get('requested_downloads') or []
    if not downloads:
        # The length filter is what skips one
        too_long = info is None or (info.get('duration') or 0) > LONGEST
        return {'error': f'That’s over {LONGEST // 60} minutes long.' if too_long else 'That link had nothing to download.', 'missing': True}
    got = downloads[0]
    # A video the length filter or the size limit stopped is listed, but with no file
    if not got.get('filepath') or not os.path.exists(got['filepath']):
        if (info.get('duration') or 0) > LONGEST:
            return {'error': f'That’s over {LONGEST // 60} minutes long.', 'missing': True}
        return {'error': f'That’s over {CLIP_MAX_BYTES // 1024 // 1024} MB even at 480p, so it wasn’t downloaded.', 'missing': True}
    if (got.get('acodec') or info.get('acodec')) == 'none':
        # Instagram sends some Reels without their sound to anyone who isn't signed in
        os.remove(got['filepath'])
        return {'error': 'That came without its sound, so there’s nothing to cut. Instagram does this to some Reels without a sign-in.', 'missing': True}
    return {
        **about(info, url),
        'source': info.get('extractor_key', '').lower(),
        'file': got['filepath'].rsplit('/', 1)[-1],
        'video': (got.get('vcodec') or info.get('vcodec') or 'none') != 'none',
    }


def answer(request):
    if request.get('clip'):
        return clip(request['url'], request['dir'])
    if 'similar' in request:
        return similar(request['similar'])
    if 'url' in request:
        url = request['url']
        if not LINK.match(url):
            return {'error': 'That isn’t a YouTube or SoundCloud link.', 'missing': True}
        if request.get('info'):
            return lookup(url, request.get('count') or 1)
        info, path = download(url, request['dir'])
        return {**about(info, url), 'source': info.get('extractor_key', '').lower(), 'file': path.rsplit('/', 1)[-1]}
    source, url = find(request)
    if not url:
        return {'error': 'No match on YouTube or SoundCloud.', 'missing': True}
    info, path = download(url, request['dir'])
    return {'source': source, 'url': info.get('webpage_url') or url, 'title': info.get('title'), 'durationMs': round((info.get('duration') or 0) * 1000), 'file': path.rsplit('/', 1)[-1]}


if __name__ == '__main__':
    try:
        result = answer(json.load(sys.stdin))
    except Exception as err:
        # yt-dlp's errors start with its own label and colour codes
        message = re.sub(r'\x1b\[[0-9;]*m', '', str(err)).replace('ERROR: ', '').strip()
        result = {'error': message[:500] or type(err).__name__}
    print(json.dumps(result))
