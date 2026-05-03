# when_to_use: Gamepad / controller support for a Godot 4.x game. Wraps
# Godot's Input class with deadzone-aware stick reads, named-button
# helpers (Xbox/PS standard layout), connect/disconnect signals, and
# rumble.
#
# Godot's idiomatic approach is to define InputMap actions
# ("move_left", "jump", "fire") in project.godot and bind them to
# joypad_button / joypad_motion events, then read via Input.is_action_pressed.
# That works well for SIMPLE games. For complex briefs (twin-stick
# shooter, racing) where you need raw stick values + per-pad device id,
# bypass InputMap and read the joypad directly — that's what this skill
# is for.
#
# Place this script as `autoload/controller.gd` and add it as an
# AutoLoad singleton in project.godot (Project → Autoload → name:
# "Controller", path: "res://autoload/controller.gd").

extends Node

const STANDARD_BUTTONS := {
	JOY_BUTTON_A: "a",
	JOY_BUTTON_B: "b",
	JOY_BUTTON_X: "x",
	JOY_BUTTON_Y: "y",
	JOY_BUTTON_LEFT_SHOULDER: "lb",
	JOY_BUTTON_RIGHT_SHOULDER: "rb",
	JOY_BUTTON_BACK: "select",
	JOY_BUTTON_START: "start",
	JOY_BUTTON_LEFT_STICK: "l3",
	JOY_BUTTON_RIGHT_STICK: "r3",
	JOY_BUTTON_DPAD_UP: "up",
	JOY_BUTTON_DPAD_DOWN: "down",
	JOY_BUTTON_DPAD_LEFT: "left",
	JOY_BUTTON_DPAD_RIGHT: "right",
	JOY_BUTTON_GUIDE: "home",
}

@export var deadzone: float = 0.15
@export var device: int = 0

signal connected(device_id: int)
signal disconnected(device_id: int)

var _last_button_state: Dictionary = {}
var _just_pressed: Dictionary = {}
var _just_released: Dictionary = {}


func _ready() -> void:
	# Godot fires joy_connection_changed for both connect and disconnect.
	# Plumb that into our own typed signals so callers don't have to
	# reach into the Input singleton.
	Input.joy_connection_changed.connect(_on_joy_connection_changed)


func _on_joy_connection_changed(device_id: int, is_connected: bool) -> void:
	if device_id != device:
		return
	if is_connected:
		emit_signal("connected", device_id)
	else:
		_last_button_state.clear()
		emit_signal("disconnected", device_id)


# Godot provides Input.get_vector() with a built-in deadzone, but it
# expects InputMap action names. For raw stick reads we apply our own
# radial deadzone — same shape as the JS / Pygame engine skills.
func _apply_deadzone(x: float, y: float) -> Vector2:
	var mag := sqrt(x * x + y * y)
	if mag < deadzone:
		return Vector2.ZERO
	var scale := (mag - deadzone) / (1.0 - deadzone) / mag
	return Vector2(x * scale, y * scale)


func is_connected_to_pad() -> bool:
	return Input.get_connected_joypads().has(device)


# Read the current state of stick + buttons + triggers as a single
# Dictionary. Call once per _physics_process tick.
func poll() -> Dictionary:
	if not is_connected_to_pad():
		return {}

	# Edge tracking — must run every poll so wasPressed reflects the
	# transition since the LAST poll, not since some arbitrary boot.
	for code in STANDARD_BUTTONS.keys():
		var pressed_now: bool = Input.is_joy_button_pressed(device, code)
		var was_pressed: bool = _last_button_state.get(code, false)
		var name: String = STANDARD_BUTTONS[code]
		if pressed_now and not was_pressed:
			_just_pressed[name] = true
		if not pressed_now and was_pressed:
			_just_released[name] = true
		_last_button_state[code] = pressed_now

	var left := _apply_deadzone(
		Input.get_joy_axis(device, JOY_AXIS_LEFT_X),
		Input.get_joy_axis(device, JOY_AXIS_LEFT_Y),
	)
	var right := _apply_deadzone(
		Input.get_joy_axis(device, JOY_AXIS_RIGHT_X),
		Input.get_joy_axis(device, JOY_AXIS_RIGHT_Y),
	)
	# Godot maps trigger axes to JOY_AXIS_TRIGGER_LEFT / TRIGGER_RIGHT —
	# range is 0..1 for digital pads, may go negative on some Xbox pads
	# in their idle position. clampf to 0..1 normalises that out.
	var lt: float = clampf(Input.get_joy_axis(device, JOY_AXIS_TRIGGER_LEFT), 0.0, 1.0)
	var rt: float = clampf(Input.get_joy_axis(device, JOY_AXIS_TRIGGER_RIGHT), 0.0, 1.0)

	var buttons := {}
	for code in STANDARD_BUTTONS.keys():
		buttons[STANDARD_BUTTONS[code]] = Input.is_joy_button_pressed(device, code)

	return {
		"id": Input.get_joy_name(device),
		"buttons": buttons,
		"leftStick": left,
		"rightStick": right,
		"lt": lt,
		"rt": rt,
	}


func was_pressed(name: String) -> bool:
	return _just_pressed.get(name, false)


func was_released(name: String) -> bool:
	return _just_released.get(name, false)


# Call at the end of each tick after reading was_pressed / was_released.
func flush() -> void:
	_just_pressed.clear()
	_just_released.clear()


# Rumble effect. weak_magnitude / strong_magnitude are 0..1.
# `duration_sec` of 0 plays indefinitely (call stop_rumble() to cancel).
func rumble(weak_magnitude: float = 0.5, strong_magnitude: float = 0.5, duration_sec: float = 0.2) -> void:
	Input.start_joy_vibration(device, weak_magnitude, strong_magnitude, duration_sec)


func stop_rumble() -> void:
	Input.stop_joy_vibration(device)


# Usage (assumes this script is autoloaded as `Controller`):
#   func _physics_process(delta: float) -> void:
#       var state := Controller.poll()
#       if not state.is_empty():
#           player.velocity.x = state["leftStick"].x * speed
#           player.velocity.z = state["leftStick"].y * speed
#           if Controller.was_pressed("a"):
#               player.jump()
#           if state["buttons"]["rt"]:
#               weapon.fire()
#       Controller.flush()
#
#   func _on_player_hit() -> void:
#       Controller.rumble(0.4, 0.8, 0.15)
