# Finds a song on YouTube Music, YouTube or SoundCloud and downloads its audio, or reads what a pasted link is.
# Reads one JSON request on stdin and writes one JSON answer on stdout:
#   {"title", "artist", "durationMs", "dir"}  a song from Spotify, matched by name and length, then downloaded
#   {"url", "dir"}                            a YouTube or SoundCloud link, downloaded
#   {"url", "info": true}                     what a link is, without downloading it
#   {"similar"}                               songs like a YouTube video, from YouTube Music's mix for it
import json
import re
import sys
from urllib.parse import quote

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


def answer(request):
    if 'similar' in request:
        return similar(request['similar'])
    if 'url' in request:
        url = request['url']
        if not LINK.match(url):
            return {'error': 'That isn’t a YouTube or SoundCloud link.', 'missing': True}
        if request.get('info'):
            with ydl({'noplaylist': True}) as y:
                info = y.extract_info(url, download=False, process=False)
            if info.get('_type') == 'playlist':
                return {'error': 'Playlists from YouTube and SoundCloud can’t be added. Add their songs one at a time.', 'missing': True}
            if (info.get('duration') or 0) > LONGEST:
                return {'error': f'That’s over {LONGEST // 60} minutes long.', 'missing': True}
            return about(info, url)
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
