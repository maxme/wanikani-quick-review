(() => {
  'use strict';

  const API_BASE = 'https://api.wanikani.com/v2';
  const REVISION = '20170710';
  const LEVEL_MAX = 60;
  const PAGE_SIZE = 100;
  const HOUR = 60 * 60 * 1000;

  // Leech: at least LEECH_MIN_MISTAKES wrong answers and an overall correct rate below LEECH_MAX_PERCENT.
  // Calibrated on a real account, where most items sit between 83% and 96% correct.
  const LEECH_MIN_MISTAKES = 10;
  const LEECH_MAX_PERCENT = 80;

  // Storage keys are unchanged so existing tokens and preferences keep working.
  const STORAGE_TOKEN = 'wk-quick-review.token';
  const STORAGE_PREFS = 'wk-quick-review.prefs';
  const STORAGE_THEME = 'wk-quick-review.theme';
  // v2: the cache entries now hold the last-review miss flag; older caches are dropped and fully re-synced.
  const STORAGE_STATS = 'wk-quick-review.stats.v2';
  const OLD_STORAGE_STATS = 'wk-quick-review.stats';

  const TYPE_LABEL = { radical: 'Radical', kanji: 'Kanji', vocabulary: 'Vocabulary' };
  // Shorter labels for the card tags, so they fit on one line on phones.
  const TYPE_TAG = { radical: 'Radical', kanji: 'Kanji', vocabulary: 'Vocab' };
  const TYPE_ORDER = { radical: 0, kanji: 1, vocabulary: 2 };
  // The plain "reading" group of vocabulary gets no row label: the card already says "Reading".
  const READING_LABEL = { onyomi: 'On’yomi', kunyomi: 'Kun’yomi', nanori: 'Nanori', reading: '' };
  const READING_ORDER = ['onyomi', 'kunyomi', 'nanori', 'reading'];
  const SRS_LABEL = { 1: 'Apprentice', 2: 'Apprentice', 3: 'Apprentice', 4: 'Apprentice', 5: 'Guru', 6: 'Guru', 7: 'Master', 8: 'Enlightened', 9: 'Burned' };

  const PROGRESS_VALUES = ['all', 'not-started', 'started', 'review', 'burned'];
  const MISTAKE_VALUES = ['any', 'missed-24h', 'missed-48h', 'missed-7d', 'leech', 'never'];
  // Values used by earlier versions, mapped to the current ones when preferences are restored.
  const OLD_MISTAKE_VALUES = { 'since-last-visit': 'any' };
  // Filters from data/japanese.json (JLPT, frequency, school grade) and from WaniKani parts of speech.
  // 'upto4' = N5 and N4, 'upto3' = N5 to N3, 'upto2' = N5 to N2.
  const JLPT_VALUES = ['any', '5', '4', '3', '2', '1', 'upto4', 'upto3', 'upto2', 'none'];
  const JLPT_QUICK = ['any', '5', '4', '3', '2', '1', 'upto4', 'upto3', 'upto2'];
  const JLPT_QUICK_LABEL = {
    any: 'All', 5: 'N5', 4: 'N4', 3: 'N3', 2: 'N2', 1: 'N1', upto4: 'N5 + N4', upto3: 'N5 – N3', upto2: 'N5 – N2',
  };
  const FREQUENCY_VALUES = ['any', '500', '1000', '2500', '5000', '10000', 'rare'];
  const GRADE_VALUES = ['any', '1', '2', '3', '4', '5', '6', '8', '9', 'none'];
  // Grade scale: 1-6 elementary school, 8 secondary school, 9-10 jinmeiyo (names), NOT_JOYO otherwise.
  const NOT_JOYO = 11;
  // JMdict frequency bands hold 500 words each.
  const FREQUENCY_BAND = 500;
  const RARE_FROM = 10000;
  const POS_GROUPS = {
    noun: ['noun', 'proper noun', 'pronoun', 'independent noun', 'verbal noun'],
    verb: ['godan verb', 'ichidan verb', 'する verb', 'transitive verb', 'intransitive verb'],
    godan: ['godan verb'],
    ichidan: ['ichidan verb'],
    suru: ['する verb'],
    transitive: ['transitive verb'],
    intransitive: ['intransitive verb'],
    'i-adj': ['い adjective'],
    'na-adj': ['な adjective'],
    'no-adj': ['の adjective'],
    adverb: ['adverb'],
    expression: ['expression'],
    counter: ['counter', 'numeral'],
    affix: ['prefix', 'suffix'],
  };
  const POS_VALUES = ['any', ...Object.keys(POS_GROUPS)];
  const JAPANESE_DATA_URL = 'data/japanese.json';
  const HAN = /\p{Script=Han}/u;
  const THEME_LABEL = { auto: 'auto', light: 'light', dark: 'dark' };
  const THEME_NEXT = { auto: 'light', light: 'dark', dark: 'auto' };

  const $ = (sel) => document.querySelector(sel);
  const els = {
    login: $('#login'),
    loginForm: $('#login-form'),
    token: $('#token'),
    logout: $('#logout'),
    filters: $('#filters'),
    filtersForm: $('#filters-form'),
    levelMin: $('#level-min'),
    levelMax: $('#level-max'),
    progress: $('#progress'),
    mistakes: $('#mistakes'),
    jlpt: $('#jlpt'),
    quickJlpt: $('#quick-jlpt'),
    frequency: $('#frequency'),
    grade: $('#grade'),
    pos: $('#pos'),
    autoplay: $('#autoplay'),
    results: $('#results'),
    count: $('#count'),
    list: $('#list'),
    pager: $('#pager'),
    prevPage: $('#prev-page'),
    nextPage: $('#next-page'),
    pageLabel: $('#page-label'),
    shuffle: $('#shuffle'),
    showAll: $('#show-all'),
    hideAll: $('#hide-all'),
    message: $('#message'),
    theme: $('#theme'),
    filtersPanel: $('#filters-panel'),
    filtersSummary: $('#filters-summary'),
    quickFilters: $('#quick-filters'),
    revealedCount: $('#revealed-count'),
  };

  // raw: subjects and assignments as returned by the API (null until loaded)
  // stats: Map subject id -> review history built from the local statistics cache
  // voice: chosen pronunciation voice per vocabulary id
  const state = { raw: null, stats: new Map(), items: [], view: [], page: 0, revealed: new Set(), voice: new Map() };

  // ---------- Local storage (token, preferences, theme, statistics cache) ----------
  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  }
  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }
  const getToken = () => storageGet(STORAGE_TOKEN);

  function loadPrefs() {
    try {
      return JSON.parse(storageGet(STORAGE_PREFS) || '{}');
    } catch { return {}; }
  }

  function savePrefs() {
    storageSet(STORAGE_PREFS, JSON.stringify({
      types: selectedTypes(),
      levelMin: Number(els.levelMin.value),
      levelMax: Number(els.levelMax.value),
      progress: els.progress.value,
      mistakes: els.mistakes.value,
      jlpt: els.jlpt.value,
      frequency: els.frequency.value,
      grade: els.grade.value,
      pos: els.pos.value,
      autoplay: els.autoplay.checked,
    }));
  }

  // ---------- Theme: automatic (system), light or dark ----------
  function currentTheme() {
    const saved = storageGet(STORAGE_THEME);
    return saved === 'light' || saved === 'dark' ? saved : 'auto';
  }

  function applyTheme(theme) {
    if (theme === 'auto') {
      delete document.documentElement.dataset.theme;
      storageRemove(STORAGE_THEME);
    } else {
      document.documentElement.dataset.theme = theme;
      storageSet(STORAGE_THEME, theme);
    }
    els.theme.textContent = `Theme: ${THEME_LABEL[theme]}`;
  }

  // ---------- DOM helpers ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else node.setAttribute(k, String(v));
    }
    for (const child of children) {
      if (child == null) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function setMessage(text, isError = false) {
    els.message.textContent = text;
    els.message.classList.toggle('error', isError);
  }

  function setBusy(busy) {
    els.filtersForm.querySelector('button[type="submit"]').disabled = busy;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------- Audio ----------
  // One shared player: starting a new clip stops the previous one.
  let player = null;

  function playAudio(url) {
    try {
      if (!player) player = new Audio();
      player.pause();
      player.src = url;
      const playing = player.play();
      if (playing) playing.catch(() => setMessage('The audio could not be played.', true));
    } catch {
      setMessage('The audio could not be played.', true);
    }
  }

  // ---------- Filters ----------
  function selectedTypes() {
    return [...els.filtersForm.querySelectorAll('input[name="types"]:checked')].map((i) => i.value);
  }

  function populateLevels() {
    for (const select of [els.levelMin, els.levelMax]) {
      for (let n = 1; n <= LEVEL_MAX; n++) select.append(el('option', { value: n }, n));
    }
    els.levelMax.value = String(LEVEL_MAX);
  }

  function restorePrefs() {
    const prefs = loadPrefs();
    if (Array.isArray(prefs.types)) {
      for (const input of els.filtersForm.querySelectorAll('input[name="types"]')) {
        input.checked = prefs.types.includes(input.value);
      }
    }
    if (Number.isInteger(prefs.levelMin)) els.levelMin.value = String(Math.min(Math.max(prefs.levelMin, 1), LEVEL_MAX));
    if (Number.isInteger(prefs.levelMax)) els.levelMax.value = String(Math.min(Math.max(prefs.levelMax, 1), LEVEL_MAX));

    // Older versions stored the progress filter under "status" with other values.
    const progress = prefs.progress ?? (prefs.status === 'review' || prefs.status === 'started' ? prefs.status : 'all');
    if (PROGRESS_VALUES.includes(progress)) els.progress.value = progress;
    const mistakes = OLD_MISTAKE_VALUES[prefs.mistakes] ?? prefs.mistakes;
    if (MISTAKE_VALUES.includes(mistakes)) els.mistakes.value = mistakes;
    const restoreSelect = (select, values, value) => {
      if (values.includes(value)) select.value = value;
    };
    restoreSelect(els.jlpt, JLPT_VALUES, prefs.jlpt);
    restoreSelect(els.frequency, FREQUENCY_VALUES, prefs.frequency);
    restoreSelect(els.grade, GRADE_VALUES, prefs.grade);
    restoreSelect(els.pos, POS_VALUES, prefs.pos);
    if (typeof prefs.autoplay === 'boolean') els.autoplay.checked = prefs.autoplay;
  }

  // ---------- WaniKani API calls ----------
  async function fetchPage(url, token, attempt = 0) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Wanikani-Revision': REVISION,
      },
    });
    // Rate limited: wait for the reset announced by WaniKani, then retry a few times.
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(Number(res.headers.get('RateLimit-Reset')) || 60, 65);
      setMessage(`WaniKani rate limit reached, retrying in ${wait}s…`);
      await sleep(wait * 1000);
      return fetchPage(url, token, attempt + 1);
    }
    return res;
  }

  // Follows pagination (next_url) and returns every "data" entry of the collection.
  async function fetchAll(url, token) {
    const items = [];
    let next = url;
    while (next) {
      const res = await fetchPage(next, token);
      if (res.status === 401 || res.status === 403) {
        throw new Error('WaniKani rejected the token (401/403). Check that it is valid and has read permission.');
      }
      if (res.status === 429) {
        throw new Error('WaniKani rate limit reached. Try again in a minute.');
      }
      if (!res.ok) {
        throw new Error(`WaniKani error (HTTP ${res.status}).`);
      }
      const json = await res.json();
      items.push(...json.data);
      next = json.pages?.next_url ?? null;
    }
    return items;
  }

  // ---------- Data normalization ----------
  function pickImage(images = []) {
    const svg = images.find((i) => i.content_type === 'image/svg+xml');
    const png = images.find((i) => i.content_type === 'image/png');
    return (svg || png || {}).url ?? null;
  }

  function normalizeMeanings(list = []) {
    return [...list]
      .sort((a, b) => Number(!!b.primary) - Number(!!a.primary))
      .map((m) => ({ text: m.meaning, primary: !!m.primary }));
  }

  function normalizeReadings(list = []) {
    const groups = new Map();
    for (const r of list) {
      const key = r.type ?? 'reading';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ text: r.reading, primary: !!r.primary });
    }
    const rank = (k) => (READING_ORDER.includes(k) ? READING_ORDER.indexOf(k) : 99);
    return [...groups.keys()].sort((a, b) => rank(a) - rank(b)).map((k) => ({
      label: READING_LABEL[k] ?? k,
      items: [...groups.get(k)].sort((a, b) => Number(b.primary) - Number(a.primary)),
    }));
  }

  // One audio clip per voice actor; MP3 is preferred when both formats are offered.
  function normalizeAudios(list = []) {
    const byVoice = new Map();
    for (const a of list) {
      if (!a.url || !String(a.content_type || '').startsWith('audio/')) continue;
      const voice = a.metadata?.voice_actor_name || 'Voice';
      const key = a.metadata?.voice_actor_id ?? voice;
      const current = byVoice.get(key);
      if (!current || (a.content_type === 'audio/mpeg' && current.type !== 'audio/mpeg')) {
        byVoice.set(key, { url: a.url, type: a.content_type, voice });
      }
    }
    return [...byVoice.values()];
  }

  // ---------- Local cache of subjects and assignments (IndexedDB) ----------
  // Subjects and assignments of every level are downloaded once, then only the records changed since the
  // last sync are requested (updated_after). The list is shown from the cache at once and refreshed after.
  // IndexedDB is used because the subjects are too large for localStorage. If it is unavailable
  // (private browsing), everything still works, without the cache.
  const DB_NAME = 'wk-quick-review';
  const DB_STORE = 'cache';
  // Bump when the compact format changes: older caches are then downloaded again.
  const CACHE_VERSION = 1;
  let dbPromise = null;

  function openDb() {
    dbPromise ??= new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
    return dbPromise;
  }

  // Runs one request on the store; resolves with its result, or null on any error.
  async function dbRequest(mode, run) {
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, mode);
        const req = run(tx.objectStore(DB_STORE));
        tx.oncomplete = () => resolve(req.result ?? null);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  const dbGet = (key) => dbRequest('readonly', (store) => store.get(key));
  const dbSet = (key, value) => dbRequest('readwrite', (store) => store.put(value, key));
  const dbClear = () => dbRequest('readwrite', (store) => store.clear());

  async function readCollection(key) {
    const stored = await dbGet(key);
    return stored?.version === CACHE_VERSION ? stored : null;
  }

  // Brings a cached collection up to date and returns { records, changed }.
  async function syncCollection(key, url, token, compact, idOf, cached) {
    const cache = cached ?? (await readCollection(key)) ?? { version: CACHE_VERSION, syncedAt: null, records: {} };
    // Overlap of a few minutes, so no change made during the sync is lost.
    const nextSync = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const query = cache.syncedAt ? `${url.includes('?') ? '&' : '?'}${new URLSearchParams({ updated_after: cache.syncedAt })}` : '';
    const changed = await fetchAll(url + query, token);
    for (const raw of changed) cache.records[idOf(raw)] = compact(raw);
    // Written only when something changed: the next sync then simply starts from the older date.
    if (changed.length || !cache.syncedAt) {
      cache.syncedAt = nextSync;
      await dbSet(key, cache);
    }
    return { records: cache.records, changed: changed.length, cache };
  }

  // ---------- Japanese data (JLPT, frequency, school grade) ----------
  // Static file built by scripts/build_japanese_data.py; the browser caches it. Loaded once per page.
  let japaneseData = null;
  function loadJapaneseData() {
    japaneseData ??= fetch(JAPANESE_DATA_URL)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    return japaneseData;
  }

  const stripTilde = (text) => text.replace(/^[〜～]+|[〜～]+$/g, '');

  // Grade on a single scale where higher is harder; jinmeiyo (9, 10) is grouped as 9.
  function kanjiGrade(jp, char) {
    const grade = jp.kanji[char]?.[1] ?? 0;
    if (grade === 0) return NOT_JOYO;
    return grade >= 9 ? 9 : grade;
  }

  // JLPT level, frequency rank and grade of a subject. null = unknown or not applicable.
  function japaneseInfo(jp, type, characters) {
    const none = { jlpt: null, frequency: null, grade: null };
    if (!jp || !characters || type === 'radical') return none;
    if (type === 'kanji') {
      const [jlpt = 0, , frequency = 0] = jp.kanji[characters] ?? [];
      return { jlpt: jlpt || null, frequency: frequency || null, grade: kanjiGrade(jp, characters) };
    }
    const [jlpt = 0, band = 0] = jp.words[stripTilde(characters)] ?? [];
    // A word's grade is the grade of its hardest kanji; kana-only words have none.
    const kanji = [...characters].filter((c) => HAN.test(c));
    const grade = kanji.length ? Math.max(...kanji.map((c) => kanjiGrade(jp, c))) : null;
    return { jlpt: jlpt || null, frequency: band ? band * FREQUENCY_BAND : null, grade };
  }

  // ---------- Review history ----------
  // GET /reviews is deprecated and returns nothing, so review_statistics is the source of history.
  // Recent misses are deduced from it:
  // - A review records one final correct answer per part, so a part answered wrong during the review
  //   ends with current_streak = 1 (see "Create a Review" in the API docs). current_streak = 1 on a part
  //   that has wrong answers therefore means the last review of the subject had a miss on that part.
  // - data_updated_at is the time of that last review (it matches assignment.available_at minus the
  //   SRS interval). So "missed in the last N hours" = last review had a miss and happened within N hours.
  // Limit: a miss followed by a correct review inside the window is no longer visible.
  // The local copy is synced incrementally with updated_after.
  // Cache entry per subject: [wrong, answered, percentCorrect, lastReviewAt(ms), lastReviewMissed(0|1)]
  const NO_HISTORY = { wrong: 0, answered: 0, percentCorrect: null, lastReviewAt: 0, lastReviewMissed: false };

  function loadStatsCache() {
    try {
      const cache = JSON.parse(storageGet(STORAGE_STATS) || 'null');
      if (cache && typeof cache.syncedAt === 'string' && cache.s) return cache;
    } catch { /* corrupt cache: start again */ }
    return { syncedAt: null, s: {} };
  }

  function saveStatsCache(cache) {
    storageSet(STORAGE_STATS, JSON.stringify(cache));
  }

  function compactStat(raw) {
    const d = raw.data;
    const lastReviewMissed = (d.meaning_current_streak === 1 && d.meaning_incorrect > 0)
      || (d.reading_current_streak === 1 && d.reading_incorrect > 0);
    return [
      d.meaning_incorrect + d.reading_incorrect,
      d.meaning_correct + d.meaning_incorrect + d.reading_correct + d.reading_incorrect,
      d.percentage_correct ?? null,
      Date.parse(raw.data_updated_at) || 0,
      lastReviewMissed ? 1 : 0,
    ];
  }

  // Syncs review_statistics (only changed records after the first sync) and returns the updated cache.
  async function syncStats(token) {
    const cache = loadStatsCache();
    // Overlap of a few minutes, so no review made during the sync is lost.
    const nextSync = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const query = cache.syncedAt ? `?${new URLSearchParams({ updated_after: cache.syncedAt })}` : '';
    const changed = await fetchAll(`${API_BASE}/review_statistics${query}`, token);
    for (const raw of changed) {
      cache.s[raw.data.subject_id] = compactStat(raw);
    }
    cache.syncedAt = nextSync;
    saveStatsCache(cache);
    // Not saved: only tells the caller whether anything changed.
    cache.changed = changed.length;
    return cache;
  }

  function buildStatsMap(cache) {
    const map = new Map();
    for (const [id, [wrong, answered, percentCorrect, lastReviewAt, lastReviewMissed]] of Object.entries(cache.s)) {
      map.set(Number(id), { wrong, answered, percentCorrect, lastReviewAt, lastReviewMissed: lastReviewMissed === 1 });
    }
    return map;
  }

  function isLeech(h) {
    return h.wrong >= LEECH_MIN_MISTAKES && h.percentCorrect !== null && h.percentCorrect < LEECH_MAX_PERCENT;
  }

  // Compact copy of a subject, as kept in the local cache: only what the cards and filters use.
  function compactSubject(raw) {
    const d = raw.data;
    // Kana-only vocabulary is a separate subject type in the API; it is shown as vocabulary.
    const kana = raw.object === 'kana_vocabulary';
    const type = kana ? 'vocabulary' : raw.object;
    return {
      id: raw.id,
      type,
      level: d.level,
      position: d.lesson_position ?? 0,
      hidden: !!d.hidden_at,
      glyph: d.characters ?? null,
      image: d.characters ? null : pickImage(d.character_images),
      meanings: normalizeMeanings(d.meanings),
      // Kana vocabulary has no readings: its characters are the reading.
      readings: type === 'radical' ? []
        : kana ? [{ label: '', items: [{ text: d.characters, primary: true }] }]
          : normalizeReadings(d.readings),
      audios: type === 'vocabulary' ? normalizeAudios(d.pronunciation_audios) : [],
      partsOfSpeech: d.parts_of_speech ?? [],
    };
  }

  // Assignment cache entry: [srs_stage, available_at]
  const compactAssignment = (raw) => [raw.data.srs_stage, raw.data.available_at];

  function toItem(subject, assignment, history, jp) {
    const { hidden, ...fields } = subject;
    const h = history ?? NO_HISTORY;
    return {
      ...fields,
      ...japaneseInfo(jp, subject.type, subject.glyph),
      srsStage: assignment?.[0] ?? 0,
      availableAt: assignment?.[1] ?? null,
      history: h,
      leech: isLeech(h),
    };
  }

  function compareItems(a, b) {
    return a.level - b.level
      || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
      || a.position - b.position;
  }

  // Everything is cached; the type and level filters are applied here.
  function buildItems() {
    const { subjects, assignments, japanese } = state.raw;
    const types = new Set(selectedTypes());
    const min = Number(els.levelMin.value);
    const max = Number(els.levelMax.value);
    return Object.values(subjects)
      .filter((s) => !s.hidden && types.has(s.type) && s.level >= min && s.level <= max)
      .map((s) => toItem(s, assignments[s.id], state.stats.get(s.id) ?? null, japanese))
      .sort(compareItems);
  }

  // ---------- Filter predicates ----------
  function matchesProgress(item, value, now) {
    switch (value) {
      case 'not-started':
        return item.srsStage === 0;
      case 'started':
        return item.srsStage >= 1;
      case 'review':
        return item.srsStage >= 1 && item.srsStage < 9
          && item.availableAt != null && Date.parse(item.availableAt) <= now;
      case 'burned':
        return item.srsStage === 9;
      default:
        return true;
    }
  }

  function matchesMistakes(item, value, now) {
    const h = item.history;
    // The last review had a miss and happened within the window.
    const missedWithin = (hours) => h.lastReviewMissed && h.lastReviewAt >= now - hours * HOUR;
    switch (value) {
      case 'missed-24h': return missedWithin(24);
      case 'missed-48h': return missedWithin(48);
      case 'missed-7d': return missedWithin(24 * 7);
      case 'leech': return item.leech;
      case 'never': return h.answered > 0 && h.wrong === 0;
      default: return true;
    }
  }

  function matchesJlpt(item, value) {
    if (value === 'any') return true;
    if (value === 'none') return item.jlpt === null;
    // N5 is the easiest level: "up to N3" keeps N5, N4 and N3.
    if (value.startsWith('upto')) return item.jlpt !== null && item.jlpt >= Number(value.slice(4));
    return item.jlpt === Number(value);
  }

  // JLPT, frequency, grade and word type. Any value other than "any" leaves radicals out.
  function matchesJapanese(item, f) {
    if (item.type === 'radical' && (f.jlpt !== 'any' || f.frequency !== 'any' || f.grade !== 'any' || f.pos !== 'any')) {
      return false;
    }
    if (!matchesJlpt(item, f.jlpt)) return false;
    if (f.frequency === 'rare') {
      if (item.frequency !== null && item.frequency <= RARE_FROM) return false;
    } else if (f.frequency !== 'any' && !(item.frequency !== null && item.frequency <= Number(f.frequency))) {
      return false;
    }
    if (f.grade !== 'any' && item.grade !== (f.grade === 'none' ? NOT_JOYO : Number(f.grade))) return false;
    if (f.pos !== 'any' && !item.partsOfSpeech.some((p) => POS_GROUPS[f.pos].includes(p))) return false;
    return true;
  }

  function japaneseFilters() {
    return { jlpt: els.jlpt.value, frequency: els.frequency.value, grade: els.grade.value, pos: els.pos.value };
  }

  // ---------- Card rendering ----------
  function buildGlyph(item) {
    if (item.image) {
      return el('img', { src: item.image, alt: TYPE_LABEL[item.type], loading: 'lazy' });
    }
    const text = item.glyph ?? '';
    return el('span', { class: 'glyph', lang: 'ja' }, text);
  }

  function joinSpans(entries, separator) {
    const parts = [];
    entries.forEach((entry, i) => {
      if (i > 0) parts.push(separator);
      parts.push(el('span', { class: entry.primary ? 'primary' : 'secondary' }, entry.text));
    });
    return parts;
  }

  // Small round audio buttons shown at the end of the reading line.
  function buildAudioButtons(item, voiceIndex, handlers) {
    const audio = item.audios[voiceIndex];
    const play = el('button', {
      type: 'button',
      class: 'audio-btn play-btn',
      title: `Play (${audio.voice})`,
      'aria-label': `Play pronunciation (${audio.voice})`,
    }, '▶');
    play.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onPlay();
    });
    const buttons = [play];
    if (item.audios.length > 1) {
      const other = el('button', {
        type: 'button',
        class: 'audio-btn',
        title: 'Hear another voice',
        'aria-label': 'Hear another voice',
      }, '⇄');
      other.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.onSwitch();
      });
      buttons.push(other);
    }
    return el('span', { class: 'audio' }, ...buttons);
  }

  // Compact answer: one line for the meanings, one line for all readings (with the audio buttons).
  function buildAnswer(item, voiceIndex, handlers) {
    const meaningText = item.meanings.map((m) => m.text).join(', ');
    const nodes = [el('div', { class: 'meanings', title: meaningText }, ...joinSpans(item.meanings, ', '))];

    if (item.readings.length) {
      const groups = [];
      item.readings.forEach((group, i) => {
        if (i > 0) groups.push(el('span', { class: 'sep' }, '·'));
        groups.push(
          group.label ? el('span', { class: 'label' }, group.label) : null,
          el('span', { class: 'jp', lang: 'ja' }, ...joinSpans(group.items, '、')),
        );
      });
      nodes.push(el('div', { class: 'reading-line' },
        el('div', { class: 'readings' }, ...groups),
        item.audios.length ? buildAudioButtons(item, voiceIndex, handlers) : null));
    }
    return nodes;
  }

  function buildCard(item) {
    // The answer is always laid out, so the card keeps the same height whether it is revealed or not.
    // While hidden, CSS makes the content invisible (and its buttons unfocusable) and shows the placeholder over it.
    const content = el('div', { class: 'answer-content' });
    const answer = el('div', { class: 'answer' },
      content,
      el('div', { class: 'placeholder', 'aria-hidden': 'true' }, 'Tap to reveal'));
    const srs = item.srsStage >= 1 ? SRS_LABEL[item.srsStage] : null;
    const wrong = item.history.wrong;
    const card = el('div', {
      class: `card type-${item.type}`,
      role: 'button',
      tabindex: '0',
      'aria-expanded': 'false',
    },
      el('div', { class: 'glyph-tile' }, buildGlyph(item)),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-head' },
          el('div', { class: 'tags' },
            el('span', { class: 'tag tag-type' }, TYPE_TAG[item.type]),
            el('span', { class: 'tag' }, `Lvl ${item.level}`),
            item.jlpt ? el('span', { class: 'tag jlpt', title: `JLPT N${item.jlpt}` }, `N${item.jlpt}`) : null,
            srs ? el('span', { class: 'tag' }, srs) : null,
            item.leech ? el('span', { class: 'tag leech' }, 'Leech') : null,
            wrong > 0 ? el('span', { class: 'tag', title: `${wrong} miss${wrong > 1 ? 'es' : ''} in total` }, `✗ ${wrong}`) : null),
          el('span', { class: 'chevron', 'aria-hidden': 'true' }, '›')),
        answer));

    const renderAnswer = () => {
      const voiceIndex = state.voice.get(item.id) ?? 0;
      content.replaceChildren(...buildAnswer(item, voiceIndex, {
        onPlay: () => playAudio(item.audios[state.voice.get(item.id) ?? 0].url),
        onSwitch: () => {
          const next = ((state.voice.get(item.id) ?? 0) + 1) % item.audios.length;
          state.voice.set(item.id, next);
          renderAnswer();
          playAudio(item.audios[next].url);
        },
      }));
    };

    // play: true only for a user click on the card, so re-rendering never starts audio on its own.
    const setRevealed = (on, { play = false } = {}) => {
      if (on) state.revealed.add(item.id);
      else state.revealed.delete(item.id);
      card.classList.toggle('revealed', on);
      card.setAttribute('aria-expanded', String(on));
      if (on && play && els.autoplay.checked && item.audios.length) {
        playAudio(item.audios[state.voice.get(item.id) ?? 0].url);
      }
    };

    card.addEventListener('click', () => {
      setRevealed(!state.revealed.has(item.id), { play: true });
      updateRevealedCount();
    });
    card.addEventListener('keydown', (e) => {
      // Ignore keys pressed on the audio buttons inside the card.
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setRevealed(!state.revealed.has(item.id), { play: true });
        updateRevealedCount();
      }
    });

    renderAnswer();
    setRevealed(state.revealed.has(item.id));
    return el('li', {}, card);
  }

  // Renders only the current page (PAGE_SIZE items) of the filtered view.
  function renderList() {
    const total = state.view.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    state.page = Math.min(Math.max(state.page, 0), pages - 1);
    const start = state.page * PAGE_SIZE;
    const slice = state.view.slice(start, start + PAGE_SIZE);

    els.list.replaceChildren(...slice.map(buildCard));
    updateRevealedCount();
    els.count.textContent = total
      ? `Showing ${start + 1}–${start + slice.length} of ${total} items`
      : 'No items match these filters';
    els.pager.hidden = pages <= 1;
    els.pageLabel.textContent = `Page ${state.page + 1} of ${pages}`;
    els.prevPage.disabled = state.page === 0;
    els.nextPage.disabled = state.page >= pages - 1;
    els.results.hidden = false;
  }

  const QUICK_LABEL = {
    any: 'All', 'missed-24h': 'Missed 24 h', 'missed-48h': 'Missed 48 h', 'missed-7d': 'Missed 7 days',
    leech: 'Leeches', never: 'Never missed',
  };

  // One-line summary of the filters, shown when the filter panel is collapsed.
  function updateFiltersSummary() {
    const types = selectedTypes().map((t) => TYPE_LABEL[t]).join(', ') || 'No type';
    const levels = els.levelMin.value === els.levelMax.value
      ? `Level ${els.levelMin.value}`
      : `Levels ${els.levelMin.value}–${els.levelMax.value}`;
    const progress = els.progress.selectedOptions[0]?.textContent ?? '';
    // Japanese level filters are listed only when set.
    const extra = [els.jlpt, els.frequency, els.grade, els.pos]
      .filter((select) => select.value !== 'any')
      .map((select) => (select === els.jlpt && select.value !== 'none' ? `JLPT ${JLPT_QUICK_LABEL[select.value]}` : select.selectedOptions[0].textContent));
    els.filtersSummary.textContent = [types, levels, progress, ...extra].join(' · ');
  }

  function updateRevealedCount() {
    const revealed = state.view.reduce((n, item) => n + (state.revealed.has(item.id) ? 1 : 0), 0);
    els.revealedCount.textContent = state.view.length ? `${revealed} / ${state.view.length} revealed` : '';
  }

  // A row of quick buttons that set a select, each with the number of items it would show.
  function renderChips(container, select, values, labels, countFor) {
    const current = select.value;
    container.replaceChildren(...values.map((value) => {
      const button = el('button', {
        type: 'button',
        class: value === current ? 'quick active' : 'quick',
        'aria-pressed': String(value === current),
      }, labels[value], ' ', el('span', { class: 'quick-count' }, countFor(value)));
      button.addEventListener('click', () => {
        select.value = value;
        select.dispatchEvent(new Event('change'));
      });
      return button;
    }));
  }

  const countMatching = (items, test) => items.reduce((n, item) => n + (test(item) ? 1 : 0), 0);

  function applyFilters({ keepPage = false } = {}) {
    const now = Date.now();
    const progress = els.progress.value;
    const mistakes = els.mistakes.value;
    const japanese = japaneseFilters();
    const forProgress = state.items.filter((item) => matchesProgress(item, progress, now));
    // Each row of quick buttons counts items within every other filter.
    const forMistakes = forProgress.filter((item) => matchesJapanese(item, japanese));
    const forJlpt = forProgress.filter((item) => matchesMistakes(item, mistakes, now)
      && matchesJapanese(item, { ...japanese, jlpt: 'any' }));
    state.view = forMistakes.filter((item) => matchesMistakes(item, mistakes, now));
    if (!keepPage) state.page = 0;
    renderChips(els.quickFilters, els.mistakes, MISTAKE_VALUES, QUICK_LABEL,
      (value) => countMatching(forMistakes, (item) => matchesMistakes(item, value, now)));
    renderChips(els.quickJlpt, els.jlpt, JLPT_QUICK, JLPT_QUICK_LABEL,
      (value) => countMatching(forJlpt, (item) => matchesJapanese(item, { ...japanese, jlpt: value })));
    updateFiltersSummary();
    renderList();
  }

  function setAllRevealed(on) {
    for (const item of state.view) {
      if (on) state.revealed.add(item.id);
      else state.revealed.delete(item.id);
    }
    renderList();
  }

  function shuffleView() {
    const arr = state.view;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    state.page = 0;
    renderList();
  }

  // ---------- Loading ----------
  async function load() {
    const types = selectedTypes();
    if (types.length === 0) {
      setMessage('Select at least one type.', true);
      return;
    }
    const min = Number(els.levelMin.value);
    const max = Number(els.levelMax.value);
    if (min > max) {
      setMessage('The minimum level must be lower than or equal to the maximum level.', true);
      return;
    }

    const token = getToken();
    if (!token) {
      showLogin();
      return;
    }

    savePrefs();
    setBusy(true);
    // 1. Show the list at once from what is already known (memory or local cache).
    let shown = false;
    let cachedSubjects = null;
    let cachedAssignments = null;
    if (!state.raw) {
      [cachedSubjects, cachedAssignments] = await Promise.all([readCollection('subjects'), readCollection('assignments')]);
      if (cachedSubjects && cachedAssignments) {
        state.raw = { subjects: cachedSubjects.records, assignments: cachedAssignments.records, japanese: await loadJapaneseData() };
        state.stats = buildStatsMap(loadStatsCache());
      }
    }
    if (state.raw) {
      state.items = buildItems();
      applyFilters();
      els.filtersPanel.open = false;
      shown = true;
      setMessage('Checking WaniKani for updates…');
    } else {
      setMessage('Loading from WaniKani (first time: this can take a minute)…');
    }

    // 2. Fetch only what changed since the last sync, and redraw if anything did.
    try {
      const [subjects, assignments, statsCache, japanese] = await Promise.all([
        syncCollection('subjects', `${API_BASE}/subjects`, token, compactSubject, (raw) => raw.id, cachedSubjects),
        syncCollection('assignments', `${API_BASE}/assignments`, token, compactAssignment, (raw) => raw.data.subject_id, cachedAssignments),
        syncStats(token),
        loadJapaneseData(),
      ]);
      state.raw = { subjects: subjects.records, assignments: assignments.records, japanese };
      state.stats = buildStatsMap(statsCache);
      if (!shown || subjects.changed || assignments.changed || statsCache.changed) {
        state.items = buildItems();
        // Keep the current page when the list was already on screen.
        applyFilters({ keepPage: shown });
        els.filtersPanel.open = false;
      }
      const notes = [];
      if (!state.items.length) notes.push('No items for these filters.');
      if (!japanese) notes.push('The JLPT, frequency and grade data could not be loaded: those filters match nothing.');
      setMessage(notes.join(' '), !japanese);
    } catch (err) {
      const text = err.message || 'Unknown error.';
      setMessage(shown ? `Could not update from WaniKani (${text}) Showing saved data.` : text, true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- Screens ----------
  function showLogin() {
    els.login.hidden = false;
    els.filters.hidden = true;
    els.results.hidden = true;
    els.logout.hidden = true;
    els.token.focus();
  }

  function showApp() {
    els.login.hidden = true;
    els.filters.hidden = false;
    els.logout.hidden = false;
  }

  // ---------- Events ----------
  els.loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const token = els.token.value.trim();
    if (!token) return;
    storageSet(STORAGE_TOKEN, token);
    els.token.value = '';
    showApp();
    load();
  });

  els.logout.addEventListener('click', () => {
    // The statistics cache belongs to the account: remove it with the token.
    storageRemove(STORAGE_TOKEN);
    storageRemove(STORAGE_STATS);
    storageRemove(OLD_STORAGE_STATS);
    dbClear();
    state.raw = null;
    state.stats = new Map();
    state.items = [];
    state.view = [];
    state.page = 0;
    state.revealed.clear();
    els.list.replaceChildren();
    setMessage('');
    showLogin();
  });

  els.filtersForm.addEventListener('submit', (e) => {
    e.preventDefault();
    load();
  });

  els.levelMin.addEventListener('change', () => {
    if (Number(els.levelMin.value) > Number(els.levelMax.value)) {
      els.levelMax.value = els.levelMin.value;
    }
  });

  els.levelMax.addEventListener('change', () => {
    if (Number(els.levelMax.value) < Number(els.levelMin.value)) {
      els.levelMin.value = els.levelMax.value;
    }
  });

  for (const select of [els.progress, els.mistakes, els.jlpt, els.frequency, els.grade, els.pos]) {
    select.addEventListener('change', () => {
      savePrefs();
      if (state.raw) applyFilters();
      else updateFiltersSummary();
    });
  }

  for (const input of [els.levelMin, els.levelMax, ...els.filtersForm.querySelectorAll('input[name="types"]')]) {
    input.addEventListener('change', updateFiltersSummary);
  }

  els.autoplay.addEventListener('change', savePrefs);

  els.prevPage.addEventListener('click', () => {
    state.page -= 1;
    renderList();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  els.nextPage.addEventListener('click', () => {
    state.page += 1;
    renderList();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  els.theme.addEventListener('click', () => {
    applyTheme(THEME_NEXT[currentTheme()]);
  });

  els.shuffle.addEventListener('click', shuffleView);
  els.showAll.addEventListener('click', () => setAllRevealed(true));
  els.hideAll.addEventListener('click', () => setAllRevealed(false));

  // ---------- Startup ----------
  function init() {
    storageRemove(OLD_STORAGE_STATS);
    applyTheme(currentTheme());
    populateLevels();
    restorePrefs();
    updateFiltersSummary();
    if (getToken()) {
      showApp();
      load();
    } else {
      showLogin();
    }
  }

  init();
})();
