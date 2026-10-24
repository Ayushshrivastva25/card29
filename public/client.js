'use strict';

const socket = io({ transports: ['websocket', 'polling'] });
const $ = (id) => document.getElementById(id);
let appState = null;
let activeTab = 'chat';
let lastChatLength = 0;
let liveRooms = [];
let localStream = null;
let videoJoined = false;
let micEnabled = true;
let cameraEnabled = true;
const peerConnections = new Map();
const remoteStreams = new Map();

const SUITS = {
  clubs: { symbol: '♣', label: 'Clubs', red: false },
  diamonds: { symbol: '♦', label: 'Diamonds', red: true },
  hearts: { symbol: '♥', label: 'Hearts', red: true },
  spades: { symbol: '♠', label: 'Spades', red: false },
};
const PHASE_LABELS = { lobby: 'LOBBY', redeal: 'REDEAL', bidding: 'BIDDING', trump: 'TRUMP', playing: 'PLAYING', trickComplete: 'TRICK', roundEnd: 'ROUND OVER', gameOver: 'MATCH OVER' };

function setConnectionStatus(label, connected) {
  $('connectionLabel').textContent = label;
  $('roomConnectionLabel').textContent = label;
  $('connectionLabel').previousElementSibling.style.background = connected ? 'var(--lime2)' : '#e99b9b';
  $('roomConnectionDot').style.background = connected ? 'var(--lime2)' : '#e99b9b';
  $('roomConnectionDot').classList.toggle('is-connected', connected);
}
socket.on('connect', () => setConnectionStatus('Connected', true));
socket.on('disconnect', () => {
  setConnectionStatus('Reconnecting…', false);
  showToast('Connection lost. Reconnecting to the game server…', 'error');
});
socket.on('connect_error', () => setConnectionStatus('Connection issue', false));
socket.on('notice', (notice) => showToast(notice?.text || 'Something went wrong.', notice?.type || 'info'));
socket.on('room:removed', (payload = {}) => {
  if (videoJoined) leaveVideoCall();
  appState = null; lastChatLength = 0;
  renderApp(false);
  showToast(payload.message || 'You were removed from the room.', 'error');
});
socket.on('rooms:list', (rooms) => { liveRooms = Array.isArray(rooms) ? rooms : []; renderLiveRooms(); });
socket.on('room:activity', (activity = {}) => {
  if (activity.type === 'chat') showToast(`💬 ${activity.name}: ${activity.text}`, 'info');
  else if (activity.type === 'video') showToast(`📹 ${activity.name} joined the video call.`, 'success');
  else if (activity.type === 'video-left') showToast(`📹 ${activity.name} left the video call.`, 'info');
});
socket.on('state', (state) => {
  const previousLength = lastChatLength;
  appState = state;
  lastChatLength = Array.isArray(state.chat) ? state.chat.length : 0;
  renderApp(previousLength !== lastChatLength);
});
socket.on('video:peers', async (peers) => {
  if (!videoJoined) return;
  for (const peer of peers || []) {
    try { await createOffer(peer.id, peer.name); }
    catch (e) { console.warn('Could not connect to video peer', e); }
  }
});
socket.on('video:offer', async ({ from, name, offer }) => {
  if (!videoJoined || !from || !offer) return;
  try {
    const record = getPeerConnection(from, name);
    await record.pc.setRemoteDescription(new RTCSessionDescription(offer));
    await flushCandidates(record);
    const answer = await record.pc.createAnswer();
    await record.pc.setLocalDescription(answer);
    socket.emit('video:answer', { target: from, answer: record.pc.localDescription });
  } catch (e) { console.error(e); showToast(`Video connection with ${name || 'a player'} failed.`, 'error'); }
});
socket.on('video:answer', async ({ from, answer }) => {
  const record = peerConnections.get(from);
  if (!record || !answer) return;
  try { await record.pc.setRemoteDescription(new RTCSessionDescription(answer)); await flushCandidates(record); }
  catch (e) { console.warn('Could not set remote video answer', e); }
});
socket.on('video:ice', async ({ from, candidate }) => {
  const record = peerConnections.get(from);
  if (!record || !candidate) return;
  try {
    if (record.pc.remoteDescription) await record.pc.addIceCandidate(new RTCIceCandidate(candidate));
    else record.pendingCandidates.push(candidate);
  } catch (e) { console.warn('ICE candidate was not accepted', e); }
});
socket.on('video:peer-left', ({ id }) => removePeer(id));

