/**
 * Free-fly camera with an optional hands-off cruise.
 *
 * Positions are stored in absolute world metres as JS doubles. The main loop
 * subtracts a floating render origin before writing camera.position, keeping
 * the GPU in the comfortable float range.
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class FlightController {
  constructor({ camera, canvas, heightAt, heightScale, initialSpeed = 80 }) {
    this.camera = camera;
    this.canvas = canvas;
    this.heightAt = heightAt;
    this.heightScale = heightScale;

    this.x = 0;
    this.z = 0;
    this.y = 900;
    this.yaw = 0.35;
    this.pitch = -0.08;
    this.speed = initialSpeed;
    this.autoCruise = true;
    this.cruiseTime = 0;
    this.paused = false;
    this.pointerLocked = false;
    this.keys = new Set();
    this.dragging = false;
    this.lastPointerX = 0;
    this.lastPointerY = 0;

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

    this.onAutoCruiseChange = null;
    this.onPointerLockChange = null;
    this.onSpeedChange = null;
    this.onUserInput = null;

    this.reset();
  }

  _handleKey(e, down) {
    const tag = e.target && e.target.tagName;
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

  _handleMouseMove(e) {
    if (!this.pointerLocked) return;
    this.yaw -= e.movementX * 0.0022;
    this.pitch -= e.movementY * 0.0022;
    this.pitch = clamp(this.pitch, -1.45, 1.45);
  }

  _handlePointerDown(e) {
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

  _handlePointerMove(e) {
    if (!this.dragging || this.pointerLocked) return;
    const dx = e.clientX - this.lastPointerX;
    const dy = e.clientY - this.lastPointerY;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
    this.yaw -= dx * 0.0035;
    this.pitch = clamp(this.pitch - dy * 0.0035, -1.45, 1.45);
    this._takeControl(false);
  }

  _handlePointerUp(e) {
    this.dragging = false;
    this.canvas.releasePointerCapture?.(e.pointerId);
  }

  _takeControl(disableCruise = true) {
    if (disableCruise && this.autoCruise) {
      this.autoCruise = false;
      this.onAutoCruiseChange?.(false);
    }
    this.onUserInput?.();
  }

  setAutoCruise(on) {
    this.autoCruise = on;
    if (on) {
      this.cruiseTime = 0;
      this.onAutoCruiseChange?.(true);
    }
  }

  setSpeed(speed) {
    this.speed = clamp(speed, 15, 500);
    this.onSpeedChange?.(this.speed);
  }

  setPaused(paused) {
    this.paused = paused;
  }

  groundHeight() {
    return this.heightAt(this.x, this.z) * this.heightScale;
  }

  reset() {
    this.x = 0;
    this.z = 0;
    this.yaw = 0.35;
    this.pitch = -0.08;
    this.y = this.groundHeight() + 220;
    this.cruiseTime = 0;
  }

  warpTo(x, z, y = null) {
    this.x = x;
    this.z = z;
    this.y = y === null ? this.groundHeight() + 220 : y;
    this.cruiseTime = 0;
  }

  update(dt) {
    if (this.paused) return;

    const ground = this.groundHeight();
    const shift = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) ? 3.5 : 1;

    if (this.autoCruise) {
      this.cruiseTime += dt;
      const targetYaw = 0.30 + Math.sin(this.cruiseTime * 0.035) * 0.55;
      this.yaw += (targetYaw - this.yaw) * Math.min(1, dt * 0.35);
      this.pitch += (-0.10 - this.pitch) * Math.min(1, dt * 0.6);

      const fwdX = -Math.sin(this.yaw);
      const fwdZ = -Math.cos(this.yaw);
      const cruiseSpeed = 70 * (this.speed / 80);
      this.x += fwdX * cruiseSpeed * dt;
      this.z += fwdZ * cruiseSpeed * dt;

      const targetY = ground + 180;
      this.y += (targetY - this.y) * Math.min(1, dt * 0.7);
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

    // Soft terrain guard: never fly into the ground.
    const minY = ground + 18;
    if (this.y < minY) this.y = minY;
    if (this.y > 9000) this.y = 9000;
  }

  applyCamera(camera, origin) {
    // renderOrigin is a Vector2: x and y are world x/z.
    camera.position.set(this.x - origin.x, this.y, this.z - origin.y);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  getInfo() {
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

  dispose() {
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
