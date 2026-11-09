# WaniKani Quick Review

A small static web app to quickly review your WaniKani radicals, kanji and vocabulary.
Each item shows its Japanese text on the left. The **meaning** and **reading** stay hidden until you click the card (click again to hide them).

## How it works

- **Sign in**: paste your WaniKani API token (*Settings → API Tokens*). A read-only token is enough.
- **Storage**: the token is kept in your browser's `localStorage`. It is never written into the code and only sent to `api.wanikani.com`. *Change token* clears it.
- **Filters**: every filter is a group of chips, applied as soon as it changes.
  - Chips of one group add up (N5 + N4 shows both levels); groups combine (N5 + N4 *and* missed in the last 7 days).
    No chip selected in a group means no constraint. Each chip shows how many items it matches with the other filters.
  - Groups: type, SRS stage (not started, apprentice, guru, master, enlightened, burned), reviews available now, mistakes
    (missed in the last 24 h / 48 h / 7 days, leeches, never missed), JLPT N5–N1, frequency (disjoint bands, so they add up
    to a top N), school grade, word type. Plus the level range.
  - Mistakes and JLPT chips are also shown above the list, with *Clear all filters*.
  - JLPT, frequency, school grade and word type leave radicals out once a chip is selected. See below.
  - Preferences of earlier versions (one value per filter) are converted to chips.
- **Cache**: subjects and assignments of every level are kept in the browser (IndexedDB). After the first load, the list
  is shown at once from the cache, and only records changed since the last visit are requested (`updated_after`), so a
  visit usually costs three small API requests. Changing the type or level range needs no request. *Change token* clears it.
- **Pages**: 1,000 items per page, with previous/next navigation.
- **Audio (vocabulary only)**: revealing a vocabulary card plays its pronunciation automatically (toggle *Autoplay vocabulary audio when revealed*). *▶ Play* replays it, and *⇄ Other voice* switches voice actor when WaniKani provides more than one. Audio is only played on a click, never when the list is re-rendered, and clicking the audio buttons does not hide the card.
- **Actions**: *Shuffle*, *Show all*, *Hide all* (applies to the whole filtered list).
- **Theme**: auto (follows the system), light or dark.

### Mistake definitions

WaniKani no longer exposes the time of each answer: `GET /reviews` is deprecated and returns nothing.
Recent misses are deduced from `review_statistics`, synced incrementally with `updated_after`:

- A review records one final correct answer per part, so a part answered wrong during the review ends with
  `current_streak = 1` (see *Create a Review* in the API docs). `current_streak = 1` on a part that has wrong
  answers means the item's **last review had a miss**.
- `data_updated_at` of the statistic is the time of that last review.
- *Missed in the last 24 h / 48 h / 7 days*: the last review had a miss and happened in that period.
  A miss followed by a correct review in the same period is not shown.
- *Leech*: at least 10 wrong answers in total, and under 80% correct overall (thresholds at the top of `app.js`).
- *Never missed*: at least one answer, and no wrong answer.

The statistics cache is stored in the browser and cleared on *Change token*.


## Japanese level filters

WaniKani does not provide JLPT levels or frequency, so they come from `data/japanese.json`, a static file built by
`scripts/build_japanese_data.py` from open data:

| Filter | Kanji | Vocabulary |
| --- | --- | --- |
| JLPT | [kanji-data](https://github.com/davidluzgouveia/kanji-data) (MIT), from Jonathan Waller's lists (same levels as [wkstats](https://www.wkstats.com/items/jlpt)) | Jonathan Waller's lists, via [yomitan-jlpt-vocab](https://github.com/stephenmk/yomitan-jlpt-vocab) (linked to JMdict entries) and [open-anki-jlpt-decks](https://github.com/jamsinclair/open-anki-jlpt-decks) (keeps affixes such as 〜円) |
| Frequency | Newspaper rank from KANJIDIC (top 2,500 kanji) | JMdict newspaper frequency bands (`nf01`–`nf48`, 500 words each) |
| School grade | KANJIDIC grade: 1–6, secondary school, jinmeiyō | Grade of the word's hardest kanji |
| Word type | – | WaniKani parts of speech |

The JLPT has published no official lists since 2010; Jonathan Waller's lists (tanos.co.uk) are the usual reference.
A word gets a level when its WaniKani spelling **and** reading match a listed word (日 read ひ is N4, not the N5 of 日 read
にち). When nothing matches exactly, the level of the same JMdict entry is used, so a word listed only in kana (おととし)
still gives its level to the kanji spelling (一昨年). Frequency also comes from the JMdict entry with the matching reading.
About 3,800 of 6,800 WaniKani words are on the lists.
KANJIDIC and JMdict are © EDRDG, used under CC BY-SA 4.0.

To rebuild the file (the token is read from the environment and only sent to `api.wanikani.com`):

```bash
WANIKANI_TOKEN=your-token python3 scripts/build_japanese_data.py
```

## Run locally

Open `index.html` in your browser, or from the project folder:

```bash
python3 -m http.server 8000
```

then go to <http://localhost:8000>.

## GitHub Pages

The workflow `.github/workflows/pages.yml` publishes the site on every push to `main` (the `github-pages` environment only accepts deployments from the default branch).

One-time setup in GitHub:

1. *Settings → Pages*
2. Under *Build and deployment → Source*, choose **GitHub Actions**.

The app is then available at `https://maxme.github.io/wanikani-quick-review/`.

## Known limits

- Radicals without a text character are shown with their WaniKani image.
- The "available now" filter uses `available_at` from the API, so it reflects the state at load time.
- WaniKani API limit: 60 requests per minute. The app waits and retries when the limit is hit.
