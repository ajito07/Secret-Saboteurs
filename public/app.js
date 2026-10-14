const app = document.querySelector('#app');
const modalRoot = document.querySelector('#modal-root');
const toastRoot = document.querySelector('#toast-root');
const SESSION_KEY = 'secret-saboteurs-session';
const NAME_KEY = 'secret-saboteurs-name';
const CODE_NAMES = ['NIGHT OWL', 'VELVET FOX', 'GHOST SIGNAL', 'SILVER LYNX', 'STATIC BLOOM', 'CAPTAIN NOIR', 'CIPHER KID', 'LASER LARK'];
const REACTIONS = ['👀', '🕵️', '🤝', '🚨', '💬'];
const state = { session: null, room: null, stream: null, networkUp: false, soundOn: localStorage.getItem('ss-sound') !== 'off', selectedTeam: new Set(), selectionKey: '', sending: false, chatDraft: '', briefingOpen: false, briefingStep: 0 };
let ambience = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function codename() { return CODE_NAMES[Math.floor(Math.random() * CODE_NAMES.length)]; }
function nameValue() { return localStorage.getItem(NAME_KEY) || codename(); }
function playerById(id) { return state.room?.players.find((player) => player.id === id); }
function isMe(player) { return player.id === state.session?.token; }
function isHost() { return state.room?.hostId === state.session?.token; }
function connectedCount() { return state.room?.players.filter((player) => player.active && player.connected).length || 0; }
function timerText() {
  if (!state.room?.deadlineAt) return '';
  return `${Math.max(0, Math.ceil((state.room.deadlineAt - Date.now()) / 1000))}s`;
}

async function api(path, payload) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'The secure channel could not complete that action.');
  return result;
}

function toast(message, type = 'info') {
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.textContent = message;
  toastRoot.append(item);
  setTimeout(() => item.remove(), 3300);
}

function tone(kind = 'tap') {
  if (!state.soundOn) return;
  startAmbience();
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    const context = new Audio();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(kind === 'alarm' ? 640 : kind === 'success' ? 780 : 480, now);
    oscillator.frequency.exponentialRampToValueAtTime(kind === 'alarm' ? 330 : 920, now + 0.1);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(kind === 'alarm' ? 0.075 : 0.045, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.19);
    oscillator.onended = () => context.close();
  } catch { /* Audio is an optional flourish. */ }
}

function startAmbience() {
  if (!state.soundOn || ambience) return;
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  try {
    const context = new Audio();
    const master = context.createGain();
    master.gain.setValueAtTime(0.005, context.currentTime);
    master.connect(context.destination);
    const notes = [110, 164.81, 220];
    const oscillators = notes.map((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.value = index === 0 ? 0.42 : 0.19;
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start();
      return oscillator;
    });
    ambience = { context, master, oscillators };
  } catch { ambience = null; }
}

function stopAmbience() {
  if (!ambience) return;
  const current = ambience;
  ambience = null;
  try {
    current.master.gain.setTargetAtTime(0.0001, current.context.currentTime, 0.04);
    setTimeout(() => current.context.close().catch(() => {}), 300);
  } catch { current.context.close().catch(() => {}); }
}

function updateSoundButton() {
  const button = document.querySelector('.sound-toggle');
  if (!button) return;
  button.innerHTML = `${state.soundOn ? '♫' : '♪'} <span>Sound ${state.soundOn ? 'on' : 'off'}</span>`;
  button.setAttribute('aria-label', `Sound ${state.soundOn ? 'on' : 'off'}`);
}

function setSession(session) {
  state.session = session;
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  localStorage.setItem(NAME_KEY, session.name);
  if (state.stream) state.stream.close();
  const source = new EventSource(`/events?code=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.token)}`);
  state.stream = source;
  source.addEventListener('state', (event) => {
    const oldPhase = state.room?.phase;
    const oldWinner = state.room?.match?.winner;
    state.room = JSON.parse(event.data);
    state.networkUp = true;
    if (oldPhase !== state.room.phase && state.room.phase === 'mission') tone('tap');
    if (oldPhase !== 'endgame' && state.room.phase === 'endgame') tone('success');
    render();
    if (oldWinner !== state.room.match?.winner && state.room.phase === 'endgame') tone('success');
    if (state.room.phase === 'lobby' && !localStorage.getItem('ss-briefing-seen')) showBriefing();
  });
  source.addEventListener('removed', () => {
    clearSession();
    toast('The host removed you from the room.', 'error');
  });
  source.addEventListener('room-ended', () => {
    clearSession();
    toast('The host closed the room.', 'info');
  });
  source.onerror = () => {
    state.networkUp = false;
    render();
  };
  render();
}

function clearSession() {
  state.stream?.close();
  state.stream = null;
  state.session = null;
  state.room = null;
  state.networkUp = false;
  state.selectedTeam.clear();
  localStorage.removeItem(SESSION_KEY);
  modalRoot.innerHTML = '';
  render();
}

async function boot() {
  updateSoundButton();
  document.addEventListener('click', handleClick);
  document.addEventListener('submit', handleSubmit);
  document.addEventListener('input', handleInput);
  window.addEventListener('online', () => toast('Secure channel restored.', 'success'));
  const saved = localStorage.getItem(SESSION_KEY);
  if (saved) {
    try {
      const session = JSON.parse(saved);
      const returned = await api('/api/join', { code: session.code, token: session.token });
      setSession({ ...session, ...returned });
      return;
    } catch (error) {
      localStorage.removeItem(SESSION_KEY);
      if (!String(error.message).includes('Room not found')) toast('Your last room is no longer available. Join or create another.', 'info');
    }
  }
  render();
}

