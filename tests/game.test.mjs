import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GameError,
  TEAM_SIZES,
  addPlayer,
  advanceTimer,
  applyAction,
  createRoom,
  markInactive,
  setConnected,
  snapshot,
  startMatch,
} from '../server/game.mjs';

function makeMatch(count = 4) {
  const now = 1_000;
  const room = createRoom('ABC234', 'p1', 'NIGHT OWL', now);
  for (let index = 2; index <= count; index += 1) addPlayer(room, `p${index}`, `OPERATIVE ${index}`, now);
  for (let index = 1; index <= count; index += 1) setConnected(room, `p${index}`, true, now);
  startMatch(room, 'p1', now, () => 0.41);
  return room;
}

function voteDetainNobody(room, now = 2_000) {
  for (const player of Object.values(room.players)) {
    if (player.active && player.connected) applyAction(room, player.id, { action: 'detention-vote', targetId: null }, now);
  }
}

function approveTeam(room, team, now = 3_000) {
  applyAction(room, room.match.leaderId, { action: 'propose-team', team }, now);
  for (const player of Object.values(room.players)) {
    if (player.active && player.connected && player.id !== room.match.detainedId) {
      applyAction(room, player.id, { action: 'team-vote', vote: 'yes' }, now);
    }
  }
}

function rejectOneProposal(room, now) {
  voteDetainNobody(room, now);
  const team = Object.keys(room.players).slice(0, TEAM_SIZES[room.match.playerCount]);
  for (let rejection = 0; rejection < 1; rejection += 1) {
    applyAction(room, room.match.leaderId, { action: 'propose-team', team }, now);
    for (const player of Object.values(room.players)) {
      if (player.active && player.connected && player.id !== room.match.detainedId) {
        applyAction(room, player.id, { action: 'team-vote', vote: 'no' }, now);
      }
    }
  }
}

test('role counts follow the player brackets and other roles stay sealed', () => {
  const four = makeMatch(4);
  const eight = makeMatch(8);
  assert.equal(Object.values(four.players).filter((player) => player.role === 'Saboteur').length, 1);
  assert.equal(Object.values(eight.players).filter((player) => player.role === 'Saboteur').length, 2);

  const privateView = snapshot(eight, 'p1');
  assert.equal(privateView.players.find((player) => player.id === 'p1').role, eight.players.p1.role);
  assert.ok(privateView.players.filter((player) => player.id !== 'p1').every((player) => player.role === null));
  assert.ok(privateView.players.filter((player) => player.id !== 'p1').every((player) => player.objective === null));
  assert.equal(Object.hasOwn(privateView.match, 'actions'), false);
});

test('mission team sizes are fixed for each player count', () => {
  assert.deepEqual(TEAM_SIZES, { 4: 2, 5: 3, 6: 3, 7: 4, 8: 4 });
  assert.equal(Object.values(makeMatch(5).players).filter((player) => player.role === 'Saboteur').length, 1);
  assert.equal(Object.values(makeMatch(6).players).filter((player) => player.role === 'Saboteur').length, 2);
});

test('one sabotage action fails a 4-player mission', () => {
  const room = makeMatch(4);
  voteDetainNobody(room);
  const saboteur = Object.values(room.players).find((player) => player.role === 'Saboteur');
  const agent = Object.values(room.players).find((player) => player.role === 'Agent');
  approveTeam(room, [saboteur.id, agent.id], 3_000);
  applyAction(room, saboteur.id, { action: 'mission-action', choice: 'sabotage' }, 4_000);
  applyAction(room, agent.id, { action: 'mission-action', choice: 'success' }, 4_000);
  assert.equal(room.match.history[0].sabotageCount, 1);
  assert.equal(room.match.history[0].result, 'failure');
});

test('a tied detention vote detains nobody', () => {
  const room = makeMatch(4);
  applyAction(room, 'p1', { action: 'detention-vote', targetId: 'p2' }, 2_000);
  applyAction(room, 'p2', { action: 'detention-vote', targetId: 'p1' }, 2_000);
  applyAction(room, 'p3', { action: 'detention-vote', targetId: null }, 2_000);
  applyAction(room, 'p4', { action: 'detention-vote', targetId: null }, 2_000);
  assert.equal(room.phase, 'proposal');
  assert.equal(room.match.detainedId, null);
});

