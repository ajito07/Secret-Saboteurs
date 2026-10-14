import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../server/http.mjs';

async function readState(connection, predicate = () => true) {
  while (true) {
    const event = await connection.nextEvent();
    if (event.name === 'state' && predicate(event.data)) return event.data;
  }
}

function eventConnection(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    reader,
    async nextEvent() {
      while (true) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary >= 0) {
          const block = buffered.slice(0, boundary).replace(/\r/g, '');
          buffered = buffered.slice(boundary + 2);
          const name = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (name && data) return { name, data: JSON.parse(data) };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('Event stream closed before the expected update.');
        buffered += decoder.decode(value, { stream: true });
      }
    },
  };
}

test('separate event streams receive private role snapshots after match start', async (context) => {
  const server = createHttpServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const connections = [];
  context.after(async () => {
    await Promise.all(connections.map((connection) => connection.reader.cancel().catch(() => {})));
    await new Promise((resolveClose) => server.close(resolveClose));
  });

  const homeResponse = await fetch(`${base}/`);
  assert.equal(homeResponse.status, 200);
  assert.match(await homeResponse.text(), /Secret Saboteurs — The mission is classified/);
  const appResponse = await fetch(`${base}/app.js`);
  assert.equal(appResponse.status, 200);
  assert.match(await appResponse.text(), /THE BETRAYAL IS PERSONAL/);
  const healthResponse = await fetch(`${base}/api/health`);
  assert.deepEqual(await healthResponse.json(), { status: 'ok', rooms: 0 });

  const createResponse = await fetch(`${base}/api/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'NIGHT OWL' }) });
  assert.equal(createResponse.status, 201);
  const host = await createResponse.json();
  const sessions = [host];
  const hostStreamResponse = await fetch(`${base}/events?code=${host.code}&token=${host.token}`);
  const hostConnection = eventConnection(hostStreamResponse);
  connections.push(hostConnection);
  const hostView = await readState(hostConnection, (state) => state.phase === 'lobby' && Boolean(state.inviteToken));
  const settingsResponse = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: host.code, token: host.token, action: { action: 'settings', timerSeconds: 90, visibility: 'invite' } }) });
  assert.equal(settingsResponse.status, 200);
  const codeOnlyResponse = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: host.code, name: 'CODE ONLY' }) });
  assert.equal(codeOnlyResponse.status, 403);
  for (const name of ['VELVET FOX', 'GHOST SIGNAL', 'SILVER LYNX']) {
    const response = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: host.code, name, invite: hostView.inviteToken }) });
    assert.equal(response.status, 201);
    sessions.push(await response.json());
  }

  for (const session of sessions.slice(1)) {
    const response = await fetch(`${base}/events?code=${session.code}&token=${session.token}`);
    assert.equal(response.status, 200);
    connections.push(eventConnection(response));
    await readState(connections.at(-1), (state) => state.players.length === sessions.length);
  }

  const startResponse = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: host.code, token: host.token, action: { action: 'start' } }) });
  assert.equal(startResponse.status, 200);
  const views = await Promise.all(connections.map((connection) => readState(connection, (state) => state.phase === 'detention')));
  const roles = views.map((view) => view.players.find((player) => player.id === view.you.id)?.role);
  assert.equal(roles.filter((role) => role === 'Saboteur').length, 1);
  for (const view of views) {
    assert.equal(view.players.find((player) => player.id === view.you.id)?.role, view.you.role);
    assert.ok(view.players.filter((player) => player.id !== view.you.id).every((player) => player.role === null));
    assert.ok(view.players.filter((player) => player.id !== view.you.id).every((player) => player.objective === null));
    assert.equal(view.inviteToken, null);
  }
});
