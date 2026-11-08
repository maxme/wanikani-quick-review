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

- *Missed in the last 24 h / 48 h / 7 days*: read from `data/misses.json`, a journal that GitHub Actions updates every hour
  (`.github/workflows/track-misses.yml`, script `scripts/track_misses.py`). The script compares each item's wrong-answer
  total with the previous run. The journal only starts from the first run, so earlier misses are unknown. Precision is about one hour.
- *Leech*: at least 3 wrong answers in total, and under 75% correct overall (thresholds at the top of `app.js`).
- *Never missed*: at least one answer, and no wrong answer.

#### Setting up the miss journal

1. Create a read-only WaniKani token and add it as a repository secret named `WANIKANI_TOKEN`
   (*Settings → Secrets and variables → Actions*). Never commit the token.
2. The workflow runs on the default branch (`main`). Trigger it once from the *Actions* tab to record the baseline.

The journal is in the public repository, so it is visible to anyone who can see the repository.


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
