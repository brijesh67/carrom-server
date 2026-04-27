'use strict';

const WebSocket = require('ws');
const crypto    = require('crypto');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

// rooms: code → { p1: { ws, token } | null, p2: { ws, token } | null, graceTimer }
const rooms = new Map();

// How long to hold a room open after a client disconnects, so brief
// interruptions (phone call, app switch, transient wifi drop) don't end the game.
const GRACE_MS = 30000;

function makeCode()  { return Math.random().toString(36).substr(2, 4).toUpperCase(); }
function makeToken() { return crypto.randomBytes(8).toString('hex'); }

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function opponentWs(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  const opp = ws.playerIndex === 0 ? room.p2 : room.p1;
  return opp ? opp.ws : null;
}

function clearGrace(room) {
  if (room && room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = null; }
}

wss.on('connection', ws => {
  ws.roomCode    = null;
  ws.playerIndex = -1;
  ws.isAlive     = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create_room': {
        let code;
        do { code = makeCode(); } while (rooms.has(code));
        const token = makeToken();
        rooms.set(code, { p1: { ws, token }, p2: null, graceTimer: null });
        ws.roomCode    = code;
        ws.playerIndex = 0;
        send(ws, { type: 'room_created', code, player: 0, token });
        break;
      }
      case 'join_room': {
        const code = (msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room)   { send(ws, { type: 'error', message: 'Room not found' }); break; }
        if (room.p2) { send(ws, { type: 'error', message: 'Room is full'   }); break; }
        const token = makeToken();
        room.p2        = { ws, token };
        ws.roomCode    = code;
        ws.playerIndex = 1;
        send(ws,         { type: 'room_joined', code, player: 1, token });
        send(room.p1.ws, { type: 'opponent_joined' });
        break;
      }
      case 'rejoin_room': {
        const code = (msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) { send(ws, { type: 'rejoin_failed', message: 'Room expired' }); break; }
        const slot = msg.player === 0 ? room.p1 : room.p2;
        if (!slot || slot.token !== msg.token) {
          send(ws, { type: 'rejoin_failed', message: 'Invalid token' });
          break;
        }
        slot.ws        = ws;
        ws.roomCode    = code;
        ws.playerIndex = msg.player;
        clearGrace(room);
        send(ws, { type: 'rejoin_ok' });
        send(opponentWs(ws), { type: 'opponent_reconnected' });
        break;
      }
      case 'shot':
      case 'new_round':
      case 'placing':
        send(opponentWs(ws), msg);
        break;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    // Tell the opponent we're trying to reconnect — they'll see a banner
    // instead of an immediate "disconnected" state.
    const opp = opponentWs(ws);
    if (opp) send(opp, { type: 'opponent_reconnecting' });

    // Hold the room open for GRACE_MS. If the player rejoins in time,
    // the timer is cleared; otherwise we notify the opponent and clean up.
    clearGrace(room);
    const code = ws.roomCode;
    const idx  = ws.playerIndex;
    room.graceTimer = setTimeout(() => {
      const r = rooms.get(code);
      if (!r) return;
      const oppSlot = idx === 0 ? r.p2 : r.p1;
      if (oppSlot && oppSlot.ws) send(oppSlot.ws, { type: 'opponent_disconnected' });
      rooms.delete(code);
    }, GRACE_MS);
  });
});

// Ping every 25 seconds — keeps connections alive through Render's proxy
// and detects dead connections that didn't send a clean close frame.
// On termination, the 'close' handler runs and starts the grace period.
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => clearInterval(pingInterval));

console.log(`Carrom server running on port ${process.env.PORT || 8080}`);
