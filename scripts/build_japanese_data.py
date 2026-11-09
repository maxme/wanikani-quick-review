#!/usr/bin/env python3
"""Build data/japanese.json: JLPT level, school grade and frequency for WaniKani kanji and vocabulary.

The web app loads this static file to offer filters that WaniKani itself does not provide.

Sources (downloaded at build time, not stored in the repository):
- Kanji: grade, frequency rank and JLPT level from davidluzgouveia/kanji-data (MIT),
  itself built from KANJIDIC (EDRDG, CC BY-SA 4.0) and Jonathan Waller's JLPT lists (tanos.co.uk, CC BY).
  These kanji levels are the same as wkstats.com's.
- Vocabulary JLPT levels, both from Jonathan Waller's lists:
  - stephenmk/yomitan-jlpt-vocab, where each word is linked to its JMdict entry (spellings fixed);
  - jamsinclair/open-anki-jlpt-decks, which also keeps the affixes (〜円, 〜時…) dropped by the first one.
  A WaniKani word gets a level when its spelling AND one of its readings match a listed word. Only when no
  listed word matches exactly, the level of its JMdict entry is used (same word written another way, e.g. a
  kana-only listing). With several matches, the easiest level wins.
- Vocabulary frequency: JMdict (EDRDG, CC BY-SA 4.0) newspaper frequency bands (nf01-nf48, 500 words each),
  taken from the JMdict entries whose spelling and reading match the WaniKani word.
- The WaniKani vocabulary and readings: WaniKani API /subjects. The token is read from the WANIKANI_TOKEN
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
JLPT_JMDICT_URL = "https://raw.githubusercontent.com/stephenmk/yomitan-jlpt-vocab/main/original_data/n{}.csv"
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
    """WaniKani kanji characters, and {word: set of readings} for vocabulary."""
    headers = {"Wanikani-Revision": "20170710"}
    token = os.environ.get("WANIKANI_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    url, kanji, words = WK_SUBJECTS_URL, set(), {}
    while url:
        page = json.loads(fetch(url, headers))
        for subject in page["data"]:
            data = subject["data"]
            if subject["object"] == "kanji":
                kanji.add(data["characters"])
                continue
            word = strip_tilde(data["characters"])
            # Kana-only vocabulary has no readings: the characters are the reading.
            readings = {strip_tilde(r["reading"]) for r in data.get("readings") or []} or {word}
            words.setdefault(word, set()).update(readings)
        url = page["pages"]["next_url"]
    return kanji, words


def split_forms(text):
    return [strip_tilde(f) for f in re.split(r"[;；、,/]", text) if strip_tilde(f)]


def jlpt_by_spelling():
    """{(spelling, reading): easiest level} from jamsinclair's decks."""
    levels = {}
    for n in (5, 4, 3, 2, 1):  # easiest first: a word listed at several levels keeps the easiest
        for row in csv.DictReader(io.StringIO(fetch(JLPT_VOCAB_URL.format(n)).decode("utf-8"))):
            for form in split_forms(row["expression"]):
                for reading in split_forms(row["reading"]):
                    levels.setdefault((form, reading), n)
    return levels


def jlpt_by_entry(by_spelling):
    """{JMdict entry id: easiest level} from stephenmk's lists; also adds its spellings to by_spelling."""
    levels = {}
    for n in (5, 4, 3, 2, 1):
        for row in csv.DictReader(io.StringIO(fetch(JLPT_JMDICT_URL.format(n)).decode("utf-8"))):
            if row["jmdict_seq"]:
                levels.setdefault(int(row["jmdict_seq"]), n)
            for reading in split_forms(row["kana"]):
                for form in split_forms(row["kanji"]) or [reading]:
                    key = (form, reading)
                    by_spelling[key] = max(by_spelling.get(key, 0), n)
    return levels


def jmdict_entries(words):
    """{written form: [(entry id, readings, frequency band of that form or 0)]} for the wanted forms."""
    entries = {}
    with gzip.open(io.BytesIO(fetch(JMDICT_URL))) as f:
        for _, el in ET.iterparse(f):
            if el.tag != "entry":
                continue
            seq = int(el.findtext("ent_seq"))
            readings = {r.findtext("reb") for r in el.findall("r_ele")}
            for ele, tag, pri in [(k, "keb", "ke_pri") for k in el.findall("k_ele")] + \
                                 [(r, "reb", "re_pri") for r in el.findall("r_ele")]:
                form = ele.findtext(tag)
                if form in words:
                    bands = [int(p.text[2:]) for p in ele.findall(pri) if p.text.startswith("nf")]
                    entries.setdefault(form, []).append((seq, readings, min(bands) if bands else 0))
            el.clear()
    return entries


def main():
    wk_kanji, wk_words = wanikani_subjects()
    kanji_data = json.loads(fetch(KANJI_URL))
    by_spelling = jlpt_by_spelling()
    by_entry = jlpt_by_entry(by_spelling)
    entries = jmdict_entries(wk_words)

    kanji = {}
    for char, info in sorted(kanji_data.items()):
        row = [info.get("jlpt_new") or 0, info.get("grade") or 0, info.get("freq") or 0]
        if any(row):
            kanji[char] = row

    words = {}
    for word, readings in sorted(wk_words.items()):
        # JMdict entries with this spelling and one of the WaniKani readings.
        matching = [(seq, band) for seq, entry_readings, band in entries.get(word, []) if entry_readings & readings]
        levels = [by_spelling[(word, r)] for r in readings if (word, r) in by_spelling] \
            or [by_entry[seq] for seq, _ in matching if seq in by_entry]
        bands = [band for _, band in matching if band]
        row = [max(levels, default=0), min(bands, default=0)]
        if any(row):
            words[word] = row

    data = {
        "version": 2,
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
