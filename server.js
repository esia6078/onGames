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
const DEFAULT_MAX_ROUNDS  = 5;
const ROUND_OPTIONS       = [3, 5, 10, 999];   // 999 = "bez limitu"
const MAX_CATEGORIES      = 12;
const MAX_CUSTOM_CAT_LEN  = 24;
const POINT_STEP          = 5;                  // each net downvote lowers points by 5

// ─── ARCADE GAMES DATA ──────────────────────────────────────────────────────
const QUIZ_QUESTIONS = [
  { q: 'Stolica Australii?',                       o: ['Sydney','Canberra','Melbourne','Perth'],            c: 1 },
  { q: 'Ile nóg ma pająk?',                        o: ['6','8','10','12'],                                  c: 1 },
  { q: 'Który pierwiastek ma symbol „O"?',         o: ['Złoto','Tlen','Osm','Wodór'],                       c: 1 },
  { q: 'W którym roku zaczęła się II wojna światowa?', o: ['1914','1939','1945','1918'],                    c: 1 },
  { q: 'Najdłuższa rzeka w Polsce?',               o: ['Odra','Wisła','Warta','Bug'],                       c: 1 },
  { q: 'Ile wynosi 7 × 8?',                        o: ['54','56','64','48'],                                c: 1 },
  { q: 'Kto namalował Mona Lisę?',                 o: ['Picasso','Leonardo da Vinci','Van Gogh','Rembrandt'], c: 1 },
  { q: 'Stolica Japonii?',                         o: ['Pekin','Tokio','Seul','Bangkok'],                   c: 1 },
  { q: 'Która planeta jest najbliżej Słońca?',     o: ['Wenus','Merkury','Mars','Ziemia'],                  c: 1 },
  { q: 'Ile kontynentów jest na Ziemi?',           o: ['5','6','7','8'],                                     c: 2 },
  { q: 'Symbol chemiczny wody?',                   o: ['CO₂','H₂O','O₂','NaCl'],                            c: 1 },
  { q: 'Kto napisał „Pana Tadeusza"?',             o: ['Słowacki','Mickiewicz','Sienkiewicz','Prus'],       c: 1 },
  { q: 'Największy ocean świata?',                 o: ['Atlantycki','Spokojny','Indyjski','Arktyczny'],     c: 1 },
  { q: 'W jakim kraju stoi wieża Eiffla?',         o: ['Włochy','Francja','Hiszpania','Anglia'],            c: 1 },
  { q: 'Ile to jest 12 × 12?',                     o: ['124','144','148','132'],                            c: 1 },
  { q: 'Największe zwierzę na świecie?',           o: ['Słoń','Płetwal błękitny','Żyrafa','Rekin'],         c: 1 },
  { q: 'Stolica Niemiec?',                         o: ['Monachium','Berlin','Hamburg','Frankfurt'],         c: 1 },
  { q: 'Ile bitów ma bajt?',                       o: ['4','8','16','32'],                                  c: 1 },
  { q: 'Kto pierwszy stanął na Księżycu?',         o: ['Gagarin','Armstrong','Aldrin','Glenn'],             c: 1 },
  { q: 'Najwyższy szczyt świata?',                 o: ['K2','Mount Everest','Rysy','Mont Blanc'],           c: 1 },
  { q: 'Ilu piłkarzy z jednej drużyny jest na boisku?', o: ['9','10','11','12'],                            c: 2 },
  { q: 'Żółty + niebieski daje kolor…',            o: ['Zielony','Fioletowy','Pomarańczowy','Brązowy'],     c: 0 },
  { q: 'W którym mieście jest Krzywa Wieża?',      o: ['Rzym','Piza','Wenecja','Mediolan'],                 c: 1 },
  { q: 'Pierwiastek z 81 to…',                     o: ['7','9','8','6'],                                     c: 1 },
  { q: 'Stolica Polski?',                          o: ['Kraków','Warszawa','Łódź','Wrocław'],               c: 1 },
  { q: 'Jak nazywa się nasza galaktyka?',          o: ['Andromeda','Droga Mleczna','Wielki Wóz','Plejady'], c: 1 },
  { q: 'Ile serc ma ośmiornica?',                  o: ['1','2','3','8'],                                    c: 2 },
  { q: 'W którym roku Polska weszła do UE?',        o: ['2000','2004','2007','1999'],                        c: 1 },
  { q: 'Stolica Hiszpanii?',                       o: ['Barcelona','Madryt','Sewilla','Walencja'],          c: 1 },
  { q: 'Stolica Włoch?',                           o: ['Mediolan','Rzym','Neapol','Turyn'],                 c: 1 },
  { q: 'Stolica Rosji?',                           o: ['Petersburg','Moskwa','Kijów','Mińsk'],              c: 1 },
  { q: 'Stolica Wielkiej Brytanii?',               o: ['Manchester','Londyn','Liverpool','Glasgow'],        c: 1 },
  { q: 'Stolica USA?',                             o: ['Nowy Jork','Waszyngton','Los Angeles','Chicago'],   c: 1 },
  { q: 'Stolica Kanady?',                          o: ['Toronto','Ottawa','Montreal','Vancouver'],          c: 1 },
  { q: 'Stolica Grecji?',                          o: ['Ateny','Saloniki','Sparta','Korynt'],               c: 0 },
  { q: 'Stolica Egiptu?',                          o: ['Kair','Aleksandria','Luksor','Giza'],               c: 0 },
  { q: 'Stolica Portugalii?',                      o: ['Porto','Lizbona','Faro','Braga'],                   c: 1 },
  { q: 'Stolica Norwegii?',                        o: ['Bergen','Oslo','Trondheim','Stavanger'],            c: 1 },
  { q: 'Stolica Szwecji?',                         o: ['Göteborg','Sztokholm','Malmö','Uppsala'],           c: 1 },
  { q: 'Stolica Czech?',                           o: ['Brno','Praga','Ostrawa','Pilzno'],                  c: 1 },
  { q: 'Stolica Ukrainy?',                         o: ['Lwów','Kijów','Odessa','Charków'],                  c: 1 },
  { q: 'Stolica Węgier?',                          o: ['Debreczyn','Budapeszt','Segedyn','Miszkolc'],       c: 1 },
  { q: 'Najmniejszy kontynent świata?',            o: ['Australia i Oceania','Europa','Antarktyda','Ameryka Płd.'], c: 0 },
  { q: 'Największe państwo świata (powierzchnia)?', o: ['Kanada','Rosja','Chiny','USA'],                    c: 1 },
  { q: 'Ile państw graniczy z Polską?',            o: ['5','6','7','8'],                                     c: 2 },
  { q: 'Najwyższy szczyt Polski?',                 o: ['Śnieżka','Rysy','Giewont','Kasprowy Wierch'],       c: 1 },
  { q: 'Nad jakim morzem leży Polska?',            o: ['Czarnym','Bałtyckim','Śródziemnym','Północnym'],    c: 1 },
  { q: 'Które państwo ma kształt buta?',           o: ['Grecja','Włochy','Hiszpania','Chorwacja'],          c: 1 },
  { q: 'W którym roku upadł mur berliński?',       o: ['1989','1991','1985','1993'],                        c: 0 },
  { q: 'Pierwszy koronowany król Polski?',         o: ['Mieszko I','Bolesław Chrobry','Kazimierz Wielki','Łokietek'], c: 1 },
  { q: 'Kiedy Polska odzyskała niepodległość?',    o: ['1918','1920','1945','1791'],                        c: 0 },
  { q: 'Chrzest Polski miał miejsce w roku?',      o: ['966','1000','1025','896'],                          c: 0 },
  { q: 'Bitwa pod Grunwaldem odbyła się w roku?',  o: ['1410','1385','1500','1444'],                        c: 0 },
  { q: 'Konstytucja 3 maja uchwalona w roku?',     o: ['1791','1793','1815','1772'],                        c: 0 },
  { q: 'Pierwszy prezydent USA?',                  o: ['Lincoln','Waszyngton','Jefferson','Franklin'],      c: 1 },
  { q: 'Ile planet ma Układ Słoneczny?',           o: ['7','8','9','10'],                                    c: 1 },
  { q: 'Co rośliny pobierają do fotosyntezy?',     o: ['Tlen','Dwutlenek węgla','Azot','Wodór'],            c: 1 },
  { q: 'Ile chromosomów ma człowiek?',             o: ['23','46','48','44'],                                c: 1 },
  { q: 'Największy narząd człowieka?',             o: ['Wątroba','Skóra','Płuca','Jelito'],                 c: 1 },
  { q: 'Który organ pompuje krew?',                o: ['Płuca','Serce','Wątroba','Nerki'],                  c: 1 },
  { q: 'Ile to jest 15% z 200?',                   o: ['15','30','20','45'],                                c: 1 },
  { q: 'Ile stopni ma kąt prosty?',                o: ['45','90','180','360'],                              c: 1 },
  { q: 'Woda wrze w temperaturze (°C)?',           o: ['90','100','80','120'],                              c: 1 },
  { q: 'Który pierwiastek oznaczamy „Fe"?',        o: ['Fluor','Żelazo','Fosfor','Frans'],                  c: 1 },
  { q: 'Który pierwiastek oznaczamy „Au"?',        o: ['Srebro','Złoto','Glin','Argon'],                    c: 1 },
  { q: 'Ile nóg ma owad?',                         o: ['4','6','8','10'],                                    c: 1 },
  { q: 'Największe zwierzę lądowe?',               o: ['Nosorożec','Słoń afrykański','Żyrafa','Hipopotam'], c: 1 },
  { q: 'Ile to jest 9 × 9?',                       o: ['72','81','99','89'],                                c: 1 },
  { q: 'Ile dni ma rok przestępny?',               o: ['365','366','364','367'],                            c: 1 },
  { q: 'Nauka o pogodzie to…',                     o: ['Geologia','Meteorologia','Astronomia','Biologia'], c: 1 },
  { q: 'Ile strun ma standardowa gitara?',         o: ['4','6','8','12'],                                    c: 1 },
  { q: 'Ile pól ma szachownica?',                  o: ['36','64','81','100'],                               c: 1 },
  { q: 'Ile minut trwa mecz piłki nożnej?',        o: ['60','90','120','45'],                               c: 1 },
  { q: 'W jakim sporcie używa się lotki?',         o: ['Tenis','Badminton','Squash','Golf'],                c: 1 },
  { q: 'Ile kart ma talia (bez jokerów)?',         o: ['48','52','54','50'],                                c: 1 },
  { q: 'Kto napisał „Quo Vadis"?',                 o: ['Prus','Sienkiewicz','Reymont','Żeromski'],          c: 1 },
  { q: 'Autor komedii „Zemsta"?',                  o: ['Mickiewicz','Fredro','Sienkiewicz','Norwid'],       c: 1 },
  { q: 'Ile wynosi liczba Pi (w zaokrągleniu)?',   o: ['3.14','2.72','1.61','3.41'],                        c: 0 },
  { q: 'Który miesiąc jest siódmy w roku?',        o: ['Czerwiec','Lipiec','Sierpień','Maj'],               c: 1 },
  { q: 'Ile liter ma polski alfabet?',             o: ['26','32','35','30'],                                c: 1 },
  { q: 'Waluta Japonii?',                          o: ['Juan','Jen','Won','Rupia'],                         c: 1 },
  { q: 'Waluta obowiązująca w Polsce?',            o: ['Euro','Złoty','Korona','Forint'],                   c: 1 },
  { q: 'Ile to jest 100 − 37?',                    o: ['63','73','53','67'],                                c: 0 },
  { q: 'Ile to jest połowa z 90?',                 o: ['40','45','50','35'],                                c: 1 },
  { q: 'Najgłębsze jezioro świata?',               o: ['Wiktorii','Bajkał','Tanganika','Huron'],            c: 1 },
  { q: 'Najszybsze zwierzę lądowe?',               o: ['Lew','Gepard','Antylopa','Koń'],                    c: 1 },
  { q: 'Największy ptak świata?',                  o: ['Kondor','Struś','Orzeł','Pelikan'],                 c: 1 },
  { q: 'Instrument z klawiszami i pedałami?',      o: ['Skrzypce','Fortepian','Trąbka','Flet'],             c: 1 },
  { q: 'Ile boków ma sześciokąt?',                 o: ['5','6','7','8'],                                     c: 1 },
  { q: 'Największe jezioro świata?',               o: ['Morze Kaspijskie','Bajkał','Wiktorii','Huron'],     c: 0 },
  { q: 'Ile sekund ma minuta?',                    o: ['30','60','100','90'],                               c: 1 },
];

