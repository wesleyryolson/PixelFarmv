import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const BOT_USER_ID = process.env.BOT_USER_ID; // This is the User ID of the chat bot
const OAUTH_TOKEN = process.env.OAUTH_TOKEN; // Needs scopes user:bot, user:read:chat, user:write:chat
const CLIENT_ID = process.env.CLIENT_ID;


const CHAT_CHANNEL_USER_ID = process.env.CHAT_CHANNEL_USER_ID;

const EVENTSUB_WEBSOCKET_URL = 'wss://eventsub.wss.twitch.tv/ws';
const LOCAL_WEBSOCKET_PORT = 8080;

const httpServer = createServer(async (request, response) => {
	if (request.method !== 'GET' || !['/', '/index.html', '/utilities.js'].includes(request.url)) {
		response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		response.end('Not found');
		return;
	}

	try {
		const isUtility = request.url === '/utilities.js';
		const fileName = isUtility ? './utilities.js' : './index.html';
		const content = await readFile(fileURLToPath(new URL(fileName, import.meta.url)));
		response.writeHead(200, {
			'Content-Type': isUtility ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'
		});
		response.end(content);
	} catch (error) {
		console.error('Failed to load overlay page:', error);
		response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
		response.end('Could not load overlay');
	}
});

const browserServer = new WebSocketServer({ server: httpServer });
browserServer.on('connection', () => {
	console.log('Overlay page connected to the local WebSocket server.');
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

var websocketSessionID;

// Start executing the bot from here
(async () => {
	// Verify that the authentication is valid
	await getAuth();

	// Start WebSocket client and register handlers
	const websocketClient = startWebSocketClient();
})();

// WebSocket will persist the application loop until you exit the program forcefully

async function getAuth() {
	// https://dev.twitch.tv/docs/authentication/validate-tokens/#how-to-validate-a-token
	let response = await fetch('https://id.twitch.tv/oauth2/validate', {
		method: 'GET',
		headers: {
			'Authorization': 'OAuth ' + OAUTH_TOKEN
		}
	});



	if (response.status != 200) {
		let data = await response.json();
		console.error("Token is not valid. /oauth2/validate returned status code " + response.status);
		console.error(data);
		process.exit(1);
	}

	console.log("Validated token.");
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
					broadcastToBrowsers({
						type: 'chat.message',
						direction: 'incoming',
						event: chatEvent
					});

					// First, print the message to the program's console.
					console.log(`MSG #${chatEvent.broadcaster_user_login} <${chatEvent.chatter_user_login}> ${chatText}`);

					// Handle the overlay command directly, like the HeyGuys chat trigger below.
					if (/^!harvest(?:\s|$)/i.test(chatText)) {
						console.log('Harvest command received; notifying overlay.');
						broadcastToBrowsers({
							type: 'command.harvest',
							user: chatEvent.chatter_user_login,
							text: chatText
						});
					}

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
