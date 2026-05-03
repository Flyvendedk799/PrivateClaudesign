// when_to_use: Uniform keyboard/mouse/gamepad input across a Three.js
// game. Read state synchronously per tick — no listeners in your update
// loop. Adds to `dispose()` so you don't leak listeners on unmount.

export function createInput(target = window) {
  const keys = new Set();
  const justPressed = new Set();
  const justReleased = new Set();
  const mouse = { x: 0, y: 0, dx: 0, dy: 0, buttons: 0 };

  function down(e) {
    if (!keys.has(e.code)) justPressed.add(e.code);
    keys.add(e.code);
  }
  function up(e) {
    keys.delete(e.code);
    justReleased.add(e.code);
  }
  function move(e) {
    mouse.dx += e.movementX ?? 0;
    mouse.dy += e.movementY ?? 0;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }
  function btn(e) {
    mouse.buttons = e.buttons;
  }

  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('mousemove', move);
  target.addEventListener('mousedown', btn);
  target.addEventListener('mouseup', btn);

  return {
    isDown: (code) => keys.has(code),
    wasPressed: (code) => justPressed.has(code),
    wasReleased: (code) => justReleased.has(code),
    /** Read accumulated mouse delta + reset. Call once per tick. */
    pollMouse() {
      const out = { ...mouse };
      mouse.dx = 0;
      mouse.dy = 0;
      return out;
    },
    /** First-gamepad axes + buttons. */
    pollGamepad() {
      const pads = navigator.getGamepads?.();
      const pad = pads?.[0];
      if (!pad) return null;
      return { axes: [...pad.axes], buttons: pad.buttons.map((b) => b.pressed) };
    },
    /** Call at the END of each tick. */
    flush() {
      justPressed.clear();
      justReleased.clear();
    },
    dispose() {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('mousemove', move);
      target.removeEventListener('mousedown', btn);
      target.removeEventListener('mouseup', btn);
    },
  };
}

// Usage:
//   const input = createInput();
//   function update(dt) {
//     if (input.isDown('ArrowLeft')) player.x -= speed * dt;
//     if (input.wasPressed('Space')) jump();
//     const mouse = input.pollMouse();
//     camera.rotation.y -= mouse.dx * 0.002;
//     input.flush();
//   }
