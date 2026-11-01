import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
// Optional: set OPENROUTER_API_KEY or OPENAI_API_KEY in .env.local or .env to generate crop modifiers.

const BOT_USER_ID = process.env.BOT_USER_ID; // This is the User ID of the chat bot
const OAUTH_TOKEN = process.env.OAUTH_TOKEN; // Also needs user:manage:whispers for private !shop replies
const CHANNEL_OWNER_OAUTH_TOKEN = process.env.CHANNEL_OWNER_OAUTH_TOKEN?.trim();
const CLIENT_ID = process.env.CLIENT_ID;


const CHAT_CHANNEL_USER_ID = process.env.CHAT_CHANNEL_USER_ID;

const EVENTSUB_WEBSOCKET_URL = 'wss://eventsub.wss.twitch.tv/ws';
const LOCAL_WEBSOCKET_PORT = 8080;
const STARTING_BANK_BALANCE = 1000;
const MOCK_RESET_BANK_BALANCE = 100;
const DYNAMIC_HARVEST_ENABLED = /^(1|true|yes|on)$/i.test(process.env.DYNAMIC_HARVEST?.trim() || '');
const ACTIVE_CHATTER_WINDOW_MS = 5 * 60 * 1000;
const WATER_COMMAND_COOLDOWN_MS = 15_000;
const MAX_TILE_WETNESS = 15;
const MAX_ISLAND_LEVEL = 2;
const HARVEST_COMMAND_QUEUE_FALLBACK_MS = 18_000;
const ISLAND_UPGRADE_HARVESTS = { 2: 10, 3: 25 };
const FARM_STATE_PATH = fileURLToPath(new URL('./farm-state.json', import.meta.url));
const LEADERBOARD_PATH = fileURLToPath(new URL('./leaderboard.json', import.meta.url));
const CROP_CATALOG = {
	potato: { name: 'Potato', price: 0, value: 10, growthMs: 30_000 },
	carrot: { name: 'Carrot', price: 75, value: 30, growthMs: 60_000 },
	onion: { name: 'Onion', price: 150, value: 100, growthMs: 120_000 }
};
const VEGETABLES_PER_HARVEST = 2;
const SHINY_VALUE_MULTIPLIER = 5;
const SHINY_SPECIAL_MODIFIER_CHANCE = 0.5;
const SPECIAL_MODIFIER_VALUE_MULTIPLIER = 5;
const AVERAGE_VEGETABLE_WEIGHT_KG = { potato: 0.2, carrot: 0.2, onion: 0.2 };
const LOCAL_CROP_MODIFIERS = [
	{ modifier: 'RADIOACTIVE', hexColor: '0x39ff14' },
	{ modifier: 'INFERNO', hexColor: '0xff2200' },
	{ modifier: 'GLITCH', hexColor: '0x00e5ff' }
];
const CROP_ALIASES = { potatoes: 'potato', carrots: 'carrot', onions: 'onion' };
const MOCK_CHAT_USERS = [
	'GlitchRunner', 'PixelFarmer', 'RetroGamer99', 'SproutMaster',
	'TwitchCat', 'CozyStreamer', 'CropWatcher', 'ZeroLag',
	'NeonVibes', 'HypeTrainDriver', 'SpudLover', 'CoffeeCoder'
];
const MOCK_ACTIVITY_INTERVAL_MS = { 1: 7000, 2: 4000, 3: 2200, 4: 900, 5: 600, 6: 400, 7: 250, 8: 125 };
const MOCK_ACTIVITY_NAMES = ['off', 'low', 'medium', 'high', 'demo', 'fast', 'faster', 'rapid', 'chaos'];
let farmState = createDefaultFarmState();
let leaderboard = createEmptyLeaderboard();
let persistentDataReady = false;
let tokenScopes = new Set();
let oauthUserId = null;
let channelOwnerTokenReady = false;
let debugShinyChance = 0.15;
let debugActiveChatterCount = 1;
let debugIslandSize = null;
let mockActivityLevel = 2;
let mockBitsEnabled = false;
let mockSubsEnabled = false;
const recentChatters = new Map();
const waterCommandCooldowns = new Map();
let chatCommandQueue = Promise.resolve();
let activeHarvestAnimationId = null;
let releaseHarvestCommandGate = null;
let harvestCommandGate = null;
let harvestCommandFallbackTimer = null;
let harvestAnimationSequence = 0;

function createDefaultFarmState() {
	return {
		bank: STARTING_BANK_BALANCE,
		harvestedCrops: 0,
		islandLevel: 1,
		crops: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index + 1, null])),
		wetness: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index + 1, 0])),
		subscribers: []
	};
}

function createEmptyLeaderboard(streamId = null) {
	return { streamId, users: {}, mostValuableCrop: null };
}

function getIslandLevelForHarvestCount(harvestCount) {
	const level = harvestCount >= ISLAND_UPGRADE_HARVESTS[3]
		? 3
		: harvestCount >= ISLAND_UPGRADE_HARVESTS[2] ? 2 : 1;
	return Math.min(MAX_ISLAND_LEVEL, level);
}

function getIslandLevel() {
	return farmState.islandLevel || getIslandLevelForHarvestCount(farmState.harvestedCrops);
}

function rollVegetableWeightKg() {
	const rarityRoll = Math.random();
	const weightKg = rarityRoll < 0.01
		? 1.5 + Math.random() * 1.5
		: rarityRoll < 0.06
			? 1 + Math.random() * 0.5
			: 0.05 + Math.random() * 0.3;
	return Math.round(weightKg * 100) / 100;
}

function getLocalCropModifier() {
	return LOCAL_CROP_MODIFIERS[Math.floor(Math.random() * LOCAL_CROP_MODIFIERS.length)];
}

async function generateCropModifier() {
	const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
	const openAiKey = process.env.OPENAI_API_KEY?.trim();
	const provider = openAiKey ? 'openai' : openRouterKey ? 'openrouter' : null;
	const apiKey = provider === 'openai' ? openAiKey : openRouterKey;
	if (!provider) return getLocalCropModifier();
	const endpoint = provider === 'openrouter'
		? 'https://openrouter.ai/api/v1/chat/completions'
		: 'https://api.openai.com/v1/chat/completions';
	const model = provider === 'openrouter' ? 'openai/gpt-4o-mini' : 'gpt-4o-mini';

	try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model,
				messages: [
					{
						role: 'system',
						content: 'Create a playful retro farming-game crop modifier. Return JSON only with exactly two keys: modifier (one short word, 1-12 letters) and hexColor (a vivid color in the format 0xRRGGBB). Do not include markdown or any other fields.'
					},
					{ role: 'user', content: 'Generate one crop modifier and its tint color.' }
				],
				response_format: { type: 'json_object' },
				max_tokens: 32
			}),
			signal: AbortSignal.timeout(8000)
		});
		if (!response.ok) throw new Error(`${provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} returned HTTP ${response.status}`);

		const data = await response.json();
		const result = JSON.parse(data.choices?.[0]?.message?.content || '{}');
		if (typeof result.modifier !== 'string' || !/^[a-zA-Z]{1,12}$/.test(result.modifier)) {
			throw new Error(`${provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} returned an invalid modifier`);
		}
		if (typeof result.hexColor !== 'string' || !/^0x[\da-fA-F]{6}$/.test(result.hexColor)) {
			throw new Error(`${provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} returned an invalid hex color`);
		}
		return { modifier: result.modifier.toUpperCase(), hexColor: result.hexColor.toLowerCase() };
	} catch (error) {
		console.warn(`${provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} crop modifier generation failed; using a local preset: ${error.message}`);
		return getLocalCropModifier();
	}
}

