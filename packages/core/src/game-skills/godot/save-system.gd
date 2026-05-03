# when_to_use: Persistent save/load for game state (high score, unlocked
# levels, options). Writes JSON to user://save.json — Godot resolves
# user:// to a per-user app-data directory automatically. Add as an
# autoload: `SaveSystem="*res://scripts/save_system.gd"`.

extends Node

const SAVE_PATH := "user://save.json"
const VERSION := 1

# In-memory cache. Loaded once on autoload startup; mutated by the game
# at runtime; written to disk on save() / on_quit().
var data: Dictionary = {
	"version": VERSION,
	"high_score": 0,
	"unlocked_levels": [],
	"options": {
		"master_volume": 0.7,
		"music_volume": 0.5,
		"sfx_volume": 0.8,
	},
}

func _ready() -> void:
	load_from_disk()
	# Save on quit so partial progress isn't lost.
	get_tree().auto_accept_quit = false
	get_tree().connect("quit_request", Callable(self, "_on_quit_request"))

func _on_quit_request() -> void:
	save_to_disk()
	get_tree().quit()

func load_from_disk() -> void:
	if not FileAccess.file_exists(SAVE_PATH):
		return
	var f := FileAccess.open(SAVE_PATH, FileAccess.READ)
	if f == null:
		push_warning("save: failed to open " + SAVE_PATH + " for reading")
		return
	var raw := f.get_as_text()
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_warning("save: malformed JSON; ignoring on-disk save")
		return
	# Migrate older versions silently — keep defaults for new keys, drop
	# unknown ones from the loaded dict.
	for key in data.keys():
		if (parsed as Dictionary).has(key):
			data[key] = (parsed as Dictionary)[key]

func save_to_disk() -> void:
	var f := FileAccess.open(SAVE_PATH, FileAccess.WRITE)
	if f == null:
		push_warning("save: failed to open " + SAVE_PATH + " for writing")
		return
	f.store_string(JSON.stringify(data, "  "))

# Convenience helpers — call these from game code instead of poking
# `data` directly so future schema bumps stay backwards-compatible.
func set_high_score(score: int) -> void:
	if score > data.high_score:
		data.high_score = score
		save_to_disk()

func unlock_level(level_id: String) -> void:
	if level_id not in data.unlocked_levels:
		data.unlocked_levels.append(level_id)
		save_to_disk()

func get_volume(bus: String) -> float:
	return data.options.get(bus + "_volume", 0.7)
