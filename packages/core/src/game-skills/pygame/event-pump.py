# when_to_use: Centralised input handler for Pygame games. Wraps
# pygame.event.get() + pygame.key.get_pressed() + pygame.mouse so
# scenes don't each re-implement the boilerplate. Returns an Input
# struct your update() consumes per-frame.

import pygame


class InputState:
    """Snapshot of input for one tick.

    Read fields directly:
        if input.dir.x < 0: ...
        if input.just_pressed(pygame.K_SPACE): ...
        if input.mouse_buttons[0]: ...
    """

    def __init__(self) -> None:
        self.dir = pygame.Vector2(0, 0)
        self.mouse_pos: tuple[int, int] = (0, 0)
        self.mouse_buttons: tuple[bool, ...] = (False, False, False)
        self.quit_requested = False
        self.restart_requested = False
        # Per-tick edge events. just_pressed is true ONLY on the frame
        # the key transitioned from up → down. Cleared each pump.
        self._just_pressed: set[int] = set()
        self._just_released: set[int] = set()

    def just_pressed(self, key: int) -> bool:
        return key in self._just_pressed

    def just_released(self, key: int) -> bool:
        return key in self._just_released


class EventPump:
    """Drains pygame.event.get() once per tick and produces an InputState.

    Usage inside the game loop:
        pump.tick()
        if pump.state.quit_requested: running = False
        if pump.state.just_pressed(pygame.K_SPACE): jump()
        player.move(pump.state.dir, dt)
    """

    def __init__(self) -> None:
        self.state = InputState()

    def tick(self) -> None:
        s = self.state
        s._just_pressed.clear()
        s._just_released.clear()

        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                s.quit_requested = True
            elif event.type == pygame.KEYDOWN:
                s._just_pressed.add(event.key)
                if event.key == pygame.K_ESCAPE:
                    s.quit_requested = True
                elif event.key == pygame.K_r:
                    s.restart_requested = True
            elif event.type == pygame.KEYUP:
                s._just_released.add(event.key)

        # Sample held-key state for movement vector.
        keys = pygame.key.get_pressed()
        dx = (1 if keys[pygame.K_RIGHT] or keys[pygame.K_d] else 0) - (
            1 if keys[pygame.K_LEFT] or keys[pygame.K_a] else 0
        )
        dy = (1 if keys[pygame.K_DOWN] or keys[pygame.K_s] else 0) - (
            1 if keys[pygame.K_UP] or keys[pygame.K_w] else 0
        )
        s.dir = pygame.Vector2(dx, dy)
        if s.dir.length_squared() > 0:
            s.dir = s.dir.normalize()

        s.mouse_pos = pygame.mouse.get_pos()
        s.mouse_buttons = pygame.mouse.get_pressed(num_buttons=3)
