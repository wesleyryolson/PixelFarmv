/**
 * Small Phaser 3 helpers for the farming overlay.
 *
 * Sprites are kept upright and pixel crisp; the isometric projection controls
 * where each sprite sits on the ground grid. Sprite artwork should already be
 * drawn for the desired view.
 */

const DEFAULT_TILE_WIDTH = 64;
const DEFAULT_TILE_HEIGHT = 32;
const HARVEST_PUFF_TEXTURE = '__farm_utilities_harvest_puff__';

/**
 * Convert an isometric grid coordinate to a screen position.
 *
 * The default 64x32 tile footprint gives the classic 2:1 isometric angle used
 * by the reference image. `elevation` is measured in screen pixels.
 */
export function projectIsometricPosition(gridX, gridY, options = {}) {
	const {
		originX = 0,
		originY = 0,
		tileWidth = DEFAULT_TILE_WIDTH,
		tileHeight = DEFAULT_TILE_HEIGHT,
		elevation = 0
	} = options;

	return {
		x: originX + (gridX - gridY) * tileWidth / 2,
		y: originY + (gridX + gridY) * tileHeight / 2 - elevation
	};
}

/**
 * Add a pixel-art sprite at an isometric grid coordinate.
 *
 * `originX` and `originY` default to the center of the scene. `depthOffset`
 * can move a prop slightly in front of or behind another sprite on the same
 * grid row. The returned Phaser Image can be animated or otherwise modified.
 *
 * @example
 * const carrot = addIsometricSprite(this, 'carrot', 2, 3, {
 *   originX: 480,
 *   originY: 240,
 *   elevation: 12,
 *   scale: 3
 * });
 */
export function addIsometricSprite(scene, textureKey, gridX, gridY, options = {}) {
	const {
		originX = scene.scale.width / 2,
		originY = scene.scale.height / 2,
		tileWidth = DEFAULT_TILE_WIDTH,
		tileHeight = DEFAULT_TILE_HEIGHT,
		elevation = 0,
		depthOffset = 0,
		origin = { x: 0.5, y: 1 },
		scale = 1,
		alpha = 1,
		frame,
		tint
	} = options;

	const position = projectIsometricPosition(gridX, gridY, {
		originX,
		originY,
		tileWidth,
		tileHeight,
		elevation
	});
	const sprite = scene.add.image(position.x, position.y, textureKey, frame);
	sprite.setOrigin(origin.x, origin.y);
	sprite.setScale(scale);
	sprite.setAlpha(alpha);
	sprite.setDepth((gridX + gridY) * 100 + depthOffset);
	if (tint !== undefined) sprite.setTint(tint);
	return sprite;
}

function ensureHarvestPuffTexture(scene, textureKey) {
	if (scene.textures.exists(textureKey)) return;

	const graphics = scene.make.graphics({ add: false });
	graphics.fillStyle(0x80521b, 1);
	// A tiny stepped shape keeps the puff crisp when Phaser scales it.
	graphics.fillRect(1, 0, 2, 1);
	graphics.fillRect(0, 1, 4, 2);
	graphics.fillRect(1, 3, 2, 1);
	graphics.generateTexture(textureKey, 4, 4);
	graphics.destroy();
}

/**
 * Spawn and automatically clean up a short pixel-dust burst at (x, y).
 *
 * Coordinates are Phaser world coordinates, so pass the crop's screen/world
 * position. Options can override the tint, particle count, spread, or timing.
 *
 * @example
 * spawnHarvestPuff(this, crop.x, crop.y - 8, { count: 12, tint: 0xd8c18b });
 */
export function spawnHarvestPuff(scene, x, y, options = {}) {
	const {
		count = 10,
		tint = 0xd9c99c,
		textureKey = HARVEST_PUFF_TEXTURE,
		lifespan = { min: 300, max: 520 },
		speed = { min: 18, max: 52 },
		angle = { min: 205, max: 335 },
		gravityY = 65,
		scale = { start: 0.9, end: 0.1 },
		alpha = { start: 0.9, end: 0 }
	} = options;

	ensureHarvestPuffTexture(scene, textureKey);
	const emitter = scene.add.particles(0, 0, textureKey, {
		frequency: -1,
		lifespan,
		speed,
		angle,
		gravityY,
		scale,
		alpha,
		tint
	});
	emitter.explode(count, x, y);

	const longestLifespan = typeof lifespan === 'number'
		? lifespan
		: (lifespan.max ?? lifespan.min ?? 520);
	scene.time.delayedCall(longestLifespan + 100, () => emitter.destroy());
	return emitter;
}
