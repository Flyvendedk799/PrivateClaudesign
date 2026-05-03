# when_to_use: Async-aware Pygame main loop for Pyodide. Yields to the
# browser via asyncio.sleep(0) so the page doesn't freeze. Drop into
# main.py; replace the update/draw stubs with your scene logic.

import asyncio

import pygame


async def run_game(width: int = 800, height: int = 600, fps: int = 60) -> None:
    pygame.init()
    screen = pygame.display.set_mode((width, height))
    pygame.display.set_caption("Game")
    clock = pygame.time.Clock()
    running = True

    last_ms = pygame.time.get_ticks()

    while running:
        # 1. Drain events (REQUIRED — without this the browser thinks we hung)
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
            elif event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
                running = False
            elif event.type == pygame.KEYDOWN and event.key == pygame.K_r:
                # Restart binding — game-anti-slop §Core mechanic.
                pass  # call your reset_state() here

        # 2. Compute dt in seconds for frame-rate-independent motion
        now = pygame.time.get_ticks()
        dt = (now - last_ms) / 1000.0
        last_ms = now

        # 3. Update — read live tweaks via window.__game.params
        # speed = get_param("player_speed", 200)
        # update(dt, speed)

        # 4. Draw — clear, blit, flip
        screen.fill((11, 11, 14))
        # render(screen)
        pygame.display.flip()

        # 5. Cap fps + YIELD to the JS event loop (Pyodide-required)
        clock.tick(fps)
        await asyncio.sleep(0)

    pygame.quit()


# Usage at the bottom of main.py:
#   asyncio.ensure_future(run_game())
