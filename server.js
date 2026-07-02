const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// ─── OpenAI client (optional – needed only for Państwa-Miasta AI validation) ──
// The module is optional: the game must run fine even when it isn't installed
// or no API key is provided. In that case AI validation is simply skipped and
// players decide everything by voting.
let openai = null;
if (process.env.OPENAI_API_KEY) {
  try {
    const OpenAI = require('openai').default || require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (err) {
    console.warn('OpenAI module unavailable – AI validation disabled:', err.message);
  }
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const DISCONNECT_GRACE_MS = 10 * 60 * 1000;   // 10 min
const MAX_PM_PLAYERS      = 15;
const ROUND_MS            = 120_000;           // 2 min
const STOP_GRACE_MS       = 3_000;             // 3 s after STOP
const WORD_REVEAL_MS      = 4_000;             // 4 s reveal screen
const ASSIGN_TIMEOUT_MS   = 90_000;            // 90 s max for assignment phase
const LETTERS             = 'ABCDEFGHIJKLMNOPRSTUWZ'.split('');
const DEFAULT_CATEGORIES  = ['Państwo','Miasto','Rzeka','Zwierzę','Roślina','Imię'];
const ALL_CATEGORIES      = ['Państwo','Miasto','Rzeka','Zwierzę','Roślina','Imię','Zawód','Kolor','Jedzenie','Marka'];

const CATEGORY_DESCRIPTIONS = {
  'Państwo':  'sovereign country recognised internationally',
  'Miasto':   'real city or town',
  'Rzeka':    'real river',
  'Zwierzę':  'real animal species',
  'Roślina':  'real plant, tree or flower',
  'Imię':     'real human first name (any language)',
  'Zawód':    'real profession or job',
  'Kolor':    'recognised colour name',
  'Jedzenie': 'real food or drink',
  'Marka':    'real brand or company',
};

// ─── STATE ───────────────────────────────────────────────────────────────────
const lobbies = {};   // code → lobby

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function generateId()   { return Date.now().toString(36) + Math.random().toString(36).substring(2,10); }
function generateCode() { return Math.random().toString(36).substring(2,7).toUpperCase(); }

function publicPlayers(lobby) {
  return lobby.players.map(p => {
    const base = { id: p.playerId, nickname: p.nickname, connected: p.connected };
    if (lobby.game === 'czolko')  base.word  = p.word;
    if (lobby.game === 'panstwa') base.score = p.score;
    return base;
  });
}

function broadcastLobby(code) {
  const lobby = lobbies[code];
  if (!lobby) return;
  io.to(code).emit('updateLobby', {
    game: lobby.game,
    admin: lobby.admin,
    players: publicPlayers(lobby),
    categories: lobby.game === 'panstwa' ? lobby.categories : undefined,
  });
}

// ─── CZÓŁKO – SIMULTANEOUS ASSIGNMENT ───────────────────────────────────────

function buildAssignments(players) {
  // Shuffle, then circular chain: shuffled[i] → shuffled[(i+1) % n]
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  return shuffled.map((p, i) => {
    const target = shuffled[(i + 1) % shuffled.length];
    return { assignerId: p.playerId, targetId: target.playerId, targetNickname: target.nickname, word: null };
  });
}

function pendingNicknames(lobby) {
  return lobby.assignments
    .filter(a => a.word === null)
    .map(a => lobby.players.find(p => p.playerId === a.assignerId)?.nickname ?? '?');
}

function startSimultaneousAssign(code) {
  const lobby = lobbies[code];
  lobby.phase       = 'assigning';
  lobby.assignments = buildAssignments(lobby.players);

  const totalCount = lobby.players.length;

  // Send personalised event to each player
  lobby.players.forEach(player => {
    const assignment = lobby.assignments.find(a => a.assignerId === player.playerId);
    if (!assignment) return;
    io.to(player.socketId).emit('simultaneousAssignStart', {
      myTarget:         { targetId: assignment.targetId, targetNickname: assignment.targetNickname },
      submittedCount:   0,
      totalCount,
      pendingNicknames: pendingNicknames(lobby),
    });
  });

  // Safety timeout
  lobby.assignTimeout = setTimeout(() => {
    lobby.assignments.forEach(a => { if (a.word === null) a.word = '???'; });
    doWordReveal(code);
  }, ASSIGN_TIMEOUT_MS);
}

function doWordReveal(code) {
  const lobby = lobbies[code];
  if (lobby.assignTimeout) { clearTimeout(lobby.assignTimeout); lobby.assignTimeout = null; }

  // Apply words to players
  lobby.assignments.forEach(a => {
    const target = lobby.players.find(p => p.playerId === a.targetId);
    if (target) target.word = a.word ?? '???';
  });

  io.to(code).emit('wordReveal', {
    assignments: lobby.assignments.map(a => {
      const assigner = lobby.players.find(p => p.playerId === a.assignerId);
      return { assignerId: a.assignerId, assignerNickname: assigner?.nickname ?? '?', targetId: a.targetId, targetNickname: a.targetNickname, word: a.word ?? '???' };
    }),
  });

  setTimeout(() => {
    lobby.phase = 'playing';
    io.to(code).emit('gameStarted', publicPlayers(lobby));
  }, WORD_REVEAL_MS);
}

// ─── CZÓŁKO – END-GAME VOTE (new game vs back to lobby) ─────────────────────

const CZOLKO_VOTE_MS = 30_000;   // auto-resolve if not everyone votes in time

function czolkoVoteTally(lobby) {
  let neu = 0, lob = 0;
  Object.values(lobby.endVotes).forEach(v => { if (v === 'new') neu++; else if (v === 'lobby') lob++; });
  return { new: neu, lobby: lob, total: connectedCount(lobby), voted: neu + lob };
}

function resetCzolkoToWaiting(lobby) {
  lobby.phase       = 'waiting';
  lobby.assignments = [];
  lobby.winner      = null;
  lobby.endVotes    = {};
  if (lobby.endVoteTimeout) { clearTimeout(lobby.endVoteTimeout); lobby.endVoteTimeout = null; }
  if (lobby.assignTimeout)  { clearTimeout(lobby.assignTimeout);  lobby.assignTimeout  = null; }
  lobby.players.forEach(p => { p.word = null; });
}

function resolveCzolkoVote(code) {
  const lobby = lobbies[code];
  if (!lobby || lobby.game !== 'czolko' || lobby.phase !== 'finished') return;
  if (lobby.endVoteTimeout) { clearTimeout(lobby.endVoteTimeout); lobby.endVoteTimeout = null; }

  const tally = czolkoVoteTally(lobby);
  // More votes wins; a tie (or nobody voting) means "back to lobby".
  const startNewGame = tally.new > tally.lobby;

  resetCzolkoToWaiting(lobby);

  if (startNewGame && connectedCount(lobby) >= 2) {
    io.to(code).emit('czolkoVoteResult', { decision: 'new' });
    startSimultaneousAssign(code);
  } else {
    io.to(code).emit('czolkoVoteResult', { decision: 'lobby' });
    broadcastLobby(code);
  }
}

// ─── PAŃSTWA-MIASTA ───────────────────────────────────────────────────────────

function normalizeAnswer(str) { return (str || '').trim().toLowerCase(); }

function answerKey(playerId, category) { return playerId + '||' + category; }

// Number of connected players – used as the electorate size for vote majorities.
function connectedCount(lobby) { return lobby.players.filter(p => p.connected).length; }

// Decide whether a single answer counts, based on player votes (+ AI as fallback).
// Rule (per the design): an answer counts unless a *majority of the players who
// voted* reject it. A tie keeps the word (falls back to the AI verdict when the
// tie is 0-0, i.e. nobody voted at all).
function pmAnswerValid(lobby, entry) {
  if (!entry.eligible) return false;                 // empty / wrong letter → never counts
  const votes = lobby.reviewVotes[entry.key] || {};
  let accept = 0, reject = 0;
  Object.values(votes).forEach(v => { if (v === 'accept') accept++; else if (v === 'reject') reject++; });
  if (reject > accept) return false;                 // majority of voters rejected
  if (accept > reject) return true;                  // majority accepted
  // Tie. If somebody voted it's a real tie → keep. If nobody voted, defer to AI.
  if (accept === 0 && reject === 0) {
    const ai = lobby.aiVerdicts[entry.key];
    if (ai && typeof ai.valid === 'boolean') return ai.valid;
  }
  return true;
}

// Build the full results object from the current review state (no mutation).
function pmComputeResults(lobby) {
  const { categories } = lobby.reviewData;
  const results = {};
  categories.forEach(cat => {
    const decided = lobby.reviewData.entries[cat].map(e => ({ ...e, valid: pmAnswerValid(lobby, e) }));
    const counts = {};
    decided.forEach(e => { if (e.valid) counts[e.norm] = (counts[e.norm] || 0) + 1; });
    results[cat] = decided.map(e => {
      const votes = lobby.reviewVotes[e.key] || {};
      let accept = 0, reject = 0;
      Object.values(votes).forEach(v => { if (v === 'accept') accept++; else if (v === 'reject') reject++; });
      const ai = lobby.aiVerdicts[e.key] || null;
      return {
        key: e.key, playerId: e.playerId, nickname: e.nickname, answer: e.answer,
        eligible: e.eligible, valid: e.valid,
        points: e.valid ? (counts[e.norm] > 1 ? 5 : 10) : 0,
        accept, reject,
        ai: ai ? { valid: ai.valid, reason: ai.reason } : null,
      };
    });
  });
  return results;
}

// Scoreboard for the review screen. While the round is not finalised the points
// are a live projection (base score + this round's projected points).
function pmReviewScoreboard(lobby, results) {
  return lobby.players.map(p => {
    let extra = 0;
    if (!lobby.roundFinalized) {
      lobby.reviewData.categories.forEach(cat => {
        const r = results[cat].find(x => x.playerId === p.playerId);
        if (r) extra += r.points;
      });
    }
    return { id: p.playerId, nickname: p.nickname, score: p.score + extra };
  }).sort((a, b) => b.score - a.score);
}

function pmReviewPayload(lobby) {
  const results = pmComputeResults(lobby);
  return {
    letter: lobby.reviewData.letter,
    categories: lobby.reviewData.categories,
    results,
    scoreboard: pmReviewScoreboard(lobby, results),
    finalized: lobby.roundFinalized,
    connected: connectedCount(lobby),
  };
}

function pmBroadcastReview(code) {
  const lobby = lobbies[code];
  if (!lobby || !lobby.reviewData) return;
  io.to(code).emit('reviewState', pmReviewPayload(lobby));
}

// Apply this round's points to the players' scores (idempotent per round).
function pmFinalizeRound(code) {
  const lobby = lobbies[code];
  if (!lobby || lobby.phase !== 'reviewing' || lobby.roundFinalized) return;
  const results = pmComputeResults(lobby);
  lobby.players.forEach(p => {
    let add = 0;
    lobby.reviewData.categories.forEach(cat => {
      const r = results[cat].find(x => x.playerId === p.playerId);
      if (r) add += r.points;
    });
    p.score += add;
  });
  lobby.roundFinalized = true;
  lobby.lastResults = { letter: lobby.reviewData.letter, categories: lobby.reviewData.categories, results };
  pmBroadcastReview(code);
}

function pmEndRound(code) {
  const lobby = lobbies[code];
  if (!lobby || lobby.phase !== 'playing') return;
  if (lobby.roundTimeout) { clearTimeout(lobby.roundTimeout); lobby.roundTimeout = null; }
  lobby.phase = 'reviewing';

  const letter = lobby.currentLetter;

  // Build immutable per-answer entries. Eligibility = non-empty AND starts with
  // the round letter. Everything else is decided by voting during review.
  const entries = {};
  lobby.categories.forEach(cat => {
    entries[cat] = lobby.players.map(p => {
      const raw  = (lobby.answers[p.playerId] || {})[cat] || '';
      const norm = normalizeAnswer(raw);
      const eligible = norm.length > 0 && norm[0].toUpperCase() === letter;
      return { key: answerKey(p.playerId, cat), playerId: p.playerId, nickname: p.nickname, answer: raw, norm, eligible };
    });
  });

  lobby.reviewData     = { letter, categories: lobby.categories.slice(), entries };
  lobby.reviewVotes    = {};   // answerKey → { voterId: 'accept'|'reject' }
  lobby.aiVerdicts     = {};   // answerKey → { valid, reason }
  lobby.roundFinalized = false;
  lobby.lastResults    = null;

  pmBroadcastReview(code);
  pmRunAiValidation(code);
}

// ── AI VALIDATION (fire-and-forget) ────────────────────────────────────────
// The AI no longer silently assigns points. Instead it seeds a recommendation
// (shown to players) and acts as the tie-breaker for answers nobody voted on.
function pmRunAiValidation(code) {
  const lobby = lobbies[code];
  if (!lobby || !openai || !lobby.reviewData) return;
  const letter = lobby.reviewData.letter;

  const nonEmpty = [];
  lobby.reviewData.categories.forEach(cat => {
    lobby.reviewData.entries[cat].forEach(e => {
      if (e.answer && e.answer.trim().length > 0) {
        nonEmpty.push({ key: e.key, category: cat, answer: e.answer, nickname: e.nickname });
      }
    });
  });
  if (nonEmpty.length === 0) return;

  const entriesText = nonEmpty.map((e, i) =>
    `${i+1}. Category: "${e.category}" (${CATEGORY_DESCRIPTIONS[e.category] || e.category}), Answer: "${e.answer}" by ${e.nickname}`
  ).join('\n');

  io.to(code).emit('aiStatus', { checking: true });

  openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a strict but fair judge for the Polish word game "Państwa i Miasta".
Validate whether each answer is a legitimate entry for its category, starting with the letter "${letter}".
Rules:
- Answer must start with "${letter}" (case-insensitive; Polish Ą/Ę/Ó/Ź/Ż/Ś/Ć/Ń count as their base letter for the game)
- Must be a real, widely-recognised example of the category
- Common knowledge entries are valid even if somewhat obscure; obvious nonsense is not
- Minor typos that are clearly identifiable are acceptable
Respond ONLY with JSON: { "validations": [ { "index": 1, "valid": true, "reason": "brief Polish explanation" }, ... ] }`,
      },
      { role: 'user', content: `Validate these answers for letter "${letter}":\n${entriesText}` },
    ],
  }).then(completion => {
    // The lobby may have moved on while we waited.
    if (!lobby.reviewData || lobby.reviewData.letter !== letter) return;
    const raw  = completion.choices[0]?.message?.content || '{}';
    const obj  = JSON.parse(raw);
    const list = Array.isArray(obj) ? obj : (Array.isArray(obj.validations) ? obj.validations : []);
    nonEmpty.forEach((entry, i) => {
      const r = list.find(x => x.index === i + 1);
      lobby.aiVerdicts[entry.key] = { valid: r?.valid ?? true, reason: r?.reason ?? '' };
    });
    io.to(code).emit('aiStatus', { checking: false });
    pmBroadcastReview(code);
  }).catch(err => {
    console.error('AI request error', err.message);
    io.to(code).emit('aiStatus', { checking: false });
  });
}

function pmBeginRound(code) {
  const lobby = lobbies[code];
  lobby.phase         = 'playing';
  lobby.round        += 1;
  lobby.currentLetter = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  lobby.answers       = {};
  lobby.players.forEach(p => { lobby.answers[p.playerId] = {}; });
  lobby.roundEndsAt   = Date.now() + ROUND_MS;
  lobby.stopping      = false;
  lobby.roundTimeout  = setTimeout(() => pmEndRound(code), ROUND_MS);

  io.to(code).emit('roundStarted', {
    round: lobby.round, letter: lobby.currentLetter,
    categories: lobby.categories, endsAt: lobby.roundEndsAt,
  });
}

// ─── SOCKET EVENTS ───────────────────────────────────────────────────────────

io.on('connection', socket => {

  // CREATE LOBBY
  socket.on('createLobby', ({ nickname, playerId, game }) => {
    const pid      = playerId || generateId();
    const code     = generateCode();
    const gameType = game === 'panstwa' ? 'panstwa' : 'czolko';

    const basePlayer = { playerId: pid, socketId: socket.id, nickname, connected: true, disconnectTimer: null, word: null, score: 0 };

    if (gameType === 'czolko') {
      lobbies[code] = { game: 'czolko', admin: pid, players: [basePlayer], phase: 'waiting', assignments: [], assignTimeout: null, winner: null, endVotes: {}, endVoteTimeout: null };
    } else {
      lobbies[code] = { game: 'panstwa', admin: pid, players: [basePlayer], phase: 'waiting', categories: DEFAULT_CATEGORIES.slice(), round: 0, currentLetter: null, answers: {}, roundTimeout: null, roundEndsAt: 0, stopping: false, lastResults: null, reviewData: null, reviewVotes: {}, aiVerdicts: {}, roundFinalized: false };
    }

    socket.join(code);
    socket.lobbyCode = code;
    socket.playerId  = pid;
    socket.emit('lobbyCreated', { code, playerId: pid, game: gameType, allCategories: gameType === 'panstwa' ? ALL_CATEGORIES : undefined });
    broadcastLobby(code);
  });

  // JOIN LOBBY
  socket.on('joinLobby', ({ code, nickname, playerId }) => {
    const lobby = lobbies[code];
    if (!lobby)                                              return socket.emit('error', 'Nie ma takiego lobby!');
    if (lobby.phase !== 'waiting')                           return socket.emit('error', 'Gra już trwa!');
    if (lobby.game === 'panstwa' && lobby.players.length >= MAX_PM_PLAYERS) return socket.emit('error', 'Lobby jest pełne (max 15 graczy)!');

    const pid = playerId || generateId();
    lobby.players.push({ playerId: pid, socketId: socket.id, nickname, connected: true, disconnectTimer: null, word: null, score: 0 });
    socket.join(code);
    socket.lobbyCode = code;
    socket.playerId  = pid;
    socket.emit('joinedLobby', { code, playerId: pid, game: lobby.game, allCategories: lobby.game === 'panstwa' ? ALL_CATEGORIES : undefined });
    broadcastLobby(code);
  });

  // REJOIN
  socket.on('rejoin', ({ code, playerId }) => {
    const lobby  = lobbies[code];
    if (!lobby || !playerId) return socket.emit('rejoinFailed');
    const player = lobby.players.find(p => p.playerId === playerId);
    if (!player) return socket.emit('rejoinFailed');

    if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
    player.socketId  = socket.id;
    player.connected = true;
    socket.join(code);
    socket.lobbyCode = code;
    socket.playerId  = playerId;

    const isAdmin = lobby.admin === playerId;
    const base    = { game: lobby.game, code, isAdmin, players: publicPlayers(lobby) };

    if (lobby.game === 'czolko') {
      if (lobby.phase === 'waiting') {
        socket.emit('rejoinState', { ...base, phase: 'waiting' });
      } else if (lobby.phase === 'assigning') {
        const myAssignment = lobby.assignments.find(a => a.assignerId === playerId);
        socket.emit('rejoinState', {
          ...base, phase: 'assigning',
          myTarget:          myAssignment ? { targetId: myAssignment.targetId, targetNickname: myAssignment.targetNickname } : null,
          alreadySubmitted:  myAssignment?.word !== null,
          submittedCount:    lobby.assignments.filter(a => a.word !== null).length,
          totalCount:        lobby.players.length,
          pendingNicknames:  pendingNicknames(lobby),
        });
      } else if (lobby.phase === 'playing') {
        socket.emit('rejoinState', { ...base, phase: 'playing' });
      } else if (lobby.phase === 'finished') {
        socket.emit('rejoinState', {
          ...base, phase: 'finished', winner: lobby.winner,
          endVote: czolkoVoteTally(lobby), myEndVote: lobby.endVotes[playerId] || null,
        });
      }
    } else {
      const extra = { allCategories: ALL_CATEGORIES, categories: lobby.categories, scoreboard: publicPlayers(lobby).sort((a,b) => b.score - a.score) };
      if (lobby.phase === 'waiting') {
        socket.emit('rejoinState', { ...base, ...extra, phase: 'waiting' });
      } else if (lobby.phase === 'playing') {
        socket.emit('rejoinState', { ...base, ...extra, phase: 'playing', letter: lobby.currentLetter, round: lobby.round, myAnswers: lobby.answers[playerId] || {}, endsAt: lobby.roundEndsAt });
      } else if (lobby.phase === 'reviewing') {
        const myVotes = {};
        Object.keys(lobby.reviewVotes).forEach(k => { if (lobby.reviewVotes[k][playerId]) myVotes[k] = lobby.reviewVotes[k][playerId]; });
        socket.emit('rejoinState', { ...base, ...extra, phase: 'reviewing', round: lobby.round, review: pmReviewPayload(lobby), myVotes });
      } else if (lobby.phase === 'finished') {
        socket.emit('rejoinState', { ...base, ...extra, phase: 'finished' });
      }
    }
    broadcastLobby(code);
  });

  // ── CZÓŁKO ──────────────────────────────────────────────────────────────────

  socket.on('startSimultaneousAssign', () => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'czolko' || lobby.admin !== socket.playerId) return;
    if (lobby.players.length < 2) return socket.emit('error', 'Potrzeba minimum 2 graczy!');
    if (lobby.phase !== 'waiting') return;
    startSimultaneousAssign(code);
  });

  socket.on('submitSimultaneousWord', ({ word }) => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'czolko' || lobby.phase !== 'assigning') return;
    const assignment = lobby.assignments.find(a => a.assignerId === socket.playerId);
    if (!assignment || assignment.word !== null) return;

    assignment.word = (word || '').trim() || '???';

    const submittedCount = lobby.assignments.filter(a => a.word !== null).length;
    const totalCount     = lobby.players.length;

    io.to(code).emit('simultaneousAssignProgress', { submittedCount, totalCount, pendingNicknames: pendingNicknames(lobby) });

    if (submittedCount === totalCount) doWordReveal(code);
  });

  socket.on('czolkoEndGame', ({ winnerId }) => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'czolko' || lobby.admin !== socket.playerId || lobby.phase !== 'playing') return;
    const winner = lobby.players.find(p => p.playerId === winnerId);
    if (!winner) return socket.emit('error', 'Nie znaleziono gracza!');
    lobby.phase   = 'finished';
    lobby.winner  = { id: winner.playerId, nickname: winner.nickname };
    lobby.endVotes = {};
    io.to(code).emit('czolkoGameEnded', { winner: lobby.winner, players: publicPlayers(lobby), endVote: czolkoVoteTally(lobby) });
    if (lobby.endVoteTimeout) clearTimeout(lobby.endVoteTimeout);
    lobby.endVoteTimeout = setTimeout(() => resolveCzolkoVote(code), CZOLKO_VOTE_MS);
  });

  // Vote on what happens after the game ends: 'new' game or back to 'lobby'.
  socket.on('czolkoEndVote', ({ vote }) => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'czolko' || lobby.phase !== 'finished' || !socket.playerId) return;
    if (vote !== 'new' && vote !== 'lobby') return;
    lobby.endVotes[socket.playerId] = vote;

    const tally = czolkoVoteTally(lobby);
    io.to(code).emit('czolkoVoteUpdate', tally);
    // Resolve as soon as every connected player has voted.
    if (tally.voted >= tally.total && tally.total > 0) resolveCzolkoVote(code);
  });

  // ── PAŃSTWA-MIASTA ───────────────────────────────────────────────────────────

  socket.on('updateCategories', ({ categories }) => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    const clean = (categories || []).filter(c => ALL_CATEGORIES.includes(c));
    if (clean.length < 3) return socket.emit('error', 'Wybierz minimum 3 kategorie!');
    lobby.categories = clean;
    broadcastLobby(code);
  });

  socket.on('startGame', () => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    if (lobby.players.length < 2)   return socket.emit('error', 'Potrzeba minimum 2 graczy!');
    if (lobby.categories.length < 3) return socket.emit('error', 'Wybierz minimum 3 kategorie!');
    pmBeginRound(code);
  });

  socket.on('updateAnswers', ({ answers }) => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.phase !== 'playing' || !socket.playerId) return;
    lobby.answers[socket.playerId] = answers || {};
  });

  socket.on('stopRound', () => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.phase !== 'playing' || lobby.stopping) return;
    lobby.stopping = true;
    const stopper  = lobby.players.find(p => p.playerId === socket.playerId);
    io.to(code).emit('roundStopping', { by: stopper?.nickname ?? '???', gracePeriodMs: STOP_GRACE_MS });
    if (lobby.roundTimeout) clearTimeout(lobby.roundTimeout);
    lobby.roundTimeout = setTimeout(() => { lobby.stopping = false; pmEndRound(code); }, STOP_GRACE_MS);
  });

  // A player votes to accept/reject an answer during review. Sending the same
  // vote again toggles it off. Nobody may vote on their own answer.
  socket.on('castVote', ({ targetId, category, vote }) => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.phase !== 'reviewing' || lobby.roundFinalized) return;
    if (!socket.playerId || targetId === socket.playerId) return;
    if (!lobby.reviewData || !lobby.reviewData.categories.includes(category)) return;

    const entry = (lobby.reviewData.entries[category] || []).find(e => e.playerId === targetId);
    if (!entry || !entry.eligible) return;   // can't vote on empty / wrong-letter answers

    if (!lobby.reviewVotes[entry.key]) lobby.reviewVotes[entry.key] = {};
    const bucket = lobby.reviewVotes[entry.key];
    if (vote !== 'accept' && vote !== 'reject') return;
    if (bucket[socket.playerId] === vote) delete bucket[socket.playerId];   // toggle off
    else bucket[socket.playerId] = vote;

    pmBroadcastReview(code);
  });

  // Admin locks in the voting results and applies the points for this round.
  socket.on('finalizeRound', () => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'reviewing') return;
    pmFinalizeRound(code);
  });

  socket.on('nextRound', () => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'reviewing') return;
    pmFinalizeRound(code);   // make sure this round's points are applied
    pmBeginRound(code);
  });

  socket.on('endGame', () => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId) return;
    if (lobby.phase === 'reviewing') pmFinalizeRound(code);
    if (lobby.roundTimeout) { clearTimeout(lobby.roundTimeout); lobby.roundTimeout = null; }
    lobby.phase = 'finished';
    io.to(code).emit('gameEnded', { scoreboard: publicPlayers(lobby).sort((a,b) => b.score - a.score) });
  });

  // ── LEAVE LOBBY (voluntary exit) ─────────────────────────────────────────────

  socket.on('leaveLobby', () => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    const pid   = socket.playerId;
    socket.emit('leftLobby');            // always let the client reset to home
    if (!lobby || !pid) return;

    const player = lobby.players.find(p => p.playerId === pid);
    if (player && player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }

    lobby.players = lobby.players.filter(p => p.playerId !== pid);
    socket.leave(code);
    socket.lobbyCode = null;
    socket.playerId  = null;

    if (lobby.players.length === 0) {
      if (lobby.roundTimeout)    clearTimeout(lobby.roundTimeout);
      if (lobby.assignTimeout)   clearTimeout(lobby.assignTimeout);
      if (lobby.endVoteTimeout)  clearTimeout(lobby.endVoteTimeout);
      delete lobbies[code];
      return;
    }

    // Hand the crown to the next player if the admin left.
    if (lobby.admin === pid) {
      const next = lobby.players.find(p => p.connected) || lobby.players[0];
      lobby.admin = next.playerId;
    }

    broadcastLobby(code);
    // Keep review/vote screens consistent after a departure.
    if (lobby.game === 'panstwa' && lobby.phase === 'reviewing') pmBroadcastReview(code);
    if (lobby.game === 'czolko'  && lobby.phase === 'finished') {
      const tally = czolkoVoteTally(lobby);
      io.to(code).emit('czolkoVoteUpdate', tally);
      if (tally.voted >= tally.total && tally.total > 0) resolveCzolkoVote(code);
    }
  });

  // ── DISCONNECT ───────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    const { lobbyCode: code, playerId } = socket;
    if (!code || !lobbies[code] || !playerId) return;
    const lobby  = lobbies[code];
    const player = lobby.players.find(p => p.playerId === playerId);
    if (!player || player.socketId !== socket.id) return;

    player.connected = false;
    broadcastLobby(code);

    // A disconnect changes the electorate size, which can complete a vote.
    if (lobby.game === 'panstwa' && lobby.phase === 'reviewing') pmBroadcastReview(code);
    if (lobby.game === 'czolko'  && lobby.phase === 'finished') {
      const tally = czolkoVoteTally(lobby);
      io.to(code).emit('czolkoVoteUpdate', tally);
      if (tally.voted >= tally.total && tally.total > 0) resolveCzolkoVote(code);
    }

    player.disconnectTimer = setTimeout(() => {
      lobby.players = lobby.players.filter(p => p.playerId !== playerId);
      if (lobby.players.length === 0) {
        if (lobby.roundTimeout)    clearTimeout(lobby.roundTimeout);
        if (lobby.assignTimeout)   clearTimeout(lobby.assignTimeout);
        if (lobby.endVoteTimeout)  clearTimeout(lobby.endVoteTimeout);
        delete lobbies[code];
      } else {
        if (lobby.admin === playerId) {
          const next = lobby.players.find(p => p.connected) || lobby.players[0];
          lobby.admin = next.playerId;
        }
        broadcastLobby(code);
        if (lobby.game === 'panstwa' && lobby.phase === 'reviewing') pmBroadcastReview(code);
      }
    }, DISCONNECT_GRACE_MS);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Serwer działa na porcie ' + PORT));
