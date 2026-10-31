const USERNAMES = [
	'GlitchRunner', 'PixelFarmer', 'RetroGamer99', 'SproutMaster',
	'TwitchCat', 'CozyStreamer', 'CropWatcher', 'ZeroLag',
	'NeonVibes', 'HypeTrainDriver', 'SpudLover', 'CoffeeCoder'
];
const USER_COLORS = ['#ff7bac', '#66d9ef', '#8fe388', '#ffc36e', '#d19bff', '#6fe4b0', '#ff9d8e', '#91a8ff'];
const CROP_INFO = {
	potato: { cost: 0, value: 10, growthMs: 30_000, label: 'potato' },
	carrot: { cost: 30, value: 30, growthMs: 45_000, label: 'carrot' },
	onion: { cost: 100, value: 100, growthMs: 60_000, label: 'onion' }
};
const CHATTER_LINES = [
	'cozy little farm stream \u{1F331}', 'this island is coming together', 'the water animation is so satisfying',
	'chat powered agriculture', 'we are so back', 'tiny farm, huge dreams', 'need a spud emote',
	'checking on the crops \u{1F440}', 'the seafoam animation is lovely', 'farm arc continues'
];
const container = document.getElementById('chat-container');
const connection = document.getElementById('connection');
const connectionLabel = document.getElementById('connection-label');

let socket = null;
let farm = null;
let activeChatters = 1;
let mockControl = { enabled: true, activityLevel: 2, activityName: 'medium', intervalMs: 4000 };
let simulatorStarted = false;
let harvestAnimationActive = false;
let pendingHarvestHype = false;
let actionTimer = null;
const lastWaterCommandAt = new Map();

function randomChoice(items) {
	return items[Math.floor(Math.random() * items.length)];
}

function appendLine(username, text, kind = 'chat') {
	const line = document.createElement('div');
	line.className = `chat-line${kind === 'bot' ? ' bot-line' : ''}${kind === 'reaction' ? ' reaction' : ''}${kind === 'notice' ? ' notice' : ''}`;
	if (kind === 'bot') {
		const badge = document.createElement('span');
		badge.className = 'badge';
		badge.textContent = 'BOT';
		line.appendChild(badge);
	}
	if (username) {
		const user = document.createElement('span');
		user.className = 'user';
		user.style.color = USER_COLORS[username.length % USER_COLORS.length];
		user.textContent = `${username}:`;
		line.appendChild(user);
	}
	const message = document.createElement('span');
	message.textContent = text;
	if (kind === 'command') message.className = 'command';
	line.appendChild(message);
	container.appendChild(line);
	while (container.children.length > 28) container.firstElementChild.remove();
	container.scrollTop = container.scrollHeight;
}

function setConnection(state, label) {
	connection.className = state;
	connectionLabel.textContent = label;
}

function copyFarmState(state) {
	const crops = {};
	for (const [tile, crop] of Object.entries(state.crops || {})) {
		crops[tile] = crop ? { ...crop, votes: [...(crop.votes || [])], mockVotes: [...(crop.votes || [])] } : null;
	}
	return {
		level: Math.max(1, Math.min(2, Number(state.level) || 1)),
		bank: Number(state.bank) || 0,
		wetness: { ...(state.wetness || {}) },
		crops
	};
}

function getRequiredVotes() {
	if (activeChatters < 10) return 1;
	if (activeChatters <= 50) return 5;
	return 5 + Math.ceil((activeChatters - 50) / 10);
}

function getTileNumbers() {
	return Array.from({ length: farm.level * farm.level }, (_, index) => index + 1);
}

function sayCommand(username, command) {
	appendLine(username, command, 'command');
	if (command.startsWith('!water ')) lastWaterCommandAt.set(username.toLowerCase(), Date.now());
	if (socket?.readyState === WebSocket.OPEN && mockControl.enabled) {
		socket.send(JSON.stringify({ type: 'mock.command', username, text: command }));
	}
}

function replyToMockChat(text) {
	appendLine('FarmBot', text, 'bot');
}

function reactToHarvest(cropKind, rewards = []) {
	const kind = CROP_INFO[cropKind]?.label || 'crop';
	const shinyRewards = rewards.filter((reward) => reward?.shiny);
	const heaviest = rewards.reduce((best, reward) => Math.max(best, Number(reward?.weightKg) || 0), 0);
	const hasSpecialModifier = rewards.some((reward) => typeof reward?.modifier === 'string' && reward.modifier.length > 0);
	if (shinyRewards.length) {
		appendLine(randomChoice(USERNAMES), `SHINY ${kind.toUpperCase()}!! \u{2728}`, 'reaction');
		appendLine(randomChoice(USERNAMES), 'that glow is unreal', 'reaction');
	}
	if (heaviest >= 1) {
		appendLine(randomChoice(USERNAMES), `${heaviest.toFixed(2)} kg ${kind}?! absolute unit \u{1F4AA}`, 'reaction');
		appendLine(randomChoice(USERNAMES), 'big crop energy', 'reaction');
	}
	if (!shinyRewards.length && heaviest < 1) {
		appendLine(randomChoice(USERNAMES), randomChoice([
			'huge harvest!', 'nice pull \u{1F33E}', 'those crops paid off', 'farmers in chat did it again'
		]), 'reaction');
	}
	return heaviest >= 1 || hasSpecialModifier;
}

