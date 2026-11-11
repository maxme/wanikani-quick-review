(() => {
  'use strict';

  const API_BASE = 'https://api.wanikani.com/v2';
  const REVISION = '20170710';
  const LEVEL_MAX = 60;
  const PAGE_SIZE = 1000;
  const HOUR = 60 * 60 * 1000;
  // Timed study: time allowed for each card before it counts as wrong.
  const TIMED_LIMIT_MS = 10 * 1000;
  // Firefox on macOS adds a sound at the end of every speech synthesis reading, in every voice (checked with
  // Kyoko and Kyoko (Enhanced)); Chrome and Safari on the same Mac do not. The read-aloud button is hidden there.
  const SPEECH_END_SOUND = /Firefox\//.test(navigator.userAgent) && /Macintosh/.test(navigator.userAgent);

  // Leech score, as in the community "Leech Training" script: for the meaning and the reading separately,
  // incorrect answers / (current streak of correct answers) ^ 1.5; an item's score is the higher of the two.
  // It is high for items missed often AND missed recently (the streak restarts at 1 after a miss), unlike the
  // overall % correct, which barely moves once an item has many correct answers.
  // Leech: at least LEECH_MIN_MISTAKES misses in total, a score of at least LEECH_SCORE, and not burned.
  // With 10 and 4: 71 leeches on a real level-60 account (on one part: missed at the last review with 4+ misses
  // there, or 12+ misses with a streak of 2, 21+ with a streak of 3…).
  const LEECH_MIN_MISTAKES = 10;
  const LEECH_SCORE = 4;

  // Storage keys are unchanged so existing tokens and preferences keep working.
  const STORAGE_TOKEN = 'wk-quick-review.token';
  const STORAGE_PREFS = 'wk-quick-review.prefs';
  const STORAGE_THEME = 'wk-quick-review.theme';
  // v3: the cache entries now hold the leech score; older caches are dropped and fully re-synced.
  const STORAGE_STATS = 'wk-quick-review.stats.v3';
  const OLD_STORAGE_STATS = ['wk-quick-review.stats', 'wk-quick-review.stats.v2'];
  // A study paused in this browser (one at a time). Holds item ids and timings only.
  const STORAGE_STUDY = 'wk-quick-review.study';

  const TYPE_LABEL ={ radical: 'Radical', kanji: 'Kanji', vocabulary: 'Vocabulary' };
  const TYPE_ORDER = { radical: 0, kanji: 1, vocabulary: 2 };
  // The plain "reading" group of vocabulary gets no row label: the card already says "Reading".
  const READING_LABEL = { onyomi: 'On’yomi', kunyomi: 'Kun’yomi', nanori: 'Nanori', reading: '' };
  const READING_ORDER = ['onyomi', 'kunyomi', 'nanori', 'reading'];
  const SRS_LABEL = { 1: 'Apprentice', 2: 'Apprentice', 3: 'Apprentice', 4: 'Apprentice', 5: 'Guru', 6: 'Guru', 7: 'Master', 8: 'Enlightened', 9: 'Burned' };

  // Grade scale: 1-6 elementary school, 8 secondary school, 9-10 jinmeiyo (names), NOT_JOYO otherwise.
  const NOT_JOYO = 11;
  // JMdict frequency bands hold 500 words each.
  const FREQUENCY_BAND = 500;
  const STAGE_GROUP = ['not-started', 'apprentice', 'apprentice', 'apprentice', 'apprentice', 'guru', 'guru', 'master', 'enlightened', 'burned'];
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
  // Frequency chips are disjoint bands, so selecting several adds them up (Top 500 + 501–1,000 = top 1,000).
  const FREQUENCY_RANGE = { 500: [0, 500], 1000: [500, 1000], 2500: [1000, 2500], 5000: [2500, 5000], 10000: [5000, 10000] };

  // ---------- Filter model ----------
  // Every filter is a group of chips. Chips of one group add up (OR); groups combine (AND).
  // No chip selected in a group = no constraint. "japanese" groups leave radicals out once a chip is selected.
  const FILTER_GROUPS = [
    {
      key: 'types', label: 'Type', summary: (labels) => labels.join(', '),
      options: [['radical', 'Radicals'], ['kanji', 'Kanji'], ['vocabulary', 'Vocabulary']],
      test: (item, v) => item.type === v,
    },
    {
      key: 'progress', label: 'SRS stage',
      options: [['not-started', 'Not started'], ['apprentice', 'Apprentice'], ['guru', 'Guru'], ['master', 'Master'],
        ['enlightened', 'Enlightened'], ['burned', 'Burned']],
      test: (item, v) => STAGE_GROUP[item.srsStage] === v,
    },
    {
      key: 'due', label: 'Reviews',
      options: [['now', 'Available now']],
      test: (item, v, now) => item.srsStage >= 1 && item.srsStage < 9
        && item.availableAt != null && Date.parse(item.availableAt) <= now,
    },
    {
      key: 'mistakes', label: 'Mistakes', quick: true,
      hint: 'A miss is counted when the last review of an item had a wrong answer and happened within the period. '
        + 'Leech: 10+ misses, missed often and recently (leech score of 4 or more: misses on the meaning or reading '
        + 'divided by its current correct streak ^ 1.5), not burned.',
      options: [['missed-24h', 'Missed 24 h'], ['missed-48h', 'Missed 48 h'], ['missed-7d', 'Missed 7 days'],
        ['leech', 'Leeches'], ['never', 'Never missed']],
      test: (item, v, now) => matchesMistake(item, v, now),
    },
    {
      key: 'jlpt', label: 'JLPT', japanese: true, quick: true, summary: (labels) => `JLPT ${labels.join(' + ')}`,
      hint: 'Jonathan Waller’s lists (unofficial: the JLPT has published no list since 2010).',
      options: [['5', 'N5'], ['4', 'N4'], ['3', 'N3'], ['2', 'N2'], ['1', 'N1'], ['none', 'Not in JLPT']],
      test: (item, v) => (v === 'none' ? item.jlpt === null : item.jlpt === Number(v)),
    },
    {
      key: 'frequency', label: 'Frequency', japanese: true,
      hint: 'Newspaper rank for kanji (KANJIDIC), JMdict frequency band for words.',
      options: [['500', 'Top 500'], ['1000', '501–1,000'], ['2500', '1,001–2,500'], ['5000', '2,501–5,000'],
        ['10000', '5,001–10,000'], ['rare', 'Rarer']],
      test: (item, v) => {
        if (v === 'rare') return item.frequency === null || item.frequency > 10000;
        const [low, high] = FREQUENCY_RANGE[v];
        return item.frequency !== null && item.frequency > low && item.frequency <= high;
      },
    },
    {
      key: 'grade', label: 'School grade', japanese: true,
      hint: 'School year a kanji is taught in; for a word, its hardest kanji.',
      options: [['1', 'Grade 1'], ['2', 'Grade 2'], ['3', 'Grade 3'], ['4', 'Grade 4'], ['5', 'Grade 5'], ['6', 'Grade 6'],
        ['8', 'Secondary'], ['9', 'Jinmeiyō (names)'], ['none', 'Not jōyō']],
      test: (item, v) => item.grade === (v === 'none' ? NOT_JOYO : Number(v)),
    },
    {
      key: 'pos', label: 'Word type', japanese: true,
      options: [['noun', 'Nouns'], ['verb', 'Verbs'], ['godan', 'Godan'], ['ichidan', 'Ichidan'], ['suru', 'する verbs'],
        ['transitive', 'Transitive'], ['intransitive', 'Intransitive'], ['i-adj', 'い adjectives'],
        ['na-adj', 'な adjectives'], ['no-adj', 'の adjectives'], ['adverb', 'Adverbs'], ['expression', 'Expressions'],
        ['counter', 'Counters, numerals'], ['affix', 'Prefixes, suffixes']],
      test: (item, v) => item.partsOfSpeech.some((p) => POS_GROUPS[v].includes(p)),
    },
  ];
  // ---------- Sort orders ----------
  // Each order is a list of [key, direction] (1 ascending, -1 descending), then the WaniKani order (level, type,
  // lesson position) for ties. Reversing flips every direction, ties included, so the list is an exact mirror,
  // except that items without a value (null: never reviewed, no frequency, not in the JLPT lists…) stay last.
  function compareKey(x, y, dir) {
    if (x === y) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * dir;
  }
  const lastMissAt = (item) => (item.history.lastReviewMissed ? item.history.lastReviewAt : null);
  const SORTS = {
    level: {
      label: 'Level', reversedLabel: 'Level (highest first)',
      keys: [[(i) => i.level, 1], [(i) => TYPE_ORDER[i.type], 1], [(i) => i.position, 1]],
    },
    misses: { label: 'Most misses', reversedLabel: 'Fewest misses', keys: [[(i) => i.history.wrong, -1]] },
    difficulty: {
      label: 'Hardest (leech score)', reversedLabel: 'Easiest (leech score)',
      keys: [[(i) => (i.history.answered ? i.history.leechScore : null), -1], [(i) => i.history.wrong, -1]],
    },
    recent: { label: 'Recently missed', reversedLabel: 'Missed longest ago', keys: [[lastMissAt, -1]] },
    jlpt: { label: 'JLPT (N5 → N1)', reversedLabel: 'JLPT (N1 → N5)', keys: [[(i) => i.jlpt, -1]] },
    frequency: { label: 'Most frequent', reversedLabel: 'Least frequent', keys: [[(i) => i.frequency, 1]] },
    srs: {
      label: 'SRS stage (Apprentice first)', reversedLabel: 'SRS stage (Burned first)',
      keys: [[(i) => i.srsStage || null, 1]],
    },
    due: {
      label: 'Next review', reversedLabel: 'Latest review',
      keys: [[(i) => (i.availableAt ? Date.parse(i.availableAt) : null), 1]],
    },
    random: { label: 'Random', keys: null },
  };

  function sortComparator(order, reversed) {
    const keys = [...SORTS[order].keys, ...SORTS.level.keys].map(([key, dir]) => [key, reversed ? -dir : dir]);
    return (a, b) => {
      for (const [key, dir] of keys) {
        const c = compareKey(key(a), key(b), dir);
        if (c) return c;
      }
      return 0;
    };
  }

  const GROUP_BY_KEY = Object.fromEntries(FILTER_GROUPS.map((g) => [g.key, g]));
  const emptyFilters = () => Object.fromEntries(FILTER_GROUPS.map((g) => [g.key, new Set()]));
  const JAPANESE_DATA_URL = 'data/japanese.json';
  const HAN = /\p{Script=Han}/u;
  const THEME_LABEL = { auto: 'auto', light: 'light', dark: 'dark' };
  // Inline SVG icons: text symbols such as ◐ render inconsistently across fonts.
  const svg = (body) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">${body}</svg>`;
  const THEME_ICON = {
    auto: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
    light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    dark: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  };
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
    filterGroups: $('#filter-groups'),
    quickMistakes: $('#quick-mistakes'),
    quickJlpt: $('#quick-jlpt'),
    clearFilters: $('#clear-filters'),
    sort: $('#sort'),
    reverse: $('#reverse'),
    sortLabel: $('#sort-label'),
    autoplay: $('#autoplay'),
    results: $('#results'),
    count: $('#count'),
    list: $('#list'),
    pager: $('#pager'),
    prevPage: $('#prev-page'),
    nextPage: $('#next-page'),
    pageLabel: $('#page-label'),
    shuffle: $('#shuffle'),
    toggleAll: $('#toggle-all'),
    density: $('#density'),
    revealedBar: $('#revealed-bar'),
    study: $('#study'),
    studyView: $('#study-view'),
    studyProgress: $('#study-progress'),
    studyBar: $('#study-bar'),
    studyStage: $('#study-stage'),
    studyButtons: $('#study-buttons'),
    studyClose: $('#study-close'),
    studyPause: $('#study-pause'),
    studyTimer: $('#study-timer'),
    studyTimed: $('#study-timed'),
    resume: $('#study-resume'),
    resumeText: $('#resume-text'),
    resumeContinue: $('#resume-continue'),
    resumeDiscard: $('#resume-discard'),
    message: $('#message'),
    theme: $('#theme'),
    filtersPanel: $('#filters-panel'),
    filtersSummary: $('#filters-summary'),
  };

  // raw: subjects and assignments as returned by the API (null until loaded)
  // stats: Map subject id -> review history built from the local statistics cache
  // voice: chosen pronunciation voice per vocabulary id
  // filters: Set of selected chip values per filter group
  const state = { reversed: false, filters: emptyFilters(), raw: null, stats: new Map(), items: [], view: [], page: 0, revealed: new Set(), voice: new Map() };

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
      version: 2,
      levelMin: Number(els.levelMin.value),
      levelMax: Number(els.levelMax.value),
      filters: Object.fromEntries(Object.entries(state.filters).map(([key, set]) => [key, [...set]])),
      autoplay: els.autoplay.checked,
      timed: study.timed,
      compact: document.body.classList.contains('compact'),
      sort: els.sort.value,
      reversed: state.reversed,
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
    els.theme.innerHTML = THEME_ICON[theme];
    els.theme.title = `Theme: ${THEME_LABEL[theme]}`;
    els.theme.setAttribute('aria-label', `Theme: ${THEME_LABEL[theme]}`);
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
  function populateLevels() {
    for (const select of [els.levelMin, els.levelMax]) {
      for (let n = 1; n <= LEVEL_MAX; n++) select.append(el('option', { value: n }, n));
    }
    els.levelMax.value = String(LEVEL_MAX);
  }

  // Preferences of earlier versions held one value per select; they map to chips here.
  function migrateFilters(prefs) {
    const f = {};
    if (Array.isArray(prefs.types) && prefs.types.length < 3) f.types = prefs.types;
    const progress = prefs.progress ?? prefs.status;
    if (progress === 'not-started') f.progress = ['not-started'];
    if (progress === 'started') f.progress = ['apprentice', 'guru', 'master', 'enlightened', 'burned'];
    if (progress === 'burned') f.progress = ['burned'];
    if (progress === 'review') f.due = ['now'];
    if (prefs.mistakes && prefs.mistakes !== 'any') f.mistakes = [prefs.mistakes];
    const upTo = { upto4: ['5', '4'], upto3: ['5', '4', '3'], upto2: ['5', '4', '3', '2'] };
    if (prefs.jlpt && prefs.jlpt !== 'any') f.jlpt = upTo[prefs.jlpt] ?? [prefs.jlpt];
    const bands = ['500', '1000', '2500', '5000', '10000'];
    if (prefs.frequency === 'rare') f.frequency = ['rare'];
    else if (bands.includes(prefs.frequency)) f.frequency = bands.slice(0, bands.indexOf(prefs.frequency) + 1);
    if (prefs.grade && prefs.grade !== 'any') f.grade = [prefs.grade];
    if (prefs.pos && prefs.pos !== 'any') f.pos = [prefs.pos];
    return f;
  }

  function restorePrefs() {
    const prefs = loadPrefs();
    if (Number.isInteger(prefs.levelMin)) els.levelMin.value = String(Math.min(Math.max(prefs.levelMin, 1), LEVEL_MAX));
    if (Number.isInteger(prefs.levelMax)) els.levelMax.value = String(Math.min(Math.max(prefs.levelMax, 1), LEVEL_MAX));
    const saved = prefs.version === 2 ? prefs.filters ?? {} : migrateFilters(prefs);
    state.filters = emptyFilters();
    for (const group of FILTER_GROUPS) {
      const valid = new Set(group.options.map(([value]) => value));
      for (const value of Array.isArray(saved[group.key]) ? saved[group.key] : []) {
        if (valid.has(value)) state.filters[group.key].add(value);
      }
    }
    if (typeof prefs.autoplay === 'boolean') els.autoplay.checked = prefs.autoplay;
    if (typeof prefs.timed === 'boolean') study.timed = prefs.timed;
    setCompact(prefs.compact === true);
    if (SORTS[prefs.sort]) els.sort.value = prefs.sort;
    state.reversed = prefs.reversed === true;
    updateSortLabel();
  }

  function populateSorts() {
    for (const [value, { label }] of Object.entries(SORTS)) els.sort.append(el('option', { value }, label));
  }

  function updateSortLabel() {
    const sort = SORTS[els.sort.value];
    const random = !sort.keys;
    const reversed = state.reversed;
    const label = random ? sort.label : reversed ? sort.reversedLabel : sort.label;
    els.sortLabel.textContent = label.replace(/ \(.*\)$/, '');
    const wrapper = els.sort.parentElement;
    wrapper.title = `Order: ${label}`;
    wrapper.classList.toggle('active', els.sort.value !== 'level' || reversed);
    els.reverse.setAttribute('aria-pressed', String(reversed));
    els.reverse.textContent = reversed ? '↑' : '↓';
    els.reverse.title = reversed ? `Reversed: ${label}` : 'Reverse order';
    els.reverse.setAttribute('aria-label', els.reverse.title);
  }

  // Sorts the filtered list in place by the chosen order.
  function sortView() {
    const order = els.sort.value;
    if (order === 'random') {
      const arr = state.view;
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    } else {
      state.view.sort(sortComparator(order, state.reversed));
    }
  }

  function setCompact(on) {
    document.body.classList.toggle('compact', on);
    els.density.setAttribute('aria-pressed', String(on));
    els.density.title = on ? 'Comfortable view' : 'Compact view';
    els.density.setAttribute('aria-label', els.density.title);
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
  // Cache entry per subject: [wrong, answered, percentCorrect, lastReviewAt(ms), lastReviewMissed(0|1), leechScore]
  const NO_HISTORY = { wrong: 0, answered: 0, percentCorrect: null, lastReviewAt: 0, lastReviewMissed: false, leechScore: 0 };

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

  const partLeechScore = (incorrect, streak) => (incorrect || 0) / Math.max(streak || 0, 1) ** 1.5;

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
      Math.round(100 * Math.max(
        partLeechScore(d.meaning_incorrect, d.meaning_current_streak),
        partLeechScore(d.reading_incorrect, d.reading_current_streak),
      )) / 100,
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
    for (const [id, [wrong, answered, percentCorrect, lastReviewAt, lastReviewMissed, leechScore]] of Object.entries(cache.s)) {
      map.set(Number(id), {
        wrong, answered, percentCorrect, lastReviewAt, lastReviewMissed: lastReviewMissed === 1, leechScore,
      });
    }
    return map;
  }

  // Burned items never come back in reviews: they are not leeches any more.
  function isLeech(h, srsStage) {
    return h.wrong >= LEECH_MIN_MISTAKES && h.leechScore >= LEECH_SCORE && srsStage !== 9;
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
      leech: isLeech(h, assignment?.[0] ?? 0),
    };
  }

  function compareItems(a, b) {
    return a.level - b.level
      || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
      || a.position - b.position;
  }

  // Every subject of every level; all filters, type and level included, are applied in applyFilters.
  function buildItems() {
    const { subjects, assignments, japanese } = state.raw;
    return Object.values(subjects)
      .filter((s) => !s.hidden)
      .map((s) => toItem(s, assignments[s.id], state.stats.get(s.id) ?? null, japanese))
      .sort(compareItems);
  }

  // ---------- Filter predicates ----------
  function matchesMistake(item, value, now) {
    const h = item.history;
    // The last review had a miss and happened within the window.
    const missedWithin = (hours) => h.lastReviewMissed && h.lastReviewAt >= now - hours * HOUR;
    switch (value) {
      case 'missed-24h': return missedWithin(24);
      case 'missed-48h': return missedWithin(48);
      case 'missed-7d': return missedWithin(24 * 7);
      case 'leech': return item.leech;
      case 'never': return h.answered > 0 && h.wrong === 0;
      default: return false;
    }
  }

  // An item passes a group when no chip is selected, or when it matches at least one selected chip.
  function matchesGroup(item, group, selected, now) {
    if (selected.size === 0) return true;
    if (group.japanese && item.type === 'radical') return false;
    for (const value of selected) {
      if (group.test(item, value, now)) return true;
    }
    return false;
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
      // Vocabulary has WaniKani audio; a kanji gets its primary reading read aloud by the browser.
      const primary = item.type === 'kanji' && !SPEECH_END_SOUND ? primaryReading(item) : null;
      nodes.push(el('div', { class: 'reading-line' },
        el('div', { class: 'readings' }, ...groups),
        item.audios.length ? buildAudioButtons(item, voiceIndex, handlers)
          : primary ? buildSpeakButton(primary) : null));
    }
    return nodes;
  }

  // The reading WaniKani marks as primary (on’yomi or kun’yomi, whichever it is), with its group label.
  function primaryReading(item) {
    for (const group of item.readings) {
      const primary = group.items.find((reading) => reading.primary);
      if (primary) return { text: primary.text, label: group.label };
    }
    return null;
  }

  function buildSpeakButton({ text, label }) {
    const button = el('button', {
      type: 'button',
      class: 'audio-btn speak-btn',
      title: `Read aloud: ${text}${label ? ` (${label})` : ''}`,
      'aria-label': `Read aloud: ${text}`,
    }, '🔊');
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      speakReading(text);
    });
    return button;
  }

  // Reads a kanji reading with the browser's speech synthesis, using a Japanese voice when the device has one.
  function speakReading(text) {
    const unavailable = 'Read-aloud is not available in this browser.';
    if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) {
      setMessage(unavailable, true);
      return;
    }
    try {
      const voices = window.speechSynthesis.getVoices();
      const japanese = voices.find((voice) => voice.lang?.toLowerCase().startsWith('ja'));
      if (voices.length && !japanese) {
        setMessage('No Japanese voice on this device: install one to hear readings.', true);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'ja-JP';
      if (japanese) utterance.voice = japanese;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch {
      setMessage(unavailable, true);
    }
  }

  // Small grey line: level, JLPT, SRS stage, misses. The type is given by the card colour (and the tile label).
  function buildMeta(item) {
    const wrong = item.history.wrong;
    const parts = [
      el('span', {}, `Lvl ${item.level}`),
      item.jlpt ? el('span', { class: 'jlpt', title: `JLPT N${item.jlpt}` }, `N${item.jlpt}`) : null,
      item.srsStage >= 1 ? el('span', {}, SRS_LABEL[item.srsStage]) : null,
      wrong > 0 ? el('span', { title: `${wrong} miss${wrong > 1 ? 'es' : ''} in total` }, `✗ ${wrong}`) : null,
      wrong > 0 && item.history.percentCorrect !== null
        ? el('span', { title: 'Correct answers overall' }, `${item.history.percentCorrect}%`) : null,
      item.leech ? el('span', { class: 'leech' }, 'Leech') : null,
    ].filter(Boolean);
    return el('div', { class: 'meta' }, ...parts);
  }

  function buildCard(item) {
    // The answer is always laid out, so the card keeps the same height whether it is revealed or not.
    // While hidden, CSS makes it invisible (its buttons cannot be focused) and shows a faint hint instead.
    const content = el('div', { class: 'answer-content' });
    const answer = el('div', { class: 'answer' }, content);
    const card = el('div', {
      class: `card type-${item.type}`,
      role: 'button',
      tabindex: '0',
      'aria-expanded': 'false',
    },
      el('div', { class: 'glyph-tile', title: TYPE_LABEL[item.type] }, buildGlyph(item)),
      el('div', { class: 'card-body' }, buildMeta(item), answer));

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
    const n = (x) => x.toLocaleString('en-US');
    // With several pages, wide screens show the range; phones show only the total (the pager shows the page).
    if (!total) els.count.textContent = 'No items match these filters';
    else if (pages > 1) {
      els.count.replaceChildren(
        el('span', { class: 'count-range' }, `${n(start + 1)}–${n(start + slice.length)} of `),
        n(total),
        el('span', { class: 'count-unit' }, ' items'));
    } else els.count.textContent = `${n(total)} item${total > 1 ? 's' : ''}`;
    els.study.disabled = total === 0;
    els.pager.hidden = pages <= 1;
    els.pageLabel.textContent = `Page ${state.page + 1} of ${pages}`;
    els.prevPage.disabled = state.page === 0;
    els.nextPage.disabled = state.page >= pages - 1;
    els.results.hidden = false;
  }

  const hasActiveFilters = () => FILTER_GROUPS.some((g) => state.filters[g.key].size > 0);

  // One-line summary of the filters, shown when the filter panel is collapsed.
  function updateFiltersSummary() {
    const levels = els.levelMin.value === els.levelMax.value
      ? `Level ${els.levelMin.value}`
      : `Levels ${els.levelMin.value}–${els.levelMax.value}`;
    const parts = [levels];
    for (const group of FILTER_GROUPS) {
      const selected = state.filters[group.key];
      if (!selected.size) continue;
      // Labels in the order of the chips, not of the clicks.
      const labels = group.options.filter(([value]) => selected.has(value)).map(([, label]) => label);
      parts.push(group.summary ? group.summary(labels) : labels.join(' + '));
    }
    if (parts.length === 1) parts.push('No filter');
    els.filtersSummary.textContent = parts.join(' · ');
    els.clearFilters.hidden = !hasActiveFilters();
  }

  // Thin progress bar under the toolbar; the eye button shows or hides all depending on it.
  function updateRevealedCount() {
    const total = state.view.length;
    const revealed = state.view.reduce((n, item) => n + (state.revealed.has(item.id) ? 1 : 0), 0);
    els.revealedBar.style.width = total ? `${(100 * revealed) / total}%` : '0';
    const bar = els.revealedBar.parentElement;
    bar.setAttribute('aria-valuemax', String(total));
    bar.setAttribute('aria-valuenow', String(revealed));
    bar.title = `${revealed} / ${total} revealed`;
    const allShown = total > 0 && revealed === total;
    els.toggleAll.textContent = allShown ? '○' : '◉';
    els.toggleAll.title = allShown ? 'Hide all answers' : 'Show all answers';
    els.toggleAll.setAttribute('aria-label', els.toggleAll.title);
  }

  function toggleChip(group, value) {
    const selected = state.filters[group.key];
    if (selected.has(value)) selected.delete(value);
    else selected.add(value);
    savePrefs();
    applyFilters();
  }

  // Chips of one group. counts: Map value -> number of items this chip matches within the other groups,
  // or null before the data is loaded.
  function buildChips(group, counts) {
    const selected = state.filters[group.key];
    return group.options.map(([value, label]) => {
      const on = selected.has(value);
      const count = counts?.get(value);
      const button = el('button', {
        type: 'button',
        class: `quick${on ? ' active' : ''}${count === 0 && !on ? ' empty' : ''}`,
        'aria-pressed': String(on),
      }, label, count === undefined ? null : el('span', { class: 'quick-count' }, count));
      button.addEventListener('click', () => toggleChip(group, value));
      return button;
    });
  }

  // The filter panel: one row of chips per group, built once; the chips are refreshed by renderChips.
  const groupRows = new Map();
  function buildFilterGroups() {
    for (const group of FILTER_GROUPS) {
      const chips = el('div', { class: 'chips', role: 'group', 'aria-label': group.label });
      els.filterGroups.append(el('fieldset', { class: 'filter-group' },
        el('legend', {}, group.label),
        chips,
        group.hint ? el('small', { class: 'hint' }, group.hint) : null));
      groupRows.set(group.key, chips);
    }
  }

  function renderChips(counts) {
    for (const group of FILTER_GROUPS) {
      groupRows.get(group.key).replaceChildren(...buildChips(group, counts?.get(group.key)));
    }
    els.quickMistakes.replaceChildren(...buildChips(GROUP_BY_KEY.mistakes, counts?.get('mistakes')));
    els.quickJlpt.replaceChildren(...buildChips(GROUP_BY_KEY.jlpt, counts?.get('jlpt')));
  }

  // Applies every filter and computes, for each chip, how many items the list would show with it:
  // the count uses all the other groups, so chips of one group add up as the counts suggest.
  function applyFilters({ keepPage = false } = {}) {
    const now = Date.now();
    const min = Number(els.levelMin.value);
    const max = Number(els.levelMax.value);
    const active = FILTER_GROUPS.filter((g) => state.filters[g.key].size > 0);
    const inLevels = state.items.filter((item) => item.level >= min && item.level <= max);
    // For each item, the active groups it fails.
    const failed = inLevels.map((item) => active.filter((g) => !matchesGroup(item, g, state.filters[g.key], now)));
    state.view = inLevels.filter((_, i) => failed[i].length === 0);
    sortView();
    if (!keepPage) state.page = 0;

    const counts = new Map();
    for (const group of FILTER_GROUPS) {
      // Items that pass every group except possibly this one.
      const candidates = inLevels.filter((_, i) => failed[i].length === 0 || (failed[i].length === 1 && failed[i][0] === group));
      const groupCounts = new Map();
      for (const [value] of group.options) {
        const one = new Set([value]);
        groupCounts.set(value, candidates.reduce((n, item) => n + (matchesGroup(item, group, one, now) ? 1 : 0), 0));
      }
      counts.set(group.key, groupCounts);
    }
    renderChips(counts);
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

  // The shuffle button switches to the random order and draws a new one each time.
  function shuffleView() {
    els.sort.value = 'random';
    state.reversed = false;
    updateSortLabel();
    savePrefs();
    sortView();
    state.page = 0;
    renderList();
  }


  // ---------- Study mode: one card at a time ----------
  // Goes through a copy of the current list in its current order. The answers ("knew it" / "didn't know")
  // only live for the session: at the end, the missed cards can be studied again.
  // stopped: the session was left before the end; its results are shown for the cards answered so far.
  // answered: cards answered so far, over all the sittings of a paused study (knew + missed.length).
  // size: cards in the study (answered + still to come). all: the full list, to start again (null after a resume).
  // activeMs: time of the answered cards. cardMs / cardStart: the clock of the card on screen.
  // timed: each card has TIMED_LIMIT_MS on the card clock; past that, it counts as missed and the study moves on.
  // timedOut: how many of the missed cards ran out of time.
  const study = { items: [], index: 0, revealed: false, missed: [], knew: 0, answered: 0, stopped: false, size: 0, all: null, activeMs: 0, cardMs: 0, cardStart: null, timed: false, timedOut: 0 };
  const studyDone = () => study.stopped || study.index >= study.items.length;
  const cardElapsed = () => study.cardMs + (study.cardStart === null ? 0 : performance.now() - study.cardStart);

  // Ticks while a timed card is on screen: shows the countdown, and moves on when the time is up.
  setInterval(() => {
    if (!study.timed || studyDone() || study.cardStart === null) {
      els.studyTimer.textContent = '';
      return;
    }
    const left = TIMED_LIMIT_MS - cardElapsed();
    if (left <= 0) {
      study.timedOut += 1;
      answerStudy(false);
      return;
    }
    els.studyTimer.textContent = `${Math.ceil(left / 1000)} s`;
    els.studyTimer.classList.toggle('urgent', left <= 3000);
  }, 100);

  // The clock runs only while a card is on screen and the tab is visible.
  function clockStart() {
    if (study.cardStart === null && !studyDone() && !els.studyView.hidden && !document.hidden) study.cardStart = performance.now();
  }
  function clockStop() {
    if (study.cardStart !== null) {
      study.cardMs += performance.now() - study.cardStart;
      study.cardStart = null;
    }
  }
  // A card left without an answer (pause, stop, close) is not counted: it comes back later.
  function clockDiscard() {
    clockStop();
    study.cardMs = 0;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clockStop();
    else clockStart();
  });

  function startStudy(items) {
    if (!items.length) return;
    // The timed choice is kept from the last study: it is set from the study view.
    Object.assign(study, { items: [...items], all: [...items], index: 0, revealed: false, missed: [], knew: 0, answered: 0, stopped: false, size: items.length, activeMs: 0, cardMs: 0, cardStart: null, timedOut: 0 });
    showStudyView();
  }

  function showStudyView() {
    els.studyView.hidden = false;
    document.body.classList.add('studying');
    renderStudy();
    clockStart();
    // Keys go to the study view, not to the list behind it.
    els.studyView.focus();
  }

  // ✕ or Esc during a session: show the results so far if any card was answered; on the results, close.
  function leaveStudy() {
    if (!studyDone() && study.index > 0) {
      clockDiscard();
      study.stopped = true;
      renderStudy();
      els.studyView.focus();
    } else {
      closeStudy();
    }
  }

  function closeStudy() {
    clockDiscard();
    els.studyView.hidden = true;
    document.body.classList.remove('studying');
    els.study.focus();
  }

  // ---------- Paused study: saved in this browser, one at a time ----------
  // Only ids and counters are stored: the cards come from the list as it is when the study is resumed.
  function readPausedStudy() {
    try {
      const saved = JSON.parse(storageGet(STORAGE_STUDY) || 'null');
      return saved?.version === 1 && Array.isArray(saved.remaining) ? saved : null;
    } catch { return null; }
  }

  function pauseStudy() {
    if (study.index >= study.items.length) return;
    clockDiscard();
    storageSet(STORAGE_STUDY, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      size: study.size,
      answered: study.answered,
      knew: study.knew,
      activeMs: study.activeMs,
      missed: study.missed.map((item) => item.id),
      remaining: study.items.slice(study.index).map((item) => item.id),
      timedOut: study.timedOut,
    }));
    closeStudy();
    renderResume();
    if (!readPausedStudy()) setMessage('The study could not be saved: browser storage is unavailable.', true);
  }

  function resumePausedStudy() {
    const saved = readPausedStudy();
    if (!saved) return;
    const byId = new Map(state.items.map((item) => [item.id, item]));
    const remaining = saved.remaining.map((id) => byId.get(id)).filter(Boolean);
    const missed = saved.missed.map((id) => byId.get(id)).filter(Boolean);
    storageRemove(STORAGE_STUDY);
    renderResume();
    if (!remaining.length) {
      setMessage('The paused study has no cards left.');
      return;
    }
    Object.assign(study, { items: remaining, all: null, index: 0, revealed: false, missed, knew: saved.knew, answered: saved.answered, stopped: false, size: saved.answered + remaining.length, activeMs: saved.activeMs, cardMs: 0, cardStart: null, timedOut: saved.timedOut ?? 0 });
    showStudyView();
  }

  // The timed choice lives in the study view and is remembered in the preferences. Turning it on starts
  // the countdown of the card on screen from 10 s.
  function toggleTimed() {
    study.timed = !study.timed;
    if (study.timed && study.cardStart !== null) {
      study.cardMs = 0;
      study.cardStart = performance.now();
    }
    savePrefs();
    renderStudy();
    // Keeps Space on the card, not on this button.
    els.studyView.focus();
  }

  function discardPausedStudy() {
    storageRemove(STORAGE_STUDY);
    renderResume();
  }

  // Shows the paused study above the list, with what is left and the projected time at its pace.
  function renderResume() {
    const saved = readPausedStudy();
    els.resume.hidden = !saved;
    if (!saved) return;
    const left = saved.remaining.length;
    const pace = saved.answered ? projectionText(saved.activeMs, saved.answered, left) : '';
    els.resumeText.textContent = `Study paused: ${saved.answered} of ${saved.size} cards done, ${left} left${pace ? ` (${pace})` : ''}.`;
  }

  // ---------- Time formatting and projection ----------
  function formatDuration(ms) {
    const total = Math.round(ms / 1000);
    if (total < 60) return `${total} s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes} min ${String(total % 60).padStart(2, '0')} s`;
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
  }

  // Average per card: one decimal under 10 seconds, where a whole second would hide the difference.
  function formatAverage(ms) {
    return ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : formatDuration(ms);
  }

  // The projection applies the average time per answered card to the cards left.
  function projectionText(activeMs, answered, left) {
    if (!answered || !left) return '';
    return `about ${formatDuration((activeMs / answered) * left)} at this pace`;
  }

  function statBlock(value, label) {
    return el('div', { class: 'stat' }, el('span', { class: 'stat-value' }, value), el('span', { class: 'stat-label' }, label));
  }

  function studyButton(label, key, onClick, cls = '') {
    const button = el('button', { type: 'button', class: cls }, label, el('kbd', {}, key));
    button.addEventListener('click', onClick);
    return button;
  }

  function renderStudy() {
    els.studyBar.style.width = `${(100 * study.answered) / study.size}%`;
    els.studyPause.hidden = studyDone();
    els.studyTimer.hidden = studyDone() || !study.timed;
    els.studyTimed.hidden = studyDone();
    els.studyTimed.setAttribute('aria-pressed', String(study.timed));
    if (studyDone()) {
      const left = study.size - study.answered;
      const average = study.answered ? study.activeMs / study.answered : 0;
      els.studyProgress.textContent = study.stopped
        ? `Stopped after ${study.answered} of ${study.size} cards`
        : `Done: ${study.size} card${study.size > 1 ? 's' : ''}`;
      els.studyStage.replaceChildren(el('div', { class: 'study-summary' },
        el('div', { class: 'study-score' }, `${study.knew} / ${study.answered}`),
        el('p', {}, study.missed.length
          ? `${study.missed.length} missed${study.timedOut ? ` (${study.timedOut} out of time)` : ''}:`
          : 'You knew them all.'),
        el('div', { class: 'study-stats' },
          statBlock(formatDuration(study.activeMs), 'Total time'),
          statBlock(study.answered ? formatAverage(average) : '–', 'Average per card'),
          study.stopped && left > 0 && study.answered
            ? statBlock(`≈ ${formatDuration(average * left)}`, `Projected for the ${left} cards left`)
            : null),
        study.missed.length ? el('ol', { class: 'list study-missed' }, ...study.missed.map(buildMissedRow)) : null));
      const missed = [...study.missed];
      els.studyButtons.replaceChildren(
        missed.length ? studyButton(`Retry ${missed.length} missed`, 'Space', () => startStudy(missed), 'primary') : null,
        study.stopped && left > 0 ? studyButton('Continue later', 'P', pauseStudy) : null,
        study.all ? studyButton('Start again', 'R', () => startStudy(study.all)) : null,
        studyButton('Close', 'Esc', closeStudy));
      return;
    }
    const item = study.items[study.index];
    els.studyProgress.textContent = `${study.answered + 1} / ${study.size}`;
    if (study.timed) els.studyTimer.textContent = `${TIMED_LIMIT_MS / 1000} s`;
    const content = el('div', { class: 'answer-content' });
    const voice = () => state.voice.get(item.id) ?? 0;
    const renderAnswer = () => content.replaceChildren(...buildAnswer(item, voice(), {
      onPlay: () => playAudio(item.audios[voice()].url),
      onSwitch: () => {
        state.voice.set(item.id, (voice() + 1) % item.audios.length);
        renderAnswer();
        playAudio(item.audios[voice()].url);
      },
    }));
    renderAnswer();
    const card = el('div', { class: `study-card type-${item.type}${study.revealed ? ' revealed' : ''}` },
      el('div', { class: 'glyph-tile', title: TYPE_LABEL[item.type] }, buildGlyph(item)),
      el('div', { class: 'study-answer' }, buildMeta(item), content));
    card.addEventListener('click', (e) => {
      if (!study.revealed && !e.target.closest('button')) revealStudy();
    });
    els.studyStage.replaceChildren(card);
    els.studyButtons.replaceChildren(...(study.revealed
      ? [studyButton('Didn’t know', '1', () => answerStudy(false), 'miss'),
        studyButton('Knew it', '2', () => answerStudy(true), 'knew')]
      : [studyButton('Show answer', 'Space', revealStudy, 'primary')]));
  }

  // A missed card in the end-of-session list: always revealed, with its audio buttons.
  function buildMissedRow(item) {
    const voice = () => state.voice.get(item.id) ?? 0;
    const content = el('div', { class: 'answer-content' });
    const renderAnswer = () => content.replaceChildren(...buildAnswer(item, voice(), {
      onPlay: () => playAudio(item.audios[voice()].url),
      onSwitch: () => {
        state.voice.set(item.id, (voice() + 1) % item.audios.length);
        renderAnswer();
        playAudio(item.audios[voice()].url);
      },
    }));
    renderAnswer();
    return el('li', {}, el('div', { class: `card revealed static type-${item.type}` },
      el('div', { class: 'glyph-tile', title: TYPE_LABEL[item.type] }, buildGlyph(item)),
      el('div', { class: 'card-body' }, buildMeta(item), el('div', { class: 'answer' }, content))));
  }

  function revealStudy() {
    study.revealed = true;
    renderStudy();
    els.studyView.focus();
    const item = study.items[study.index];
    if (els.autoplay.checked && item.audios.length) playAudio(item.audios[state.voice.get(item.id) ?? 0].url);
  }

  function answerStudy(knew) {
    const item = study.items[study.index];
    clockStop();
    study.activeMs += study.cardMs;
    study.cardMs = 0;
    study.answered += 1;
    if (knew) study.knew += 1;
    else study.missed.push(item);
    study.index += 1;
    study.revealed = false;
    renderStudy();
    clockStart();
    els.studyView.focus();
  }

  function studyKey(e) {
    const done = studyDone();
    let handled = true;
    if (e.key === 'Escape') leaveStudy();
    // Space/Enter on a focused study button presses that button.
    else if (e.target.closest?.('#study-view button') && (e.key === ' ' || e.key === 'Enter')) handled = false;
    else if ((e.key === 'p' || e.key === 'P') && study.index < study.items.length) pauseStudy();
    else if ((e.key === 't' || e.key === 'T') && !done) toggleTimed();
    else if (done && (e.key === ' ' || e.key === 'Enter') && study.missed.length) startStudy([...study.missed]);
    else if (done && (e.key === 'r' || e.key === 'R') && study.all) startStudy(study.all);
    // Before the answer is shown, the answer keys (←/→, 1/2) also just show it; pressed again, they answer.
    else if (!done && !study.revealed && [' ', 'Enter', 'ArrowLeft', 'ArrowRight', '1', '2'].includes(e.key)) revealStudy();
    else if (!done && study.revealed && (e.key === '1' || e.key === 'ArrowLeft')) answerStudy(false);
    else if (!done && study.revealed && (e.key === '2' || e.key === 'ArrowRight')) answerStudy(true);
    else handled = false;
    if (handled) e.preventDefault();
  }

  // ---------- Loading ----------
  async function load() {
    const token = getToken();
    if (!token) {
      showLogin();
      return;
    }

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
    OLD_STORAGE_STATS.forEach(storageRemove);
    storageRemove(STORAGE_STUDY);
    renderResume();
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

  // The button only refreshes from WaniKani: every filter applies as soon as it changes.
  els.filtersForm.addEventListener('submit', (e) => {
    e.preventDefault();
    load();
  });

  const onFiltersChanged = () => {
    savePrefs();
    if (state.raw) applyFilters();
    else {
      renderChips(null);
      updateFiltersSummary();
    }
  };

  els.levelMin.addEventListener('change', () => {
    if (Number(els.levelMin.value) > Number(els.levelMax.value)) els.levelMax.value = els.levelMin.value;
    onFiltersChanged();
  });

  els.levelMax.addEventListener('change', () => {
    if (Number(els.levelMax.value) < Number(els.levelMin.value)) els.levelMin.value = els.levelMax.value;
    onFiltersChanged();
  });

  els.clearFilters.addEventListener('click', () => {
    state.filters = emptyFilters();
    onFiltersChanged();
  });

  els.autoplay.addEventListener('change', savePrefs);
  els.studyTimed.addEventListener('click', toggleTimed);

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
  els.reverse.addEventListener('click', () => {
    state.reversed = !state.reversed;
    updateSortLabel();
    savePrefs();
    if (!state.raw) return;
    if (els.sort.value === 'random') {
      // A random order is not drawn again: the current one is turned around.
      state.view.reverse();
      state.page = 0;
      renderList();
    } else {
      applyFilters();
    }
    window.scrollTo({ top: 0 });
  });

  els.sort.addEventListener('change', () => {
    // A new order starts in its natural direction.
    state.reversed = false;
    updateSortLabel();
    savePrefs();
    if (!state.raw) return;
    // Re-filtering starts from the WaniKani order, then applies the new one.
    applyFilters();
    window.scrollTo({ top: 0 });
  });
  els.toggleAll.addEventListener('click', () => {
    setAllRevealed(!(state.view.length && state.view.every((item) => state.revealed.has(item.id))));
  });
  els.density.addEventListener('click', () => {
    setCompact(!document.body.classList.contains('compact'));
    savePrefs();
  });
  els.study.addEventListener('click', () => startStudy(state.view));
  els.studyClose.addEventListener('click', leaveStudy);
  els.studyPause.addEventListener('click', pauseStudy);
  els.resumeContinue.addEventListener('click', resumePausedStudy);
  els.resumeDiscard.addEventListener('click', discardPausedStudy);

  // ---------- Keyboard ----------
  // Up/Down (or k/j) move between cards; Space/Enter on a card reveals it (handled on the card).
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!els.studyView.hidden) {
      studyKey(e);
      return;
    }
    if (e.target.closest?.('input, select, textarea, summary')) return;
    const down = e.key === 'ArrowDown' || e.key === 'j';
    const up = e.key === 'ArrowUp' || e.key === 'k';
    if (!down && !up) return;
    const cards = [...els.list.querySelectorAll('.card')];
    if (!cards.length) return;
    const index = cards.indexOf(document.activeElement?.closest?.('.card'));
    const next = index === -1 ? (down ? 0 : cards.length - 1) : index + (down ? 1 : -1);
    if (next < 0 || next >= cards.length) return;
    e.preventDefault();
    cards[next].focus({ preventScroll: true });
    cards[next].scrollIntoView({ block: 'nearest' });
  });

  // ---------- Startup ----------
  function init() {
    OLD_STORAGE_STATS.forEach(storageRemove);
    applyTheme(currentTheme());
    populateLevels();
    populateSorts();
    buildFilterGroups();
    restorePrefs();
    renderChips(null);
    updateFiltersSummary();
    renderResume();
    if (getToken()) {
      showApp();
      load();
    } else {
      showLogin();
    }
  }

  init();
})();
