# when_to_use: Gamepad / controller support for a Pygame game running
# on Pyodide. Wraps pygame.joystick with deadzones, named-button mapping
# (Xbox/PS standard layout), hot-plug detection, and a single `poll()`
# call your event loop reads each frame.
#
# Pyodide-specific note: pygame-ce on Pyodide bridges the browser
# Gamepad API through pygame.joystick. Connect events fire only AFTER
# the user presses a button on the controller (Chrome's policy). The
# first poll after that returns a Joystick object; before that, no pad
# is visible. Show "Press any button on your controller to begin"
# during onboarding.

import pygame

# Standard mapping (Xbox layout). PS players see ✕○□△ but the indices
# are the same on the Standard Gamepad mapping the browser exposes.
STANDARD_BUTTONS = [
    "a", "b", "x", "y",
    "lb", "rb",
    "lt", "rt",
    "select", "start",
    "l3", "r3",
    "up", "down", "left", "right",
    "home",
]


def _apply_deadzone(x: float, y: float, deadzone: float) -> tuple[float, float]:
    """Radial deadzone — same shape as the JS engine skills. Below the
    threshold returns (0, 0); above, smoothly remaps so the stick
    starts at 0 magnitude at the boundary."""
    mag = (x * x + y * y) ** 0.5
    if mag < deadzone:
        return (0.0, 0.0)
    scale = (mag - deadzone) / (1.0 - deadzone) / mag
    return (x * scale, y * scale)


class Controller:
    """One-pad wrapper. Multi-pad games instantiate two of these against
    different joystick indices; the user-facing brief usually means one."""

    def __init__(self, deadzone: float = 0.15):
        pygame.joystick.init()
        self.deadzone = deadzone
        self._joy: pygame.joystick.Joystick | None = None
        self._last_buttons: list[bool] = []
        self._just_pressed: set[str] = set()
        self._just_released: set[str] = set()

    def _ensure_joy(self) -> None:
        # Re-probe every poll — Pyodide's joystick adapter creates the
        # Joystick lazily on first browser-level button press. Cheap to
        # call (joystick count is cached).
        if self._joy is None and pygame.joystick.get_count() > 0:
            self._joy = pygame.joystick.Joystick(0)
            self._joy.init()
            self._last_buttons = [False] * self._joy.get_numbuttons()

    def poll(self) -> dict | None:
        """Return a snapshot of stick / button / trigger state, or None
        when no controller is connected. Updates internal edge-tracking
        (wasPressed / wasReleased)."""
        self._ensure_joy()
        if self._joy is None:
            return None
        joy = self._joy
        # Edge tracking
        for i in range(min(joy.get_numbuttons(), len(STANDARD_BUTTONS))):
            pressed_now = joy.get_button(i) == 1
            was_pressed = self._last_buttons[i] if i < len(self._last_buttons) else False
            name = STANDARD_BUTTONS[i] if i < len(STANDARD_BUTTONS) else f"b{i}"
            if pressed_now and not was_pressed:
                self._just_pressed.add(name)
            if not pressed_now and was_pressed:
                self._just_released.add(name)
            if i < len(self._last_buttons):
                self._last_buttons[i] = pressed_now

        # Standard Gamepad axis layout (browser-bridged):
        #   axis 0 = left stick X, axis 1 = left stick Y
        #   axis 2 = right stick X, axis 3 = right stick Y
        #   axes 4 / 5 are sometimes triggers; sometimes buttons[6/7].value.
        def _axis(i: int) -> float:
            return joy.get_axis(i) if joy.get_numaxes() > i else 0.0

        lx, ly = _apply_deadzone(_axis(0), _axis(1), self.deadzone)
        rx, ry = _apply_deadzone(_axis(2), _axis(3), self.deadzone)

        # D-pad on most pads is hat 0 — (-1, 0) = left, (0, 1) = up, etc.
        # Some browsers map it to buttons[12-15] instead; use whichever
        # the current pad exposes.
        dpad_x = dpad_y = 0
        if joy.get_numhats() > 0:
            dpad_x, dpad_y = joy.get_hat(0)

        return {
            "id": joy.get_name(),
            "buttons": {
                name: (joy.get_button(i) == 1)
                for i, name in enumerate(STANDARD_BUTTONS)
                if i < joy.get_numbuttons()
            },
            "leftStick": (lx, ly),
            "rightStick": (rx, ry),
            "dpad": (dpad_x, dpad_y),
            # Triggers vary across browsers — buttons[6/7].value isn't
            # exposed by pygame-ce. Approximate via axis 4/5 if present.
            "lt": max(0.0, _axis(4)),
            "rt": max(0.0, _axis(5)),
        }

    def was_pressed(self, name: str) -> bool:
        return name in self._just_pressed

    def was_released(self, name: str) -> bool:
        return name in self._just_released

    def is_connected(self) -> bool:
        return self._joy is not None

    def flush(self) -> None:
        """Call at the end of each frame after reading was_pressed / was_released."""
        self._just_pressed.clear()
        self._just_released.clear()

    def handle_event(self, event: pygame.event.Event) -> None:
        """Optionally route JOYDEVICEADDED / JOYDEVICEREMOVED events
        through here so the controller reconnects after a browser
        suspend/resume cycle. Most games can rely on _ensure_joy()
        instead."""
        if event.type == pygame.JOYDEVICEADDED:
            # New pad — re-probe on next poll
            self._joy = None
        elif event.type == pygame.JOYDEVICEREMOVED:
            self._joy = None
            self._last_buttons = []

    def dispose(self) -> None:
        if self._joy is not None:
            self._joy.quit()
            self._joy = None
        pygame.joystick.quit()


# Usage:
#   ctrl = Controller(deadzone=0.15)
#   while running:
#       for event in pygame.event.get():
#           if event.type == pygame.QUIT:
#               running = False
#           ctrl.handle_event(event)
#       state = ctrl.poll()
#       if state:
#           player.x += state["leftStick"][0] * speed * dt
#           player.y += state["leftStick"][1] * speed * dt
#           if ctrl.was_pressed("a"):
#               player.jump()
#           if state["buttons"]["rt"]:
#               player.fire()
#       ctrl.flush()
#       pygame.display.flip()
#       await asyncio.sleep(0)  # YIELD — Pyodide requires it (engine guide §A)
