const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const DISCONNECT_GRACE_MS = 10 * 60 * 1000; // 10 minut na powrót do gry po zerwaniu połączenia
const MAX_PM_PLAYERS = 15;
const ROUND_MS = 120000; // 2 minuty na rundę Państw-Miast
const STOP_GRACE_MS = 3000; // 3 sekundy na dokończenie po kliknięciu "STOP!"
const LETTERS = 'ABCDEFGHIJKLMNOPRSTUWZ'.split('');
const DEFAULT_CATEGORIES = ['Państwo', 'Miasto', 'Rzeka', 'Zwierzę', 'Roślina', 'Imię'];
const ALL_CATEGORIES = ['Państwo', 'Miasto', 'Rzeka', 'Zwierzę', 'Roślina', 'Imię', 'Zawód', 'Kolor', 'Jedzenie', 'Marka'];

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
}

// Wszystkie lobby (obu gier) trzymane w jednym słowniku po kodzie.
// lobby.game === 'czolko' | 'panstwa'
const lobbies = {};

function publicPlayers(lobby) {
  return lobby.players.map(p => {
    const base = { id: p.playerId, nickname: p.nickname, connected: p.connected };
    if (lobby.game === 'czolko') base.word = p.word;
    if (lobby.game === 'panstwa') base.score = p.score;
    return base;
  });
}

function broadcastLobby(code) {
  const lobby = lobbies[code];
  if (!lobby) return;
  io.to(code).emit('updateLobby', {
    game: lobby.game,
    players: publicPlayers(lobby),
    categories: lobby.game === 'panstwa' ? lobby.categories : undefined
  });
}

/* =========================================================================
   CZÓŁKO
   ========================================================================= */

function startNextAssignment(code) {
  const lobby = lobbies[code];
  const target = lobby.players[lobby.wordAssignIndex];
  let assignerId;
  if (target.playerId === lobby.admin) {
    assignerId = lobby.adminAssigner;
  } else {
    assignerId = lobby.admin;
  }
  lobby.currentAssignment = {
    targetId: target.playerId,
    targetNickname: target.nickname,
    assignerId: assignerId
  };
  io.to(code).emit('assignTurn', lobby.currentAssignment);
}

/* =========================================================================
   PAŃSTWA-MIASTA
   ========================================================================= */

function normalizeAnswer(str) {
  return (str || '').trim().toLowerCase();
}

function pmEndRound(code) {
  const lobby = lobbies[code];
  if (!lobby || lobby.phase !== 'playing') return;
  if (lobby.roundTimeout) { clearTimeout(lobby.roundTimeout); lobby.roundTimeout = null; }
  lobby.phase = 'reviewing';

  const letter = lobby.currentLetter;
  const results = {};

  lobby.categories.forEach(cat => {
    const entries = lobby.players.map(p => {
      const raw = (lobby.answers[p.playerId] && lobby.answers[p.playerId][cat]) || '';
      const norm = normalizeAnswer(raw);
      const valid = norm.length > 0 && norm[0].toUpperCase() === letter;
      return { playerId: p.playerId, nickname: p.nickname, answer: raw, norm, valid };
    });

    const counts = {};
    entries.forEach(e => { if (e.valid) counts[e.norm] = (counts[e.norm] || 0) + 1; });

    results[cat] = entries.map(e => {
      let points = 0;
      if (e.valid) points = counts[e.norm] > 1 ? 5 : 10;
      return { playerId: e.playerId, nickname: e.nickname, answer: e.answer, valid: e.valid, points };
    });
  });

  lobby.players.forEach(p => {
    let roundPoints = 0;
    lobby.categories.forEach(cat => {
      const entry = results[cat].find(r => r.playerId === p.playerId);
      if (entry) roundPoints += entry.points;
    });
    p.score += roundPoints;
  });

  lobby.lastResults = { letter, categories: lobby.categories, results };

  io.to(code).emit('roundResults', {
    letter,
    categories: lobby.categories,
    results,
    scoreboard: publicPlayers(lobby).sort((a, b) => b.score - a.score)
  });
}

