# How search.py shapes what ytmusicapi gives, from answers like YouTube Music's, without asking it
import unittest

import search


def picture(*sizes):
    return [{'url': f'https://img/{size}', 'width': size, 'height': size} for size in sizes]


class FakeYTMusic:
    """Answers as ytmusicapi does, and keeps what it was asked"""

    def __init__(self):
        self.asked = []

    def search(self, words, filter, limit):
        self.asked.append(('search', words, filter, limit))
        if filter == 'songs':
            return [
                {'resultType': 'song', 'videoId': 'Bn-lcvrMOlc', 'title': 'Last Nite', 'artists': [{'name': 'The Strokes', 'id': 'UC1'}], 'album': {'name': 'Is This It', 'id': 'MPREb_1'}, 'duration_seconds': 194, 'isExplicit': False, 'thumbnails': picture(60, 120)},
                # No video, so nothing to play
                {'resultType': 'song', 'videoId': None, 'title': 'Gone'},
                # Over 20 minutes, so a mix
                {'resultType': 'song', 'videoId': 'mixmixmixmi', 'title': 'Hour of Strokes', 'artists': [], 'duration_seconds': 3600},
                {'resultType': 'video', 'videoId': 'vvvvvvvvvvv', 'title': 'Not a song'},
                {'resultType': 'song', 'videoId': 'hO4-QAjkpSA', 'title': '12:51', 'artists': [{'name': 'The Strokes'}], 'album': None, 'isExplicit': True},
            ]
        if filter == 'albums':
            return [{'resultType': 'album', 'browseId': 'MPREb_tc3z4MYeOpY', 'title': 'The Wall', 'type': 'Album', 'year': '1979', 'artists': [{'name': 'Pink Floyd'}], 'thumbnails': picture(120, 544)}]
        return [{'resultType': 'artist', 'browseId': 'UC8N13xhRG78YQK7Ppc4Ytrg', 'artist': 'The Strokes', 'thumbnails': picture(120)}, {'resultType': 'artist', 'title': 'No id'}]

    def get_album(self, album_id):
        self.asked.append(('album', album_id))
        return {
            'title': 'The Wall',
            'type': 'Album',
            'year': '1979',
            'artists': [{'name': 'Pink Floyd'}],
            'thumbnails': picture(544),
            'tracks': [
                # An album's songs name it as text, and have no pictures of their own
                {'videoId': 'uzsEmI61Xas', 'title': 'In the Flesh?', 'artists': [{'name': 'Pink Floyd'}], 'album': 'The Wall', 'duration_seconds': 199, 'isAvailable': True},
                {'videoId': 'xxxxxxxxxxx', 'title': 'Not here', 'artists': [], 'album': 'The Wall', 'duration_seconds': 100, 'isAvailable': False},
                {'videoId': 'KGC7E3XYZ1M', 'title': 'The Thin Ice', 'artists': [], 'album': 'The Wall', 'duration_seconds': 147},
            ],
        }

    def get_artist(self, artist_id):
        self.asked.append(('artist', artist_id))
        return {
            'name': 'Radiohead',
            'thumbnails': picture(900),
            'songs': {'results': [{'videoId': 'zFYEYRcjK2g', 'title': 'Creep', 'artists': [{'name': 'Radiohead'}], 'album': {'name': 'Pablo Honey', 'id': 'MPREb_2'}}]},
            # More than the page shows, so they're read in full
            'albums': {'browseId': 'UCalbums', 'params': 'more', 'results': [{'browseId': 'MPREb_a', 'title': 'Shown', 'year': '2016'}]},
            'singles': {'results': [{'browseId': 'MPREb_s', 'title': 'Daydreaming', 'year': '2016', 'type': 'Single'}]},
        }

    def get_artist_albums(self, browse_id, params):
        self.asked.append(('artist albums', browse_id, params))
        return [{'browseId': 'MPREb_k', 'title': 'KID A MNESIA', 'year': '2021', 'thumbnails': picture(226)}, {'browseId': 'MPREb_m', 'title': 'A Moon Shaped Pool', 'year': 'soon'}]


