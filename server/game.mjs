import { randomBytes } from 'node:crypto';

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 8;
export const MAX_CHAT_LENGTH = 280;
export const TEAM_SIZES = Object.freeze({ 4: 2, 5: 3, 6: 3, 7: 4, 8: 4 });
export const REPORT_REASONS = Object.freeze(['Harassment', 'Spam', 'Inappropriate content', 'Cheating', 'Other']);
export const REACTIONS = Object.freeze(['👀', '🕵️', '🤝', '🚨', '💬']);

const OBJECTIVES = Object.freeze({
  Agent: [
    { id: 'clear-cover', title: 'Keep your cover clear', detail: 'Finish two successful missions without being detained.' },
    { id: 'trust-the-rotation', title: 'Trust the rotation', detail: 'Approve three teams that complete successful missions.' },
    { id: 'protect-the-network', title: 'Protect your network', detail: 'Join the team on two successful missions.' },
  ],
  Saboteur: [
    { id: 'accidental-chaos', title: 'Make chaos look accidental', detail: 'Sabotage a mission without being detained.' },
    { id: 'control-the-room', title: 'Control the room', detail: 'Join the proposed team on two missions.' },
    { id: 'burn-the-trail', title: 'Burn the paper trail', detail: 'Cause a mission to fail by sabotage or deadlock.' },
  ],
});

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'GameError';
    this.status = status;
  }
}

const clone = (value) => structuredClone(value);
const randToken = (bytes = 12) => randomBytes(bytes).toString('hex');
const activePlayers = (room) => Object.values(room.players).filter((player) => player.active && !player.removed);
const onlinePlayers = (room) => activePlayers(room).filter((player) => player.connected);
const playerById = (room, id) => room.players[id];

function requirePlayer(room, id) {
  const player = playerById(room, id);
  if (!player || player.removed) throw new GameError('This player is no longer in the room.', 403);
  return player;
}

function requireHost(room, id) {
  requirePlayer(room, id);
  if (room.hostId !== id) throw new GameError('Only the host can do that.', 403);
}

function requireConnected(room, id) {
  const player = requirePlayer(room, id);
  if (!player.connected || !player.active) throw new GameError('Reconnect before taking an action.', 409);
  return player;
}

