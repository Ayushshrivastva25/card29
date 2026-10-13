## Latest UI update (v1.1.0)

- The Rang picker shows all four suits (Clubs ♣, Spades ♠, Hearts ♥, Diamonds ♦); suits not in the dealer's hand are shown disabled.
- Team badges identify partners: opposite seats play together; N/S seats are one team and E/W seats are the other.
- A compact left-to-right hand-score strip shows each completed hand's points and team, with no played-card history.
- Played card faces are not sent in the public live-trick or history payload.
- On phone screens, the large Card29 site header is hidden while inside a room, with connection status moved into the room header. Chat input stays visible at the bottom of the chat panel.

# Card29 — Play with your friends

A browser-based four-player 28/29 card game with private room codes, ready-up lobby, bidding, trump declaration, trick play, team match scoring, live chat, and peer-to-peer video calls.

## Stack

- Node.js 18+
- Express for serving the browser app and health endpoint
- Socket.IO for rooms, game state, and real-time chat
- WebRTC mesh connections for browser-to-browser audio/video
- Plain HTML, CSS, and JavaScript on the client

## Run locally

1. Install Node.js 18 or newer.
2. Open a terminal in this folder.
3. Install dependencies:

   ```bash
   npm install
   ```

4. Start the server:

   ```bash
   npm start
   ```

5. Open [http://localhost:3000](http://localhost:3000) in your browser.
6. Create a room, then open the site in three other browsers/devices and join with the six-character code.
7. All four players should click **I'm ready**. The host can then start the game.

You can test multiple seats on one computer with separate browser profiles or private windows. Use separate devices to test real video/audio behaviour.

## Deploy to Render

1. Create a GitHub repository and upload the contents of this folder (the `server.js`, `package.json`, `render.yaml`, and `public/` folder should be in the repository root).
2. In Render, choose **New → Blueprint** and connect the repository, or create a **Web Service** directly.
3. If creating a Web Service manually, use:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Health check path:** `/health`
4. Deploy, then open the HTTPS URL Render gives you.
5. Share the HTTPS URL and room code with the other three players.

Render free services may sleep after inactivity and take a short time to wake. Room state is stored in server memory, so rooms and ongoing games are lost if the server restarts or sleeps. This build is intended for casual tables, not persistent ranked play.

## How to play in this build

- Four players, with seats 1 & 3 playing together as N/S, against seats 2 & 4 together as E/W.
- The 32-card deck uses 7, 8, Q, K, 10, A, 9, J in each suit.
- Card strength is J > 9 > A > 10 > K > Q > 8 > 7.
- Card values are J = 3, 9 = 2, A = 1, 10 = 1. The last trick gives an extra point, for 29 points per hand.
- Bidding starts at 16 and goes up to 29. After bidding closes, the dealer chooses **Rang** (the trump suit) from suits in their hand. This is the requested house-rule version; in many traditional 29 variants, the winning bidder chooses trump instead.
- The dealer's team can see the chosen Rang. Opponents see it as hidden until it is revealed.
- During play, a player holding a card of the chosen suit can select **Reveal Rang (trump)**. The suit then becomes visible to all players.
- Players must follow the led suit when they can. Until Rang is revealed, off-suit cards do not beat the led suit.
- The round scoreboard shows North/South and East/West points as tricks complete. A compact hand-score strip displays only each hand's points from hand 1 on the left to hand 8 on the right, with the scoring team abbreviated under each value. Played cards are not displayed in the table/history.
- The bidding team makes its contract by scoring at least its bid. The successful team earns one match point; if the bid fails, the other team earns one. First team to 6 match points wins.

This implements a practical browser version of 28/29. Regional rule variations (such as dealing five cards before bidding, double/redouble, or different scoring) are not included.

## Chat and video

- Chat is scoped to the current room and retained in memory for the room lifetime.
- Video uses a peer-to-peer WebRTC mesh and public Google STUN servers. There is no TURN relay configured. Camera/microphone access generally requires HTTPS or localhost. Some restrictive networks may block direct peer-to-peer connections; for production use, consider adding a TURN service.
- Each player must select **Video room → Join video call** and permit camera/microphone access.

## Project layout

```text
card29/
├── server.js
├── package.json
├── render.yaml
├── README.md
└── public/
    ├── index.html
    ├── style.css
    └── client.js
```

## Health check

The deployment exposes `GET /health`, returning a small JSON status response.
