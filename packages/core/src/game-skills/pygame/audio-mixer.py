# when_to_use: SFX bank for Pygame games on Pyodide. Pre-loads every
# Sound at boot, exposes play(name) for one-shot cues. Respects
# window.__game.config.startMuted (autoplay-policy gate). Does NOT use
# pygame.mixer.music — that's unsupported on Pyodide; loop short Sounds
# instead.

import pygame


class AudioBank:
    """Pre-loaded SFX cues + autoplay-policy aware playback.

    Usage:
        audio = AudioBank({
            "jump": "assets/audio/jump.wav",
            "hit": "assets/audio/hit.wav",
            "coin": "assets/audio/coin.wav",
        })
        audio.play("jump")
        audio.play("hit", volume=0.6)
    """

    def __init__(self, manifest: dict[str, str]) -> None:
        # Pyodide-compatible mixer init. Channels=8 covers a small game's
        # SFX overlap; bump to 16 for bullet-hell.
        pygame.mixer.init()
        pygame.mixer.set_num_channels(8)
        self._sounds: dict[str, pygame.mixer.Sound] = {}
        for name, path in manifest.items():
            try:
                snd = pygame.mixer.Sound(path)
                snd.set_volume(0.4)
                self._sounds[name] = snd
            except (pygame.error, FileNotFoundError):
                # Fail open: a missing audio file shouldn't crash the game.
                # The validator catches dangling asset references at the
                # bundle level; this fallback is for runtime-only paths.
                pass
        self._muted = self._read_initial_muted()

    def _read_initial_muted(self) -> bool:
        """Honour window.__game.config.startMuted set by the host."""
        try:
            import js  # type: ignore[import-not-found]

            return bool(js.window.__game.config.startMuted)
        except (ImportError, AttributeError):
            return False

    def set_muted(self, muted: bool) -> None:
        self._muted = muted

    def play(self, name: str, volume: float = 0.4, loops: int = 0) -> None:
        if self._muted:
            return
        snd = self._sounds.get(name)
        if snd is None:
            return
        snd.set_volume(volume)
        snd.play(loops=loops)

    def stop(self, name: str) -> None:
        snd = self._sounds.get(name)
        if snd is not None:
            snd.stop()

    def stop_all(self) -> None:
        for snd in self._sounds.values():
            snd.stop()


# Looping music workaround (pygame.mixer.music is unsupported on Pyodide):
#   loop_track = pygame.mixer.Sound("assets/audio/loop.wav")
#   loop_track.set_volume(0.2)
#   loop_track.play(loops=-1)  # -1 = forever