function spamHarvestHype() {
	const hypeLines = [
		'GOATED pull', 'MASSIVE W', 'that crop is BUILT DIFFERENT', 'absolute unit',
		'farm diff', 'huge W', 'chat is eating good', 'what a legendary pull',
		'WE TAKE THOSE', 'crop of the year'
	];
	hypeLines.forEach((line, index) => {
		const delay = 450 + index * 300 + Math.floor(Math.random() * 120);
		window.setTimeout(() => appendLine(randomChoice(USERNAMES), line, 'reaction'), delay);
	});
}

function runMockAction() {
	if (!socket || socket.readyState !== WebSocket.OPEN || !mockControl.enabled || harvestAnimationActive) return;
	if (!farm) {
		appendLine(randomChoice(USERNAMES), randomChoice(CHATTER_LINES));
		return;
	}
	const username = randomChoice(USERNAMES);
	if (Math.random() < 0.08) {
		appendLine(username, randomChoice(CHATTER_LINES));
		return;
	}

	const now = Date.now();
	const tiles = getTileNumbers();
	const mature = tiles.filter((tile) => farm.crops[tile] && !farm.crops[tile].mockHarvestPending && Number(farm.crops[tile].readyAt) <= now - 500);
	if (mature.length) {
		const tile = randomChoice(mature);
		const crop = farm.crops[tile];
		crop.mockVotes ||= [];
		crop.mockRequiredVotes ||= getRequiredVotes();
		const voters = USERNAMES.filter((name) => !crop.mockVotes.includes(name.toLowerCase()));
		if (!voters.length) crop.mockVotes = [];
		const voter = randomChoice(voters.length ? voters : USERNAMES);
		crop.mockVotes.push(voter.toLowerCase());
		sayCommand(voter, `!harvest ${tile}`);
		if (crop.mockVotes.length >= crop.mockRequiredVotes) {
			crop.mockHarvestPending = true;
			appendLine(randomChoice(USERNAMES), `the harvest is in! tile ${tile} \u{1F33E}`, 'reaction');
		} else {
			appendLine(randomChoice(USERNAMES), `${crop.mockVotes.length}/${crop.mockRequiredVotes} harvest votes on tile ${tile}`);
		}
		return;
	}

	const empty = tiles.filter((tile) => !farm.crops[tile]);
	const growing = tiles.filter((tile) => {
		const crop = farm.crops[tile];
		return crop && Number(crop.readyAt) > now && (Number(farm.wetness[tile]) || 0) < 15;
	});
	const affordable = Object.entries(CROP_INFO).filter(([, crop]) => crop.cost <= farm.bank);
	if (empty.length && affordable.length && Math.random() < 0.12) {
		const tile = randomChoice(empty);
		const kind = randomChoice(affordable.map(([name]) => name));
		const info = CROP_INFO[kind];
		const wetness = Number(farm.wetness[tile]) || 0;
		const multiplier = 1 + 4 * wetness / 15;
		farm.bank -= info.cost;
		farm.crops[tile] = { kind, plantedAt: now, readyAt: now + info.growthMs / multiplier, mockVotes: [] };
		sayCommand(username, `!plant ${kind} ${tile}`);
		return;
	}
	if (growing.length) {
		const tile = randomChoice(growing);
		const crop = farm.crops[tile];
		const waterUsers = USERNAMES.filter((name) => now - (lastWaterCommandAt.get(name.toLowerCase()) || 0) >= 15_000);
		if (!waterUsers.length) {
			appendLine(username, randomChoice(CHATTER_LINES));
			return;
		}
		const waterUser = randomChoice(waterUsers);
		const oldWetness = Number(farm.wetness[tile]) || 0;
		const newWetness = Math.min(15, oldWetness + 1);
		const oldMultiplier = 1 + 4 * oldWetness / 15;
		const newMultiplier = 1 + 4 * newWetness / 15;
		const remainingGrowthMs = Math.max(0, Number(crop.readyAt) - now) * oldMultiplier;
		crop.readyAt = now + remainingGrowthMs / newMultiplier;
		farm.wetness[tile] = newWetness;
		sayCommand(waterUser, `!water ${tile}`);
		return;
	}
	if (empty.length && affordable.length) {
		const tile = randomChoice(empty);
		const kind = randomChoice(affordable.map(([name]) => name));
		farm.bank -= CROP_INFO[kind].cost;
		farm.crops[tile] = { kind, plantedAt: now, readyAt: now + CROP_INFO[kind].growthMs, mockVotes: [] };
		sayCommand(username, `!plant ${kind} ${tile}`);
		return;
	}
	appendLine(username, randomChoice(CHATTER_LINES));
}