async function calculateHarvestRewards(kind, baseCropValue) {
	const baseShare = Math.floor(baseCropValue / VEGETABLES_PER_HARVEST);
	const baseValues = Array(VEGETABLES_PER_HARVEST).fill(baseShare);
	baseValues[baseValues.length - 1] += baseCropValue - baseShare * VEGETABLES_PER_HARVEST;
	const averageWeight = AVERAGE_VEGETABLE_WEIGHT_KG[kind] || 0.2;
	let cumulativeValue = 0;
	let cumulativePoints = 0;
	const rewardRolls = baseValues.map(() => {
		const shiny = Math.random() < debugShinyChance;
		return {
			weightKg: rollVegetableWeightKg(),
			shiny,
			getsSpecialModifier: shiny && Math.random() < SHINY_SPECIAL_MODIFIER_CHANCE
		};
	});
	const cropModifiers = await Promise.all(rewardRolls.map(({ getsSpecialModifier }) =>
		getsSpecialModifier ? generateCropModifier() : null
	));
	const rewards = baseValues.map((baseValue, index) => {
		const { weightKg, shiny } = rewardRolls[index];
		const cropModifier = cropModifiers[index];
		const shinyMultiplier = shiny ? SHINY_VALUE_MULTIPLIER : 1;
		const specialModifierMultiplier = cropModifier?.modifier ? SPECIAL_MODIFIER_VALUE_MULTIPLIER : 1;
		const value = Math.round(baseValue * Math.max(1, weightKg / averageWeight) * shinyMultiplier * specialModifierMultiplier * getPlantWorthMultiplier());
		const pointsAfterItem = Math.floor((cumulativeValue + value) * 0.2);
		const pointsForItem = pointsAfterItem - cumulativePoints;
		const bankReturn = value - pointsForItem;
		cumulativeValue += value;
		cumulativePoints = pointsAfterItem;
		return { weightKg, value, bankReturn, shiny, ...cropModifier };
	});
	return {
		rewards,
		totalValue: cumulativeValue,
		points: cumulativePoints,
		bankReturn: cumulativeValue - cumulativePoints
	};
}

function getTileCoordinates(tile) {
	const level = getIslandLevel();
	if (!Number.isInteger(tile) || tile < 1 || tile > level * level) return null;
	return { gridX: (tile - 1) % level, gridY: Math.floor((tile - 1) / level) };
}

function getGrowthMultiplier(tile) {
	const wetness = Math.max(0, Math.min(MAX_TILE_WETNESS, Number(farmState.wetness?.[tile]) || 0));
	return (1 + 4 * wetness / MAX_TILE_WETNESS) * getStreamGrowthMultiplier();
}

function getSubscriberCount() {
	return Array.isArray(farmState.subscribers) ? farmState.subscribers.length : 0;
}

function getStreamGrowthMultiplier() {
	return 1 + getSubscriberCount() * 0.1;
}

function getPlantWorthMultiplier() {
	return 1 + getSubscriberCount() * 0.05;
}

function updateCropReadyTimes(now = Date.now()) {
	for (const tile of Object.keys(farmState.crops)) {
		const crop = farmState.crops[tile];
		if (!crop) continue;
		const duration = CROP_CATALOG[crop.kind].growthMs;
		crop.readyAt = now + Math.max(0, duration - crop.growthProgressMs) / getGrowthMultiplier(tile);
	}
}

async function registerNewSubscriber(userId, username, isMockSimulator = false) {
	const id = String(userId || '').trim();
	if (!id || (farmState.subscribers || []).some((subscriber) => subscriber.id === id)) return false;
	const displayName = String(username || 'New subscriber').trim() || 'New subscriber';
	const now = Date.now();
	for (const tile of Object.keys(farmState.crops)) advanceCropGrowth(tile, now);
	farmState.subscribers = [...(farmState.subscribers || []), { id, username: String(username || 'New subscriber').trim() || 'New subscriber' }];
	updateCropReadyTimes(now);
	await writeJsonFile(FARM_STATE_PATH, farmState);
	const subscriberCount = getSubscriberCount();
	broadcastToBrowsers({
		type: 'farm.subscribed',
		username: displayName,
		subscriberCount,
		flowerFrame: Math.min(3, subscriberCount - 1),
		growthMultiplier: getStreamGrowthMultiplier(),
		plantWorthMultiplier: getPlantWorthMultiplier()
	});
	broadcastFarmState();
	const announcement = `@${displayName} just subbed for the first time! +10% growth speed +5% crop value!`;
	await announceFarmEvent(announcement, isMockSimulator);
	console.log(`New subscriber ${displayName}: ${subscriberCount} this stream; crop growth x${getStreamGrowthMultiplier().toFixed(2)}, crop value x${getPlantWorthMultiplier().toFixed(2)}.`);
	return true;
}

function enqueueNewSubscriber(event) {
	const subscriber = event || {};
	chatCommandQueue = chatCommandQueue
		.then(async () => {
			await waitForHarvestAnimation();
			return registerNewSubscriber(subscriber.user_id, subscriber.user_name || subscriber.user_login);
		})
		.catch((error) => console.error('Failed to process new subscriber:', error));
}

function getCropGrowthSnapshot(tile, crop, now = Date.now()) {
	const duration = CROP_CATALOG[crop.kind].growthMs;
	const updatedAt = Number.isFinite(crop.growthUpdatedAt) ? crop.growthUpdatedAt : crop.plantedAt || now;
	const storedProgress = Number.isFinite(crop.growthProgressMs) ? crop.growthProgressMs : 0;
	const multiplier = getGrowthMultiplier(tile);
	const progress = Math.min(duration, Math.max(0, storedProgress + Math.max(0, now - updatedAt) * multiplier));
	return { progress, multiplier, readyAt: now + Math.max(0, duration - progress) / multiplier };
}

function advanceCropGrowth(tile, now = Date.now()) {
	const crop = farmState.crops[tile];
	if (!crop) return null;
	const snapshot = getCropGrowthSnapshot(tile, crop, now);
	crop.growthProgressMs = snapshot.progress;
	crop.growthUpdatedAt = now;
	crop.readyAt = snapshot.readyAt;
	return crop;
}