class SearchTest(unittest.TestCase):
    def setUp(self):
        self.yt = FakeYTMusic()

    def ask(self, request):
        return search.answer(request, self.yt)

    def test_songs_are_the_playable_ones_with_their_largest_picture(self):
        found = self.ask({'search': 'last nite', 'kind': 'song', 'limit': 5})['results']
        self.assertEqual(self.yt.asked, [('search', 'last nite', 'songs', 5)])
        self.assertEqual(found, [
            {'id': 'Bn-lcvrMOlc', 'title': 'Last Nite', 'artists': ['The Strokes'], 'album': 'Is This It', 'albumId': 'MPREb_1', 'seconds': 194, 'explicit': False, 'cover': 'https://img/120'},
            {'id': 'hO4-QAjkpSA', 'title': '12:51', 'artists': ['The Strokes'], 'album': None, 'albumId': None, 'seconds': None, 'explicit': True, 'cover': None},
        ])

    def test_albums_and_artists(self):
        self.assertEqual(self.ask({'search': 'the wall', 'kind': 'album'})['results'], [
            {'id': 'MPREb_tc3z4MYeOpY', 'title': 'The Wall', 'artists': ['Pink Floyd'], 'year': '1979', 'type': 'Album', 'cover': 'https://img/544'},
        ])
        self.assertEqual(self.ask({'search': 'the strokes', 'kind': 'artist'})['results'], [
            {'id': 'UC8N13xhRG78YQK7Ppc4Ytrg', 'name': 'The Strokes', 'cover': 'https://img/120'},
        ])
        # Ten at most, unless fewer are asked for
        self.assertEqual([a[3] for a in self.yt.asked], [10, 10])

    def test_an_album_has_its_songs_that_can_be_played(self):
        got = self.ask({'album': 'MPREb_tc3z4MYeOpY'})
        self.assertEqual({k: got[k] for k in ('id', 'title', 'artists', 'year', 'type', 'cover')},
                         {'id': 'MPREb_tc3z4MYeOpY', 'title': 'The Wall', 'artists': ['Pink Floyd'], 'year': '1979', 'type': 'Album', 'cover': 'https://img/544'})
        self.assertEqual([s['title'] for s in got['songs']], ['In the Flesh?', 'The Thin Ice'])
        # Each song is on the album, with its picture, and its artist where the song doesn't name one
        thin_ice = got['songs'][1]
        self.assertEqual((thin_ice['album'], thin_ice['albumId'], thin_ice['cover'], thin_ice['artists']), ('The Wall', 'MPREb_tc3z4MYeOpY', 'https://img/544', ['Pink Floyd']))

    def test_an_artist_has_all_their_albums_and_singles_named_for_them(self):
        got = self.ask({'artist': 'UCr_iyUANcn9OX_yy9piYoLw'})
        self.assertIn(('artist albums', 'UCalbums', 'more'), self.yt.asked)
        self.assertEqual(got['name'], 'Radiohead')
        self.assertEqual([(a['title'], a['year'], a['artists']) for a in got['albums']], [('KID A MNESIA', '2021', ['Radiohead']), ('A Moon Shaped Pool', None, ['Radiohead'])])
        self.assertEqual([(a['title'], a['type']) for a in got['singles']], [('Daydreaming', 'Single')])
        # Top songs come without lengths
        self.assertEqual([(s['title'], s['seconds'], s['album']) for s in got['songs']], [('Creep', None, 'Pablo Honey')])

    def test_what_isnt_a_search_is_refused_without_asking(self):
        for wrong in ({}, {'search': '  ', 'kind': 'song'}, {'search': 'x', 'kind': 'playlist'}, {'album': '../x'}, {'artist': 'a b'}):
            self.assertIn('error', self.ask(wrong), wrong)
        self.assertEqual(self.yt.asked, [])
        # A limit out of range is the most
        self.ask({'search': 'x', 'kind': 'song', 'limit': 50})
        self.assertEqual(self.yt.asked[-1][3], 10)

    def test_a_page_it_couldnt_read_is_a_failure_not_a_miss(self):
        failed = search.plain_error(Exception('"Unable to find \'contents\' using path [...] on {...}'))
        self.assertNotIn('missing', failed)
        self.assertIn('isn’t there, or its pages have changed', failed['error'])
        self.assertEqual(search.plain_error(Exception('x' * 600))['error'], 'x' * 500)


if __name__ == '__main__':
    unittest.main()
