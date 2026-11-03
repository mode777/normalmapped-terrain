/**
 * Thin UI layer for the infinite-terrain page. Rendering logic lives in
 * main.js; this module only binds controls and exposes state setters.
 */

const $ = (id) => document.getElementById(id);

export function initUI(cb) {
  const el = {
    loading: $('loading'),
    progressBar: $('progress-bar'),
    loadingStatus: $('loading-status'),
    titleCard: $('title-card'),
    stats: $('stats'),
    panel: $('panel'),
    footnote: $('footnote'),
    statFps: $('stat-fps'),
    statTris: $('stat-tris'),
    statCalls: $('stat-calls'),
    statAlt: $('stat-alt'),
    statSpeed: $('stat-speed'),
    statTiles: $('stat-tiles'),
    statQueue: $('stat-queue'),
    statPos: $('stat-pos'),
    sunAz: $('sun-azimuth'),
    sunEl: $('sun-elevation'),
    sunAzVal: $('sun-azimuth-val'),
    sunElVal: $('sun-elevation-val'),
    normalStrength: $('normal-strength'),
    normalStrengthVal: $('normal-strength-val'),
    wireframe: $('wireframe'),
    lodDebug: $('lod-debug'),
    tileDebug: $('tile-debug'),
    autoCruise: $('auto-cruise'),
    cruiseSpeed: $('cruise-speed'),
    cruiseSpeedVal: $('cruise-speed-val'),
    resetFlight: $('reset-flight'),
    panelToggle: $('panel-toggle'),
    flightHint: $('flight-hint'),
    pointerHint: $('pointer-hint'),
    tileStatus: $('tile-status'),
  };

  // ---- sliders ------------------------------------------------------------
  const onSun = () => {
    el.sunAzVal.textContent = `${el.sunAz.value}°`;
    el.sunElVal.textContent = `${el.sunEl.value}°`;
    cb.onSunChange(+el.sunAz.value, +el.sunEl.value);
  };
  el.sunAz.addEventListener('input', onSun);
  el.sunEl.addEventListener('input', onSun);

  el.normalStrength.addEventListener('input', () => {
    el.normalStrengthVal.textContent = `${(+el.normalStrength.value).toFixed(2)}×`;
    cb.onNormalStrength(+el.normalStrength.value);
  });

  el.cruiseSpeed.addEventListener('input', () => {
    el.cruiseSpeedVal.textContent = `${el.cruiseSpeed.value} m/s`;
    cb.onSpeedChange(+el.cruiseSpeed.value);
  });

  // ---- toggles ------------------------------------------------------------
  el.wireframe.addEventListener('change', () => cb.onWireframe(el.wireframe.checked));
  el.lodDebug.addEventListener('change', () => cb.onLodDebug(el.lodDebug.checked));
  el.tileDebug.addEventListener('change', () => cb.onTileDebug(el.tileDebug.checked));
  el.autoCruise.addEventListener('change', () => cb.onAutoCruise(el.autoCruise.checked));
  el.resetFlight.addEventListener('click', () => cb.onReset());

  // ---- panel collapse -----------------------------------------------------
  el.panelToggle.addEventListener('click', () => {
    const collapsed = el.panel.classList.toggle('collapsed');
    el.panelToggle.textContent = collapsed ? '+' : '–';
  });

  if (window.matchMedia && window.matchMedia('(max-width: 760px)').matches) {
    el.panel.classList.add('collapsed');
    el.panelToggle.textContent = '+';
  }

  // ---- toast --------------------------------------------------------------
  const toast = document.createElement('div');
  toast.className = 'glass chip';
  toast.id = 'toast';
  toast.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:50;padding:9px 16px;font-size:.78rem;color:var(--text-dim);display:none;';
  document.body.appendChild(toast);
  let toastTimer = null;
  function showToast(text, sticky = false) {
    toast.textContent = text;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 1800);
  }

  return {
    setLoading(pct, text) {
      el.progressBar.style.width = `${Math.round(pct * 100)}%`;
      if (text) el.loadingStatus.textContent = text;
    },
    hideLoading() {
      el.loading.classList.add('done');
      setTimeout(() => el.loading.remove(), 700);
      for (const n of [el.titleCard, el.stats, el.panel, el.footnote]) n?.classList.remove('hidden');
      el.flightHint?.classList.remove('hidden');
    },
    setStats({ fps, tris, calls, alt, speed, tiles, queue, pos }) {
      el.statFps.textContent = fps;
      el.statTris.textContent = tris;
      el.statCalls.textContent = calls;
      el.statAlt.textContent = alt;
      el.statSpeed.textContent = speed;
      el.statTiles.textContent = tiles;
      el.statQueue.textContent = queue;
      el.statPos.textContent = pos;
    },
    setAutoCruise(on) {
      el.autoCruise.checked = on;
    },
    setSpeed(speed) {
      el.cruiseSpeed.value = Math.round(speed);
      el.cruiseSpeedVal.textContent = `${Math.round(speed)} m/s`;
    },
    setPointerLock(locked) {
      el.pointerHint?.classList.toggle('hidden', locked);
      if (locked) el.flightHint?.classList.add('hidden');
    },
    setTileStatus(text) {
      if (el.tileStatus) el.tileStatus.textContent = text;
    },
    toast: showToast,
  };
}
