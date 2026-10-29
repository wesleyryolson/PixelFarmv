import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const BOT_USER_ID = process.env.BOT_USER_ID; // This is the User ID of the chat bot
const OAUTH_TOKEN = process.env.OAUTH_TOKEN; // Also needs user:manage:whispers for private !shop replies
const CLIENT_ID = process.env.CLIENT_ID;


const CHAT_CHANNEL_USER_ID = process.env.CHAT_CHANNEL_USER_ID;

const EVENTSUB_WEBSOCKET_URL = 'wss://eventsub.wss.twitch.tv/ws';
const LOCAL_WEBSOCKET_PORT = 8080;
const STARTING_BANK_BALANCE = 1000;
const ACTIVE_CHATTER_WINDOW_MS = 5 * 60 * 1000;
const WATER_COMMAND_COOLDOWN_MS = 15_000;
const MAX_TILE_WETNESS = 15;
const ISLAND_UPGRADE_HARVESTS = { 2: 4, 3: 12 };
const FARM_STATE_PATH = fileURLToPath(new URL('./farm-state.json', import.meta.url));
const LEADERBOARD_PATH = fileURLToPath(new URL('./leaderboard.json', import.meta.url));
const STREAMER_PROFILE_URL = new URL('https://api.twitch.tv/helix/users');
const CROP_CATALOG = {
	potato: { name: 'Potato', price: 0, value: 10, growthMs: 30_000 },
	carrot: { name: 'Carrot', price: 30, value: 30, growthMs: 45_000 },
	onion: { name: 'Onion', price: 100, value: 100, growthMs: 60_000 }
};
const CROP_ALIASES = { potatoes: 'potato', carrots: 'carrot', onions: 'onion' };
let farmState = createDefaultFarmState();
let leaderboard = { users: {} };
let persistentDataReady = false;
let tokenScopes = new Set();
const recentChatters = new Map();
const waterCommandCooldowns = new Map();
let chatCommandQueue = Promise.resolve();

function createDefaultFarmState() {
	return {
		bank: STARTING_BANK_BALANCE,
		harvestedCrops: 0,
		streamerName: '',
		farmName: '',
		farmNameCustom: false,
		crops: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index + 1, null])),
		wetness: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index + 1, 0]))
	};
}

function getIslandLevel(harvestCount = farmState.harvestedCrops) {
	if (harvestCount >= ISLAND_UPGRADE_HARVESTS[3]) return 3;
	if (harvestCount >= ISLAND_UPGRADE_HARVESTS[2]) return 2;
	return 1;
}

function getTileCoordinates(tile) {
	const level = getIslandLevel();
	if (!Number.isInteger(tile) || tile < 1 || tile > level * level) return null;
	return { gridX: (tile - 1) % level, gridY: Math.floor((tile - 1) / level) };
}

