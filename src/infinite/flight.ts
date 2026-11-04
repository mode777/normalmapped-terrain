/**
 * Free-fly camera with an optional hands-off cruise.
 *
 * Positions are stored in absolute world metres as JS doubles. The main loop
 * subtracts a floating render origin before writing camera.position, keeping
 * the GPU in the comfortable float range.
 */

import type * as THREE from 'three';

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

export interface FlightView {
  x: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Metres above the terrain; defaults to 220. */
  altitude?: number;
}

export interface FlightControllerOptions {
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  heightAt: (x: number, z: number) => number;
  heightScale: number;
  initialSpeed?: number;
  /** Soft circular bound for free flight and the orbit mode. */
  boundsRadius?: number;
  /** Orbit radius; defaults to 75% of boundsRadius. */
  orbitRadius?: number;
  cruiseMode?: 'wander' | 'orbit';
  /** Metres above ground used by orbit mode; defaults to 180. */
  cruiseAltitude?: number;
  defaultView?: FlightView;
}

export interface FlightInfo {
  x: number;
  z: number;
  y: number;
  speed: number;
  altitude: number;
  autoCruise: boolean;
  yaw: number;
  pitch: number;
}

export class FlightController {
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly heightAt: (x: number, z: number) => number;
  readonly heightScale: number;
  readonly boundsRadius: number | null;
  readonly orbitRadius: number;
  readonly cruiseMode: 'wander' | 'orbit';
  readonly cruiseAltitude: number;
  readonly defaultView: FlightView | null;

  x = 0;
  z = 0;
  y = 900;
  yaw = 0.35;
  pitch = -0.08;
  speed: number;
  autoCruise = true;
  cruiseTime = 0;
  cruiseAngle = 0;
  paused = false;
  pointerLocked = false;
  keys = new Set<string>();
  dragging = false;
  lastPointerX = 0;
  lastPointerY = 0;

  onAutoCruiseChange: ((on: boolean) => void) | null = null;
  onPointerLockChange: ((locked: boolean) => void) | null = null;
  onSpeedChange: ((speed: number) => void) | null = null;
  onUserInput: (() => void) | null = null;

  private readonly _onKeyDown: (e: KeyboardEvent) => void;
  private readonly _onKeyUp: (e: KeyboardEvent) => void;
  private readonly _onMouseMove: (e: MouseEvent) => void;
  private readonly _onPointerDown: (e: PointerEvent) => void;
  private readonly _onPointerMove: (e: PointerEvent) => void;
  private readonly _onPointerUp: (e: PointerEvent) => void;
  private readonly _onPointerLockChange: () => void;
  private readonly _onWheel: (e: WheelEvent) => void;