const httpServer = createServer(async (request, response) => {
	if (request.method !== 'GET' || !['/', '/index.html', '/utilities.js', '/chat-simulator', '/ChatSimulator/mockchat.html', '/ChatSimulator/simulate-chat.js', '/assets/1x1.png', '/assets/1x1flowers.png', '/assets/2x2.png', '/assets/2x2flowers.png', '/assets/2x2signs.png', '/assets/Carrot.png', '/assets/Carrot1.png', '/assets/Carrot2.png', '/assets/Carrot3.png', '/assets/CarrotSeeds.png', '/assets/Onion.png', '/assets/Onion1.png', '/assets/Onion2.png', '/assets/Onion3.png', '/assets/OnionSeeds.png', '/assets/Potato1.png', '/assets/Potato2.png', '/assets/Potato3.png', '/assets/PotatoSeeds.png', '/assets/emptySack.png', '/assets/carrot.png', '/assets/Potato.png', '/assets/coin.png', '/assets/plantemoji.png', '/assets/WetOverlay.png', '/assets/wateringCan.png', '/assets/PixelifySans-VariableFont_wght.ttf', '/assets/yoster.ttf'].includes(request.url)) {
		response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		response.end('Not found');
		return;
	}

	try {
		const isPngAsset = ['/assets/1x1.png', '/assets/1x1flowers.png', '/assets/2x2.png', '/assets/2x2flowers.png', '/assets/2x2signs.png', '/assets/Carrot.png', '/assets/Carrot1.png', '/assets/Carrot2.png', '/assets/Carrot3.png', '/assets/CarrotSeeds.png', '/assets/Onion.png', '/assets/Onion1.png', '/assets/Onion2.png', '/assets/Onion3.png', '/assets/OnionSeeds.png', '/assets/Potato1.png', '/assets/Potato2.png', '/assets/Potato3.png', '/assets/PotatoSeeds.png', '/assets/emptySack.png', '/assets/carrot.png', '/assets/Potato.png', '/assets/coin.png', '/assets/plantemoji.png', '/assets/WetOverlay.png', '/assets/wateringCan.png'].includes(request.url);
		const isPixelifyFont = request.url === '/assets/PixelifySans-VariableFont_wght.ttf';
		const isYosterFont = request.url === '/assets/yoster.ttf';
		const isUtility = request.url === '/utilities.js';
		const isSimulatorScript = request.url === '/ChatSimulator/simulate-chat.js';
		const simulatorFiles = {
			'/chat-simulator': './ChatSimulator/mockchat.html',
			'/ChatSimulator/mockchat.html': './ChatSimulator/mockchat.html',
			'/ChatSimulator/simulate-chat.js': './ChatSimulator/simulate-chat.js'
		};
		const assetFiles = {
			'/assets/1x1flowers.png': './assets/1x1flowers.png',
			'/assets/2x2.png': './assets/2x2.png',
			'/assets/2x2flowers.png': './assets/2x2flowers.png',
			'/assets/2x2signs.png': './assets/2x2signs.png',
			'/assets/Carrot.png': './assets/Carrot.png',
			'/assets/Carrot1.png': './assets/Carrot1.png',
			'/assets/Carrot2.png': './assets/Carrot2.png',
			'/assets/Carrot3.png': './assets/Carrot3.png',
			'/assets/CarrotSeeds.png': './assets/CarrotSeeds.png',
			'/assets/Onion.png': './assets/Onion.png',
			'/assets/Onion1.png': './assets/Onion1.png',
			'/assets/Onion2.png': './assets/Onion2.png',
			'/assets/Onion3.png': './assets/Onion3.png',
			'/assets/OnionSeeds.png': './assets/OnionSeeds.png',
			'/assets/Potato1.png': './Assets/Potato1.png',
			'/assets/Potato2.png': './Assets/Potato2.png',
			'/assets/Potato3.png': './Assets/Potato3.png',
			'/assets/PotatoSeeds.png': './assets/PotatoSeeds.png',
			'/assets/emptySack.png': './assets/emptySack.png',
			'/assets/carrot.png': './assets/Carrot.png',
			'/assets/Potato.png': './Assets/Potato.png',
			'/assets/coin.png': './assets/coin.png',
			'/assets/plantemoji.png': './assets/plantemoji.png',
			'/assets/WetOverlay.png': './assets/WetOverlay.png',
			'/assets/wateringCan.png': './assets/wateringCan.png'
		};
		const fileName = simulatorFiles[request.url] || assetFiles[request.url] || (request.url === '/assets/1x1.png' ? './assets/1x1.png' : isPixelifyFont ? './assets/PixelifySans-VariableFont_wght.ttf' : isYosterFont ? './assets/yoster.ttf' : isUtility ? './utilities.js' : './index.html');
		const content = await readFile(fileURLToPath(new URL(fileName, import.meta.url)));
		response.writeHead(200, {
			'Content-Type': isPngAsset ? 'image/png' : isPixelifyFont || isYosterFont ? 'font/ttf' : isUtility || isSimulatorScript ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'
		});
		response.end(content);
	} catch (error) {
		console.error('Failed to load overlay page:', error);
		response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
		response.end('Could not load overlay');
	}
});

const browserServer = new WebSocketServer({ server: httpServer });
const mockBrowserClients = new WeakSet();
browserServer.on('connection', (client) => {
	console.log('Overlay page connected to the local WebSocket server.');
	client.on('close', () => mockBrowserClients.delete(client));
	client.on('message', (rawMessage) => {
		try {
			const message = JSON.parse(rawMessage.toString());
			if (message.type === 'mock.register') {
				mockBrowserClients.add(client);
				client.send(JSON.stringify(createMockActivityMessage()));
			} else if (message.type === 'farm.state.request' && mockBrowserClients.has(client)) {
				client.send(JSON.stringify(createFarmStateMessage()));
			} else if (message.type === 'harvest.animation.complete') {
				finishHarvestCommandPause(message.harvestId);
			} else if (message.type === 'mock.command' && mockBrowserClients.has(client)) {
				enqueueMockCommand(message);
			} else if (message.type === 'mock.cheer' && mockBrowserClients.has(client)) {
				enqueueMockCheer(message);
			} else if (message.type === 'mock.sub' && mockBrowserClients.has(client)) {
				enqueueMockSubscription(message);
			} else if (message.type === 'debug.settings.update') {
				if (message.shinyChance === 0.15 || message.shinyChance === 0.5) {
					debugShinyChance = message.shinyChance;
				}
				if (message.activeChatters === 1 || message.activeChatters === 50) {
					debugActiveChatterCount = message.activeChatters;
				}
				if (message.islandLevel === null || message.islandLevel === 1 || message.islandLevel === 2) {
					debugIslandSize = message.islandLevel;
				}
				broadcastDebugSettings();
			}
		} catch (error) {
			console.warn('Ignored invalid overlay WebSocket message:', error.message);
		}
	});
	if (persistentDataReady) client.send(JSON.stringify(createFarmStateMessage()));
	client.send(JSON.stringify(createDebugSettingsMessage()));
	client.send(JSON.stringify(createMockActivityMessage()));
});
httpServer.on('error', (error) => {
	console.error('Local overlay server error:', error);
});
httpServer.listen(LOCAL_WEBSOCKET_PORT, () => {
	console.log(`Overlay page: http://localhost:${LOCAL_WEBSOCKET_PORT}/`);
	console.log(`Mock chat page: http://localhost:${LOCAL_WEBSOCKET_PORT}/chat-simulator`);
	console.log(`Browser WebSocket server listening on ws://localhost:${LOCAL_WEBSOCKET_PORT}`);
	startMockActivityTerminalControls();
});

function broadcastToBrowsers(message) {
	const serializedMessage = JSON.stringify(message);
	for (const client of browserServer.clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(serializedMessage);
		}
	}
}

function createDebugSettingsMessage() {
	return {
		type: 'debug.settings',
		shinyChance: debugShinyChance,
		activeChatters: debugActiveChatterCount,
		islandLevel: debugIslandSize,
		dynamicHarvest: DYNAMIC_HARVEST_ENABLED,
		mockBitsEnabled,
		mockSubsEnabled
	};
}

function broadcastDebugSettings() {
	broadcastToBrowsers(createDebugSettingsMessage());
}

function createMockActivityMessage() {
	const enabled = mockActivityLevel > 0;
	return {
		type: 'mock.control',
		enabled,
		activityLevel: mockActivityLevel,
		activityName: MOCK_ACTIVITY_NAMES[mockActivityLevel],
		intervalMs: enabled ? MOCK_ACTIVITY_INTERVAL_MS[mockActivityLevel] : 0
	};
}

function setMockActivityLevel(level) {
	if (!Number.isInteger(level) || level < 0 || level >= MOCK_ACTIVITY_NAMES.length) return false;
	mockActivityLevel = level;
	broadcastToBrowsers(createMockActivityMessage());
	console.log(`Mock chat activity: ${createMockActivityMessage().activityName}.`);
	return true;
}

async function resetMockFarm() {
	farmState = {
		...createDefaultFarmState(),
		bank: MOCK_RESET_BANK_BALANCE,
		islandLevel: 1
	};
	debugIslandSize = null;
	await writeJsonFile(FARM_STATE_PATH, farmState);
	broadcastDebugSettings();
	broadcastFarmState();
	console.log('Mock farm reset: 1x1 island, 100g, empty tiles. Leaderboard was kept.');
}

