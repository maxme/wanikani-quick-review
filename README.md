# WaniKani Quick Review

A small static web app to quickly review your WaniKani radicals, kanji and vocabulary.
Each item shows its Japanese text on the left. The **meaning** and **reading** stay hidden until you click the card (click again to hide them).

## How it works

- **Sign in**: paste your WaniKani API token (*Settings → API Tokens*). A read-only token is enough.
- **Storage**: the token is kept in your browser's `localStorage`. It is never written into the code and only sent to `api.wanikani.com`. *Change token* clears it.
- **Filters**
  - Types: radicals, kanji, vocabulary. Radicals show meaning only (no reading).
  - Level range.
  - Progress: all, not started, started, reviews available now, burned.
  - Mistakes: any, missed in the last 24 h / 48 h / 7 days, leeches, never missed.
- **Pages**: 100 items per page, with previous/next navigation.
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


## Run locally

Open `index.html` in your browser, or from the project folder:

```bash
python3 -m http.server 8000
```

then go to <http://localhost:8000>.

## GitHub Pages

The workflow `.github/workflows/pages.yml` publishes the site on every push to `claude/sharp-ritchie-oti2be` (and `main`).

One-time setup in GitHub:

1. *Settings → Pages*
2. Under *Build and deployment → Source*, choose **GitHub Actions**.

The app is then available at `https://maxme.github.io/wanikani-quick-review/`.

## Known limits

- Radicals without a text character are shown with their WaniKani image.
- The "available now" filter uses `available_at` from the API, so it reflects the state at load time.
- WaniKani API limit: 60 requests per minute. The app waits and retries when the limit is hit.