function getGrowthMultiplier(tile) {
	const wetness = Math.max(0, Math.min(MAX_TILE_WETNESS, Number(farmState.wetness?.[tile]) || 0));
	return 1 + 4 * wetness / MAX_TILE_WETNESS;
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
	if (request.method !== 'GET' || !['/', '/index.html', '/utilities.js', '/assets/1x1.png', '/assets/2x2.png', '/assets/2x2signs.png', '/assets/Carrot1.png', '/assets/Carrot2.png', '/assets/Carrot3.png', '/assets/emptySack.png', '/assets/coin.png', '/assets/WetOverlay.png', '/assets/wateringCan.png', '/assets/KiwiSoda.ttf', '/assets/PixelifySans-VariableFont_wght.ttf', '/assets/yoster.ttf'].includes(request.url)) {
		response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		response.end('Not found');
		return;
	}

	try {
		const isPngAsset = ['/assets/1x1.png', '/assets/2x2.png', '/assets/2x2signs.png', '/assets/Carrot1.png', '/assets/Carrot2.png', '/assets/Carrot3.png', '/assets/emptySack.png', '/assets/coin.png', '/assets/WetOverlay.png', '/assets/wateringCan.png'].includes(request.url);
		const isPixelifyFont = request.url === '/assets/PixelifySans-VariableFont_wght.ttf';
		const isYosterFont = request.url === '/assets/yoster.ttf';
		const isFontAsset = request.url === '/assets/KiwiSoda.ttf';
		const isUtility = request.url === '/utilities.js';
		const fileName = request.url === '/assets/2x2.png' ? './assets/2x2.png' : request.url === '/assets/2x2signs.png' ? './assets/2x2signs.png' : request.url === '/assets/Carrot1.png' ? './assets/Carrot1.png' : request.url === '/assets/Carrot2.png' ? './assets/Carrot2.png' : request.url === '/assets/Carrot3.png' ? './assets/Carrot3.png' : request.url === '/assets/emptySack.png' ? './assets/emptySack.png' : request.url === '/assets/coin.png' ? './assets/coin.png' : request.url === '/assets/WetOverlay.png' ? './assets/WetOverlay.png' : request.url === '/assets/wateringCan.png' ? './assets/wateringCan.png' : isPngAsset ? './assets/1x1.png' : isPixelifyFont ? './assets/PixelifySans-VariableFont_wght.ttf' : isYosterFont ? './assets/yoster.ttf' : isFontAsset ? './assets/KiwiSoda.ttf' : isUtility ? './utilities.js' : './index.html';
		const content = await readFile(fileURLToPath(new URL(fileName, import.meta.url)));
		response.writeHead(200, {
			'Content-Type': isPngAsset ? 'image/png' : isPixelifyFont || isYosterFont || isFontAsset ? 'font/ttf' : isUtility ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'
		});
		response.end(content);
	} catch (error) {
		console.error('Failed to load overlay page:', error);
		response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
		response.end('Could not load overlay');
	}
});

const browserServer = new WebSocketServer({ server: httpServer });
browserServer.on('connection', (client) => {
	console.log('Overlay page connected to the local WebSocket server.');
	if (persistentDataReady) client.send(JSON.stringify(createFarmStateMessage()));
});
httpServer.on('error', (error) => {
	console.error('Local overlay server error:', error);
});
httpServer.listen(LOCAL_WEBSOCKET_PORT, () => {
	console.log(`Overlay page: http://localhost:${LOCAL_WEBSOCKET_PORT}/`);
	console.log(`Browser WebSocket server listening on ws://localhost:${LOCAL_WEBSOCKET_PORT}`);
});

function broadcastToBrowsers(message) {
	const serializedMessage = JSON.stringify(message);
	for (const client of browserServer.clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(serializedMessage);
		}
	}
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
	const savedLeaderboard = await readJsonFile(LEADERBOARD_PATH, { users: {} });
	const priorHarvestCount = Object.values(savedLeaderboard?.users || {})
		.reduce((total, user) => total + (Number.isSafeInteger(user.harvests) ? user.harvests : 0), 0);
	farmState = {
		bank: Number.isSafeInteger(savedFarm.bank) && savedFarm.bank >= 0 ? savedFarm.bank : STARTING_BANK_BALANCE,
		harvestedCrops: Number.isSafeInteger(savedFarm.harvestedCrops) && savedFarm.harvestedCrops >= 0
			? savedFarm.harvestedCrops
			: priorHarvestCount,
		crops: { ...createDefaultFarmState().crops, ...(savedFarm.crops || {}) },
		wetness: { ...createDefaultFarmState().wetness, ...(savedFarm.wetness || {}) }
	};
	farmState.streamerName = typeof savedFarm.streamerName === 'string' ? savedFarm.streamerName : '';
	farmState.farmName = typeof savedFarm.farmName === 'string' ? savedFarm.farmName : '';
	farmState.farmNameCustom = savedFarm.farmNameCustom === true;
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
	leaderboard = savedLeaderboard && savedLeaderboard.users && typeof savedLeaderboard.users === 'object'
		? savedLeaderboard
		: { users: {} };
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
		wetness: farmState.wetness,
		streamerName: farmState.streamerName,
		farmName: farmState.farmName || (farmState.streamerName ? `${farmState.streamerName}'s farm` : "Streamer's farm"),
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
	return recentChatters.size;
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
	return `Farm shop | Shared bank: $${farmState.bank}. Potato: FREE (value $10); Carrot: $30; Onion: $100. Island ${level}x${level}; plant with !buy potato 1 (tiles 1-${level ** 2}).`;
}