function showToast(message, type = 'info') {
  const region = $('toastRegion');
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  region.appendChild(item);
  setTimeout(() => item.remove(), 3800);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function getName() {
  const value = $('playerName').value.trim();
  if (!value) { $('playerName').focus(); showToast('Enter your name before joining the table.', 'error'); return null; }
  return value.slice(0, 22);
}
$('createRoomBtn').addEventListener('click', () => {
  const name = getName();
  if (name) socket.emit('room:create', { name });
});
$('joinRoomBtn').addEventListener('click', () => {
  const name = getName();
  const code = $('roomCodeInput').value.trim().toUpperCase();
  if (!name) return;
  if (code.length !== 6) { $('roomCodeInput').focus(); showToast('Enter the full six-character room code.', 'error'); return; }
  socket.emit('room:join', { name, code });
});
$('roomCodeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
$('roomCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinRoomBtn').click(); });
$('playerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('createRoomBtn').click(); });
$('brandHome').addEventListener('click', (e) => { e.preventDefault(); if (!appState) window.scrollTo({ top: 0, behavior: 'smooth' }); else $('confirmOverlay').classList.remove('hidden'); });
$('copyCodeBtn').addEventListener('click', async () => {
  if (!appState?.code) return;
  try { await navigator.clipboard.writeText(appState.code); showToast('Room code copied. Send it to your three friends.', 'success'); }
  catch { showToast(`Your room code is ${appState.code}. Select and copy it.`, 'info'); }
});
$('readyBtn').addEventListener('click', () => socket.emit('player:ready'));
$('startGameBtn').addEventListener('click', () => socket.emit('game:start'));
$('leaveRoomBtn').addEventListener('click', () => $('confirmOverlay').classList.remove('hidden'));
$('stayBtn').addEventListener('click', () => $('confirmOverlay').classList.add('hidden'));
$('confirmLeaveBtn').addEventListener('click', () => {
  $('confirmOverlay').classList.add('hidden');
  if (videoJoined) leaveVideoCall();
  socket.emit('room:leave');
  appState = null;
  lastChatLength = 0;
  renderApp(false);
});
$('chatTab').addEventListener('click', () => setTab('chat'));
$('videoTab').addEventListener('click', () => setTab('video'));
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text || !appState) return;
  socket.emit('chat:send', { text });
  input.value = '';
  input.focus();
});
$('joinVideoBtn').addEventListener('click', joinVideoCall);
$('leaveVideoBtn').addEventListener('click', leaveVideoCall);
$('micBtn').addEventListener('click', () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((track) => { track.enabled = micEnabled; });
  $('micBtn').textContent = micEnabled ? '🎙' : '🔇';
  $('micBtn').classList.toggle('muted', !micEnabled);
});
$('cameraBtn').addEventListener('click', () => {
  if (!localStream) return;
  cameraEnabled = !cameraEnabled;
  localStream.getVideoTracks().forEach((track) => { track.enabled = cameraEnabled; });
  $('cameraBtn').textContent = cameraEnabled ? '▣' : '▧';
  $('cameraBtn').classList.toggle('muted', !cameraEnabled);
});

