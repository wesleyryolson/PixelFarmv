# Pixel Farm

Pixel Farm is a little Twitch chat farm. Viewers plant crops, water them to speed up growth, and vote together to harvest. The farm runs as a browser overlay, so it can sit in an OBS Browser Source while the bot listens to chat.

This is a hackathon project, so the quickest way to try it is to run the bot on your own computer and open the local overlay.

## What you need

- Node.js 18 or newer (the project uses Node's built-in `fetch`)
- A Twitch account for the channel
- A Twitch account for the bot (you can use the same account for a quick demo)
- A Twitch Developer application and a user access token for the bot account

## Run it locally

From the repository root:

```bash
cd FarmBot
npm install
```

Create your local environment file from the example, then fill in the Twitch values described below:

```bash
cp .env.example .env.local
```

On Windows PowerShell, use `Copy-Item .env.example .env.local` instead.

Start the bot and overlay server:

```bash
node bot.js
```

Open [http://localhost:8080](http://localhost:8080) in a browser. To put it on stream, add that same URL as an OBS **Browser Source**. Keep the terminal running while the overlay is in use; closing it stops both the bot and the local server. The bot logs chat activity and connection status in that terminal.

The farm state and leaderboard are saved in `FarmBot/farm-state.json` and `FarmBot/leaderboard.json`, so progress survives a restart. Back these up before resetting or replacing them.

## Twitch bot setup

The bot uses Twitch EventSub over a WebSocket. It reads chat as the bot account, sends replies as that account, and uses the broadcaster's ID to select the channel. The values below must refer to the same accounts you authorize.

1. Sign in to the [Twitch Developer Console](https://dev.twitch.tv/console) and create an application. Twitch requires 2FA on the developer account. For the redirect URL, `http://localhost:3000` is fine when using the Twitch CLI token flow below; choose a desktop application category.
2. Open the application in the console and copy its **Client ID** into `CLIENT_ID`.
3. Install and configure the [Twitch CLI](https://dev.twitch.tv/docs/cli/), using this app's Client ID. Generate a **user access token while signed in as the bot account**, with these scopes:

   ```bash
   twitch token --user-token --scopes "user:read:chat user:write:chat user:manage:whispers"
   ```

   Copy the access token (the `access_token` value, without an `oauth:` prefix) into `OAUTH_TOKEN`. The first two scopes let the bot read and send chat messages; `user:manage:whispers` lets `!shop` send its response privately. If you leave off the whisper scope, the rest of the farm can work, but `!shop` cannot send its private reply. Twitch's [chat authentication guide](https://dev.twitch.tv/docs/chat/authenticating/) documents the token flow and scopes.
4. Find the numeric Twitch User ID for the account that will run the bot and put it in `BOT_USER_ID`. Find the channel owner's numeric User ID and put it in `CHAT_CHANNEL_USER_ID`. These are not usernames or channel URLs. You can look up either account with Twitch's [Get Users API](https://dev.twitch.tv/docs/api/reference/#get-users) or another trusted Twitch ID lookup tool.
5. Save the file as `FarmBot/.env.local`, start the bot, and check the terminal for `Validated token.` and `Subscribed to channel.chat.message`. If Twitch rejects the subscription, check that the token belongs to `BOT_USER_ID`, has `user:read:chat`, and that the bot account can join the channel's chat.

The app does not need a Client Secret at runtime. Keep access tokens private, and do not commit `.env.local`. Twitch access tokens expire; if the bot later reports an invalid token, generate a fresh token and update `OAUTH_TOKEN`.

## Environment variables

The bot loads `.env.local` from the directory where you run `node bot.js` (normally `FarmBot/`). The committed [`.env.example`](FarmBot/.env.example) lists every variable the app reads:

| Variable | What goes here | Where to find it |
| --- | --- | --- |
| `CLIENT_ID` | The Twitch application's Client ID | Developer Console → Applications → your app → Manage |
| `OAUTH_TOKEN` | A user access token for the bot account | Generate with Twitch CLI as described above; include `user:read:chat` and `user:write:chat`. Add `user:manage:whispers` for `!shop`. |
| `BOT_USER_ID` | Numeric User ID of the account represented by the token | Twitch Get Users API or a trusted Twitch ID lookup tool |
| `CHAT_CHANNEL_USER_ID` | Numeric User ID of the channel owner | Twitch Get Users API or a trusted Twitch ID lookup tool |

Use the bot account's ID for `BOT_USER_ID`, even if the bot and channel owner are the same person. The OAuth token is a secret; the Client ID and User IDs are identifiers, not passwords.

## Chat commands

### Public commands

Anyone in the channel can use these:

| Command | What it does |
| --- | --- |
| `!buy <crop> <tile>` | Plant on an empty, unlocked tile. Crops are `potato` (free), `carrot` ($30), and `onion` ($100). Plural names also work. |
| `!water <tile>` | Water a tile to speed up its crop. Each chatter can water once every 15 seconds, and each tile tops out at 15 water. |
| `!harvest <tile>` | Vote to harvest a fully grown crop. The number of unique votes needed depends on how many chatters are active. |
| `!shop` | Send the current crop prices, bank balance, and island size to you in a Twitch whisper. Requires the bot token's `user:manage:whispers` scope. |
| `!leaderboard` | Show the top five farmers by harvest points. |

The island starts as a 1×1 plot and expands to 2×2 after 4 harvests, then 3×3 after 12. Use the tile numbers shown on the overlay; `!water` and `!harvest` also accept an optional `#` before the number.

### Admin command

Only the channel owner account can change the farm name:

| Command | What it does |
| --- | --- |
| `!rename <name>` | Set the name shown for the farm. Names can be up to 32 characters. |

The owner check uses `CHAT_CHANNEL_USER_ID`, so the command must come from that Twitch account. If no custom name is set, the farm uses `<streamer>'s farm` automatically.

## A couple of notes

- The small **DEBUG** button on the overlay cycles the island preview size. It is only a visual preview and does not change the farm's saved progression.
- The overlay loads Phaser 3.90 from jsDelivr, so the browser needs internet access for that library.
- The server uses port `8080` for both the overlay page and its browser WebSocket connection. If that port is busy, stop the other process using it before starting Pixel Farm.

## Built with

Node.js, Twitch EventSub, WebSockets, Phaser 3, and a handful of pixel-art assets.
