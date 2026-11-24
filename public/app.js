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

  // Checks Bezeq and IBC in parallel; fiber if either has it. null = both checks failed.
  async function checkFiber({ cityId, streetId, houseNumber, apartment }) {
    const address = { cityId, streetId, houseNumber };
    // IBC requires an apartment; a private house has none, so "0" stands for "no apartment".
    const [bezeq, ibc] = await Promise.all([
      checkProvider('bezeq', { address }),
      checkProvider('ibc', { address: { ...address, apartment: apartment || '0' } }),
    ]);
    return combineResults(bezeq, ibc);
  }

  async function checkFiberByCoordinates(coordinates) {
    const [bezeq, ibc] = await Promise.all([
      checkProvider('bezeq', { coordinates }),
      checkProvider('ibc', { coordinates }),
    ]);
    return combineResults(bezeq, ibc);
  }

  function combineResults(bezeq, ibc) {
    dbg('check results', { bezeq, ibc });
    state.providers = { bezeq, ibc };
    if (bezeq === null && ibc === null) return null;
    return bezeq === true || ibc === true;
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

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('הדפדפן לא תומך באיתור מיקום. הזינו כתובת במקום.'));
      navigator.geolocation.getCurrentPosition(resolve, (err) => {
        dbg('geolocation error', err.code, err.message);
        reject(new Error(err.code === 1
          ? 'אין הרשאה למיקום. אשרו גישה למיקום בדפדפן, או הזינו כתובת.'
          : 'לא הצלחנו לאתר את המיקום שלכם. נסו שוב או הזינו כתובת.'));
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    });
  }

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

  async function coordinatesToAddress(coordinates) {
    const [bezeq, ibc] = await Promise.all([addressText('bezeq', coordinates), addressText('ibc', coordinates)]);
    return { bezeq, ibc };
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
      const fiber = await checkFiber({ cityId: state.city.cityId, streetId: state.street.streetId, houseNumber: house, apartment: apt });
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

  // Full-screen loading shown while the location check runs.
  function setLocating(step) {
    $('locating').hidden = !step;
    if (!step) return;
    const checking = step === 'check';
    $('locating-title').textContent = checking ? 'בודקים זמינות סיבים…' : 'מאתרים את המיקום שלכם…';
    $('locating-text').textContent = checking ? 'עוד רגע ויש תשובה' : 'אשרו גישה למיקום אם הדפדפן מבקש';
  }

  locateBtn.addEventListener('click', async () => {
    dbg('locate click');
    clearInvalid(checkForm);
    showError('check-error', '');
    locateBtn.disabled = checkBtn.disabled = true;
    locateBtn.classList.add('is-loading');
    locateLabel.textContent = 'מאתרים את המיקום…';
    setLocating('locate');
    try {
      const { coords } = await getPosition();
      dbg('position', { accuracy: coords.accuracy });
      if (coords.accuracy > MAX_ACCURACY_METERS) throw new Error('המיקום שהתקבל אינו מדויק מספיק. הפעילו מיקום מדויק, או הזינו כתובת.');
      if (!window.proj4) throw new Error('לא הצלחנו לבדוק לפי מיקום כרגע. רעננו את הדף או הזינו כתובת.');
      const coordinates = WGS84toITM(coords.latitude, coords.longitude);
      locateLabel.textContent = 'בודקים…';
      setLocating('check');
      const [addresses, fiber] = await Promise.all([coordinatesToAddress(coordinates), checkFiberByCoordinates(coordinates)]);
      // Bezeq and IBC may resolve a point to neighbouring buildings: show the one the answer is about.
      const { bezeq, ibc } = state.providers;
      const fromIbc = (ibc === true && bezeq !== true) || (bezeq === null && ibc !== null);
      const address = fromIbc ? addresses.ibc || addresses.bezeq : addresses.bezeq || addresses.ibc;
      if (fiber === null) {
        throw new Error(address
          ? `המיקום שאותר: ${address}. לא הצלחנו לבדוק אותו כרגע. נסו שוב או הזינו כתובת.`
          : 'לא מצאנו כתובת במיקום שלכם. הזינו כתובת לבדיקה.');
      }
      showResult(fiber, address || 'המיקום הנוכחי שלכם');
    } catch (err) {
      dbg('locate failed', err.message);
      showError('check-error', err.message);
    } finally {
      locateBtn.disabled = checkBtn.disabled = false;
      locateBtn.classList.remove('is-loading');
      locateLabel.textContent = LOCATE_LABEL;
      setLocating(null);
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
    showError('lead-error', '');
    clearInvalid(leadForm);
    checkForm.hidden = true;
    $('locate').hidden = true;
    document.body.classList.add('has-result');
    result.hidden = false;
    setTimeout(() => $('lead-name').focus({ preventScroll: true }), 400);
  }

  leadForm.addEventListener('submit', (e) => {
    e.preventDefault();
    dbg('lead submit');
    clearInvalid(leadForm);
    const name = $('lead-name').value.trim();
    const phone = $('lead-phone').value.replace(/[\s-]/g, '');
    const problems = [];
    if (name.length < 2) { markInvalid($('lead-name')); problems.push('שם מלא'); }
    if (!/^05\d{8}$/.test(phone)) { markInvalid($('lead-phone')); problems.push('מספר טלפון תקין'); }
    if (problems.length) return showError('lead-error', 'נא להזין ' + problems.join(' ו') + '.');
    showError('lead-error', '');

    sendLead(name, phone);
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
