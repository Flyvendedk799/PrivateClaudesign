# when_to_use: Game-state autoload singleton. Holds run-scoped state
# (current score, level, paused flag) that scenes need to read/write
# without parent-child coupling. Add to project.godot:
# `[autoload]\nGameState="*res://scripts/game_state.gd"`.

extends Node

# --- Run-scoped state -------------------------------------------------
# Cleared on new_run(); persists across scene changes within a run.

var current_score: int = 0
var current_level: int = 1
var lives: int = 3

# UI signals — anything reading score/lives subscribes to the right
# signal so HUDs update without per-frame polling.
signal score_changed(new_score: int)
signal lives_changed(new_lives: int)
signal level_changed(new_level: int)
signal game_over

# --- Pause -----------------------------------------------------------

var _paused: bool = false

func is_paused() -> bool:
	return _paused

func set_paused(p: bool) -> void:
	if _paused == p:
		return
	_paused = p
	get_tree().paused = p
	# Allow autoloads (this) and pause-menu UI to keep ticking even when
	# the tree is paused. Set process_mode on those nodes:
	#   process_mode = Node.PROCESS_MODE_ALWAYS

# --- Scoring helpers --------------------------------------------------

func add_score(points: int) -> void:
	current_score += points
	score_changed.emit(current_score)

func lose_life() -> void:
	lives -= 1
	lives_changed.emit(lives)
	if lives <= 0:
		game_over.emit()

func advance_level() -> void:
	current_level += 1
	level_changed.emit(current_level)

# --- Run lifecycle ----------------------------------------------------

func new_run() -> void:
	current_score = 0
	current_level = 1
	lives = 3
	score_changed.emit(current_score)
	lives_changed.emit(lives)
	level_changed.emit(current_level)