function startMockActivityTerminalControls() {
	console.log('Mock controls: mock status | mock off | mock on | mock activity 0-8 | mock shiny | mock size | mock chatters | mock bits | mock subs | mock events | mock reset | mock help');
	if (!process.stdin.isTTY) return;
	const terminal = createInterface({ input: process.stdin, output: process.stdout, prompt: 'farmbot> ' });
	terminal.on('line', async (rawLine) => {
		const [root, action, value] = rawLine.trim().toLowerCase().split(/\s+/);
		if (root !== 'mock' || action === 'help') {
			console.log('Commands: mock status | mock off/on | mock activity 0-8 | mock shiny | mock size | mock chatters | mock bits | mock subs | mock events | mock reset');
		} else if (action === 'off') {
			setMockActivityLevel(0);
		} else if (action === 'on') {
			setMockActivityLevel(mockActivityLevel || 2);
		} else if (action === 'shiny') {
			debugShinyChance = debugShinyChance === 0.15 ? 0.5 : 0.15;
			broadcastDebugSettings();
			console.log(`Mock shiny chance: ${Math.round(debugShinyChance * 100)}%.`);
		} else if (action === 'size') {
			const currentSize = debugIslandSize || getIslandLevel();
			debugIslandSize = currentSize === 1 ? 2 : 1;
			broadcastDebugSettings();
			console.log(`Mock island preview: ${debugIslandSize}x${debugIslandSize}.`);
		} else if (action === 'chatters') {
			debugActiveChatterCount = debugActiveChatterCount === 1 ? 50 : 1;
			broadcastDebugSettings();
			console.log(`Mock active chatters: ${debugActiveChatterCount}.`);
		} else if (action === 'bits') {
			mockBitsEnabled = !mockBitsEnabled;
			broadcastDebugSettings();
			console.log(`Mock random bit donations: ${mockBitsEnabled ? 'on' : 'off'}.`);
		} else if (action === 'subs') {
			mockSubsEnabled = !mockSubsEnabled;
			broadcastDebugSettings();
			console.log(`Mock random subscriptions: ${mockSubsEnabled ? 'on' : 'off'}.`);
		} else if (action === 'events') {
			const enabled = !(mockBitsEnabled && mockSubsEnabled);
			mockBitsEnabled = enabled;
			mockSubsEnabled = enabled;
			broadcastDebugSettings();
			console.log(`Mock random bit donations and subscriptions: ${enabled ? 'on' : 'off'}.`);
		} else if (action === 'reset') {
			setMockActivityLevel(0);
			try {
				await chatCommandQueue;
				await resetMockFarm();
			} catch (error) {
				console.error('Mock farm reset failed:', error);
			}
		} else if (action === 'status') {
			const status = createMockActivityMessage();
			console.log(`Mock chat is ${status.activityName}${status.enabled ? ` (about one command every ${status.intervalMs} ms)` : ''}.`);
			console.log(`Shiny chance: ${Math.round(debugShinyChance * 100)}%; island preview: ${debugIslandSize ? `${debugIslandSize}x${debugIslandSize}` : `farm size (${getIslandLevel()}x${getIslandLevel()})`}; active chatters: ${debugActiveChatterCount}; mock bits: ${mockBitsEnabled ? 'on' : 'off'}; mock subs: ${mockSubsEnabled ? 'on' : 'off'}.`);
		} else if (action === 'activity' && /^\d+$/.test(value || '') && setMockActivityLevel(Number(value))) {
			// Activity level was updated and sent to connected simulator pages.
		} else {
			console.log('Use: mock status | mock off/on | mock activity 0-8 | mock shiny | mock size | mock chatters | mock bits | mock subs | mock events | mock reset | mock help');
		}
		terminal.prompt();
	});
	terminal.prompt();
}

