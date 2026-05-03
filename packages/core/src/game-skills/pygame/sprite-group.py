# when_to_use: Sprite hierarchy for any Pygame game with multiple
# entities (player + enemies + projectiles + pickups). Uses pygame's
# native Sprite + Group classes — they batch draw + collision-detect
# at C speed instead of per-sprite Python loops.

import pygame


class GameSprite(pygame.sprite.Sprite):
    """Base for every animated entity. Subclass for Player / Enemy / Pickup.

    Convention: __init__(image, pos, group=None) and update(dt) override.
    Always convert_alpha() the loaded image at load time.
    """

    def __init__(
        self,
        image: pygame.Surface,
        pos: tuple[int, int],
        groups: tuple[pygame.sprite.Group, ...] = (),
    ) -> None:
        super().__init__(*groups)
        self.image = image
        self.rect = image.get_rect(center=pos)
        # Float position for sub-pixel motion; sync to .rect at draw time.
        self.fpos = pygame.Vector2(pos)

    def update(self, dt: float) -> None:  # noqa: ARG002
        # Subclasses override — base version is a no-op.
        self.rect.center = (round(self.fpos.x), round(self.fpos.y))


class Player(GameSprite):
    def __init__(
        self,
        image: pygame.Surface,
        pos: tuple[int, int],
        groups: tuple[pygame.sprite.Group, ...] = (),
    ) -> None:
        super().__init__(image, pos, groups)
        self.velocity = pygame.Vector2(0, 0)
        self.speed = 200.0

    def update(self, dt: float) -> None:
        keys = pygame.key.get_pressed()
        direction = pygame.Vector2(0, 0)
        if keys[pygame.K_LEFT] or keys[pygame.K_a]:
            direction.x -= 1
        if keys[pygame.K_RIGHT] or keys[pygame.K_d]:
            direction.x += 1
        if keys[pygame.K_UP] or keys[pygame.K_w]:
            direction.y -= 1
        if keys[pygame.K_DOWN] or keys[pygame.K_s]:
            direction.y += 1
        if direction.length_squared() > 0:
            direction = direction.normalize()
        self.fpos += direction * self.speed * dt
        super().update(dt)


# Usage:
#   player_sprites = pygame.sprite.GroupSingle()
#   enemy_sprites = pygame.sprite.Group()
#   pickup_sprites = pygame.sprite.Group()
#
#   player_img = pygame.image.load("assets/sprites/player.png").convert_alpha()
#   player = Player(player_img, (400, 300), (player_sprites,))
#
#   # Inside the game loop:
#   player_sprites.update(dt)
#   enemy_sprites.update(dt)
#
#   # Collision detection — pygame batches this at C speed
#   hits = pygame.sprite.spritecollide(player, enemy_sprites, dokill=False)
#   if hits:
#       player.take_damage()
#
#   # Drawing
#   screen.fill((11, 11, 14))
#   enemy_sprites.draw(screen)
#   pickup_sprites.draw(screen)
#   player_sprites.draw(screen)
#   pygame.display.flip()