function homeView() {
  const params = new URLSearchParams(location.search);
  const suggestedCode = params.get('room') || '';
  const suggestedInvite = params.get('invite') || '';
  const roomFromLink = Boolean(suggestedCode);
  return `
    <section class="home-layout">
      <div class="hero-copy">
        <div class="eyebrow"><span class="eyebrow-line"></span> A SOCIAL DEDUCTION OPERATION</div>
        <h1>TRUST IS<br><em>YOUR COVER.</em></h1>
        <p class="tagline">THE MISSION IS CLASSIFIED.<br><strong>THE BETRAYAL IS PERSONAL.</strong></p>
        <div class="hero-dossier">
          <div class="dossier-stamp">TOP<br>SECRET</div>
          <div><span class="tiny-label">FIELD BRIEF // 001</span><p>Build a team. Earn the crew's trust.<br>And catch the Saboteurs in the act.</p></div>
        </div>
        <div class="hero-meta"><span>4—8 OPERATIVES</span><span>NO INSTALL</span><span>ONE BAD APPLE?</span></div>
      </div>
      <div class="entry-card panel">
        <div class="panel-topline"><span>SECURE ENTRY</span><span class="status-live"><i></i> OPEN CHANNEL</span></div>
        <h2>Get in the room.</h2>
        <p class="muted">No accounts. No downloads. Just your crew and a code.</p>
        <form id="create-form" class="entry-form">
          <label for="create-name">YOUR FIELD NAME</label>
          <div class="name-entry"><input id="create-name" name="name" maxlength="22" autocomplete="nickname" value="${esc(nameValue())}" placeholder="Pick a codename" required><button class="reroll-button" type="button" data-action="codename" aria-label="Generate a codename">⟳</button></div>
          <button class="button button-primary button-wide" type="submit"><span>+</span> Create a private room</button>
        </form>
        <div class="form-divider"><span>OR JOIN YOUR CREW</span></div>
        <form id="join-form" class="entry-form">
          <label for="join-name">YOUR FIELD NAME</label>
          <input id="join-name" name="name" maxlength="22" autocomplete="nickname" value="${esc(nameValue())}" placeholder="Pick a codename" required>
          <label for="room-code">ROOM CODE</label>
          <input id="room-code" name="code" class="code-input" maxlength="6" autocomplete="off" value="${esc(suggestedCode)}" placeholder="E.G. 7KQ9MX" required>
          <button class="button button-secondary button-wide" type="submit">Join room <span>↗</span></button>
        </form>
        <div class="entry-foot"><span>🔒 PRIVATE ROOMS</span><span>ROOM CODE REQUIRED</span></div>
      </div>
    </section>
    <section class="home-bottom">
      <div class="how-card"><span class="number-tag">01</span><div><b>Pick your side.</b><span>Roles are dealt in secret.</span></div></div>
      <div class="how-card"><span class="number-tag">02</span><div><b>Build a crew.</b><span>Every vote changes the mission.</span></div></div>
      <div class="how-card"><span class="number-tag">03</span><div><b>Read the room.</b><span>One wrong call can sink it all.</span></div></div>
    </section>
    ${roomFromLink ? `<p class="link-code-hint">${suggestedInvite ? `Invite received for room <b>${esc(suggestedCode.toUpperCase())}</b>. Enter your field name to join.` : `Room <b>${esc(suggestedCode.toUpperCase())}</b> is ready. Enter your field name to join.`}</p>` : ''}
  `;
}

function phaseLabel(phase) {
  return ({ lobby: 'READY ROOM', detention: 'DETENTION VOTE', proposal: 'TEAM PROPOSAL', team_vote: 'TEAM APPROVAL', mission: 'MISSION LIVE', endgame: 'OPERATION COMPLETE' })[phase] || 'FIELD STATUS';
}

function avatar(player, index = 0) {
  const initials = player.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '??';
  return `<span class="avatar avatar-${index % 6}">${esc(initials)}</span>`;
}

function inviteControl(room) {
  if (room.settings.visibility === 'invite' && !isHost()) return '<span class="link-button invite-host-only">Invite link held by host</span>';
  return '<button class="link-button" data-action="copy-invite">Copy invite link ↗</button>';
}

function playerCard(player, index, room) {
  const me = isMe(player);
  const match = room.match;
  const canInvestigate = match && !['endgame', 'lobby'].includes(room.phase) && room.you.investigationTokens > 0 && !me && player.active;
  const canDetain = room.phase === 'detention' && !room.match.hasDetentionVoted && !me && player.active;
  const canSelect = room.phase === 'proposal' && room.match.leaderId === room.you.id && player.active && player.id !== room.match.detainedId;
  const selected = state.selectedTeam.has(player.id);
  const role = player.role ? `<span class="role-pill ${player.role === 'Saboteur' ? 'role-bad' : 'role-good'}">${player.role === 'Saboteur' ? '☠' : '✦'} ${esc(player.role)}</span>` : '<span class="sealed-pill">IDENTITY SEALED</span>';
  const status = !player.active ? '<span class="status-offline">INACTIVE</span>' : !player.connected ? '<span class="status-offline">RECONNECTING</span>' : player.detained ? '<span class="status-detained">DETAINED</span>' : '';
  const hostBadge = player.isHost ? '<span class="host-badge">HOST</span>' : '';
  const teamBadge = match?.team.includes(player.id) ? '<span class="team-badge">ON TEAM</span>' : '';
  const controls = [];
  if (canDetain) controls.push(`<button class="mini-action mini-alert" data-action="vote-detain" data-target="${esc(player.id)}">Detain</button>`);
  if (canSelect) controls.push(`<button class="mini-action ${selected ? 'mini-selected' : ''}" data-action="select-team" data-target="${esc(player.id)}">${selected ? 'Selected ✓' : 'Add to team'}</button>`);
  if (canInvestigate && player.id !== room.match.detainedId) controls.push(`<button class="mini-action" data-action="investigate" data-target="${esc(player.id)}">⌕ Investigate</button>`);
  if (match && !['endgame', 'lobby'].includes(room.phase) && !me) controls.push(`<button class="mini-action mini-muted" data-action="accuse" data-target="${esc(player.id)}">+ Accuse</button><button class="mini-action mini-muted" data-action="report" data-target="${esc(player.id)}">Report</button>`);
  if (isHost() && !me) {
    controls.push(`<button class="mini-action mini-muted" data-action="mute" data-target="${esc(player.id)}">${player.muted ? 'Unmute' : 'Mute'}</button>`);
    controls.push(`<button class="mini-action mini-muted" data-action="transfer" data-target="${esc(player.id)}">Make host</button>`);
    controls.push(`<button class="mini-action mini-danger" data-action="remove" data-target="${esc(player.id)}">Remove</button>`);
  }
  return `<article class="player-card ${me ? 'is-me' : ''} ${selected ? 'is-selected' : ''} ${player.detained ? 'is-detained' : ''}">
    ${avatar(player, index)}
    <div class="player-info"><div class="player-name-line"><b>${esc(player.name)}${me ? ' <small>(YOU)</small>' : ''}</b>${hostBadge}${teamBadge}</div><div class="player-role-line">${role}${player.muted ? '<span class="muted-dot">CHAT MUTED</span>' : ''}${status}</div></div>
    ${controls.length ? `<div class="player-actions">${controls.join('')}</div>` : ''}
  </article>`;
}

