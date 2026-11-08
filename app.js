(() => {
  'use strict';

  const API_BASE = 'https://api.wanikani.com/v2';
  const REVISION = '20170710';
  const LEVEL_MAX = 60;
  const STORAGE_TOKEN = 'wk-quick-review.token';
  const STORAGE_PREFS = 'wk-quick-review.prefs';

  const TYPE_LABEL = { radical: 'Radical', kanji: 'Kanji', vocabulary: 'Vocabulaire' };
  const TYPE_ORDER = { radical: 0, kanji: 1, vocabulary: 2 };
  const READING_LABEL = { onyomi: 'On’yomi', kunyomi: 'Kun’yomi', nanori: 'Nanori', reading: 'Lecture' };
  const READING_ORDER = ['onyomi', 'kunyomi', 'nanori', 'reading'];
  const SRS_LABEL = { 1: 'Apprenti', 2: 'Apprenti', 3: 'Apprenti', 4: 'Apprenti', 5: 'Gourou', 6: 'Gourou', 7: 'Maître', 8: 'Éveillé', 9: 'Brûlé' };

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
    status: $('#status'),
    results: $('#results'),
    count: $('#count'),
    list: $('#list'),
    shuffle: $('#shuffle'),
    showAll: $('#show-all'),
    hideAll: $('#hide-all'),
    message: $('#message'),
  };

  // État courant : éléments chargés, éléments affichés, ids dont le sens est révélé
  const state = { items: [], view: [], revealed: new Set(), cards: new Map() };

  // ---------- Stockage local (préférences et jeton) ----------
  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* stockage indisponible */ }
  }
  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch { /* stockage indisponible */ }
  }
  const getToken = () => storageGet(STORAGE_TOKEN);

  function loadPrefs() {
    try {
      return JSON.parse(storageGet(STORAGE_PREFS) || '{}');
    } catch { return {}; }
  }
  function savePrefs() {
    const prefs = {
      types: selectedTypes(),
      levelMin: Number(els.levelMin.value),
      levelMax: Number(els.levelMax.value),
      status: els.status.value,
    };
    storageSet(STORAGE_PREFS, JSON.stringify(prefs));
  }

  // ---------- Utilitaires DOM ----------
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

  // ---------- Filtres ----------
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
    if (['all', 'started', 'review'].includes(prefs.status)) els.status.value = prefs.status;
  }

  // ---------- Appels API WaniKani ----------
  async function fetchAll(url, token) {
    const items = [];
    let next = url;
    while (next) {
      const res = await fetch(next, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Wanikani-Revision': REVISION,
        },
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error('Jeton refusé par WaniKani (401/403). Vérifiez qu\'il est valide et qu\'il a la permission de lecture.');
      }
      if (res.status === 429) {
        throw new Error('Limite de requêtes WaniKani atteinte. Réessayez dans une minute.');
      }
      if (!res.ok) {
        throw new Error(`Erreur WaniKani (HTTP ${res.status}).`);
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

  // ---------- Normalisation des données ----------
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
    const keys = [...groups.keys()].sort((a, b) => {
      const ia = READING_ORDER.indexOf(a) === -1 ? 99 : READING_ORDER.indexOf(a);
      const ib = READING_ORDER.indexOf(b) === -1 ? 99 : READING_ORDER.indexOf(b);
      return ia - ib;
    });
    return keys.map((k) => ({
      label: READING_LABEL[k] ?? k,
      items: [...groups.get(k)].sort((a, b) => Number(b.primary) - Number(a.primary)),
    }));
  }

  function toItem(subject, assignment) {
    const d = subject.data;
    const type = subject.object;
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
    };
  }

  function compareItems(a, b) {
    return a.level - b.level
      || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
      || a.position - b.position;
  }

  function buildItems(subjects, assignments) {
    const bySubject = new Map(assignments.map((a) => [a.data.subject_id, a.data]));
    return subjects.map((s) => toItem(s, bySubject.get(s.id))).sort(compareItems);
  }

  function matchesStatus(item, status, now) {
    switch (status) {
      case 'started':
        return item.srsStage >= 1;
      case 'review':
        return item.srsStage >= 1 && item.srsStage < 9
          && item.availableAt != null && Date.parse(item.availableAt) <= now;
      default:
        return true;
    }
  }

  // ---------- Rendu d'une carte ----------
  function buildGlyph(item) {
    if (item.image) {
      return el('img', { src: item.image, alt: TYPE_LABEL[item.type], loading: 'lazy' });
    }
    const text = item.glyph ?? '';
    return el('span', { class: text.length > 2 ? 'glyph long' : 'glyph', lang: 'ja' }, text);
  }

  function joinSpans(entries, className, separator) {
    const parts = [];
    entries.forEach((entry, i) => {
      if (i > 0) parts.push(separator);
      parts.push(el('span', { class: entry.primary ? className.primary : className.secondary }, entry.text));
    });
    return parts;
  }

  function buildAnswer(item) {
    const meanings = el('div', { class: 'meanings' },
      ...joinSpans(item.meanings, { primary: 'primary', secondary: 'secondary' }, ', '));

    const readingRows = item.readings.map((group) => el('div', { class: 'reading-row' },
      el('span', { class: 'label' }, group.label),
      el('span', { class: 'jp', lang: 'ja' },
        ...joinSpans(group.items, { primary: 'primary', secondary: 'secondary' }, '、'))));

    return [meanings, readingRows.length ? el('div', { class: 'readings' }, ...readingRows) : null];
  }

  function buildPlaceholder() {
    return el('div', { class: 'placeholder' }, 'Cliquer pour afficher le sens et la lecture');
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
          el('span', {}, `Niv. ${item.level}`),
          srs ? el('span', {}, srs) : null)),
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
    state.cards.set(item.id, setRevealed);

    return el('li', {}, card);
  }

  function renderList() {
    state.cards.clear();
    els.list.replaceChildren(...state.view.map(buildCard));
    const total = state.items.length;
    const shown = state.view.length;
    els.count.textContent = shown === total
      ? `${shown} élément${shown > 1 ? 's' : ''}`
      : `${shown} élément${shown > 1 ? 's' : ''} sur ${total}`;
    els.results.hidden = false;
  }

  function applyStatus() {
    const now = Date.now();
    const status = els.status.value;
    state.view = state.items.filter((item) => matchesStatus(item, status, now));
    renderList();
  }

  function setAllRevealed(on) {
    for (const item of state.view) {
      if (on) state.revealed.add(item.id);
      else state.revealed.delete(item.id);
    }
    for (const item of state.view) {
      state.cards.get(item.id)?.(on);
    }
  }

  function shuffleView() {
    const arr = state.view;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    renderList();
  }

  // ---------- Chargement ----------
  async function load() {
    const types = selectedTypes();
    if (types.length === 0) {
      setMessage('Sélectionnez au moins un type.', true);
      return;
    }
    const min = Number(els.levelMin.value);
    const max = Number(els.levelMax.value);
    if (min > max) {
      setMessage('Le niveau minimum doit être inférieur ou égal au niveau maximum.', true);
      return;
    }

    const token = getToken();
    if (!token) {
      showLogin();
      return;
    }

    savePrefs();
    setBusy(true);
    setMessage('Chargement depuis WaniKani…');
    try {
      const query = new URLSearchParams({
        types: types.join(','),
        levels: levelRange(min, max).join(','),
        hidden: 'false',
      });
      const [subjects, assignments] = await Promise.all([
        fetchAll(`${API_BASE}/subjects?${query}`, token),
        fetchAll(`${API_BASE}/assignments`, token),
      ]);
      state.items = buildItems(subjects, assignments);
      applyStatus();
      setMessage(state.items.length ? '' : 'Aucun élément pour ces filtres.');
    } catch (err) {
      setMessage(err.message || 'Erreur inconnue.', true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- Affichage des écrans ----------
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

  // ---------- Événements ----------
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

  els.status.addEventListener('change', () => {
    savePrefs();
    if (state.items.length) applyStatus();
  });

  els.shuffle.addEventListener('click', shuffleView);
  els.showAll.addEventListener('click', () => setAllRevealed(true));
  els.hideAll.addEventListener('click', () => setAllRevealed(false));

  // ---------- Démarrage ----------
  function init() {
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