function pmBeginRound(code) {
  const lobby = lobbies[code];
  lobby.phase = 'playing';
  lobby.round += 1;
  lobby.currentLetter = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  lobby.answers = {};
  lobby.players.forEach(p => { lobby.answers[p.playerId] = {}; });
  lobby.roundEndsAt = Date.now() + ROUND_MS;
  lobby.stopping = false;
  lobby.roundTimeout = setTimeout(() => pmEndRound(code), ROUND_MS);
  io.to(code).emit('roundStarted', {
    round: lobby.round,
    letter: lobby.currentLetter,
    categories: lobby.categories,
    endsAt: lobby.roundEndsAt
  });
}

/* =========================================================================
   WSPÓLNA OBSŁUGA POŁĄCZEŃ
   ========================================================================= */

io.on('connection', (socket) => {

  socket.on('createLobby', ({ nickname, playerId, game }) => {
    const pid = playerId || generateId();
    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    const gameType = game === 'panstwa' ? 'panstwa' : 'czolko';

    if (gameType === 'czolko') {
      lobbies[code] = {
        game: 'czolko',
        admin: pid,
        players: [{ playerId: pid, socketId: socket.id, nickname, word: null, connected: true, disconnectTimer: null }],
        phase: 'waiting',
        wordAssignIndex: 0,
        adminAssigner: null,
        currentAssignment: null
      };
    } else {
      lobbies[code] = {
        game: 'panstwa',
        admin: pid,
        players: [{ playerId: pid, socketId: socket.id, nickname, connected: true, disconnectTimer: null, score: 0 }],
        phase: 'waiting',
        categories: DEFAULT_CATEGORIES.slice(),
        round: 0,
        currentLetter: null,
        answers: {},
        roundTimeout: null,
        stopping: false,
        lastResults: null
      };
    }

    socket.join(code);
    socket.lobbyCode = code;
    socket.playerId = pid;
    socket.emit('lobbyCreated', {
      code, playerId: pid, game: gameType,
      allCategories: gameType === 'panstwa' ? ALL_CATEGORIES : undefined
    });
    broadcastLobby(code);
  });

  socket.on('joinLobby', ({ code, nickname, playerId }) => {
    const lobby = lobbies[code];
    if (!lobby) return socket.emit('error', 'Nie ma takiego lobby!');
    if (lobby.phase !== 'waiting') return socket.emit('error', 'Gra już trwa!');
    if (lobby.game === 'panstwa' && lobby.players.length >= MAX_PM_PLAYERS) {
      return socket.emit('error', 'Lobby jest pełne (max 15 graczy)!');
    }
    const pid = playerId || generateId();
    if (lobby.game === 'czolko') {
      lobby.players.push({ playerId: pid, socketId: socket.id, nickname, word: null, connected: true, disconnectTimer: null });
    } else {
      lobby.players.push({ playerId: pid, socketId: socket.id, nickname, connected: true, disconnectTimer: null, score: 0 });
    }
    socket.join(code);
    socket.lobbyCode = code;
    socket.playerId = pid;
    socket.emit('joinedLobby', {
      code, playerId: pid, game: lobby.game,
      allCategories: lobby.game === 'panstwa' ? ALL_CATEGORIES : undefined
    });
    broadcastLobby(code);
  });

  socket.on('rejoin', ({ code, playerId }) => {
    const lobby = lobbies[code];
    if (!lobby || !playerId) return socket.emit('rejoinFailed');
    const player = lobby.players.find(p => p.playerId === playerId);
    if (!player) return socket.emit('rejoinFailed');

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    player.socketId = socket.id;
    player.connected = true;
    socket.join(code);
    socket.lobbyCode = code;
    socket.playerId = playerId;

    const isAdmin = lobby.admin === playerId;
    const base = {
      game: lobby.game, code, isAdmin,
      players: publicPlayers(lobby)
    };

    if (lobby.game === 'czolko') {
      if (lobby.phase === 'waiting') {
        socket.emit('rejoinState', { ...base, phase: 'waiting' });
      } else if (lobby.phase === 'assigning') {
        socket.emit('rejoinState', { ...base, phase: 'assigning', assignment: lobby.currentAssignment });
      } else if (lobby.phase === 'playing') {
        socket.emit('rejoinState', { ...base, phase: 'playing' });
      } else if (lobby.phase === 'finished') {
        socket.emit('rejoinState', { ...base, phase: 'finished', winner: lobby.winner });
      }
    } else {
      const extra = {
        allCategories: ALL_CATEGORIES,
        categories: lobby.categories,
        scoreboard: publicPlayers(lobby).sort((a, b) => b.score - a.score)
      };
      if (lobby.phase === 'waiting') {
        socket.emit('rejoinState', { ...base, ...extra, phase: 'waiting' });
      } else if (lobby.phase === 'playing') {
        socket.emit('rejoinState', {
          ...base, ...extra, phase: 'playing',
          letter: lobby.currentLetter, round: lobby.round,
          myAnswers: lobby.answers[playerId] || {}, endsAt: lobby.roundEndsAt
        });
      } else if (lobby.phase === 'reviewing') {
        socket.emit('rejoinState', { ...base, ...extra, phase: 'reviewing', letter: lobby.currentLetter, round: lobby.round, lastResults: lobby.lastResults });
      } else if (lobby.phase === 'finished') {
        socket.emit('rejoinState', { ...base, ...extra, phase: 'finished' });
      }
    }
    broadcastLobby(code);
  });

  // ---- CZÓŁKO ----

  socket.on('startAssigning', () => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'czolko' || lobby.admin !== socket.playerId) return;
    if (lobby.players.length < 2) return socket.emit('error', 'Potrzeba minimum 2 graczy!');
    lobby.phase = 'assigning';
    lobby.wordAssignIndex = 0;
    const others = lobby.players.filter(p => p.playerId !== lobby.admin);
    lobby.adminAssigner = others[Math.floor(Math.random() * others.length)].playerId;
    startNextAssignment(code);
  });

  socket.on('assignWord', ({ word }) => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'czolko' || lobby.phase !== 'assigning') return;
    const target = lobby.players[lobby.wordAssignIndex];
    target.word = word;
    lobby.wordAssignIndex++;
    lobby.currentAssignment = null;

    io.to(code).emit('showWord', {
      targetId: target.playerId,
      targetNickname: target.nickname,
      word: word
    });

    setTimeout(() => {
      if (lobby.wordAssignIndex >= lobby.players.length) {
        lobby.phase = 'playing';
        io.to(code).emit('gameStarted', publicPlayers(lobby));
      } else {
        startNextAssignment(code);
      }
    }, 3000);
  });

  socket.on('czolkoEndGame', ({ winnerId }) => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'czolko' || lobby.admin !== socket.playerId) return;
    if (lobby.phase !== 'playing') return;
    const winner = lobby.players.find(p => p.playerId === winnerId);
    if (!winner) return socket.emit('error', 'Nie znaleziono gracza!');
    lobby.phase = 'finished';
    lobby.winner = { id: winner.playerId, nickname: winner.nickname };
    io.to(code).emit('czolkoGameEnded', { winner: lobby.winner, players: publicPlayers(lobby) });
  });

  // ---- PAŃSTWA-MIASTA ----

  socket.on('updateCategories', ({ categories }) => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    const clean = (categories || []).filter(c => ALL_CATEGORIES.includes(c));
    if (clean.length < 3) return socket.emit('error', 'Wybierz minimum 3 kategorie!');
    lobby.categories = clean;
    broadcastLobby(code);
  });

  socket.on('startGame', () => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    if (lobby.players.length < 2) return socket.emit('error', 'Potrzeba minimum 2 graczy!');
    if (lobby.categories.length < 3) return socket.emit('error', 'Wybierz minimum 3 kategorie!');
    pmBeginRound(code);
  });

  socket.on('updateAnswers', ({ answers }) => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.phase !== 'playing' || !socket.playerId) return;
    lobby.answers[socket.playerId] = answers || {};
  });

  socket.on('stopRound', () => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.phase !== 'playing' || lobby.stopping) return;
    lobby.stopping = true;
    const stopper = lobby.players.find(p => p.playerId === socket.playerId);
    io.to(code).emit('roundStopping', { by: stopper ? stopper.nickname : '???', gracePeriodMs: STOP_GRACE_MS });
    if (lobby.roundTimeout) clearTimeout(lobby.roundTimeout);
    lobby.roundTimeout = setTimeout(() => {
      lobby.stopping = false;
      pmEndRound(code);
    }, STOP_GRACE_MS);
  });

  socket.on('nextRound', () => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'reviewing') return;
    pmBeginRound(code);
  });

  socket.on('endGame', () => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId) return;
    if (lobby.roundTimeout) { clearTimeout(lobby.roundTimeout); lobby.roundTimeout = null; }
    lobby.phase = 'finished';
    io.to(code).emit('gameEnded', { scoreboard: publicPlayers(lobby).sort((a, b) => b.score - a.score) });
  });

  // ---- WSPÓLNE: ROZŁĄCZENIE ----

  socket.on('disconnect', () => {
    const code = socket.lobbyCode;
    const playerId = socket.playerId;
    if (!code || !lobbies[code] || !playerId) return;
    const lobby = lobbies[code];
    const player = lobby.players.find(p => p.playerId === playerId);
    if (!player) return;
    if (player.socketId !== socket.id) return;

    player.connected = false;
    broadcastLobby(code);

    player.disconnectTimer = setTimeout(() => {
      lobby.players = lobby.players.filter(p => p.playerId !== playerId);
      if (lobby.players.length === 0) {
        if (lobby.roundTimeout) clearTimeout(lobby.roundTimeout);
        delete lobbies[code];
      } else {
        broadcastLobby(code);
      }
    }, DISCONNECT_GRACE_MS);
  });
});