function lobbyView(room) {
  const players = room.players;
  const enoughPlayers = connectedCount() >= 4;
  return `
    <section class="room-topline"><div><span class="eyebrow"><span class="eyebrow-line"></span> READY ROOM</span><h1 class="room-title">THE CREW <em>ASSEMBLES.</em></h1></div><div class="room-code-box"><span class="tiny-label">ROOM CODE</span><button class="room-code" data-action="copy-code" title="Copy room code">${esc(room.code)} <span>▣</span></button>${inviteControl(room)}</div></section>
    <div class="lobby-grid">
      <section class="panel crew-panel">
        <div class="panel-topline"><span>OPERATIVES <b>${connectedCount()}</b> / 8</span><span class="status-live"><i></i> ${state.networkUp ? 'SYNCED' : 'RECONNECTING'}</span></div>
        <div class="player-list">${players.map((player, index) => playerCard(player, index, room)).join('')}</div>
        <div class="invite-note"><span class="note-icon">↗</span><span>Send your crew the room code. Up to 8 agents can join.</span></div>
        ${isHost() ? `<div class="host-settings"><div class="settings-heading"><span class="tiny-label">HOST CONTROLS</span><span class="tiny-label">CORE RULES LOCKED</span></div><label class="setting-row"><span><b>Discussion timer</b><small>Voting and mission action deadlines</small></span><select id="timer-setting" aria-label="Discussion timer"><option value="60" ${room.settings.timerSeconds === 60 ? 'selected' : ''}>60 seconds</option><option value="90" ${room.settings.timerSeconds === 90 ? 'selected' : ''}>90 seconds</option><option value="120" ${room.settings.timerSeconds === 120 ? 'selected' : ''}>120 seconds</option></select></label><label class="setting-row"><span><b>Room access</b><small>Every room stays private</small></span><select id="access-setting" aria-label="Room access"><option value="code" ${room.settings.visibility === 'code' ? 'selected' : ''}>Join by code</option><option value="invite" ${room.settings.visibility === 'invite' ? 'selected' : ''}>Invite link only</option></select></label><button class="button button-tertiary button-wide" data-action="save-settings">Save room settings</button></div>` : `<div class="waiting-host"><span class="lock-icon">⌑</span><span>Waiting for <b>${esc(playerById(room.hostId)?.name || 'the host')}</b> to launch the operation.</span></div>`}
        <div class="lobby-footer-controls"><button class="link-button" data-action="briefing">Open field briefing</button><button class="link-button danger-link" data-action="leave">Leave room</button>${isHost() ? '<button class="link-button danger-link" data-action="end-room">End room</button>' : ''}</div>
      </section>
      <aside class="panel rules-panel">
        <div class="panel-topline"><span>FIELD MANUAL</span><span class="manual-stamp">CLASSIFIED</span></div>
        <div class="rules-intro"><div class="target-mark">◎</div><div><span class="tiny-label">YOUR OBJECTIVE</span><h2>Find the leak.<br>Save the operation.</h2></div></div>
        <div class="rule-row"><span class="rule-number">01</span><p><b>Agents</b> need 3 successful missions before 3 failures.</p></div>
        <div class="rule-row"><span class="rule-number rule-pink">02</span><p><b>Saboteurs</b> secretly fail missions and win at 3 failures.</p></div>
        <div class="rule-row"><span class="rule-number">03</span><p>Choose teams carefully. Three rejected proposals count as a failure.</p></div>
        <div class="rule-row"><span class="rule-number rule-pink">04</span><p>At 7–8 players, two sabotage actions are needed to fail a mission.</p></div>
        <button class="button button-primary button-wide start-button ${enoughPlayers && isHost() ? '' : 'is-disabled'}" data-action="start" ${enoughPlayers && isHost() ? '' : 'disabled'}>${isHost() ? (enoughPlayers ? 'Start the operation' : 'Need at least 4 players') : 'Host will start the operation'} <span>↗</span></button>
        <p class="start-footnote">${enoughPlayers ? `${connectedCount()} connected operatives. Roles are dealt at launch.` : `${Math.max(0, 4 - connectedCount())} more operative${4 - connectedCount() === 1 ? '' : 's'} needed to begin.`}</p>
      </aside>
    </div>
    <section class="panel room-chat-panel"><div class="panel-topline"><span>ROOM CHANNEL</span><span class="tiny-label">FIELD CHAT IS ALWAYS OPEN</span></div>${chatView(room, true)}</section>
  `;
}

