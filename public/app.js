(() => {
  // ---------- debug log (DEBUG: remove when done) ----------
  // Entries are kept in sessionStorage so they survive a page reload; the previous
  // page's log is printed on load together with how this page was loaded.
  const DEBUG_KEY = 'callup-debug-log';
  const t0 = performance.now();
  function dbg(...args) {
    const line = `[callup +${Math.round(performance.now() - t0)}ms] ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    console.log(line);
    try {
      const log = JSON.parse(sessionStorage.getItem(DEBUG_KEY) || '[]');
      log.push(new Date().toISOString().slice(11, 23) + ' ' + line);
      sessionStorage.setItem(DEBUG_KEY, JSON.stringify(log.slice(-200)));
    } catch {}
  }
  try {
    const prev = JSON.parse(sessionStorage.getItem(DEBUG_KEY) || '[]');
    if (prev.length) {
      console.groupCollapsed(`[callup] log from the PREVIOUS page load (${prev.length} lines)`);
      prev.forEach((l) => console.log(l));
      console.groupEnd();
    }
    sessionStorage.setItem(DEBUG_KEY, '[]');
  } catch {}
  const nav = performance.getEntriesByType('navigation')[0];
  dbg('page loaded', { navigationType: nav && nav.type, url: location.href });
  window.addEventListener('beforeunload', () => dbg('beforeunload — the page is reloading/navigating away', new Error().stack));
  window.addEventListener('pagehide', (e) => dbg('pagehide', { persisted: e.persisted }));
  window.addEventListener('error', (e) => dbg('window error', e.message, e.filename + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => dbg('unhandled rejection', String(e.reason)));
  document.addEventListener('submit', (e) => dbg('submit event', { form: e.target.id, defaultPrevented: e.defaultPrevented }), true);
  // Live Server injects a WebSocket that reloads the page when any watched file changes.
  const NativeWS = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new NativeWS(...args);
    dbg('WebSocket opened', args[0]);
    ws.addEventListener('message', (m) => dbg('WebSocket message (Live Server sends "reload" when a file in its folder changes)', String(m.data)));
    return ws;
  };
  window.WebSocket.prototype = NativeWS.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.callupDebugLog = () => JSON.parse(sessionStorage.getItem(DEBUG_KEY) || '[]').join('\n');

  const $ = (id) => document.getElementById(id);
  const state = { cities: [], streets: [], city: null, street: null, fiber: null };

  // ---------- kma-crm API ----------
  const CONFIG = window.CALLUP_CONFIG || {};
  const API_URL = String(CONFIG.apiUrl || '').replace(/\/+$/, '');

  async function kma(method, endpoint, body) {
    dbg('→ API', method, endpoint, body || '');
    const started = performance.now();
    const res = await fetch(API_URL + endpoint, {
      method,
      headers: {
        Authorization: 'Bearer ' + CONFIG.apiToken,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    dbg('← API', method, endpoint, res.status, `${Math.round(performance.now() - started)}ms`, endpoint === '/streets' || endpoint === '/cities' ? '(list)' : data);
    return { ok: res.ok, data };
  }

  // /streets returns every street in the country: fetch once, group by city.
  let streetsByCityPromise = null;
  function streetsByCity() {
    if (!streetsByCityPromise) {
      streetsByCityPromise = kma('GET', '/streets').then(({ ok, data }) => {
        if (!ok) throw new Error('streets');
        const map = new Map();
        for (const st of data.streets || []) {
          if (!map.has(st.cityId)) map.set(st.cityId, []);
          map.get(st.cityId).push({ streetId: st.streetId, name: st.name });
        }
        for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'he'));
        return map;
      }).catch((err) => { streetsByCityPromise = null; throw err; });
    }
    return streetsByCityPromise;
  }

  const FIBER_TECH = ['GPON', 'XGSPON', 'AE'];

  // target: { address } or { coordinates: { itmX, itmY } }
  async function checkProvider(provider, target) {
    try {
      const { ok, data } = await kma('POST', '/check', { provider, ...target });
      if (!ok || !data.result) return null;
      if (provider === 'bezeq') return !!data.gpon;
      const tech = String(data.technology || '').toUpperCase().trim();
      return FIBER_TECH.includes(tech) || tech.includes('PON');
    } catch {
      return null;
    }
  }

  // Checks Bezeq and IBC in parallel. Resolves to { fiber, provider }: provider is the one the answer is about.
  function checkFiber({ cityId, streetId, houseNumber, apartment }) {
    const address = { cityId, streetId, houseNumber };
    return firstFiber({
      bezeq: checkProvider('bezeq', { address }),
      // IBC requires an apartment; a private house has none, so "0" stands for "no apartment".
      ibc: checkProvider('ibc', { address: { ...address, apartment: apartment || '0' } }),
    });
  }

  function checkFiberByCoordinates(coordinates) {
    return firstFiber({
      bezeq: checkProvider('bezeq', { coordinates }),
      ibc: checkProvider('ibc', { coordinates }),
    });
  }

  // The first provider with fiber decides right away; "no fiber" needs both answers. fiber: null = both checks failed.
  // checks: { bezeq, ibc } promises of true / false / null that never reject (see checkProvider).
  function firstFiber(checks) {
    const results = {};
    return new Promise((resolve) => {
      for (const provider of ['bezeq', 'ibc']) {
        checks[provider].then((has) => {
          results[provider] = has;
          dbg('check result', provider, has);
          if (has === true) return resolve({ fiber: true, provider });
          if (!('bezeq' in results && 'ibc' in results)) return;
          const { bezeq, ibc } = results;
          resolve({ fiber: bezeq === null && ibc === null ? null : false, provider: bezeq === null && ibc !== null ? 'ibc' : 'bezeq' });
        });
      }
    });
  }

  // ---------- location ----------
  // WGS84 -> ITM, as in https://github.com/zvizvi/ITM-to-WGS84. The API accepts whole meters only.
  function WGS84toITM(lat, long) {
    const proj4 = window.proj4;
    proj4.defs('EPSG:2039', '+proj=tmerc +lat_0=31.73439361111111 +lon_0=35.20451694444445 +k=1.0000067 +x_0=219529.584 +y_0=626907.39 +ellps=GRS80 +towgs84=-48,55,52,0,0,0,0 +units=m +no_defs');
    proj4.defs('EPSG:4326', '+title=WGS 84 (long/lat) +proj=longlat +ellps=WGS84 +datum=WGS84 +units=degrees');
    const [x, y] = proj4(proj4('EPSG:4326'), proj4('EPSG:2039'), [long, lat]);
    return { itmX: Math.round(x), itmY: Math.round(y) };
  }

  const MAX_ACCURACY_METERS = 500; // a wider fix (IP-based / "approximate location") cannot identify a building

  const POSITION_REUSE_MS = 5 * 60 * 1000;
  const POSITION_WAIT_MS = 15000;
  const POSITION_KEY = 'callup-last-position'; // sessionStorage: survives a reload of this tab only

  function savePosition(coords) {
    try {
      sessionStorage.setItem(POSITION_KEY, JSON.stringify({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy, at: Date.now() }));
    } catch {}
  }
  function savedPosition() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(POSITION_KEY) || 'null');
      return saved && Date.now() - saved.at <= POSITION_REUSE_MS ? { coords: saved } : null;
    } catch {
      return null;
    }
  }

  // The OS often answers "position unavailable" for a moment (macOS does it when asked again shortly
  // after a fix), and getCurrentPosition gives up on that first error. A watch keeps listening, so we
  // wait for a fix until the deadline, and only then fall back to the last fix this tab got.
  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('הדפדפן לא תומך באיתור מיקום. הזינו כתובת במקום.'));
      let best = null;
      const finish = (settle, value) => {
        navigator.geolocation.clearWatch(watchId);
        clearTimeout(timer);
        settle(value);
      };
      const giveUp = () => {
        if (best) return finish(resolve, best); // a fix arrived, just not an accurate one
        const saved = savedPosition();
        if (saved) { dbg('geolocation fallback: last fix from this tab'); return finish(resolve, saved); }
        finish(reject, new Error('לא הצלחנו לאתר את המיקום שלכם. נסו שוב או הזינו כתובת.'));
      };
      const timer = setTimeout(giveUp, POSITION_WAIT_MS);
      const watchId = navigator.geolocation.watchPosition((position) => {
        if (!best || position.coords.accuracy < best.coords.accuracy) best = position;
        if (position.coords.accuracy > MAX_ACCURACY_METERS) return; // keep waiting for a better fix
        savePosition(position.coords);
        finish(resolve, position);
      }, (err) => {
        dbg('geolocation error', err.code, err.message);
        if (err.code === 1) finish(reject, new Error('אין הרשאה למיקום. אשרו גישה למיקום בדפדפן, או הזינו כתובת.'));
        else if (savedPosition()) giveUp(); // no need to keep the user waiting when we have a recent fix
      }, { enableHighAccuracy: true, maximumAge: 0 });
    });
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const ADDRESS_WAIT_MS = 2000; // how long a ready answer waits for its address

  // Display only: the check itself runs on the coordinates.
  async function addressText(provider, coordinates) {
    try {
      const { ok, data } = await kma('POST', '/coordinates-to-address', { provider, coordinates });
      if (!ok || !data.result) return '';
      const a = data.address;
      const street = [a.streetName, `${a.houseNumber || ''}${a.letter || ''}`].map((s) => (s || '').trim()).filter(Boolean).join(' ');
      return [street, (a.cityName || '').trim()].filter(Boolean).join(', ');
    } catch {
      return '';
    }
  }

  // Looks the address up at both providers. Nothing here blocks the check:
  // onFirst gets the first address that comes back ('' when neither provider found one), and
  // forProvider() picks the address to show with the answer.
  function lookupAddresses(coordinates, onFirst) {
    const found = {};
    let reported = false;
    const lookup = (provider) => addressText(provider, coordinates).then((text) => {
      found[provider] = text;
      if (reported || (!text && !('bezeq' in found && 'ibc' in found))) return;
      reported = true;
      onFirst(text);
    });
    const pending = { bezeq: lookup('bezeq'), ibc: lookup('ibc') };
    return {
      // Bezeq and IBC may resolve a point to neighbouring buildings, so prefer the answering provider's
      // address; when it is slow or missing, use the other one rather than hold the answer back.
      async forProvider(provider) {
        await Promise.race([pending[provider], wait(ADDRESS_WAIT_MS)]);
        return found[provider] || found[provider === 'bezeq' ? 'ibc' : 'bezeq'] || '';
      },
    };
  }

  // ---------- combobox (dropdown on desktop, bottom drawer on mobile) ----------
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const norm = (s) => s.replace(/["'׳״`-]/g, '').replace(/\s+/g, ' ').trim();
  const mobileQuery = window.matchMedia('(max-width: 640px)');
  const isMobile = () => mobileQuery.matches;

  function filterItems(items, query, limit) {
    const q = norm(query);
    if (!q) return items.slice(0, limit);
    const starts = [];
    const contains = [];
    for (const it of items) {
      const n = norm(it.name);
      if (n.startsWith(q)) starts.push(it);
      else if (n.includes(q)) contains.push(it);
      if (starts.length >= limit) break;
    }
    return starts.concat(contains).slice(0, limit);
  }
  function highlight(name, q) {
    const safe = escapeHtml(name);
    if (!q) return safe;
    const idx = name.indexOf(q);
    if (idx < 0) return safe;
    return escapeHtml(name.slice(0, idx)) + '<mark>' + escapeHtml(name.slice(idx, idx + q.length)) + '</mark>' + escapeHtml(name.slice(idx + q.length));
  }

  // One shared bottom drawer, reused by the city and street fields on mobile.
  const sheet = (() => {
    const root = $('sheet');
    const panel = root.querySelector('.sheet__panel');
    const title = $('sheet-title');
    const search = $('sheet-search');
    const list = $('sheet-list');
    let current = null; // { getItems, onPick, emptyText, selected }
    let matches = [];

    function render() {
      const q = search.value.trim();
      const items = current.getItems();
      matches = filterItems(items, q, 150);
      const selectedName = current.selected && current.selected();
      list.innerHTML = matches.length
        ? matches.map((it, i) => `<li role="option" data-i="${i}" aria-selected="${it.name === selectedName}"><span>${highlight(it.name, q)}</span></li>`).join('')
        : `<li class="sheet__empty">${items.length ? current.emptyText : current.loadingText}</li>`;
      list.scrollTop = 0;
    }
    function fitToKeyboard() {
      // Keep the drawer above the on-screen keyboard.
      const vv = window.visualViewport;
      if (!vv) return;
      const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      panel.style.bottom = keyboard + 'px';
      panel.style.maxHeight = Math.round(vv.height - 16) + 'px';
    }
    function open(opts) {
      current = opts;
      title.textContent = opts.title;
      search.placeholder = opts.searchPlaceholder;
      search.value = '';
      render();
      root.hidden = false;
      document.body.classList.add('sheet-open');
      search.focus({ preventScroll: true });
      window.visualViewport && window.visualViewport.addEventListener('resize', fitToKeyboard);
      fitToKeyboard();
      dbg('sheet open', opts.title);
    }
    function close() {
      if (root.hidden) return;
      root.hidden = true;
      document.body.classList.remove('sheet-open');
      search.blur();
      window.visualViewport && window.visualViewport.removeEventListener('resize', fitToKeyboard);
      panel.style.bottom = '';
      panel.style.maxHeight = '';
      current = null;
    }
    function pick(i) {
      const it = matches[i];
      if (!it || !current) return;
      const onPick = current.onPick;
      close();
      onPick(it);
    }

    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (matches.length) pick(0); }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li) pick(Number(li.dataset.i));
    });
    root.querySelector('.sheet__backdrop').addEventListener('click', close);
    root.querySelector('.sheet__close').addEventListener('click', close);
    return { open, close, render: () => { if (current) render(); } };
  })();

  function createCombo({ input, list, getItems, onSelect, emptyText, title, searchPlaceholder, loadingText }) {
    let matches = [];
    let active = -1;

    function render() {
      matches = filterItems(getItems(), input.value, 60);
      active = matches.length ? 0 : -1;
      list.innerHTML = matches.length
        ? matches.map((it, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}">${highlight(it.name, input.value.trim())}</li>`).join('')
        : `<li class="combo__empty">${emptyText}</li>`;
      open();
    }
    function open() { list.hidden = false; input.setAttribute('aria-expanded', 'true'); }
    function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); }
    function setActive(i) {
      const lis = list.querySelectorAll('li[data-i]');
      if (!lis.length) return;
      active = (i + lis.length) % lis.length;
      lis.forEach((li, k) => li.setAttribute('aria-selected', String(k === active)));
      lis[active].scrollIntoView({ block: 'nearest' });
    }
    function choose(i) {
      const it = matches[i];
      if (!it) return;
      input.value = it.name;
      close();
      onSelect(it);
    }

    // On mobile the field is a read-only button that opens the drawer (no keyboard on the field itself).
    function applyMode() {
      input.readOnly = isMobile();
      if (isMobile()) close();
    }
    applyMode();
    mobileQuery.addEventListener('change', applyMode);
    input.closest('.field').addEventListener('click', () => {
      if (!isMobile() || input.disabled) return;
      sheet.open({
        title,
        searchPlaceholder,
        emptyText,
        loadingText,
        getItems,
        selected: () => input.value,
        onPick: (it) => { input.value = it.name; onSelect(it); },
      });
    });

    input.addEventListener('input', () => { onSelect(null, true); render(); });
    input.addEventListener('focus', () => { if (!isMobile()) render(); });
    input.addEventListener('keydown', (e) => {
      if (isMobile()) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); list.hidden ? render() : setActive(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (e.key === 'Enter' && !list.hidden && active >= 0) { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li) { e.preventDefault(); choose(Number(li.dataset.i)); }
    });
    input.addEventListener('blur', () => {
      if (isMobile()) return;
      setTimeout(close, 120);
      // Accept an exact typed match without clicking it.
      const exact = getItems().find((it) => norm(it.name) === norm(input.value));
      if (exact) onSelect(exact);
    });
    return { close };
  }

  const cityInput = $('city-input');
  const streetInput = $('street-input');

  createCombo({
    input: cityInput,
    list: $('city-list'),
    getItems: () => state.cities,
    emptyText: 'לא נמצא יישוב',
    loadingText: 'טוען יישובים…',
    title: 'בחירת יישוב',
    searchPlaceholder: 'חיפוש יישוב',
    onSelect: (city, typing) => {
      if (state.city && city && state.city.cityId === city.cityId) return;
      state.city = city;
      state.street = null;
      state.streets = [];
      streetInput.value = '';
      streetInput.disabled = !city;
      streetInput.placeholder = city ? 'טוען רחובות…' : 'בחרו יישוב קודם';
      if (city) loadStreets(city.cityId);
      if (!typing) clearInvalid();
    },
  });

  createCombo({
    input: streetInput,
    list: $('street-list'),
    getItems: () => state.streets,
    emptyText: 'לא נמצא רחוב',
    loadingText: 'טוען רחובות…',
    title: 'בחירת רחוב',
    searchPlaceholder: 'חיפוש רחוב',
    onSelect: (street) => { state.street = street; },
  });

  function syncCityPlaceholder() {
    cityInput.placeholder = isMobile() ? 'בחרו יישוב' : 'התחילו להקליד שם יישוב';
  }
  syncCityPlaceholder();
  mobileQuery.addEventListener('change', syncCityPlaceholder);

  async function loadCities() {
    try {
      const { ok, data } = await kma('GET', '/cities');
      if (!ok) throw new Error();
      state.cities = (data.cities || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'he'));
      sheet.render();
      streetsByCity().catch(() => {}); // warm the street list while the user types
    } catch {
      showError('check-error', 'לא הצלחנו לטעון את רשימת היישובים. רעננו את הדף ונסו שוב.');
    }
  }

  async function loadStreets(cityId) {
    try {
      const streets = (await streetsByCity()).get(cityId) || [];
      if (!state.city || state.city.cityId !== cityId) return;
      state.streets = streets;
      streetInput.placeholder = streets.length ? (isMobile() ? 'בחרו רחוב' : 'התחילו להקליד שם רחוב') : 'אין רחובות ליישוב זה';
      sheet.render();
      if (!isMobile()) streetInput.focus();
    } catch {
      streetInput.placeholder = 'שגיאה בטעינת רחובות';
    }
  }

  // ---------- errors ----------
  function showError(id, msg) { const el = $(id); el.textContent = msg; el.hidden = !msg; }
  function markInvalid(el) { el.closest('.field').classList.add('is-invalid'); }
  function clearInvalid(root = document) { root.querySelectorAll('.is-invalid').forEach((el) => el.classList.remove('is-invalid')); }

  // ---------- check ----------
  const checkForm = $('check-form');
  const checkBtn = $('check-btn');
  const houseInput = $('house-input');
  const aptInput = $('apt-input');

  checkForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    dbg('check submit', { city: state.city, street: state.street, house: houseInput.value, apt: aptInput.value });
    clearInvalid(checkForm);
    showError('check-error', '');

    const house = houseInput.value.trim();
    const apt = aptInput.value.trim();
    const problems = [];
    if (!state.city) { markInvalid(cityInput); problems.push('יישוב מהרשימה'); }
    if (!state.street) { markInvalid(streetInput); problems.push('רחוב מהרשימה'); }
    if (!/^[\p{L}\p{N}]{1,10}$/u.test(house)) { markInvalid(houseInput); problems.push('מספר בית'); }
    if (apt && !/^[\p{L}\p{N}_-]{1,10}$/u.test(apt)) { markInvalid(aptInput); problems.push('מספר דירה תקין'); }
    if (problems.length) return showError('check-error', 'נא לבחור ' + problems.join(', ') + '.');

    setLoading(checkBtn, true);
    try {
      const { fiber } = await checkFiber({ cityId: state.city.cityId, streetId: state.street.streetId, houseNumber: house, apartment: apt });
      if (fiber === null) throw new Error('לא הצלחנו לבדוק את הכתובת כרגע. נסו שוב בעוד רגע.');
      const address = `${state.street.name} ${house}${apt ? ', דירה ' + apt : ''}, ${state.city.name}`;
      showResult(fiber, address);
    } catch (err) {
      dbg('check failed', err.message);
      showError('check-error', err.message);
    } finally {
      setLoading(checkBtn, false);
    }
  });

  const locateBtn = $('locate-btn');
  const locateLabel = $('locate-label');
  const LOCATE_LABEL = locateLabel.textContent;

  // Full-screen loading shown while the location check runs, with a step list of what is happening.
  const STEP_TEXT = {
    locate: { pending: 'איתור המיקום', active: 'מאתרים את המיקום שלכם…', done: 'המיקום אותר' },
    address: { pending: 'זיהוי הכתובת', active: 'מזהים את הכתובת…', done: 'הכתובת שזוהתה:' },
    check: { pending: 'בדיקת זמינות סיבים', active: 'בודקים זמינות סיבים מול בזק ו-IBC…', done: 'הבדיקה הושלמה', none: 'אין סיבים בכתובת הזו עדיין' },
  };
  const RESULT_HOLD_MS = 1100; // let the user read the confirmed address before the result replaces the screen

  // status: 'pending' | 'active' | 'done' | 'none' (check step only: finished, no fiber). detail (the address) is shown under a done step.
  function setStep(name, status, detail) {
    const li = $('locating-steps').querySelector(`[data-step="${name}"]`);
    li.classList.toggle('is-active', status === 'active');
    li.classList.toggle('is-done', status === 'done');
    li.classList.toggle('is-none', status === 'none');
    const label = li.querySelector('.steps__label');
    label.textContent = STEP_TEXT[name][status];
    if (detail) {
      const strong = document.createElement('strong');
      strong.textContent = detail;
      label.append(strong);
    }
    $('locating-text').textContent = name === 'locate' && status === 'active' ? 'אשרו גישה למיקום אם הדפדפן מבקש' : '';
  }

  function setLocating(on) {
    $('locating').hidden = !on;
    if (!on) return;
    setStep('address', 'pending');
    setStep('check', 'pending');
    setStep('locate', 'active');
  }

  function setAddressStep(address) {
    setStep('address', 'done', address);
    if (!address) $('locating-steps').querySelector('[data-step="address"] .steps__label').textContent = 'לא זוהתה כתובת מדויקת, בודקים לפי המיקום';
  }

  locateBtn.addEventListener('click', async () => {
    dbg('locate click');
    clearInvalid(checkForm);
    showError('check-error', '');
    locateBtn.disabled = checkBtn.disabled = true;
    locateBtn.classList.add('is-loading');
    locateLabel.textContent = 'מאתרים את המיקום…';
    setLocating(true);
    let answered = false;
    try {
      const { coords } = await getPosition();
      dbg('position', { accuracy: coords.accuracy });
      if (coords.accuracy > MAX_ACCURACY_METERS) throw new Error('המיקום שהתקבל אינו מדויק מספיק. הפעילו מיקום מדויק, או הזינו כתובת.');
      if (!window.proj4) throw new Error('לא הצלחנו לבדוק לפי מיקום כרגע. רעננו את הדף או הזינו כתובת.');
      const coordinates = WGS84toITM(coords.latitude, coords.longitude);
      locateLabel.textContent = 'בודקים…';
      setStep('locate', 'done');
      setStep('address', 'active');
      const addresses = lookupAddresses(coordinates, (text) => {
        if (answered) return; // a late address must not touch the screen (or a newer check's screen)
        setAddressStep(text);
        setStep('check', 'active');
      });
      const { fiber, provider } = await checkFiberByCoordinates(coordinates);
      const address = await addresses.forProvider(provider);
      answered = true;
      if (fiber === null) {
        throw new Error(address
          ? `המיקום שאותר: ${address}. לא הצלחנו לבדוק אותו כרגע. נסו שוב או הזינו כתובת.`
          : 'לא מצאנו כתובת במיקום שלכם. הזינו כתובת לבדיקה.');
      }
      setAddressStep(address); // the address the answer is about, if it differs from the first one shown
      setStep('check', fiber ? 'done' : 'none');
      await wait(RESULT_HOLD_MS);
      showResult(fiber, address || 'המיקום הנוכחי שלכם');
    } catch (err) {
      dbg('locate failed', err.message);
      showError('check-error', err.message);
    } finally {
      locateBtn.disabled = checkBtn.disabled = false;
      locateBtn.classList.remove('is-loading');
      locateLabel.textContent = LOCATE_LABEL;
      setLocating(false);
    }
  });

  function setLoading(btn, on) {
    locateBtn.disabled = on;
    btn.disabled = on;
    btn.classList.toggle('is-loading', on);
    const label = btn.querySelector('.btn__label');
    if (label) label.textContent = on ? 'בודקים…' : 'בדקו זמינות';
  }

  // ---------- result + lead ----------
  const result = $('result');
  const leadForm = $('lead-form');

  function showResult(fiber, address) {
    dbg('showResult', { fiber, address });
    state.fiber = fiber;
    result.classList.toggle('is-fiber', fiber);
    result.classList.toggle('is-nofiber', !fiber);
    $('result-badge').textContent = fiber ? 'יש סיבים' : 'אין סיבים עדיין';
    $('result-address').textContent = address;
    $('result-title').textContent = fiber ? 'הסיב כבר מחכה לכם בבית.' : 'הסיבים עוד לא הגיעו אליכם.';
    $('result-text').textContent = fiber
      ? 'השאירו שם וטלפון, ונציג של Call Up יחזור אליכם עם הצעה לחיבור.'
      : 'השאירו שם וטלפון ונעדכן אתכם ברגע שהסיבים יגיעו לכתובת – ובינתיים נבדוק איזה חיבור הכי מהיר אפשר לתת לכם היום.';
    $('lead-btn').textContent = fiber ? 'חזרו אליי' : 'עדכנו אותי';
    leadForm.hidden = false;
    $('thanks').hidden = true;
    showLeadProblems({ name: false });
    checkForm.hidden = true;
    $('locate').hidden = true;
    document.body.classList.add('has-result');
    result.hidden = false;
    setTimeout(() => $('lead-name').focus({ preventScroll: true }), 400);
  }

  const leadName = $('lead-name');
  const leadPhone = $('lead-phone');
  // Israeli mobile number: 050-055 or 058, then 7 digits.
  const PHONE_PATTERN = /^05[0123458]\d{7}$/;
  const isPhoneValid = () => PHONE_PATTERN.test(leadPhone.value);

  const isNameValid = () => leadName.value.trim().length >= 2;
  const isMarked = (el) => el.closest('.field').classList.contains('is-invalid');

  // Without "name", an error already shown on the name stays until the name is corrected.
  function showLeadProblems({ name = isMarked(leadName) && !isNameValid(), phone = false }) {
    showFieldError(leadName, name ? 'נא להזין שם מלא.' : '');
    showFieldError(leadPhone, phone ? 'מספר הטלפון אינו תקין.' : '');
    showError('lead-error', '');
  }

  // Marks the field red, with the message under its input.
  function showFieldError(input, msg) {
    input.closest('.field').classList.toggle('is-invalid', !!msg);
    input.setAttribute('aria-invalid', String(!!msg));
    showError(input.id + '-error', msg);
  }

  leadName.addEventListener('input', () => {
    if (isMarked(leadName) && isNameValid()) showLeadProblems({ phone: isMarked(leadPhone) && !isPhoneValid() });
  });
  // Checked when leaving the field; a shown error goes away as soon as the number is corrected.
  leadPhone.addEventListener('blur', () => {
    if (leadPhone.value.trim()) showLeadProblems({ phone: !isPhoneValid() });
  });
  // The field takes digits only.
  leadPhone.addEventListener('input', () => {
    const digits = leadPhone.value.replace(/\D/g, '');
    if (digits !== leadPhone.value) {
      const caret = leadPhone.value.slice(0, leadPhone.selectionStart).replace(/\D/g, '').length;
      leadPhone.value = digits;
      leadPhone.setSelectionRange(caret, caret);
    }
    if (isMarked(leadPhone) && isPhoneValid()) showLeadProblems({});
  });

  // Dashes and spaces in pasted or suggested numbers are dropped before maxlength applies,
  // or they would cost digits.
  leadPhone.addEventListener('beforeinput', (e) => {
    if (!e.cancelable || !e.data || !/\D/.test(e.data)) return;
    e.preventDefault();
    const { selectionStart: start, selectionEnd: end, value, maxLength } = leadPhone;
    const room = maxLength - (value.length - (end - start));
    leadPhone.setRangeText(e.data.replace(/\D/g, '').slice(0, room), start, end, 'end');
    leadPhone.dispatchEvent(new Event('input', { bubbles: true }));
  });

  leadForm.addEventListener('submit', (e) => {
    e.preventDefault();
    dbg('lead submit');
    const name = leadName.value.trim();
    const problems = { name: !isNameValid(), phone: !isPhoneValid() };
    showLeadProblems(problems);
    if (problems.name || problems.phone) return;

    sendLead(name, leadPhone.value);
  });

  // ---------- lead -> callup saveLandingLeadFiber ----------
  // The endpoint may send no CORS headers, so the lead is sent as a plain form POST
  // in "no-cors" mode (fire-and-forget): the browser delivers it but cannot read the reply.
  const LEAD_URL = CONFIG.leadUrl || 'https://www.callup.co/main/saveLandingLeadFiber';
  const LEAD_SOURCE = CONFIG.leadSource || 'fiberCheckLanding';
  const leadBtn = $('lead-btn');

  async function sendLead(name, phone) {
    const body = new URLSearchParams({
      phone_number: phone,
      fullname: name,
      source: LEAD_SOURCE,
    });
    dbg('lead send', Object.fromEntries(body));

    const label = leadBtn.textContent;
    leadBtn.disabled = true;
    leadBtn.textContent = 'שולחים…';
    try {
      await fetch(LEAD_URL, { method: 'POST', mode: 'no-cors', body });
      dbg('lead sent (opaque response)');
      $('thanks-name').textContent = name.split(' ')[0];
      leadForm.hidden = true;
      $('thanks').hidden = false;
    } catch (err) {
      dbg('lead failed', err.message);
      showError('lead-error', 'לא הצלחנו לשלוח את הפרטים. בדקו את החיבור לאינטרנט ונסו שוב.');
    } finally {
      leadBtn.disabled = false;
      leadBtn.textContent = label;
    }
  }

  $('again-btn').addEventListener('click', () => {
    dbg('again clicked');
    result.hidden = true;
    checkForm.hidden = false;
    $('locate').hidden = false;
    document.body.classList.remove('has-result');
    $('lead-name').value = '';
    $('lead-phone').value = '';
    if (state.city) houseInput.focus({ preventScroll: true });
  });

  loadCities();
})();