function enqueueMockCommand(message) {
	if (mockActivityLevel === 0) return;
	const requestedName = String(message.username || '').trim();
	const username = MOCK_CHAT_USERS.find((candidate) => candidate.toLowerCase() === requestedName.toLowerCase());
	const text = String(message.text || '').trim().slice(0, 120);
	if (!username || !/^!(?:plant\s+\S+\s+\d+|water\s+#?\d+|harvest\s+#?\d+)$/i.test(text)) return;
	const chatterLogin = username.toLowerCase();
	const event = {
		broadcaster_user_id: CHAT_CHANNEL_USER_ID,
		broadcaster_user_login: 'farm',
		chatter_user_id: `mock-${chatterLogin}`,
		chatter_user_login: chatterLogin,
		chatter_user_name: username,
		message: { text },
		isMockSimulator: true
	};
	recentChatters.set(chatterLogin, Date.now());
	const activeChattersAtMessage = getActiveChatterCount();
	chatCommandQueue = chatCommandQueue
		.then(async () => {
			await waitForHarvestAnimation();
			return handleFarmCommand(event, text, chatterLogin, activeChattersAtMessage);
		})
		.catch((error) => console.error('Failed to process mock chat command:', error));
}

function enqueueMockCheer(message) {
	if (!mockBitsEnabled) return;
	const requestedName = String(message.username || '').trim();
	const username = MOCK_CHAT_USERS.find((candidate) => candidate.toLowerCase() === requestedName.toLowerCase());
	const bits = Number(message.bits);
	if (!username || !Number.isSafeInteger(bits) || bits <= 500 || bits > 10_000) return;
	chatCommandQueue = chatCommandQueue
		.then(async () => {
			await waitForHarvestAnimation();
			return growAllCropsImmediately(username, bits, true);
		})
		.catch((error) => console.error('Failed to process mock cheer:', error));
}

function enqueueMockSubscription(message) {
	if (!mockSubsEnabled) return;
	const requestedName = String(message.username || '').trim();
	const username = MOCK_CHAT_USERS.find((candidate) => candidate.toLowerCase() === requestedName.toLowerCase());
	if (!username) return;
	const requestedId = String(message.subscriberId || '');
	const subscriberId = /^mock-subscriber-[\w-]{1,80}$/.test(requestedId)
		? requestedId
		: `mock-${username.toLowerCase()}`;
	chatCommandQueue = chatCommandQueue
		.then(async () => {
			await waitForHarvestAnimation();
			return registerNewSubscriber(subscriberId, username, true);
		})
		.catch((error) => console.error('Failed to process mock subscription:', error));
}

function beginHarvestCommandPause() {
	if (activeHarvestAnimationId !== null) return activeHarvestAnimationId;
	const hasOverlay = [...browserServer.clients].some((client) => client.readyState === WebSocket.OPEN && !mockBrowserClients.has(client));
	if (!hasOverlay) return null;
	const harvestId = ++harvestAnimationSequence;
	activeHarvestAnimationId = harvestId;
	harvestCommandGate = new Promise((resolve) => { releaseHarvestCommandGate = resolve; });
	harvestCommandFallbackTimer = setTimeout(() => finishHarvestCommandPause(harvestId), HARVEST_COMMAND_QUEUE_FALLBACK_MS);
	harvestCommandFallbackTimer.unref?.();
	return harvestId;
}

function finishHarvestCommandPause(harvestId) {
	if (activeHarvestAnimationId === null || harvestId !== activeHarvestAnimationId) return;
	if (harvestCommandFallbackTimer) clearTimeout(harvestCommandFallbackTimer);
	harvestCommandFallbackTimer = null;
	broadcastFarmState();
	broadcastToBrowsers({ type: 'farm.harvest.animation.complete', harvestId });
	activeHarvestAnimationId = null;
	const release = releaseHarvestCommandGate;
	releaseHarvestCommandGate = null;
	harvestCommandGate = null;
	release?.();
}

async function waitForHarvestAnimation() {
	while (harvestCommandGate) await harvestCommandGate;
}

function queueStreamLeaderboardReset(streamId, reason) {
	chatCommandQueue = chatCommandQueue
		.then(async () => {
			leaderboard = createEmptyLeaderboard(streamId);
			await writeJsonFile(LEADERBOARD_PATH, leaderboard);
			if (farmState.subscribers.length) {
				const now = Date.now();
				for (const tile of Object.keys(farmState.crops)) advanceCropGrowth(tile, now);
				farmState.subscribers = [];
				updateCropReadyTimes(now);
				await writeJsonFile(FARM_STATE_PATH, farmState);
				broadcastFarmState();
			}
			console.log(`Stream leaderboard reset (${reason}).`);
		})
		.catch((error) => console.error('Failed to reset stream leaderboard:', error));
}

async function readJsonFile(path, fallback) {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT') return fallback;
		throw error;
	}
}

async function writeJsonFile(path, value) {
	const temporaryPath = `${path}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
	await rename(temporaryPath, path);
}

async function loadPersistentData() {
	const savedFarm = await readJsonFile(FARM_STATE_PATH, createDefaultFarmState());
	const savedLeaderboard = await readJsonFile(LEADERBOARD_PATH, createEmptyLeaderboard());
	const priorHarvestCount = Object.values(savedLeaderboard?.users || {})
		.reduce((total, user) => total + (Number.isSafeInteger(user.harvests) ? user.harvests : 0), 0);
	const harvestedCrops = Number.isSafeInteger(savedFarm.harvestedCrops) && savedFarm.harvestedCrops >= 0
		? savedFarm.harvestedCrops
		: priorHarvestCount;
	const savedIslandLevel = Number.isInteger(savedFarm.islandLevel) && savedFarm.islandLevel >= 1
		? Math.min(MAX_ISLAND_LEVEL, savedFarm.islandLevel)
		: getIslandLevelForHarvestCount(harvestedCrops);
	farmState = {
		bank: Number.isSafeInteger(savedFarm.bank) && savedFarm.bank >= 0 ? savedFarm.bank : STARTING_BANK_BALANCE,
		harvestedCrops,
		islandLevel: savedIslandLevel,
		crops: { ...createDefaultFarmState().crops, ...(savedFarm.crops || {}) },
		wetness: { ...createDefaultFarmState().wetness, ...(savedFarm.wetness || {}) },
		subscribers: Array.isArray(savedFarm.subscribers)
			? savedFarm.subscribers.filter((subscriber) => subscriber && typeof subscriber.id === 'string').map((subscriber) => ({
				id: subscriber.id,
				username: typeof subscriber.username === 'string' ? subscriber.username : 'New subscriber'
			}))
			: []
	};
	for (const tile of Object.keys(farmState.wetness)) {
		const wetness = Number(farmState.wetness[tile]);
		farmState.wetness[tile] = Number.isInteger(wetness) ? Math.max(0, Math.min(MAX_TILE_WETNESS, wetness)) : 0;
	}
	for (const tile of Object.keys(farmState.crops)) {
		const crop = farmState.crops[tile];
		if (!crop || typeof crop !== 'object' || !CROP_CATALOG[crop.kind]) {
			farmState.crops[tile] = null;
			continue;
		}
		crop.votes = Array.isArray(crop.votes) ? crop.votes : [];
		crop.requiredVotes = Number.isInteger(crop.requiredVotes) && crop.requiredVotes > 0 ? crop.requiredVotes : null;
		const now = Date.now();
		const duration = CROP_CATALOG[crop.kind].growthMs;
		if (!Number.isFinite(crop.growthProgressMs)) {
			const remaining = Number.isFinite(crop.readyAt) ? Math.max(0, crop.readyAt - now) : duration;
			crop.growthProgressMs = Math.max(0, Math.min(duration, duration - remaining));
			crop.growthUpdatedAt = now;
		} else {
			const updatedAt = Number.isFinite(crop.growthUpdatedAt) ? crop.growthUpdatedAt : now;
			crop.growthProgressMs += Math.max(0, now - updatedAt) * getGrowthMultiplier(tile);
			crop.growthUpdatedAt = now;
		}
		crop.growthProgressMs = Math.max(0, Math.min(duration, crop.growthProgressMs));
		crop.readyAt = now + Math.max(0, duration - crop.growthProgressMs) / getGrowthMultiplier(tile);
	}
	const hasSavedStreamId = typeof savedLeaderboard?.streamId === 'string' && savedLeaderboard.streamId.length > 0;
	const savedStreamId = hasSavedStreamId ? savedLeaderboard.streamId : `session-${Date.now()}`;
	leaderboard = savedLeaderboard && savedLeaderboard.users && typeof savedLeaderboard.users === 'object'
		? {
			...savedLeaderboard,
			streamId: savedStreamId,
			users: hasSavedStreamId ? savedLeaderboard.users : {},
			mostValuableCrop: hasSavedStreamId ? savedLeaderboard.mostValuableCrop || null : null
		}
		: createEmptyLeaderboard(savedStreamId);
	persistentDataReady = true;
	await writeJsonFile(FARM_STATE_PATH, farmState);
	await writeJsonFile(LEADERBOARD_PATH, leaderboard);
	broadcastToBrowsers(createFarmStateMessage());
	console.log(`Loaded shared farm state with $${farmState.bank} in the bank.`);
}

function createFarmStateMessage() {
	const now = Date.now();
	const crops = Object.fromEntries(Object.entries(farmState.crops).map(([tile, crop]) => {
		if (!crop) return [tile, null];
		const snapshot = getCropGrowthSnapshot(tile, crop, now);
		return [tile, { ...crop, growthProgressMs: snapshot.progress, growthUpdatedAt: now, readyAt: snapshot.readyAt }];
	}));
	return {
		type: 'farm.state',
		bank: farmState.bank,
		harvestedCrops: farmState.harvestedCrops,
		level: getIslandLevel(),
		subscriberCount: getSubscriberCount(),
		growthMultiplier: getStreamGrowthMultiplier(),
		plantWorthMultiplier: getPlantWorthMultiplier(),
		wetness: farmState.wetness,
		crops
	};
}

function broadcastFarmState() {
	broadcastToBrowsers(createFarmStateMessage());
}

function getActiveChatterCount() {
	const cutoff = Date.now() - ACTIVE_CHATTER_WINDOW_MS;
	for (const [login, lastMessageAt] of recentChatters) {
		if (lastMessageAt < cutoff) recentChatters.delete(login);
	}
	return Math.max(debugActiveChatterCount, recentChatters.size);
}

function isChannelOwner(event) {
	const chatterId = String(event?.chatter_user_id || '');
	const ownerIds = [CHAT_CHANNEL_USER_ID, event?.broadcaster_user_id]
		.filter(Boolean)
		.map(String);
	if (chatterId && ownerIds.includes(chatterId)) return true;
	const chatterLogin = String(event?.chatter_user_login || '').toLowerCase();
	const broadcasterLogin = String(event?.broadcaster_user_login || '').toLowerCase();
	return Boolean(chatterLogin && broadcasterLogin && chatterLogin === broadcasterLogin);
}

function getRequiredHarvestVotes(activeChatters) {
	if (!DYNAMIC_HARVEST_ENABLED) return 1;
	const chatterCount = Math.max(0, Number(activeChatters) || 0);
	if (chatterCount < 10) return 1;
	return Math.min(5, 2 + Math.floor(Math.max(0, chatterCount - 50) / 100));
}

function cropName(kind) {
	return CROP_CATALOG[kind]?.name || kind;
}

function normalizeCropName(value) {
	const normalized = String(value || '').toLowerCase();
	return CROP_CATALOG[normalized] ? normalized : CROP_ALIASES[normalized];
}

function formatShopMessage() {
	const level = getIslandLevel();
	return `🌱Farm shop🌱 | Shared bank: $${farmState.bank}. •Potato: FREE; •Carrot: $75; •Onion: $150. Plant with !plant potato 1 (tiles 1-${level ** 2}). !Leaderboard to see who has the most farm points!`;
}

function formatStreamLeaderboard() {
	const topFarmers = Object.entries(leaderboard.users)
		.sort((a, b) => (Number(b[1].points) || 0) - (Number(a[1].points) || 0))
		.slice(0, 3);
	const pointsLine = topFarmers.length
		? `✨Top farm points: ${topFarmers.map(([login, user], index) => `${index + 1}. ${user.username || login} ${Number(user.points) || 0} pts`).join(' | ')}`
		: '✨Top farm points: none yet';
	const bestCrop = leaderboard.mostValuableCrop;
	if (!bestCrop) return `${pointsLine}. 🌱Most valuable crop: none yet.`;
	const weightKg = Number(bestCrop.weightKg) || 0;
	const modifiers = [
		bestCrop.modifier,
		bestCrop.shiny ? 'SHINY' : null,
		weightKg >= 1 ? 'MASSIVE' : weightKg >= 0.3 ? 'CHUNKY' : null
	].filter(Boolean);
	const modifierText = modifiers.length ? modifiers.join(', ') : 'no modifiers';
	const cropLine = `🌱Most valuable crop: ${bestCrop.username} planted ${weightKg.toFixed(2)} kg ${cropName(bestCrop.kind)} (${modifierText}, ${Number(bestCrop.value) || 0}g).`;
	return `${pointsLine}. ${cropLine}`;
}

async function sendPrivateMessage(toUserId, message) {
	if (!tokenScopes.has('user:manage:whispers')) {
		console.error('Could not send private Twitch reply: authorize the bot token with user:manage:whispers.');
		return false;
	}
	const url = new URL('https://api.twitch.tv/helix/whispers');
	url.searchParams.set('from_user_id', BOT_USER_ID);
	url.searchParams.set('to_user_id', toUserId);
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Authorization': 'Bearer ' + OAUTH_TOKEN,
			'Client-Id': CLIENT_ID,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ message })
	});
	if (response.status !== 204) {
		console.error(`Failed to send private Twitch reply (HTTP ${response.status}): ${await response.text()}`);
		return false;
	}
	return true;
}

async function sendFarmReply(event, chatterLogin, message, whisper = false) {
	if (event?.isMockSimulator) {
		broadcastToBrowsers({ type: 'chat.message', direction: 'outgoing', message, simulated: true });
		return true;
	}
	if (whisper) return sendPrivateMessage(event.chatter_user_id, message);
	return sendChatMessage(message);
}

async function announceFarmEvent(message, isMockSimulator = false) {
	if (isMockSimulator) {
		broadcastToBrowsers({ type: 'chat.message', direction: 'outgoing', message, simulated: true });
		return;
	}
	try {
		await sendChatMessage(message);
	} catch (error) {
		console.error('Failed to announce farm event in chat:', error.message);
	}
}

var websocketSessionID;

// Start executing the bot from here
(async () => {
	await loadPersistentData();
	// Verify that the authentication is valid
	await getAuth();
	channelOwnerTokenReady = await validateChannelOwnerToken();

	// Start WebSocket client and register handlers
	const websocketClient = startWebSocketClient();
	if (channelOwnerTokenReady && oauthUserId !== String(CHAT_CHANNEL_USER_ID)) {
		startChannelOwnerSubscriptionClient(CHANNEL_OWNER_OAUTH_TOKEN);
	}
})();

// WebSocket will persist the application loop until you exit the program forcefully

async function getAuth() {
	// https://dev.twitch.tv/docs/authentication/validate-tokens/#how-to-validate-a-token
	const response = await fetch('https://id.twitch.tv/oauth2/validate', {
		method: 'GET',
		headers: {
			'Authorization': 'OAuth ' + OAUTH_TOKEN
		}
	});



	if (response.status != 200) {
		const data = await response.json();
		console.error("Token is not valid. /oauth2/validate returned status code " + response.status);
		console.error(data);
		process.exit(1);
	}

	const data = await response.json();
	tokenScopes = new Set(data.scopes || []);
	oauthUserId = String(data.user_id || '');
	console.log('Validated token.');
	if (!tokenScopes.has('user:manage:whispers')) {
		console.warn('The token is missing user:manage:whispers; !shop and !leaderboard cannot send private Twitch whispers until it is reauthorized with that scope.');
	}
}

async function validateChannelOwnerToken() {
	if (!CHANNEL_OWNER_OAUTH_TOKEN) return false;
	try {
		const response = await fetch('https://id.twitch.tv/oauth2/validate', {
			method: 'GET',
			headers: { 'Authorization': `OAuth ${CHANNEL_OWNER_OAUTH_TOKEN}` }
		});
		if (response.status !== 200) throw new Error(`token validation returned HTTP ${response.status}`);
		const data = await response.json();
		const scopes = new Set(data.scopes || []);
		if (String(data.user_id || '') !== String(CHAT_CHANNEL_USER_ID)) {
			throw new Error('token does not belong to CHAT_CHANNEL_USER_ID');
		}
		if (!scopes.has('channel:read:subscriptions')) {
			throw new Error('token is missing channel:read:subscriptions');
		}
		return true;
	} catch (error) {
		console.warn(`Real subscriber flowers are disabled: CHANNEL_OWNER_OAUTH_TOKEN ${error.message}.`);
		return false;
	}
}

function startChannelOwnerSubscriptionClient(accessToken) {
	const client = new WebSocket(EVENTSUB_WEBSOCKET_URL);
	client.on('error', (error) => console.error('Channel owner EventSub WebSocket error:', error.message));
	client.on('open', () => console.log('Channel owner EventSub WebSocket connected.'));
	client.on('message', async (rawMessage) => {
		try {
			const data = JSON.parse(rawMessage.toString());
			if (data.metadata?.message_type === 'session_welcome') {
				const sessionId = data.payload.session.id;
				const response = await subscribeToChannelSubscribe(sessionId, accessToken);
				if (!response) console.warn('Real subscriber flowers could not be enabled through the channel owner EventSub connection.');
			} else if (data.metadata?.message_type === 'notification' && data.metadata.subscription_type === 'channel.subscribe') {
				enqueueNewSubscriber(data.payload.event);
			}
		} catch (error) {
			console.error('Failed to initialize channel owner EventSub:', error.message);
		}
	});
	return client;
}

function startWebSocketClient() {
	let websocketClient = new WebSocket(EVENTSUB_WEBSOCKET_URL);

	websocketClient.on('error', console.error);

	websocketClient.on('open', () => {
		console.log('WebSocket connection opened to ' + EVENTSUB_WEBSOCKET_URL);
	});

	websocketClient.on('message', (data) => {
		handleWebSocketMessage(JSON.parse(data.toString()));
	});

	return websocketClient;
}

function handleWebSocketMessage(data) {
	switch (data.metadata.message_type) {
		case 'session_welcome': // First message you get from the WebSocket server when connecting
			websocketSessionID = data.payload.session.id; // Register the Session ID it gives us

			// Listen to EventSub, which joins the chatroom from your bot's account
			registerEventSubListeners();
			break;
		case 'notification': // An EventSub notification has occurred, such as channel.chat.message
			switch (data.metadata.subscription_type) {
				case 'channel.chat.message':
					const chatEvent = data.payload.event;
					const chatText = chatEvent.message.text.trim();
					const chatterLogin = (chatEvent.chatter_user_login || chatEvent.chatter_user_name).toLowerCase();
					if (chatEvent.chatter_user_id !== BOT_USER_ID) recentChatters.set(chatterLogin, Date.now());
					const activeChattersAtMessage = getActiveChatterCount();
					broadcastToBrowsers({
						type: 'chat.message',
						direction: 'incoming',
						event: chatEvent
					});

					// First, print the message to the program's console.
					console.log(`MSG #${chatEvent.broadcaster_user_login} <${chatEvent.chatter_user_login}> ${chatText}`);
					chatCommandQueue = chatCommandQueue
						.then(async () => {
							await waitForHarvestAnimation();
							return handleFarmCommand(chatEvent, chatText, chatterLogin, activeChattersAtMessage);
						})
						.catch((error) => console.error('Failed to process chat command:', error));

					// Then check to see if that message was "HeyGuys"
					if (chatText == "HeyGuys") {
						// If so, send back "VoHiYo" to the chatroom
						sendChatMessage("VoHiYo")
					}

					break;
				case 'stream.online': {
					const streamId = String(data.payload.event.id || '');
					if (streamId && streamId !== leaderboard.streamId) {
						queueStreamLeaderboardReset(streamId, 'new stream started');
					}
					break;
				}
				case 'stream.offline':
					queueStreamLeaderboardReset(null, 'stream ended');
					break;
				case 'channel.subscribe': {
					enqueueNewSubscriber(data.payload.event);
					break;
				}
				case 'channel.cheer': {
					const cheerEvent = data.payload.event;
					const bits = Number(cheerEvent.bits) || 0;
					if (bits < 500) break;
					const username = cheerEvent.user_name || cheerEvent.user_login || 'Anonymous';
					chatCommandQueue = chatCommandQueue
						.then(async () => {
							await waitForHarvestAnimation();
							return growAllCropsImmediately(username, bits);
						})
						.catch((error) => console.error('Failed to process cheer reward:', error));
					break;
				}
			}
			break;
	}
}

