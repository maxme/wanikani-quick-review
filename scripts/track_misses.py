#!/usr/bin/env python3
"""Detect new wrong answers by polling WaniKani's review_statistics.

Run hourly by GitHub Actions (.github/workflows/track-misses.yml).

- WANIKANI_TOKEN is read from the environment. It is never printed, stored or written to a file.
- data/state.json: last sync time and the wrong-answer total per subject (the baseline).
- data/misses.json: journal of detected misses, [{"subject_id": 1, "detected_at": "..."}],
  entries older than KEEP_DAYS are dropped.

A miss is an increase of a subject's wrong-answer total between two runs. The first run only
records the baseline, so it detects nothing.
"""

import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = "https://api.wanikani.com/v2/review_statistics"
REVISION = "20170710"
KEEP_DAYS = 30
MAX_RETRIES = 3

ROOT = Path(__file__).resolve().parent.parent
STATE_FILE = ROOT / "data" / "state.json"
JOURNAL_FILE = ROOT / "data" / "misses.json"


def fetch_json(url, token, attempt=0):
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "Wanikani-Revision": REVISION},
    )
    try:
        # Read the whole body inside the try: a connection cut mid-transfer shows up here.
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read()
        return json.loads(body)
    except urllib.error.HTTPError as error:
        # Only the status code is shown: no headers, no token.
        if error.code == 429 and attempt < MAX_RETRIES:
            wait = min(int(error.headers.get("RateLimit-Reset") or 60), 65)
            print(f"Rate limited, waiting {wait}s")
            time.sleep(wait)
            return fetch_json(url, token, attempt + 1)
        if error.code in (401, 403):
            sys.exit("WaniKani rejected the token (401/403). Check the WANIKANI_TOKEN secret.")
        sys.exit(f"WaniKani API error: HTTP {error.code}")
    except (http.client.HTTPException, urllib.error.URLError, TimeoutError, ConnectionError) as error:
        # Network failure or truncated response: retry the same request after a pause.
        if attempt < MAX_RETRIES:
            wait = 5 * (attempt + 1)
            print(f"Network error ({type(error).__name__}), retrying in {wait}s")
            time.sleep(wait)
            return fetch_json(url, token, attempt + 1)
        sys.exit(f"Network error after {MAX_RETRIES} retries: {type(error).__name__}")


def fetch_changed(updated_after, token):
    """All review statistics, or only those changed since updated_after."""
    url = API
    if updated_after:
        url += "?" + urllib.parse.urlencode({"updated_after": updated_after})
    items = []
    while url:
        body = fetch_json(url, token)
        items.extend(body["data"])
        url = (body.get("pages") or {}).get("next_url")
    return items


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def main():
    token = os.environ.get("WANIKANI_TOKEN", "").strip()
    if not token:
        sys.exit("WANIKANI_TOKEN is not set")

    now = datetime.now(timezone.utc)
    state = load_json(STATE_FILE, {"syncedAt": None, "wrong": {}})
    journal = load_json(JOURNAL_FILE, [])
    has_baseline = state["syncedAt"] is not None

    changed = fetch_changed(state["syncedAt"], token)
    new_misses = 0
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    for raw in changed:
        data = raw["data"]
        subject_id = data["subject_id"]
        wrong = data["meaning_incorrect"] + data["reading_incorrect"]
        previous = state["wrong"].get(str(subject_id), 0)
        if has_baseline and wrong > previous:
            journal.append({"subject_id": subject_id, "detected_at": stamp})
            new_misses += wrong - previous
        state["wrong"][str(subject_id)] = wrong

    # Overlap of 5 minutes so that no change made during the run is lost. Re-read records do not double count.
    state["syncedAt"] = (now - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

    cutoff = (now - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    journal = [entry for entry in journal if entry["detected_at"] >= cutoff]

    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    JOURNAL_FILE.write_text(json.dumps(journal, separators=(",", ":")), encoding="utf-8")

    if not has_baseline:
        print(f"Baseline recorded for {len(state['wrong'])} subjects. No misses are detected on the first run.")
    else:
        print(f"Checked {len(changed)} changed subjects, {new_misses} new wrong answer(s) recorded.")


if __name__ == "__main__":
    main()