function historyView(room) {
  if (!room.match?.history.length) return '<div class="history-empty"><span>◎</span><b>No completed missions yet.</b><small>Every public clue will be filed here.</small></div>';
  return `<div class="mission-history-list">${room.match.history.map((record) => {
    const teamNames = record.team.map((id) => playerById(id)?.name || 'Unknown operative').join(', ');
    const result = record.result === 'success' ? 'MISSION SUCCESS' : record.cause === 'deadlock' ? 'PROPOSAL DEADLOCK' : 'MISSION FAILED';
    const recordTitle = record.result === 'success' ? 'Success' : 'Failure';
    return `<details class="history-card"><summary><span class="history-number">M${String(record.number).padStart(2, '0')}</span><span class="history-result ${record.result === 'success' ? 'text-good' : 'text-bad'}">${recordTitle}</span><span class="history-track">${esc(result)}</span><span class="history-chevron">⌄</span></summary><div class="history-details"><div><small>MISSION TEAM</small><b>${esc(teamNames || 'No team approved')}</b></div><div><small>PUBLIC EVIDENCE</small><b>${record.cause === 'deadlock' ? 'Three proposals were rejected.' : `${record.sabotageCount} anonymous sabotage action${record.sabotageCount === 1 ? '' : 's'} filed.`}</b></div><div><small>TEAM VOTE</small><b>${record.yesVotes} approve / ${record.noVotes} reject${record.rejectedProposals ? ` · ${record.rejectedProposals} rejected proposal${record.rejectedProposals === 1 ? '' : 's'}` : ''}</b></div></div></details>`;
  }).join('')}</div>`;
}

