# How fetch.py finds a Spotify song on YouTube Music and downloads it, with ytmusicapi and yt-dlp stood in for
import unittest

import fetch

SONG = {'artist': 'Daft Punk, Pharrell Williams', 'title': 'Get Lucky', 'durationMs': 248000}


class FakeYTMusic:
    def __init__(self, found=None, error=None):
        self.found = found
        self.error = error
        self.asked = []

    def search(self, words, filter, limit):
        self.asked.append((words, filter))
        if self.error:
            raise self.error
        return self.found


class Find(unittest.TestCase):
    def setUp(self):
        self.listed = []
        self.saved = fetch.connect, fetch.listed, fetch.find_listed
        fetch.listed = lambda query, count=5: self.listed.append(query) or []
        fetch.find_listed = lambda song, words: self.listed.append('music page') or None

    def tearDown(self):
        fetch.connect, fetch.listed, fetch.find_listed = self.saved

    def answer(self, found=None, error=None):
        yt = FakeYTMusic(found, error)
        fetch.connect = lambda: yt
        return yt

    def test_the_first_song_of_the_right_length_from_its_api(self):
        yt = self.answer([
            {'videoId': None, 'title': 'Get Lucky'},
            {'videoId': 'aaaaaaaaaaa', 'title': 'Get Lucky (Live)', 'duration_seconds': 248},
            {'videoId': 'bbbbbbbbbbb', 'title': 'Get Lucky', 'duration_seconds': 369},
            {'videoId': 'ccccccccccc', 'title': 'Get Lucky (Radio Edit)', 'duration_seconds': 250},
        ])
        self.assertEqual(fetch.find(SONG), ('youtube', 'https://music.youtube.com/watch?v=ccccccccccc'))
        # By the first artist, and nothing else asked
        self.assertEqual(yt.asked, [('Daft Punk Get Lucky', 'songs')])
        self.assertEqual(self.listed, [])

    def test_only_the_first_few_are_weighed(self):
        self.answer([
            {'videoId': 'aaaaaaaaaaa', 'title': 'Get Lucky', 'duration_seconds': 369},
            {'videoId': 'bbbbbbbbbbb', 'title': 'Get Lucky', 'duration_seconds': 120},
            {'videoId': 'ccccccccccc', 'title': 'Get Lucky', 'duration_seconds': 248},
        ])
        self.assertEqual(fetch.find(SONG), (None, None))
        # Its page isn't read again for the same songs: YouTube and SoundCloud are searched instead
        self.assertEqual(self.listed, ['ytsearch5:Daft Punk - Get Lucky audio', 'scsearch5:Daft Punk Get Lucky'])

    def test_its_page_when_the_api_fails_or_answers_nothing(self):
        for found, error in [(None, RuntimeError('YouTube Music changed')), ([], None)]:
            self.listed = []
            self.answer(found, error)
            fetch.find_listed = lambda song, words: self.listed.append(words) or 'https://music.youtube.com/watch?v=ddddddddddd'
            self.assertEqual(fetch.find(SONG), ('youtube', 'https://music.youtube.com/watch?v=ddddddddddd'))
            self.assertEqual(self.listed, ['Daft Punk Get Lucky'])


class FakeYDL:
    """Stands in for yt-dlp, failing with what `fails` says for the options it's given"""

    made = []
    fails = None

    def __init__(self, options):
        self.options = options
        FakeYDL.made.append(options)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def extract_info(self, url, download):
        problem = FakeYDL.fails and FakeYDL.fails(self.options)
        if problem == 'too long':
            return {'id': 'x'}
        if problem:
            raise RuntimeError(problem)
        return {'id': 'x', 'requested_downloads': [{'filepath': '/data/audio/youtube-x.webm'}]}


class Download(unittest.TestCase):
    def setUp(self):
        self.saved = fetch.ydl
        fetch.ydl = FakeYDL
        FakeYDL.made = []
        FakeYDL.fails = None

    def tearDown(self):
        fetch.ydl = self.saved

    def clients(self):
        return [o.get('extractor_args', {}).get('youtube', {}).get('player_client') for o in FakeYDL.made]

    def test_youtube_with_the_quick_client(self):
        info, path = fetch.download('https://music.youtube.com/watch?v=ccccccccccc', '/data/audio')
        self.assertEqual(path, '/data/audio/youtube-x.webm')
        self.assertEqual(self.clients(), [['visionos']])

    def test_the_usual_clients_when_the_quick_one_fails(self):
        FakeYDL.fails = lambda o: 'extractor_args' in o and 'Requested format is not available'
        info, path = fetch.download('https://www.youtube.com/watch?v=ccccccccccc', '/data/audio')
        self.assertEqual(path, '/data/audio/youtube-x.webm')
        self.assertEqual(self.clients(), [['visionos'], None])
        # Started over, not carried on from the quick client's part
        self.assertIs(FakeYDL.made[1]['continuedl'], False)

    def test_too_long_is_not_asked_again(self):
        FakeYDL.fails = lambda o: 'too long'
        with self.assertRaises(fetch.TooLong):
            fetch.download('https://www.youtube.com/watch?v=ccccccccccc', '/data/audio')
        self.assertEqual(len(FakeYDL.made), 1)

    def test_soundcloud_as_before(self):
        fetch.download('https://soundcloud.com/someone/some-song', '/data/audio')
        self.assertEqual(self.clients(), [None])

    def test_both_failing_says_why(self):
        FakeYDL.fails = lambda o: 'Sign in to confirm your age'
        with self.assertRaisesRegex(RuntimeError, 'confirm your age'):
            fetch.download('https://www.youtube.com/watch?v=ccccccccccc', '/data/audio')
        self.assertEqual(len(FakeYDL.made), 2)

    def test_a_video_thats_gone_is_not_asked_again(self):
        FakeYDL.fails = lambda o: 'ERROR: [youtube] ccccccccccc: Video unavailable. This video has been removed by the uploader'
        with self.assertRaisesRegex(RuntimeError, 'Video unavailable'):
            fetch.download('https://www.youtube.com/watch?v=ccccccccccc', '/data/audio')
        self.assertEqual(len(FakeYDL.made), 1)


if __name__ == '__main__':
    unittest.main()
