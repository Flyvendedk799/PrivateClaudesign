# when_to_use: Scene-transition autoload for multi-screen Godot games
# (Menu → Play → GameOver, level transitions). Crossfades via a
# CanvasLayer overlay so transitions don't blank the screen. Add as an
# autoload in project.godot: `SceneManager="*res://scripts/scene_manager.gd"`.

extends Node

signal transition_started(target_path: String)
signal transition_finished(target_path: String)

@export var fade_duration: float = 0.25

var _fade_layer: CanvasLayer
var _fade_rect: ColorRect
var _busy: bool = false

func _ready() -> void:
	_fade_layer = CanvasLayer.new()
	_fade_layer.layer = 100  # above everything except hard-coded UI
	add_child(_fade_layer)
	_fade_rect = ColorRect.new()
	_fade_rect.color = Color(0, 0, 0, 0)
	_fade_rect.set_anchors_preset(Control.PRESET_FULL_RECT)
	_fade_rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_fade_layer.add_child(_fade_rect)

# Crossfade to a different .tscn. Pass `data` to seed the destination
# scene with state (e.g. final score for the GameOver screen).
func change_scene(scene_path: String, data: Dictionary = {}) -> void:
	if _busy:
		return
	_busy = true
	transition_started.emit(scene_path)

	# Fade to black
	var tween := create_tween()
	tween.tween_property(_fade_rect, "color:a", 1.0, fade_duration)
	await tween.finished

	# Stash data on the SceneManager so the next scene's _ready() can
	# read it (use SceneManager.transition_data on the inbound side).
	transition_data = data
	get_tree().change_scene_to_file(scene_path)

	# Fade back in
	var tween2 := create_tween()
	tween2.tween_property(_fade_rect, "color:a", 0.0, fade_duration)
	await tween2.finished

	_busy = false
	transition_finished.emit(scene_path)

# Read this from the new scene's _ready() to recover the data the
# previous scene passed via change_scene().
var transition_data: Dictionary = {}

# Convenience: restart the current scene (for "press R to restart").
func restart_current() -> void:
	if _busy:
		return
	var current := get_tree().current_scene.scene_file_path
	change_scene(current)
