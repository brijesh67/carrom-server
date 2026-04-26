'use strict';

const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

const rooms = new Map(); // code → { p1: ws, p2: ws | null }

function makeCode() {
  return Math.random().toString(36).substr(2, 4).toUpperCase();
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function opponent(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  return ws.playerIndex === 0 ? room.p2 : room.p1;
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
        rooms.set(code, { p1: ws, p2: null });
        ws.roomCode    = code;
        ws.playerIndex = 0;
        send(ws, { type: 'room_created', code, player: 0 });
        break;
      }
      case 'join_room': {
        const code = (msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room)   { send(ws, { type: 'error', message: 'Room not found' }); break; }
        if (room.p2) { send(ws, { type: 'error', message: 'Room is full'   }); break; }
        room.p2        = ws;
        ws.roomCode    = code;
        ws.playerIndex = 1;
        send(ws,      { type: 'room_joined',     player: 1 });
        send(room.p1, { type: 'opponent_joined' });
        break;
      }
      case 'shot':
      case 'new_round':
      case 'placing':
        send(opponent(ws), msg);
        break;
    }
  });

  ws.on('close', () => {
    send(opponent(ws), { type: 'opponent_disconnected' });
    rooms.delete(ws.roomCode);
  });
});

// Ping every 25 seconds — keeps connections alive through Render's proxy
// and detects dead connections that didn't send a clean close frame
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      // No pong since last ping — connection is dead, terminate it
      send(opponent(ws), { type: 'opponent_disconnected' });
      rooms.delete(ws.roomCode);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => clearInterval(pingInterval));

console.log(`Carrom server running on port ${process.env.PORT || 8080}`);
