/**
 * Thin UI layer for the infinite-terrain page. Rendering logic lives in
 * main.ts; this module only binds controls and exposes state setters.
 */

import type { MaterialMode } from './renderer.ts';

export interface UICallbacks {
  onSunChange(azimuth: number, elevation: number): void;
  onNormalStrength(strength: number): void;
  onDetailStrength(strength: number): void;
  onSpeedChange(speed: number): void;
  onWireframe(on: boolean): void;
  onLodDebug(on: boolean): void;
  onTileDebug(on: boolean): void;
  onAutoCruise(on: boolean): void;
  onReset(): void;
  onMaterialMode?(mode: MaterialMode): void;
  onHeightBlend?(value: number): void;
  onMaterialNormalStrength?(value: number): void;
}

export interface UIStats {
  fps: number;
  tris: string;
  calls: number;
  alt: string;
  speed: number;
  tiles: number;
  queue: number;
  pos: string;
}

export interface UIApi {
  setLoading(pct: number, text?: string): void;
  hideLoading(): void;
  setStats(stats: UIStats): void;
  setAutoCruise(on: boolean): void;
  setSpeed(speed: number): void;
  setPointerLock(locked: boolean): void;
  setTileStatus(text: string): void;
  toast(text: string, sticky?: boolean): void;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function optionalById<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

interface UIElements {
  loading: HTMLDivElement;
  progressBar: HTMLDivElement;
  loadingStatus: HTMLParagraphElement;
  titleCard: HTMLElement;
  stats: HTMLDivElement;
  panel: HTMLElement;
  footnote: HTMLElement;
  statFps: HTMLElement;
  statTris: HTMLElement;
  statCalls: HTMLElement;
  statAlt: HTMLElement;
  statSpeed: HTMLElement;
  statTiles: HTMLElement;
  statQueue: HTMLElement;
  statPos: HTMLElement;
  sunAz: HTMLInputElement;
  sunEl: HTMLInputElement;
  sunAzVal: HTMLSpanElement;
  sunElVal: HTMLSpanElement;
  normalStrength: HTMLInputElement;
  normalStrengthVal: HTMLSpanElement;
  detailStrength: HTMLInputElement;
  detailStrengthVal: HTMLSpanElement;
  materialMode: HTMLSelectElement | null;
  heightBlend: HTMLInputElement | null;
  heightBlendVal: HTMLSpanElement | null;
  materialNormalStrength: HTMLInputElement | null;
  materialNormalStrengthVal: HTMLSpanElement | null;
  wireframe: HTMLInputElement;
  lodDebug: HTMLInputElement;
  tileDebug: HTMLInputElement;
  autoCruise: HTMLInputElement;
  cruiseSpeed: HTMLInputElement;
  cruiseSpeedVal: HTMLSpanElement;
  resetFlight: HTMLButtonElement;
  panelToggle: HTMLButtonElement;
  flightHint: HTMLElement;
  pointerHint: HTMLElement | null;
  tileStatus: HTMLParagraphElement | null;
}

export function initUI(cb: UICallbacks): UIApi {
  const el: UIElements = {
    loading: byId<HTMLDivElement>('loading'),
    progressBar: byId<HTMLDivElement>('progress-bar'),
    loadingStatus: byId<HTMLParagraphElement>('loading-status'),
    titleCard: byId<HTMLElement>('title-card'),
    stats: byId<HTMLDivElement>('stats'),
    panel: byId<HTMLElement>('panel'),
    footnote: byId<HTMLElement>('footnote'),
    statFps: byId<HTMLElement>('stat-fps'),
    statTris: byId<HTMLElement>('stat-tris'),
    statCalls: byId<HTMLElement>('stat-calls'),
    statAlt: byId<HTMLElement>('stat-alt'),
    statSpeed: byId<HTMLElement>('stat-speed'),
    statTiles: byId<HTMLElement>('stat-tiles'),
    statQueue: byId<HTMLElement>('stat-queue'),
    statPos: byId<HTMLElement>('stat-pos'),
    sunAz: byId<HTMLInputElement>('sun-azimuth'),
    sunEl: byId<HTMLInputElement>('sun-elevation'),
    sunAzVal: byId<HTMLSpanElement>('sun-azimuth-val'),
    sunElVal: byId<HTMLSpanElement>('sun-elevation-val'),
    normalStrength: byId<HTMLInputElement>('normal-strength'),
    normalStrengthVal: byId<HTMLSpanElement>('normal-strength-val'),
    detailStrength: byId<HTMLInputElement>('detail-strength'),
    detailStrengthVal: byId<HTMLSpanElement>('detail-strength-val'),
    materialMode: optionalById<HTMLSelectElement>('material-mode'),
    heightBlend: optionalById<HTMLInputElement>('height-blend'),
    heightBlendVal: optionalById<HTMLSpanElement>('height-blend-val'),
    materialNormalStrength: optionalById<HTMLInputElement>('material-normal-strength'),
    materialNormalStrengthVal: optionalById<HTMLSpanElement>('material-normal-strength-val'),
    wireframe: byId<HTMLInputElement>('wireframe'),
    lodDebug: byId<HTMLInputElement>('lod-debug'),
    tileDebug: byId<HTMLInputElement>('tile-debug'),
    autoCruise: byId<HTMLInputElement>('auto-cruise'),
    cruiseSpeed: byId<HTMLInputElement>('cruise-speed'),
    cruiseSpeedVal: byId<HTMLSpanElement>('cruise-speed-val'),
    resetFlight: byId<HTMLButtonElement>('reset-flight'),
    panelToggle: byId<HTMLButtonElement>('panel-toggle'),
    flightHint: byId<HTMLElement>('flight-hint'),
    pointerHint: optionalById<HTMLElement>('pointer-hint'),
    tileStatus: optionalById<HTMLParagraphElement>('tile-status'),
  };

  // ---- sliders ------------------------------------------------------------
  const onSun = (): void => {
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

  el.detailStrength.addEventListener('input', () => {
    el.detailStrengthVal.textContent = `${(+el.detailStrength.value).toFixed(2)}×`;
    cb.onDetailStrength(+el.detailStrength.value);
  });

  el.materialMode?.addEventListener('change', () => {
    const mode = el.materialMode?.value;
    if (mode === 'on' || mode === 'off' || mode === 'debug') cb.onMaterialMode?.(mode);
  });

  el.heightBlend?.addEventListener('input', () => {
    const value = +el.heightBlend!.value;
    if (el.heightBlendVal) el.heightBlendVal.textContent = `${value.toFixed(2)}×`;
    cb.onHeightBlend?.(value);
  });

  el.materialNormalStrength?.addEventListener('input', () => {
    const value = +el.materialNormalStrength!.value;
    if (el.materialNormalStrengthVal) {
      el.materialNormalStrengthVal.textContent = `${value.toFixed(2)}×`;
    }
    cb.onMaterialNormalStrength?.(value);
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
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function showToast(text: string, sticky = false): void {
    toast.textContent = text;
    toast.style.display = 'block';
    if (toastTimer !== null) clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 1800);
  }

  return {
    setLoading(pct: number, text?: string): void {
      el.progressBar.style.width = `${Math.round(pct * 100)}%`;
      if (text) el.loadingStatus.textContent = text;
    },
    hideLoading(): void {
      el.loading.classList.add('done');
      setTimeout(() => el.loading.remove(), 700);
      for (const n of [el.titleCard, el.stats, el.panel, el.footnote]) n?.classList.remove('hidden');
      el.flightHint?.classList.remove('hidden');
    },
    setStats({ fps, tris, calls, alt, speed, tiles, queue, pos }: UIStats): void {
      el.statFps.textContent = String(fps);
      el.statTris.textContent = tris;
      el.statCalls.textContent = String(calls);
      el.statAlt.textContent = alt;
      el.statSpeed.textContent = String(speed);
      el.statTiles.textContent = String(tiles);
      el.statQueue.textContent = String(queue);
      el.statPos.textContent = pos;
    },
    setAutoCruise(on: boolean): void {
      el.autoCruise.checked = on;
    },
    setSpeed(speed: number): void {
      el.cruiseSpeed.value = String(Math.round(speed));
      el.cruiseSpeedVal.textContent = `${Math.round(speed)} m/s`;
    },
    setPointerLock(locked: boolean): void {
      el.pointerHint?.classList.toggle('hidden', locked);
      if (locked) el.flightHint?.classList.add('hidden');
    },
    setTileStatus(text: string): void {
      if (el.tileStatus) el.tileStatus.textContent = text;
    },
    toast: showToast,
  };
}