server.listen(3000, () => console.log('Serwer działa na porcie 3000'));
    p.score += roundPoints;
  });

  lobby.lastResults = { letter, categories: lobby.categories, results };

  io.to(code).emit('roundResults', {
    letter,
    categories: lobby.categories,
    results,
    scoreboard: publicPlayers(lobby).sort((a, b) => b.score - a.score)
  });
}

function pmBeginRound(code) {
  const lobby = lobbies[code];
  lobby.phase = 'playing';
  lobby.round += 1;
  lobby.currentLetter = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  lobby.answers = {};
  lobby.players.forEach(p => { lobby.answers[p.playerId] = {}; });
  lobby.roundEndsAt = Date.now() + ROUND_MS;
  lobby.stopping = false;
  lobby.roundTimeout = setTimeout(() => pmEndRound(code), ROUND_MS);
  io.to(code).emit('roundStarted', {
    round: lobby.round,
    letter: lobby.currentLetter,
    categories: lobby.categories,
    endsAt: lobby.roundEndsAt
  });
}

/* =========================================================================
   WSPÓLNA OBSŁUGA POŁĄCZEŃ
   ========================================================================= */

io.on('connection', (socket) => {

  socket.on('createLobby', ({ nickname, playerId, game }) => {
    const pid = playerId || generateId();
    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    const gameType = game === 'panstwa' ? 'panstwa' : 'czolko';

    if (gameType === 'czolko') {
      lobbies[code] = {
        game: 'czolko',
        admin: pid,
        players: [{ playerId: pid, socketId: socket.id, nickname, word: null, connected: true, disconnectTimer: null }],
        phase: 'waiting',
        wordAssignIndex: 0,
        adminAssigner: null,
        currentAssignment: null
      };
    } else {
      lobbies[code] = {
        game: 'panstwa',
        admin: pid,
        players: [{ playerId: pid, socketId: socket.id, nickname, connected: true, disconnectTimer: null, score: 0 }],
        phase: 'waiting',
        categories: DEFAULT_CATEGORIES.slice(),
        round: 0,
        currentLetter: null,
        answers: {},
        roundTimeout: null,
        stopping: false,
        lastResults: null
      };
    }

    socket.join(code);
    socket.lobbyCode = code;
    socket.playerId = pid;
    socket.emit('lobbyCreated', {
      code, playerId: pid, game: gameType,
      allCategories: gameType === 'panstwa' ? ALL_CATEGORIES : undefined
    });
    broadcastLobby(code);
  });

  socket.on('joinLobby', ({ code, nickname, playerId }) => {
    const lobby = lobbies[code];
    if (!lobby) return socket.emit('error', 'Nie ma takiego lobby!');
    if (lobby.phase !== 'waiting') return socket.emit('error', 'Gra już trwa!');
    if (lobby.game === 'panstwa' && lobby.players.length >= MAX_PM_PLAYERS) {
      return socket.emit('error', 'Lobby jest pełne (max 15 graczy)!');
    }
    const pid = playerId || generateId();
    if (lobby.game === 'czolko') {
      lobby.players.push({ playerId: pid, socketId: socket.id, nickname, word: null, connected: true, disconnectTimer: null });
    } else {
      lobby.players.push({ playerId: pid, socketId: socket.id, nickname, connected: true, disconnectTimer: null, score: 0 });
    }
    socket.join(code);
    socket.lobbyCode = code;
    socket.playerId = pid;
    socket.emit('joinedLobby', {
      code, playerId: pid, game: lobby.game,
      allCategories: lobby.game === 'panstwa' ? ALL_CATEGORIES : undefined
    });
    broadcastLobby(code);
  });

  socket.on('rejoin', ({ code, playerId }) => {
    const lobby = lobbies[code];
    if (!lobby || !playerId) return socket.emit('rejoinFailed');
    const player = lobby.players.find(p => p.playerId === playerId);
    if (!player) return socket.emit('rejoinFailed');

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    player.socketId = socket.id;
    player.connected = true;
    socket.join(code);
    socket.lobbyCode = code;
    socket.playerId = playerId;

    const isAdmin = lobby.admin === playerId;
    const base = {
      game: lobby.game, code, isAdmin,
      players: publicPlayers(lobby)
    };

    if (lobby.game === 'czolko') {
      if (lobby.phase === 'waiting') {
        socket.emit('rejoinState', { ...base, phase: 'waiting' });
      } else if (lobby.phase === 'assigning') {
        socket.emit('rejoinState', { ...base, phase: 'assigning', assignment: lobby.currentAssignment });
      } else if (lobby.phase === 'playing') {
        socket.emit('rejoinState', { ...base, phase: 'playing' });
      }
    } else {
      const extra = {
        allCategories: ALL_CATEGORIES,
        categories: lobby.categories,
        scoreboard: publicPlayers(lobby).sort((a, b) => b.score - a.score)
      };
      if (lobby.phase === 'waiting') {
        socket.emit('rejoinState', { ...base, ...extra, phase: 'waiting' });
      } else if (lobby.phase === 'playing') {
        socket.emit('rejoinState', {
          ...base, ...extra, phase: 'playing',
          letter: lobby.currentLetter, round: lobby.round,
          myAnswers: lobby.answers[playerId] || {}, endsAt: lobby.roundEndsAt
        });
      } else if (lobby.phase === 'reviewing') {
        socket.emit('rejoinState', { ...base, ...extra, phase: 'reviewing', letter: lobby.currentLetter, round: lobby.round, lastResults: lobby.lastResults });
      } else if (lobby.phase === 'finished') {
        socket.emit('rejoinState', { ...base, ...extra, phase: 'finished' });
      }
    }
    broadcastLobby(code);
  });

  // ---- CZÓŁKO ----

  socket.on('startAssigning', () => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'czolko' || lobby.admin !== socket.playerId) return;
    if (lobby.players.length < 2) return socket.emit('error', 'Potrzeba minimum 2 graczy!');
    lobby.phase = 'assigning';
    lobby.wordAssignIndex = 0;
    const others = lobby.players.filter(p => p.playerId !== lobby.admin);
    lobby.adminAssigner = others[Math.floor(Math.random() * others.length)].playerId;
    startNextAssignment(code);
  });

  socket.on('assignWord', ({ word }) => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'czolko' || lobby.phase !== 'assigning') return;
    const target = lobby.players[lobby.wordAssignIndex];
    target.word = word;
    lobby.wordAssignIndex++;
    lobby.currentAssignment = null;

    io.to(code).emit('showWord', {
      targetId: target.playerId,
      targetNickname: target.nickname,
      word: word
    });

    setTimeout(() => {
      if (lobby.wordAssignIndex >= lobby.players.length) {
        lobby.phase = 'playing';
        io.to(code).emit('gameStarted', publicPlayers(lobby));
      } else {
        startNextAssignment(code);
      }
    }, 3000);
  });

  // ---- PAŃSTWA-MIASTA ----

  socket.on('updateCategories', ({ categories }) => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    const clean = (categories || []).filter(c => ALL_CATEGORIES.includes(c));
    if (clean.length < 3) return socket.emit('error', 'Wybierz minimum 3 kategorie!');
    lobby.categories = clean;
    broadcastLobby(code);
  });

  socket.on('startGame', () => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    if (lobby.players.length < 2) return socket.emit('error', 'Potrzeba minimum 2 graczy!');
    if (lobby.categories.length < 3) return socket.emit('error', 'Wybierz minimum 3 kategorie!');
    pmBeginRound(code);
  });

  socket.on('updateAnswers', ({ answers }) => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.phase !== 'playing' || !socket.playerId) return;
    lobby.answers[socket.playerId] = answers || {};
  });

  socket.on('stopRound', () => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.phase !== 'playing' || lobby.stopping) return;
    lobby.stopping = true;
    const stopper = lobby.players.find(p => p.playerId === socket.playerId);
    io.to(code).emit('roundStopping', { by: stopper ? stopper.nickname : '???', gracePeriodMs: STOP_GRACE_MS });
    if (lobby.roundTimeout) clearTimeout(lobby.roundTimeout);
    lobby.roundTimeout = setTimeout(() => {
      lobby.stopping = false;
      pmEndRound(code);
    }, STOP_GRACE_MS);
  });

  socket.on('nextRound', () => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'reviewing') return;
    pmBeginRound(code);
  });

  socket.on('endGame', () => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId) return;
    if (lobby.roundTimeout) { clearTimeout(lobby.roundTimeout); lobby.roundTimeout = null; }
    lobby.phase = 'finished';
    io.to(code).emit('gameEnded', { scoreboard: publicPlayers(lobby).sort((a, b) => b.score - a.score) });
  });

  // ---- WSPÓLNE: ROZŁĄCZENIE ----

  socket.on('disconnect', () => {
    const code = socket.lobbyCode;
    const playerId = socket.playerId;
    if (!code || !lobbies[code] || !playerId) return;
    const lobby = lobbies[code];
    const player = lobby.players.find(p => p.playerId === playerId);
    if (!player) return;
    if (player.socketId !== socket.id) return;

    player.connected = false;
    broadcastLobby(code);

    player.disconnectTimer = setTimeout(() => {
      lobby.players = lobby.players.filter(p => p.playerId !== playerId);
      if (lobby.players.length === 0) {
        if (lobby.roundTimeout) clearTimeout(lobby.roundTimeout);
        delete lobbies[code];
      } else {
        broadcastLobby(code);
      }
    }, DISCONNECT_GRACE_MS);
  });
});

server.listen(3000, () => console.log('Serwer działa na porcie 3000'));
