'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true }, pingInterval: 25000, pingTimeout: 60000 });
const PORT = Number(process.env.PORT) || 3000;
const TARGET_MATCH_SCORE = 6;
const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const SUIT_SYMBOLS = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
const RANKS = ['7', '8', 'Q', 'K', '10', 'A', '9', 'J'];
const RANK_POWER = { '7': 1, '8': 2, 'Q': 3, 'K': 4, '10': 5, 'A': 6, '9': 7, 'J': 8 };
const CARD_POINTS = { J: 3, '9': 2, A: 1, '10': 1, K: 0, Q: 0, '8': 0, '7': 0 };
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'card29-online', rooms: rooms.size }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function safeName(input) {
  const name = String(input || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 22);
  return name || 'Player';
}
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function makeDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ id: `${suit}_${rank}`, suit, rank, points: CARD_POINTS[rank] });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function sortHand(hand) {
  const suitOrder = { spades: 0, hearts: 1, diamonds: 2, clubs: 3 };
  return hand.sort((a, b) => suitOrder[a.suit] - suitOrder[b.suit] || RANK_POWER[a.rank] - RANK_POWER[b.rank]);
}
function seatOf(room, socketId) { return room.players.findIndex((p) => p && p.id === socketId); }
function teamOf(seat) { return seat % 2; }
function partnerTeamLabel(team) { return team === 0 ? 'North / South' : 'East / West'; }
function member(_ignored, socket) {
  const code = socket.data.roomCode;
  const room = rooms.get(code);
  if (!room) return { error: 'This room no longer exists.' };
  const seat = seatOf(room, socket.id);
  if (seat < 0) return { error: 'You are not a player in this room.' };
  return { room, seat, player: room.players[seat] };
}
function sysChat(room, text) {
  room.chat.push({ id: `${Date.now()}-${Math.random()}`, system: true, text, at: Date.now() });
  if (room.chat.length > 100) room.chat.splice(0, room.chat.length - 100);
}
function emitNotice(socket, text, type = 'info') { socket.emit('notice', { text, type }); }
function broadcastState(room) {
  for (const p of room.players) {
    if (p) io.to(p.id).emit('state', stateFor(room, p.id));
  }
}
function stateFor(room, viewerId) {
  const viewerSeat = seatOf(room, viewerId);
  const game = room.game;
  const sameTeamAsBidder = game && game.bidder !== null && viewerSeat >= 0 && teamOf(viewerSeat) === teamOf(game.bidder);
  const sameTeamAsDealer = game && viewerSeat >= 0 && teamOf(viewerSeat) === teamOf(game.dealer);
  let publicGame = null;
  if (game) {
    publicGame = {
      phase: game.phase,
      dealer: game.dealer,
      currentTurn: game.currentTurn,
      highBid: game.highBid,
      bidder: game.bidder,
      passes: game.passes,
      passedSeats: game.passedSeats,
      bids: game.bids,
      trump: game.trumpRevealed || sameTeamAsDealer ? game.trump : null,
      trumpHidden: Boolean(game.trump && !game.trumpRevealed && !sameTeamAsDealer),
      trumpRevealed: game.trumpRevealed,
      trickNumber: game.tricksCompleted + (game.phase === 'playing' ? 1 : 0),
      tricksCompleted: game.tricksCompleted,
      // Only send the count/seat activity for the live trick; the UI intentionally does not display played cards.
      currentTrick: game.currentTrick.map((item) => ({ seat: item.seat })),
      lastTrick: game.lastTrick ? {
        winnerSeat: game.lastTrick.winnerSeat,
        points: game.lastTrick.points,
        trickNumber: game.lastTrick.trickNumber,
      } : null,
      trickWins: game.trickWins,
      teamPoints: game.teamPoints,
      // Keep per-hand points and team results public without sending historical card faces.
      trickHistory: game.trickHistory.map(({ trickNumber, winnerSeat, winnerName, team, points, cardPoints, lastTrickBonus, teamPoints }) => ({
        trickNumber, winnerSeat, winnerName, team, points, cardPoints, lastTrickBonus, teamPoints,
      })),
      roundSummary: game.roundSummary,
      handCounts: game.hands.map((hand) => hand.length),
      hand: viewerSeat >= 0 ? game.hands[viewerSeat] : [],
      matchScores: room.matchScores,
      roundsPlayed: room.roundsPlayed,
      targetMatchScore: TARGET_MATCH_SCORE,
      youCanReveal: viewerSeat >= 0 && game.phase === 'playing' && !game.trumpRevealed && Boolean(game.trump) && game.hands[viewerSeat].some((c) => c.suit === game.trump),
      winningTeam: game.winningTeam,
      leadSuit: game.currentTrick.length ? game.currentTrick[0].card.suit : null,
    };
  }
  return {
    code: room.code,
    hostId: room.hostId,
    you: viewerId,
    yourSeat: viewerSeat,
    players: room.players.map((p, seat) => p ? { id: p.id, name: p.name, ready: p.ready, seat, host: p.id === room.hostId, connected: true } : { id: null, name: 'Waiting for player', ready: false, seat, host: false, connected: false }),
    chat: room.chat,
    game: publicGame,
  };
}
function announceVideoPeers(room, socket) {
  const peers = room.players.filter((p) => p && p.id !== socket.id && io.sockets.sockets.get(p.id)?.data.videoReady).map((p) => ({ id: p.id, name: p.name }));
  socket.emit('video:peers', peers);
}
function beginRound(room) {
  const deck = makeDeck();
  const hands = [[], [], [], []];
  // Deal round-robin for predictable, fair hand sizes.
  for (let i = 0; i < deck.length; i++) hands[i % 4].push(deck[i]);
  hands.forEach(sortHand);
  room.game = {
    phase: 'bidding', dealer: room.dealer, hands,
    currentTurn: (room.dealer + 1) % 4,
    highBid: 15, bidder: null, passes: 0, passedSeats: [], bids: {},
    trump: null, trumpRevealed: false,
    currentTrick: [], lastTrick: null, tricksCompleted: 0,
    trickWins: [0, 0, 0, 0], teamPoints: [0, 0],
    roundSummary: null, winningTeam: null, trickHistory: [],
  };
  sysChat(room, `Round ${room.roundsPlayed + 1} has started. ${room.players[room.dealer].name} is dealing.`);
  broadcastState(room);
}
function advanceAfterBid(room, seat, action) {
  const game = room.game;
  if (action.type === 'bid') {
    const bid = Number(action.value);
    if (!Number.isInteger(bid) || bid < 16 || bid > 29 || bid <= game.highBid) return 'Your bid must be higher than the current bid and between 16 and 29.';
    game.highBid = bid;
    game.bidder = seat;
    game.passes = game.passedSeats.length;
    game.bids[seat] = bid;
    sysChat(room, `${room.players[seat].name} bids ${bid}.`);
  } else {
    if (!game.passedSeats.includes(seat)) game.passedSeats.push(seat);
    game.passes = game.passedSeats.length;
    game.bids[seat] = 'Pass';
    sysChat(room, `${room.players[seat].name} passes.`);
  }

  if (game.bidder === null && game.passedSeats.length >= 4) {
    sysChat(room, 'Everyone passed. The hand will be redealt with a new dealer.');
    game.phase = 'redeal';
    broadcastState(room);
    clearTimeout(room.timer);
    const redealGame = game;
    room.timer = setTimeout(() => {
      if (!rooms.has(room.code) || room.game !== redealGame || !room.players.every(Boolean)) return;
      room.dealer = (room.dealer + 1) % 4;
      beginRound(room);
    }, 1500);
    return null;
  }

  if (game.bidder !== null && [0, 1, 2, 3].every((otherSeat) => otherSeat === game.bidder || game.passedSeats.includes(otherSeat))) {
    game.phase = 'trump';
    // This version uses the requested house rule: the dealer chooses Rang (trump suit) each round.
    game.currentTurn = game.dealer;
    sysChat(room, `${room.players[game.bidder].name} won the bidding at ${game.highBid}. ${room.players[game.dealer].name} (dealer) will choose Rang for this round.`);
    broadcastState(room);
    return null;
  }

  // Move to the next player who has not passed and is not currently holding the high bid.
  for (let step = 1; step <= 4; step++) {
    const candidate = (seat + step) % 4;
    if (!game.passedSeats.includes(candidate) && candidate !== game.bidder) {
      game.currentTurn = candidate;
      broadcastState(room);
      return null;
    }
  }

  // Defensive fallback; normal auction completion is handled above.
  if (game.bidder !== null) {
    game.phase = 'trump';
    game.currentTurn = game.bidder;
    broadcastState(room);
  }
  return null;
}
function cardBeats(a, b, leadSuit, trump, trumpRevealed) {
  const aIsTrump = trumpRevealed && a.suit === trump;
  const bIsTrump = trumpRevealed && b.suit === trump;
  if (aIsTrump && !bIsTrump) return true;
  if (!aIsTrump && bIsTrump) return false;
  const aCounts = aIsTrump || a.suit === leadSuit;
  const bCounts = bIsTrump || b.suit === leadSuit;
  if (aCounts && !bCounts) return true;
  if (!aCounts && bCounts) return false;
  if (!aCounts && !bCounts) return false;
  return RANK_POWER[a.rank] > RANK_POWER[b.rank];
}
function resolveTrick(room) {
  const g = room.game;
  const leadSuit = g.currentTrick[0].card.suit;
  let winningCard = g.currentTrick[0];
  for (const played of g.currentTrick.slice(1)) {
    if (cardBeats(played.card, winningCard.card, leadSuit, g.trump, g.trumpRevealed)) winningCard = played;
  }
  const winner = winningCard.seat;
  const cardPoints = g.currentTrick.reduce((sum, item) => sum + item.card.points, 0);
  const lastTrickBonus = g.tricksCompleted === 7 ? 1 : 0;
  const points = cardPoints + lastTrickBonus;
  const team = teamOf(winner);
  g.teamPoints[team] += points;
  g.trickWins[winner] += 1;
  g.tricksCompleted += 1;
  g.lastTrick = { cards: g.currentTrick.map((item) => ({ seat: item.seat, card: item.card })), winnerSeat: winner, points, trickNumber: g.tricksCompleted, cardPoints, lastTrickBonus };
  g.trickHistory.push({
    trickNumber: g.tricksCompleted,
    cards: g.currentTrick.map((item) => ({ seat: item.seat, card: item.card })),
    winnerSeat: winner,
    winnerName: room.players[winner]?.name || `Player ${winner + 1}`,
    team, points, cardPoints, lastTrickBonus,
    teamPoints: [...g.teamPoints],
  });
  g.currentTurn = winner;
  g.phase = 'trickComplete';
  sysChat(room, `${room.players[winner].name} wins trick ${g.tricksCompleted} for ${points} point${points === 1 ? '' : 's'}.`);
  broadcastState(room);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    if (!rooms.has(room.code) || room.game !== g) return;
    if (g.tricksCompleted >= 8) {
      const bidTeam = teamOf(g.bidder);
      const madeContract = g.teamPoints[bidTeam] >= g.highBid;
      const winningTeam = madeContract ? bidTeam : 1 - bidTeam;
      room.matchScores[winningTeam] += 1;
      room.roundsPlayed += 1;
      g.winningTeam = winningTeam;
      g.phase = room.matchScores[winningTeam] >= TARGET_MATCH_SCORE ? 'gameOver' : 'roundEnd';
      g.roundSummary = {
        bidder: g.bidder,
        bid: g.highBid,
        bidTeam,
        madeContract,
        winningTeam,
        teamPoints: [...g.teamPoints],
        matchScores: [...room.matchScores],
        resultText: madeContract ? `${partnerTeamLabel(bidTeam)} made the ${g.highBid} bid.` : `${partnerTeamLabel(bidTeam)} missed the ${g.highBid} bid.`,
      };
      sysChat(room, `${g.roundSummary.resultText} ${partnerTeamLabel(winningTeam)} win the round. Match score: ${room.matchScores[0]}–${room.matchScores[1]}.`);
    } else {
      g.phase = 'playing';
      g.currentTrick = [];
      g.lastTrick = null;
    }
    broadcastState(room);
  }, 1500);
}
function resetRoomToLobby(room, message) {
  clearTimeout(room.timer);
  room.game = null;
  for (const p of room.players) if (p) p.ready = false;
  sysChat(room, message);
  broadcastState(room);
}
function cleanupRoom(room) {
  clearTimeout(room.timer);
  rooms.delete(room.code);
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.videoReady = false;

  socket.on('room:create', (payload = {}) => {
    if (socket.data.roomCode) return emitNotice(socket, 'Leave your current room before creating another.', 'error');
    const name = safeName(payload.name);
    const code = newCode();
    const room = { code, hostId: socket.id, players: [ { id: socket.id, name, ready: false }, null, null, null ], dealer: 0, game: null, matchScores: [0, 0], roundsPlayed: 0, chat: [], timer: null };
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);
    sysChat(room, `${name} created the room. Share code ${code} with three friends.`);
    broadcastState(room);
  });

  socket.on('room:join', (payload = {}) => {
    if (socket.data.roomCode) return emitNotice(socket, 'Leave your current room before joining another.', 'error');
    const code = String(payload.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const room = rooms.get(code);
    if (!room) return emitNotice(socket, 'Room not found. Check the six-character code.', 'error');
    if (room.game && !['lobby', 'interrupted'].includes(room.game.phase)) return emitNotice(socket, 'This game has already started. Join after the current round.', 'error');
    const seat = room.players.findIndex((p) => p === null);
    if (seat < 0) return emitNotice(socket, 'This room already has four players.', 'error');
    const name = safeName(payload.name);
    room.players[seat] = { id: socket.id, name, ready: false };
    socket.data.roomCode = code;
    socket.join(code);
    sysChat(room, `${name} joined the room.`);
    broadcastState(room);
  });

  socket.on('player:ready', () => {
    const ctx = member(null, socket); if (ctx.error) return emitNotice(socket, ctx.error, 'error');
    if (ctx.room.game) return emitNotice(socket, 'The round is already running.', 'error');
    ctx.player.ready = !ctx.player.ready;
    sysChat(ctx.room, `${ctx.player.name} is ${ctx.player.ready ? 'ready' : 'not ready'}.`);
    broadcastState(ctx.room);
  });

  socket.on('game:start', () => {
    const ctx = member(null, socket); if (ctx.error) return emitNotice(socket, ctx.error, 'error');
    const r = ctx.room;
    if (r.hostId !== socket.id) return emitNotice(socket, 'Only the room host can start the game.', 'error');
    if (r.game) return emitNotice(socket, 'A game is already in progress.', 'error');
    if (!r.players.every(Boolean)) return emitNotice(socket, 'Four players are required to start.', 'error');
    if (!r.players.every((p) => p.ready)) return emitNotice(socket, 'All four players must be ready first.', 'error');
    beginRound(r);
  });

  socket.on('game:bid', (payload = {}) => {
    const ctx = member(null, socket); if (ctx.error) return emitNotice(socket, ctx.error, 'error');
    const g = ctx.room.game;
    if (!g || g.phase !== 'bidding') return emitNotice(socket, 'Bidding is not open.', 'error');
    if (g.currentTurn !== ctx.seat) return emitNotice(socket, 'Wait for your turn to bid.', 'error');
    const error = advanceAfterBid(ctx.room, ctx.seat, { type: payload.pass ? 'pass' : 'bid', value: payload.value });
    if (error) emitNotice(socket, error, 'error');
  });

  socket.on('game:trump', (payload = {}) => {
    const ctx = member(null, socket); if (ctx.error) return emitNotice(socket, ctx.error, 'error');
    const g = ctx.room.game;
    if (!g || g.phase !== 'trump' || g.dealer !== ctx.seat) return emitNotice(socket, 'Only the dealer can choose Rang for this round.', 'error');
    const suit = String(payload.suit || '');
    if (!SUITS.includes(suit)) return emitNotice(socket, 'Choose a valid suit.', 'error');
    if (!g.hands[ctx.seat].some((c) => c.suit === suit)) return emitNotice(socket, 'Choose a suit you hold in your hand.', 'error');
    g.trump = suit;
    g.trumpRevealed = false;
    g.phase = 'playing';
    g.currentTurn = ctx.seat;
    sysChat(ctx.room, `${ctx.player.name} (dealer) chose Rang: ${SUIT_SYMBOLS[suit]} ${suit}. The suit is hidden from opponents until someone reveals it.`);
    broadcastState(ctx.room);
  });

  socket.on('game:play', (payload = {}) => {
    const ctx = member(null, socket); if (ctx.error) return emitNotice(socket, ctx.error, 'error');
    const r = ctx.room, g = r.game;
    if (!g || g.phase !== 'playing') return emitNotice(socket, 'You cannot play a card right now.', 'error');
    if (g.currentTurn !== ctx.seat) return emitNotice(socket, 'Wait for your turn to play.', 'error');
    const hand = g.hands[ctx.seat];
    const index = hand.findIndex((c) => c.id === payload.cardId);
    if (index < 0) return emitNotice(socket, 'That card is not in your hand.', 'error');
    const card = hand[index];
    const leadSuit = g.currentTrick.length ? g.currentTrick[0].card.suit : null;
    if (leadSuit && hand.some((c) => c.suit === leadSuit) && card.suit !== leadSuit) return emitNotice(socket, `You must follow suit with ${SUIT_SYMBOLS[leadSuit]}.`, 'error');
    hand.splice(index, 1);
    g.currentTrick.push({ seat: ctx.seat, card });
    if (g.currentTrick.length === 4) resolveTrick(r);
    else {
      g.currentTurn = (ctx.seat + 1) % 4;
      broadcastState(r);
    }
  });

  socket.on('game:reveal-trump', () => {
    const ctx = member(null, socket); if (ctx.error) return emitNotice(socket, ctx.error, 'error');
    const g = ctx.room.game;
    if (!g || g.phase !== 'playing' || !g.trump || g.trumpRevealed) return emitNotice(socket, 'Trump cannot be revealed right now.', 'error');
    if (!g.hands[ctx.seat].some((c) => c.suit === g.trump)) return emitNotice(socket, 'You need to hold a trump card to reveal it.', 'error');
    g.trumpRevealed = true;
    sysChat(ctx.room, `${ctx.player.name} revealed trump: ${SUIT_SYMBOLS[g.trump]}.`);
    broadcastState(ctx.room);
  });

  socket.on('game:next-round', () => {
    const ctx = member(null, socket); if (ctx.error) return emitNotice(socket, ctx.error, 'error');
    const r = ctx.room;
    if (r.hostId !== socket.id) return emitNotice(socket, 'Only the host can start the next round.', 'error');
    if (!r.game || r.game.phase !== 'roundEnd') return emitNotice(socket, 'The round has not finished yet.', 'error');
    r.dealer = (r.dealer + 1) % 4;
    beginRound(r);
  });

  socket.on('game:new-match', () => {
    const ctx = member(null, socket); if (ctx.error) return emitNotice(socket, ctx.error, 'error');
    const r = ctx.room;
    if (r.hostId !== socket.id) return emitNotice(socket, 'Only the host can start a new match.', 'error');
    if (!r.game || r.game.phase !== 'gameOver') return emitNotice(socket, 'The match is not over yet.', 'error');
    r.matchScores = [0, 0]; r.roundsPlayed = 0; r.dealer = (r.dealer + 1) % 4;
    beginRound(r);
  });

  socket.on('chat:send', (payload = {}) => {
    const ctx = member(null, socket); if (ctx.error) return emitNotice(socket, ctx.error, 'error');
    const text = String(payload.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
    if (!text) return;
    ctx.room.chat.push({ id: `${Date.now()}-${Math.random()}`, system: false, seat: ctx.seat, name: ctx.player.name, text, at: Date.now() });
    if (ctx.room.chat.length > 100) ctx.room.chat.splice(0, ctx.room.chat.length - 100);
    broadcastState(ctx.room);
  });

  socket.on('video:ready', () => {
    const ctx = member(null, socket); if (ctx.error) return emitNotice(socket, ctx.error, 'error');
    socket.data.videoReady = true;
    announceVideoPeers(ctx.room, socket);
  });
  socket.on('video:leave', () => {
    const ctx = member(null, socket);
    socket.data.videoReady = false;
    if (!ctx.error) io.to(ctx.room.code).emit('video:peer-left', { id: socket.id });
  });
  for (const signalType of ['video:offer', 'video:answer', 'video:ice']) {
    socket.on(signalType, (payload = {}) => {
      const ctx = member(null, socket); if (ctx.error) return;
      const target = String(payload.target || '');
      const isMember = ctx.room.players.some((p) => p && p.id === target);
      if (!target || !isMember || target === socket.id || !io.sockets.sockets.get(target)?.data.videoReady) return;
      const safePayload = { from: socket.id, name: ctx.player.name };
      if (signalType === 'video:offer') safePayload.offer = payload.offer;
      if (signalType === 'video:answer') safePayload.answer = payload.answer;
      if (signalType === 'video:ice') safePayload.candidate = payload.candidate;
      io.to(target).emit(signalType, safePayload);
    });
  }

  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket, true));
});

function leaveRoom(socket, disconnecting = false) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  socket.data.videoReady = false;
  if (!room) return;
  const seat = seatOf(room, socket.id);
  if (seat >= 0) {
    const departed = room.players[seat];
    room.players[seat] = null;
    sysChat(room, `${departed?.name || 'A player'} ${disconnecting ? 'disconnected' : 'left the room'}.`);
    io.to(code).emit('video:peer-left', { id: socket.id });
    if (room.hostId === socket.id) {
      const nextHost = room.players.find(Boolean);
      room.hostId = nextHost ? nextHost.id : null;
      if (nextHost) sysChat(room, `${nextHost.name} is now the room host.`);
    }
    if (room.game) {
      clearTimeout(room.timer);
      room.timer = null;
      room.game = null;
      for (const p of room.players) if (p) p.ready = false;
      sysChat(room, 'The game was reset because a player left. Ready up when all four players are back.');
    }
    if (room.players.every((p) => p === null)) cleanupRoom(room);
    else broadcastState(room);
  }
  if (!disconnecting) socket.leave(code);
}

server.listen(PORT, '0.0.0.0', () => console.log(`Card29 listening on port ${PORT}`));
