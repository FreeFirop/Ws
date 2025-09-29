// server.js - simple WebSocket signaling and room manager
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.json()); 

// simple health route
app.get('/', (req, res) => res.send('Signaling server alive'));

// create server (so Fly can use PORT)
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/*
 Room model:
 rooms = {
   roomId: Set of ws clients
 }
 Each client will send JSON messages:
 { type: 'join', room: 'room123', username: 'Alice' }
 { type: 'offer', room: 'room123', sdp: ..., to: recipientId? }
 { type: 'answer', room: 'room123', sdp: ... }
 { type: 'ice', room: 'room123', candidate: ... }
 { type: 'leave', room: 'room123' }
 We'll include client.id assigned by server.
*/

const rooms = new Map();
const clients = new Map(); // ws -> metadata

function broadcastToRoom(roomId, data, exceptWs = null) {
  const set = rooms.get(roomId);
  if (!set) return;
  const msg = JSON.stringify(data);
  for (const client of set) {
    if (client.readyState === client.OPEN && client !== exceptWs) {
      client.send(msg);
    }
  }
}

wss.on('connection', (ws, req) => {
  ws.id = cryptoRandomId();
  clients.set(ws, { room: null, username: null });

  ws.send(JSON.stringify({ type: 'id', id: ws.id }));

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (e) { return; }
    const { type } = data;

    if (type === 'join') {
      const { room, username } = data;
      clients.get(ws).room = room;
      clients.get(ws).username = username || 'Anon';
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(ws);

      // notify existing members that a new peer joined
      broadcastToRoom(room, {
        type: 'peer-joined',
        id: ws.id,
        username: clients.get(ws).username
      }, ws);

      // send list of existing peers to this ws
      const peers = Array.from(rooms.get(room))
        .filter(s => s !== ws && s.readyState === s.OPEN)
        .map(s => ({ id: s.id, username: clients.get(s).username }));
      ws.send(JSON.stringify({ type: 'peers', peers }));

    } else if (type === 'offer' || type === 'answer' || type === 'ice') {
      // route to target if provided, else broadcast to room (except sender)
      const { room, to } = data;
      if (to) {
        // find the socket with id === to in the room
        const set = rooms.get(room);
        if (!set) return;
        for (const client of set) {
          if (client.id === to && client.readyState === client.OPEN) {
            client.send(JSON.stringify({ ...data, from: ws.id }));
            break;
          }
        }
      } else {
        broadcastToRoom(room, { ...data, from: ws.id }, ws);
      }
    } else if (type === 'leave') {
      const { room } = clients.get(ws) || {};
      leaveRoom(ws, room);
    }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    if (meta) leaveRoom(ws, meta.room);
    clients.delete(ws);
  });

  ws.on('error', () => {
    const meta = clients.get(ws);
    if (meta) leaveRoom(ws, meta.room);
    clients.delete(ws);
  });
});

function leaveRoom(ws, room) {
  if (!room) return;
  const set = rooms.get(room);
  if (!set) return;
  set.delete(ws);
  broadcastToRoom(room, { type: 'peer-left', id: ws.id });
  if (set.size === 0) rooms.delete(room);
}

function cryptoRandomId() {
  return (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 12);
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Signaling server listening on ${PORT}`));
