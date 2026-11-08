(() => {
  'use strict';

  const API_BASE = 'https://api.wanikani.com/v2';
  const REVISION = '20170710';
  const LEVEL_MAX = 60;
  const PAGE_SIZE = 100;
  const HOUR = 60 * 60 * 1000;

  // Leech: at least LEECH_MIN_MISTAKES wrong answers, and at least LEECH_MIN_RATE of all answers wrong.
  const LEECH_MIN_MISTAKES = 3;
  const LEECH_MIN_RATE = 0.25;

  // Storage keys are unchanged so existing tokens and preferences keep working.
  const STORAGE_TOKEN = 'wk-quick-review.token';
  const STORAGE_PREFS = 'wk-quick-review.prefs';
  const STORAGE_THEME = 'wk-quick-review.theme';

  const TYPE_LABEL = { radical: 'Radical', kanji: 'Kanji', vocabulary: 'Vocabulary' };
  const TYPE_ORDER = { radical: 0, kanji: 1, vocabulary: 2 };
  const READING_LABEL = { onyomi: 'On’yomi', kunyomi: 'Kun’yomi', nanori: 'Nanori', reading: 'Reading' };
  const READING_ORDER = ['onyomi', 'kunyomi', 'nanori', 'reading'];
  const SRS_LABEL = { 1: 'Apprentice', 2: 'Apprentice', 3: 'Apprentice', 4: 'Apprentice', 5: 'Guru', 6: 'Guru', 7: 'Master', 8: 'Enlightened', 9: 'Burned' };

  const PROGRESS_VALUES = ['all', 'not-started', 'started', 'review', 'burned'];
  const MISTAKE_VALUES = ['any', '24h', '48h', '7d', 'leech', 'never'];
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

  // Current state: all loaded items, filtered view, current page, ids whose answer is revealed
  const state = { items: [], view: [], page: 0, revealed: new Set() };

  // ---------- Local storage (token, preferences, theme) ----------
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
    if (MISTAKE_VALUES.includes(prefs.mistakes)) els.mistakes.value = prefs.mistakes;
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

  // Mistake history per subject, from the reviews endpoint.
  function buildMistakeStats(reviews) {
    const stats = new Map();
    for (const r of reviews) {
      const d = r.data;
      let s = stats.get(d.subject_id);
      if (!s) {
        s = { reviews: 0, wrong: 0, lastMistakeAt: null };
        stats.set(d.subject_id, s);
      }
      s.reviews += 1;
      const wrong = (d.incorrect_meaning_answers || 0) + (d.incorrect_reading_answers || 0);
      if (wrong > 0) {
        s.wrong += wrong;
        const t = Date.parse(d.created_at);
        if (s.lastMistakeAt === null || t > s.lastMistakeAt) s.lastMistakeAt = t;
      }
    }
    return stats;
  }

  function toItem(subject, assignment, mistakes) {
    const d = subject.data;
    const type = subject.object;
    // A radical has one answer per review (meaning), kanji and vocabulary have two (meaning + reading).
    const answers = mistakes.reviews * (type === 'radical' ? 1 : 2);
    const leech = mistakes.wrong >= LEECH_MIN_MISTAKES
      && answers > 0 && mistakes.wrong / answers >= LEECH_MIN_RATE;
    return {
      id: subject.id,
      type,
      level: d.level,
      position: d.lesson_position ?? 0,
      glyph: d.characters ?? null,
      image: d.characters ? null : pickImage(d.character_images),
      meanings: normalizeMeanings(d.meanings),
      readings: type === 'radical' ? [] : normalizeReadings(d.readings),
      srsStage: assignment?.srs_stage ?? 0,
      availableAt: assignment?.available_at ?? null,
      reviews: mistakes.reviews,
      wrong: mistakes.wrong,
      lastMistakeAt: mistakes.lastMistakeAt,
      leech,
    };
  }

  function compareItems(a, b) {
    return a.level - b.level
      || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
      || a.position - b.position;
  }

  function buildItems(subjects, assignments, reviews) {
    const bySubject = new Map(assignments.map((a) => [a.data.subject_id, a.data]));
    const mistakes = buildMistakeStats(reviews);
    const none = { reviews: 0, wrong: 0, lastMistakeAt: null };
    return subjects
      .map((s) => toItem(s, bySubject.get(s.id), mistakes.get(s.id) ?? none))
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
    const within = (hours) => item.lastMistakeAt != null && item.lastMistakeAt >= now - hours * HOUR;
    switch (value) {
      case '24h': return within(24);
      case '48h': return within(48);
      case '7d': return within(24 * 7);
      case 'leech': return item.leech;
      case 'never': return item.reviews > 0 && item.wrong === 0;
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

  function buildAnswer(item) {
    const meanings = el('div', { class: 'meanings' }, ...joinSpans(item.meanings, ', '));
    const readingRows = item.readings.map((group) => el('div', { class: 'reading-row' },
      el('span', { class: 'label' }, group.label),
      el('span', { class: 'jp', lang: 'ja' }, ...joinSpans(group.items, '、'))));
    return [meanings, readingRows.length ? el('div', { class: 'readings' }, ...readingRows) : null];
  }

  function buildPlaceholder() {
    return el('div', { class: 'placeholder' }, 'Click to show meaning and reading');
  }

  function buildCard(item) {
    const answer = el('div', { class: 'answer' });
    const srs = item.srsStage >= 1 ? SRS_LABEL[item.srsStage] : null;
    const card = el('div', {
      class: `card type-${item.type}`,
      role: 'button',
      tabindex: '0',
      'aria-expanded': 'false',
    },
      el('div', { class: 'glyph-col' },
        buildGlyph(item),
        el('div', { class: 'tags' },
          el('span', {}, TYPE_LABEL[item.type]),
          el('span', {}, `Lvl ${item.level}`),
          srs ? el('span', {}, srs) : null,
          item.leech ? el('span', { class: 'leech' }, 'Leech') : null,
          item.wrong > 0 ? el('span', {}, `${item.wrong} miss${item.wrong > 1 ? 'es' : ''}`) : null)),
      answer);

    const setRevealed = (on) => {
      if (on) state.revealed.add(item.id);
      else state.revealed.delete(item.id);
      card.classList.toggle('revealed', on);
      card.setAttribute('aria-expanded', String(on));
      answer.replaceChildren(...(on ? buildAnswer(item) : [buildPlaceholder()]));
    };

    const toggle = () => setRevealed(!state.revealed.has(item.id));
    card.addEventListener('click', toggle);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
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
    setMessage('Loading subjects, assignments and reviews from WaniKani…');
    try {
      const query = new URLSearchParams({
        types: types.join(','),
        levels: levelRange(min, max).join(','),
        hidden: 'false',
      });
      const [subjects, assignments, reviews] = await Promise.all([
        fetchAll(`${API_BASE}/subjects?${query}`, token),
        fetchAll(`${API_BASE}/assignments`, token),
        fetchAll(`${API_BASE}/reviews`, token),
      ]);
      state.items = buildItems(subjects, assignments, reviews);
      applyFilters();
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
    storageRemove(STORAGE_TOKEN);
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
      if (state.items.length) applyFilters();
    });
  }

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
