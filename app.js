/* STC Monitor — tampilan & mesin alarm. Data diambil dari window.dataSource */
(function () {
  const ds = window.dataSource;
  const $ = s => document.querySelector(s);
  const view = $('#view');

  const ALARM_TYPES = {
    trip: 'Pompa trip',
    overcurrent: 'Arus berlebih',
    phase: 'Phase loss / tegangan tidak normal',
    lowPressure: 'Tekanan rendah',
    highPressure: 'Tekanan tinggi',
    dryRun: 'Dry run (pompa jalan kering)',
    highTemp: 'Suhu motor tinggi',
  };

  /* ---------- Pengaturan batas alarm (localStorage) ---------- */
  const DEFAULTS = {
    booster: { pressureLow: 2.0, pressureHigh: 7.0, currentMax: 22, voltageMin: 342, voltageMax: 418, tempMax: 85 },
    fire: { pressureLow: 5.0, pressureHigh: 11.0, currentMax: 75, voltageMin: 342, voltageMax: 418, tempMax: 90 },
  };
  const FIELDS = [
    ['pressureLow', 'Tekanan rendah (bar) di bawah', 0.1],
    ['pressureHigh', 'Tekanan tinggi (bar) di atas', 0.1],
    ['currentMax', 'Arus maksimum (A)', 0.5],
    ['voltageMin', 'Tegangan minimum (V)', 1],
    ['voltageMax', 'Tegangan maksimum (V)', 1],
    ['tempMax', 'Suhu motor maksimum (°C)', 1],
  ];
  const pumps = ds.getPumps();
  const pumpById = id => pumps.find(p => p.id === id);
  let settings = JSON.parse(localStorage.getItem('stc.thresholds') || '{}');
  const getThresholds = id => Object.assign({}, DEFAULTS[pumpById(id).type], settings[id] || {});

  /* ---------- Riwayat alarm ---------- */
  let alarms = JSON.parse(localStorage.getItem('stc.alarms') || '[]');
  let unread = 0;
  const active = {};   // key pumpId|type -> id alarm
  const saveAlarms = () => localStorage.setItem('stc.alarms', JSON.stringify(alarms.slice(0, 200)));

  function check(r) {
    const t = getThresholds(r.pumpId);
    const I = [r.currentR, r.currentS, r.currentT];
    const phaseLoss = r.running && Math.min(...I) < 0.5 && Math.max(...I) > 1;
    const cond = {
      trip: r.trip,
      overcurrent: r.running && Math.max(...I) > t.currentMax,
      phase: phaseLoss || r.voltage < t.voltageMin || r.voltage > t.voltageMax,
      lowPressure: r.running && !r.dryRun && r.pressure < t.pressureLow,
      highPressure: r.pressure > t.pressureHigh,
      dryRun: r.dryRun,
      highTemp: r.motorTemp > t.tempMax,
    };
    for (const type in cond) {
      const key = r.pumpId + '|' + type;
      if (cond[type] && !active[key]) raise(r, type, key);
      else if (!cond[type] && active[key]) {
        const a = alarms.find(x => x.id === active[key]); if (a) a.cleared = r.ts;
        delete active[key]; saveAlarms();
      }
    }
  }
  const isAlarm = id => Object.keys(active).some(k => k.startsWith(id + '|'));

  function valueText(r, type) {
    return {
      trip: 'Status trip dari panel', overcurrent: `Arus ${Math.max(r.currentR, r.currentS, r.currentT)} A`,
      phase: `R/S/T ${r.currentR}/${r.currentS}/${r.currentT} A, ${r.voltage} V`, lowPressure: `${r.pressure} bar`,
      highPressure: `${r.pressure} bar`, dryRun: 'Sensor level / air tidak ada', highTemp: `${r.motorTemp} °C`,
    }[type];
  }

  function raise(r, type, key) {
    const a = { id: Date.now() + Math.random(), ts: r.ts, pumpId: r.pumpId, type, value: valueText(r, type), cleared: null };
    alarms.unshift(a); active[key] = a.id; saveAlarms();
    unread++; updateBadge();
    const name = pumpById(r.pumpId).name, msg = `${name}: ${ALARM_TYPES[type]}`;
    showBanner(msg);
    beep(); if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
    notify('ALARM ' + msg, a.value);
    if (location.hash.startsWith('#/alarm')) render();
  }

  /* ---------- Banner, suara, notifikasi ---------- */
  let bannerTimer;
  function showBanner(msg) {
    const b = $('#banner');
    b.innerHTML = `🚨 <b>ALARM</b> — ${msg} <a href="#/alarm">Lihat</a> <button aria-label="Tutup">✕</button>`;
    b.classList.remove('hidden');
    b.querySelector('button').onclick = () => b.classList.add('hidden');
    clearTimeout(bannerTimer); bannerTimer = setTimeout(() => b.classList.add('hidden'), 15000);
  }
  let audioCtx;
  document.addEventListener('click', () => { if (!audioCtx) try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }, { once: true });
  function beep() {
    if (!audioCtx) return;
    [0, .35, .7].forEach(d => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.type = 'square'; g.gain.value = .08;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(audioCtx.currentTime + d); o.stop(audioCtx.currentTime + d + .2);
    });
  }
  function notify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const opt = { body, icon: 'icon-192.png', badge: 'icon-192.png', tag: 'stc-' + Date.now(), vibrate: [300, 150, 300] };
    if (navigator.serviceWorker && navigator.serviceWorker.controller)
      navigator.serviceWorker.ready.then(reg => reg.showNotification(title, opt));
    else try { new Notification(title, opt); } catch (e) {}
  }
  function notifState() {
    if (!('Notification' in window)) return 'Browser ini tidak mendukung notifikasi';
    return { granted: 'Notifikasi aktif ✅', denied: 'Notifikasi diblokir — izinkan di pengaturan browser', default: '' }[Notification.permission];
  }
  function updateBadge() { const b = $('#badge'); b.textContent = unread; b.classList.toggle('hidden', !unread); }

  /* ---------- Helper tampilan ---------- */
  function status(r) {
    if (r.trip) return ['TRIP', 'trip'];
    if (isAlarm(r.pumpId)) return ['Alarm', 'alarm'];
    return r.running ? ['Jalan', 'run'] : ['Berhenti', 'stop'];
  }
  const fmtTime = ts => new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtDate = ts => new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function metrics(r) {
    const [label, cls] = status(r);
    return `<div class="status ${cls}">${label}</div>
      <div class="grid">
        <div><span>Tekanan</span><b>${r.pressure.toFixed(1)}</b> bar</div>
        <div><span>Tegangan</span><b>${r.voltage}</b> V</div>
        <div class="wide"><span>Arus R / S / T</span><b>${r.currentR.toFixed(1)} / ${r.currentS.toFixed(1)} / ${r.currentT.toFixed(1)}</b> A</div>
        <div><span>Suhu motor</span><b>${r.motorTemp.toFixed(0)}</b> °C</div>
        <div><span>Jam jalan</span><b>${r.runHours.toLocaleString('id-ID')}</b> jam</div>
      </div>`;
  }

  /* ---------- Halaman ---------- */
  function pageHome() {
    view.innerHTML = `<div class="actions">
        <button class="btn red" id="simBtn">🚨 Simulasi alarm</button>
        <button class="btn" id="notifBtn">🔔 Aktifkan notifikasi</button>
      </div><p class="hint" id="notifInfo">${notifState()}</p>
      ${pumps.map(p => `<a class="card" href="#/pompa/${p.id}" data-id="${p.id}"><h2>${p.name} <small>›</small></h2><div class="m"></div></a>`).join('')}
      <p class="hint">Data diperbarui tiap 2,5 detik. Ketuk kartu pompa untuk melihat grafik.</p>`;
    $('#simBtn').onclick = () => ds.simulateFault();
    $('#notifBtn').onclick = askNotif;
    updateHome();
  }
  function updateHome() {
    pumps.forEach(p => { const el = view.querySelector(`[data-id="${p.id}"] .m`); if (el) el.innerHTML = metrics(ds.getLatest(p.id)); });
  }
  function askNotif() {
    if (!('Notification' in window)) return alert('Browser ini tidak mendukung notifikasi.');
    Notification.requestPermission().then(() => { const i = $('#notifInfo'); if (i) i.textContent = notifState();
      if (Notification.permission === 'granted') notify('STC Monitor', 'Notifikasi alarm sudah aktif.'); });
  }

  function pageDetail(id) {
    const p = pumpById(id); if (!p) return (location.hash = '#/');
    view.innerHTML = `<a href="#/" class="back">‹ Kembali</a>
      <div class="card"><h2>${p.name}</h2><div class="m"></div></div>
      <div class="card"><h3>Tekanan (bar) — 10 menit terakhir</h3><canvas id="cP"></canvas></div>
      <div class="card"><h3>Arus R / S / T (A) — 10 menit terakhir</h3><canvas id="cA"></canvas>
        <div class="legend"><i style="background:#d62828"></i>R <i style="background:#e0a800"></i>S <i style="background:#1d4ed8"></i>T</div></div>
      <button class="btn red full" id="simOne">🚨 Simulasi alarm pada pompa ini</button>`;
    $('#simOne').onclick = () => ds.simulateFault(id);
    updateDetail(id);
  }
  function updateDetail(id) {
    const h = ds.getHistory(id), t = getThresholds(id);
    view.querySelector('.m').innerHTML = metrics(h[h.length - 1]);
    drawChart($('#cP'), h, [{ k: 'pressure', c: '#0b4f8a' }], [t.pressureLow, t.pressureHigh]);
    drawChart($('#cA'), h, [{ k: 'currentR', c: '#d62828' }, { k: 'currentS', c: '#e0a800' }, { k: 'currentT', c: '#1d4ed8' }], [t.currentMax]);
  }
  function drawChart(cv, h, series, limits) {
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = 150;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const L = 34, R = 6, T = 8, B = 20, w = W - L - R, hh = H - T - B;
    let vals = []; series.forEach(s => h.forEach(r => vals.push(r[s.k]))); vals = vals.concat(limits);
    let mn = Math.min(0, ...vals), mx = Math.max(...vals) * 1.1 || 1;
    const t0 = h[0].ts, t1 = h[h.length - 1].ts || t0 + 1;
    const X = ts => L + (ts - t0) / (t1 - t0 || 1) * w, Y = v => T + hh - (v - mn) / (mx - mn) * hh;
    g.font = '10px sans-serif'; g.fillStyle = '#667'; g.strokeStyle = '#e3e8ef'; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const v = mn + (mx - mn) * i / 4, y = Y(v); g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.fillText(v.toFixed(v < 10 ? 1 : 0), 2, y + 3); }
    g.fillText(fmtTime(t0).slice(0, 5), L, H - 5); g.fillText(fmtTime(t1).slice(0, 5), W - R - 30, H - 5);
    g.setLineDash([4, 4]); g.strokeStyle = '#f08c00';
    limits.forEach(v => { g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(W - R, Y(v)); g.stroke(); });
    g.setLineDash([]); g.lineWidth = 1.8;
    series.forEach(s => { g.strokeStyle = s.c; g.beginPath(); h.forEach((r, i) => i ? g.lineTo(X(r.ts), Y(r[s.k])) : g.moveTo(X(r.ts), Y(r[s.k]))); g.stroke(); });
  }

  function pageAlarm() {
    unread = 0; updateBadge();
    view.innerHTML = `<h2 class="title">Riwayat alarm</h2>
      <div class="card sim-box"><b>Simulasi alarm</b>
        <select id="sPump"><option value="">Pompa acak</option>${pumps.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select>
        <select id="sType"><option value="">Jenis acak</option>${Object.entries(ALARM_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <button class="btn red full" id="simGo">🚨 Simulasi alarm</button></div>
      ${alarms.length ? alarms.map(a => `<div class="alarm ${a.cleared ? 'done' : 'on'}">
          <div><b>${ALARM_TYPES[a.type]}</b><span>${(pumpById(a.pumpId) || {}).name || a.pumpId} · ${a.value || ''}</span></div>
          <div class="when">${fmtDate(a.ts)}<em>${a.cleared ? 'Selesai ' + fmtTime(a.cleared) : 'AKTIF'}</em></div></div>`).join('')
        : '<p class="hint">Belum ada alarm.</p>'}
      ${alarms.length ? '<button class="btn full" id="clr">Hapus riwayat</button>' : ''}`;
    $('#simGo').onclick = () => ds.simulateFault($('#sPump').value || undefined, $('#sType').value || undefined);
    const c = $('#clr'); if (c) c.onclick = () => { if (confirm('Hapus semua riwayat alarm?')) { alarms = alarms.filter(a => !a.cleared); saveAlarms(); render(); } };
  }

  function pageSetting() {
    view.innerHTML = `<h2 class="title">Pengaturan batas alarm</h2>
      <p class="hint">Disimpan di HP ini (localStorage). Alarm muncul jika nilai melewati batas.</p>
      ${pumps.map(p => { const t = getThresholds(p.id); return `<form class="card set" data-id="${p.id}"><h3>${p.name}</h3>
        ${FIELDS.map(([k, l, st]) => `<label>${l}<input type="number" step="${st}" name="${k}" value="${t[k]}" required></label>`).join('')}
        <div class="row"><button class="btn blue">Simpan</button><button type="button" class="btn reset">Kembalikan default</button></div></form>`; }).join('')}
      <p class="hint">Mode: ${ds.mode}. Versi tahap 1.</p>`;
    view.querySelectorAll('form.set').forEach(f => {
      const id = f.dataset.id;
      f.onsubmit = e => { e.preventDefault(); settings[id] = {}; FIELDS.forEach(([k]) => settings[id][k] = parseFloat(f.elements[k].value));
        localStorage.setItem('stc.thresholds', JSON.stringify(settings)); toast('Tersimpan ✅'); };
      f.querySelector('.reset').onclick = () => { delete settings[id]; localStorage.setItem('stc.thresholds', JSON.stringify(settings)); pageSetting(); toast('Default dipulihkan'); };
    });
  }
  function toast(m) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 1800); }

  /* ---------- Router ---------- */
  let route = '';
  function render() {
    route = location.hash || '#/';
    document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on',
      (a.dataset.tab === 'home' && (route === '#/' || route.startsWith('#/pompa'))) || route.startsWith('#/' + a.dataset.tab)));
    const m = route.match(/^#\/pompa\/(\w+)/);
    if (m) pageDetail(m[1]); else if (route.startsWith('#/alarm')) pageAlarm(); else if (route.startsWith('#/setting')) pageSetting(); else pageHome();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', render);

  ds.onData(r => {
    check(r);
    if (route === '#/' || route === '') updateHome();
    else if (route === '#/pompa/' + r.pumpId) updateDetail(r.pumpId);
  });
  ds.start({ getThresholds });
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
