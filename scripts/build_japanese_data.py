#!/usr/bin/env python3
"""Build data/japanese.json: JLPT level, school grade and frequency for WaniKani kanji and vocabulary.

The web app loads this static file to offer filters that WaniKani itself does not provide.

Sources (downloaded at build time, not stored in the repository):
- Kanji: grade, frequency rank and JLPT level from davidluzgouveia/kanji-data (MIT),
  itself built from KANJIDIC (EDRDG, CC BY-SA 4.0) and Jonathan Waller's JLPT lists (tanos.co.uk).
- Vocabulary JLPT levels: jamsinclair/open-anki-jlpt-decks, based on Jonathan Waller's lists.
- Vocabulary frequency: JMdict (EDRDG, CC BY-SA 4.0) newspaper frequency bands (nf01-nf48, 500 words each).
- The list of vocabulary to keep: WaniKani API /subjects. The token is read from the WANIKANI_TOKEN
  environment variable and is never printed or written anywhere.

Usage: WANIKANI_TOKEN=... python3 scripts/build_japanese_data.py
"""
import csv
import gzip
import io
import json
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

KANJI_URL = "https://raw.githubusercontent.com/davidluzgouveia/kanji-data/master/kanji.json"
JLPT_VOCAB_URL = "https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src/n{}.csv"
JMDICT_URL = "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz"
WK_SUBJECTS_URL = "https://api.wanikani.com/v2/subjects?types=kanji,vocabulary,kana_vocabulary&hidden=false"
OUTPUT = Path(__file__).resolve().parent.parent / "data" / "japanese.json"


def fetch(url, headers=None):
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "wanikani-quick-review-build", **(headers or {})})
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except OSError as err:
            if attempt == 2:
                raise
            print(f"retrying {url.split('?')[0]}: {err}", file=sys.stderr)
            time.sleep(2 ** attempt)


def strip_tilde(text):
    return text.strip().strip("〜～")


def wanikani_subjects():
    headers = {"Wanikani-Revision": "20170710"}
    token = os.environ.get("WANIKANI_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    url, kanji, words = WK_SUBJECTS_URL, set(), set()
    while url:
        page = json.loads(fetch(url, headers))
        for subject in page["data"]:
            chars = subject["data"]["characters"]
            (kanji if subject["object"] == "kanji" else words).add(strip_tilde(chars))
        url = page["pages"]["next_url"]
    return kanji, words


def jlpt_vocabulary():
    levels = {}
    for n in (5, 4, 3, 2, 1):  # easiest first: a word listed at several levels keeps the easiest
        text = fetch(JLPT_VOCAB_URL.format(n)).decode("utf-8")
        for row in csv.DictReader(io.StringIO(text)):
            for form in re.split(r"[;；、,/]", row["expression"]):
                form = strip_tilde(form)
                if form:
                    levels.setdefault(form, n)
    return levels


def jmdict_frequency(words):
    """Best newspaper frequency band (1 = 500 most frequent words) for each wanted written form."""
    bands = {}
    with gzip.open(io.BytesIO(fetch(JMDICT_URL))) as f:
        for _, el in ET.iterparse(f):
            if el.tag in ("k_ele", "r_ele"):
                form = el.findtext("keb") or el.findtext("reb")
                if form in words:
                    ranks = [int(p.text[2:]) for p in el.findall("ke_pri") + el.findall("re_pri") if p.text.startswith("nf")]
                    if ranks:
                        bands[form] = min(bands.get(form, 99), min(ranks))
            elif el.tag == "entry":
                el.clear()
    return bands


def main():
    wk_kanji, wk_words = wanikani_subjects()
    kanji_data = json.loads(fetch(KANJI_URL))
    jlpt = jlpt_vocabulary()
    bands = jmdict_frequency(wk_words)

    kanji = {}
    for char, info in sorted(kanji_data.items()):
        row = [info.get("jlpt_new") or 0, info.get("grade") or 0, info.get("freq") or 0]
        if any(row):
            kanji[char] = row

    words = {}
    for word in sorted(wk_words):
        row = [jlpt.get(word, 0), bands.get(word, 0)]
        if any(row):
            words[word] = row

    data = {
        "version": 1,
        "about": "kanji: [JLPT level, school grade (8 secondary, 9-10 jinmeiyo), newspaper frequency rank]; "
                 "words: [JLPT level, JMdict newspaper frequency band of 500 words]. 0 = unknown.",
        "kanji": kanji,
        "words": words,
    }
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{OUTPUT}: {len(kanji)} kanji, {len(words)}/{len(wk_words)} words "
          f"({sum(1 for w in words.values() if w[0])} with JLPT, {sum(1 for w in words.values() if w[1])} with frequency); "
          f"{sum(1 for k in wk_kanji if k in kanji)}/{len(wk_kanji)} WaniKani kanji")


if __name__ == "__main__":
    main()
