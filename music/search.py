# Searches YouTube Music and reads its albums and artists, for the bot to pick songs from, with ytmusicapi and no account.
# Reads one JSON request on stdin and writes one JSON answer on stdout:
#   {"search", "kind", "limit"}  songs, albums or artists matching the words: kind is "song", "album" or "artist"
#   {"album"}                    an album, by its id from a search, with the songs on it that can be played
#   {"artist"}                   an artist, by its id from a search, with their top songs, and all their albums and singles
# What ytmusicapi gives is shaped here into the bot's own form, so a change in ytmusicapi only changes this file
import json
import re
import sys

# Longer than this is a mix or an album, not a song, as fetch.py has it
LONGEST = 20 * 60
MOST = 10
KINDS = {'song': 'songs', 'album': 'albums', 'artist': 'artists'}
# Album and artist ids, like MPREb_tc3z4MYeOpY or UC8N13xhRG78YQK7Ppc4Ytrg
ID = re.compile(r'^[\w-]{1,64}$')


# Google's pictures take their size in the link, and a song's come at 120 pixels, which looks soft in the player. 300 is
# what Spotify's covers are
COVER_SIZE = re.compile(r'=w\d+-h\d+(?=-|$)')


def cover(thumbnails):
    """The largest picture, which ytmusicapi lists last, at 300 pixels when it's one of Google's"""
    for picture in reversed(thumbnails or []):
        url = picture.get('url')
        if url:
            return COVER_SIZE.sub('=w300-h300', url, count=1) if '.googleusercontent.com/' in url else url
    return None


def names(artists):
    return [a['name'] for a in artists or [] if a.get('name')]


def year(value):
    return value if isinstance(value, str) and re.fullmatch(r'\d{4}', value) else None


def song(item, album=None):
    """A song, or None for one that can't be played: no video, unavailable, or too long to be a song"""
    if not item.get('videoId') or item.get('isAvailable') is False:
        return None
    seconds = item.get('duration_seconds')
    if not isinstance(seconds, (int, float)) or seconds <= 0:
        seconds = None
    elif seconds > LONGEST:
        return None
    # An album's own songs name it as text, and search results as the album itself
    on = item.get('album') or {}
    if isinstance(on, str):
        on = {'name': on}
    return {
        'id': item['videoId'],
        'title': item.get('title') or '',
        'artists': names(item.get('artists')) or (album or {}).get('artists') or [],
        'album': on.get('name') or (album or {}).get('title'),
        'albumId': on.get('id') or (album or {}).get('id'),
        'seconds': seconds,
        'explicit': item.get('isExplicit') is True,
        'cover': cover(item.get('thumbnails')) or (album or {}).get('cover'),
    }


def album_of(item):
    if not item.get('browseId'):
        return None
    return {
        'id': item['browseId'],
        'title': item.get('title') or '',
        'artists': names(item.get('artists')),
        'year': year(item.get('year')),
        # Album, EP or Single where YouTube Music says, which an artist's own list doesn't
        'type': item.get('type'),
        'cover': cover(item.get('thumbnails')),
    }


def artist_of(item):
    if not item.get('browseId'):
        return None
    return {'id': item['browseId'], 'name': item.get('artist') or item.get('title') or '', 'cover': cover(item.get('thumbnails'))}


SHAPES = {'song': song, 'album': album_of, 'artist': artist_of}


def search(yt, words, kind, limit):
    found = yt.search(words, filter=KINDS[kind], limit=limit)
    shaped = [SHAPES[kind](item) for item in found if item.get('resultType', kind) == kind]
    return {'results': [item for item in shaped if item][:limit]}


def album(yt, album_id):
    got = yt.get_album(album_id)
    about = album_of({**got, 'browseId': album_id})
    songs = [song(track, about) for track in got.get('tracks') or []]
    return {**about, 'songs': [s for s in songs if s]}


def releases(yt, section, name):
    """An artist's albums or singles: all of them when the page shows only some. The list doesn't name the artist"""
    if not section:
        return []
    items = section.get('results') or []
    if section.get('params') and section.get('browseId'):
        items = yt.get_artist_albums(section['browseId'], section['params']) or items
    shaped = [album_of(item) for item in items]
    return [{**a, 'artists': a['artists'] or ([name] if name else [])} for a in shaped if a]


def artist(yt, artist_id):
    got = yt.get_artist(artist_id)
    name = got.get('name') or ''
    # The top songs come without their lengths, which the bot finds when one is played
    top = [song(item) for item in (got.get('songs') or {}).get('results') or []]
    return {
        'id': artist_id,
        'name': name,
        'cover': cover(got.get('thumbnails')),
        'songs': [s for s in top if s],
        'albums': releases(yt, got.get('albums'), name),
        'singles': releases(yt, got.get('singles'), name),
    }


def answer(request, yt=None):
    if 'search' in request:
        words = str(request['search']).strip()[:200]
        kind = request.get('kind')
        if not words or kind not in KINDS:
            return {'error': 'Say what to search for, and whether it’s a song, album or artist.'}
        limit = request.get('limit')
        limit = limit if isinstance(limit, int) and 1 <= limit <= MOST else MOST
        return search(yt or connect(), words, kind, limit)
    for what, read in (('album', album), ('artist', artist)):
        if what in request:
            if not ID.match(str(request[what])):
                return {'error': f'That isn’t a YouTube Music {what} id.'}
            return read(yt or connect(), request[what])
    return {'error': 'Say what to search for or read.'}


def connect():
    # Only here, so the tests can shape answers without ytmusicapi installed
    from ytmusicapi import YTMusic

    return YTMusic()


def plain_error(err):
    message = str(err).strip()
    # ytmusicapi reads YouTube Music's pages, and says this both for an album or artist that isn't there and for a page
    # that's changed shape. Either way it's a failure, so the bot can try elsewhere, but without the page it couldn't read
    if message.lstrip('"').startswith('Unable to find'):
        return {'error': 'YouTube Music’s page didn’t have what was expected: the album or artist isn’t there, or its pages have changed.'}
    return {'error': message[:500] or type(err).__name__}


if __name__ == '__main__':
    try:
        result = answer(json.load(sys.stdin))
    except Exception as err:
        result = plain_error(err)
    print(json.dumps(result))
