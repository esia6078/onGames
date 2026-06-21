const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const lobbies = {};

io.on('connection', (socket) => {

  socket.on('createLobby', ({ nickname }) => {
    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    lobbies[code] = {
      admin: socket.id,
      players: [{ id: socket.id, nickname, word: null, votes: {} }],
      words: [],
      phase: 'waiting'
    };
    socket.join(code);
    socket.lobbyCode = code;
    socket.nickname = nickname;
    socket.emit('lobbyCreated', { code });
    io.to(code).emit('updatePlayers', lobbies[code].players);
  });

  socket.on('joinLobby', ({ code, nickname }) => {
    const lobby = lobbies[code];
    if (!lobby) return socket.emit('error', 'Nie ma takiego lobby!');
    if (lobby.phase !== 'waiting') return socket.emit('error', 'Gra już trwa!');
    lobby.players.push({ id: socket.id, nickname, word: null, votes: {} });
    socket.join(code);
    socket.lobbyCode = code;
    socket.nickname = nickname;
    socket.emit('joinedLobby', { code });
    io.to(code).emit('updatePlayers', lobby.players);
  });

  socket.on('setWords', ({ words }) => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.admin !== socket.id) return;
    lobby.words = words.filter(w => w.trim() !== '');
    socket.emit('wordsSet', lobby.words);
  });

  socket.on('startVoting', () => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.admin !== socket.id) return;
    if (lobby.words.length < 2) return socket.emit('error', 'Dodaj minimum 2 słowa!');
    lobby.phase = 'voting';
    lobby.currentVotingIndex = 0;
    lobby.players.forEach(p => { p.votes = {}; p.word = null; });
    startVotingForPlayer(code);
  });

  socket.on('vote', ({ word }) => {
    const code = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.phase !== 'voting') return;
    const idx = lobby.currentVotingIndex;
    const target = lobby.players[idx];
    if (!target || target.id === socket.id) return;
    target.votes[socket.id] = word;
    const expectedVotes = lobby.players.length - 1;
    if (Object.keys(target.votes).length >= expectedVotes) {
      const tally = {};
      Object.values(target.votes).forEach(w => { tally[w] = (tally[w] || 0) + 1; });
      const chosen = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
      target.word = chosen;
      lobby.currentVotingIndex++;
      if (lobby.currentVotingIndex >= lobby.players.length) {
        lobby.phase = 'playing';
        io.to(code).emit('gameStarted', lobby.players);
      } else {
        startVotingForPlayer(code);
      }
    }
  });

  socket.on('disconnect', () => {
    const code = socket.lobbyCode;
    if (!code || !lobbies[code]) return;
    lobbies[code].players = lobbies[code].players.filter(p => p.id !== socket.id);
    if (lobbies[code].players.length === 0) {
      delete lobbies[code];
    } else {
      io.to(code).emit('updatePlayers', lobbies[code].players);
    }
  });
});

function startVotingForPlayer(code) {
  const lobby = lobbies[code];
  const target = lobby.players[lobby.currentVotingIndex];
  io.to(code).emit('votingFor', {
    targetId: target.id,
    targetNickname: target.nickname,
    words: lobby.words
  });
}

server.listen(3000, () => console.log('Serwer działa na porcie 3000'));