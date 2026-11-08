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
- **Actions**: *Shuffle*, *Show all*, *Hide all* (applies to the whole filtered list).
- **Theme**: auto (follows the system), light or dark.

### Mistake definitions

Mistakes come from your WaniKani review history (`/v2/reviews`).

- *Missed in the last N hours/days*: at least one wrong answer (meaning or reading) during that window.
- *Leech*: at least 3 wrong answers in total, and wrong answers make up at least 25% of all answers.
  Answers are counted as reviews × 2 for kanji and vocabulary (meaning + reading), and × 1 for radicals.
  The thresholds are constants at the top of `app.js` (`LEECH_MIN_MISTAKES`, `LEECH_MIN_RATE`).

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