function scheduleNextAction() {
	window.clearTimeout(actionTimer);
	const interval = mockControl.enabled ? mockControl.intervalMs : 1000;
	const delay = mockControl.enabled ? Math.round(interval * (0.75 + Math.random() * 0.5)) : interval;
	actionTimer = window.setTimeout(() => {
		runMockAction();
		scheduleNextAction();
	}, delay);
}

function handleFarmMessage(message) {
	if (message.type === 'farm.state') {
		farm = copyFarmState(message);
		return;
	}
	if (message.type === 'mock.control') {
		mockControl = message;
		if (connection.classList.contains('connected')) setConnection('connected', 'Connected');
		if (simulatorStarted) scheduleNextAction();
		return;
	}
	if (message.type === 'debug.settings') {
		activeChatters = Number(message.activeChatters) || 1;
		return;
	}
	if (message.type === 'chat.message') {
		if (message.direction === 'incoming' && message.event) {
			appendLine(message.event.chatter_user_name || message.event.chatter_user_login || 'viewer', message.event.message?.text || '');
		} else if (message.direction === 'outgoing' && message.message) {
			replyToMockChat(message.message);
			if (message.simulated && /choose an unlocked tile|occupied|costs \$|water again|fully watered|needs \d+ more seconds|no crop on tile/i.test(message.message)) {
				socket?.send(JSON.stringify({ type: 'farm.state.request' }));
			}
		}
		return;
	}
	if (message.type === 'farm.planted') {
		appendLine(randomChoice(USERNAMES), `new ${message.crop} on tile ${message.tile} \u{1F331}`);
		return;
	}
	if (message.type === 'farm.watered') {
		appendLine(randomChoice(USERNAMES), `tile ${message.tile} is getting a drink \u{1F4A7}`);
		return;
	}
	if (message.type === 'farm.harvest.progress') {
		appendLine(randomChoice(USERNAMES), `${message.votes}/${message.required} votes for tile ${message.tile}`);
		const crop = farm?.crops?.[message.tile];
		if (crop && message.username) {
			crop.mockVotes ||= [];
			const voter = String(message.username).toLowerCase();
			if (!crop.mockVotes.includes(voter)) crop.mockVotes.push(voter);
		}
		return;
	}
	if (message.type === 'farm.harvested') {
		harvestAnimationActive = Number.isSafeInteger(message.harvestId);
		if (farm) {
			farm.crops[message.tile] = null;
			farm.wetness[message.tile] = 0;
			farm.bank += Number(message.bankReturn) || 0;
		}
		pendingHarvestHype = reactToHarvest(message.crop, Array.isArray(message.rewards) ? message.rewards : []);
		if (pendingHarvestHype && !harvestAnimationActive) {
			window.setTimeout(() => {
				if (pendingHarvestHype) {
					pendingHarvestHype = false;
					spamHarvestHype();
				}
			}, 600);
		}
		return;
	}
	if (message.type === 'farm.harvest.animation.complete') {
		harvestAnimationActive = false;
		if (pendingHarvestHype) {
			pendingHarvestHype = false;
			spamHarvestHype();
		}
		return;
	}
	if (message.type === 'farm.cheer.grow') {
		appendLine(randomChoice(USERNAMES), 'everything grew instantly?! \u{2728}', 'reaction');
	}
}

function connect() {
	setConnection('', 'Connecting');
	const currentSocket = new WebSocket('ws://localhost:8080');
	socket = currentSocket;
	currentSocket.addEventListener('open', () => {
		if (socket !== currentSocket) return;
		setConnection('connected', 'Connected');
		currentSocket.send(JSON.stringify({ type: 'mock.register' }));
		if (!simulatorStarted) {
			simulatorStarted = true;
			appendLine('FarmBot', 'Mock chat is watching the live farm.', 'notice');
			scheduleNextAction();
		}
	});
	currentSocket.addEventListener('message', (event) => {
		try { handleFarmMessage(JSON.parse(event.data)); }
		catch (error) { console.warn('Ignored invalid farm chat message:', error); }
	});
	currentSocket.addEventListener('close', () => {
		if (socket !== currentSocket) return;
		setConnection('disconnected', 'Reconnecting');
		window.setTimeout(connect, 2000);
	});
	currentSocket.addEventListener('error', () => currentSocket.close());
}

connect();
