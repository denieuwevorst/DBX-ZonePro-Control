(() => {
  const rack = document.getElementById('rack');
  const template = document.getElementById('strip-template');
  const linkLed = document.getElementById('linkLed');
  const linkLabel = document.getElementById('linkLabel');

  const strips = new Map(); // zoneId -> entry
  let ws = null;

  const zoneMatch = location.pathname.match(/^\/zone(\d+)\/?$/);
  const singleZoneId = zoneMatch ? zoneMatch[1] : null;

  function setLink(connected) {
    linkLed.classList.toggle('on', !!connected);
    linkLabel.textContent = connected ? 'ZONEPRO LINKED' : 'NO LINK';
  }

  function dbText(db) {
    const rounded = Math.round(db * 10) / 10;
    return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`;
  }

  // 0% = top of the track = max dB, 100% = bottom of the track = min dB.
  // Used for the thumb, the "0" tick, and the unity-gain line, so all three
  // are always in agreement with each other and with the numeric readout.
  function percentForDb(db, min, max) {
    return ((max - db) / (max - min)) * 100;
  }

  function dbForPercent(percent, min, max, step) {
    const raw = max - (percent / 100) * (max - min);
    const stepped = Math.round(raw / step) * step;
    return Math.min(max, Math.max(min, Math.round(stepped * 100) / 100));
  }

  function showNotConfigured() {
    document.body.classList.add('single-zone');
    rack.innerHTML = `
      <div class="empty-state">
        <p>Zone ${singleZoneId} isn't configured yet.</p>
        <a href="/">&larr; Back to all zones</a>
      </div>`;
  }

  function buildStrips(config) {
    let zones = config.zones;

    if (singleZoneId !== null) {
      document.body.classList.add('single-zone');
      zones = zones.filter((z) => String(z.id) === singleZoneId);
      document.title = zones[0] ? `${zones[0].name} \u00b7 ZonePRO` : `Zone ${singleZoneId} \u00b7 ZonePRO`;
    }

    rack.innerHTML = '';
    strips.clear();

    if (zones.length === 0) {
      showNotConfigured();
      return;
    }

    const min = config.volumeMinDb;
    const max = config.volumeMaxDb;
    const step = config.volumeStepDb;

    for (const zone of zones) {
      const node = template.content.firstElementChild.cloneNode(true);
      node.dataset.zone = zone.id;

      const nameEl = node.querySelector('[data-name]');
      nameEl.textContent = zone.name;
      nameEl.title = zone.name;

      const link = node.querySelector('[data-link]');
      if (singleZoneId === null) {
        link.href = `/zone${zone.id}`;
        link.hidden = false;
      }

      const track = node.querySelector('[data-track]');
      const thumb = node.querySelector('[data-thumb]');
      const unity = node.querySelector('[data-unity]');
      const tickTop = node.querySelector('[data-tick-top]');
      const tickUnity = node.querySelector('[data-tick-unity]');
      const tickBottom = node.querySelector('[data-tick-bottom]');
      const readout = node.querySelector('[data-readout]');
      const muteBtn = node.querySelector('[data-mute]');
      const muteLed = node.querySelector('[data-mute-led]');

      thumb.setAttribute('aria-valuemin', min);
      thumb.setAttribute('aria-valuemax', max);
      thumb.setAttribute('aria-label', `${zone.name} volume`);

      // Position the ticks and the unity-gain line from the exact same
      // formula the thumb uses, so nothing can drift out of sync.
      tickTop.style.top = `${percentForDb(max, min, max)}%`;
      tickBottom.style.top = `${percentForDb(min, min, max)}%`;
      if (min <= 0 && max >= 0) {
        const unityPercent = percentForDb(0, min, max);
        tickUnity.style.top = `${unityPercent}%`;
        unity.style.top = `${unityPercent}%`;
      } else {
        tickUnity.hidden = true;
        unity.hidden = true;
      }

      const inputSelect = node.querySelector('[data-input]');
      const inputLabel = node.querySelector('[data-input-label]');
      const sourceRow = node.querySelector('.source-row');
      const inputs = zone.inputs || [];
      const hasInputs = inputs.length > 0;

      if (hasInputs) {
        const selectId = `source-${zone.id}`;
        inputSelect.id = selectId;
        inputLabel.setAttribute('for', selectId);
        for (const src of inputs) {
          const opt = document.createElement('option');
          opt.value = src.value;
          opt.textContent = src.name;
          inputSelect.appendChild(opt);
        }
        inputSelect.addEventListener('change', () => {
          sendInput(zone.id, inputSelect.value);
        });
      } else {
        sourceRow.hidden = true;
      }

      const entry = { root: node, track, thumb, readout, muteBtn, muteLed, inputSelect, hasInputs, dragging: false };
      strips.set(String(zone.id), entry);

      const moveTo = (clientY) => {
        const rect = track.getBoundingClientRect();
        const percent = ((clientY - rect.top) / rect.height) * 100;
        const db = dbForPercent(percent, min, max, step);
        setThumb(entry, db, min, max);
        throttledSend(zone.id, db);
        return db;
      };

      track.addEventListener('pointerdown', (e) => {
        entry.dragging = true;
        track.setPointerCapture(e.pointerId);
        thumb.focus();
        moveTo(e.clientY);
      });
      track.addEventListener('pointermove', (e) => {
        if (!entry.dragging) return;
        moveTo(e.clientY);
      });
      const endDrag = (e) => {
        if (!entry.dragging) return;
        entry.dragging = false;
        const db = moveTo(e.clientY);
        sendVolume(zone.id, db);
      };
      track.addEventListener('pointerup', endDrag);
      track.addEventListener('pointercancel', endDrag);

      thumb.addEventListener('keydown', (e) => {
        const current = parseFloat(readout.dataset.db || '0');
        let db = null;
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') db = current + step;
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') db = current - step;
        else if (e.key === 'PageUp') db = current + step * 10;
        else if (e.key === 'PageDown') db = current - step * 10;
        else if (e.key === 'Home') db = max;
        else if (e.key === 'End') db = min;
        if (db === null) return;
        e.preventDefault();
        db = Math.min(max, Math.max(min, db));
        setThumb(entry, db, min, max);
        sendVolume(zone.id, db);
      });

      muteBtn.addEventListener('click', () => {
        const nowMuted = !muteBtn.classList.contains('active');
        setMuteUI(entry, nowMuted);
        sendMute(zone.id, nowMuted);
      });

      rack.appendChild(node);
    }
  }

  function setThumb(entry, db, min, max) {
    entry.thumb.style.top = `${percentForDb(db, min, max)}%`;
    entry.thumb.setAttribute('aria-valuenow', db);
    entry.readout.textContent = dbText(db);
    entry.readout.dataset.db = db;
  }

  function setMuteUI(entry, muted) {
    entry.muteBtn.classList.toggle('active', !!muted);
  }

  function applyState(state, config) {
    for (const [id, entry] of strips) {
      const zs = state.zones[id] || { volumeDb: 0, muted: false, input: 0 };
      if (!entry.dragging) {
        setThumb(entry, zs.volumeDb, config.volumeMinDb, config.volumeMaxDb);
      }
      setMuteUI(entry, zs.muted);
      if (entry.hasInputs && document.activeElement !== entry.inputSelect) {
        entry.inputSelect.value = zs.input;
      }
    }
  }

  // --- throttle drag updates to avoid flooding the socket / the ZonePRO ---
  const pending = new Map();
  function throttledSend(zoneId, db) {
    if (pending.has(zoneId)) return;
    pending.set(zoneId, true);
    setTimeout(() => {
      pending.delete(zoneId);
      sendVolume(zoneId, db);
    }, 80);
  }

  function sendVolume(zoneId, db) {
    send({ type: 'volume', zone: zoneId, db });
  }

  function sendMute(zoneId, muted) {
    send({ type: 'mute', zone: zoneId, muted });
  }

  function sendInput(zoneId, value) {
    send({ type: 'input', zone: zoneId, value: Number(value) });
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function connectWs(config) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.addEventListener('open', () => setLink(true));
    ws.addEventListener('close', () => {
      setLink(false);
      setTimeout(() => connectWs(config), 2000);
    });
    ws.addEventListener('error', () => ws.close());

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'state') {
        setLink(!!msg.connected);
        applyState(msg.state, config);
      } else if (msg.type === 'status') {
        setLink(!!msg.connected);
      }
    });
  }

  async function init() {
    const config = await fetch('/api/config').then((r) => r.json());
    buildStrips(config);

    if (strips.size > 0) {
      const initial = await fetch('/api/state').then((r) => r.json());
      applyState(initial.state, config);
      setLink(!!initial.connected);
      connectWs(config);
    }
  }

  init();
})();