async function sendPrivateMessage(toUserId, message) {
	if (!tokenScopes.has('user:manage:whispers')) {
		console.error('Could not send private !shop reply: authorize the bot token with user:manage:whispers.');
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
		console.error(`Failed to send private Twitch message (HTTP ${response.status}): ${await response.text()}`);
		return false;
	}
	return true;
}

var websocketSessionID;

// Start executing the bot from here
(async () => {
	await loadPersistentData();
	// Verify that the authentication is valid
	await getAuth();
	await loadStreamerProfile();

	// Start WebSocket client and register handlers
	const websocketClient = startWebSocketClient();
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
	console.log('Validated token.');
	if (!tokenScopes.has('user:manage:whispers')) {
		console.warn('The token is missing user:manage:whispers; !shop cannot send private Twitch whispers until the token is reauthorized with that scope.');
	}
}

async function loadStreamerProfile() {
	const url = new URL(STREAMER_PROFILE_URL);
	url.searchParams.set('id', CHAT_CHANNEL_USER_ID);
	const response = await fetch(url, {
		headers: {
			'Authorization': 'Bearer ' + OAUTH_TOKEN,
			'Client-Id': CLIENT_ID
		}
	});
	if (!response.ok) {
		console.error(`Could not load the broadcaster name (HTTP ${response.status}).`);
		return;
	}
	const data = await response.json();
	const streamer = data.data?.[0];
	if (!streamer) return;
	farmState.streamerName = streamer.display_name || streamer.user_name || streamer.login || streamer.user_login || '';
	if (!farmState.farmNameCustom) farmState.farmName = `${farmState.streamerName}'s farm`;
	await writeJsonFile(FARM_STATE_PATH, farmState);
	broadcastFarmState();
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
						.then(() => handleFarmCommand(chatEvent, chatText, chatterLogin, activeChattersAtMessage))
						.catch((error) => console.error('Failed to process chat command:', error));

					// Then check to see if that message was "HeyGuys"
					if (chatText == "HeyGuys") {
						// If so, send back "VoHiYo" to the chatroom
						sendChatMessage("VoHiYo")
					}

					break;
			}
			break;
	}
}