const BLUFF_QUESTIONS = [
  { q: 'Jak nazywał się pierwszy pies w kosmosie?',                 a: 'Łajka' },
  { q: 'Ile kości ma dorosły człowiek?',                           a: '206' },
  { q: 'Największa pustynia świata to…',                            a: 'Antarktyda' },
  { q: 'Najczęstszy pierwiastek we wszechświecie?',                a: 'Wodór' },
  { q: 'Jak nazywa się samica konia?',                             a: 'Klacz' },
  { q: 'Strach przed pająkami to…',                                a: 'Arachnofobia' },
  { q: 'Najmniejsze państwo świata?',                              a: 'Watykan' },
  { q: 'Z czego zrobiony jest grafit w ołówku?',                   a: 'Węgiel' },
  { q: 'Największy księżyc Jowisza?',                              a: 'Ganimedes' },
  { q: 'Najgłębszy punkt oceanu to Rów…',                          a: 'Mariański' },
  { q: 'Najtwardszy minerał naturalny?',                          a: 'Diament' },
  { q: 'W jakim mieście urodził się Kopernik?',                   a: 'Toruń' },
  { q: 'Prędkość światła to ok. … km/s',                          a: '300000' },
  { q: 'Największa małpa świata?',                                a: 'Goryl' },
  { q: 'Autor teorii względności?',                              a: 'Einstein' },
  { q: 'Ile lat trwała „wojna stuletnia"?',                       a: '116' },
  { q: 'Kraj o największej liczbie ludności?',                    a: 'Indie' },
  { q: 'Ile kolorów ma tęcza?',                                  a: 'Siedem' },
  { q: 'Jak nazywa się największa planeta Układu Słonecznego?',   a: 'Jowisz' },
  { q: 'Metal ciekły w temperaturze pokojowej to…',              a: 'Rtęć' },
  { q: 'Jaka jest stolica Australii?',                           a: 'Canberra' },
  { q: 'Ile ramion ma rozgwiazda (klasycznie)?',                a: 'Pięć' },
  { q: 'Z jakiego kraju pochodzi sushi?',                        a: 'Japonia' },
  { q: 'W którym roku człowiek stanął na Księżycu?',             a: '1969' },
  { q: 'Kto namalował „Słoneczniki"?',                           a: 'Van Gogh' },
  { q: 'Autor sagi o „Wiedźminie"?',                             a: 'Sapkowski' },
  { q: 'Najmniejsza liczba pierwsza?',                           a: 'Dwa' },
  { q: 'Najzimniejszy kontynent świata?',                        a: 'Antarktyda' },
  { q: 'Ile kółek ma flaga olimpijska?',                         a: 'Pięć' },
  { q: 'Symbol chemiczny soli kuchennej?',                       a: 'NaCl' },
  { q: 'Najszybsze zwierzę lądowe?',                             a: 'Gepard' },
  { q: 'Największy ptak świata?',                                a: 'Struś' },
  { q: 'Jednostka natężenia prądu to…',                          a: 'Amper' },
  { q: 'Jednostka mocy to…',                                     a: 'Wat' },
  { q: 'Kto sformułował prawa dynamiki?',                        a: 'Newton' },
  { q: 'Galaktyka sąsiadująca z Drogą Mleczną?',                a: 'Andromeda' },
  { q: 'Stolica Kanady?',                                        a: 'Ottawa' },
  { q: 'Ile zębów ma dorosły człowiek?',                         a: '32' },
  { q: 'Największe państwo świata (powierzchnia)?',             a: 'Rosja' },
  { q: 'Z czego głównie zbudowane jest Słońce?',                a: 'Wodór' },
  { q: 'Zjawisko przyciągania przez Ziemię to…',                a: 'Grawitacja' },
  { q: 'Ile wynosi suma kątów w trójkącie?',                    a: '180' },
  { q: 'Największa tętnica w ciele człowieka?',                 a: 'Aorta' },
  { q: 'Polski taniec narodowy w rytmie 3/4?',                  a: 'Polonez' },
  { q: 'Najgłębsze jezioro świata?',                            a: 'Bajkał' },
  { q: 'Największe jezioro świata?',                            a: 'Morze Kaspijskie' },
  { q: 'Rekord świata w biegu na 100 m to ok. … s',            a: '9,58' },
  { q: 'Wysokość Mount Everest to ok. … m',                     a: '8849' },
  { q: 'Jaki owad wytwarza jedwab?',                            a: 'Jedwabnik' },
  { q: 'Największy ssak lądowy?',                               a: 'Słoń' },
  { q: 'Ile kończyn ma pająk?',                                 a: 'Osiem' },
  { q: 'Waluta Japonii?',                                       a: 'Jen' },
  { q: 'Który pierwiastek ma symbol „O"?',                     a: 'Tlen' },
  { q: 'Stolica Norwegii?',                                    a: 'Oslo' },
  { q: 'Jak nazywa się najdłuższy mięsień w ciele?',           a: 'Krawiecki' },
  { q: 'Ile boków ma ośmiokąt?',                               a: 'Osiem' },
  { q: 'Który planeta jest nazywana Czerwoną Planetą?',        a: 'Mars' },
  { q: 'Jak nazywa się największa część układu pokarmowego?',  a: 'Jelito' },
  { q: 'Ile lat ma jeden wiek?',                               a: 'Sto' },
];

