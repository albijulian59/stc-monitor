/* ===================================================================
 * dataSource — lapisan data STC Monitor
 * -------------------------------------------------------------------
 * Tahap 2: data asli via MQTT over WebSocket (wss). Selama belum ada
 * data dari perangkat (atau jika dipilih), memakai SIMULATOR di browser.
 * Antarmuka:
 *
 *   dataSource.mode                      -> 'simulasi' | 'live'
 *   dataSource.onStatus(cb)              -> cb('simulasi'|'connecting'|'live'|'offline'|'error')
 *   dataSource.start(opts)               -> mulai (opts.getThresholds(id))
 *   dataSource.getPumps()                -> [{id,name,type}]
 *   dataSource.getLatest(id)             -> reading terakhir
 *   dataSource.getHistory(id)            -> [reading,...] (~10 menit)
 *   dataSource.onData(cb)                -> cb(reading) tiap update
 *   dataSource.simulateFault(id?, type?) -> hanya di mode simulasi
 *
 * Bentuk "reading" (sama untuk simulator & backend asli):
 *   { pumpId, ts, running, trip, dryRun, pressure, currentR, currentS,
 *     currentT, voltage, motorTemp, runHours }
 * =================================================================== */
(function () {
  const PUMPS = [
    { id: 'bp1', name: 'Booster Pump 1', type: 'booster', p: 4.5, a: 18 },
    { id: 'bp2', name: 'Booster Pump 2', type: 'booster', p: 4.5, a: 18 },
    { id: 'fp1', name: 'Fire Pump', type: 'fire', p: 8.0, a: 62 },
  ];
  const TICK_MS = 2500;
  const HISTORY_MS = 10 * 60 * 1000;
  const MAX_POINTS = Math.ceil(HISTORY_MS / TICK_MS);
  const FAULTS = ['trip', 'overcurrent', 'phase', 'lowPressure', 'highPressure', 'dryRun', 'highTemp'];

  const state = {}, history = {}, listeners = [];
  let getThr = () => ({});
  const rnd = (a, b) => a + Math.random() * (b - a);
  const r1 = v => Math.round(v * 10) / 10;

  PUMPS.forEach(p => {
    state[p.id] = {
      running: p.type === 'booster' ? (p.id === 'bp1' || Math.random() > .5) : false,
      runHours: p.type === 'fire' ? rnd(40, 90) : rnd(1200, 4800),
      temp: p.type === 'fire' ? 31 : 52, fault: null, faultUntil: 0,
    };
    history[p.id] = [];
  });

  function makeReading(p, ts) {
    const s = state[p.id], t = getThr(p.id) || {};
    if (s.fault && ts > s.faultUntil) s.fault = null;
    // pergantian jalan/berhenti normal untuk booster 2
    if (p.id === 'bp2' && !s.fault && Math.random() < 0.01) s.running = !s.running;
    const f = s.fault;
    let running = s.running, trip = false, dryRun = false;
    let pressure = running ? p.p + rnd(-.25, .25) : (p.type === 'fire' ? 7 + rnd(-.1, .1) : 3.2 + rnd(-.1, .1));
    let base = running ? p.a : 0;
    let cR = base ? base + rnd(-.6, .6) : 0, cS = base ? base + rnd(-.6, .6) : 0, cT = base ? base + rnd(-.6, .6) : 0;
    let voltage = 380 + rnd(-5, 5);
    let tTarget = running ? (p.type === 'fire' ? 60 : 55) : 32;

    if (f) {
      if (f === 'trip') { running = false; trip = true; cR = cS = cT = 0; pressure = 1.2 + rnd(-.2, .2); }
      if (f === 'overcurrent') { const m = Math.max(1.35, (t.currentMax || p.a * 1.2) / p.a + .15); cR *= m; cS *= m; cT *= m; }
      if (f === 'phase') { cT = 0; voltage = Math.min(330, (t.voltageMin || 342) - 15); }
      if (f === 'lowPressure') pressure = Math.max(.3, (t.pressureLow || 2) * .6);
      if (f === 'highPressure') pressure = (t.pressureHigh || 7) * 1.12 + (p.type === 'fire' ? 0 : 0);
      if (f === 'dryRun') { dryRun = true; cR *= .45; cS *= .45; cT *= .45; pressure = .4; }
      if (f === 'highTemp') tTarget = (t.tempMax || 85) + 12;
    }
    s.temp += (tTarget - s.temp) * (f === 'highTemp' ? .5 : .05) + rnd(-.2, .2);
    if (running) s.runHours += TICK_MS / 3600000;
    return {
      pumpId: p.id, ts, running, trip, dryRun,
      pressure: r1(Math.max(0, pressure)), currentR: r1(cR), currentS: r1(cS), currentT: r1(cT),
      voltage: Math.round(voltage), motorTemp: r1(s.temp), runHours: Math.round(s.runHours * 10) / 10,
    };
  }

  function push(r) {
    const h = history[r.pumpId]; h.push(r);
    while (h.length > MAX_POINTS) h.shift();
  }

  function tick() {
    const now = Date.now();
    PUMPS.forEach(p => {
      // gangguan acak sesekali (rata-rata ± tiap 10 menit untuk semua pompa)
      if (!state[p.id].fault && Math.random() < 1 / 720) startFault(p.id);
      const r = makeReading(p, now); push(r);
      listeners.forEach(cb => cb(r));
    });
  }

  function startFault(id, type) {
    const p = PUMPS.find(x => x.id === id), s = state[id];
    type = type || FAULTS[Math.floor(Math.random() * FAULTS.length)];
    if (type !== 'highPressure') s.running = true;        // gangguan lain terjadi saat pompa jalan
    s.fault = type; s.faultUntil = Date.now() + rnd(20000, 40000);
    return { pumpId: p.id, type };
  }

  /* ---------------- Koneksi perangkat (MQTT over WSS) ----------------
   * Topik (lihat README):  <prefix>/<pumpId>/telemetry  -> JSON reading
   *                        <prefix>/status               -> "online"/"offline"
   *                        <prefix>/cmd/simulate         -> perintah uji (hanya simulator)
   */
  const MQTT_DEFAULTS = {
    url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public',
    prefix: 'stc-monitor/8a50f39eb100', ntfyTopic: 'stc-alarm-0a25f56fa0fa',
  };
  const cfg = Object.assign({}, MQTT_DEFAULTS, JSON.parse(localStorage.getItem('stc.mqtt') || '{}'));
  const source = localStorage.getItem('stc.source') || 'auto';   // 'auto' | 'sim'
  const OFFLINE_MS = 30000;
  const statusCbs = [];
  let simTimer = null, client = null, lastLive = 0, liveStarted = false, status = source === 'sim' ? 'simulasi' : 'connecting';
  const setStatus = st => { if (st === status) return; status = st; ds.mode = st === 'simulasi' || st === 'connecting' ? 'simulasi' : 'live'; statusCbs.forEach(cb => cb(st, lastLive)); };
  const num = v => (v === undefined || v === null || v === '' ? 0 : +v || 0);
  const bool = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'ON';

  // Ubah payload JSON (dari RUT241 / simulator) menjadi "reading" standar
  function normalize(pumpId, j) {
    let ts = num(j.ts) || Date.now(); if (ts < 1e12) ts *= 1000;     // detik -> ms
    const st = j.status !== undefined ? num(j.status) : null;        // opsional: bitmask register status
    return {
      pumpId, ts,
      running: st !== null ? !!(st & 1) : bool(j.running),
      trip: st !== null ? !!(st & 2) : bool(j.trip),
      dryRun: st !== null ? !!(st & 4) : bool(j.dryRun),
      pressure: num(j.pressure), currentR: num(j.currentR), currentS: num(j.currentS), currentT: num(j.currentT),
      voltage: num(j.voltage), motorTemp: num(j.motorTemp), runHours: num(j.runHours),
    };
  }

  function onLive(pumpId, r) {
    if (!liveStarted) {                            // data asli pertama: hentikan simulasi, buang data palsu
      liveStarted = true; clearInterval(simTimer); simTimer = null;
      PUMPS.forEach(p => { history[p.id] = []; });
    }
    lastLive = Date.now(); push(r); setStatus('live');
    listeners.forEach(cb => cb(r));
  }

  function connectMqtt() {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js';
    s.onerror = () => setStatus('error');
    s.onload = () => {
      client = window.mqtt.connect(cfg.url, {
        username: cfg.username || undefined, password: cfg.password || undefined,
        clientId: 'stc-app-' + Math.random().toString(16).slice(2, 10), reconnectPeriod: 5000, connectTimeout: 10000,
      });
      client.on('connect', () => client.subscribe(cfg.prefix + '/+/telemetry'));
      client.on('message', (topic, msg) => {
        const id = topic.slice(cfg.prefix.length + 1).split('/')[0];
        if (!history[id]) return;                  // pompa tidak dikenal
        try { onLive(id, normalize(id, JSON.parse(msg.toString()))); } catch (e) { console.warn('payload salah', topic, e); }
      });
    };
    document.head.appendChild(s);
    setInterval(() => { if (status === 'live' && Date.now() - lastLive > OFFLINE_MS) setStatus('offline'); }, 5000);
  }

  const ds = window.dataSource = {
    mode: 'simulasi',
    config: cfg, defaults: MQTT_DEFAULTS, source,
    getStatus: () => ({ status, lastLive }),
    onStatus(cb) { statusCbs.push(cb); },
    start(opts = {}) {
      if (opts.getThresholds) getThr = opts.getThresholds;
      // isi riwayat 10 menit terakhir supaya grafik langsung terisi (simulasi)
      const now = Date.now();
      for (let ts = now - HISTORY_MS; ts < now; ts += TICK_MS) PUMPS.forEach(p => push(makeReading(p, ts)));
      tick(); simTimer = setInterval(tick, TICK_MS);
      if (source !== 'sim') connectMqtt();
    },
    getPumps: () => PUMPS.map(({ id, name, type }) => ({ id, name, type })),
    getLatest: id => history[id][history[id].length - 1] || makeReading(PUMPS.find(p => p.id === id), Date.now()),
    getHistory: id => history[id].length ? history[id].slice() : [ds.getLatest(id)],
    onData(cb) { listeners.push(cb); },
    simulateFault(id, type) {
      if (status === 'live' || status === 'offline') {   // minta simulator perangkat membuat gangguan (diabaikan RUT241 asli)
        if (client) client.publish(cfg.prefix + '/cmd/simulate', JSON.stringify({ pumpId: id || null, type: type || null }));
        return { remote: true };
      }
      id = id || PUMPS[Math.floor(Math.random() * PUMPS.length)].id;
      const res = startFault(id, type); tick(); return res;
    },
  };
})();
