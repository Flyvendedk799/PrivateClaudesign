# when_to_use: 2D top-down or platformer player controller. Reads input
# from `Input.get_axis()`, applies physics via `CharacterBody2D.move_and_slide()`,
# uses @export so designers can tune speed/accel without editing code.
# Drop on a CharacterBody2D node; pair with a CollisionShape2D + AnimatedSprite2D.

extends CharacterBody2D

@export var max_speed: float = 200.0
@export var acceleration: float = 1200.0
@export var friction: float = 1500.0
# Set to 0 for top-down, 980+ for platformer-with-gravity.
@export var gravity: float = 0.0
# Platformer-only — set to 0 to disable jumping.
@export var jump_velocity: float = -360.0

@onready var sprite: AnimatedSprite2D = $AnimatedSprite2D

func _physics_process(delta: float) -> void:
	# Horizontal input — UI-named actions ("ui_left" etc.) are pre-mapped
	# in Godot's default InputMap, no project.godot edit needed.
	var dir_x := Input.get_axis("ui_left", "ui_right")

	if gravity > 0.0:
		# Platformer mode
		velocity.y += gravity * delta
		if Input.is_action_just_pressed("ui_accept") and is_on_floor():
			velocity.y = jump_velocity
		if dir_x != 0.0:
			velocity.x = move_toward(velocity.x, dir_x * max_speed, acceleration * delta)
		else:
			velocity.x = move_toward(velocity.x, 0.0, friction * delta)
	else:
		# Top-down mode — independent y axis
		var dir_y := Input.get_axis("ui_up", "ui_down")
		var target := Vector2(dir_x, dir_y).normalized() * max_speed
		var rate := acceleration if target.length() > 0.0 else friction
		velocity = velocity.move_toward(target, rate * delta)

	move_and_slide()
	_update_animation(dir_x)

func _update_animation(dir_x: float) -> void:
	# Cheap animation router — assumes "idle" + "run" frames in the
	# AnimatedSprite2D's SpriteFrames resource. Flip the sprite for left motion.
	if dir_x < 0.0:
		sprite.flip_h = true
	elif dir_x > 0.0:
		sprite.flip_h = false
	if velocity.length() > 4.0:
		if sprite.animation != "run":
			sprite.play("run")
	else:
		if sprite.animation != "idle":
			sprite.play("idle")
