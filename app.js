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
  const LEECH_MAX_PERCENT = 75;

  // Storage keys are unchanged so existing tokens and preferences keep working.
  const STORAGE_TOKEN = 'wk-quick-review.token';
  const STORAGE_PREFS = 'wk-quick-review.prefs';
  const STORAGE_THEME = 'wk-quick-review.theme';
  const STORAGE_STATS = 'wk-quick-review.stats';
  // Miss journal written hourly by GitHub Actions (scripts/track_misses.py) to the default branch.
  const JOURNAL_URL = 'https://raw.githubusercontent.com/maxme/wanikani-quick-review/main/data/misses.json';

  const TYPE_LABEL = { radical: 'Radical', kanji: 'Kanji', vocabulary: 'Vocabulary' };
  const TYPE_ORDER = { radical: 0, kanji: 1, vocabulary: 2 };
  // The plain "reading" group of vocabulary gets no row label: the card already says "Reading".
  const READING_LABEL = { onyomi: 'On’yomi', kunyomi: 'Kun’yomi', nanori: 'Nanori', reading: '' };
  const READING_ORDER = ['onyomi', 'kunyomi', 'nanori', 'reading'];
  const SRS_LABEL = { 1: 'Apprentice', 2: 'Apprentice', 3: 'Apprentice', 4: 'Apprentice', 5: 'Guru', 6: 'Guru', 7: 'Master', 8: 'Enlightened', 9: 'Burned' };

  const PROGRESS_VALUES = ['all', 'not-started', 'started', 'review', 'burned'];
  const MISTAKE_VALUES = ['any', 'missed-24h', 'missed-48h', 'missed-7d', 'leech', 'never'];
  // Values used by earlier versions, mapped to the current ones when preferences are restored.
  const OLD_MISTAKE_VALUES = { 'since-last-visit': 'any' };
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
  };

  // raw: subjects and assignments as returned by the API (null until loaded)
  // stats: Map subject id -> review history built from the local statistics cache
  // voice: chosen pronunciation voice per vocabulary id
  const state = { raw: null, stats: new Map(), journal: new Map(), items: [], view: [], page: 0, revealed: new Set(), voice: new Map() };

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

  function levelRange(min, max) {
    const levels = [];
    for (let n = min; n <= max; n++) levels.push(n);
    return levels;
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

  // ---------- Review history ----------
  // GET /reviews is deprecated and returns nothing, and the API keeps no timestamp per answer.
  // review_statistics holds the wrong-answer totals per subject. The app keeps a local copy and syncs it
  // incrementally with updated_after on every load. A miss is detected when a subject's wrong total grows
  // between two loads, and it is recorded with the time of that load. So "missed since previous visit"
  // is exact for the period between two visits, but it cannot see misses made before the first visit.
  // Cache entry per subject: [wrong, answered, percentCorrect, updatedAt(ms), lastMissAt(ms)]
  const NO_HISTORY = { wrong: 0, answered: 0, percentCorrect: null, updatedAt: 0, lastMissAt: 0 };

  function loadStatsCache() {
    try {
      const cache = JSON.parse(storageGet(STORAGE_STATS) || 'null');
      if (cache && typeof cache.syncedAt === 'string' && cache.s) return cache;
    } catch { /* corrupt cache: start again */ }
    return { syncedAt: null, visitedAt: null, s: {} };
  }

  function saveStatsCache(cache) {
    storageSet(STORAGE_STATS, JSON.stringify(cache));
  }

  function compactStat(raw) {
    const d = raw.data;
    return [
      d.meaning_incorrect + d.reading_incorrect,
      d.meaning_correct + d.meaning_incorrect + d.reading_correct + d.reading_incorrect,
      d.percentage_correct ?? null,
      Date.parse(raw.data_updated_at) || 0,
    ];
  }

  // Syncs review_statistics (only changed records after the first sync) and returns the updated cache.
  async function syncStats(token) {
    const cache = loadStatsCache();
    const now = Date.now();
    // Overlap of a few minutes, so no review made during the sync is lost. Re-read records do not double count.
    const nextSync = new Date(now - 5 * 60 * 1000).toISOString();
    const query = cache.syncedAt ? `?${new URLSearchParams({ updated_after: cache.syncedAt })}` : '';
    const changed = await fetchAll(`${API_BASE}/review_statistics${query}`, token);

    for (const raw of changed) {
      const id = raw.data.subject_id;
      const next = compactStat(raw);
      const prev = cache.s[id];
      // Baseline: the wrong total seen last time. Unknown on the very first sync (no misses can be detected then),
      // and 0 for a subject that first appeared since the previous sync.
      const baseline = prev ? prev[0] : (cache.syncedAt ? 0 : null);
      let lastMissAt = prev ? prev[4] ?? 0 : 0;
      if (baseline !== null && next[0] > baseline) lastMissAt = now;
      cache.s[id] = [...next, lastMissAt];
    }

    cache.syncedAt = nextSync;
    cache.visitedAt = now;
    saveStatsCache(cache);
    return cache;
  }

  function buildStatsMap(cache) {
    const map = new Map();
    for (const [id, [wrong, answered, percentCorrect, updatedAt, lastMissAt]] of Object.entries(cache.s)) {
      map.set(Number(id), { wrong, answered, percentCorrect, updatedAt, lastMissAt: lastMissAt || 0 });
    }
    return map;
  }

  function isLeech(h) {
    return h.wrong >= LEECH_MIN_MISTAKES && h.percentCorrect !== null && h.percentCorrect < LEECH_MAX_PERCENT;
  }

  function toItem(subject, assignment, history) {
    const d = subject.data;
    const type = subject.object;
    const h = history ?? NO_HISTORY;
    return {
      id: subject.id,
      type,
      level: d.level,
      position: d.lesson_position ?? 0,
      glyph: d.characters ?? null,
      image: d.characters ? null : pickImage(d.character_images),
      meanings: normalizeMeanings(d.meanings),
      readings: type === 'radical' ? [] : normalizeReadings(d.readings),
      audios: type === 'vocabulary' ? normalizeAudios(d.pronunciation_audios) : [],
      srsStage: assignment?.srs_stage ?? 0,
      availableAt: assignment?.available_at ?? null,
      history: h,
      leech: isLeech(h),
    };
  }

  function compareItems(a, b) {
    return a.level - b.level
      || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
      || a.position - b.position;
  }

  function buildItems() {
    const { subjects, assignments } = state.raw;
    const bySubject = new Map(assignments.map((a) => [a.data.subject_id, a.data]));
    return subjects
      .map((s) => toItem(s, bySubject.get(s.id), state.stats.get(s.id) ?? null))
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

  // Latest miss time per subject, from the journal. Returns null when the journal could not be read.
  async function fetchJournal() {
    try {
      const res = await fetch(JOURNAL_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const entries = await res.json();
      const latest = new Map();
      for (const { subject_id: id, detected_at: at } of entries) {
        const t = Date.parse(at);
        if (t > (latest.get(id) ?? 0)) latest.set(id, t);
      }
      return latest;
    } catch {
      return null;
    }
  }

  function matchesMistakes(item, value, now) {
    const h = item.history;
    const missedWithin = (hours) => (state.journal.get(item.id) ?? 0) >= now - hours * HOUR;
    switch (value) {
      case 'missed-24h': return missedWithin(24);
      case 'missed-48h': return missedWithin(48);
      case 'missed-7d': return missedWithin(24 * 7);
      case 'leech': return item.leech;
      case 'never': return h.answered > 0 && h.wrong === 0;
      default: return true;
    }
  }

  // ---------- Card rendering ----------
  function buildGlyph(item) {
    if (item.image) {
      return el('img', { src: item.image, alt: TYPE_LABEL[item.type], loading: 'lazy' });
    }
    const text = item.glyph ?? '';
    return el('span', { class: text.length > 2 ? 'glyph long' : 'glyph', lang: 'ja' }, text);
  }

  function joinSpans(entries, separator) {
    const parts = [];
    entries.forEach((entry, i) => {
      if (i > 0) parts.push(separator);
      parts.push(el('span', { class: entry.primary ? 'primary' : 'secondary' }, entry.text));
    });
    return parts;
  }

  function block(label, content) {
    return el('div', { class: 'block' }, el('div', { class: 'block-label' }, label), content);
  }

  function buildAudioRow(item, voiceIndex, handlers) {
    const audio = item.audios[voiceIndex];
    const play = el('button', {
      type: 'button',
      class: 'audio-btn play-btn',
      'aria-label': `Play pronunciation (${audio.voice})`,
    }, '▶ Play');
    play.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onPlay();
    });

    const children = [play];
    if (item.audios.length > 1) {
      const other = el('button', { type: 'button', class: 'audio-btn', title: 'Hear another voice' }, '⇄ Other voice');
      other.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.onSwitch();
      });
      children.push(other);
    }
    children.push(el('span', { class: 'voice' }, `Voice: ${audio.voice}`));
    return el('div', { class: 'audio-row' }, ...children);
  }

  function buildAnswer(item, voiceIndex, handlers) {
    const nodes = [block('Meaning', el('div', { class: 'meanings' }, ...joinSpans(item.meanings, ', ')))];

    if (item.readings.length) {
      const rows = item.readings.map((group) => el('div', { class: 'reading-row' },
        group.label ? el('span', { class: 'label' }, group.label) : null,
        el('span', { class: 'jp', lang: 'ja' }, ...joinSpans(group.items, '、'))));
      nodes.push(block('Reading', el('div', { class: 'readings' }, ...rows)));
    }

    if (item.audios.length) {
      nodes.push(buildAudioRow(item, voiceIndex, handlers));
    }
    return nodes;
  }

  function buildPlaceholder() {
    return el('div', { class: 'placeholder' }, 'Tap to reveal meaning and reading');
  }

  function buildCard(item) {
    const answer = el('div', { class: 'answer' });
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
            el('span', { class: 'tag tag-type' }, TYPE_LABEL[item.type]),
            el('span', { class: 'tag' }, `Lvl ${item.level}`),
            srs ? el('span', { class: 'tag' }, srs) : null,
            item.leech ? el('span', { class: 'tag leech' }, 'Leech') : null,
            wrong > 0 ? el('span', { class: 'tag' }, `${wrong} miss${wrong > 1 ? 'es' : ''}`) : null),
          el('span', { class: 'chevron', 'aria-hidden': 'true' }, '›')),
        answer));

    const renderAnswer = () => {
      const voiceIndex = state.voice.get(item.id) ?? 0;
      answer.replaceChildren(...buildAnswer(item, voiceIndex, {
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
      if (on) {
        renderAnswer();
        if (play && els.autoplay.checked && item.audios.length) {
          playAudio(item.audios[state.voice.get(item.id) ?? 0].url);
        }
      } else {
        answer.replaceChildren(buildPlaceholder());
      }
    };

    card.addEventListener('click', () => setRevealed(!state.revealed.has(item.id), { play: true }));
    card.addEventListener('keydown', (e) => {
      // Ignore keys pressed on the audio buttons inside the card.
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setRevealed(!state.revealed.has(item.id), { play: true });
      }
    });

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
    els.count.textContent = total
      ? `Showing ${start + 1}–${start + slice.length} of ${total} items`
      : 'No items match these filters';
    els.pager.hidden = pages <= 1;
    els.pageLabel.textContent = `Page ${state.page + 1} of ${pages}`;
    els.prevPage.disabled = state.page === 0;
    els.nextPage.disabled = state.page >= pages - 1;
    els.results.hidden = false;
  }

  function applyFilters() {
    const now = Date.now();
    const progress = els.progress.value;
    const mistakes = els.mistakes.value;
    state.view = state.items.filter((item) =>
      matchesProgress(item, progress, now) && matchesMistakes(item, mistakes, now));
    state.page = 0;
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
    setMessage('Loading from WaniKani…');
    try {
      const levels = levelRange(min, max).join(',');
      const [subjects, assignments, cache] = await Promise.all([
        fetchAll(`${API_BASE}/subjects?${new URLSearchParams({ types: types.join(','), levels, hidden: 'false' })}`, token),
        fetchAll(`${API_BASE}/assignments?${new URLSearchParams({ subject_types: types.join(','), levels })}`, token),
        syncStats(token),
      ]);
      const journal = await fetchJournal();
      state.journal = journal ?? new Map();
      state.raw = { subjects, assignments };
      state.stats = buildStatsMap(cache);
      state.items = buildItems();
      applyFilters();
      if (journal === null) {
        setMessage('The miss journal could not be loaded: "missed" filters are empty.', true);
      } else {
        setMessage(state.items.length ? '' : 'No items for these filters.');
      }
    } catch (err) {
      setMessage(err.message || 'Unknown error.', true);
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

  for (const select of [els.progress, els.mistakes]) {
    select.addEventListener('change', () => {
      savePrefs();
      if (state.raw) applyFilters();
    });
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
    applyTheme(currentTheme());
    populateLevels();
    restorePrefs();
    if (getToken()) {
      showApp();
      load();
    } else {
      showLogin();
    }
  }

  init();
})();