async function handleFarmCommand(event, text, chatterLogin, activeChattersAtMessage) {
	const chatterName = event.chatter_user_name || event.chatter_user_login || chatterLogin;
	if (/^!rename(?:\s|$)/i.test(text)) {
		if (event.chatter_user_id !== CHAT_CHANNEL_USER_ID) {
			await sendChatMessage(`@${chatterLogin} only the streamer can rename the farm.`);
			return;
		}
		const requestedName = text.replace(/^!rename\s*/i, '').trim();
		if (!requestedName || [...requestedName].length > 32 || /[\u0000-\u001f\u007f]/.test(requestedName)) {
			await sendChatMessage('Use !rename followed by a name up to 32 characters.');
			return;
		}
		farmState.farmName = requestedName;
		farmState.farmNameCustom = true;
		await writeJsonFile(FARM_STATE_PATH, farmState);
		broadcastFarmState();
		await sendChatMessage(`The farm has been renamed to ${requestedName}.`);
		return;
	}

	if (/^!shop$/i.test(text)) {
		await sendPrivateMessage(event.chatter_user_id, formatShopMessage());
		return;
	}

	const waterMatch = text.match(/^!water\s+#?(\d+)$/i);
	if (waterMatch) {
		await waterTile(event, chatterLogin, Number(waterMatch[1]));
		return;
	}
	if (/^!water\b/i.test(text)) {
		await sendChatMessage(`@${chatterLogin} use !water 1 to water a tile (tiles 1-${getIslandLevel() ** 2}).`);
		return;
	}

	if (/^!leaderboard$/i.test(text)) {
		const top = Object.entries(leaderboard.users)
			.sort((a, b) => b[1].points - a[1].points)
			.slice(0, 5);
		const message = top.length
			? `Farm leaderboard: ${top.map(([login, user], index) => `${index + 1}. ${user.username || login} ${user.points} pts`).join(' | ')}`
			: 'Farm leaderboard: no harvest points yet.';
		await sendChatMessage(message.slice(0, 490));
		return;
	}

	const buyMatch = text.match(/^!buy\s+(\S+)\s+(\d+)$/i);
	if (buyMatch) {
		await buyCrop(event, chatterLogin, chatterName, normalizeCropName(buyMatch[1]), Number(buyMatch[2]));
		return;
	}
	if (/^!buy\b/i.test(text)) {
		await sendChatMessage(`@${chatterLogin} use !buy potato 1 (crop name, then tile 1-${getIslandLevel() ** 2}).`);
		return;
	}

	const harvestMatch = text.match(/^!harvest\s+#?(\d+)$/i);
	if (harvestMatch) {
		await voteToHarvest(event, chatterLogin, Number(harvestMatch[1]), activeChattersAtMessage);
		return;
	}
	if (/^!harvest\b/i.test(text)) {
		await sendChatMessage(`@${chatterLogin} use !harvest 1 to vote on a tile (tiles 1-${getIslandLevel() ** 2}).`);
	}
}

async function waterTile(event, chatterLogin, tile) {
	if (!getTileCoordinates(tile)) {
		await sendChatMessage(`@${chatterLogin} choose an unlocked tile from 1 to ${getIslandLevel() ** 2}.`);
		return;
	}
	const now = Date.now();
	const login = String(event.chatter_user_login || chatterLogin).toLowerCase();
	for (const [user, cooldownUntil] of waterCommandCooldowns) {
		if (cooldownUntil <= now) waterCommandCooldowns.delete(user);
	}
	const cooldownUntil = waterCommandCooldowns.get(login) || 0;
	if (cooldownUntil > now) {
		await sendChatMessage(`@${chatterLogin} you can water again in ${Math.ceil((cooldownUntil - now) / 1000)} seconds.`);
		return;
	}
	waterCommandCooldowns.set(login, now + WATER_COMMAND_COOLDOWN_MS);
	const wetness = farmState.wetness[tile] || 0;
	if (wetness >= MAX_TILE_WETNESS) {
		await sendChatMessage(`@${chatterLogin} tile ${tile} is fully watered.`);
		return;
	}
	const crop = advanceCropGrowth(tile, now);
	farmState.wetness[tile] = wetness + 1;
	if (crop) advanceCropGrowth(tile, now);
	await writeJsonFile(FARM_STATE_PATH, farmState);
	broadcastFarmState();
	broadcastToBrowsers({ type: 'farm.watered', tile, wetness: farmState.wetness[tile], username: event.chatter_user_name || chatterLogin });
	const multiplier = getGrowthMultiplier(tile);
	await sendChatMessage(`@${chatterLogin} watered tile ${tile} (${farmState.wetness[tile]}/${MAX_TILE_WETNESS}); crop growth is now ${multiplier.toFixed(1)}x faster.`);
}

async function buyCrop(event, chatterLogin, chatterName, kind, tile) {
	if (!kind) {
		await sendChatMessage(`@${chatterLogin} crops for sale: Potato (free), Carrot ($30), Onion ($100).`);
		return;
	}
	if (!getTileCoordinates(tile)) {
		await sendChatMessage(`@${chatterLogin} choose an unlocked tile from 1 to ${getIslandLevel() ** 2}.`);
		return;
	}
	if (farmState.crops[tile]) {
		await sendChatMessage(`@${chatterLogin} tile ${tile} is occupied; harvest it before planting again.`);
		return;
	}
	const crop = CROP_CATALOG[kind];
	if (farmState.bank < crop.price) {
		await sendChatMessage(`@${chatterLogin} the shared bank only has $${farmState.bank}; ${crop.name} costs $${crop.price}.`);
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
	broadcastFarmState();
	const growthSeconds = Math.ceil((farmState.crops[tile].readyAt - plantedAt) / 1000);
	await sendChatMessage(`@${chatterLogin} planted ${crop.name} on tile ${tile} for $${crop.price}. It will be ready in ${growthSeconds} seconds. Shared bank: $${farmState.bank}.`);
}

async function voteToHarvest(event, chatterLogin, tile, activeChattersAtMessage) {
	if (!getTileCoordinates(tile)) {
		await sendChatMessage(`@${chatterLogin} choose an unlocked tile from 1 to ${getIslandLevel() ** 2}.`);
		return;
	}
	const crop = advanceCropGrowth(tile);
	if (!crop) {
		await sendChatMessage(`@${chatterLogin} there is no crop on tile ${tile}.`);
		return;
	}
	if (Date.now() < crop.readyAt) {
		const secondsLeft = Math.ceil((crop.readyAt - Date.now()) / 1000);
		await sendChatMessage(`@${chatterLogin} ${cropName(crop.kind)} on tile ${tile} needs ${secondsLeft} more seconds to grow.`);
		return;
	}

	if (!Number.isInteger(crop.requiredVotes)) {
		crop.requiredVotes = Math.max(1, Math.ceil(activeChattersAtMessage / 5));
	}
	const voter = (event.chatter_user_login || chatterLogin).toLowerCase();
	if (crop.votes.includes(voter)) {
		broadcastToBrowsers({
			type: 'farm.harvest.progress', tile, votes: crop.votes.length, required: crop.requiredVotes,
			message: `${crop.votes.length}/${crop.requiredVotes} unique chatters`
		});
		return;
	}
	crop.votes.push(voter);
	if (crop.votes.length < crop.requiredVotes) {
		await writeJsonFile(FARM_STATE_PATH, farmState);
		broadcastToBrowsers({
			type: 'farm.harvest.progress', tile, votes: crop.votes.length, required: crop.requiredVotes,
			message: `${crop.votes.length}/${crop.requiredVotes} unique chatters`
		});
		await sendChatMessage(`Harvest on tile ${tile}: ${crop.votes.length}/${crop.requiredVotes} unique chatters voted.`);
		return;
	}

	const spec = CROP_CATALOG[crop.kind];
	const previousLevel = getIslandLevel();
	const planterLogin = (crop.ownerLogin || 'unknown').toLowerCase();
	const planter = leaderboard.users[planterLogin] || { username: crop.ownerName || planterLogin, points: 0, harvests: 0 };
	const points = Math.floor(spec.value * 0.2);
	const bankReturn = spec.value - points;
	planter.username = crop.ownerName || planter.username || planterLogin;
	planter.points += points;
	planter.harvests += 1;
	leaderboard.users[planterLogin] = planter;
	farmState.bank += bankReturn;
	farmState.harvestedCrops += 1;
	farmState.crops[tile] = null;
	farmState.wetness[tile] = 0;
	const newLevel = getIslandLevel();
	await writeJsonFile(FARM_STATE_PATH, farmState);
	await writeJsonFile(LEADERBOARD_PATH, leaderboard);
	broadcastToBrowsers({ type: 'farm.harvested', tile, crop: crop.kind, planter: planter.username, bankReturn, points });
	broadcastFarmState();
	const levelUpMessage = newLevel > previousLevel ? ` The island expanded to ${newLevel}x${newLevel}!` : '';
	await sendChatMessage(`${cropName(crop.kind)} harvested on tile ${tile}! $${bankReturn} added to the shared bank; ${planter.username} earns ${points} points. Shared bank: $${farmState.bank}.${levelUpMessage}`);
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
}
