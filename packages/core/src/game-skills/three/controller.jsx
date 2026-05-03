// when_to_use: Gamepad / controller support for a Three.js game.
// Wraps the browser Gamepad API with deadzones, named-button mapping
// (Xbox/PS standard layout), connect/disconnect tracking, and an
// optional vibration helper. Read state synchronously per tick — the
// Gamepad API does NOT push events for stick/button changes, only for
// connect/disconnect.

const STANDARD_BUTTON_NAMES = [
  'a',
  'b',
  'x',
  'y', // 0-3: face buttons (Xbox layout; PS users see ✕○□△)
  'lb',
  'rb', // 4-5: shoulder bumpers
  'lt',
  'rt', // 6-7: triggers (digital — analog values come from buttons[6/7].value)
  'select',
  'start', // 8-9: back/select + start/menu
  'l3',
  'r3', // 10-11: stick clicks
  'up',
  'down',
  'left',
  'right', // 12-15: d-pad
  'home', // 16: guide / home button (some browsers omit)
];

export function createController({ deadzone = 0.15 } = {}) {
  // Track per-button "just pressed" / "just released" edges between polls
  // so caller can ask `wasPressed('a')` regardless of frame timing.
  const lastButtonState = new Array(STANDARD_BUTTON_NAMES.length).fill(false);
  const justPressed = new Set();
  const justReleased = new Set();
  let connected = false;

  function onConnect(e) {
    connected = true;
    window.dispatchEvent(
      new CustomEvent('game:gamepad:connected', { detail: { id: e.gamepad.id } }),
    );
  }
  function onDisconnect() {
    connected = false;
    lastButtonState.fill(false);
    window.dispatchEvent(new CustomEvent('game:gamepad:disconnected'));
  }
  window.addEventListener('gamepadconnected', onConnect);
  window.addEventListener('gamepaddisconnected', onDisconnect);

  // Apply a radial deadzone to a stick (axes 0/1 = left, axes 2/3 = right).
  // Below the threshold returns 0/0; above, smoothly remaps so input
  // begins at 0 at the boundary, not at the threshold itself (avoids the
  // "stick snaps to 0.15 magnitude" feel).
  function applyDeadzone(x, y) {
    const mag = Math.hypot(x, y);
    if (mag < deadzone) return [0, 0];
    const scale = (mag - deadzone) / (1 - deadzone) / mag;
    return [x * scale, y * scale];
  }

  function poll() {
    const pads = navigator.getGamepads?.();
    const pad = pads?.[0];
    if (!pad) {
      if (connected) onDisconnect();
      return null;
    }
    // Edge tracking — must run BEFORE caller reads wasPressed/wasReleased.
    for (let i = 0; i < pad.buttons.length && i < lastButtonState.length; i += 1) {
      const pressedNow = pad.buttons[i]?.pressed ?? false;
      const wasPressed = lastButtonState[i];
      const name = STANDARD_BUTTON_NAMES[i] ?? `b${i}`;
      if (pressedNow && !wasPressed) justPressed.add(name);
      if (!pressedNow && wasPressed) justReleased.add(name);
      lastButtonState[i] = pressedNow;
    }
    const [lx, ly] = applyDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    const [rx, ry] = applyDeadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
    return {
      id: pad.id,
      // Boolean snapshot keyed by name (stable for if-chains).
      buttons: Object.fromEntries(
        STANDARD_BUTTON_NAMES.map((name, i) => [name, pad.buttons[i]?.pressed ?? false]),
      ),
      // Analog trigger values (0..1). Useful for racing / shooting.
      lt: pad.buttons[6]?.value ?? 0,
      rt: pad.buttons[7]?.value ?? 0,
      // Sticks already deadzone-corrected. Y is positive-down on most
      // controllers; flip in your update loop if your world uses y-up.
      leftStick: { x: lx, y: ly },
      rightStick: { x: rx, y: ry },
    };
  }

  // Optional rumble. `vibrationActuator.playEffect` is widely supported on
  // Chromium; older Firefox builds don't expose it — silently no-op.
  function rumble(durationMs = 200, weakMagnitude = 0.5, strongMagnitude = 0.5) {
    const pad = navigator.getGamepads?.()?.[0];
    pad?.vibrationActuator?.playEffect?.('dual-rumble', {
      duration: durationMs,
      weakMagnitude,
      strongMagnitude,
    });
  }

  return {
    poll,
    rumble,
    isConnected: () => connected,
    wasPressed: (name) => justPressed.has(name),
    wasReleased: (name) => justReleased.has(name),
    /** Call at the end of each tick after reading wasPressed/wasReleased. */
    flush() {
      justPressed.clear();
      justReleased.clear();
    },
    dispose() {
      window.removeEventListener('gamepadconnected', onConnect);
      window.removeEventListener('gamepaddisconnected', onDisconnect);
    },
  };
}

// Usage:
//   const ctrl = createController({ deadzone: 0.15 });
//   function update(dt) {
//     const state = ctrl.poll();
//     if (state) {
//       player.x += state.leftStick.x * speed * dt;
//       player.z += state.leftStick.y * speed * dt;
//       if (ctrl.wasPressed('a')) player.jump();
//       if (state.buttons.rt) player.fire();
//     }
//     ctrl.flush();
//   }
//   // On hit: ctrl.rumble(150, 0.4, 0.8);
