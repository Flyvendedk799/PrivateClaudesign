// when_to_use: Gamepad / controller support for a Phaser scene. Wraps
// Phaser's input.gamepad plugin with deadzones, named-button mapping
// (Xbox/PS standard), connect/disconnect events, and an optional
// vibration helper. Call `setupController(this)` inside `create()`.
//
// IMPORTANT: gamepad input requires `input: { gamepad: true }` in your
// game config — Phaser disables it by default to avoid touching the
// browser API on first user gesture. Add it in the Phaser.Game config:
//
//   const game = new Phaser.Game({
//     ...,
//     input: { gamepad: true },
//   });

import Phaser from 'phaser';

const STANDARD_BUTTONS = [
  'a',
  'b',
  'x',
  'y',
  'lb',
  'rb',
  'lt',
  'rt',
  'select',
  'start',
  'l3',
  'r3',
  'up',
  'down',
  'left',
  'right',
  'home',
];

export function setupController(scene, { deadzone = 0.15 } = {}) {
  // Phaser's gamepad plugin lazily creates Pad objects on first connect.
  // We track the FIRST pad only (most game briefs need single-player
  // input); extending to multiple pads is `scene.input.gamepad.pad2/3/4`.
  let pad = scene.input.gamepad?.pad1 ?? null;
  const justPressed = new Set();
  const justReleased = new Set();
  const lastState = new Array(STANDARD_BUTTONS.length).fill(false);

  scene.input.gamepad?.once('connected', (newPad) => {
    pad = newPad;
    scene.events.emit('controller:connected', { id: newPad.id });
  });
  scene.input.gamepad?.on('disconnected', (gone) => {
    if (gone === pad) {
      pad = null;
      lastState.fill(false);
      scene.events.emit('controller:disconnected');
    }
  });

  // Radial deadzone — see Three.js controller skill for the rationale.
  // Phaser's pad.leftStick / rightStick already return Vector2 with
  // magnitude, but it doesn't apply a deadzone for you.
  function applyDeadzone(vec) {
    const mag = vec.length();
    if (mag < deadzone) return new Phaser.Math.Vector2(0, 0);
    const scale = (mag - deadzone) / (1 - deadzone) / mag;
    return new Phaser.Math.Vector2(vec.x * scale, vec.y * scale);
  }

  function poll() {
    if (pad === null || !pad.connected) return null;
    // Edge tracking. Phaser's pad.A / pad.B etc are convenience getters
    // that read .buttons[0].pressed; we reuse them via name lookup.
    for (let i = 0; i < pad.buttons.length && i < STANDARD_BUTTONS.length; i += 1) {
      const pressedNow = pad.buttons[i]?.pressed ?? false;
      const name = STANDARD_BUTTONS[i] ?? `b${i}`;
      if (pressedNow && !lastState[i]) justPressed.add(name);
      if (!pressedNow && lastState[i]) justReleased.add(name);
      lastState[i] = pressedNow;
    }
    const left = applyDeadzone(pad.leftStick);
    const right = applyDeadzone(pad.rightStick);
    return {
      id: pad.id,
      buttons: Object.fromEntries(
        STANDARD_BUTTONS.map((name, i) => [name, pad.buttons[i]?.pressed ?? false]),
      ),
      // Phaser exposes triggers as buttons[6/7].value (analog 0..1).
      lt: pad.buttons[6]?.value ?? 0,
      rt: pad.buttons[7]?.value ?? 0,
      leftStick: { x: left.x, y: left.y },
      rightStick: { x: right.x, y: right.y },
    };
  }

  function rumble(durationMs = 200, weakMagnitude = 0.5, strongMagnitude = 0.5) {
    // Phaser doesn't wrap the vibrationActuator API directly — fall
    // through to the underlying browser pad object via pad.pad.
    pad?.pad?.vibrationActuator?.playEffect?.('dual-rumble', {
      duration: durationMs,
      weakMagnitude,
      strongMagnitude,
    });
  }

  return {
    poll,
    rumble,
    isConnected: () => pad?.connected ?? false,
    wasPressed: (name) => justPressed.has(name),
    wasReleased: (name) => justReleased.has(name),
    /** Call at the end of each scene update() after reading wasPressed/wasReleased. */
    flush() {
      justPressed.clear();
      justReleased.clear();
    },
  };
}

// Usage:
//   class PlayScene extends Phaser.Scene {
//     create() {
//       this.controller = setupController(this);
//       this.events.on('controller:connected', (info) =>
//         console.log('pad connected:', info.id),
//       );
//     }
//     update(_t, dt) {
//       const state = this.controller.poll();
//       if (state) {
//         this.player.body.setVelocityX(state.leftStick.x * 200);
//         this.player.body.setVelocityY(state.leftStick.y * 200);
//         if (this.controller.wasPressed('a')) this.player.jump();
//         if (state.buttons.rt) this.fireWeapon();
//       }
//       this.controller.flush();
//     }
//     onHit() { this.controller.rumble(150, 0.4, 0.8); }
//   }