test('three rejected team proposals become a mission failure', () => {
  const room = makeMatch(4);
  voteDetainNobody(room);
  for (let rejection = 1; rejection <= 3; rejection += 1) {
    const team = Object.keys(room.players).slice(0, 2);
    applyAction(room, room.match.leaderId, { action: 'propose-team', team }, 2_100 + rejection);
    for (const player of Object.values(room.players)) {
      if (player.active && player.connected && player.id !== room.match.detainedId) {
        applyAction(room, player.id, { action: 'team-vote', vote: 'no' }, 2_200 + rejection);
      }
    }
  }
  assert.equal(room.match.failures, 1);
  assert.equal(room.match.history[0].cause, 'deadlock');
  assert.equal(room.match.history[0].rejectedProposals, 3);
  assert.equal(room.match.mission, 2);
  assert.equal(room.phase, 'detention');
});

test('two sabotage actions are required to fail a 7-player mission', () => {
  const room = makeMatch(7);
  voteDetainNobody(room);
  const saboteurs = Object.values(room.players).filter((player) => player.role === 'Saboteur').map((player) => player.id);
  const agents = Object.values(room.players).filter((player) => player.role === 'Agent').map((player) => player.id);
  const team = [saboteurs[0], saboteurs[1], agents[0], agents[1]];
  approveTeam(room, team, 3_000);
  for (const id of team) {
    applyAction(room, id, { action: 'mission-action', choice: room.players[id].role === 'Saboteur' ? 'sabotage' : 'success' }, 4_000);
  }
  assert.equal(room.match.history[0].sabotageCount, 2);
  assert.equal(room.match.history[0].result, 'failure');
});

test('an Agent cannot submit sabotage', () => {
  const room = makeMatch(4);
  voteDetainNobody(room);
  const agents = Object.values(room.players).filter((player) => player.role === 'Agent').map((player) => player.id);
  const team = agents.slice(0, 2);
  approveTeam(room, team, 3_000);
  assert.throws(() => applyAction(room, team[0], { action: 'mission-action', choice: 'sabotage' }, 4_000), GameError);
});

test('mission timeout resolves missing Saboteur actions without sabotage', () => {
  const room = makeMatch(4);
  voteDetainNobody(room);
  const saboteur = Object.values(room.players).find((player) => player.role === 'Saboteur');
  const agent = Object.values(room.players).find((player) => player.role === 'Agent');
  approveTeam(room, [saboteur.id, agent.id], 3_000);
  assert.equal(room.phase, 'mission');
  assert.equal(advanceTimer(room, room.deadlineAt), true);
  assert.equal(room.match.history[0].result, 'success');
  assert.equal(room.match.history[0].sabotageCount, 0);
});

test('investigation reads are private and score only after the target role is revealed', () => {
  const room = makeMatch(4);
  const investigator = room.players.p1;
  const subject = Object.values(room.players).find((player) => player.role === 'Saboteur');
  applyAction(room, investigator.id, { action: 'investigate', targetId: subject.id }, 1_500, () => 0.3);
  assert.ok(investigator.investigation);
  assert.equal(snapshot(room, subject.id).players.find((player) => player.id === investigator.id).investigation, null);
});

test('disconnect preserves role and immediately transfers host', () => {
  const room = makeMatch(4);
  const role = room.players.p1.role;
  setConnected(room, 'p1', false, 1_500);
  assert.equal(room.players.p1.active, true);
  assert.equal(room.players.p1.role, role);
  assert.equal(room.hostId, 'p2');
  assert.equal(room.match.leaderId, 'p2');
  markInactive(room, 'p1', 61_500);
  assert.equal(room.players.p1.active, false);
  assert.equal(room.players.p1.role, role);
});

test('rematch returns the same roster to a fresh operation with new secret state', () => {
  const room = makeMatch(4);
  let now = 2_000;
  while (room.phase !== 'endgame') {
    voteDetainNobody(room, now++);
    for (let proposal = 0; proposal < 3; proposal += 1) {
      const team = Object.keys(room.players).slice(0, 2);
      applyAction(room, room.match.leaderId, { action: 'propose-team', team }, now++);
      for (const player of Object.values(room.players)) {
        if (player.active && player.connected && player.id !== room.match.detainedId) {
          applyAction(room, player.id, { action: 'team-vote', vote: 'no' }, now++);
        }
      }
      if (room.phase === 'endgame' || room.phase === 'detention') break;
    }
  }
  applyAction(room, room.hostId, { action: 'rematch' }, now++);
  assert.equal(room.phase, 'detention');
  assert.equal(room.match.history.length, 0);
  assert.equal(room.match.successes, 0);
  assert.equal(room.match.failures, 0);
  assert.equal(Object.values(room.players).filter((player) => player.role === 'Saboteur').length, 1);
  assert.ok(Object.values(room.players).every((player) => player.investigationTokens === 1 && player.objective));
});