function shuffle(values, random = Math.random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function nextLeader(room, currentId, eligible = onlinePlayers(room).length ? onlinePlayers(room) : activePlayers(room)) {
  if (!eligible.length) return null;
  const allIds = Object.keys(room.players);
  const start = allIds.indexOf(currentId);
  for (let step = 1; step <= allIds.length; step += 1) {
    const candidate = room.players[allIds[(start + step + allIds.length) % allIds.length]];
    if (candidate && eligible.some((player) => player.id === candidate.id)) return candidate.id;
  }
  return eligible[0].id;
}

function eligibleVoters(room) {
  return activePlayers(room).filter((player) => player.id !== room.match?.detainedId);
}

function setDeadline(room, now, seconds = room.settings.timerSeconds) {
  room.deadlineAt = now + seconds * 1000;
}

function addSystemMessage(room, text, now) {
  room.chat.push({ id: randToken(6), type: 'system', text, at: now });
  room.chat = room.chat.slice(-100);
}

function objectiveComplete(player, match) {
  const stats = player.stats;
  switch (player.objective?.id) {
    case 'clear-cover': return stats.successfulMissions >= 2 && !stats.wasDetained;
    case 'trust-the-rotation': return stats.successfulApprovals >= 3;
    case 'protect-the-network': return stats.successfulMissions >= 2;
    case 'accidental-chaos': return stats.sabotaged && !stats.wasDetained;
    case 'control-the-room': return stats.teamMissions >= 2;
    case 'burn-the-trail': return stats.causedFailure;
    default: return false;
  }
}

function tally(votes) {
  return Object.values(votes).reduce((counts, value) => {
    if (value === 'yes') counts.yes += 1;
    if (value === 'no') counts.no += 1;
    return counts;
  }, { yes: 0, no: 0 });
}

function finishMatch(room, now) {
  const match = room.match;
  room.phase = 'endgame';
  match.winner = match.successes >= 3 ? 'Agents' : 'Saboteurs';
  match.endedAt = now;
  match.commendVotes = {};
  match.commendWinnerId = null;
  match.commendationResolved = false;
  for (const player of Object.values(room.players)) {
    if (!player.investigation) continue;
    const target = room.players[player.investigation.targetId];
    player.investigation.accurate = Boolean(target?.role && target.role === player.investigation.signalRole);
  }
  for (const player of Object.values(room.players)) {
    if (!player.active || player.removed || !player.role) continue;
    player.score = (objectiveComplete(player, match) ? 3 : 0) + (player.investigation?.accurate ? 1 : 0);
    player.objectiveCompleted = objectiveComplete(player, match);
  }
  room.deadlineAt = now + 30_000;
  addSystemMessage(room, `Match over. ${match.winner} take the operation.`, now);
}

function finishMission(room, result, cause, team, sabotageCount, now) {
  const match = room.match;
  const voteTotals = tally(match.teamVotes);
  match.history.push({
    number: match.mission,
    result,
    cause,
    team: [...team],
    yesVotes: voteTotals.yes,
    noVotes: voteTotals.no,
    sabotageCount,
    rejectedProposals: match.rejectedProposals,
    at: now,
  });
  if (result === 'success') match.successes += 1;
  else match.failures += 1;
  for (const player of Object.values(room.players)) {
    if (!player.role || player.removed) continue;
    if (result === 'success' && team.includes(player.id)) player.stats.successfulMissions += 1;
    if (result === 'success' && match.teamVotes[player.id] === 'yes') player.stats.successfulApprovals += 1;
    if (team.includes(player.id)) player.stats.teamMissions += 1;
    if (result === 'failure' && player.role === 'Saboteur' && (team.includes(player.id) || cause === 'deadlock')) player.stats.causedFailure = true;
  }
  if (match.successes >= 3 || match.failures >= 3) {
    finishMatch(room, now);
    return;
  }
  const previousLeader = match.leaderId;
  match.mission += 1;
  match.rejectionStreak = 0;
  match.rejectedProposals = 0;
  match.detainedId = null;
  match.team = [];
  match.teamVotes = {};
  match.detentionVotes = {};
  match.actions = {};
  match.investigationVotes = {};
  match.leaderId = nextLeader(room, previousLeader);
  room.phase = 'detention';
  setDeadline(room, now);
  addSystemMessage(room, `Mission ${match.mission - 1} closed. Mission ${match.mission} is up.`, now);
}

function rejectProposal(room, now) {
  const match = room.match;
  match.rejectionStreak += 1;
  match.rejectedProposals += 1;
  match.team = [];
  match.teamVotes = {};
  match.leaderId = nextLeader(room, match.leaderId, onlinePlayers(room).filter((player) => player.id !== match.detainedId).length
    ? onlinePlayers(room).filter((player) => player.id !== match.detainedId)
    : activePlayers(room).filter((player) => player.id !== match.detainedId));
  addSystemMessage(room, `Team proposal rejected (${match.rejectedProposals}/3).`, now);
  if (match.rejectionStreak >= 3) {
    finishMission(room, 'failure', 'deadlock', [], 0, now);
    return;
  }
  room.phase = 'proposal';
  setDeadline(room, now);
}

function resolveDetention(room, now) {
  const match = room.match;
  const counts = new Map();
  for (const [voterId, targetId] of Object.entries(match.detentionVotes)) {
    if (!targetId || voterId === targetId) continue;
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  const max = Math.max(0, ...counts.values());
  const leaders = [...counts.entries()].filter(([, count]) => count === max && count > 0).map(([id]) => id);
  match.detainedId = leaders.length === 1 ? leaders[0] : null;
  for (const player of Object.values(room.players)) {
    if (player.id === match.detainedId) player.stats.wasDetained = true;
  }
  if (match.detainedId === match.leaderId) {
    match.leaderId = nextLeader(room, match.leaderId, onlinePlayers(room).filter((player) => player.id !== match.detainedId).length
      ? onlinePlayers(room).filter((player) => player.id !== match.detainedId)
      : activePlayers(room).filter((player) => player.id !== match.detainedId));
  }
  room.phase = 'proposal';
  setDeadline(room, now);
  const name = match.detainedId ? room.players[match.detainedId]?.name : null;
  addSystemMessage(room, name ? `${name} is detained for this mission.` : 'No one was detained.', now);
}

function resolveTeamVote(room, now) {
  const counts = tally(room.match.teamVotes);
  if (counts.yes > counts.no) {
    room.match.rejectionStreak = 0;
    room.match.rejectedProposals = 0;
    room.phase = 'mission';
    room.match.actions = {};
    setDeadline(room, now);
    addSystemMessage(room, 'Team approved. Mission actions are sealed.', now);
    return;
  }
  rejectProposal(room, now);
}

function resolveMissionActions(room, now, timedOut = false) {
  const match = room.match;
  let sabotageCount = 0;
  for (const playerId of match.team) {
    const player = room.players[playerId];
    if (!player || player.removed) continue;
    let action = match.actions[playerId];
    if (!action && timedOut) action = player.role === 'Saboteur' ? 'success' : 'success';
    if (action === 'sabotage' && player.role === 'Saboteur') {
      sabotageCount += 1;
      player.stats.sabotaged = true;
    }
  }
  const threshold = room.match.playerCount >= 7 ? 2 : 1;
  const result = sabotageCount >= threshold ? 'failure' : 'success';
  finishMission(room, result, 'mission', match.team, sabotageCount, now);
}

function allConnectedVoted(room, votes, excludeId = null) {
  return onlinePlayers(room).filter((player) => player.id !== excludeId).every((player) => Object.hasOwn(votes, player.id));
}

function ensureMatch(room) {
  if (!room.match || !['detention', 'proposal', 'team_vote', 'mission', 'endgame'].includes(room.phase)) {
    throw new GameError('There is no active match.');
  }
}

export function createRoom(code, hostId, hostName, now = Date.now()) {
  const player = {
    id: hostId, name: hostName, connected: false, active: true, removed: false, muted: false,
    role: null, objective: null, objectiveCompleted: false, score: 0, investigation: null,
    investigationTokens: 0,
    stats: { successfulMissions: 0, successfulApprovals: 0, teamMissions: 0, wasDetained: false, sabotaged: false, causedFailure: false },
  };
  return {
    code,
    inviteToken: randToken(12),
    createdAt: now,
    hostId,
    phase: 'lobby',
    deadlineAt: null,
    settings: { timerSeconds: 60, visibility: 'code' },
    players: { [hostId]: player },
    playersCount: 1,
    chat: [{ id: randToken(6), type: 'system', text: 'Room secure. Waiting on the crew.', at: now }],
    reports: [],
    match: null,
  };
}

export function addPlayer(room, playerId, name, now = Date.now()) {
  if (room.phase !== 'lobby') throw new GameError('This operation is already underway.', 409);
  if (Object.values(room.players).some((player) => player.id === playerId)) {
    throw new GameError('That reconnect code is already in use.', 409);
  }
  if (activePlayers(room).length >= MAX_PLAYERS) throw new GameError('This room is full (8 players maximum).', 409);
  const cleanName = String(name ?? '').trim().slice(0, 22);
  if (!cleanName) throw new GameError('Choose a display name or codename.');
  room.players[playerId] = {
    id: playerId, name: cleanName, connected: false, active: true, removed: false, muted: false,
    role: null, objective: null, objectiveCompleted: false, score: 0, investigation: null,
    investigationTokens: 0,
    stats: { successfulMissions: 0, successfulApprovals: 0, teamMissions: 0, wasDetained: false, sabotaged: false, causedFailure: false },
  };
  room.playersCount = activePlayers(room).length;
  addSystemMessage(room, `${cleanName} joined the lobby.`, now);
  return playerId;
}

export function setConnected(room, playerId, connected, now = Date.now()) {
  const player = requirePlayer(room, playerId);
  player.connected = Boolean(connected);
  player.lastSeen = now;
  if (connected) player.active = true;
  room.playersCount = activePlayers(room).length;
  if (!connected && room.hostId === playerId) {
    room.hostId = onlinePlayers(room).find((candidate) => candidate.id !== playerId)?.id
      ?? activePlayers(room).find((candidate) => candidate.id !== playerId)?.id
      ?? null;
  }
  if (!connected && room.match?.leaderId === playerId) room.match.leaderId = nextLeader(room, playerId);
}

export function markInactive(room, playerId, now = Date.now()) {
  const player = room.players[playerId];
  if (!player || player.removed || player.connected) return false;
  player.active = false;
  player.lastSeen = now;
  room.playersCount = activePlayers(room).length;
  if (room.hostId === playerId) {
    room.hostId = onlinePlayers(room)[0]?.id ?? activePlayers(room)[0]?.id ?? null;
  }
  if (room.match?.leaderId === playerId) room.match.leaderId = nextLeader(room, playerId);
  return true;
}

export function transferHost(room, currentHostId, targetId) {
  requireHost(room, currentHostId);
  const target = requirePlayer(room, targetId);
  if (!target.active || !target.connected) throw new GameError('Host can only move to a connected player.');
  if (targetId === currentHostId) throw new GameError('You are already the host.');
  room.hostId = targetId;
}

export function removePlayer(room, currentHostId, targetId, now = Date.now()) {
  requireHost(room, currentHostId);
  if (targetId === currentHostId) throw new GameError('Transfer host before leaving the room.');
  const target = requirePlayer(room, targetId);
  target.removed = true;
  target.active = false;
  target.connected = false;
  target.role = null;
  target.objective = null;
  room.playersCount = activePlayers(room).length;
  if (room.match?.leaderId === targetId) room.match.leaderId = nextLeader(room, targetId);
  addSystemMessage(room, `${target.name} was removed from the room.`, now);
}

export function startMatch(room, actorId, now = Date.now(), random = Math.random) {
  requireHost(room, actorId);
  if (room.phase !== 'lobby') throw new GameError('Return to the lobby before starting another match.', 409);
  const participants = onlinePlayers(room);
  if (participants.length < MIN_PLAYERS) throw new GameError('At least 4 players must be connected to start.');
  if (participants.length > MAX_PLAYERS) throw new GameError('This room supports up to 8 players.');
  room.playersCount = participants.length;
  for (const player of Object.values(room.players)) {
    player.role = null;
    player.objective = null;
    player.objectiveCompleted = false;
    player.score = 0;
    player.investigation = null;
    player.investigationTokens = 0;
    player.stats = { successfulMissions: 0, successfulApprovals: 0, teamMissions: 0, wasDetained: false, sabotaged: false, causedFailure: false };
  }
  const saboteurCount = participants.length >= 6 ? 2 : 1;
  const deck = shuffle(participants, random);
  for (let index = 0; index < deck.length; index += 1) {
    const player = deck[index];
    player.role = index < saboteurCount ? 'Saboteur' : 'Agent';
    const choices = OBJECTIVES[player.role];
    player.objective = clone(choices[Math.floor(random() * choices.length)]);
    player.investigationTokens = 1;
  }
  room.match = {
    mission: 1,
    playerCount: participants.length,
    successes: 0,
    failures: 0,
    saboteurCount,
    leaderId: participants[0].id,
    detainedId: null,
    team: [],
    detentionVotes: {},
    teamVotes: {},
    actions: {},
    rejectionStreak: 0,
    rejectedProposals: 0,
    history: [],
    winner: null,
    commendVotes: {},
    commendWinnerId: null,
    commendationResolved: false,
  };
  room.phase = 'detention';
  setDeadline(room, now);
  addSystemMessage(room, 'Operation begins. Roles are sealed; check your briefing.', now);
}

export function returnToLobby(room, actorId, now = Date.now()) {
  requireHost(room, actorId);
  if (room.phase !== 'endgame') throw new GameError('The operation has not ended.');
  room.phase = 'lobby';
  room.match = null;
  room.deadlineAt = null;
  room.chat = room.chat.filter((message) => message.type === 'system' && message.text.includes('joined the lobby'));
  for (const player of Object.values(room.players)) {
    player.role = null;
    player.objective = null;
    player.objectiveCompleted = false;
    player.score = 0;
    player.investigation = null;
    player.investigationTokens = 0;
    player.stats = { successfulMissions: 0, successfulApprovals: 0, teamMissions: 0, wasDetained: false, sabotaged: false, causedFailure: false };
  }
  addSystemMessage(room, 'Back in the lobby. The next operation will get a fresh deal.', now);
}

export function applyAction(room, actorId, input, now = Date.now(), random = Math.random) {
  const actor = requireConnected(room, actorId);
  const action = input?.action;
  if (!action || typeof action !== 'string') throw new GameError('Choose a valid action.');

  if (action === 'start') return startMatch(room, actorId, now, random);
  if (action === 'return-to-lobby') return returnToLobby(room, actorId, now);
  if (action === 'rematch') {
    requireHost(room, actorId);
    if (room.phase !== 'endgame') throw new GameError('The operation has not ended.');
    returnToLobby(room, actorId, now);
    if (onlinePlayers(room).length >= MIN_PLAYERS) startMatch(room, actorId, now, random);
    return;
  }
  if (action === 'transfer-host') return transferHost(room, actorId, input.targetId);
  if (action === 'remove-player') return removePlayer(room, actorId, input.targetId, now);
  if (action === 'settings') {
    requireHost(room, actorId);
    if (room.phase !== 'lobby') throw new GameError('Room settings can only change in the lobby.', 409);
    if (![60, 90, 120].includes(Number(input.timerSeconds))) throw new GameError('Choose a 60, 90, or 120 second timer.');
    if (!['code', 'invite'].includes(input.visibility)) throw new GameError('Choose a private room access setting.');
    room.settings = { timerSeconds: Number(input.timerSeconds), visibility: input.visibility };
    return;
  }
  if (action === 'mute') {
    requireHost(room, actorId);
    const target = requirePlayer(room, input.targetId);
    if (target.id === actorId) throw new GameError('You cannot mute yourself.');
    target.muted = !target.muted;
    addSystemMessage(room, `${target.name} was ${target.muted ? 'muted' : 'unmuted'} by the host.`, now);
    return;
  }
  if (action === 'report') {
    const target = requirePlayer(room, input.targetId);
    if (target.id === actorId) throw new GameError('Choose another player to report.');
    if (!REPORT_REASONS.includes(input.reason)) throw new GameError('Choose a report reason.');
    room.reports.push({ id: randToken(6), reporterId: actorId, reporterName: actor.name, targetId: target.id, targetName: target.name, reason: input.reason, at: now });
    room.reports = room.reports.slice(-50);
    return;
  }
  if (action === 'chat') {
    if (actor.muted) throw new GameError('The host has muted chat for this player.', 403);
    const text = String(input.text ?? '').trim().slice(0, MAX_CHAT_LENGTH);
    if (!text) throw new GameError('Write a message first.');
    room.chat.push({ id: randToken(6), type: 'chat', playerId: actorId, name: actor.name, text, at: now });
    room.chat = room.chat.slice(-100);
    return;
  }
  if (action === 'reaction') {
    if (actor.muted) throw new GameError('The host has muted chat for this player.', 403);
    if (!REACTIONS.includes(input.reaction)) throw new GameError('That reaction is not available.');
    room.chat.push({ id: randToken(6), type: 'reaction', playerId: actorId, name: actor.name, text: input.reaction, at: now });
    room.chat = room.chat.slice(-100);
    return;
  }
  if (action === 'accuse') {
    if (actor.muted) throw new GameError('The host has muted chat for this player.', 403);
    const target = requirePlayer(room, input.targetId);
    if (target.id === actorId) throw new GameError('Choose another player.');
    const text = String(input.text ?? '').trim().slice(0, 120);
    if (!text) throw new GameError('Add a short reason to the accusation card.');
    room.chat.push({ id: randToken(6), type: 'accusation', playerId: actorId, name: actor.name, targetId: target.id, targetName: target.name, text, at: now });
    room.chat = room.chat.slice(-100);
    return;
  }

  ensureMatch(room);
  if (action === 'detention-vote') {
    if (room.phase !== 'detention') throw new GameError('The detention vote is closed.', 409);
    const targetId = input.targetId || null;
    if (targetId) {
      const target = requirePlayer(room, targetId);
      if (target.id === actorId) throw new GameError('Choose another player or vote to detain nobody.');
    }
    room.match.detentionVotes[actorId] = targetId;
    if (allConnectedVoted(room, room.match.detentionVotes)) resolveDetention(room, now);
    return;
  }
  if (action === 'propose-team') {
    if (room.phase !== 'proposal') throw new GameError('A team cannot be proposed right now.', 409);
    if (actorId !== room.match.leaderId) throw new GameError('Only the mission leader can propose the team.', 403);
    if (actorId === room.match.detainedId) throw new GameError('The detained player cannot lead this mission.', 403);
    const ids = Array.isArray(input.team) ? [...new Set(input.team)] : [];
    if (ids.length !== TEAM_SIZES[room.match.playerCount]) throw new GameError(`Choose exactly ${TEAM_SIZES[room.match.playerCount]} players.`);
    for (const id of ids) {
      const player = requirePlayer(room, id);
      if (!player.active || id === room.match.detainedId) throw new GameError('The team must contain active players who are not detained.');
    }
    room.match.team = ids;
    room.match.teamVotes = {};
    room.phase = 'team_vote';
    setDeadline(room, now);
    addSystemMessage(room, `${actor.name} submitted a team for approval.`, now);
    return;
  }
  if (action === 'team-vote') {
    if (room.phase !== 'team_vote') throw new GameError('The team vote is closed.', 409);
    if (actorId === room.match.detainedId) throw new GameError('The detained player cannot vote this mission.', 403);
    if (!['yes', 'no'].includes(input.vote)) throw new GameError('Choose approve or reject.');
    room.match.teamVotes[actorId] = input.vote;
    if (allConnectedVoted(room, room.match.teamVotes, room.match.detainedId)) resolveTeamVote(room, now);
    return;
  }
  if (action === 'mission-action') {
    if (room.phase !== 'mission') throw new GameError('Mission actions are not open.', 409);
    if (!room.match.team.includes(actorId)) throw new GameError('Only the proposed team can act on the mission.', 403);
    if (Object.hasOwn(room.match.actions, actorId)) throw new GameError('Your mission action is already sealed.', 409);
    const choice = input.choice;
    if (!['success', 'sabotage'].includes(choice)) throw new GameError('Choose a mission action.');
    if (choice === 'sabotage' && actor.role !== 'Saboteur') throw new GameError('Agents cannot submit sabotage.', 403);
    room.match.actions[actorId] = choice;
    const connectedTeam = room.match.team.filter((id) => room.players[id]?.connected && !room.players[id]?.removed);
    if (connectedTeam.every((id) => Object.hasOwn(room.match.actions, id))) resolveMissionActions(room, now);
    return;
  }
  if (action === 'investigate') {
    if (!['detention', 'proposal', 'team_vote', 'mission'].includes(room.phase)) throw new GameError('Investigations are only available during an operation.', 409);
    if (actor.investigationTokens < 1) throw new GameError('Your investigation token has already been used.', 409);
    const target = requirePlayer(room, input.targetId);
    if (target.id === actorId) throw new GameError('Investigate another player.');
    if (!target.active || !target.role) throw new GameError('That player is not active in the operation.');
    const signalRole = random() < 0.7 ? target.role : (target.role === 'Agent' ? 'Saboteur' : 'Agent');
    actor.investigationTokens -= 1;
    actor.investigation = { targetId: target.id, targetName: target.name, signalRole, accurate: null, at: now };
    return;
  }
  if (action === 'commend') {
    if (room.phase !== 'endgame' || room.match.commendationResolved) throw new GameError('Commendations are closed.', 409);
    const target = requirePlayer(room, input.targetId);
    if (target.id === actorId) throw new GameError('Choose another player to commend.');
    room.match.commendVotes[actorId] = target.id;
    if (onlinePlayers(room).every((player) => Object.hasOwn(room.match.commendVotes, player.id))) resolveCommendations(room);
    return;
  }
  throw new GameError('That action is not available.');
}

export function resolveCommendations(room) {
  if (!room.match || room.phase !== 'endgame' || room.match.commendationResolved) return;
  const counts = new Map();
  for (const targetId of Object.values(room.match.commendVotes)) counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  const max = Math.max(0, ...counts.values());
  const leaders = [...counts.entries()].filter(([, count]) => count === max && count > 0).map(([id]) => id);
  room.match.commendWinnerId = leaders.length === 1 ? leaders[0] : null;
  room.match.commendationResolved = true;
  if (room.match.commendWinnerId) room.players[room.match.commendWinnerId].score += 1;
  room.deadlineAt = null;
}

export function advanceTimer(room, now = Date.now()) {
  if (!room.deadlineAt || now < room.deadlineAt) return false;
  if (room.phase === 'detention') resolveDetention(room, now);
  else if (room.phase === 'proposal') rejectProposal(room, now);
  else if (room.phase === 'team_vote') resolveTeamVote(room, now);
  else if (room.phase === 'mission') resolveMissionActions(room, now, true);
  else if (room.phase === 'endgame') resolveCommendations(room);
  else return false;
  return true;
}

function playerView(room, player, viewerId, reveal) {
  return {
    id: player.id,
    name: player.name,
    connected: player.connected,
    active: player.active,
    removed: player.removed,
    muted: player.muted,
    isHost: room.hostId === player.id,
    detained: room.match?.detainedId === player.id,
    role: reveal ? player.role : (player.id === viewerId ? player.role : null),
    objective: reveal ? player.objective : (player.id === viewerId ? player.objective : null),
    objectiveCompleted: reveal ? Boolean(player.objectiveCompleted) : null,
    score: reveal ? player.score : 0,
    investigationUsed: reveal || player.id === viewerId ? player.investigationTokens === 0 : null,
    investigation: player.id === viewerId ? clone(player.investigation) : null,
  };
}

export function snapshot(room, viewerId) {
  const viewer = room.players[viewerId];
  if (!viewer || viewer.removed) throw new GameError('This player is not in the room.', 403);
  const reveal = room.phase === 'endgame';
  const match = room.match ? {
    mission: room.match.mission,
    playerCount: room.match.playerCount,
    successes: room.match.successes,
    failures: room.match.failures,
    saboteurCount: room.match.saboteurCount,
    leaderId: room.match.leaderId,
    detainedId: room.match.detainedId,
    team: [...room.match.team],
    rejectedProposals: room.match.rejectedProposals,
    rejectionStreak: room.match.rejectionStreak,
    history: clone(room.match.history),
    winner: reveal ? room.match.winner : null,
    teamVoteCounts: tally(room.match.teamVotes),
    detentionVoteCount: Object.keys(room.match.detentionVotes).length,
    teamVoteCount: Object.keys(room.match.teamVotes).length,
    actionCount: Object.keys(room.match.actions).length,
    hasDetentionVoted: Object.hasOwn(room.match.detentionVotes, viewerId),
    hasTeamVoted: Object.hasOwn(room.match.teamVotes, viewerId),
    hasMissionActed: Object.hasOwn(room.match.actions, viewerId),
    commendVoteCount: Object.keys(room.match.commendVotes).length,
    commendationResolved: room.match.commendationResolved,
    commendWinnerId: room.match.commendWinnerId,
    hasCommended: Object.hasOwn(room.match.commendVotes, viewerId),
    commendVotes: reveal ? clone(room.match.commendVotes) : {},
  } : null;
  return {
    code: room.code,
    inviteToken: viewerId === room.hostId && room.phase === 'lobby' ? room.inviteToken : null,
    phase: room.phase,
    hostId: room.hostId,
    settings: clone(room.settings),
    deadlineAt: room.deadlineAt,
    players: Object.values(room.players).filter((player) => !player.removed).map((player) => playerView(room, player, viewerId, reveal)),
    chat: clone(room.chat.slice(-70)),
    reports: viewerId === room.hostId ? clone(room.reports) : [],
    match,
    you: {
      id: viewerId,
      role: viewer.role,
      objective: clone(viewer.objective),
      score: viewer.score,
      investigationTokens: viewer.investigationTokens,
      investigation: clone(viewer.investigation),
    },
  };
}

export function createPlayerId() {
  return randToken(18);
}
