import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GameError,
  MAX_PLAYERS,
  addPlayer,
  advanceTimer,
  applyAction,
  createPlayerId,
  createRoom,
  markInactive,
  setConnected,
  snapshot,
} from './game.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC = resolve(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();
const eventStreams = new Map();
const timerHandles = new Map();
const disconnectHandles = new Map();

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20_000) {
        reject(new GameError('Request is too large.', 413));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolveBody(body ? JSON.parse(body) : {}); }
      catch { reject(new GameError('Request must contain valid JSON.')); }
    });
    request.on('error', reject);
  });
}

function cleanName(value) {
  return String(value ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 22);
}

function generateCode() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let code = '';
    for (let index = 0; index < 6; index += 1) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new GameError('Could not reserve a room code. Try again.', 503);
}

function findRoomAndPlayer(code, token) {
  const room = rooms.get(String(code ?? '').toUpperCase());
  if (!room) throw new GameError('Room not found. Check the code and try again.', 404);
  const player = room.players[token];
  if (!player || player.removed) throw new GameError('Reconnect details are no longer valid.', 403);
  return { room, player };
}

function streamsFor(roomCode, playerId) {
  return eventStreams.get(roomCode)?.get(playerId) ?? new Set();
}

function writeEvent(response, event, data) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data).replace(/\n/g, '\\n')}\n\n`);
}

function clearRoomTimer(roomCode) {
  const handle = timerHandles.get(roomCode);
  if (handle) clearTimeout(handle);
  timerHandles.delete(roomCode);
}

function scheduleRoomTimer(room) {
  clearRoomTimer(room.code);
  if (!room.deadlineAt || !['detention', 'proposal', 'team_vote', 'mission', 'endgame'].includes(room.phase)) return;
  const handle = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (advanceTimer(room, Date.now())) {
      broadcast(room);
      scheduleRoomTimer(room);
    }
  }, Math.max(0, room.deadlineAt - Date.now()));
  handle.unref?.();
  timerHandles.set(room.code, handle);
}

function broadcast(room) {
  scheduleRoomTimer(room);
  const byPlayer = eventStreams.get(room.code);
  if (!byPlayer) return;
  for (const [playerId, responses] of byPlayer) {
    const player = room.players[playerId];
    if (!player || player.removed) {
      for (const response of responses) {
        writeEvent(response, 'removed', { message: 'The host removed you from this room.' });
        response.end();
      }
      continue;
    }
    const state = snapshot(room, playerId);
    for (const response of responses) writeEvent(response, 'state', state);
  }
}

function removeStream(room, playerId, response) {
  const byPlayer = eventStreams.get(room.code);
  const responses = byPlayer?.get(playerId);
  if (!responses) return;
  responses.delete(response);
  if (responses.size > 0) return;
  byPlayer.delete(playerId);
  if (byPlayer.size === 0) eventStreams.delete(room.code);
  const player = room.players[playerId];
  if (!rooms.has(room.code) || !player || player.removed || !player.connected) return;
  setConnected(room, playerId, false, Date.now());
  const key = `${room.code}:${playerId}`;
  const oldHandle = disconnectHandles.get(key);
  if (oldHandle) clearTimeout(oldHandle);
  const handle = setTimeout(() => {
    disconnectHandles.delete(key);
    if (!rooms.has(room.code) || streamsFor(room.code, playerId).size) return;
    const changed = markInactive(room, playerId, Date.now());
    if (changed) broadcast(room);
  }, 60_000);
  handle.unref?.();
  disconnectHandles.set(key, handle);
  broadcast(room);
}

function openEvents(request, response, url) {
  const code = String(url.searchParams.get('code') ?? '').toUpperCase();
  const token = String(url.searchParams.get('token') ?? '');
  const { room, player } = findRoomAndPlayer(code, token);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write('retry: 1500\n\n');
  let byPlayer = eventStreams.get(room.code);
  if (!byPlayer) eventStreams.set(room.code, (byPlayer = new Map()));
  let responses = byPlayer.get(player.id);
  if (!responses) byPlayer.set(player.id, (responses = new Set()));
  responses.add(response);
  const disconnectKey = `${room.code}:${player.id}`;
  const reconnectHandle = disconnectHandles.get(disconnectKey);
  if (reconnectHandle) clearTimeout(reconnectHandle);
  disconnectHandles.delete(disconnectKey);
  setConnected(room, player.id, true, Date.now());
  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write(': keepalive\n\n');
  }, 25_000);
  heartbeat.unref?.();
  response.on('close', () => {
    clearInterval(heartbeat);
    removeStream(room, player.id, response);
  });
  writeEvent(response, 'state', snapshot(room, player.id));
  broadcast(room);
}

function closeRoom(room) {
  clearRoomTimer(room.code);
  for (const [key, handle] of disconnectHandles) {
    if (key.startsWith(`${room.code}:`)) {
      clearTimeout(handle);
      disconnectHandles.delete(key);
    }
  }
  const byPlayer = eventStreams.get(room.code);
  if (byPlayer) {
    for (const responses of byPlayer.values()) {
      for (const response of responses) {
        writeEvent(response, 'room-ended', { message: 'The host closed this room.' });
        response.end();
      }
    }
    eventStreams.delete(room.code);
  }
  rooms.delete(room.code);
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { status: 'ok', rooms: rooms.size });
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
  const body = await readJson(request);

  if (url.pathname === '/api/create') {
    const name = cleanName(body.name);
    if (!name) throw new GameError('Choose a display name or codename.');
    const code = generateCode();
    const token = createPlayerId();
    const room = createRoom(code, token, name);
    rooms.set(code, room);
    return sendJson(response, 201, { code, token, name });
  }

  if (url.pathname === '/api/join') {
    const code = String(body.code ?? '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) throw new GameError('Room not found. Check the code and try again.', 404);
    const token = String(body.token ?? '');
    if (token) {
      const existing = room.players[token];
      if (existing && !existing.removed) {
        return sendJson(response, 200, { code, token, name: existing.name, rejoined: true });
      }
      throw new GameError('Reconnect details are no longer valid.', 403);
    }
    if (room.settings.visibility === 'invite' && body.invite !== room.inviteToken) {
      throw new GameError('This room is invite-only. Open the link shared by the host.', 403);
    }
    if (room.phase !== 'lobby') throw new GameError('This operation has started. Ask the host to return to the lobby.', 409);
    if (Object.values(room.players).filter((player) => !player.removed && player.active).length >= MAX_PLAYERS) {
      throw new GameError('This room is full (8 players maximum).', 409);
    }
    const name = cleanName(body.name);
    if (!name) throw new GameError('Choose a display name or codename.');
    const playerId = createPlayerId();
    addPlayer(room, playerId, name);
    broadcast(room);
    return sendJson(response, 201, { code, token: playerId, name });
  }

  if (url.pathname === '/api/action') {
    const code = String(body.code ?? '').toUpperCase();
    const token = String(body.token ?? '');
    const { room, player } = findRoomAndPlayer(code, token);
    if (body.action?.action === 'end-room') {
      if (room.hostId !== player.id) throw new GameError('Only the host can close the room.', 403);
      closeRoom(room);
      return sendJson(response, 200, { ended: true });
    }
    applyAction(room, player.id, body.action, Date.now());
    broadcast(room);
    return sendJson(response, 200, { ok: true });
  }

  return sendJson(response, 404, { error: 'Endpoint not found.' });
}

function serveStatic(request, response, url) {
  const files = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/styles.css', 'styles.css'], ['/app.js', 'app.js'], ['/favicon.svg', 'favicon.svg']]);
  const filename = files.get(url.pathname);
  if (!filename) return sendJson(response, 404, { error: 'Not found.' });
  const path = resolve(PUBLIC, filename);
  if (!existsSync(path)) return sendJson(response, 404, { error: 'App files are missing.' });
  response.writeHead(200, {
    'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
    'Cache-Control': filename === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  createReadStream(path).pipe(response);
}

export function createHttpServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/events' && request.method === 'GET') return openEvents(request, response, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
      if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'Method not allowed.' });
      return serveStatic(request, response, url);
    } catch (error) {
      const status = error instanceof GameError ? error.status : 500;
      if (!response.headersSent) sendJson(response, status, { error: error.message || 'Something went wrong.' });
      else response.end();
    }
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const server = createHttpServer();
  server.listen(port, '0.0.0.0', () => console.log(`Secret Saboteurs listening on port ${port}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