function chatView(room, compact = false) {
  const messages = room.chat.slice(-45);
  return `<div class="chat-shell ${compact ? 'chat-compact' : ''}">
    <div class="chat-feed" id="chat-feed">${messages.map((message) => {
      if (message.type === 'system') return `<div class="chat-system"><span>✦</span>${esc(message.text)}</div>`;
      if (message.type === 'reaction') return `<div class="chat-reaction">${avatar(playerById(message.playerId) || { name: message.name }, 2)}<b>${esc(message.name)}</b><span class="reaction-bubble">${esc(message.text)}</span></div>`;
      if (message.type === 'accusation') return `<div class="chat-accusation"><div class="accusation-title">⚑ ACCUSATION FILED</div><p><b>${esc(message.name)}</b> flagged <b>${esc(message.targetName)}</b>: ${esc(message.text)}</p></div>`;
      return `<div class="chat-message">${avatar(playerById(message.playerId) || { name: message.name }, 1)}<div><div class="chat-author">${esc(message.name)} <time>${new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>${esc(message.text)}</p></div></div>`;
    }).join('') || '<div class="chat-system"><span>✦</span>Channel open. Make first contact.</div>'}</div>
    <div class="reaction-row">${REACTIONS.map((reaction) => `<button type="button" data-action="reaction" data-reaction="${esc(reaction)}" aria-label="React ${esc(reaction)}">${esc(reaction)}</button>`).join('')}<span class="tiny-label">QUICK REACTIONS</span></div>
    <form id="chat-form" class="chat-compose"><input id="chat-input" name="text" maxlength="280" placeholder="Send a secure message…" autocomplete="off" ${playerById(room.you.id)?.muted ? 'disabled' : ''}><button type="submit" aria-label="Send message" ${playerById(room.you.id)?.muted ? 'disabled' : ''}>↗</button></form>
    ${playerById(room.you.id)?.muted ? '<div class="muted-notice">The host has muted chat for this player.</div>' : ''}
  </div>`;
}

function investigationCard(room) {
  const investigation = room.you.investigation;
  if (!investigation) return `<div class="investigation-card"><div class="investigation-icon">⌕</div><div><span class="tiny-label">PRIVATE INVESTIGATION</span><b>${room.you.investigationTokens ? 'One token in your pocket.' : 'Token expended.'}</b><small>Pick a suspect to request a noisy, private field read.</small></div><span class="token-count">${room.you.investigationTokens} / 1</span></div>`;
  const word = investigation.signalRole === 'Saboteur' ? 'SUSPICIOUS' : 'LOW RISK';
  return `<div class="investigation-card investigation-result"><div class="investigation-icon">⌕</div><div><span class="tiny-label">PRIVATE FIELD READ // ${esc(investigation.targetName)}</span><b>${word}: signals lean ${esc(investigation.signalRole)}.</b><small>Intel is noisy. Your read may be wrong; only you can see this file.</small></div><span class="confidential-mark">PRIVATE</span></div>`;
}

function phaseContent(room) {
  const match = room.match;
  const me = room.you.id;
  const detained = match.detainedId === me;
  if (room.phase === 'detention') {
    if (detained) return `<div class="phase-instruction"><span class="phase-index">00</span><div><h3>You are detained for this mission.</h3><p>You can read and react in chat. Your next chance to vote is the next mission.</p></div></div>`;
    if (match.hasDetentionVoted) return `<div class="phase-instruction"><span class="phase-index">00</span><div><h3>Vote sealed.</h3><p>Waiting on the crew. A tie means nobody is detained.</p></div><span class="timer-badge" data-countdown>${timerText()}</span></div>`;
    return `<div class="phase-instruction"><span class="phase-index">00</span><div><h3>Choose who sits out this mission.</h3><p>Tap Detain on a player card, or vote for nobody.</p></div><span class="timer-badge" data-countdown>${timerText()}</span></div><button class="button button-secondary button-wide" data-action="detain-none">Vote: detain nobody</button>`;
  }
  if (room.phase === 'proposal') {
    const leader = playerById(match.leaderId);
    if (me === match.leaderId) return `<div class="phase-instruction"><span class="phase-index">01</span><div><h3>Build the mission team.</h3><p>Select exactly ${match.playerCount <= 4 ? 2 : match.playerCount <= 6 ? 3 : 4} active operatives, then send the proposal to a vote.</p></div><span class="timer-badge" data-countdown>${timerText()}</span></div><div class="proposal-status">${state.selectedTeam.size} SELECTED <span>·</span> ${room.players.filter((player) => player.active && !player.detained).length} AVAILABLE</div><button class="button button-primary button-wide" data-action="propose-team" ${state.selectedTeam.size !== (match.playerCount <= 4 ? 2 : match.playerCount <= 6 ? 3 : 4) ? 'disabled' : ''}>Submit team for a vote <span>↗</span></button>${match.rejectedProposals ? `<div class="rejection-warning">⚠ ${match.rejectedProposals} of 3 proposals rejected — the third rejection fails this mission.</div>` : ''}`;
    return `<div class="phase-instruction"><span class="phase-index">01</span><div><h3>Waiting on ${esc(leader?.name || 'the leader')} to propose.</h3><p>${match.rejectedProposals ? `${match.rejectedProposals} proposal${match.rejectedProposals === 1 ? '' : 's'} rejected. Three rejections mean mission failure.` : 'Use chat to make your case before the team is selected.'}</p></div><span class="timer-badge" data-countdown>${timerText()}</span></div>`;
  }
  if (room.phase === 'team_vote') {
    const names = match.team.map((id) => playerById(id)?.name || 'Unknown').join(' · ');
    if (detained) return `<div class="phase-instruction"><span class="phase-index">02</span><div><h3>Team submitted.</h3><p>${esc(names)}. You are detained and cannot vote this mission.</p></div></div>`;
    if (match.hasTeamVoted) return `<div class="phase-instruction"><span class="phase-index">02</span><div><h3>Your vote is sealed.</h3><p>${esc(names)}. Waiting for the other votes.</p></div><span class="timer-badge" data-countdown>${timerText()}</span></div>`;
    return `<div class="phase-instruction"><span class="phase-index">02</span><div><h3>Approve this team?</h3><p>${esc(names)}. A tie rejects the proposal.</p></div><span class="timer-badge" data-countdown>${timerText()}</span></div><div class="vote-buttons"><button class="button button-approve" data-action="team-vote" data-vote="yes">✓ Approve</button><button class="button button-reject" data-action="team-vote" data-vote="no">× Reject</button></div>`;
  }
  if (room.phase === 'mission') {
    const onTeam = match.team.includes(me);
    if (!onTeam) return `<div class="phase-instruction"><span class="phase-index">03</span><div><h3>Mission team is in the field.</h3><p>Wait for their sealed actions. Your read may be useful next.</p></div><span class="timer-badge" data-countdown>${timerText()}</span></div>`;
    if (match.hasMissionActed) return `<div class="phase-instruction"><span class="phase-index">03</span><div><h3>Action received.</h3><p>Your choice is sealed. The operation resolves when every operative submits.</p></div><span class="timer-badge" data-countdown>${timerText()}</span></div>`;
    const sabotageAllowed = room.you.role === 'Saboteur';
    return `<div class="phase-instruction"><span class="phase-index">03</span><div><h3>Choose your mission action.</h3><p>Other team members will not see your choice.</p></div><span class="timer-badge" data-countdown>${timerText()}</span></div><div class="vote-buttons"><button class="button button-approve" data-action="mission-action" data-choice="success">✓ Secure success</button>${sabotageAllowed ? '<button class="button button-sabotage" data-action="mission-action" data-choice="sabotage">☠ Sabotage</button>' : ''}</div>`;
  }
  if (room.phase === 'endgame') {
    if (!match.commendationResolved) {
      if (match.hasCommended) return `<div class="phase-instruction"><span class="phase-index">✦</span><div><h3>Commendation vote sealed.</h3><p>The crew is choosing one clever operator for a +1 bonus.</p></div><span class="timer-badge" data-countdown>${timerText()}</span></div>`;
      return `<div class="phase-instruction"><span class="phase-index">✦</span><div><h3>Recognize one clever operator.</h3><p>Your commendation earns one bonus point. Ties earn no point.</p></div><span class="timer-badge" data-countdown>${timerText()}</span></div><div class="commendation-choices">${room.players.filter((player) => player.id !== me).map((player) => `<button class="mini-action" data-action="commend" data-target="${esc(player.id)}">✦ ${esc(player.name)}</button>`).join('')}</div>`;
    }
    return `<div class="phase-instruction"><span class="phase-index">✦</span><div><h3>${match.commendWinnerId ? `${esc(playerById(match.commendWinnerId)?.name || 'Operative')} earned the commendation.` : 'No commendation awarded.'}</h3><p>Team victory and individual bonus rankings are scored separately.</p></div></div>`;
  }
  return '';
}

function investigationPeople(room) {
  if (!room.match || ['endgame', 'lobby'].includes(room.phase) || !room.you.investigationTokens) return '';
  return `<div class="investigation-targets"><span class="tiny-label">CHOOSE A SUBJECT</span><div>${room.players.filter((player) => player.id !== room.you.id && player.active && player.id !== room.match.detainedId).map((player) => `<button class="mini-action" data-action="investigate" data-target="${esc(player.id)}">⌕ ${esc(player.name)}</button>`).join('')}</div></div>`;
}

function gameView(room) {
  const match = room.match;
  const missionNum = String(match.mission).padStart(2, '0');
  const teamSize = match.playerCount <= 4 ? 2 : match.playerCount <= 6 ? 3 : 4;
  const isEndgame = room.phase === 'endgame';
  const successPct = Math.round((match.successes / 3) * 100);
  const failurePct = Math.round((match.failures / 3) * 100);
  const teamText = match.team.length ? match.team.map((id) => playerById(id)?.name || 'Unknown').join(', ') : 'Awaiting proposal';
  const intro = isEndgame ? `<div class="result-banner ${match.winner === 'Agents' ? 'result-good' : 'result-bad'}"><div class="result-symbol">${match.winner === 'Agents' ? '✦' : '☠'}</div><div><span class="eyebrow">OPERATION COMPLETE</span><h1>${match.winner === 'Agents' ? 'THE CREW HELD.' : 'THE COVER IS BLOWN.'}</h1><p>${match.winner === 'Agents' ? 'Agents secured three successful missions.' : 'Saboteurs pushed the operation to three failures.'}</p></div><div class="winner-stamp">${esc(match.winner)} WIN</div></div>` : '';
  const investigation = investigationCard(room);
  const historyCount = match.history.length;
  const latestEvent = match.history.at(-1);
  const objective = room.you.objective;
  return `
    ${intro}
    <section class="game-heading"><div><span class="eyebrow"><span class="eyebrow-line"></span> ${phaseLabel(room.phase)}</span><h1 class="room-title">OPERATION <em>${missionNum}</em></h1></div><div class="game-heading-right"><div class="room-chip"><span>ROOM</span><b>${esc(room.code)}</b>${room.settings.visibility === 'invite' && !isHost() ? '<span title="Ask the host for the private invite">🔒</span>' : '<button data-action="copy-invite" aria-label="Copy invite">▣</button>'}</div><div class="sync-indicator ${state.networkUp ? '' : 'sync-off'}"><i></i>${state.networkUp ? 'LIVE SYNC' : 'RECONNECTING'}</div></div></section>
    <section class="scoreboard panel"><div class="score-side score-agent"><div class="score-label"><span>✦</span> AGENTS</div><div class="score-track"><span style="width:${successPct}%"></span></div><b>${match.successes}<small> / 3 SUCCESS</small></b></div><div class="score-divider"><span>VS</span></div><div class="score-side score-saboteur"><div class="score-label"><span>☠</span> SABOTEURS</div><div class="score-track"><span style="width:${failurePct}%"></span></div><b>${match.failures}<small> / 3 FAILURES</small></b></div></section>
    <div class="game-layout">
      <div class="game-main-column">
        <section class="panel phase-panel">
          <div class="panel-topline"><span>${room.phase === 'endgame' ? 'FINAL TRANSMISSION' : `MISSION ${missionNum} // ${phaseLabel(room.phase)}`}</span>${!isEndgame ? `<span class="mission-count">${historyCount} / 5 FILED</span>` : '<span class="manual-stamp">DECLASSIFIED</span>'}</div>
          ${phaseContent(room)}
          ${room.phase === 'proposal' && match.leaderId === room.you.id ? `<div class="leader-banner">◈ YOU ARE TEAM LEADER</div>` : ''}
          ${room.phase === 'team_vote' || room.phase === 'mission' ? `<div class="current-team"><span class="tiny-label">FIELD TEAM</span><b>${esc(teamText)}</b><small>${match.team.length} / ${teamSize} operatives selected · Leader: ${esc(playerById(match.leaderId)?.name || 'Unknown')}</small></div>` : room.phase === 'detention' ? `<div class="current-team"><span class="tiny-label">MISSION LEADER</span><b>${esc(playerById(match.leaderId)?.name || 'Unknown')}</b><small>Team of ${teamSize} · ${match.playerCount >= 7 ? 'Two sabotage actions fail the mission' : 'One sabotage action fails the mission'}</small></div>` : ''}
          ${room.phase === 'endgame' ? `<div class="endgame-controls">${isHost() ? '<button class="button button-primary" data-action="rematch">Rematch ↗</button><button class="button button-secondary" data-action="return-lobby">Return to Lobby</button>' : '<p class="muted">The host controls rematch and lobby.</p>'}</div>` : ''}
          ${room.phase !== 'endgame' ? `<div class="mission-context"><div class="context-item"><span class="tiny-label">YOUR ROLE</span><b class="${room.you.role === 'Saboteur' ? 'text-bad' : 'text-good'}">${room.you.role === 'Saboteur' ? '☠ SABOTEUR' : '✦ AGENT'}</b></div><div class="context-item"><span class="tiny-label">SECRET OBJECTIVE</span><b>${esc(objective?.title || 'Classified')}</b><small>${esc(objective?.detail || '')}</small></div><div class="context-item"><span class="tiny-label">CURRENT LEADER</span><b>${esc(playerById(match.leaderId)?.name || 'Unknown')}</b></div></div>` : ''}
          ${investigation}
          ${investigationPeople(room)}
        </section>
        <section class="panel operatives-panel"><div class="panel-topline"><span>OPERATIVE ROSTER <b>${connectedCount()}</b> / ${room.players.length}</span><span class="tiny-label">${match.saboteurCount} SABOTEUR${match.saboteurCount === 1 ? '' : 'S'} IN THE ROOM</span></div><div class="player-list game-player-list">${room.players.map((player, index) => playerCard(player, index, room)).join('')}</div></section>
        ${isEndgame ? `<section class="panel bonus-panel"><div class="panel-topline"><span>BONUS RANKINGS</span><span class="tiny-label">TEAM RESULT SCORED SEPARATELY</span></div><div class="bonus-table"><div class="bonus-head"><span>OPERATIVE</span><span>ROLE</span><span>SECRET OBJECTIVE</span><span>BONUS</span></div>${[...room.players].sort((a, b) => b.score - a.score).map((player, index) => `<div class="bonus-row"><span>${avatar(player, index)}<b>${esc(player.name)}</b></span><span class="${player.role === 'Saboteur' ? 'text-bad' : 'text-good'}">${esc(player.role)}</span><span>${esc(player.objective?.title || '—')}${player.objectiveCompleted ? ' ✓' : ' · incomplete'}</span><b>${player.score}</b></div>`).join('')}</div></section>` : ''}
      </div>
      <aside class="game-sidebar">
        <section class="panel side-panel"><div class="panel-topline"><span>MISSION HISTORY</span><span class="tiny-label">PUBLIC EVIDENCE</span></div>${historyView(room)}</section>
        <section class="panel side-panel live-chat-panel"><div class="panel-topline"><span>SECURE CHANNEL</span><span class="status-live"><i></i> LIVE</span></div>${chatView(room)}</section>
        ${isHost() && room.reports?.length ? `<section class="panel side-panel reports-panel"><div class="panel-topline"><span>PLAYER REPORTS</span><span class="tiny-label">HOST ONLY · ${room.reports.length}</span></div>${room.reports.map((report) => `<div class="report-row"><b>${esc(report.targetName)}</b><span>${esc(report.reason)}</span><small>Filed by ${esc(report.reporterName)}</small></div>`).join('')}</section>` : ''}
        <div class="utility-links">${isHost() ? '<button class="link-button danger-link" data-action="end-room">End room</button>' : ''}<button class="link-button danger-link" data-action="leave">Leave room</button><button class="link-button" data-action="briefing">Field briefing</button></div>
      </aside>
    </div>
  `;
}

function render() {
  if (!state.room || !state.session) {
    app.innerHTML = homeView();
    updateSoundButton();
    return;
  }
  const room = state.room;
  const focused = document.activeElement?.id;
  const chatValue = document.querySelector('#chat-input')?.value ?? state.chatDraft;
  const chatFeed = document.querySelector('#chat-feed');
  const nearBottom = chatFeed ? chatFeed.scrollHeight - chatFeed.scrollTop - chatFeed.clientHeight < 80 : true;
  const scrollTop = chatFeed?.scrollTop || 0;
  const phaseKey = `${room.phase}:${room.match?.mission || 0}:${room.match?.leaderId || ''}`;
  if (phaseKey !== state.selectionKey) {
    state.selectedTeam.clear();
    state.selectionKey = phaseKey;
  }
  app.innerHTML = room.phase === 'lobby' ? lobbyView(room) : gameView(room);
  const newChat = document.querySelector('#chat-input');
  if (newChat) {
    newChat.value = chatValue;
    if (focused === 'chat-input') newChat.focus({ preventScroll: true });
  }
  const newFeed = document.querySelector('#chat-feed');
  if (newFeed) newFeed.scrollTop = nearBottom ? newFeed.scrollHeight : scrollTop;
  updateSoundButton();
}

async function perform(action) {
  if (state.sending) return false;
  state.sending = true;
  try {
    const result = await api('/api/action', { code: state.session.code, token: state.session.token, action });
    if (result.ended) clearSession();
    tone(action.action === 'team-vote' || action.action === 'mission-action' ? 'tap' : 'tap');
    return true;
  } catch (error) {
    toast(error.message, 'error');
    return false;
  } finally {
    state.sending = false;
  }
}

function showModal(content) {
  modalRoot.innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true">${content}</section></div>`;
  modalRoot.querySelector('input,select,button')?.focus();
}

function closeModal() { modalRoot.innerHTML = ''; }

function showBriefing() {
  if (state.briefingOpen) return;
  state.briefingOpen = true;
  state.briefingStep = 0;
  renderBriefingStep();
}

function renderBriefingStep() {
  const steps = [
    { title: 'Know your cover.', copy: 'Each operative receives a secret role and a private objective. Agents need three successful missions. Saboteurs need three failures.', badge: '01 — THE BRIEF' },
    { title: 'Build a team.', copy: 'Vote to detain one operative for this mission. Then the leader proposes a team; everyone eligible votes. A tie rejects it.', badge: '02 — THE VOTE' },
    { title: 'Seal the mission.', copy: 'The selected crew acts in secret. Agents secure success. Saboteurs may sabotage. Three rejected teams also count as a failure.', badge: '03 — THE FIELD' },
  ];
  const step = steps[state.briefingStep];
  const final = state.briefingStep === steps.length - 1;
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true"><div class="modal-label"><span class="eyebrow-line"></span> FIELD BRIEFING // ${String(state.briefingStep + 1).padStart(2, '0')}</div><div class="briefing-art"><span class="briefing-stamp">TOP<br>SECRET</span><div class="briefing-target">${state.briefingStep === 0 ? '◉' : state.briefingStep === 1 ? '⌖' : '◎'}</div><div class="briefing-lines"><i></i><i></i><i></i></div></div><div class="tutorial-progress">${steps.map((_, index) => `<i class="${index <= state.briefingStep ? 'complete' : ''}"></i>`).join('')}</div><div class="tutorial-step-label">${step.badge}</div><h2>${step.title}</h2><p class="modal-copy">${step.copy}</p><button class="button button-primary button-wide" data-action="briefing-next">${final ? 'Enter the operation ↗' : 'Next briefing ↗'}</button><button class="link-button modal-skip" data-action="close-briefing">Skip tutorial</button></section></div>`;
}

function showReport(targetId, accuse = false) {
  const target = playerById(targetId);
  if (!target) return;
  if (accuse) {
    showModal(`<div class="modal-label"><span class="eyebrow-line"></span> ACCUSATION CARD</div><h2>Put ${esc(target.name)} on the board.</h2><p class="modal-copy">Make your case in the secure channel. Accusations are public; hidden roles stay sealed.</p><form id="accuse-form" data-target="${esc(targetId)}"><label for="accuse-text">YOUR READ</label><textarea id="accuse-text" name="text" maxlength="120" placeholder="What looks suspicious?" required></textarea><button class="button button-alert button-wide" type="submit">File accusation ↗</button><button class="link-button modal-skip" type="button" data-action="close-modal">Cancel</button></form>`);
    return;
  }
  showModal(`<div class="modal-label"><span class="eyebrow-line"></span> PRIVATE PLAYER REPORT</div><h2>Report ${esc(target.name)}.</h2><p class="modal-copy">The host receives this report privately. Choose the closest reason.</p><form id="report-form" data-target="${esc(targetId)}"><label for="report-reason">REPORT REASON</label><select id="report-reason" name="reason"><option>Harassment</option><option>Spam</option><option>Inappropriate content</option><option>Cheating</option><option>Other</option></select><button class="button button-alert button-wide" type="submit">Send private report ↗</button><button class="link-button modal-skip" type="button" data-action="close-modal">Cancel</button></form>`);
}

async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (state.soundOn) startAmbience();
  const data = new FormData(form);
  try {
    if (form.id === 'create-form') {
      const name = String(data.get('name') || '').trim();
      const result = await api('/api/create', { name });
      setSession({ ...result });
      history.replaceState({}, '', `/?room=${encodeURIComponent(result.code)}`);
      toast(`Room ${result.code} created. Invite your crew.`, 'success');
      return;
    }
    if (form.id === 'join-form') {
      const name = String(data.get('name') || '').trim();
      const code = String(data.get('code') || '').trim().toUpperCase();
      const invite = new URLSearchParams(location.search).get('invite') || '';
      const result = await api('/api/join', { name, code, invite });
      setSession({ ...result });
      history.replaceState({}, '', `/?room=${encodeURIComponent(result.code)}`);
      toast(`Connected to room ${result.code}.`, 'success');
      return;
    }
    if (form.id === 'chat-form') {
      const text = String(data.get('text') || '').trim();
      if (!text) return;
      state.chatDraft = '';
      form.elements.text.value = '';
      await perform({ action: 'chat', text });
      return;
    }
    if (form.id === 'accuse-form') {
      if (!await perform({ action: 'accuse', targetId: form.dataset.target, text: String(data.get('text') || '').trim() })) return;
      closeModal();
      toast('Accusation card filed.', 'success');
      return;
    }
    if (form.id === 'report-form') {
      if (!await perform({ action: 'report', targetId: form.dataset.target, reason: data.get('reason') })) return;
      closeModal();
      toast('Private report sent to the host.', 'success');
    }
  } catch (error) { toast(error.message, 'error'); }
}