function renderApp(chatChanged = false) {
  const inRoom = Boolean(appState?.code);
  document.body.classList.toggle('in-room', inRoom);
  $('landingView').classList.toggle('hidden', inRoom);
  $('roomView').classList.toggle('hidden', !inRoom);
  if (!inRoom) { renderLiveRooms(); return; }
  $('roomCodeDisplay').textContent = appState.code;
  $('phasePill').textContent = appState.game ? (PHASE_LABELS[appState.game.phase] || appState.game.phase.toUpperCase()) : 'LOBBY';
  renderLobby();
  if (appState.game) renderGame();
  renderChat(chatChanged);
  setTab(activeTab, false);
}
function renderLiveRooms() {
  const list = $('liveRoomList');
  if (!list) return;
  $('liveRoomCount').textContent = `${liveRooms.length} room${liveRooms.length === 1 ? '' : 's'}`;
  if (!liveRooms.length) { list.innerHTML = '<p class="rooms-empty">No active rooms yet. Create a table and invite your friends.</p>'; return; }
  list.innerHTML = liveRooms.map((room) => `<div class="live-room-row"><div class="live-room-info"><strong>${escapeHtml(room.code)}</strong><span>${room.players}/${room.capacity} players · ${escapeHtml(room.status)}</span></div>${room.joinable ? `<button class="secondary-button live-join-btn" data-room-code="${escapeHtml(room.code)}">Join</button>` : '<span class="room-full-label">In game</span>'}</div>`).join('');
  list.querySelectorAll('[data-room-code]').forEach((button) => button.addEventListener('click', () => {
    const name = getName(); if (!name) return;
    $('roomCodeInput').value = button.dataset.roomCode;
    socket.emit('room:join', { name, code: button.dataset.roomCode });
  }));
}
function renderLobby() {
  const lobby = !appState.game;
  $('lobbyPanel').classList.toggle('hidden', !lobby);
  $('gamePanel').classList.toggle('hidden', lobby);
  if (!lobby) return;
  const count = appState.players.filter((p) => p.id).length;
  const ready = appState.players.filter((p) => p.id && p.ready).length;
  $('readyCount').textContent = `${ready}/4`;
  $('lobbySeats').innerHTML = appState.players.map((p) => {
    const occupied = Boolean(p.id);
    const badge = p.host ? '<span class="seat-badge">HOST</span>' : p.ready ? '<span class="seat-badge">READY</span>' : '';
    const subtitle = !occupied ? 'Open seat' : p.ready ? 'Ready to play' : p.host ? 'Room creator' : 'Getting settled';
    const team = p.seat % 2 === 0 ? 'N/S' : 'E/W';
    const teamClass = team === 'N/S' ? 'team-ns-badge' : 'team-ew-badge';
    return `<div class="lobby-seat ${occupied ? 'occupied' : ''}">${badge}<div class="seat-avatar">${occupied ? escapeHtml(initials(p.name)) : '＋'}</div><div class="seat-name">${escapeHtml(p.name)}</div><div class="seat-meta">${subtitle}</div><span class="lobby-team-badge ${teamClass}">Seat ${p.seat + 1} · ${team} team</span>${occupied && appState.hostId === appState.you && p.id !== appState.you ? `<button class="remove-player-btn" data-remove-player="${escapeHtml(p.id)}" aria-label="Remove ${escapeHtml(p.name)}">Remove player</button>` : ''}</div>`;
  }).join('');
  $('lobbySeats').querySelectorAll('[data-remove-player]').forEach((button) => button.addEventListener('click', () => {
    const player = appState?.players.find((p) => p.id === button.dataset.removePlayer);
    if (!player || appState?.hostId !== appState?.you) return;
    if (window.confirm(`Remove ${player.name} from this room?`)) socket.emit('room:remove-player', { playerId: player.id });
  }));
  const mine = appState.players.find((p) => p.seat === appState.yourSeat);
  $('readyBtn').disabled = !mine;
  $('readyBtn').textContent = mine?.ready ? '✓ Ready — cancel' : "I'm ready";
  $('startGameBtn').classList.toggle('hidden', appState.hostId !== appState.you);
  $('startGameBtn').disabled = !(count === 4 && ready === 4);
  if (count < 4) $('lobbyHint').textContent = `Invite ${4 - count} more player${4 - count === 1 ? '' : 's'} with the room code above.`;
  else if (ready < 4) $('lobbyHint').textContent = `${ready} of 4 players ready. Everyone needs to mark ready.`;
  else $('lobbyHint').textContent = appState.hostId === appState.you ? 'Everyone is ready. Deal the cards when you are.' : 'Everyone is ready. Waiting for the host to start…';
}
function initials(name) {
  const parts = String(name || 'Player').trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase();
}
function teamName(seat) { return seat % 2 === 0 ? 'N/S' : 'E/W'; }
function renderGame() {
  const g = appState.game;
  $('scoreTeam0').textContent = g.matchScores[0];
  $('scoreTeam1').textContent = g.matchScores[1];
  const track0 = Array.from({ length: g.targetMatchScore }, (_, i) => `<i style="background:${i < g.matchScores[0] ? 'var(--lime)' : '#2b4934'}"></i>`).join('');
  const track1 = Array.from({ length: g.targetMatchScore }, (_, i) => `<i style="background:${i < g.matchScores[1] ? 'var(--gold)' : '#2b4934'}"></i>`).join('');
  // Rebuild the match track from the current team scores.
  document.querySelector('.score-track').innerHTML = track0 + track1;
  renderSeats();
  renderRoundPoints();
  renderHandScores();
  renderTrick();
  renderStatusAndActions();
  renderHand();
}
function renderRoundPoints() {
  const g = appState.game;
  $('roundPointTeam0').textContent = g.teamPoints?.[0] ?? 0;
  $('roundPointTeam1').textContent = g.teamPoints?.[1] ?? 0;
  $('completedTricksCount').textContent = `${g.tricksCompleted || 0} / 8`;
}
function renderHandScores() {
  const history = Array.isArray(appState.game.trickHistory) ? appState.game.trickHistory : [];
  const byHand = new Map(history.map((trick) => [Number(trick.trickNumber), trick]));
  $('handScoreValues').innerHTML = Array.from({ length: 8 }, (_, index) => {
    const handNumber = index + 1;
    const trick = byHand.get(handNumber);
    if (!trick) {
      return `<div class="hand-score-chip pending" title="Hand ${handNumber} is not complete" aria-label="Hand ${handNumber} not complete"><span class="hand-score-index">${handNumber}</span><strong>—</strong></div>`;
    }
    const teamLabel = trick.team === 0 ? 'N/S' : 'E/W';
    const teamClass = trick.team === 0 ? 'history-ns' : 'history-ew';
    const points = Number(trick.points) || 0;
    return `<div class="hand-score-chip ${teamClass}" title="Hand ${handNumber}: ${points} point${points === 1 ? '' : 's'} to ${teamLabel}" aria-label="Hand ${handNumber}: ${points} points to ${teamLabel}"><span class="hand-score-index">${handNumber}</span><strong>${points}</strong><span class="hand-score-team">${teamLabel}</span></div>`;
  }).join('');
}
function relativeSeats() {
  const mine = appState.yourSeat;
  return { bottom: mine, top: (mine + 2) % 4, left: (mine + 1) % 4, right: (mine + 3) % 4 };
}
function renderSeats() {
  const g = appState.game;
  const layout = relativeSeats();
  for (const [position, seat] of Object.entries(layout)) {
    const p = appState.players.find((player) => player.seat === seat);
    const isTurn = g.currentTurn === seat && ['bidding', 'trump', 'playing'].includes(g.phase);
    const isBidder = g.bidder === seat;
    const teamLabel = teamName(seat);
    const teamClass = teamLabel === 'N/S' ? 'team-ns-badge' : 'team-ew-badge';
    const meta = [seat === g.dealer ? '<span class="dealer-mark">DEALER</span>' : '', isBidder ? `<span style="color:var(--gold)">BID ${g.highBid}</span>` : '', g.trickWins[seat] ? `${g.trickWins[seat]} tricks` : `${g.handCounts[seat]} cards`].filter(Boolean).join(' · ');
    const isSide = position === 'left' || position === 'right';
    const seatEl = $(`seat${position[0].toUpperCase()}${position.slice(1)}`);
    seatEl.className = `player-seat seat-${position} ${isTurn ? 'active-turn' : ''}`;
    seatEl.innerHTML = `<div class="seat-mini-avatar">${escapeHtml(initials(p?.name || 'Player'))}<span class="seat-hand-count">${g.handCounts[seat]}</span></div><div class="seat-details"><div class="seat-player-name">${escapeHtml(p?.name || 'Player')}${seat === appState.yourSeat ? ' (you)' : ''}${isTurn ? '<span class="turn-marker">TURN</span>' : ''}</div><div class="seat-player-meta"><span class="seat-team-badge ${teamClass}">${teamLabel} team</span> ${meta}</div>${p && appState.hostId === appState.you && p.id !== appState.you ? `<button class="remove-player-btn game-remove-player" data-remove-player="${escapeHtml(p.id)}">Remove</button>` : ''}</div>`;
    if (!isSide) seatEl.style.flexDirection = position === 'top' ? 'row' : 'row-reverse';
  }
  document.querySelectorAll('#tableStage [data-remove-player]').forEach((button) => button.addEventListener('click', () => {
    const player = appState?.players.find((item) => item.id === button.dataset.removePlayer);
    if (!player || appState?.hostId !== appState?.you) return;
    if (window.confirm(`Remove ${player.name} from this room? The current game will reset.`)) socket.emit('room:remove-player', { playerId: player.id });
  }));
}
function cardMarkup(card, button = false, disabled = false, canPlay = false) {
  const suit = SUITS[card.suit] || SUITS.spades;
  const classes = `playing-card ${suit.red ? 'red' : ''} ${button ? (canPlay ? 'can-play' : 'cannot-play') : ''}`;
  const body = `<span class="card-corner"><span class="card-rank">${escapeHtml(card.rank)}</span><span class="card-suit">${suit.symbol}</span></span><span class="card-center">${suit.symbol}</span><span class="card-bottom"><span>${escapeHtml(card.rank)}</span><span>${suit.symbol}</span></span>`;
  if (button) return `<button class="${classes}" data-card-id="${escapeHtml(card.id)}" ${disabled ? 'disabled' : ''} aria-label="${escapeHtml(card.rank)} of ${suit.label}">${body}</button>`;
  return `<div class="${classes}">${body}</div>`;
}
function renderTrick() {
  const g = appState.game;
  let label = 'NEXT HAND';
  if (g.phase === 'bidding') label = 'BIDDING';
  else if (g.phase === 'trump') label = 'CHOOSE RANG';
  else if (g.phase === 'playing') label = `HAND ${Math.min((g.tricksCompleted || 0) + 1, 8)}`;
  else if (g.phase === 'trickComplete') label = `HAND ${g.tricksCompleted} COMPLETE`;
  else if (g.phase === 'roundEnd' || g.phase === 'gameOver') label = 'ROUND COMPLETE';
  const count = g.phase === 'playing' ? `${g.currentTrick.length}/4 players have played` : `${g.tricksCompleted || 0}/8 hands complete`;
  const positions = relativeSeats();
  const played = Array.isArray(g.currentTrick) ? g.currentTrick : [];
  const slots = played.map((item) => {
    const position = Object.keys(positions).find((key) => positions[key] === item.seat) || 'bottom';
    const card = item.card ? cardMarkup(item.card) : '';
    return `<div class="played-slot played-${position}" title="${escapeHtml(currentPlayerName(item.seat))}">${card}<span class="played-card-name">${escapeHtml(currentPlayerName(item.seat))}</span></div>`;
  }).join('');
  const empty = played.length ? '' : `<div class="empty-trick"><span class="trick-symbols"><span>♣ ♠</span> <span class="red-cards">♥ ♦</span></span><strong>${label}</strong><small>${count}</small></div>`;
  $('trickCenter').innerHTML = `<div class="trick-mat">${empty}${slots}<div class="trick-progress">${label} · ${count}</div></div>`;
}
function currentPlayerName(seat) { return appState.players.find((p) => p.seat === seat)?.name || 'A player'; }
function renderStatusAndActions() {
  const g = appState.game;
  const mine = appState.yourSeat;
  const myTurn = g.currentTurn === mine;
  const actions = $('actionPanel');
  let status = '';
  let html = '';
  if (g.phase === 'redeal') {
    status = 'Everyone passed. The cards are being redealt.';
    html = '<p class="action-label">The dealer will rotate automatically.</p>';
  } else if (g.phase === 'bidding') {
    status = myTurn ? 'Your turn — make a bid or pass.' : `${currentPlayerName(g.currentTurn)} is thinking about a bid.`;
    if (myTurn) {
      const first = Math.max(16, g.highBid + 1);
      const options = [];
      for (let bid = first; bid <= 29; bid++) options.push(`<option value="${bid}">${bid} points</option>`);
      html = `<p class="action-label">${g.bidder === null ? 'Open the bidding — minimum 16' : `Current bid: ${g.highBid} · Choose higher or pass`}</p><div class="bid-controls"><select id="bidValue" aria-label="Your bid" ${options.length ? '' : 'disabled'}>${options.length ? options.join('') : '<option>No higher bid</option>'}</select><button class="primary-button" id="submitBidBtn" ${options.length ? '' : 'disabled'}>Place bid</button><button class="secondary-button" id="passBidBtn">Pass</button></div>`;
    } else html = `<p class="action-label">${g.bidder === null ? 'No bids yet' : `${currentPlayerName(g.bidder)} leads with ${g.highBid}`}. ${Object.keys(g.bids).length}/4 actions in this bidding round.</p>`;
  } else if (g.phase === 'trump') {
    status = mine === g.dealer ? 'You are the dealer. Choose Rang (the trump suit) for this round.' : `${currentPlayerName(g.dealer)} (dealer) is choosing Rang for this round.`;
    if (mine === g.dealer) {
      const allSuits = ['clubs', 'spades', 'hearts', 'diamonds'];
      html = `<p class="action-label">Choose Rang from one of the four suits. You can choose a suit you hold; opponents won't see it until it is revealed.</p><div class="rang-choice-grid">${allSuits.map((suit) => {
        const held = g.hand.some((card) => card.suit === suit);
        return `<button class="suit-button ${SUITS[suit].red ? 'red-suit' : ''}" data-trump="${suit}" ${held ? '' : 'disabled'} title="${held ? `Choose ${SUITS[suit].label} as Rang` : `No ${SUITS[suit].label} in your hand`}" aria-label="${SUITS[suit].label}${held ? '' : ', not in your hand'}"><span>${SUITS[suit].symbol}</span><small>${SUITS[suit].label}</small></button>`;
      }).join('')}</div>`;
    } else html = '<p class="action-label">The dealer is selecting Rang from their hand. The suit stays hidden from opponents until it is revealed.</p>';
  } else if (g.phase === 'playing') {
    const rangLabel = g.trump ? `Rang: ${SUITS[g.trump].symbol} ${SUITS[g.trump].label}` : (g.trumpHidden ? 'Rang: hidden' : '');
    status = (myTurn ? 'Your turn — choose a card to play.' : `${currentPlayerName(g.currentTurn)} is playing${g.leadSuit ? ` · lead suit ${SUITS[g.leadSuit].symbol}` : ''}.`) + (rangLabel ? ` · ${rangLabel}` : '');
    if (g.youCanReveal && !g.trumpRevealed && myTurn) html = '<button class="secondary-button" id="revealTrumpBtn">♢ Reveal Rang (trump)</button><p class="action-label rang-help">You can reveal Rang now because it is your turn.</p>';
    if (!myTurn && !html) html = `<p class="action-label">${g.currentTrick.length}/4 cards played in this trick. Follow suit when you can.</p>`;
  } else if (g.phase === 'trickComplete') {
    status = `${currentPlayerName(g.lastTrick?.winnerSeat)} won trick ${g.lastTrick?.trickNumber} and took ${g.lastTrick?.points} point${g.lastTrick?.points === 1 ? '' : 's'}.`;
    html = '<p class="action-label">Next trick starts in a moment…</p>';
  } else if (g.phase === 'roundEnd' || g.phase === 'gameOver') {
    const summary = g.roundSummary;
    status = g.phase === 'gameOver' ? `${summary ? (summary.winningTeam === 0 ? 'North / South' : 'East / West') : 'A team'} won the match!` : 'All eight tricks are complete.';
    html = `<div class="round-result"><p class="action-label">${escapeHtml(summary?.resultText || '')} Round points: N/S ${g.teamPoints[0]} — E/W ${g.teamPoints[1]}.</p>${appState.hostId === appState.you ? (g.phase === 'gameOver' ? '<button class="primary-button" id="newMatchBtn">Start a new match ↻</button>' : '<button class="primary-button" id="nextRoundBtn">Next round →</button>') : '<p class="action-label">Waiting for the host…</p>'}</div>`;
  }
  $('statusText').textContent = status;
  actions.innerHTML = html;
  $('submitBidBtn')?.addEventListener('click', () => socket.emit('game:bid', { value: $('bidValue').value }));
  $('passBidBtn')?.addEventListener('click', () => socket.emit('game:bid', { pass: true }));
  actions.querySelectorAll('[data-trump]').forEach((button) => button.addEventListener('click', () => socket.emit('game:trump', { suit: button.dataset.trump })));
  $('revealTrumpBtn')?.addEventListener('click', () => socket.emit('game:reveal-trump'));
  $('nextRoundBtn')?.addEventListener('click', () => socket.emit('game:next-round'));
  $('newMatchBtn')?.addEventListener('click', () => socket.emit('game:new-match'));
}
function renderHand() {
  const g = appState.game;
  const mine = appState.yourSeat;
  const myTurn = g.phase === 'playing' && g.currentTurn === mine;
  const hand = g.hand || [];
  $('handCount').textContent = `${hand.length} card${hand.length === 1 ? '' : 's'}`;
  $('playerHand').innerHTML = hand.map((card) => {
    const mustFollow = g.leadSuit && hand.some((c) => c.suit === g.leadSuit);
    const follows = !mustFollow || card.suit === g.leadSuit;
    const playable = myTurn && follows;
    return cardMarkup(card, true, !playable, playable);
  }).join('') || '<p class="action-label">No cards left in your hand.</p>';
  $('playerHand').querySelectorAll('[data-card-id]').forEach((button) => button.addEventListener('click', () => {
    if (button.disabled) return;
    socket.emit('game:play', { cardId: button.dataset.cardId });
  }));
}
function renderChat(chatChanged) {
  const container = $('chatMessages');
  const shouldScroll = chatChanged || container.scrollHeight - container.scrollTop - container.clientHeight < 70;
  container.innerHTML = (appState.chat || []).map((item) => {
    if (item.system) return `<div class="system-message">${escapeHtml(item.text)}</div>`;
    const mine = item.seat === appState.yourSeat;
    const time = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="chat-message ${mine ? 'mine' : ''}"><div class="chat-meta"><strong>${mine ? 'You' : escapeHtml(item.name)}</strong><time>${time}</time></div><div class="chat-bubble">${escapeHtml(item.text)}</div></div>`;
  }).join('');
  if (shouldScroll) requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
  $('chatUnread').classList.toggle('hidden', activeTab === 'chat' || !chatChanged);
}
function setTab(tab, render = true) {
  activeTab = tab;
  $('chatTab').classList.toggle('active', tab === 'chat');
  $('videoTab').classList.toggle('active', tab === 'video');
  $('chatPanel').classList.toggle('hidden', tab !== 'chat');
  $('videoPanel').classList.toggle('hidden', tab !== 'video');
  if (tab === 'chat') $('chatUnread').classList.add('hidden');
  if (render && tab === 'video') renderVideoGrid();
}

async function joinVideoCall() {
  if (videoJoined) { setTab('video'); return; }
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('Video calls require HTTPS (or localhost) and a browser that supports camera access.', 'error');
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 480 }, height: { ideal: 360 }, facingMode: 'user' } });
    videoJoined = true; micEnabled = true; cameraEnabled = true;
    $('joinVideoBtn').classList.add('hidden');
    $('micBtn').classList.remove('hidden'); $('cameraBtn').classList.remove('hidden'); $('leaveVideoBtn').classList.remove('hidden');
    $('micBtn').textContent = '🎙'; $('cameraBtn').textContent = '▣';
    socket.emit('video:ready');
    setTab('video'); renderVideoGrid();
    showToast('You joined the video room. Invite your friends to join too.', 'success');
  } catch (e) {
    console.error(e);
    const message = e?.name === 'NotAllowedError' ? 'Camera or microphone permission was denied. Allow access in your browser and try again.' : e?.name === 'NotFoundError' ? 'No camera or microphone was found on this device.' : 'Could not start video. Check your camera permissions and try again.';
    showToast(message, 'error');
  }
}
function leaveVideoCall() {
  if (!videoJoined) return;
  socket.emit('video:leave');
  for (const [id, record] of peerConnections) { try { record.pc.close(); } catch {} }
  peerConnections.clear(); remoteStreams.clear();
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  localStream = null; videoJoined = false;
  $('joinVideoBtn').classList.remove('hidden');
  $('micBtn').classList.add('hidden'); $('cameraBtn').classList.add('hidden'); $('leaveVideoBtn').classList.add('hidden');
  renderVideoGrid();
}
function getPeerConnection(id, name) {
  let record = peerConnections.get(id);
  if (record) { if (name) record.name = name; return record; }
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });
  record = { pc, name: name || 'Friend', pendingCandidates: [] };
  peerConnections.set(id, record);
  if (localStream) localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  pc.onicecandidate = (event) => { if (event.candidate) socket.emit('video:ice', { target: id, candidate: event.candidate }); };
  pc.ontrack = (event) => {
    const stream = event.streams?.[0];
    if (stream) remoteStreams.set(id, { stream, name: record.name });
    else {
      let existing = remoteStreams.get(id);
      if (!existing) { existing = { stream: new MediaStream(), name: record.name }; remoteStreams.set(id, existing); }
      existing.stream.addTrack(event.track);
    }
    renderVideoGrid();
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') removePeer(id);
    else if (pc.connectionState === 'connected') renderVideoGrid();
  };
  pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') showToast(`Video connection to ${record.name} failed. Try rejoining the call.`, 'error'); };
  return record;
}
async function createOffer(id, name) {
  if (!videoJoined || id === socket.id) return;
  const record = getPeerConnection(id, name);
  if (record.pc.signalingState !== 'stable') return;
  const offer = await record.pc.createOffer();
  await record.pc.setLocalDescription(offer);
  socket.emit('video:offer', { target: id, offer: record.pc.localDescription });
}
async function flushCandidates(record) {
  const queued = record.pendingCandidates.splice(0);
  for (const candidate of queued) {
    try { await record.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.warn('Queued ICE candidate failed', e); }
  }
}
function removePeer(id) {
  const record = peerConnections.get(id);
  if (record) { try { record.pc.close(); } catch {} peerConnections.delete(id); }
  remoteStreams.delete(id);
  renderVideoGrid();
}
function renderVideoGrid() {
  const grid = $('videoGrid');
  if (!grid) return;
  const tiles = [];
  if (videoJoined && localStream) tiles.push({ id: 'local', name: 'You', stream: localStream, local: true, muted: true });
  for (const [id, remote] of remoteStreams) tiles.push({ id, name: remote.name || peerConnections.get(id)?.name || 'Friend', stream: remote.stream, local: false });
  if (!tiles.length) {
    grid.innerHTML = '<div class="video-empty"><span>◉</span><b>Your video room</b><p>Join with camera and microphone to see your friends here.</p></div>';
    return;
  }
  grid.innerHTML = tiles.map((tile) => `<div class="video-tile ${tile.local ? 'local' : ''}" data-video-tile="${escapeHtml(tile.id)}"><div class="video-avatar">${escapeHtml(initials(tile.name))}</div><video autoplay playsinline ${tile.muted ? 'muted' : ''}></video><span class="video-name">${escapeHtml(tile.name)}</span></div>`).join('');
  for (const tile of tiles) {
    const video = grid.querySelector(`[data-video-tile="${CSS.escape(tile.id)}"] video`);
    if (video) { video.srcObject = tile.stream; video.play().catch(() => {}); }
  }
}

// Restore familiar name if the browser autofills it, but never persist room state locally.
$('playerName').value = localStorage.getItem('card29.playerName') || '';
$('playerName').addEventListener('change', () => localStorage.setItem('card29.playerName', $('playerName').value.trim().slice(0, 22)));
renderApp(false);