  constructor({
    camera,
    canvas,
    heightAt,
    heightScale,
    initialSpeed = 80,
    boundsRadius,
    orbitRadius,
    cruiseMode = 'wander',
    cruiseAltitude = 180,
    defaultView,
  }: FlightControllerOptions) {
    this.camera = camera;
    this.canvas = canvas;
    this.heightAt = heightAt;
    this.heightScale = heightScale;
    this.speed = initialSpeed;
    this.boundsRadius = boundsRadius ?? null;
    this.orbitRadius = orbitRadius ?? (boundsRadius !== undefined ? boundsRadius * 0.75 : 0);
    this.cruiseMode = cruiseMode;
    this.cruiseAltitude = cruiseAltitude;
    this.defaultView = defaultView ?? null;

    this._onKeyDown = (e) => this._handleKey(e, true);
    this._onKeyUp = (e) => this._handleKey(e, false);
    this._onMouseMove = (e) => this._handleMouseMove(e);
    this._onPointerDown = (e) => this._handlePointerDown(e);
    this._onPointerMove = (e) => this._handlePointerMove(e);
    this._onPointerUp = (e) => this._handlePointerUp(e);
    this._onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (this.pointerLocked) {
        this.autoCruise = false;
        this.onAutoCruiseChange?.(false);
      }
      this.onPointerLockChange?.(this.pointerLocked);
    };
    this._onWheel = (e) => {
      if (e.target !== this.canvas) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0012);
      this.speed = clamp(this.speed * factor, 15, 500);
      this.onSpeedChange?.(this.speed);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });

    this.reset();
  }

  private _handleKey(e: KeyboardEvent, down: boolean): void {
    const tag = e.target instanceof HTMLElement ? e.target.tagName : '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;

    const code = e.code;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'].includes(code)) {
      if (down) {
        this.keys.add(code);
        if (!this.pointerLocked) this._takeControl();
      } else {
        this.keys.delete(code);
      }
      e.preventDefault();
    }
  }

  private _handleMouseMove(e: MouseEvent): void {
    if (!this.pointerLocked) return;
    this.yaw -= e.movementX * 0.0022;
    this.pitch -= e.movementY * 0.0022;
    this.pitch = clamp(this.pitch, -1.45, 1.45);
  }

  private _handlePointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && !this.pointerLocked && document.pointerLockElement !== this.canvas) {
      // Click-to-capture. If pointer lock is unavailable, drag-look below
      // still works.
      this.canvas.requestPointerLock?.();
      this._takeControl();
    }

    if (e.pointerType !== 'mouse' || !this.pointerLocked) {
      this.dragging = true;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      this.canvas.setPointerCapture?.(e.pointerId);
    }
  }

  private _handlePointerMove(e: PointerEvent): void {
    if (!this.dragging || this.pointerLocked) return;
    const dx = e.clientX - this.lastPointerX;
    const dy = e.clientY - this.lastPointerY;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
    this.yaw -= dx * 0.0035;
    this.pitch = clamp(this.pitch - dy * 0.0035, -1.45, 1.45);
    this._takeControl(false);
  }

  private _handlePointerUp(e: PointerEvent): void {
    this.dragging = false;
    this.canvas.releasePointerCapture?.(e.pointerId);
  }

  private _takeControl(disableCruise = true): void {
    if (disableCruise && this.autoCruise) {
      this.autoCruise = false;
      this.onAutoCruiseChange?.(false);
    }
    this.onUserInput?.();
  }

  setAutoCruise(on: boolean): void {
    this.autoCruise = on;
    if (on) {
      this.cruiseTime = 0;
      this.cruiseAngle = Math.atan2(this.z, this.x);
      this.onAutoCruiseChange?.(true);
    }
  }

  setSpeed(speed: number): void {
    this.speed = clamp(speed, 15, 500);
    this.onSpeedChange?.(this.speed);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  groundHeight(): number {
    return this.heightAt(this.x, this.z) * this.heightScale;
  }

  reset(): void {
    const view = this.defaultView;
    this.x = view?.x ?? 0;
    this.z = view?.z ?? 0;
    this.yaw = view?.yaw ?? 0.35;
    this.pitch = view?.pitch ?? -0.08;
    this.y = this.groundHeight() + (view?.altitude ?? 220);
    this.cruiseTime = 0;
    this.cruiseAngle = Math.atan2(this.z, this.x);
  }

  warpTo(x: number, z: number, y: number | null = null): void {
    this.x = x;
    this.z = z;
    this.y = y === null ? this.groundHeight() + 220 : y;
    this.cruiseTime = 0;
    this.cruiseAngle = Math.atan2(this.z, this.x);
  }

  update(dt: number): void {
    if (this.paused) return;

    const ground = this.groundHeight();
    const shift = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) ? 3.5 : 1;

    if (this.autoCruise) {
      this.cruiseTime += dt;
      const cruiseSpeed = 70 * (this.speed / 80);
      if (this.cruiseMode === 'orbit' && this.orbitRadius > 0) {
        this.cruiseAngle += cruiseSpeed * dt / this.orbitRadius;
        this.x = Math.cos(this.cruiseAngle) * this.orbitRadius;
        this.z = Math.sin(this.cruiseAngle) * this.orbitRadius;
        // Look inward at the massif while moving around it.
        const targetYaw = Math.PI / 2 - this.cruiseAngle;
        this.yaw += (targetYaw - this.yaw) * Math.min(1, dt * 1.5);
        this.pitch += (-0.18 - this.pitch) * Math.min(1, dt * 0.8);
        const targetY = ground + this.cruiseAltitude;
        this.y += (targetY - this.y) * Math.min(1, dt * 0.7);
      } else {
        const targetYaw = 0.30 + Math.sin(this.cruiseTime * 0.035) * 0.55;
        this.yaw += (targetYaw - this.yaw) * Math.min(1, dt * 0.35);
        this.pitch += (-0.10 - this.pitch) * Math.min(1, dt * 0.6);

        const fwdX = -Math.sin(this.yaw);
        const fwdZ = -Math.cos(this.yaw);
        this.x += fwdX * cruiseSpeed * dt;
        this.z += fwdZ * cruiseSpeed * dt;

        const targetY = ground + this.cruiseAltitude;
        this.y += (targetY - this.y) * Math.min(1, dt * 0.7);
      }
    } else {
      const cosPitch = Math.cos(this.pitch);
      const fwdX = -Math.sin(this.yaw) * cosPitch;
      const fwdY = Math.sin(this.pitch);
      const fwdZ = -Math.cos(this.yaw) * cosPitch;
      const rightX = Math.cos(this.yaw);
      const rightZ = -Math.sin(this.yaw);

      let mx = 0, my = 0, mz = 0;
      if (this.keys.has('KeyW')) { mx += fwdX; my += fwdY; mz += fwdZ; }
      if (this.keys.has('KeyS')) { mx -= fwdX; my -= fwdY; mz -= fwdZ; }
      if (this.keys.has('KeyD')) { mx += rightX; mz += rightZ; }
      if (this.keys.has('KeyA')) { mx -= rightX; mz -= rightZ; }
      if (this.keys.has('KeyE')) my += 1;
      if (this.keys.has('KeyQ')) my -= 1;

      const len = Math.hypot(mx, my, mz);
      if (len > 0) {
        const step = this.speed * shift * dt / len;
        this.x += mx * step;
        this.z += mz * step;
        this.y += my * step;
      }
    }

    if (this.boundsRadius !== null) {
      const radius = Math.hypot(this.x, this.z);
      if (radius > this.boundsRadius) {
        const scale = this.boundsRadius / radius;
        this.x *= scale;
        this.z *= scale;
      }
    }

    // Soft terrain guard: never fly into the ground.
    const minY = ground + 18;
    if (this.y < minY) this.y = minY;
    if (this.y > 9000) this.y = 9000;
  }

  applyCamera(camera: THREE.PerspectiveCamera, origin: THREE.Vector2): void {
    // renderOrigin is a Vector2: x and y are world x/z.
    camera.position.set(this.x - origin.x, this.y, this.z - origin.y);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  getInfo(): FlightInfo {
    return {
      x: this.x,
      z: this.z,
      y: this.y,
      speed: this.speed,
      altitude: this.y - this.groundHeight(),
      autoCruise: this.autoCruise,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  dispose(): void {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('wheel', this._onWheel);
  }
}