function handleInput(event) {
  if (event.target?.id === 'chat-input') state.chatDraft = event.target.value;
  if (event.target?.id === 'room-code') event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

async function handleClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (state.soundOn) startAmbience();
  const action = button.dataset.action;
  const targetId = button.dataset.target;
  if (action === 'modal-backdrop' && event.target === button) return closeModal();
  if (action === 'close-modal') return closeModal();
  if (action === 'close-briefing') {
    state.briefingOpen = false;
    localStorage.setItem('ss-briefing-seen', '1');
    closeModal();
    return;
  }
  if (action === 'briefing-next') {
    if (state.briefingStep < 2) {
      state.briefingStep += 1;
      renderBriefingStep();
    } else {
      state.briefingOpen = false;
      localStorage.setItem('ss-briefing-seen', '1');
      closeModal();
    }
    return;
  }
  if (action === 'briefing') return showBriefing();
  if (action === 'codename') {
    const input = button.closest('form')?.querySelector('input[name="name"]');
    if (input) input.value = codename();
    return;
  }
  if (action === 'sound') {
    state.soundOn = !state.soundOn;
    localStorage.setItem('ss-sound', state.soundOn ? 'on' : 'off');
    if (state.soundOn) startAmbience();
    else stopAmbience();
    updateSoundButton();
    tone('tap');
    return;
  }
  if (action === 'copy-code') {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(state.room.code);
      toast('Room code copied.', 'success');
    } catch { toast(`Room code: ${state.room.code}`, 'info'); }
    return;
  }
  if (action === 'copy-invite') {
    const invite = `${location.origin}/?room=${encodeURIComponent(state.room.code)}${state.room.inviteToken ? `&invite=${encodeURIComponent(state.room.inviteToken)}` : ''}`;
    try { await navigator.clipboard.writeText(invite); toast('Invite link copied.', 'success'); }
    catch { toast(invite, 'info'); }
    return;
  }
  if (action === 'leave') {
    if (confirm('Leave this room? You can reconnect with the same browser during the grace period.')) clearSession();
    return;
  }
  if (action === 'end-room') {
    if (confirm('Close this room for everyone?')) await perform({ action: 'end-room' });
    return;
  }
  if (action === 'start') return perform({ action: 'start' });
  if (action === 'detain-none') return perform({ action: 'detention-vote', targetId: null });
  if (action === 'vote-detain') return perform({ action: 'detention-vote', targetId });
  if (action === 'select-team') {
    const size = state.room.match.playerCount <= 4 ? 2 : state.room.match.playerCount <= 6 ? 3 : 4;
    if (state.selectedTeam.has(targetId)) state.selectedTeam.delete(targetId);
    else if (state.selectedTeam.size < size) state.selectedTeam.add(targetId);
    else return toast(`Choose exactly ${size} operatives.`, 'info');
    render();
    return;
  }
  if (action === 'propose-team') return perform({ action: 'propose-team', team: [...state.selectedTeam] });
  if (action === 'team-vote') return perform({ action: 'team-vote', vote: button.dataset.vote });
  if (action === 'mission-action') return perform({ action: 'mission-action', choice: button.dataset.choice });
  if (action === 'investigate') {
    if (confirm(`Use your one investigation token on ${playerById(targetId)?.name || 'this operative'}?`)) {
      if (await perform({ action: 'investigate', targetId })) toast('Private field read received.', 'success');
    }
    return;
  }
  if (action === 'commend') return perform({ action: 'commend', targetId });
  if (action === 'return-lobby') return perform({ action: 'return-to-lobby' });
  if (action === 'rematch') return perform({ action: 'rematch' });
  if (action === 'report') return showReport(targetId);
  if (action === 'accuse') return showReport(targetId, true);
  if (action === 'mute') return perform({ action: 'mute', targetId });
  if (action === 'remove') {
    if (confirm(`Remove ${playerById(targetId)?.name || 'this operative'} from the room?`)) await perform({ action: 'remove-player', targetId });
    return;
  }
  if (action === 'transfer') {
    if (confirm(`Make ${playerById(targetId)?.name || 'this operative'} the new host?`)) await perform({ action: 'transfer-host', targetId });
    return;
  }
  if (action === 'reaction') return perform({ action: 'reaction', reaction: button.dataset.reaction });
  if (action === 'save-settings') {
    const timerSeconds = Number(document.querySelector('#timer-setting')?.value || 60);
    const visibility = document.querySelector('#access-setting')?.value || 'code';
    if (await perform({ action: 'settings', timerSeconds, visibility })) toast('Room settings saved.', 'success');
  }
}

setInterval(() => {
  const countdown = document.querySelector('[data-countdown]');
  if (countdown && state.room?.deadlineAt) countdown.textContent = timerText();
}, 1000);

boot();
