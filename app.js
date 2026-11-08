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
    els.filtersSummary.textContent = `${types} · ${levels} · ${progress}`;
  }

  function updateRevealedCount() {
    const revealed = state.view.reduce((n, item) => n + (state.revealed.has(item.id) ? 1 : 0), 0);
    els.revealedCount.textContent = state.view.length ? `${revealed} / ${state.view.length} revealed` : '';
  }

  // Quick buttons for the mistake filter, each with the number of items it would show.
  function renderQuickFilters(itemsForProgress, now) {
    const current = els.mistakes.value;
    els.quickFilters.replaceChildren(...MISTAKE_VALUES.map((value) => {
      const count = itemsForProgress.reduce((n, item) => n + (matchesMistakes(item, value, now) ? 1 : 0), 0);
      const button = el('button', {
        type: 'button',
        class: value === current ? 'quick active' : 'quick',
        'aria-pressed': String(value === current),
      }, QUICK_LABEL[value], ' ', el('span', { class: 'quick-count' }, count));
      button.addEventListener('click', () => {
        els.mistakes.value = value;
        els.mistakes.dispatchEvent(new Event('change'));
      });
      return button;
    }));
  }

  function applyFilters() {
    const now = Date.now();
    const progress = els.progress.value;
    const mistakes = els.mistakes.value;
    const forProgress = state.items.filter((item) => matchesProgress(item, progress, now));
    state.view = forProgress.filter((item) => matchesMistakes(item, mistakes, now));
    state.page = 0;
    renderQuickFilters(forProgress, now);
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
    setMessage('Loading from WaniKani…');
    try {
      const levels = levelRange(min, max).join(',');
      const [subjects, assignments, cache] = await Promise.all([
        fetchAll(`${API_BASE}/subjects?${new URLSearchParams({ types: types.join(','), levels, hidden: 'false' })}`, token),
        fetchAll(`${API_BASE}/assignments?${new URLSearchParams({ subject_types: types.join(','), levels })}`, token),
        syncStats(token),
      ]);
      state.raw = { subjects, assignments };
      state.stats = buildStatsMap(cache);
      state.items = buildItems();
      applyFilters();
      // Collapse the filters once the list is there, so the cards start near the top of the screen.
      els.filtersPanel.open = false;
      setMessage(state.items.length ? '' : 'No items for these filters.');
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
    storageRemove(OLD_STORAGE_STATS);
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
