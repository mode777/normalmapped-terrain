/**
 * Thin UI layer: binds DOM controls, exposes state setters.
 * All rendering logic lives in main.js.
 */

const $ = (id) => document.getElementById(id);

export function initUI(cb) {
  const el = {
    loading: $('loading'), progressBar: $('progress-bar'), loadingStatus: $('loading-status'),
    titleCard: $('title-card'), stats: $('stats'), modeBar: $('mode-bar'),
    panel: $('panel'), footnote: $('footnote'),
    statFps: $('stat-fps'), statTris: $('stat-tris'), statMesh: $('stat-mesh'), statMap: $('stat-map'),
    pipeRes: $('pipe-res'), trisA: $('tris-A'), trisC: $('tris-C'),
    datasetSelect: $('dataset-select'), datasetInfo: $('dataset-info'), datasetCredit: $('dataset-credit'),
    sunAz: $('sun-azimuth'), sunEl: $('sun-elevation'),
    sunAzVal: $('sun-azimuth-val'), sunElVal: $('sun-elevation-val'),
    meshRes: $('mesh-res'), meshResVal: $('mesh-res-val'),
    normalStrength: $('normal-strength'), normalStrengthVal: $('normal-strength-val'),
    wireframe: $('wireframe'),
    previewHeight: $('preview-height'), previewNormal: $('preview-normal'),
    divider: $('split-divider'),
    panelToggle: $('panel-toggle'),
  };

  // ---- mode bar ---------------------------------------------------------
  el.modeBar.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.modeBar.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      cb.onModeChange(btn.dataset.mode);
    });
  });

  // ---- dataset ------------------------------------------------------------
  el.datasetSelect.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      el.datasetSelect.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      cb.onDatasetChange(btn.dataset.ds);
    });
  });

  // ---- sliders -------------------------------------------------------------
  el.sunAz.addEventListener('input', () => {
    el.sunAzVal.textContent = `${el.sunAz.value}°`;
    cb.onSunChange(+el.sunAz.value, +el.sunEl.value);
  });
  el.sunEl.addEventListener('input', () => {
    el.sunElVal.textContent = `${el.sunEl.value}°`;
    cb.onSunChange(+el.sunAz.value, +el.sunEl.value);
  });
  el.meshRes.addEventListener('input', () => {
    el.meshResVal.textContent = `${el.meshRes.value}²`;
    cb.onMeshResChange(+el.meshRes.value);
  });
  el.normalStrength.addEventListener('input', () => {
    el.normalStrengthVal.textContent = `${(+el.normalStrength.value).toFixed(2)}×`;
    cb.onNormalStrength(+el.normalStrength.value);
  });
  el.wireframe.addEventListener('change', () => cb.onWireframe(el.wireframe.checked));

  // ---- panel collapse -------------------------------------------------------
  el.panelToggle.addEventListener('click', () => {
    const collapsed = el.panel.classList.toggle('collapsed');
    el.panelToggle.textContent = collapsed ? '+' : '–';
  });

  // ---- split divider drag -----------------------------------------------------
  const line = el.divider.querySelector('.divider-line');
  const handle = el.divider.querySelector('.divider-handle');
  const labelL = el.divider.querySelector('.split-label.left');
  const labelR = el.divider.querySelector('.split-label.right');

  function positionSplit(ratio) {
    const x = (ratio * 100).toFixed(3) + '%';
    line.style.left = x;
    handle.style.left = x;
    labelL.style.left = `calc(${x} - 148px)`;
    labelR.style.left = `calc(${x} + 108px)`;
    labelR.style.right = 'auto';
  }
  positionSplit(0.5);

  let dragging = false;
  const startDrag = (e) => { dragging = true; e.preventDefault(); };
  handle.addEventListener('pointerdown', startDrag);
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = Math.min(0.9, Math.max(0.1, e.clientX / window.innerWidth));
    positionSplit(r);
    cb.onSplitChange(r);
  });
  window.addEventListener('pointerup', () => { dragging = false; });

  // ---- toast ---------------------------------------------------------------------
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

  // ---- API -----------------------------------------------------------------------
  return {
    setLoading(pct, text) {
      el.progressBar.style.width = `${Math.round(pct * 100)}%`;
      if (text) el.loadingStatus.textContent = text;
    },
    hideLoading() {
      el.loading.classList.add('done');
      setTimeout(() => el.loading.remove(), 700);
      for (const n of [el.titleCard, el.stats, el.modeBar, el.panel, el.footnote]) n.classList.remove('hidden');
    },
    setStats({ fps, tris, mesh, map }) {
      el.statFps.textContent = fps;
      el.statTris.textContent = tris;
      el.statMesh.textContent = mesh;
      el.statMap.textContent = map;
    },
    setPipelineRes(text) { el.pipeRes.textContent = text; },
    setTriLabels({ low, ref }) {
      el.trisA.textContent = low;
      el.trisC.textContent = ref;
    },
    setDatasetInfo(lines, credit) {
      el.datasetInfo.innerHTML = lines.map(l => `${l}<br>`).join('');
      el.datasetCredit.textContent = credit;
    },
    setPreviews(heightRGBA, normalRGBA, res) {
      drawPreview(el.previewHeight, heightRGBA, res);
      drawPreview(el.previewNormal, normalRGBA, res);
    },
    showSplit(show) {
      el.divider.classList.toggle('hidden', !show);
    },
    toast: showToast,
    get splitHandle() { return handle; },
  };
}

function drawPreview(canvas, rgba, res) {
  const full = document.createElement('canvas');
  full.width = res; full.height = res;
  const fctx = full.getContext('2d');
  fctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), res, res), 0, 0);
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(full, 0, 0, size, size);
}