const DRAW_WORDS = [
  'kot','pies','słońce','dom','drzewo','samochód','kwiat','ryba','gwiazda','serce',
  'księżyc','banan','jabłko','okulary','parasol','rower','telefon','but','czapka','zegar',
  'gitara','statek','samolot','pociąg','most','góra','chmura','tęcza','lody','pizza',
  'hamburger','klucz','młotek','nożyczki','książka','ołówek','żarówka','prezent','balon','latawiec',
  'robot','dinozaur','pszczoła','motyl','żaba','słoń','lew','żyrafa','wąż','pingwin',
  'sowa','korona','miecz','tarcza','zamek','choinka','bałwan','kotwica','latarnia','grzyb',
  'telewizor','komputer','laptop','kubek','widelec','łyżka','nóż','talerz','garnek','patelnia',
  'lampa','świeca','drabina','wiadro','łopata','taczka','płot','studnia','wiatrak','beczka',
  'żagiel','tratwa','helikopter','rakieta','planeta','kometa','śnieżynka','igloo','namiot','ognisko',
  'mapa','kompas','plecak','walizka','aparat','mikrofon','słuchawki','bęben','trąbka','skrzypce',
  'pianino','flet','kaktus','palma','tulipan','róża','słonecznik','liść','szyszka','jeż',
  'wiewiórka','lis','wilk','niedźwiedź','sarna','krowa','świnia','owca','koza','kaczka',
  'kogut','kura','paw','papuga','delfin','wieloryb','rekin','meduza','krab','ślimak',
  'biedronka','mrówka','nietoperz','ośmiornica','muszla','traktor','autobus','taksówka','hulajnoga','deskorolka',
  'okręt','ważka','zegarek','marchewka','truskawka','arbuz','ananas','cytryna','gruszka','winogrono',
];

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
  if (['quiz','bluff','draw'].includes(lobby.game)) return broadcastArcadeLobby(code);
  io.to(code).emit('updateLobby', {
    game: lobby.game,
    admin: lobby.admin,
    players: publicPlayers(lobby),
    categories:          lobby.game === 'panstwa' ? lobby.categories : undefined,
    availableCategories: lobby.game === 'panstwa' ? lobby.availableCategories : undefined,
    maxRounds:           lobby.game === 'panstwa' ? lobby.maxRounds : undefined,
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

// Tally votes on an answer. Each voter contributes at most one accept or reject.
function pmVoteCounts(lobby, key) {
  const votes = lobby.reviewVotes[key] || {};
  let accept = 0, reject = 0;
  Object.values(votes).forEach(v => { if (v === 'accept') accept++; else if (v === 'reject') reject++; });
  return { accept, reject };
}

// Graded scoring. A valid answer starts at a cap (10, or 5 when the same word
// was given by more than one player). Every *net* downvote lowers it one step
// of 5 (10→5→0); upvotes raise it back up to the cap. If nobody voted and the
// AI flagged it invalid, that counts as a single downvote step.
function pmAnswerPoints(lobby, entry, isDuplicate) {
  if (!entry.eligible) return 0;
  const { accept, reject } = pmVoteCounts(lobby, entry.key);
  const cap = isDuplicate ? POINT_STEP : POINT_STEP * 2;   // 5 or 10
  let effReject = reject;
  if (accept === 0 && reject === 0) {
    const ai = lobby.aiVerdicts[entry.key];
    if (ai && ai.valid === false) effReject = 1;
  }
  const steps = Math.max(0, effReject - accept);
  return Math.max(0, cap - POINT_STEP * steps);
}

// Build the full results object from the current review state (no mutation).
function pmComputeResults(lobby) {
  const { categories } = lobby.reviewData;
  const results = {};
  categories.forEach(cat => {
    const entries = lobby.reviewData.entries[cat];
    const counts = {};
    entries.forEach(e => { if (e.eligible) counts[e.norm] = (counts[e.norm] || 0) + 1; });
    results[cat] = entries.map(e => {
      const duplicate = e.eligible && counts[e.norm] > 1;
      const { accept, reject } = pmVoteCounts(lobby, e.key);
      const points = pmAnswerPoints(lobby, e, duplicate);
      const cap = duplicate ? POINT_STEP : POINT_STEP * 2;
      const ai = lobby.aiVerdicts[e.key] || null;
      return {
        key: e.key, playerId: e.playerId, nickname: e.nickname, answer: e.answer,
        eligible: e.eligible, duplicate, valid: points > 0,
        points, cap, accept, reject,
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
    round: lobby.round,
    maxRounds: lobby.maxRounds,
    isLastRound: lobby.round >= lobby.maxRounds,
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
    round: lobby.round, maxRounds: lobby.maxRounds, letter: lobby.currentLetter,
    categories: lobby.categories, endsAt: lobby.roundEndsAt,
  });
}

// ─── ARCADE GAMES (Quiz / Zmyślacz / Kalambury) ─────────────────────────────

const QUIZ_Q_MS      = 20_000;
const QUIZ_REVEAL_MS = 4_500;
const BLUFF_WRITE_MS = 55_000;
const BLUFF_GUESS_MS = 40_000;
const BLUFF_REVEAL_MS= 8_000;
const DRAW_MS        = 80_000;
const DRAW_REVEAL_MS = 5_000;

const ARCADE_SETTING_OPTIONS = {
  quiz:  { key: 'questions', label: 'Liczba pytań',       values: [5, 10, 15] },
  bluff: { key: 'rounds',    label: 'Liczba rund',        values: [3, 5, 8] },
  draw:  { key: 'laps',      label: 'Rund na gracza',     values: [1, 2, 3] },
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function scoreboardOf(lobby) {
  return lobby.players
    .map(p => ({ id: p.playerId, nickname: p.nickname, connected: p.connected, score: p.score }))
    .sort((a, b) => b.score - a.score);
}
function arcadePlayers(lobby) {
  return lobby.players.map(p => ({ id: p.playerId, nickname: p.nickname, connected: p.connected }));
}
function clearGameTimer(lobby) {
  if (lobby.timer) { clearTimeout(lobby.timer); lobby.timer = null; }
}
function broadcastArcadeLobby(code) {
  const lobby = lobbies[code];
  if (!lobby) return;
  io.to(code).emit('arcadeLobby', {
    game: lobby.game, admin: lobby.admin, players: arcadePlayers(lobby),
    settings: lobby.settings, settingOptions: ARCADE_SETTING_OPTIONS[lobby.game], code,
  });
}
function connectedNonDrawer(lobby) {
  return lobby.players.filter(p => p.connected && p.playerId !== lobby.drawerId).length;
}

// ── QUIZ ─────────────────────────────────────────────────────────────────────
function quizStart(code) {
  const lobby = lobbies[code];
  const n = Math.min(lobby.settings.questions, QUIZ_QUESTIONS.length);
  lobby.questions = shuffle(QUIZ_QUESTIONS).slice(0, n);
  lobby.qIndex = -1;
  lobby.players.forEach(p => { p.score = 0; });
  quizNextQuestion(code);
}
function quizNextQuestion(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.qIndex += 1;
  if (lobby.qIndex >= lobby.questions.length) return quizFinish(code);
  const q = lobby.questions[lobby.qIndex];
  lobby.phase    = 'question';
  lobby.answers  = {};                       // playerId → { choice, at }
  lobby.qEndsAt  = Date.now() + QUIZ_Q_MS;
  io.to(code).emit('quizQuestion', {
    index: lobby.qIndex, total: lobby.questions.length,
    question: q.q, options: q.o, endsAt: lobby.qEndsAt,
  });
  lobby.timer = setTimeout(() => quizReveal(code), QUIZ_Q_MS);
}
function quizReveal(code) {
  const lobby = lobbies[code];
  if (!lobby || lobby.phase !== 'question') return;
  clearGameTimer(lobby);
  lobby.phase = 'reveal';
  const q = lobby.questions[lobby.qIndex];
  const perPlayer = {};
  lobby.players.forEach(p => {
    const a = lobby.answers[p.playerId];
    let gained = 0;
    if (a && a.choice === q.c) {
      const frac = Math.max(0, Math.min(1, (lobby.qEndsAt - a.at) / QUIZ_Q_MS));
      gained = 500 + Math.round(500 * frac);
      p.score += gained;
    }
    perPlayer[p.playerId] = { choice: a ? a.choice : null, gained };
  });
  io.to(code).emit('quizReveal', {
    correct: q.c, options: q.o, perPlayer,
    scoreboard: scoreboardOf(lobby),
    last: lobby.qIndex >= lobby.questions.length - 1,
  });
  lobby.timer = setTimeout(() => {
    if (lobby.qIndex >= lobby.questions.length - 1) quizFinish(code);
    else quizNextQuestion(code);
  }, QUIZ_REVEAL_MS);
}
function quizFinish(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.phase = 'finished';
  io.to(code).emit('arcadeFinished', { game: 'quiz', scoreboard: scoreboardOf(lobby) });
}

// ── ZMYŚLACZ (bluff) ─────────────────────────────────────────────────────────
function bluffStart(code) {
  const lobby = lobbies[code];
  const n = Math.min(lobby.settings.rounds, BLUFF_QUESTIONS.length);
  lobby.questions = shuffle(BLUFF_QUESTIONS).slice(0, n);
  lobby.qIndex = -1;
  lobby.players.forEach(p => { p.score = 0; });
  bluffBeginWriting(code);
}
function bluffBeginWriting(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.qIndex += 1;
  if (lobby.qIndex >= lobby.questions.length) return bluffFinish(code);
  lobby.phase   = 'writing';
  lobby.fakes   = {};   // playerId → text
  lobby.guesses = {};   // playerId → optionId
  lobby.foundTruth = {};
  lobby.endsAt  = Date.now() + BLUFF_WRITE_MS;
  io.to(code).emit('bluffWrite', {
    index: lobby.qIndex, total: lobby.questions.length,
    question: lobby.questions[lobby.qIndex].q, endsAt: lobby.endsAt,
  });
  lobby.timer = setTimeout(() => bluffToGuessing(code), BLUFF_WRITE_MS);
}
function bluffToGuessing(code) {
  const lobby = lobbies[code];
  if (!lobby || lobby.phase !== 'writing') return;
  clearGameTimer(lobby);
  lobby.phase = 'guessing';
  const real = lobby.questions[lobby.qIndex].a;
  const realNorm = normalizeAnswer(real);
  // Build options: the real answer + each player's (non-truth) fake.
  const opts = [{ id: 'REAL', text: real, ownerId: null }];
  lobby.players.forEach(p => {
    const raw = (lobby.fakes[p.playerId] || '').trim();
    if (!raw) return;
    if (normalizeAnswer(raw) === realNorm) { lobby.foundTruth[p.playerId] = true; return; }
    opts.push({ id: p.playerId, text: raw, ownerId: p.playerId });
  });
  lobby.options = shuffle(opts);
  lobby.endsAt  = Date.now() + BLUFF_GUESS_MS;
  // Each player sees the options but not who wrote them; their own fake is flagged.
  lobby.players.forEach(p => {
    io.to(p.socketId).emit('bluffGuess', {
      index: lobby.qIndex, total: lobby.questions.length,
      question: lobby.questions[lobby.qIndex].q,
      options: lobby.options.map(o => ({ id: o.id, text: o.text, mine: o.ownerId === p.playerId })),
      foundTruth: !!lobby.foundTruth[p.playerId],
      endsAt: lobby.endsAt,
    });
  });
  lobby.timer = setTimeout(() => bluffReveal(code), BLUFF_GUESS_MS);
}
function bluffReveal(code) {
  const lobby = lobbies[code];
  if (!lobby || lobby.phase !== 'guessing') return;
  clearGameTimer(lobby);
  lobby.phase = 'reveal';
  const gained = {};
  lobby.players.forEach(p => { gained[p.playerId] = 0; });
  // Truth-finders bonus.
  Object.keys(lobby.foundTruth).forEach(pid => { if (gained[pid] != null) gained[pid] += 500; });
  // Score guesses.
  Object.entries(lobby.guesses).forEach(([voterId, optId]) => {
    if (optId === 'REAL') { if (gained[voterId] != null) gained[voterId] += 1000; }
    else if (gained[optId] != null) gained[optId] += 500;   // fooled someone → author scores
  });
  lobby.players.forEach(p => { p.score += gained[p.playerId] || 0; });
  // Build a readable reveal: each option, its author, and who picked it.
  const pickedBy = {};
  lobby.options.forEach(o => { pickedBy[o.id] = []; });
  Object.entries(lobby.guesses).forEach(([voterId, optId]) => {
    const voter = lobby.players.find(p => p.playerId === voterId);
    if (pickedBy[optId]) pickedBy[optId].push(voter?.nickname ?? '?');
  });
  const reveal = lobby.options.map(o => ({
    id: o.id, text: o.text,
    author: o.ownerId ? (lobby.players.find(p => p.playerId === o.ownerId)?.nickname ?? '?') : 'PRAWDA',
    isReal: o.id === 'REAL',
    pickedBy: pickedBy[o.id] || [],
  }));
  io.to(code).emit('bluffReveal', {
    question: lobby.questions[lobby.qIndex].q, real: lobby.questions[lobby.qIndex].a,
    reveal, gained, scoreboard: scoreboardOf(lobby),
    last: lobby.qIndex >= lobby.questions.length - 1,
  });
  lobby.timer = setTimeout(() => {
    if (lobby.qIndex >= lobby.questions.length - 1) bluffFinish(code);
    else bluffBeginWriting(code);
  }, BLUFF_REVEAL_MS);
}
function bluffFinish(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.phase = 'finished';
  io.to(code).emit('arcadeFinished', { game: 'bluff', scoreboard: scoreboardOf(lobby) });
}
// Advance early once everyone (still connected) has acted.
function bluffMaybeAdvanceWrite(code) {
  const lobby = lobbies[code];
  const need = lobby.players.filter(p => p.connected).length;
  const have = lobby.players.filter(p => p.connected && (lobby.fakes[p.playerId] || '').trim()).length;
  if (have >= need && need > 0) bluffToGuessing(code);
}
function bluffMaybeAdvanceGuess(code) {
  const lobby = lobbies[code];
  const need = lobby.players.filter(p => p.connected).length;
  const have = lobby.players.filter(p => p.connected && lobby.guesses[p.playerId]).length;
  if (have >= need && need > 0) bluffReveal(code);
}

// ── KALAMBURY (draw & guess) ─────────────────────────────────────────────────
function drawStart(code) {
  const lobby = lobbies[code];
  lobby.players.forEach(p => { p.score = 0; });
  lobby.order      = shuffle(lobby.players.map(p => p.playerId));
  lobby.turnIndex  = -1;
  lobby.totalTurns = lobby.order.length * lobby.settings.laps;
  lobby.turnNo     = 0;
  drawNextTurn(code);
}
function drawNextTurn(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.turnNo += 1;
  if (lobby.turnNo > lobby.totalTurns) return drawFinish(code);
  // Pick next connected drawer.
  let guard = 0;
  do { lobby.turnIndex = (lobby.turnIndex + 1) % lobby.order.length; guard++; }
  while (guard <= lobby.order.length && !lobby.players.find(p => p.playerId === lobby.order[lobby.turnIndex] && p.connected));
  lobby.drawerId  = lobby.order[lobby.turnIndex];
  lobby.word      = DRAW_WORDS[Math.floor(Math.random() * DRAW_WORDS.length)];
  lobby.guessed   = {};        // playerId → order index of correct guess
  lobby.correctCount = 0;
  lobby.strokes   = [];        // for late joiners / rejoins
  lobby.phase     = 'drawing';
  lobby.endsAt    = Date.now() + DRAW_MS;
  const drawer = lobby.players.find(p => p.playerId === lobby.drawerId);
  lobby.players.forEach(p => {
    io.to(p.socketId).emit('drawTurn', {
      turnNo: lobby.turnNo, totalTurns: lobby.totalTurns,
      drawerId: lobby.drawerId, drawerNick: drawer?.nickname ?? '?',
      amDrawer: p.playerId === lobby.drawerId,
      word: p.playerId === lobby.drawerId ? lobby.word : null,
      wordLen: lobby.word.length, endsAt: lobby.endsAt,
      scoreboard: scoreboardOf(lobby),
    });
  });
  lobby.timer = setTimeout(() => drawEndTurn(code, 'timeout'), DRAW_MS);
}
function drawEndTurn(code, reason) {
  const lobby = lobbies[code];
  if (!lobby || lobby.phase !== 'drawing') return;
  clearGameTimer(lobby);
  lobby.phase = 'reveal';
  io.to(code).emit('drawReveal', {
    word: lobby.word, reason,
    scoreboard: scoreboardOf(lobby),
    last: lobby.turnNo >= lobby.totalTurns,
  });
  lobby.timer = setTimeout(() => {
    if (lobby.turnNo >= lobby.totalTurns) drawFinish(code);
    else drawNextTurn(code);
  }, DRAW_REVEAL_MS);
}
function drawFinish(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.phase = 'finished';
  io.to(code).emit('arcadeFinished', { game: 'draw', scoreboard: scoreboardOf(lobby) });
}

// Full snapshot for a reconnecting arcade player.
function arcadeRejoinSnapshot(lobby, pid, isAdmin, code) {
  const base = {
    game: lobby.game, code, isAdmin, phase: lobby.phase,
    settings: lobby.settings, settingOptions: ARCADE_SETTING_OPTIONS[lobby.game],
    players: arcadePlayers(lobby), scoreboard: scoreboardOf(lobby),
  };
  if (lobby.phase === 'waiting' || lobby.phase === 'finished') return base;
  if (lobby.game === 'quiz') {
    const q = lobby.questions[lobby.qIndex];
    if (lobby.phase === 'question') return { ...base, index: lobby.qIndex, total: lobby.questions.length, question: q.q, options: q.o, endsAt: lobby.qEndsAt, youAnswered: !!lobby.answers[pid] };
    if (lobby.phase === 'reveal')   return { ...base, index: lobby.qIndex, total: lobby.questions.length, question: q.q, options: q.o, correct: q.c };
  } else if (lobby.game === 'bluff') {
    const q = lobby.questions[lobby.qIndex];
    if (lobby.phase === 'writing')  return { ...base, index: lobby.qIndex, total: lobby.questions.length, question: q.q, endsAt: lobby.endsAt, submitted: !!(lobby.fakes[pid] || '').trim() };
    if (lobby.phase === 'guessing') return { ...base, index: lobby.qIndex, total: lobby.questions.length, question: q.q, endsAt: lobby.endsAt, options: lobby.options.map(o => ({ id: o.id, text: o.text, mine: o.ownerId === pid })), foundTruth: !!lobby.foundTruth[pid], picked: lobby.guesses[pid] || null };
    if (lobby.phase === 'reveal')   return { ...base, question: q.q, real: q.a };
  } else if (lobby.game === 'draw') {
    if (lobby.phase === 'drawing') {
      const drawer = lobby.players.find(p => p.playerId === lobby.drawerId);
      return { ...base, turnNo: lobby.turnNo, totalTurns: lobby.totalTurns, drawerId: lobby.drawerId, drawerNick: drawer?.nickname ?? '?', amDrawer: pid === lobby.drawerId, word: pid === lobby.drawerId ? lobby.word : null, wordLen: lobby.word.length, endsAt: lobby.endsAt, strokes: lobby.strokes, alreadyGuessed: !!lobby.guessed[pid] };
    }
    if (lobby.phase === 'reveal') return { ...base, word: lobby.word };
  }
  return base;
}

// ─── SOCKET EVENTS ───────────────────────────────────────────────────────────

io.on('connection', socket => {

  // CREATE LOBBY
  socket.on('createLobby', ({ nickname, playerId, game }) => {
    const pid      = playerId || generateId();
    const code     = generateCode();
    const valid    = ['czolko','panstwa','quiz','bluff','draw'];
    const gameType = valid.includes(game) ? game : 'czolko';

    const basePlayer = { playerId: pid, socketId: socket.id, nickname, connected: true, disconnectTimer: null, word: null, score: 0 };

    if (gameType === 'czolko') {
      lobbies[code] = { game: 'czolko', admin: pid, players: [basePlayer], phase: 'waiting', assignments: [], assignTimeout: null, winner: null, endVotes: {}, endVoteTimeout: null };
    } else if (gameType === 'panstwa') {
      lobbies[code] = { game: 'panstwa', admin: pid, players: [basePlayer], phase: 'waiting', categories: DEFAULT_CATEGORIES.slice(), availableCategories: ALL_CATEGORIES.slice(), maxRounds: DEFAULT_MAX_ROUNDS, round: 0, currentLetter: null, answers: {}, roundTimeout: null, roundEndsAt: 0, stopping: false, lastResults: null, reviewData: null, reviewVotes: {}, aiVerdicts: {}, roundFinalized: false };
    } else {
      const settings = gameType === 'quiz'  ? { questions: 10 }
                     : gameType === 'bluff' ? { rounds: 5 }
                     :                        { laps: 2 };
      lobbies[code] = { game: gameType, admin: pid, players: [basePlayer], phase: 'waiting', settings, timer: null };
    }

    socket.join(code);
    socket.lobbyCode = code;
    socket.playerId  = pid;
    socket.emit('lobbyCreated', {
      code, playerId: pid, game: gameType,
      allCategories: gameType === 'panstwa' ? lobbies[code].availableCategories : undefined,
      maxRounds:     gameType === 'panstwa' ? lobbies[code].maxRounds : undefined,
      roundOptions:  gameType === 'panstwa' ? ROUND_OPTIONS : undefined,
      settings:      lobbies[code].settings,
      settingOptions: ARCADE_SETTING_OPTIONS[gameType],
    });
    if (['quiz','bluff','draw'].includes(gameType)) broadcastArcadeLobby(code);
    else broadcastLobby(code);
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
    socket.emit('joinedLobby', {
      code, playerId: pid, game: lobby.game,
      allCategories: lobby.game === 'panstwa' ? lobby.availableCategories : undefined,
      maxRounds:     lobby.game === 'panstwa' ? lobby.maxRounds : undefined,
      roundOptions:  lobby.game === 'panstwa' ? ROUND_OPTIONS : undefined,
      settings:      lobby.settings,
      settingOptions: ARCADE_SETTING_OPTIONS[lobby.game],
    });
    if (['quiz','bluff','draw'].includes(lobby.game)) broadcastArcadeLobby(code);
    else broadcastLobby(code);
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

    if (['quiz','bluff','draw'].includes(lobby.game)) {
      socket.emit('arcadeRejoin', arcadeRejoinSnapshot(lobby, playerId, isAdmin, code));
      broadcastArcadeLobby(code);
      return;
    }

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
      const extra = { allCategories: lobby.availableCategories, categories: lobby.categories, maxRounds: lobby.maxRounds, roundOptions: ROUND_OPTIONS, scoreboard: publicPlayers(lobby).sort((a,b) => b.score - a.score) };
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
    const clean = (categories || []).filter(c => lobby.availableCategories.includes(c));
    if (clean.length < 3) return socket.emit('error', 'Wybierz minimum 3 kategorie!');
    lobby.categories = clean;
    broadcastLobby(code);
  });

  // Admin adds a custom category (auto-selected once created).
  socket.on('addCustomCategory', ({ name }) => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    let clean = (name || '').replace(/[^\p{L}\p{N} \-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_CUSTOM_CAT_LEN);
    if (!clean) return socket.emit('error', 'Wpisz poprawną nazwę kategorii!');
    // Case-insensitive duplicate check against existing categories.
    if (lobby.availableCategories.some(c => c.toLowerCase() === clean.toLowerCase()))
      return socket.emit('error', 'Taka kategoria już istnieje!');
    if (lobby.availableCategories.length >= ALL_CATEGORIES.length + 12)
      return socket.emit('error', 'Za dużo własnych kategorii!');
    lobby.availableCategories.push(clean);
    if (lobby.categories.length < MAX_CATEGORIES) lobby.categories.push(clean);
    broadcastLobby(code);
  });

  // Admin picks how many rounds the game lasts.
  socket.on('setRoundCount', ({ count }) => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    if (!ROUND_OPTIONS.includes(count)) return;
    lobby.maxRounds = count;
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
    let action;
    if (bucket[socket.playerId] === vote) { delete bucket[socket.playerId]; action = 'cancel'; }   // toggle off
    else { bucket[socket.playerId] = vote; action = vote; }

    pmBroadcastReview(code);

    // Notify everyone who voted on what.
    const voter = lobby.players.find(p => p.playerId === socket.playerId);
    io.to(code).emit('voteNotice', {
      voterId: socket.playerId,
      voter:   voter?.nickname ?? '?',
      target:  entry.nickname,
      category,
      answer:  entry.answer,
      action,   // 'accept' | 'reject' | 'cancel'
    });
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
    // Stop automatically once the configured number of rounds has been played.
    if (lobby.round >= lobby.maxRounds) {
      lobby.phase = 'finished';
      io.to(code).emit('gameEnded', { scoreboard: publicPlayers(lobby).sort((a,b) => b.score - a.score) });
      return;
    }
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

  // ── ARCADE GAMES (Quiz / Zmyślacz / Kalambury) ──────────────────────────────

  const isArcade = l => l && ['quiz','bluff','draw'].includes(l.game);

  socket.on('arcadeSetting', ({ value }) => {
    const lobby = lobbies[socket.lobbyCode];
    if (!isArcade(lobby) || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    const opt = ARCADE_SETTING_OPTIONS[lobby.game];
    if (!opt.values.includes(value)) return;
    lobby.settings[opt.key] = value;
    broadcastArcadeLobby(socket.lobbyCode);
  });

  socket.on('arcadeStart', () => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!isArcade(lobby) || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    if (lobby.players.length < 2) return socket.emit('error', 'Potrzeba minimum 2 graczy!');
    if (lobby.game === 'quiz')  quizStart(code);
    else if (lobby.game === 'bluff') bluffStart(code);
    else drawStart(code);
  });

  socket.on('arcadePlayAgain', () => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!isArcade(lobby) || lobby.admin !== socket.playerId || lobby.phase !== 'finished') return;
    clearGameTimer(lobby);
    lobby.phase = 'waiting';
    lobby.players.forEach(p => { p.score = 0; });
    io.to(code).emit('arcadeReturnLobby');
    broadcastArcadeLobby(code);
  });

  // QUIZ
  socket.on('quizAnswer', ({ choice }) => {
    const lobby = lobbies[socket.lobbyCode];
    if (!lobby || lobby.game !== 'quiz' || lobby.phase !== 'question' || !socket.playerId) return;
    if (lobby.answers[socket.playerId]) return;                 // already answered
    if (typeof choice !== 'number' || choice < 0 || choice > 3) return;
    lobby.answers[socket.playerId] = { choice, at: Date.now() };
    const answered = Object.keys(lobby.answers).length;
    io.to(socket.lobbyCode).emit('quizProgress', { answered, total: lobby.players.filter(p => p.connected).length });
    if (answered >= lobby.players.filter(p => p.connected).length) quizReveal(socket.lobbyCode);
  });

  // ZMYŚLACZ
  socket.on('bluffSubmitFake', ({ text }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'bluff' || lobby.phase !== 'writing' || !socket.playerId) return;
    const clean = (text || '').trim().slice(0, 60);
    if (!clean) return;
    lobby.fakes[socket.playerId] = clean;
    const need = lobby.players.filter(p => p.connected).length;
    const have = lobby.players.filter(p => p.connected && (lobby.fakes[p.playerId] || '').trim()).length;
    io.to(code).emit('bluffWriteProgress', { have, need });
    bluffMaybeAdvanceWrite(code);
  });

  socket.on('bluffPick', ({ optionId }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'bluff' || lobby.phase !== 'guessing' || !socket.playerId) return;
    const opt = (lobby.options || []).find(o => o.id === optionId);
    if (!opt || opt.ownerId === socket.playerId) return;        // can't pick your own fake
    lobby.guesses[socket.playerId] = optionId;
    const need = lobby.players.filter(p => p.connected).length;
    const have = lobby.players.filter(p => p.connected && lobby.guesses[p.playerId]).length;
    io.to(code).emit('bluffGuessProgress', { have, need });
    bluffMaybeAdvanceGuess(code);
  });

  // KALAMBURY
  socket.on('drawStroke', (data) => {
    const lobby = lobbies[socket.lobbyCode];
    if (!lobby || lobby.game !== 'draw' || lobby.phase !== 'drawing' || socket.playerId !== lobby.drawerId) return;
    if (!data || typeof data !== 'object') return;
    lobby.strokes.push(data);
    if (lobby.strokes.length > 4000) lobby.strokes.shift();     // cap memory
    socket.to(socket.lobbyCode).emit('drawStroke', data);       // to everyone except drawer
  });

  socket.on('drawClear', () => {
    const lobby = lobbies[socket.lobbyCode];
    if (!lobby || lobby.game !== 'draw' || lobby.phase !== 'drawing' || socket.playerId !== lobby.drawerId) return;
    lobby.strokes = [];
    socket.to(socket.lobbyCode).emit('drawClear');
  });

  socket.on('drawGuess', ({ text }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'draw' || lobby.phase !== 'drawing' || !socket.playerId) return;
    if (socket.playerId === lobby.drawerId) return;             // drawer can't guess
    const guess = (text || '').trim().slice(0, 40);
    if (!guess) return;
    const me = lobby.players.find(p => p.playerId === socket.playerId);
    if (lobby.guessed[socket.playerId]) return;                 // already got it

    if (normalizeAnswer(guess) === normalizeAnswer(lobby.word)) {
      lobby.correctCount += 1;
      lobby.guessed[socket.playerId] = lobby.correctCount;
      const gPts = Math.max(60, 140 - 20 * (lobby.correctCount - 1));
      me.score += gPts;
      const drawer = lobby.players.find(p => p.playerId === lobby.drawerId);
      if (drawer) drawer.score += 40;
      io.to(code).emit('drawGuessed', {
        id: me.playerId, nick: me.nickname, order: lobby.correctCount,
        scoreboard: scoreboardOf(lobby),
      });
      // End the turn once everyone who can guess has guessed.
      const remaining = connectedNonDrawer(lobby) - Object.keys(lobby.guessed).length;
      if (remaining <= 0) drawEndTurn(code, 'all-guessed');
    } else {
      // Broadcast as a normal chat message (a wrong guess).
      io.to(code).emit('drawChat', { nick: me.nickname, text: guess });
    }
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
      if (lobby.timer)           clearTimeout(lobby.timer);
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
    // If the drawer left mid-turn, end the turn so the game keeps moving.
    if (lobby.game === 'draw' && lobby.phase === 'drawing' && lobby.drawerId === pid) drawEndTurn(code, 'drawer-left');
    else if (lobby.game === 'bluff' && lobby.phase === 'writing')  bluffMaybeAdvanceWrite(code);
    else if (lobby.game === 'bluff' && lobby.phase === 'guessing') bluffMaybeAdvanceGuess(code);
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
        if (lobby.timer)           clearTimeout(lobby.timer);
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