async function handleFarmCommand(event, text, chatterLogin, activeChattersAtMessage) {
	const chatterName = event.chatter_user_name || event.chatter_user_login || chatterLogin;
	if (/^!shop$/i.test(text)) {
		await sendFarmReply(event, chatterLogin, formatShopMessage(), !isChannelOwner(event));
		return;
	}

	const waterMatch = text.match(/^!water\s+#?(\d+)$/i);
	if (waterMatch) {
		await waterTile(event, chatterLogin, Number(waterMatch[1]));
		return;
	}
	if (/^!water\b/i.test(text)) {
		await sendFarmReply(event, chatterLogin, `@${chatterLogin} use !water 1 to water a tile (tiles 1-${getIslandLevel() ** 2}).`);
		return;
	}

	if (/^!leaderboard$/i.test(text)) {
		await sendFarmReply(event, chatterLogin, formatStreamLeaderboard().slice(0, 490), !isChannelOwner(event));
		return;
	}

	const plantMatch = text.match(/^!plant\s+(\S+)\s+(\d+)$/i);
	if (plantMatch) {
		await buyCrop(event, chatterLogin, chatterName, normalizeCropName(plantMatch[1]), Number(plantMatch[2]));
		return;
	}
	if (/^!plant\b/i.test(text)) {
		await sendFarmReply(event, chatterLogin, `@${chatterLogin} use !plant potato 1 (crop type, then tile 1-${getIslandLevel() ** 2}).`);
		return;
	}

	const harvestMatch = text.match(/^!harvest\s+#?(\d+)$/i);
	if (harvestMatch) {
		await voteToHarvest(event, chatterLogin, Number(harvestMatch[1]), activeChattersAtMessage);
		return;
	}
	if (/^!harvest\b/i.test(text)) {
		await sendFarmReply(event, chatterLogin, `@${chatterLogin} use !harvest 1 to vote on a tile (tiles 1-${getIslandLevel() ** 2}).`);
	}
}

async function waterTile(event, chatterLogin, tile) {
	if (!getTileCoordinates(tile)) {
		await sendFarmReply(event, chatterLogin, `@${chatterLogin} choose an unlocked tile from 1 to ${getIslandLevel() ** 2}.`);
		return;
	}
	const now = Date.now();
	const login = String(event.chatter_user_login || chatterLogin).toLowerCase();
	for (const [user, cooldownUntil] of waterCommandCooldowns) {
		if (cooldownUntil <= now) waterCommandCooldowns.delete(user);
	}
	if (!isChannelOwner(event)) {
		const cooldownUntil = waterCommandCooldowns.get(login) || 0;
		if (cooldownUntil > now) {
			await sendFarmReply(event, chatterLogin, `@${chatterLogin} you can water again in ${Math.ceil((cooldownUntil - now) / 1000)} seconds.`);
			return;
		}
		waterCommandCooldowns.set(login, now + WATER_COMMAND_COOLDOWN_MS);
	}
	const wetness = farmState.wetness[tile] || 0;
	if (wetness >= MAX_TILE_WETNESS) {
		await sendFarmReply(event, chatterLogin, `@${chatterLogin} tile ${tile} is fully watered.`);
		return;
	}
	const crop = advanceCropGrowth(tile, now);
	farmState.wetness[tile] = wetness + 1;
	if (crop) advanceCropGrowth(tile, now);
	await writeJsonFile(FARM_STATE_PATH, farmState);
	broadcastFarmState();
	broadcastToBrowsers({ type: 'farm.watered', tile, wetness: farmState.wetness[tile], username: event.chatter_user_name || chatterLogin });
	const multiplier = getGrowthMultiplier(tile);
	await sendFarmReply(event, chatterLogin, `@${chatterLogin} watered tile ${tile} (${farmState.wetness[tile]}/${MAX_TILE_WETNESS}); crop growth is now ${multiplier.toFixed(1)}x faster.`);
}

async function buyCrop(event, chatterLogin, chatterName, kind, tile) {
	if (!kind) {
		await sendFarmReply(event, chatterLogin, `@${chatterLogin} crops for sale: Potato (free), Carrot ($75), Onion ($150).`);
		return;
	}
	if (!getTileCoordinates(tile)) {
		await sendFarmReply(event, chatterLogin, `@${chatterLogin} choose an unlocked tile from 1 to ${getIslandLevel() ** 2}.`);
		return;
	}
	if (farmState.crops[tile]) {
		await sendFarmReply(event, chatterLogin, `@${chatterLogin} tile ${tile} is occupied; harvest it before planting again.`);
		return;
	}
	const crop = CROP_CATALOG[kind];
	if (farmState.bank < crop.price) {
		await sendFarmReply(event, chatterLogin, `@${chatterLogin} the shared bank only has $${farmState.bank}; ${crop.name} costs $${crop.price}.`);
		return;
	}

	farmState.bank -= crop.price;
	const plantedAt = Date.now();
	farmState.crops[tile] = {
		kind,
		ownerLogin: chatterLogin,
		ownerName: chatterName,
		plantedAt,
		growthProgressMs: 0,
		growthUpdatedAt: plantedAt,
		readyAt: plantedAt + crop.growthMs / getGrowthMultiplier(tile),
		votes: [],
		requiredVotes: null
	};
	await writeJsonFile(FARM_STATE_PATH, farmState);
	broadcastToBrowsers({ type: 'farm.planted', tile, crop: kind, username: chatterName });
	broadcastFarmState();
	const growthSeconds = Math.ceil((farmState.crops[tile].readyAt - plantedAt) / 1000);
	await sendFarmReply(event, chatterLogin, `@${chatterLogin} planted ${crop.name} on tile ${tile} for $${crop.price}. It will be ready in ${growthSeconds} seconds. Shared bank: $${farmState.bank}.`);
}

async function growAllCropsImmediately(username, bits, isMockSimulator = false) {
	const now = Date.now();
	let cropsGrown = 0;
	for (const [tile, crop] of Object.entries(farmState.crops)) {
		if (!crop) continue;
		const duration = CROP_CATALOG[crop.kind]?.growthMs;
		if (!duration) continue;
		crop.growthProgressMs = duration;
		crop.growthUpdatedAt = now;
		crop.readyAt = now;
		cropsGrown += 1;
	}
	await writeJsonFile(FARM_STATE_PATH, farmState);
	broadcastFarmState();
	broadcastToBrowsers({ type: 'farm.cheer.grow', username, bits, cropsGrown });
	await announceFarmEvent(`@${username} donated ${bits} bits, all crops instantly grown!`, isMockSimulator);
	console.log(`${username} cheered ${bits} bits; instantly grew ${cropsGrown} crops.`);
}

async function voteToHarvest(event, chatterLogin, tile, activeChattersAtMessage) {
	if (!getTileCoordinates(tile)) {
		await sendFarmReply(event, chatterLogin, `@${chatterLogin} choose an unlocked tile from 1 to ${getIslandLevel() ** 2}.`);
		return;
	}
	const crop = advanceCropGrowth(tile);
	if (!crop) {
		await sendFarmReply(event, chatterLogin, `@${chatterLogin} there is no crop on tile ${tile}.`);
		return;
	}
	if (Date.now() < crop.readyAt) {
		const secondsLeft = Math.ceil((crop.readyAt - Date.now()) / 1000);
		await sendFarmReply(event, chatterLogin, `@${chatterLogin} ${cropName(crop.kind)} on tile ${tile} needs ${secondsLeft} more seconds to grow.`);
		return;
	}

	const previousRequiredVotes = crop.requiredVotes;
	crop.requiredVotes = getRequiredHarvestVotes(activeChattersAtMessage);
	const voter = (event.chatter_user_login || chatterLogin).toLowerCase();
	const newVote = !crop.votes.includes(voter);
	if (newVote) crop.votes.push(voter);
	const harvestComplete = crop.votes.length >= crop.requiredVotes;
	if (crop.votes.length < crop.requiredVotes) {
		if (newVote || previousRequiredVotes !== crop.requiredVotes) {
			await writeJsonFile(FARM_STATE_PATH, farmState);
		}
		if (DYNAMIC_HARVEST_ENABLED) {
			broadcastToBrowsers({
				type: 'farm.harvest.progress', tile, votes: crop.votes.length, required: crop.requiredVotes,
				message: `${crop.votes.length}/${crop.requiredVotes} unique chatters`,
				username: event.chatter_user_name || chatterLogin, newVote, complete: false
			});
		}
		if (newVote) {
			await sendFarmReply(event, chatterLogin, `Harvest on tile ${tile}: ${crop.votes.length}/${crop.requiredVotes} unique chatters voted.`);
		}
		return;
	}
	await writeJsonFile(FARM_STATE_PATH, farmState);
	if (DYNAMIC_HARVEST_ENABLED) {
		broadcastToBrowsers({
			type: 'farm.harvest.progress', tile, votes: crop.votes.length, required: crop.requiredVotes,
			message: `${crop.votes.length}/${crop.requiredVotes} unique chatters`,
			username: event.chatter_user_name || chatterLogin,
			newVote,
			complete: harvestComplete
		});
	}

	const spec = CROP_CATALOG[crop.kind];
	const previousLevel = getIslandLevel();
	const planterLogin = (crop.ownerLogin || 'unknown').toLowerCase();
	const planter = leaderboard.users[planterLogin] || { username: crop.ownerName || planterLogin, points: 0, harvests: 0 };
	const { rewards, totalValue, points, bankReturn } = await calculateHarvestRewards(crop.kind, spec.value);
	planter.username = crop.ownerName || planter.username || planterLogin;
	planter.points += points;
	planter.harvests += 1;
	leaderboard.users[planterLogin] = planter;
	for (const reward of rewards) {
		if (!leaderboard.mostValuableCrop || reward.value > leaderboard.mostValuableCrop.value) {
			leaderboard.mostValuableCrop = {
				username: planter.username,
				login: planterLogin,
				kind: crop.kind,
				weightKg: reward.weightKg,
				value: reward.value,
				modifier: reward.modifier || null,
				shiny: reward.shiny === true
			};
		}
	}
	farmState.bank += bankReturn;
	farmState.harvestedCrops += 1;
	farmState.islandLevel = getIslandLevelForHarvestCount(farmState.harvestedCrops);
	farmState.crops[tile] = null;
	farmState.wetness[tile] = 0;
	const newLevel = getIslandLevel();
	await writeJsonFile(FARM_STATE_PATH, farmState);
	await writeJsonFile(LEADERBOARD_PATH, leaderboard);
	const harvestId = beginHarvestCommandPause();
	broadcastToBrowsers({
		type: 'farm.harvested', tile, crop: crop.kind, planter: planter.username,
		username: event.chatter_user_name || chatterLogin, rewards, totalValue, bankReturn, points, harvestId
	});
	if (harvestId === null) broadcastFarmState();
	const levelUpMessage = newLevel > previousLevel ? ` The island expanded to ${newLevel}x${newLevel}!` : '';
	await sendFarmReply(event, chatterLogin, `${cropName(crop.kind)} harvested on tile ${tile}! $${bankReturn} added to the shared bank; ${planter.username} earns ${points} points. Shared bank: $${farmState.bank}.${levelUpMessage}`);
}

async function sendChatMessage(chatMessage) {
	let response = await fetch('https://api.twitch.tv/helix/chat/messages', {
		method: 'POST',
		headers: {
			'Authorization': 'Bearer ' + OAUTH_TOKEN,
			'Client-Id': CLIENT_ID,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			broadcaster_id: CHAT_CHANNEL_USER_ID,
			sender_id: BOT_USER_ID,
			message: chatMessage
		})
	});

	if (response.status != 200) {
		let data = await response.json();
		console.error("Failed to send chat message");
		console.error(data);
	} else {
		console.log("Sent chat message: " + chatMessage);
		broadcastToBrowsers({
			type: 'chat.message',
			direction: 'outgoing',
			message: chatMessage
		});
	}
}

async function registerEventSubListeners() {
	// Register channel.chat.message
	let response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
		method: 'POST',
		headers: {
			'Authorization': 'Bearer ' + OAUTH_TOKEN,
			'Client-Id': CLIENT_ID,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			type: 'channel.chat.message',
			version: '1',
			condition: {
				broadcaster_user_id: CHAT_CHANNEL_USER_ID,
				user_id: BOT_USER_ID
			},
			transport: {
				method: 'websocket',
				session_id: websocketSessionID
			}
		})
	});

	if (response.status != 202) {
		let data = await response.json();
		console.error("Failed to subscribe to channel.chat.message. API call returned status code " + response.status);
		console.error(data);
		process.exit(1);
	} else {
		const data = await response.json();
		console.log(`Subscribed to channel.chat.message [${data.data[0].id}]`);
	}

	for (const type of ['stream.online', 'stream.offline']) {
		response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
			method: 'POST',
			headers: {
				'Authorization': 'Bearer ' + OAUTH_TOKEN,
				'Client-Id': CLIENT_ID,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				type,
				version: '1',
				condition: { broadcaster_user_id: CHAT_CHANNEL_USER_ID },
				transport: { method: 'websocket', session_id: websocketSessionID }
			})
		});
		const data = await response.json().catch(() => ({}));
		if (response.status !== 202) {
			console.warn(`Failed to subscribe to ${type} (HTTP ${response.status}):`, data);
		} else {
			console.log(`Subscribed to ${type} [${data.data?.[0]?.id || 'enabled'}]`);
		}
	}

	if (oauthUserId === String(CHAT_CHANNEL_USER_ID) && tokenScopes.has('channel:read:subscriptions')) {
		await subscribeToChannelSubscribe(websocketSessionID, OAUTH_TOKEN);
	} else if (!channelOwnerTokenReady) {
		console.warn('Real subscriber flower events are disabled. Authorize the channel owner with channel:read:subscriptions and set CHANNEL_OWNER_OAUTH_TOKEN, or add that scope to OAUTH_TOKEN when it belongs to the channel owner.');
	}

	if (!tokenScopes.has('bits:read')) {
		console.warn('500-bit crop growth is disabled until the OAuth token is authorized with bits:read.');
		return;
	}
	response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
		method: 'POST',
		headers: {
			'Authorization': 'Bearer ' + OAUTH_TOKEN,
			'Client-Id': CLIENT_ID,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			type: 'channel.cheer',
			version: '1',
			condition: { broadcaster_user_id: CHAT_CHANNEL_USER_ID },
			transport: { method: 'websocket', session_id: websocketSessionID }
		})
	});
	if (response.status !== 202) {
		const data = await response.json();
		console.error(`Failed to subscribe to channel.cheer. API call returned status code ${response.status}`);
		console.error(data);
	} else {
		const data = await response.json();
		console.log(`Subscribed to channel.cheer [${data.data[0].id}]`);
	}
}

async function subscribeToChannelSubscribe(sessionId, accessToken) {
	const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${accessToken}`,
			'Client-Id': CLIENT_ID,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			type: 'channel.subscribe',
			version: '1',
			condition: { broadcaster_user_id: CHAT_CHANNEL_USER_ID },
			transport: { method: 'websocket', session_id: sessionId }
		})
	});
	const data = await response.json().catch(() => ({}));
	if (response.status !== 202) {
		console.warn(`Failed to subscribe to channel.subscribe (HTTP ${response.status}):`, data);
		return false;
	}
	console.log(`Subscribed to channel.subscribe [${data.data?.[0]?.id || 'enabled'}]`);
	return true;
}
