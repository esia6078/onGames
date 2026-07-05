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
const ROUND_MS            = 120_000;           // 2 min (default round length)
const ROUND_MS_MIN        = 30_000;            // 30 s minimum
const ROUND_MS_MAX        = 300_000;           // 5 min maximum
const ROUND_MS_STEP       = 15_000;            // ±15 s per tap
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
const ARCADE_GAME_TYPES   = ['quiz','bluff','draw','truths','assoc','who','dance'];
const DANCE_TRACK_COUNT   = 269;  // must match DANCE_SONGS length on the client

// ─── ARCADE GAMES DATA ──────────────────────────────────────────────────────
// Poziom ŁATWY – dla każdego, bardzo proste.
const QUIZ_EASY_QUESTIONS = [
  { q: 'Jakiego koloru jest banan?',               o: ['Żółty','Niebieski','Czarny','Fioletowy'],           c: 0 },
  { q: 'Jakiego koloru jest dojrzały pomidor?',    o: ['Czerwony','Niebieski','Czarny','Biały'],            c: 0 },
  { q: 'Jakiego koloru jest cytryna?',             o: ['Żółty','Czerwony','Niebieski','Zielony'],           c: 0 },
  { q: 'Jakiego koloru jest śnieg?',               o: ['Biały','Czarny','Zielony','Czerwony'],              c: 0 },
  { q: 'Jakiego koloru jest trawa?',               o: ['Zielona','Niebieska','Czarna','Żółta'],             c: 0 },
  { q: 'Ile to jest 2 + 2?',                       o: ['4','3','5','22'],                                   c: 0 },
  { q: 'Ile to jest 5 + 5?',                       o: ['10','15','25','50'],                                c: 0 },
  { q: 'Ile to jest 10 − 3?',                      o: ['7','6','8','13'],                                   c: 0 },
  { q: 'Ile to jest 3 × 2?',                       o: ['6','5','8','9'],                                    c: 0 },
  { q: 'Ile to jest 4 × 2?',                       o: ['8','6','10','4'],                                   c: 0 },
  { q: 'Ile to jest połowa z 10?',                 o: ['5','2','10','15'],                                  c: 0 },
  { q: 'Ile nóg ma pies?',                         o: ['4','2','6','3'],                                    c: 0 },
  { q: 'Ile nóg ma pająk?',                        o: ['8','6','4','10'],                                   c: 0 },
  { q: 'Ile nóg ma kura?',                         o: ['2','4','6','3'],                                    c: 0 },
  { q: 'Ile palców ma jedna dłoń?',                o: ['5','4','6','10'],                                   c: 0 },
  { q: 'Co robi krowa?',                           o: ['Muczy','Szczeka','Miauczy','Rży'],                  c: 0 },
  { q: 'Co robi kaczka?',                          o: ['Kwacze','Szczeka','Muczy','Miauczy'],               c: 0 },
  { q: 'Gdzie mieszka ryba?',                      o: ['W wodzie','W lesie','Na drzewie','W piasku'],       c: 0 },
  { q: 'Które to zwierzę ma trąbę?',               o: ['Słoń','Mysz','Kot','Żaba'],                         c: 0 },
  { q: 'Jak nazywa się król zwierząt?',            o: ['Lew','Kot','Pies','Mysz'],                          c: 0 },
  { q: 'Czym jeździ się po torach?',               o: ['Pociąg','Samolot','Statek','Rower'],                c: 0 },
  { q: 'Ile kół ma samochód osobowy?',             o: ['4','2','3','6'],                                    c: 0 },
  { q: 'Ile kół ma rower?',                        o: ['2','4','1','3'],                                    c: 0 },
  { q: 'Co świeci w dzień na niebie?',             o: ['Słońce','Księżyc','Gwiazdy','Lampa'],               c: 0 },
  { q: 'Co świeci w nocy na niebie?',              o: ['Księżyc','Słońce','Tęcza','Chmura'],                c: 0 },
  { q: 'Pora roku, gdy pada śnieg?',               o: ['Zima','Lato','Wiosna','Jesień'],                    c: 0 },
  { q: 'Pora roku, gdy jest najgoręcej?',          o: ['Lato','Zima','Jesień','Wiosna'],                    c: 0 },
  { q: 'Czym widzimy?',                            o: ['Oczami','Uszami','Nosem','Rękami'],                 c: 0 },
  { q: 'Czym słyszymy?',                           o: ['Uszami','Oczami','Nosem','Nogami'],                 c: 0 },
  { q: 'Czym wąchamy?',                            o: ['Nosem','Uszami','Oczami','Rękami'],                 c: 0 },
  { q: 'Gdzie kupujemy jedzenie?',                 o: ['Sklep','Szkoła','Kino','Basen'],                    c: 0 },
  { q: 'Gdzie się uczymy?',                        o: ['Szkoła','Sklep','Szpital','Stadion'],               c: 0 },
  { q: 'Kto leczy zwierzęta?',                     o: ['Weterynarz','Dentysta','Fryzjer','Kucharz'],        c: 0 },
  { q: 'Kto roznosi listy?',                       o: ['Listonosz','Strażak','Piekarz','Malarz'],           c: 0 },
  { q: 'Co daje krowa?',                           o: ['Mleko','Jajka','Wełnę','Miód'],                     c: 0 },
  { q: 'Co daje owca?',                            o: ['Wełnę','Jajka','Miód','Sok'],                       c: 0 },
  { q: 'Co robi pszczoła?',                        o: ['Robi miód','Szczeka','Pływa','Rży'],                c: 0 },
  { q: 'Co nosi król na głowie?',                  o: ['Koronę','Kask','Czapkę z daszkiem','Kapelusz'],     c: 0 },
  { q: 'Czym piszemy?',                            o: ['Długopisem','Widelcem','Młotkiem','Garnkiem'],      c: 0 },
  { q: 'Co zakładamy na nogi?',                    o: ['Buty','Czapkę','Rękawiczki','Okulary'],             c: 0 },
  { q: 'Co zakładamy na głowę?',                   o: ['Czapkę','Buty','Skarpetki','Rękawiczki'],           c: 0 },
  { q: 'Ile dni ma weekend?',                      o: ['2','1','3','5'],                                    c: 0 },
  { q: 'Ile minut ma kwadrans?',                   o: ['15','30','45','60'],                                c: 0 },
  { q: 'Który to owoc?',                           o: ['Jabłko','Marchewka','Ziemniak','Cebula'],           c: 0 },
  { q: 'Które to warzywo?',                        o: ['Marchewka','Banan','Truskawka','Winogrono'],        c: 0 },
  { q: 'Jaki napój robi się z jabłek?',            o: ['Sok jabłkowy','Mleko','Kawa','Ocet'],               c: 0 },
  { q: 'Jaki kształt ma piłka?',                   o: ['Okrągły','Kwadratowy','Trójkątny','Prosty'],        c: 0 },
  { q: 'Ile boków ma trójkąt?',                    o: ['3','4','5','6'],                                    c: 0 },
  { q: 'Ile boków ma kwadrat?',                    o: ['4','3','5','6'],                                    c: 0 },
  { q: 'Gdzie śpi człowiek?',                      o: ['W łóżku','W wannie','W lodówce','Na drzewie'],      c: 0 },
  { q: 'Jak nazywa się młody pies?',               o: ['Szczeniak','Kociak','Prosiak','Źrebak'],            c: 0 },
  { q: 'Jak nazywa się młody kot?',                o: ['Kociak','Szczeniak','Kurczak','Cielak'],            c: 0 },
  { q: 'Co robi żaba?',                            o: ['Skacze i kumka','Szczeka','Rży','Kwacze'],          c: 0 },
  { q: 'Ile liter ma słowo „kot"?',                o: ['3','2','4','5'],                                    c: 0 },
  { q: 'Ile to jest tuzin?',                       o: ['12','10','6','20'],                                 c: 0 },
];

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
  { q: 'Stolica Francji?',                         o: ['Lyon','Paryż','Marsylia','Nicea'],                  c: 1 },
  { q: 'Stolica Chin?',                            o: ['Szanghaj','Pekin','Kanton','Hongkong'],             c: 1 },
  { q: 'Stolica Brazylii?',                        o: ['Rio de Janeiro','Brasília','São Paulo','Salvador'], c: 1 },
  { q: 'Stolica Turcji?',                          o: ['Stambuł','Ankara','Izmir','Bursa'],                 c: 1 },
  { q: 'Stolica Indii?',                           o: ['Mumbaj','New Delhi','Kalkuta','Ćennaj'],            c: 1 },
  { q: 'Stolica Argentyny?',                       o: ['Buenos Aires','Córdoba','Rosario','Mendoza'],       c: 0 },
  { q: 'Stolica Holandii?',                        o: ['Rotterdam','Amsterdam','Haga','Utrecht'],           c: 1 },
  { q: 'Stolica Austrii?',                         o: ['Salzburg','Wiedeń','Graz','Linz'],                  c: 1 },
  { q: 'Stolica Szwajcarii?',                      o: ['Zurych','Berno','Genewa','Bazylea'],                c: 1 },
  { q: 'Stolica Danii?',                           o: ['Kopenhaga','Aarhus','Odense','Aalborg'],            c: 0 },
  { q: 'Stolica Finlandii?',                       o: ['Helsinki','Espoo','Tampere','Turku'],               c: 0 },
  { q: 'Stolica Irlandii?',                        o: ['Cork','Dublin','Galway','Limerick'],                c: 1 },
  { q: 'Stolica Islandii?',                        o: ['Reykjavik','Akureyri','Kópavogur','Selfoss'],       c: 0 },
  { q: 'Stolica Belgii?',                          o: ['Antwerpia','Bruksela','Gandawa','Brugia'],          c: 1 },
  { q: 'Ile to jest 6 × 7?',                       o: ['42','48','36','49'],                                c: 0 },
  { q: 'Ile to jest 8 × 9?',                       o: ['72','81','64','79'],                                c: 0 },
  { q: 'Ile to jest 144 : 12?',                    o: ['12','14','11','16'],                                c: 0 },
  { q: 'Ile to jest 25% ze 100?',                  o: ['25','50','20','75'],                                c: 0 },
  { q: 'Ile to jest 3 do potęgi 3?',               o: ['27','9','12','6'],                                  c: 0 },
  { q: 'Ile ścian ma sześcian?',                   o: ['6','4','8','12'],                                    c: 0 },
  { q: 'Ile milimetrów ma centymetr?',             o: ['10','100','5','1'],                                 c: 0 },
  { q: 'Ile gramów ma kilogram?',                  o: ['1000','100','10','500'],                            c: 0 },
  { q: 'Ile centymetrów ma metr?',                 o: ['100','10','1000','50'],                             c: 0 },
  { q: 'Ile dni ma tydzień?',                      o: ['7','5','10','6'],                                    c: 0 },
  { q: 'Ile miesięcy ma rok?',                     o: ['12','10','11','24'],                                c: 0 },
  { q: 'Ile godzin ma doba?',                      o: ['24','12','48','20'],                                c: 0 },
  { q: 'Który zmysł odpowiada za widzenie?',       o: ['Wzrok','Słuch','Smak','Dotyk'],                     c: 0 },
  { q: 'Ile palców ma jedna dłoń?',                o: ['5','4','6','10'],                                    c: 0 },
  { q: 'Które zwierzę miauczy?',                   o: ['Kot','Pies','Krowa','Kura'],                        c: 0 },
  { q: 'Które zwierzę szczeka?',                   o: ['Pies','Kot','Koń','Owca'],                          c: 0 },
  { q: 'Które zwierzę daje mleko?',                o: ['Krowa','Kura','Wąż','Orzeł'],                       c: 0 },
  { q: 'Gdzie żyją pingwiny?',                     o: ['Antarktyda','Sahara','Amazonia','Alpy'],            c: 0 },
  { q: 'Które zwierzę ma trąbę?',                  o: ['Słoń','Żyrafa','Lew','Zebra'],                      c: 0 },
  { q: 'Z czego robi się chleb?',                  o: ['Mąka','Ryż','Ziemniaki','Mleko'],                   c: 0 },
  { q: 'Z czego robi się wino?',                   o: ['Winogrona','Jabłka','Chmiel','Pszenica'],           c: 0 },
  { q: 'Jaki owoc jest żółty i zakrzywiony?',      o: ['Banan','Jabłko','Śliwka','Wiśnia'],                 c: 0 },
  { q: 'Ilu siatkarzy z drużyny jest na boisku?',  o: ['6','5','7','11'],                                   c: 0 },
  { q: 'W jakim sporcie używa się kija i krążka?', o: ['Hokej','Koszykówka','Pływanie','Boks'],             c: 0 },
  { q: 'Ilu koszykarzy z drużyny jest na boisku?', o: ['5','6','7','11'],                                   c: 0 },
  { q: 'Jak nazywają się MŚ w piłce nożnej?',      o: ['Mundial','Wimbledon','Tour de France','Puchar Davisa'], c: 0 },
  { q: 'Największe państwo Europy (powierzchnia)?', o: ['Rosja','Niemcy','Francja','Ukraina'],              c: 0 },
  { q: 'Najdłuższa rzeka Afryki?',                 o: ['Nil','Kongo','Niger','Zambezi'],                    c: 0 },
  { q: 'Na jakim kontynencie leży Egipt?',         o: ['Afryka','Azja','Europa','Ameryka'],                 c: 0 },
  { q: 'Na jakim kontynencie leży Brazylia?',      o: ['Ameryka Południowa','Afryka','Azja','Europa'],      c: 0 },
  { q: 'Ile kolorów ma polska flaga?',             o: ['2','3','1','4'],                                    c: 0 },
  { q: 'Jakie zwierzę jest w godle Polski?',       o: ['Orzeł','Lew','Niedźwiedź','Żubr'],                  c: 0 },
  { q: 'Kto leczy zęby?',                          o: ['Dentysta','Kardiolog','Weterynarz','Okulista'],     c: 0 },
  { q: 'Kto gasi pożary?',                         o: ['Strażak','Policjant','Listonosz','Piekarz'],        c: 0 },
  { q: 'Gdzie pracuje nauczyciel?',                o: ['Szkoła','Szpital','Piekarnia','Fabryka'],           c: 0 },
  { q: 'Gwiazda w centrum Układu Słonecznego?',    o: ['Słońce','Księżyc','Mars','Syriusz'],                c: 0 },
  { q: 'Co krąży wokół Ziemi?',                    o: ['Księżyc','Słońce','Mars','Wenus'],                  c: 0 },
  { q: 'Ile wynosi 10 + 15?',                      o: ['25','20','30','35'],                                c: 0 },
  { q: 'Ile wynosi 100 − 1?',                      o: ['99','90','101','89'],                               c: 0 },
  { q: 'Który miesiąc jest pierwszy w roku?',      o: ['Styczeń','Grudzień','Luty','Marzec'],               c: 0 },
  { q: 'Który miesiąc jest ostatni w roku?',       o: ['Grudzień','Styczeń','Listopad','Październik'],      c: 0 },
  { q: 'Ile kół ma rower?',                        o: ['2','3','4','1'],                                    c: 0 },
  { q: 'Który owoc jest czerwony i rośnie na jabłoni?', o: ['Jabłko','Banan','Cytryna','Kiwi'],             c: 0 },
  { q: 'Jak nazywa się dom pszczół?',              o: ['Ul','Kurnik','Mrowisko','Nora'],                    c: 0 },
  { q: 'Jak nazywa się młode psa?',                o: ['Szczeniak','Kociak','Źrebak','Cielak'],             c: 0 },
  { q: 'Jak nazywa się młode kota?',               o: ['Kociak','Szczeniak','Prosiak','Kurczak'],           c: 0 },
  { q: 'Która pora roku jest najcieplejsza?',      o: ['Lato','Zima','Jesień','Wiosna'],                    c: 0 },
  { q: 'Która pora roku jest najzimniejsza?',      o: ['Zima','Lato','Wiosna','Jesień'],                    c: 0 },
  { q: 'Jakiego koloru jest śnieg?',               o: ['Biały','Czarny','Zielony','Niebieski'],             c: 0 },
  { q: 'Ile nóg ma pies?',                         o: ['4','2','6','8'],                                    c: 0 },
  { q: 'Co daje kura?',                            o: ['Jajka','Mleko','Wełnę','Miód'],                     c: 0 },
  { q: 'Co produkują pszczoły?',                   o: ['Miód','Mleko','Jajka','Ser'],                       c: 0 },
  { q: 'W którym kraju wynaleziono pizzę?',        o: ['Włochy','Francja','Grecja','Hiszpania'],            c: 0 },
  { q: 'Jaki taniec pochodzi z Argentyny?',        o: ['Tango','Walc','Samba','Polka'],                     c: 0 },
  { q: 'Który instrument ma czarno-białe klawisze?', o: ['Pianino','Gitara','Skrzypce','Perkusja'],         c: 0 },
  { q: 'Jak nazywa się słynny detektyw Conan Doyle\'a?', o: ['Sherlock Holmes','Herkules Poirot','James Bond','Zorro'], c: 0 },
  { q: 'Kto napisał „Harry\'ego Pottera"?',        o: ['J.K. Rowling','Tolkien','C.S. Lewis','R. Dahl'],    c: 0 },
  { q: 'Gdzie mieszka Święty Mikołaj (wg legendy)?', o: ['Laponia','Syberia','Grenlandia','Alaska'],        c: 0 },
  { q: 'Ile pierścieni ma flaga olimpijska?',      o: ['5','4','6','3'],                                    c: 0 },
  { q: 'Największy ssak morski?',                  o: ['Płetwal błękitny','Delfin','Rekin','Foka'],         c: 0 },
  { q: 'Które zwierzę zmienia kolor skóry?',       o: ['Kameleon','Żyrafa','Słoń','Krokodyl'],              c: 0 },
  { q: 'Jak nazywa się dom Eskimosów ze śniegu?',  o: ['Igloo','Jurta','Wigwam','Namiot'],                  c: 0 },
  { q: 'W jakim kraju zbudowano Wielki Mur?',      o: ['Chiny','Japonia','Indie','Korea'],                  c: 0 },
  { q: 'Kto namalował „Bitwę pod Grunwaldem"?',    o: ['Jan Matejko','Wyspiański','Malczewski','Kossak'],   c: 0 },
  { q: 'Kto namalował „Damę z gronostajem"?',      o: ['Leonardo da Vinci','Rembrandt','Matejko','Picasso'], c: 0 },
  { q: 'W jakim mieście stoi wieża Eiffla?',       o: ['Paryż','Londyn','Rzym','Berlin'],                   c: 0 },
  { q: 'W którym kraju jest Wielki Kanion?',       o: ['USA','Kanada','Meksyk','Brazylia'],                 c: 0 },
  { q: 'Waluta Wielkiej Brytanii?',               o: ['Funt','Euro','Dolar','Frank'],                      c: 0 },
  { q: 'Które zwierzę jest symbolem WWF?',         o: ['Panda','Lew','Tygrys','Słoń'],                      c: 0 },
  { q: 'Który malarz odciął sobie ucho?',          o: ['Van Gogh','Rembrandt','Vermeer','Mondrian'],        c: 0 },
  { q: 'W jakim mieście stoi Statua Wolności?',    o: ['Nowy Jork','Waszyngton','Chicago','Boston'],        c: 0 },
  { q: 'W którym kraju żyją kangury?',             o: ['Australia','Brazylia','Kenia','Kanada'],            c: 0 },
  { q: 'W którym kraju żyją pandy?',               o: ['Chiny','Japonia','Indie','Tajlandia'],              c: 0 },
  { q: 'Największe państwo Ameryki Południowej?',  o: ['Brazylia','Argentyna','Chile','Peru'],              c: 0 },
  { q: 'Autor „Dziadów"?',                         o: ['Mickiewicz','Słowacki','Norwid','Krasiński'],       c: 0 },
  { q: 'Największa gorąca pustynia świata?',       o: ['Sahara','Gobi','Atakama','Kalahari'],               c: 0 },
  { q: 'Najwyższy budynek świata?',               o: ['Burdż Chalifa','Empire State','Wieża Eiffla','Sears'], c: 0 },
  { q: 'Najszybszy ptak w locie nurkowym?',        o: ['Sokół wędrowny','Orzeł','Jaskółka','Koliber'],      c: 0 },
  { q: 'Które „Wielkie ___" to przydomek Nowego Jorku?', o: ['Jabłko','Winogrono','Pomarańcza','Banan'],    c: 0 },
  { q: 'Polski noblista, autor „Chłopów"?',        o: ['Reymont','Sienkiewicz','Miłosz','Prus'],            c: 0 },
  { q: 'W którym sporcie wykonuje się „slam dunk"?', o: ['Koszykówka','Siatkówka','Piłka nożna','Tenis'],   c: 0 },
  { q: 'Ile zawodników siatkówki jest na boisku?', o: ['6','5','7','11'],                                   c: 0 },
  { q: 'W jakim sporcie gra się rakietką na stole?', o: ['Tenis stołowy','Golf','Hokej','Rugby'],           c: 0 },
  { q: 'Największy ptak nielot?',                  o: ['Struś','Emu','Pingwin','Kiwi'],                     c: 0 },
  { q: 'Jak nazywa się grupa wilków?',             o: ['Wataha','Stado','Rój','Ławica'],                    c: 0 },
  { q: 'Który miesiąc bywa dłuższy w roku przestępnym?', o: ['Luty','Styczeń','Marzec','Kwiecień'],         c: 0 },
  { q: 'Który kraj słynie z serów i wieży Eiffla?', o: ['Francja','Włochy','Szwajcaria','Grecja'],          c: 0 },
  { q: 'Ile lat ma stulecie?',                    o: ['100','10','1000','50'],                             c: 0 },
  { q: 'Dawna dziewiąta „planeta", dziś karłowata?', o: ['Pluton','Ceres','Mars','Eris'],                   c: 0 },
  { q: 'Największe państwo Afryki (powierzchnia)?', o: ['Algieria','Egipt','Nigeria','RPA'],                c: 0 },
  { q: 'Jakim pojazdem lata się w kosmos?',        o: ['Rakieta','Samolot','Balon','Ślizgacz'],             c: 0 },
  { q: 'Ile wynosi 7 + 8?',                        o: ['15','16','14','17'],                                c: 0 },
  { q: 'Który kontynent jest najzimniejszy?',      o: ['Antarktyda','Europa','Afryka','Azja'],              c: 0 },
  { q: 'Kto napisał bajki „Kopciuszek" i „Kot w butach" (zbiór)?', o: ['Charles Perrault','Bracia Grimm','Andersen','Ezop'], c: 0 },
  { q: 'Największa małpa człekokształtna?',        o: ['Goryl','Szympans','Orangutan','Gibon'],             c: 0 },
  { q: 'Który sport rozgrywa się na korcie?',      o: ['Tenis','Hokej','Pływanie','Kolarstwo'],             c: 0 },
];

// Tryb HARDCORE – dużo trudniejsze pytania.
const QUIZ_HARD_QUESTIONS = [
  { q: 'W którym roku odbyła się bitwa pod Wiedniem?',       o: ['1673','1683','1699','1621'],                          c: 1 },
  { q: 'Który pierwiastek ma liczbę atomową 79?',           o: ['Srebro','Złoto','Platyna','Rtęć'],                    c: 1 },
  { q: 'Kto napisał „Boską Komedię"?',                      o: ['Petrarka','Dante','Boccaccio','Wergiliusz'],          c: 1 },
  { q: 'Który malarz namalował „Guernicę"?',                o: ['Dalí','Picasso','Miró','Goya'],                       c: 1 },
  { q: 'Najdłuższa kość w ciele człowieka?',                o: ['Piszczel','Kość udowa','Kość ramienna','Strzałka'],   c: 1 },
  { q: 'Przyspieszenie ziemskie g wynosi ok. … m/s²',       o: ['9,81','10,8','8,9','11,2'],                           c: 0 },
  { q: 'Który władca zapoczątkował unię polsko-litewską?',  o: ['Kazimierz Wielki','Władysław Jagiełło','Chrobry','Zygmunt Stary'], c: 1 },
  { q: 'Kto odkrył penicylinę?',                            o: ['Pasteur','Fleming','Koch','Salk'],                    c: 1 },
  { q: 'Stolica Nowej Zelandii?',                           o: ['Auckland','Wellington','Christchurch','Hamilton'],    c: 1 },
  { q: 'Liczba Eulera „e" wynosi w przybliżeniu…',          o: ['2,72','3,14','1,62','2,30'],                          c: 0 },
  { q: 'Który kraj ma najwięcej czynnych wulkanów?',        o: ['Japonia','Indonezja','USA','Islandia'],               c: 1 },
  { q: 'Autor „Zbrodni i kary"?',                           o: ['Tołstoj','Dostojewski','Czechow','Gogol'],            c: 1 },
  { q: 'Który pierwiastek jest ciekłym niemetalem (20°C)?', o: ['Rtęć','Brom','Jod','Chlor'],                          c: 1 },
  { q: 'W którym roku Gagarin poleciał w kosmos?',          o: ['1961','1957','1969','1959'],                          c: 0 },
  { q: 'Najwyższy szczyt Afryki?',                          o: ['Mount Kenia','Kilimandżaro','Ruwenzori','Atlas'],     c: 1 },
  { q: 'Który organ produkuje insulinę?',                   o: ['Wątroba','Trzustka','Nerki','Śledziona'],             c: 1 },
  { q: 'Który filozof napisał dialog „Państwo"?',           o: ['Arystoteles','Platon','Sokrates','Kant'],             c: 1 },
  { q: 'Pierwiastek o symbolu „W" to…',                     o: ['Wanad','Wolfram','Wapń','Wodór'],                     c: 1 },
  { q: 'Kto sformułował zasadę nieoznaczoności?',           o: ['Bohr','Heisenberg','Schrödinger','Planck'],           c: 1 },
  { q: 'Rów Mariański ma głębokość ok. … m',                o: ['11 000','8 800','6 500','15 000'],                    c: 0 },
  { q: 'Ile ścian ma dwudziestościan foremny?',             o: ['12','20','8','24'],                                   c: 1 },
  { q: 'Suma kątów wewnętrznych pięciokąta wynosi…',        o: ['540°','360°','720°','480°'],                          c: 0 },
  { q: 'Który pierwiastek jest najlżejszy?',                o: ['Hel','Wodór','Lit','Tlen'],                           c: 1 },
  { q: 'Najczęstszy pierwiastek w skorupie ziemskiej?',     o: ['Żelazo','Tlen','Krzem','Glin'],                       c: 1 },
  { q: 'Gdzie mieści się Międzynarodowy Trybunał Sprawiedliwości?', o: ['Haga','Genewa','Nowy Jork','Wiedeń'],         c: 0 },
  { q: 'W którym roku wybuchła rewolucja francuska?',       o: ['1789','1799','1776','1804'],                          c: 0 },
  { q: 'Który kraj podarował USA Statuę Wolności?',         o: ['Wielka Brytania','Francja','Hiszpania','Włochy'],     c: 1 },
  { q: 'Pierwiastek o symbolu „K" to…',                     o: ['Krzem','Potas','Kadm','Kobalt'],                      c: 1 },
  { q: 'Autor „Odysei"?',                                   o: ['Wergiliusz','Homer','Sofokles','Owidiusz'],           c: 1 },
  { q: 'Który kompozytor napisał „Odę do radości" (IX Symfonia)?', o: ['Mozart','Beethoven','Bach','Brahms'],         c: 1 },
  { q: 'W którym roku wybuchło powstanie warszawskie?',     o: ['1944','1943','1939','1945'],                          c: 0 },
  { q: 'Kto był pierwszym cesarzem rzymskim?',              o: ['Juliusz Cezar','Oktawian August','Neron','Kaligula'], c: 1 },
  { q: 'Który pierwiastek ma symbol „Na"?',                 o: ['Azot','Sód','Nikiel','Neon'],                         c: 1 },
  { q: 'Który pierwiastek ma symbol „Pb"?',                 o: ['Platyna','Ołów','Pallad','Polon'],                    c: 1 },
  { q: 'Który pierwiastek ma symbol „Hg"?',                 o: ['Rtęć','Wodór','Hel','Hafn'],                          c: 0 },
  { q: 'Ile wynosi zero absolutne w °C?',                   o: ['-273','-100','-459','0'],                             c: 0 },
  { q: 'Kto napisał „Hamleta"?',                            o: ['Szekspir','Molier','Goethe','Dante'],                 c: 0 },
  { q: 'W którym roku Kolumb dotarł do Ameryki?',           o: ['1492','1498','1453','1519'],                          c: 0 },
  { q: 'Liczba atomowa węgla to…',                          o: ['6','12','8','14'],                                    c: 0 },
  { q: 'Który kraj wynalazł papier?',                       o: ['Chiny','Egipt','Grecja','Indie'],                     c: 0 },
  { q: 'Stolica Maroka?',                                   o: ['Casablanca','Rabat','Marrakesz','Fez'],               c: 1 },
  { q: 'Najmniejszy ocean świata?',                         o: ['Arktyczny','Spokojny','Atlantycki','Indyjski'],       c: 0 },
  { q: 'Filozof – nauczyciel Aleksandra Wielkiego?',        o: ['Arystoteles','Platon','Sokrates','Diogenes'],         c: 0 },
  { q: 'W którym roku zjednoczono ponownie Niemcy?',        o: ['1990','1989','1991','1985'],                          c: 0 },
  { q: 'Kto skomponował „Cztery pory roku"?',               o: ['Vivaldi','Mozart','Chopin','Bach'],                   c: 0 },
  { q: 'Najlepszy przewodnik prądu spośród metali?',        o: ['Srebro','Miedź','Złoto','Żelazo'],                    c: 0 },
  { q: 'Stolica Korei Południowej?',                        o: ['Seul','Pjongjang','Busan','Inczon'],                  c: 0 },
  { q: 'W którym mieście stoi Koloseum?',                   o: ['Rzym','Ateny','Neapol','Florencja'],                  c: 0 },
  { q: 'Kto namalował „Ostatnią Wieczerzę"?',               o: ['Leonardo da Vinci','Michał Anioł','Rafael','Caravaggio'], c: 0 },
  { q: 'Kto wyrzeźbił słynnego „Dawida"?',                  o: ['Michał Anioł','Donatello','Bernini','Rodin'],         c: 0 },
  { q: 'Prędkość dźwięku w powietrzu to ok. … m/s',         o: ['343','150','1000','30'],                              c: 0 },
  { q: 'Który pierwiastek jest gazem szlachetnym?',         o: ['Hel','Tlen','Azot','Wodór'],                          c: 0 },
  { q: 'Jednostka temperatury w układzie SI?',              o: ['Kelwin','Celsjusz','Fahrenheit','Dżul'],              c: 0 },
  { q: 'Z ilu jam zbudowane jest ludzkie serce?',           o: ['4','2','3','1'],                                      c: 0 },
  { q: 'Największy producent kawy na świecie?',             o: ['Brazylia','Kolumbia','Wietnam','Etiopia'],            c: 0 },
  { q: 'Najwyższy wodospad świata?',                        o: ['Salto Ángel','Niagara','Wiktorii','Iguazú'],          c: 0 },
  { q: 'Ile wynosi 2 do potęgi 10?',                        o: ['1024','1000','512','2048'],                           c: 0 },
  { q: 'Najczęściej używany język ojczysty na świecie?',    o: ['Chiński mandaryński','Angielski','Hiszpański','Hindi'], c: 0 },
  { q: 'Kto sformułował prawo powszechnego ciążenia?',      o: ['Newton','Einstein','Galileusz','Kepler'],             c: 0 },
  { q: 'Największa wyspa świata?',                          o: ['Grenlandia','Nowa Gwinea','Borneo','Madagaskar'],     c: 0 },
  { q: 'Który papież był Polakiem?',                        o: ['Jan Paweł II','Benedykt XVI','Franciszek','Jan XXIII'], c: 0 },
  { q: 'W którym roku zakończyła się II wojna światowa?',   o: ['1945','1944','1946','1939'],                          c: 0 },
  { q: 'Który kraj słynie z fiordów?',                      o: ['Norwegia','Hiszpania','Grecja','Egipt'],              c: 0 },
  { q: 'Ile wynosi pierwiastek z 169?',                     o: ['13','12','14','11'],                                  c: 0 },
  { q: 'Który organ odpowiada za oddychanie?',              o: ['Płuca','Serce','Wątroba','Żołądek'],                  c: 0 },
  { q: 'Jak nazywa się teoria powstania wszechświata?',     o: ['Wielki Wybuch','Ewolucja','Względność','Struny'],     c: 0 },
  { q: 'Ile wynosi kąt pełny?',                             o: ['360°','180°','270°','90°'],                           c: 0 },
  { q: 'Który pierwiastek ma symbol „Sn"?',                 o: ['Cyna','Srebro','Antymon','Selen'],                    c: 0 },
  { q: 'Autor obrazu „Krzyk"?',                             o: ['Edvard Munch','Van Gogh','Klimt','Dalí'],             c: 0 },
  { q: 'W którym roku zatonął Titanic?',                    o: ['1912','1905','1918','1923'],                          c: 0 },
  { q: 'Bóg wojny w mitologii greckiej?',                  o: ['Ares','Zeus','Apollo','Hades'],                       c: 0 },
  { q: 'Bóg mórz w mitologii greckiej?',                   o: ['Posejdon','Zeus','Hades','Hermes'],                   c: 0 },
  { q: 'Władca podziemi w mitologii greckiej?',            o: ['Hades','Zeus','Posejdon','Ares'],                     c: 0 },
  { q: 'Bogini mądrości w mitologii greckiej?',            o: ['Atena','Hera','Afrodyta','Artemida'],                 c: 0 },
  { q: 'Posłaniec bogów w mitologii greckiej?',            o: ['Hermes','Ares','Apollo','Zeus'],                      c: 0 },
  { q: 'Kto napisał „Lalkę"?',                             o: ['Bolesław Prus','Sienkiewicz','Żeromski','Reymont'],   c: 0 },
  { q: 'Kto napisał „Romeo i Julię"?',                     o: ['Szekspir','Molier','Goethe','Dante'],                 c: 0 },
  { q: 'Który kompozytor był Polakiem?',                   o: ['Chopin','Mozart','Beethoven','Vivaldi'],              c: 0 },
  { q: 'W którym roku wybuchła rewolucja październikowa?', o: ['1917','1905','1918','1922'],                          c: 0 },
  { q: 'Pierwszy prezydent II RP?',                        o: ['Gabriel Narutowicz','Piłsudski','Mościcki','Wojciechowski'], c: 0 },
  { q: 'Pierwsza dynastia królów Polski?',                 o: ['Piastowie','Jagiellonowie','Wazowie','Sasi'],         c: 0 },
  { q: 'Faraon ze słynną złotą maską (grób odkryty 1922)?', o: ['Tutanchamon','Ramzes II','Cheops','Echnaton'],       c: 0 },
  { q: 'Najwyższy szczyt Ameryki Południowej?',            o: ['Aconcagua','Kilimandżaro','Denali','Elbrus'],         c: 0 },
  { q: 'Cieśnina między Europą a Afryką?',                 o: ['Gibraltarska','Beringa','Bosfor','Kaletańska'],       c: 0 },
  { q: 'Kto wynalazł telefon (przypisuje się)?',           o: ['Bell','Edison','Marconi','Morse'],                    c: 0 },
  { q: 'Bracia, którzy skonstruowali pierwszy samolot?',   o: ['Wright','Montgolfier','Zeppelin','Grimm'],            c: 0 },
  { q: 'W którym roku zdobyto Mount Everest?',             o: ['1953','1924','1969','1901'],                          c: 0 },
  { q: 'Kto stworzył kubizm (wraz z Braquem)?',            o: ['Picasso','Monet','Dalí','Warhol'],                    c: 0 },
  { q: 'Najdłuższa rzeka Europy?',                         o: ['Wołga','Dunaj','Ren','Wisła'],                        c: 0 },
  { q: 'Kto pomalował sufit Kaplicy Sykstyńskiej?',        o: ['Michał Anioł','Leonardo','Rafael','Botticelli'],      c: 0 },
  { q: 'Flagowy statek Krzysztofa Kolumba?',               o: ['Santa Maria','Titanic','Beagle','Victoria'],          c: 0 },
  { q: 'Kto opracował układ okresowy pierwiastków?',       o: ['Mendelejew','Newton','Bohr','Curie'],                 c: 0 },
  { q: 'Polka z dwiema Nagrodami Nobla?',                  o: ['Maria Skłodowska-Curie','W. Szymborska','O. Tokarczuk','I. Sendlerowa'], c: 0 },
  { q: 'W którym kraju leży Machu Picchu?',                o: ['Peru','Meksyk','Chile','Boliwia'],                    c: 0 },
  { q: 'W którym kraju leży Tadż Mahal?',                  o: ['Indie','Pakistan','Iran','Egipt'],                    c: 0 },
  { q: 'Autor teorii ewolucji?',                           o: ['Karol Darwin','Mendel','Lamarck','Wallace'],          c: 0 },
  { q: 'Który kraj tradycyjnie wynalazł herbatę?',         o: ['Chiny','Indie','Japonia','Anglia'],                   c: 0 },
  { q: 'Słynny wódz Hunów?',                               o: ['Attyla','Czyngis-chan','Cezar','Napoleon'],           c: 0 },
  { q: 'Cesarz Francuzów pokonany pod Waterloo?',          o: ['Napoleon','Ludwik XIV','De Gaulle','Robespierre'],    c: 0 },
  { q: 'W którym roku była bitwa pod Waterloo?',           o: ['1815','1789','1805','1832'],                          c: 0 },
  { q: 'Jedyny zachowany cud świata starożytnego?',        o: ['Piramida w Gizie','Wiszące ogrody','Kolos Rodyjski','Latarnia w Aleksandrii'], c: 0 },
  { q: 'Kto namalował „Mona Lisę"?',                       o: ['Leonardo da Vinci','Rafael','Tycjan','Rubens'],       c: 0 },
  { q: 'Kraj o największej liczbie ludności?',             o: ['Indie','Chiny','USA','Indonezja'],                    c: 0 },
  { q: 'Który kompozytor napisał „Marsza tureckiego"?',    o: ['Mozart','Beethoven','Chopin','Bach'],                 c: 0 },
  { q: 'Autor „Pana Wołodyjowskiego"?',                    o: ['Sienkiewicz','Prus','Reymont','Orzeszkowa'],          c: 0 },
  { q: 'W której epoce żyły dinozaury (era)?',             o: ['Mezozoik','Paleozoik','Kenozoik','Prekambr'],         c: 0 },
  { q: 'Który polski król zwany był „Wielkim"?',           o: ['Kazimierz III','Mieszko I','Zygmunt III','Jan III'],  c: 0 },
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
  if (ARCADE_GAME_TYPES.includes(lobby.game)) return broadcastArcadeLobby(code);
  io.to(code).emit('updateLobby', {
    game: lobby.game,
    admin: lobby.admin,
    players: publicPlayers(lobby),
    categories:          lobby.game === 'panstwa' ? lobby.categories : undefined,
    availableCategories: lobby.game === 'panstwa' ? lobby.availableCategories : undefined,
    maxRounds:           lobby.game === 'panstwa' ? lobby.maxRounds : undefined,
    roundMs:             lobby.game === 'panstwa' ? lobby.roundMs : undefined,
  });
  broadcastPublicLobbies();
}

// ─── PUBLIC LOBBY BROWSER ────────────────────────────────────────────────────
const GAME_MAX = { panstwa: MAX_PM_PLAYERS, monopoly: 8 };
function publicLobbyList() {
  return Object.entries(lobbies)
    .filter(([, l]) => l.visibility === 'public' && l.phase === 'waiting')
    .map(([code, l]) => {
      const host = l.players.find(p => p.playerId === l.admin);
      return {
        code, game: l.game,
        host: host?.nickname ?? '?',
        players: l.players.length,
        max: GAME_MAX[l.game] || null,
        hasPassword: !!l.password,
      };
    });
}
function broadcastPublicLobbies() {
  io.to('lobby-browser').emit('publicLobbies', publicLobbyList());
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
  const roundMs       = lobby.roundMs || ROUND_MS;
  lobby.roundEndsAt   = Date.now() + roundMs;
  lobby.stopping      = false;
  lobby.roundTimeout  = setTimeout(() => pmEndRound(code), roundMs);

  io.to(code).emit('roundStarted', {
    round: lobby.round, maxRounds: lobby.maxRounds, letter: lobby.currentLetter,
    categories: lobby.categories, endsAt: lobby.roundEndsAt,
  });
}

// ─── ARCADE GAMES (Quiz / Zmyślacz / Kalambury) ─────────────────────────────

const QUIZ_Q_MS       = 20_000;
const QUIZ_REVEAL_MS  = 4_500;
const BLUFF_WRITE_MS  = 55_000;
const BLUFF_GUESS_MS  = 40_000;
const BLUFF_REVEAL_MS = 8_000;
const DRAW_MS         = 80_000;
const DRAW_REVEAL_MS  = 5_000;
const TRUTHS_TELL_MS  = 70_000;
const TRUTHS_GUESS_MS = 35_000;
const TRUTHS_REVEAL_MS= 8_000;
const ASSOC_WRITE_MS  = 55_000;
const ASSOC_VOTE_MS   = 35_000;
const ASSOC_REVEAL_MS = 9_000;
const WHO_VOTE_MS     = 25_000;
const WHO_REVEAL_MS   = 8_000;
const DANCE_DURATIONS    = [60_000, 120_000, 180_000];  // 1 / 2 / 3 min tańca (regulowane)
const DANCE_READY_MAXWAIT = 180_000; // start i tak po tym czasie, gdyby ktoś nie klikał
const DANCE_VOTE_MS   = 25_000;
const DANCE_REVEAL_MS = 10_000;

const ARCADE_SETTING_OPTIONS = {
  quiz:   { key: 'questions', label: 'Liczba pytań',       values: [5, 10, 15] },
  bluff:  { key: 'rounds',    label: 'Liczba rund',        values: [3, 5, 8] },
  draw:   { key: 'laps',      label: 'Rund na gracza',     values: [1, 2, 3] },
  truths: { key: 'rounds',    label: 'Liczba rund',        values: [3, 5, 8] },
  assoc:  { key: 'rounds',    label: 'Liczba rund',        values: [3, 5, 8] },
  who:    { key: 'rounds',    label: 'Liczba rund',        values: [7, 12, 20] },
  dance:  { key: 'rounds',    label: 'Liczba rund',        values: [3, 5, 8] },
};

const ASSOC_PROMPTS = [
  'Najgorszy prezent pod choinkę to ___.',
  'Czego nigdy nie mów na pierwszej randce? ___',
  'Supermoc, której nikt by nie chciał: ___',
  'Najgorsza nazwa dla zespołu muzycznego: ___',
  'Co znajdziesz w lodówce singla? ___',
  'Nowy przedmiot w szkole: ___',
  'Najgorsza wymówka na spóźnienie: ___',
  'Najdziwniejsza rzecz do zjedzenia o 3 w nocy: ___',
  'Tytuł najgorszego filmu wszech czasów: ___',
  'Czego szukasz w internecie o północy? ___',
  'Co powiedziałby twój pies, gdyby umiał mówić? ___',
  'Najgorsza nazwa dla restauracji: ___',
  'Sekretny talent, którym nikt się nie chwali: ___',
  'Najgorsza rzecz do powiedzenia szefowi: ___',
  'Co robi kot, gdy nikt nie patrzy? ___',
  'Nowy smak lodów, który się nie przyjmie: ___',
  'Najgorsza rada życiowa: ___',
  'Najgorsza pamiątka z wakacji: ___',
  'Czego nie powinno być w kanapce: ___',
  'Nowy hit na TikToku: ___',
  'Najgorsza rzecz do znalezienia w zupie: ___',
  'Co robisz, gdy padnie internet? ___',
  'Najgorsze hasło do konta: ___',
  'Najgorszy motyw przewodni imprezy: ___',
  'Co ukrywasz przed rodzicami? ___',
  'Najgorszy sposób na rozpoczęcie przemówienia: ___',
  'Rzecz, której nie kupisz nawet na promocji: ___',
  'Najgorszy pomysł na biznes: ___',
  'Co znajdą archeolodzy za 1000 lat? ___',
  'Najgorsza nazwa dla nowego telefonu: ___',
];

// "Kto z nas?" – każda runda pokazuje jedno hasło, wszyscy głosują na gracza.
const WHO_PROMPTS = [
  'Kto z nas najprędzej zaśnie na własnym ślubie?',
  'Kto z nas najprędzej zostanie milionerem?',
  'Kto z nas najprędzej wyda całą wypłatę w jeden dzień?',
  'Kto z nas najprędzej zgubi telefon na imprezie?',
  'Kto z nas najprędzej rozpłacze się na komedii romantycznej?',
  'Kto z nas najprędzej zapomni o urodzinach najlepszego przyjaciela?',
  'Kto z nas najprędzej zostanie gwiazdą TikToka?',
  'Kto z nas najprędzej przespał ważny egzamin?',
  'Kto z nas najprędzej zamówi jedzenie zamiast ugotować?',
  'Kto z nas najprędzej wda się w kłótnię o politykę przy świątecznym stole?',
  'Kto z nas najprędzej zapłacze ze śmiechu na pogrzebie?',
  'Kto z nas najprędzej wyjedzie na drugi koniec świata bez planu?',
  'Kto z nas najprędzej pomyli imiona swoich dzieci?',
  'Kto z nas najprędzej kupi coś kompletnie niepotrzebnego na promocji?',
  'Kto z nas najprędzej zgubi się w znanym mieście?',
  'Kto z nas najprędzej zostanie aresztowany za coś głupiego?',
  'Kto z nas najprędzej rzuci pracę, żeby zostać influencerem?',
  'Kto z nas najprędzej zapomni wyłączyć piekarnik?',
  'Kto z nas najprędzej powie coś nie tak na rozmowie o pracę?',
  'Kto z nas najprędzej zakocha się w kimś poznanym przez internet?',
  'Kto z nas najprędzej rozbije telefon w pierwszym tygodniu?',
  'Kto z nas najprędzej wygada cudzy sekret?',
  'Kto z nas najprędzej wróci z wakacji spalony na raka?',
  'Kto z nas najprędzej zapomni jak się nazywa osoba, którą właśnie poznał?',
  'Kto z nas najprędzej zostanie w piżamie cały dzień?',
  'Kto z nas najprędzej weźmie kredyt na coś głupiego?',
  'Kto z nas najprędzej zgubi klucze i wejdzie oknem?',
  'Kto z nas najprędzej pokłóci się z nawigacją w samochodzie?',
  'Kto z nas najprędzej przefarbuje włosy na zielono?',
  'Kto z nas najprędzej zamieszka na wsi i będzie hodował kozy?',
  'Kto z nas raczej zjadłby coś, co spadło na podłogę?',
  'Kto z nas raczej przetańczyłby całą noc?',
  'Kto z nas raczej zapomniałby własnego numeru telefonu?',
  'Kto z nas raczej rozmawia sam ze sobą?',
  'Kto z nas raczej śpiewa pod prysznicem na cały głos?',
  'Kto z nas raczej ugotowałby obiad z tego, co znajdzie w lodówce?',
  'Kto z nas raczej powiedziałby "to ostatni raz" i zrobił to znowu?',
  'Kto z nas najprędzej spóźni się na własną imprezę?',
  'Kto z nas najprędzej zjadłby najostrzejsze danie w menu?',
  'Kto z nas najprędzej zrobi sobie tatuaż pod wpływem chwili?',
  'Kto z nas najprędzej zostanie prezydentem?',
  'Kto z nas najprędzej zapomni gdzie zaparkował auto?',
  'Kto z nas najprędzej zacznie płakać ze wzruszenia?',
  'Kto z nas najprędzej weźmie udział w reality show?',
  'Kto z nas najprędzej wygra na loterii i i tak zbankrutuje?',
  'Kto z nas najprędzej zaśpiewa karaoke bez wahania?',
  'Kto z nas najprędzej zapomni hasła do wszystkiego?',
  'Kto z nas najprędzej pokłóci się z kelnerem o rachunek?',
  'Kto z nas najprędzej zgubi bagaż na lotnisku?',
  'Kto z nas najprędzej odda ostatnią złotówkę potrzebującemu?',
  'Kto z nas najprędzej przesadzi z kawą?',
  'Kto z nas najprędzej weźmie kota ze schroniska, a potem drugiego, i trzeciego?',
  'Kto z nas najprędzej powie "wiedziałem" po fakcie?',
  'Kto z nas najprędzej zrobi awanturę w kolejce?',
  'Kto z nas najprędzej zapomni parasola w dzień deszczu?',
  'Kto z nas raczej obejrzałby cały serial w jedną noc?',
  'Kto z nas raczej zaczepia obcych ludzi na ulicy?',
  'Kto z nas raczej zapomniałby o umówionym spotkaniu?',
  'Kto z nas raczej wygrałby konkurs jedzenia na czas?',
  'Kto z nas raczej zgubiłby się we własnym domu?',
  'Kto z nas najprędzej kupi coś, bo "wyglądało fajnie w reklamie"?',
  'Kto z nas najprędzej wsiądzie do niewłaściwego pociągu?',
  'Kto z nas najprędzej zaśnie w kinie?',
  'Kto z nas najprędzej zrobi z siebie głupka na pierwszej randce?',
  'Kto z nas najprędzej wyśle wiadomość do złej osoby?',
  'Kto z nas najprędzej zje cały tort sam?',
  'Kto z nas najprędzej zapomni, że coś się gotuje na kuchence?',
  'Kto z nas najprędzej zostanie królem/królową imprezy?',
  'Kto z nas najprędzej rozpłacze się przy zwierzęcej reklamie?',
  'Kto z nas najprędzej pojedzie autostopem przez pół Europy?',
  'Kto z nas najprędzej zamówi to samo co zawsze w restauracji?',
  'Kto z nas najprędzej zgubi rękawiczkę i będzie chodził z jedną?',
  'Kto z nas najprędzej weźmie udział w bójce na poduszki?',
  'Kto z nas najprędzej powie coś głupiego i będzie się z tego śmiać sam?',
  'Kto z nas najprędzej zapomni doładować telefon i zostanie bez zasięgu?',
  'Kto z nas najprędzej zainwestuje w kryptowaluty i wszystko straci?',
  'Kto z nas najprędzej zaproponuje wspólny wyjazd o 2 w nocy?',
  'Kto z nas najprędzej zje coś, czego nazwy nie potrafi wymówić?',
  'Kto z nas najprędzej pokłóci się o miejsce w kolejce do bufetu?',
  'Kto z nas raczej rozdałby wszystkim prezenty bez okazji?',
  'Kto z nas raczej zapomniałby zdjąć metki z nowych ubrań?',
  'Kto z nas raczej spałby do południa w każdy weekend?',
  'Kto z nas raczej rozmawia z roślinami?',
  'Kto z nas raczej zjadłby deser przed obiadem?',
  'Kto z nas najprędzej zapomni gdzie schował prezenty?',
  'Kto z nas najprędzej wejdzie do złej łazienki?',
  'Kto z nas najprędzej zacznie tańczyć, gdy nikt inny nie tańczy?',
  'Kto z nas najprędzej zgubi się w supermarkecie?',
  'Kto z nas najprędzej zapłaci za wszystkich i będzie się śmiał, że go stać?',
  'Kto z nas najprędzej pomyli sól z cukrem?',
  'Kto z nas najprędzej zaśnie podczas oglądania meczu?',
  'Kto z nas najprędzej zrobi zdjęcie jedzenia zanim zacznie jeść?',
  'Kto z nas najprędzej weźmie ślub w Las Vegas?',
  'Kto z nas najprędzej wygra w kłótni, choć nie ma racji?',
  'Kto z nas najprędzej zapomni jak wrócić do domu?',
  'Kto z nas najprędzej ubierze się nieodpowiednio na okazję?',
  'Kto z nas najprędzej zje coś prosto z lodówki o północy?',
  'Kto z nas najprędzej zostanie gwiazdą internetu przez przypadek?',
  'Kto z nas najprędzej pomyli lewo z prawem podczas jazdy?',
  'Kto z nas najprędzej pójdzie spać przed 21:00?',
  'Kto z nas najprędzej zaproponuje zamówienie pizzy zamiast gotowania?',
  'Kto z nas raczej zgadałby się z każdym w autobusie?',
  'Kto z nas raczej zapomniałby wyłączyć budzik w weekend?',
  'Kto z nas raczej dokupiłby jeszcze jedną parę butów?',
  'Kto z nas raczej odpowiedziałby na wiadomość po trzech dniach?',
  'Kto z nas raczej zjadłby całą paczkę chipsów przed telewizorem?',
  'Kto z nas najprędzej zamówi coś dziwnego przez internet o 3 w nocy?',
  'Kto z nas najprędzej zapomni imienia swojego szefa?',
  'Kto z nas najprędzej zabłądzi na własnym osiedlu?',
  'Kto z nas najprędzej zaśpiewa hymn w niewłaściwym momencie?',
  'Kto z nas najprędzej zainwestuje w kolejny "genialny" pomysł na biznes?',
  'Kto z nas najprędzej zapomni zdjąć folię z nowego telefonu?',
  'Kto z nas najprędzej zrobi coś z listy "nigdy więcej" po raz kolejny?',
  'Kto z nas najprędzej zaśnie na plaży i się poparzy?',
  'Kto z nas najprędzej wróci do domu z imprezy z cudzą kurtką?',
  'Kto z nas najprędzej pomyli piątek z sobotą?',
  'Kto z nas najprędzej zamówi jedzenie, którego nie potrafi zjeść?',
  'Kto z nas najprędzej zgubi bilet tuż przed kontrolą?',
  'Kto z nas najprędzej zapłaci kartą za gumę do żucia?',
  'Kto z nas najprędzej rozpocznie dietę i zakończy ją tego samego dnia?',
  'Kto z nas najprędzej zapomni gdzie odłożył okulary, które ma na nosie?',
  'Kto z nas najprędzej wejdzie w szklane drzwi?',
  'Kto z nas najprędzej zacznie mówić do siebie w sklepie?',
  'Kto z nas najprędzej pomyli się w liczeniu do dziesięciu?',
  'Kto z nas raczej zjadłby ostatni kawałek pizzy bez pytania?',
  'Kto z nas raczej wygrałby konkurs na najgłośniejszy śmiech?',
  'Kto z nas raczej zapomniałby własnej rocznicy?',
  'Kto z nas raczej zrobiłby najwięcej selfie w ciągu dnia?',
  'Kto z nas raczej zgubiłby pilota w ciągu minuty?',
  'Kto z nas najprędzej zaproponuje wyjazd w góry o poranku?',
  'Kto z nas najprędzej zapomni parasola i będzie narzekał na deszcz?',
  'Kto z nas najprędzej zrobi sobie grzywkę i pożałuje?',
  'Kto z nas najprędzej zamówi dokładkę, choć jest już najedzony?',
  'Kto z nas najprędzej zaśnie podczas rozmowy telefonicznej?',
  'Kto z nas najprędzej pomyli przyprawy podczas gotowania?',
  'Kto z nas najprędzej rozpocznie kłótnię o to, gdzie iść na obiad?',
  'Kto z nas najprędzej zgubi ładowarkę w hotelu?',
  'Kto z nas najprędzej zapomni jak się nazywa film, który właśnie oglądał?',
  'Kto z nas najprędzej odda swoją ostatnią kanapkę głodnemu psu?',
  'Kto z nas najprędzej zaproponuje karaoke o północy?',
  'Kto z nas najprędzej pomyli aplikacje i wyśle mem szefowi?',
  'Kto z nas najprędzej weźmie za dużo na talerz i nie zje?',
  'Kto z nas najprędzej zaśnie w trakcie medytacji?',
  'Kto z nas najprędzej pokłóci się z automatem biletowym?',
  'Kto z nas najprędzej zapomni gdzie ukrył czekoladę przed samym sobą?',
  'Kto z nas raczej pomógłby nieznajomemu przenieść meble?',
  'Kto z nas raczej rozmawiałby z kasjerem przez pół godziny?',
  'Kto z nas raczej wybrałby najdłuższą kolejkę?',
  'Kto z nas raczej zjadłby coś tylko na wyzwanie?',
  'Kto z nas raczej zapomniałby o gotującej się wodzie?',
  'Kto z nas najprędzej zostanie zaproszony na wesele obcych ludzi?',
  'Kto z nas najprędzej zaśpiewa nie swoją partię w chórze?',
  'Kto z nas najprędzej zamówi kawę, o której nazwie nawet nie słyszał?',
  'Kto z nas najprędzej zapomni gdzie mieszka po przeprowadzce?',
  'Kto z nas najprędzej rozpłacze się na koncercie ulubionego zespołu?',
  'Kto z nas najprędzej weźmie udział w maratonie bez treningu?',
  'Kto z nas najprędzej pomyli poniedziałek z niedzielą?',
  'Kto z nas najprędzej zaśnie z otwartymi oczami na wykładzie?',
  'Kto z nas najprędzej zgubi się wracając z toalety w restauracji?',
  'Kto z nas najprędzej zamówi coś "na spróbowanie" i zje wszystko?',
  'Kto z nas najprędzej zapomni jak działa jego własna kuchenka?',
  'Kto z nas najprędzej rozpocznie taniec na środku sklepu?',
  'Kto z nas najprędzej pomyli imię partnera z imieniem eks?',
  'Kto z nas najprędzej zgubi telefon, trzymając go w ręce?',
  'Kto z nas najprędzej zaproponuje wspólne wakacje całej paczce?',
  'Kto z nas najprędzej zapomni kodu do własnego telefonu?',
  'Kto z nas najprędzej zjeździ pół świata w poszukiwaniu idealnej kawy?',
  'Kto z nas najprędzej pomyli przystanek i wysiądzie za wcześnie?',
  'Kto z nas raczej rozdałby autografy, choć nikt go nie zna?',
  'Kto z nas raczej wygrałby konkurs na najlepszą wymówkę?',
  'Kto z nas raczej zjadłby śniadanie na kolację?',
  'Kto z nas raczej zapomniałby zamknąć drzwi na klucz?',
  'Kto z nas raczej rozpocząłby rozmowę z manekinem w sklepie?',
  'Kto z nas najprędzej wyjdzie z domu w dwóch różnych butach?',
  'Kto z nas najprędzej zapomni, po co wszedł do pokoju?',
  'Kto z nas najprędzej zrobi zakupy głodny i kupi za dużo?',
  'Kto z nas najprędzej zaśnie podczas czytania książki na stojąco?',
  'Kto z nas najprędzej pomyli numer mieszkania i zapuka do sąsiada?',
  'Kto z nas najprędzej zgubi listę zakupów w sklepie?',
  'Kto z nas najprędzej wyśle "kocham cię" do niewłaściwego kontaktu?',
  'Kto z nas najprędzej zamówi deser wielkości głowy?',
  'Kto z nas najprędzej zapomni gdzie zostawił rower?',
  'Kto z nas najprędzej zacznie śpiewać reklamę w tramwaju?',
  'Kto z nas najprędzej pomyli cukier z solą przy pieczeniu ciasta?',
  'Kto z nas najprędzej rozpocznie remont i nigdy go nie skończy?',
  'Kto z nas najprędzej zaśnie na siłowni?',
  'Kto z nas najprędzej zgubi bilet do kina zanim wejdzie do sali?',
  'Kto z nas najprędzej zapomni imienia własnego psa w stresie?',
  'Kto z nas najprędzej zaproponuje wspólne bieganie o 6 rano?',
  'Kto z nas najprędzej zje coś prosto z półki w sklepie?',
  'Kto z nas najprędzej pomyli lewą nogę z prawą na lekcji tańca?',
  'Kto z nas raczej zaśpiewałby na scenie bez zaproszenia?',
  'Kto z nas raczej zapomniałby, że coś już opowiadał trzy razy?',
  'Kto z nas raczej zjadłby całe pudełko lodów w jeden wieczór?',
  'Kto z nas raczej zgubiłby się na mapie własnego miasta?',
  'Kto z nas raczej rozpocząłby rozmowę o kosmosie przy śniadaniu?',
  'Kto z nas najprędzej zostanie sławny z zupełnie głupiego powodu?',
  'Kto z nas najprędzej zapomni wziąć prezentu na własne przyjęcie?',
  'Kto z nas najprędzej pomyli szampon z żelem pod prysznic?',
  'Kto z nas najprędzej zaśnie zaraz po powiedzeniu "tylko na chwilę zamknę oczy"?',
];

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
    customPrompts: lobby.customPrompts || [],
  });
  broadcastPublicLobbies();
}
function connectedNonDrawer(lobby) {
  return lobby.players.filter(p => p.connected && p.playerId !== lobby.drawerId).length;
}

// ── QUIZ ─────────────────────────────────────────────────────────────────────
function quizStart(code) {
  const lobby = lobbies[code];
  const bank = lobby.settings.difficulty === 'easy' ? QUIZ_EASY_QUESTIONS
             : lobby.settings.difficulty === 'hard' ? QUIZ_HARD_QUESTIONS
             :                                        QUIZ_QUESTIONS;
  const n = Math.min(lobby.settings.questions, bank.length);
  lobby.questions = shuffle(bank).slice(0, n);
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
  lobby.ops       = [];        // completed draw operations (for undo / rejoin)
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

// ── 2 PRAWDY 1 KŁAMSTWO (truths) ─────────────────────────────────────────────
function truthsStart(code) {
  const lobby = lobbies[code];
  lobby.players.forEach(p => { p.score = 0; });
  lobby.order   = shuffle(lobby.players.map(p => p.playerId));   // rotating authors
  lobby.authIdx = -1;
  lobby.roundNo = 0;
  lobby.maxR    = lobby.settings.rounds;
  truthsBeginTelling(code);
}
function truthsBeginTelling(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.roundNo += 1;
  if (lobby.roundNo > lobby.maxR) return truthsFinish(code);
  let guard = 0;
  do { lobby.authIdx = (lobby.authIdx + 1) % lobby.order.length; guard++; }
  while (guard <= lobby.order.length && !lobby.players.find(p => p.playerId === lobby.order[lobby.authIdx] && p.connected));
  lobby.authorId   = lobby.order[lobby.authIdx];
  lobby.statements = null; lobby.lieIndex = null; lobby.guesses = {};
  lobby.phase = 'telling'; lobby.endsAt = Date.now() + TRUTHS_TELL_MS;
  const author = lobby.players.find(p => p.playerId === lobby.authorId);
  lobby.players.forEach(p => {
    io.to(p.socketId).emit('truthsTell', {
      round: lobby.roundNo, total: lobby.maxR,
      authorId: lobby.authorId, authorNick: author?.nickname ?? '?',
      amAuthor: p.playerId === lobby.authorId, endsAt: lobby.endsAt,
    });
  });
  lobby.timer = setTimeout(() => { lobby.statements ? truthsToGuessing(code) : truthsBeginTelling(code); }, TRUTHS_TELL_MS);
}
function truthsToGuessing(code) {
  const lobby = lobbies[code];
  if (lobby.phase !== 'telling' || !lobby.statements) return;
  clearGameTimer(lobby);
  lobby.phase = 'guessing'; lobby.endsAt = Date.now() + TRUTHS_GUESS_MS;
  const author = lobby.players.find(p => p.playerId === lobby.authorId);
  lobby.players.forEach(p => {
    io.to(p.socketId).emit('truthsGuess', {
      round: lobby.roundNo, total: lobby.maxR, authorNick: author?.nickname ?? '?',
      statements: lobby.statements, amAuthor: p.playerId === lobby.authorId,
      picked: lobby.guesses[p.playerId] ?? null, endsAt: lobby.endsAt,
    });
  });
  lobby.timer = setTimeout(() => truthsReveal(code), TRUTHS_GUESS_MS);
}
function truthsReveal(code) {
  const lobby = lobbies[code];
  if (lobby.phase !== 'guessing') return;
  clearGameTimer(lobby);
  lobby.phase = 'reveal';
  const gained = {}; lobby.players.forEach(p => { gained[p.playerId] = 0; });
  let fooled = 0;
  Object.entries(lobby.guesses).forEach(([voter, idx]) => {
    if (idx === lobby.lieIndex) gained[voter] = (gained[voter] || 0) + 1000;
    else fooled++;
  });
  if (gained[lobby.authorId] != null) gained[lobby.authorId] += fooled * 500;
  lobby.players.forEach(p => { p.score += gained[p.playerId] || 0; });
  const tally = lobby.statements.map((s, i) => ({
    text: s, isLie: i === lobby.lieIndex,
    pickedBy: Object.entries(lobby.guesses).filter(([, x]) => x === i)
      .map(([v]) => lobby.players.find(p => p.playerId === v)?.nickname ?? '?'),
  }));
  const author = lobby.players.find(p => p.playerId === lobby.authorId);
  io.to(code).emit('truthsReveal', {
    authorNick: author?.nickname ?? '?', lieIndex: lobby.lieIndex, tally,
    scoreboard: scoreboardOf(lobby), last: lobby.roundNo >= lobby.maxR,
  });
  lobby.timer = setTimeout(() => lobby.roundNo >= lobby.maxR ? truthsFinish(code) : truthsBeginTelling(code), TRUTHS_REVEAL_MS);
}
function truthsFinish(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.phase = 'finished';
  io.to(code).emit('arcadeFinished', { game: 'truths', scoreboard: scoreboardOf(lobby) });
}
function truthsMaybeAdvanceGuess(code) {
  const lobby = lobbies[code];
  const need = lobby.players.filter(p => p.connected && p.playerId !== lobby.authorId).length;
  const have = lobby.players.filter(p => p.connected && p.playerId !== lobby.authorId && lobby.guesses[p.playerId] != null).length;
  if (have >= need && need > 0) truthsReveal(code);
}

// ── NAJGORSZE SKOJARZENIA (assoc) ────────────────────────────────────────────
function assocStart(code) {
  const lobby = lobbies[code];
  lobby.players.forEach(p => { p.score = 0; });
  const n = Math.min(lobby.settings.rounds, ASSOC_PROMPTS.length);
  lobby.prompts = shuffle(ASSOC_PROMPTS).slice(0, n);
  lobby.qIndex = -1;
  assocBeginWriting(code);
}
function assocBeginWriting(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.qIndex += 1;
  if (lobby.qIndex >= lobby.prompts.length) return assocFinish(code);
  lobby.phase = 'writing'; lobby.answers = {}; lobby.votes = {};
  lobby.endsAt = Date.now() + ASSOC_WRITE_MS;
  io.to(code).emit('assocWrite', { index: lobby.qIndex, total: lobby.prompts.length, prompt: lobby.prompts[lobby.qIndex], endsAt: lobby.endsAt });
  lobby.timer = setTimeout(() => assocToVoting(code), ASSOC_WRITE_MS);
}
function assocToVoting(code) {
  const lobby = lobbies[code];
  if (lobby.phase !== 'writing') return;
  clearGameTimer(lobby);
  const opts = [];
  lobby.players.forEach(p => {
    const raw = (lobby.answers[p.playerId] || '').trim();
    if (raw) opts.push({ id: p.playerId, text: raw, ownerId: p.playerId });
  });
  if (opts.length < 2) return assocReveal(code, true);          // not enough answers – skip voting
  lobby.options = shuffle(opts);
  lobby.phase = 'voting'; lobby.endsAt = Date.now() + ASSOC_VOTE_MS;
  lobby.players.forEach(p => {
    io.to(p.socketId).emit('assocVote', {
      index: lobby.qIndex, total: lobby.prompts.length, prompt: lobby.prompts[lobby.qIndex],
      options: lobby.options.map(o => ({ id: o.id, text: o.text, mine: o.ownerId === p.playerId })),
      picked: lobby.votes[p.playerId] || null, endsAt: lobby.endsAt,
    });
  });
  lobby.timer = setTimeout(() => assocReveal(code), ASSOC_VOTE_MS);
}
function assocReveal(code, skipped) {
  const lobby = lobbies[code];
  if (lobby.phase !== 'writing' && lobby.phase !== 'voting') return;
  clearGameTimer(lobby);
  lobby.phase = 'reveal';
  const counts = {};
  Object.values(lobby.votes || {}).forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  (lobby.options || []).forEach(o => {
    const c = counts[o.id] || 0;
    const author = lobby.players.find(p => p.playerId === o.ownerId);
    if (author) author.score += c * 500;
  });
  const reveal = (lobby.options || []).map(o => ({
    text: o.text, author: lobby.players.find(p => p.playerId === o.ownerId)?.nickname ?? '?',
    votes: counts[o.id] || 0,
  })).sort((a, b) => b.votes - a.votes);
  io.to(code).emit('assocReveal', {
    prompt: lobby.prompts[lobby.qIndex], reveal, skipped: !!skipped,
    scoreboard: scoreboardOf(lobby), last: lobby.qIndex >= lobby.prompts.length - 1,
  });
  lobby.timer = setTimeout(() => lobby.qIndex >= lobby.prompts.length - 1 ? assocFinish(code) : assocBeginWriting(code), ASSOC_REVEAL_MS);
}
function assocFinish(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.phase = 'finished';
  io.to(code).emit('arcadeFinished', { game: 'assoc', scoreboard: scoreboardOf(lobby) });
}
function assocMaybeAdvanceWrite(code) {
  const lobby = lobbies[code];
  const need = lobby.players.filter(p => p.connected).length;
  const have = lobby.players.filter(p => p.connected && (lobby.answers[p.playerId] || '').trim()).length;
  if (have >= need && need > 0) assocToVoting(code);
}
function assocMaybeAdvanceVote(code) {
  const lobby = lobbies[code];
  const need = lobby.players.filter(p => p.connected).length;
  const have = lobby.players.filter(p => p.connected && lobby.votes[p.playerId]).length;
  if (have >= need && need > 0) assocReveal(code);
}

// ── KTO Z NAS? ───────────────────────────────────────────────────────────────
function whoStart(code) {
  const lobby = lobbies[code];
  lobby.players.forEach(p => { p.score = 0; });
  const custom = lobby.customPrompts || [];
  const n = Math.min(lobby.settings.rounds, WHO_PROMPTS.length + custom.length);
  // Own questions are guaranteed in; the rest is filled with random bank prompts.
  const fill = shuffle(WHO_PROMPTS).slice(0, Math.max(0, n - custom.length));
  lobby.prompts = shuffle([...custom, ...fill]).slice(0, n);
  lobby.qIndex = -1;
  whoBeginVoting(code);
}
function whoBeginVoting(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.qIndex += 1;
  if (lobby.qIndex >= lobby.prompts.length) return whoFinish(code);
  lobby.phase = 'voting'; lobby.votes = {};
  lobby.endsAt = Date.now() + WHO_VOTE_MS;
  io.to(code).emit('whoVote', {
    index: lobby.qIndex, total: lobby.prompts.length,
    prompt: lobby.prompts[lobby.qIndex], players: arcadePlayers(lobby), endsAt: lobby.endsAt,
  });
  lobby.timer = setTimeout(() => whoReveal(code), WHO_VOTE_MS);
}
function whoReveal(code) {
  const lobby = lobbies[code];
  if (lobby.phase !== 'voting') return;
  clearGameTimer(lobby);
  lobby.phase = 'reveal';
  const counts = {};
  Object.values(lobby.votes || {}).forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  // Each player earns 100 points per vote they received this round.
  lobby.players.forEach(p => { p.score += (counts[p.playerId] || 0) * 100; });
  const max = Math.max(0, ...Object.values(counts));
  const rows = lobby.players
    .map(p => ({ nickname: p.nickname, votes: counts[p.playerId] || 0, top: max > 0 && (counts[p.playerId] || 0) === max }))
    .filter(r => r.votes > 0)
    .sort((a, b) => b.votes - a.votes);
  io.to(code).emit('whoReveal', {
    prompt: lobby.prompts[lobby.qIndex], rows,
    noVotes: rows.length === 0,
    scoreboard: scoreboardOf(lobby), last: lobby.qIndex >= lobby.prompts.length - 1,
  });
  lobby.timer = setTimeout(() => lobby.qIndex >= lobby.prompts.length - 1 ? whoFinish(code) : whoBeginVoting(code), WHO_REVEAL_MS);
}
function whoFinish(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.phase = 'finished';
  io.to(code).emit('arcadeFinished', { game: 'who', scoreboard: scoreboardOf(lobby) });
}
function whoMaybeAdvanceVote(code) {
  const lobby = lobbies[code];
  const need = lobby.players.filter(p => p.connected).length;
  const have = lobby.players.filter(p => p.connected && lobby.votes[p.playerId]).length;
  if (have >= need && need > 0) whoReveal(code);
}

// ── TAŃCZERECZKI (silent-disco impostor) ─────────────────────────────────────
function danceReadyNeed(lobby) {
  const connected = lobby.players.filter(p => p.connected).length;
  return Math.max(2, Math.ceil(connected * 0.8));   // 80% lobby, min. 2
}
function danceMs(lobby) {
  const v = lobby.settings && lobby.settings.danceMs;
  return DANCE_DURATIONS.includes(v) ? v : 120_000;
}
function danceStart(code) {
  const lobby = lobbies[code];
  lobby.players.forEach(p => { p.score = 0; });
  lobby.qIndex = -1;
  danceReadyPhase(code);   // najpierw wszyscy klikają „Gotowy” — potem start równocześnie
}
// Pre-game readiness gate: gra rusza, gdy 80% lobby kliknie „Gotowy”.
function danceReadyPhase(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.phase = 'ready'; lobby.ready = {};
  lobby.endsAt = Date.now() + DANCE_READY_MAXWAIT;
  io.to(code).emit('danceReadyPhase', {
    players: arcadePlayers(lobby), need: danceReadyNeed(lobby), endsAt: lobby.endsAt,
  });
  lobby.timer = setTimeout(() => danceBeginRound(code), DANCE_READY_MAXWAIT);  // start i tak
}
function danceBeginRound(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.qIndex += 1;
  if (lobby.qIndex >= lobby.settings.rounds) return danceFinish(code);
  const connected = lobby.players.filter(p => p.connected);
  if (connected.length < 2) return danceFinish(code);
  // Pick the impostor + two distinct tracks (main for everyone, odd one for impostor).
  lobby.impostorId = connected[Math.floor(Math.random() * connected.length)].playerId;
  const mainTrack = Math.floor(Math.random() * DANCE_TRACK_COUNT);
  let impTrack = Math.floor(Math.random() * (DANCE_TRACK_COUNT - 1));
  if (impTrack >= mainTrack) impTrack += 1;
  lobby.mainTrack = mainTrack; lobby.impTrack = impTrack;
  // Losowy punkt startu utworu, żeby „zaczynało się już od muzyki”, nie od intra.
  lobby.startAt = 18 + Math.floor(Math.random() * 30);   // 18–47 s
  lobby.phase = 'dancing'; lobby.votes = {}; lobby.skip = {};
  const dur = danceMs(lobby);
  lobby.endsAt = Date.now() + dur;
  lobby.players.forEach(p => {
    const amImp = p.playerId === lobby.impostorId;
    io.to(p.socketId).emit('danceStart', {
      round: lobby.qIndex, total: lobby.settings.rounds,
      trackIndex: amImp ? impTrack : mainTrack, amImpostor: amImp,
      players: arcadePlayers(lobby), endsAt: lobby.endsAt, startAt: lobby.startAt,
      skipNeed: danceReadyNeed(lobby),
    });
  });
  lobby.timer = setTimeout(() => danceToVoting(code), dur);
}
// 80% ekipy chce zakończyć muzykę → przejdź do głosowania wcześniej.
function danceMaybeAdvanceSkip(code) {
  const lobby = lobbies[code];
  if (!lobby || lobby.phase !== 'dancing') return;
  const have = lobby.players.filter(p => p.connected && lobby.skip && lobby.skip[p.playerId]).length;
  if (have >= danceReadyNeed(lobby)) danceToVoting(code);
}
function danceToVoting(code) {
  const lobby = lobbies[code];
  if (lobby.phase !== 'dancing') return;
  clearGameTimer(lobby);
  lobby.phase = 'voting'; lobby.endsAt = Date.now() + DANCE_VOTE_MS;
  lobby.players.forEach(p => {
    io.to(p.socketId).emit('danceVote', {
      round: lobby.qIndex, total: lobby.settings.rounds,
      players: arcadePlayers(lobby), picked: lobby.votes[p.playerId] || null, endsAt: lobby.endsAt,
    });
  });
  lobby.timer = setTimeout(() => danceReveal(code), DANCE_VOTE_MS);
}
function danceReveal(code) {
  const lobby = lobbies[code];
  if (lobby.phase !== 'dancing' && lobby.phase !== 'voting') return;
  clearGameTimer(lobby);
  lobby.phase = 'reveal';
  const counts = {};
  Object.values(lobby.votes || {}).forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  const impId = lobby.impostorId;
  // Detectors: +150 for correctly fingering the impostor.
  lobby.players.forEach(p => { if (lobby.votes[p.playerId] === impId) p.score += 150; });
  // Impostor: +100 for every voter who did NOT catch them.
  const impostor = lobby.players.find(p => p.playerId === impId);
  const missed = Object.entries(lobby.votes || {}).filter(([voter, tgt]) => voter !== impId && tgt !== impId).length;
  if (impostor) impostor.score += 100 * missed;
  const max = Math.max(0, ...Object.values(counts));
  const caught = max > 0 && (counts[impId] || 0) === max &&
    Object.values(counts).filter(c => c === max).length === 1;   // impostor uniquely most-voted
  const rows = lobby.players
    .map(p => ({ nickname: p.nickname, votes: counts[p.playerId] || 0, impostor: p.playerId === impId }))
    .sort((a, b) => b.votes - a.votes);
  io.to(code).emit('danceReveal', {
    impostorNick: impostor ? impostor.nickname : '???', caught,
    mainTrack: lobby.mainTrack, impTrack: lobby.impTrack, rows,
    scoreboard: scoreboardOf(lobby), last: lobby.qIndex >= lobby.settings.rounds - 1,
  });
  lobby.timer = setTimeout(() => lobby.qIndex >= lobby.settings.rounds - 1 ? danceFinish(code) : danceBeginRound(code), DANCE_REVEAL_MS);
}
function danceFinish(code) {
  const lobby = lobbies[code];
  clearGameTimer(lobby);
  lobby.phase = 'finished';
  io.to(code).emit('arcadeFinished', { game: 'dance', scoreboard: scoreboardOf(lobby) });
}
function danceMaybeAdvanceReady(code) {
  const lobby = lobbies[code];
  if (lobby.phase !== 'ready') return;
  const have = lobby.players.filter(p => p.connected && lobby.ready[p.playerId]).length;
  if (have >= danceReadyNeed(lobby)) danceBeginRound(code);
}
function danceMaybeAdvanceVote(code) {
  const lobby = lobbies[code];
  const need = lobby.players.filter(p => p.connected).length;
  const have = lobby.players.filter(p => p.connected && lobby.votes[p.playerId]).length;
  if (have >= need && need > 0) danceReveal(code);
}

// Keep an arcade game moving after a player leaves/disconnects mid-round.
function arcadeAfterDepart(code, pid) {
  const lobby = lobbies[code]; if (!lobby) return;
  if (lobby.game === 'draw' && lobby.phase === 'drawing') {
    if (lobby.drawerId === pid) drawEndTurn(code, 'drawer-left');
    else if (connectedNonDrawer(lobby) - Object.keys(lobby.guessed).length <= 0) drawEndTurn(code, 'all-guessed');
  } else if (lobby.game === 'bluff') {
    if (lobby.phase === 'writing') bluffMaybeAdvanceWrite(code);
    else if (lobby.phase === 'guessing') bluffMaybeAdvanceGuess(code);
  } else if (lobby.game === 'quiz' && lobby.phase === 'question') {
    const total = lobby.players.filter(p => p.connected).length;
    if (total > 0 && Object.keys(lobby.answers).length >= total) quizReveal(code);
  } else if (lobby.game === 'truths') {
    if (lobby.phase === 'telling' && lobby.authorId === pid) truthsBeginTelling(code);
    else if (lobby.phase === 'guessing') truthsMaybeAdvanceGuess(code);
  } else if (lobby.game === 'assoc') {
    if (lobby.phase === 'writing') assocMaybeAdvanceWrite(code);
    else if (lobby.phase === 'voting') assocMaybeAdvanceVote(code);
  } else if (lobby.game === 'who') {
    if (lobby.phase === 'voting') whoMaybeAdvanceVote(code);
  } else if (lobby.game === 'dance') {
    if (pid === lobby.impostorId && (lobby.phase === 'dancing' || lobby.phase === 'voting')) danceReveal(code);
    else if (lobby.phase === 'ready') danceMaybeAdvanceReady(code);   // ktoś wyszedł → próg 80% mógł zostać osiągnięty
    else if (lobby.phase === 'dancing') danceMaybeAdvanceSkip(code);
    else if (lobby.phase === 'voting') danceMaybeAdvanceVote(code);
  }
}

// Full snapshot for a reconnecting arcade player.
function arcadeRejoinSnapshot(lobby, pid, isAdmin, code) {
  const base = {
    game: lobby.game, code, isAdmin, phase: lobby.phase,
    settings: lobby.settings, settingOptions: ARCADE_SETTING_OPTIONS[lobby.game],
    players: arcadePlayers(lobby), scoreboard: scoreboardOf(lobby),
    customPrompts: lobby.customPrompts || [],
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
      return { ...base, turnNo: lobby.turnNo, totalTurns: lobby.totalTurns, drawerId: lobby.drawerId, drawerNick: drawer?.nickname ?? '?', amDrawer: pid === lobby.drawerId, word: pid === lobby.drawerId ? lobby.word : null, wordLen: lobby.word.length, endsAt: lobby.endsAt, ops: lobby.ops, alreadyGuessed: !!lobby.guessed[pid] };
    }
    if (lobby.phase === 'reveal') return { ...base, word: lobby.word };
  } else if (lobby.game === 'truths') {
    const author = lobby.players.find(p => p.playerId === lobby.authorId);
    if (lobby.phase === 'telling')  return { ...base, round: lobby.roundNo, total: lobby.maxR, authorId: lobby.authorId, authorNick: author?.nickname ?? '?', amAuthor: pid === lobby.authorId, endsAt: lobby.endsAt };
    if (lobby.phase === 'guessing') return { ...base, round: lobby.roundNo, total: lobby.maxR, authorNick: author?.nickname ?? '?', statements: lobby.statements, amAuthor: pid === lobby.authorId, picked: lobby.guesses[pid] ?? null, endsAt: lobby.endsAt };
    if (lobby.phase === 'reveal')   return { ...base, authorNick: author?.nickname ?? '?' };
  } else if (lobby.game === 'assoc') {
    if (lobby.phase === 'writing')  return { ...base, index: lobby.qIndex, total: lobby.prompts.length, prompt: lobby.prompts[lobby.qIndex], endsAt: lobby.endsAt, submitted: !!(lobby.answers[pid] || '').trim() };
    if (lobby.phase === 'voting')   return { ...base, index: lobby.qIndex, total: lobby.prompts.length, prompt: lobby.prompts[lobby.qIndex], options: lobby.options.map(o => ({ id: o.id, text: o.text, mine: o.ownerId === pid })), picked: lobby.votes[pid] || null, endsAt: lobby.endsAt };
    if (lobby.phase === 'reveal')   return { ...base, prompt: lobby.prompts[lobby.qIndex] };
  } else if (lobby.game === 'who') {
    if (lobby.phase === 'voting')   return { ...base, index: lobby.qIndex, total: lobby.prompts.length, prompt: lobby.prompts[lobby.qIndex], players: arcadePlayers(lobby), picked: lobby.votes[pid] || null, endsAt: lobby.endsAt };
    if (lobby.phase === 'reveal')   return { ...base, prompt: lobby.prompts[lobby.qIndex] };
  } else if (lobby.game === 'dance') {
    const amImp = pid === lobby.impostorId;
    if (lobby.phase === 'ready')    return { ...base, players: arcadePlayers(lobby), need: danceReadyNeed(lobby), endsAt: lobby.endsAt, youReady: !!lobby.ready[pid] };
    if (lobby.phase === 'dancing')  return { ...base, round: lobby.qIndex, total: lobby.settings.rounds, trackIndex: amImp ? lobby.impTrack : lobby.mainTrack, amImpostor: amImp, players: arcadePlayers(lobby), endsAt: lobby.endsAt, startAt: lobby.startAt, skipNeed: danceReadyNeed(lobby), youSkipped: !!(lobby.skip && lobby.skip[pid]) };
    if (lobby.phase === 'voting')   return { ...base, round: lobby.qIndex, total: lobby.settings.rounds, players: arcadePlayers(lobby), picked: lobby.votes[pid] || null, endsAt: lobby.endsAt };
    if (lobby.phase === 'reveal')   return { ...base, round: lobby.qIndex, total: lobby.settings.rounds };
  }
  return base;
}

// ─── SOCKET EVENTS ───────────────────────────────────────────────────────────

// ═══════════════════════════ MONOPOLY ═══════════════════════════
const MONO_TOKENS = ['🎩','🐕','🚗','🚢','👢','🐈','🦖','🛞'];
// t: go|prop|rail|util|tax|chance|chest|jail|parking|gotojail
// prop rent: [baza, 1 dom, 2, 3, 4, hotel]; h = koszt domu
const MONO_BOARD = [
  { t:'go', name:'START' },
  { t:'prop', name:'Ulica Konopacka', group:'brown', price:60, rent:[2,10,30,90,160,250], h:50 },
  { t:'chest', name:'Kasa Społeczna' },
  { t:'prop', name:'Ulica Stalowa', group:'brown', price:60, rent:[4,20,60,180,320,450], h:50 },
  { t:'tax', name:'Podatek dochodowy', amount:200 },
  { t:'rail', name:'Dworzec Zachodni', price:200 },
  { t:'prop', name:'Ulica Radzymińska', group:'lblue', price:100, rent:[6,30,90,270,400,550], h:50 },
  { t:'chance', name:'Szansa' },
  { t:'prop', name:'Ulica Jagiellońska', group:'lblue', price:100, rent:[6,30,90,270,400,550], h:50 },
  { t:'prop', name:'Ulica Targowa', group:'lblue', price:120, rent:[8,40,100,300,450,600], h:50 },
  { t:'jail', name:'Więzienie' },
  { t:'prop', name:'Ulica Sienna', group:'pink', price:140, rent:[10,50,150,450,625,750], h:100 },
  { t:'util', name:'Elektrownia', price:150 },
  { t:'prop', name:'Ulica Marszałkowska', group:'pink', price:140, rent:[10,50,150,450,625,750], h:100 },
  { t:'prop', name:'Plac Bankowy', group:'pink', price:160, rent:[12,60,180,500,700,900], h:100 },
  { t:'rail', name:'Dworzec Główny', price:200 },
  { t:'prop', name:'Ulica Świętokrzyska', group:'orange', price:180, rent:[14,70,200,550,750,950], h:100 },
  { t:'chest', name:'Kasa Społeczna' },
  { t:'prop', name:'Ulica Wolska', group:'orange', price:180, rent:[14,70,200,550,750,950], h:100 },
  { t:'prop', name:'Ulica Chłodna', group:'orange', price:200, rent:[16,80,220,600,800,1000], h:100 },
  { t:'parking', name:'Parking' },
  { t:'prop', name:'Ulica Puławska', group:'red', price:220, rent:[18,90,250,700,875,1050], h:150 },
  { t:'chance', name:'Szansa' },
  { t:'prop', name:'Aleje Jerozolimskie', group:'red', price:220, rent:[18,90,250,700,875,1050], h:150 },
  { t:'prop', name:'Ulica Grójecka', group:'red', price:240, rent:[20,100,300,750,925,1100], h:150 },
  { t:'rail', name:'Dworzec Wschodni', price:200 },
  { t:'prop', name:'Ulica Nowy Świat', group:'yellow', price:260, rent:[22,110,330,800,975,1150], h:150 },
  { t:'prop', name:'Ulica Krakowskie Przedmieście', group:'yellow', price:260, rent:[22,110,330,800,975,1150], h:150 },
  { t:'util', name:'Wodociągi', price:150 },
  { t:'prop', name:'Plac Trzech Krzyży', group:'yellow', price:280, rent:[24,120,360,850,1025,1200], h:150 },
  { t:'gotojail', name:'Idź do więzienia' },
  { t:'prop', name:'Ulica Mokotowska', group:'green', price:300, rent:[26,130,390,900,1100,1275], h:200 },
  { t:'prop', name:'Ulica Marszałka', group:'green', price:300, rent:[26,130,390,900,1100,1275], h:200 },
  { t:'chest', name:'Kasa Społeczna' },
  { t:'prop', name:'Aleja Ujazdowska', group:'green', price:320, rent:[28,150,450,1000,1200,1400], h:200 },
  { t:'rail', name:'Dworzec Gdański', price:200 },
  { t:'chance', name:'Szansa' },
  { t:'prop', name:'Ulica Foksal', group:'dblue', price:350, rent:[35,175,500,1100,1300,1500], h:200 },
  { t:'tax', name:'Podatek luksusowy', amount:100 },
  { t:'prop', name:'Ulica Belwederska', group:'dblue', price:400, rent:[50,200,600,1400,1700,2000], h:200 },
];
const MONO_GROUP_SIZE = {}; MONO_BOARD.forEach(s => { if (s.t==='prop') MONO_GROUP_SIZE[s.group]=(MONO_GROUP_SIZE[s.group]||0)+1; });
// Karty: e = efekt. money | move (to pos, +200 jeśli mija start) | moveBy | jail | jailfree | eachpay (od każdego) | repair (za dom)
const MONO_CHANCE = [
  { text:'Idź na START. Odbierz $200.', e:{move:0} },
  { text:'Idź do więzienia. Nie przechodzisz przez START.', e:{jail:true} },
  { text:'Awansuj na Aleje Jerozolimskie.', e:{move:23} },
  { text:'Cofnij się o 3 pola.', e:{moveBy:-3} },
  { text:'Bank wypłaca Ci dywidendę $50.', e:{money:50} },
  { text:'Mandat za przekroczenie prędkości. Zapłać $15.', e:{money:-15} },
  { text:'Wyjdź za darmo z więzienia. Zachowaj tę kartę.', e:{jailfree:true} },
  { text:'Idź na Dworzec Główny.', e:{move:15} },
  { text:'Zapłać za remonty: $25 za dom, $100 za hotel.', e:{repair:[25,100]} },
  { text:'Wygrałeś konkurs krzyżówkowy. Odbierz $100.', e:{money:100} },
  { text:'Twoje akcje wzrosły. Odbierz $150.', e:{money:150} },
  { text:'Opłata za szkołę. Zapłać $50.', e:{money:-50} },
];
const MONO_CHEST = [
  { text:'Błąd banku na Twoją korzyść. Odbierz $200.', e:{money:200} },
  { text:'Idź do więzienia. Nie przechodzisz przez START.', e:{jail:true} },
  { text:'Zwrot podatku. Odbierz $75.', e:{money:75} },
  { text:'Opłata lekarska. Zapłać $50.', e:{money:-50} },
  { text:'Wyjdź za darmo z więzienia. Zachowaj tę kartę.', e:{jailfree:true} },
  { text:'Idź na START. Odbierz $200.', e:{move:0} },
  { text:'Odziedziczyłeś $100.', e:{money:100} },
  { text:'Składka ubezpieczeniowa. Zapłać $100.', e:{money:-100} },
  { text:'Wygrałeś drugą nagrodę w konkursie piękności. Odbierz $10.', e:{money:10} },
  { text:'Są Twoje urodziny. Zbierz po $10 od każdego gracza.', e:{eachpay:10} },
  { text:'Opłata za szpital. Zapłać $100.', e:{money:-100} },
  { text:'Sprzedaż akcji. Odbierz $50.', e:{money:50} },
];

function monoP(lobby, pid) { return lobby.mono.pl[pid]; }
function monoNick(lobby, pid) { return (lobby.players.find(p => p.playerId===pid)||{}).nickname || '?'; }
function monoLog(lobby, msg) { lobby.mono.log.push(msg); if (lobby.mono.log.length > 40) lobby.mono.log.shift(); }
function monoCurrent(lobby) { return lobby.mono.order[lobby.mono.turn]; }
function monoActive(lobby) { return lobby.mono.order.filter(pid => !lobby.mono.pl[pid].bankrupt); }
function monoPositionsOf(lobby, pid) { return Object.keys(lobby.owner).filter(pos => lobby.owner[pos]===pid).map(Number); }
function monoCountType(lobby, pid, t) { return monoPositionsOf(lobby, pid).filter(pos => MONO_BOARD[pos].t===t).length; }
function monoOwnsFullGroup(lobby, pid, group) {
  for (let i=0;i<40;i++) { const s=MONO_BOARD[i]; if (s.t==='prop' && s.group===group && lobby.owner[i]!==pid) return false; }
  return true;
}
function monoGroupHouseBounds(lobby, group) {
  let min=99, max=0;
  for (let i=0;i<40;i++){ const s=MONO_BOARD[i]; if (s.t==='prop'&&s.group===group){ const h=lobby.houses[i]||0; min=Math.min(min,h); max=Math.max(max,h);} }
  return { min, max };
}
function monoRent(lobby, pos, diceSum) {
  const s = MONO_BOARD[pos]; const owner = lobby.owner[pos];
  if (!owner) return 0;
  if (s.t==='rail') { const c = monoCountType(lobby, owner, 'rail'); return [25,50,100,200][Math.max(0,c-1)]; }
  if (s.t==='util') { const c = monoCountType(lobby, owner, 'util'); return diceSum * (c===2?10:4); }
  const h = lobby.houses[pos]||0;
  if (h>0) return s.rent[h];
  return monoOwnsFullGroup(lobby, owner, s.group) ? s.rent[0]*2 : s.rent[0];
}
function monoNetWorth(lobby, pid) {
  const p = monoP(lobby, pid); let w = p.money;
  monoPositionsOf(lobby, pid).forEach(pos => { const s=MONO_BOARD[pos]; w += (s.price||0); w += (lobby.houses[pos]||0)*(s.h||0); });
  return w;
}

function monoStart(code) {
  const lobby = lobbies[code];
  const order = shuffle(lobby.players.map(p => p.playerId));
  const pl = {};
  order.forEach((pid, i) => { pl[pid] = { money:1500, pos:0, jail:false, jailTurns:0, jailCards:0, bankrupt:false, token:MONO_TOKENS[i%MONO_TOKENS.length] }; });
  lobby.owner = {}; lobby.houses = {};
  lobby.mono = {
    order, turn:0, phase:'preroll', dice:[0,0], doubles:0, rolledThisTurn:false,
    pending:null, log:[], pl,
    chance: shuffle(MONO_CHANCE.map((_,i)=>i)), chanceP:0,
    chest:  shuffle(MONO_CHEST.map((_,i)=>i)),  chestP:0,
    winner:null, trade:null,
  };
  lobby.phase = 'playing';
  monoLog(lobby, `🎲 Gra rozpoczęta! Zaczyna ${monoNick(lobby, order[0])}.`);
  monoBroadcast(code);
  broadcastPublicLobbies();
}
function monoStateFor(lobby, pid) {
  const m = lobby.mono;
  return {
    phase: lobby.phase, gamePhase: m.phase,
    order: m.order, turn: m.turn, current: monoCurrent(lobby),
    dice: m.dice, doubles: m.doubles, pending: m.pending,
    winner: m.winner, log: m.log.slice(-14),
    you: pid,
    players: m.order.map(id => ({
      id, nick: monoNick(lobby, id), token: m.pl[id].token,
      money: m.pl[id].money, pos: m.pl[id].pos, jail: m.pl[id].jail,
      jailCards: m.pl[id].jailCards, bankrupt: m.pl[id].bankrupt,
      connected: (lobby.players.find(p=>p.playerId===id)||{}).connected !== false,
    })),
    owner: lobby.owner, houses: lobby.houses,
    tradePending: !!m.trade,
  };
}
// ── handel ──
function monoGroupHasHouses(lobby, group) {
  for (let i=0;i<40;i++){ const s=MONO_BOARD[i]; if (s.t==='prop'&&s.group===group&&(lobby.houses[i]||0)>0) return true; }
  return false;
}
function monoPropTradeable(lobby, pos) {
  const s = MONO_BOARD[pos]; if (!s) return false;
  if (s.t==='prop') return !monoGroupHasHouses(lobby, s.group);
  return s.t==='rail' || s.t==='util';
}
function monoExecTrade(code) {
  const lobby = lobbies[code]; const m = lobby.mono; const t = m.trade; if (!t) return;
  const from = monoP(lobby, t.from), to = monoP(lobby, t.to);
  t.giveProps.forEach(pos => { lobby.owner[pos] = t.to; });
  t.getProps.forEach(pos => { lobby.owner[pos] = t.from; });
  from.money += t.getMoney - t.giveMoney;
  to.money   += t.giveMoney - t.getMoney;
  monoLog(lobby, `🤝 ${monoNick(lobby,t.from)} i ${monoNick(lobby,t.to)} zawarli transakcję.`);
  m.trade = null;
  monoBroadcast(code);
}
function monoBroadcast(code) {
  const lobby = lobbies[code]; if (!lobby || !lobby.mono) return;
  lobby.players.forEach(p => io.to(p.socketId).emit('monoState', monoStateFor(lobby, p.playerId)));
}
function monoDraw(lobby, code, which) {
  const m = lobby.mono;
  const deck = which==='chance' ? MONO_CHANCE : MONO_CHEST;
  const idxArr = which==='chance' ? m.chance : m.chest;
  const ptrKey = which==='chance' ? 'chanceP' : 'chestP';
  const card = deck[idxArr[m[ptrKey]]];
  m[ptrKey] = (m[ptrKey]+1) % idxArr.length;
  const pid = monoCurrent(lobby); const p = monoP(lobby, pid);
  monoLog(lobby, `🃏 ${monoNick(lobby,pid)}: ${card.text}`);
  const e = card.e;
  if (e.money) { if (e.money>0) p.money += e.money; else return monoCharge(lobby, code, pid, -e.money, null, () => monoAfterResolve(code)); }
  if (typeof e.move === 'number') { monoMoveTo(lobby, code, pid, e.move, true); return monoResolveLanding(code); }
  if (typeof e.moveBy === 'number') { p.pos = ((p.pos + e.moveBy) % 40 + 40) % 40; return monoResolveLanding(code); }
  if (e.jail) { monoGoToJail(lobby, code, pid); return monoEndTurn(code, true); }
  if (e.jailfree) { p.jailCards += 1; }
  if (e.eachpay) { monoActive(lobby).forEach(o => { if (o!==pid) { const op=monoP(lobby,o); const amt=Math.min(e.eachpay, op.money); op.money-=amt; p.money+=amt; } }); }
  if (e.repair) { const houses=monoPositionsOf(lobby,pid).reduce((a,pos)=>a+((lobby.houses[pos]||0)===5?0:(lobby.houses[pos]||0)),0); const hotels=monoPositionsOf(lobby,pid).filter(pos=>(lobby.houses[pos]||0)===5).length; const bill=houses*e.repair[0]+hotels*e.repair[1]; if (bill>0) return monoCharge(lobby, code, pid, bill, null, () => monoAfterResolve(code)); }
  monoAfterResolve(code);
}
function monoMoveTo(lobby, code, pid, dest, mayCollect) {
  const p = monoP(lobby, pid);
  if (mayCollect && dest <= p.pos) { p.money += 200; monoLog(lobby, `💵 ${monoNick(lobby,pid)} mija START (+$200).`); }
  p.pos = dest;
}
function monoGoToJail(lobby, code, pid) {
  const p = monoP(lobby, pid); p.pos = 10; p.jail = true; p.jailTurns = 0;
  monoLog(lobby, `🚔 ${monoNick(lobby,pid)} trafia do więzienia!`);
}
function monoRoll(code) {
  const lobby = lobbies[code]; const m = lobby.mono;
  const pid = monoCurrent(lobby); const p = monoP(lobby, pid);
  const d1 = 1+Math.floor(Math.random()*6), d2 = 1+Math.floor(Math.random()*6);
  m.dice = [d1, d2]; const sum = d1+d2; const dbl = d1===d2;
  if (p.jail) {
    if (dbl) { p.jail=false; p.jailTurns=0; monoLog(lobby, `🎲 ${monoNick(lobby,pid)} wyrzuca dublet (${d1}+${d2}) i wychodzi z więzienia!`); m.rolledThisTurn=true; monoAdvance(code, pid, sum); return; }
    p.jailTurns += 1;
    monoLog(lobby, `🎲 ${monoNick(lobby,pid)} nie wyrzuca dubletu (${d1}+${d2}).`);
    if (p.jailTurns >= 3) { monoLog(lobby, `${monoNick(lobby,pid)} płaci $50 i wychodzi.`); return monoCharge(lobby, code, pid, 50, null, () => { p.jail=false; p.jailTurns=0; monoAdvance(code, pid, sum); }); }
    m.dice=[d1,d2]; return monoEndTurn(code, true);  // zostaje w więzieniu
  }
  if (dbl) m.doubles += 1; else m.doubles = 0;
  if (m.doubles === 3) { monoLog(lobby, `🎲 ${monoNick(lobby,pid)} trzeci dublet z rzędu!`); monoGoToJail(lobby, code, pid); return monoEndTurn(code, true); }
  m.rolledThisTurn = true;
  monoLog(lobby, `🎲 ${monoNick(lobby,pid)} wyrzuca ${d1}+${d2}=${sum}${dbl?' (dublet!)':''}.`);
  monoAdvance(code, pid, sum);
}
function monoAdvance(code, pid, sum) {
  const lobby = lobbies[code]; const p = monoP(lobby, pid);
  const old = p.pos; p.pos = (p.pos + sum) % 40;
  if (old + sum >= 40) { p.money += 200; monoLog(lobby, `💵 ${monoNick(lobby,pid)} mija START (+$200).`); }
  monoResolveLanding(code);
}
function monoResolveLanding(code) {
  const lobby = lobbies[code]; const m = lobby.mono;
  const pid = monoCurrent(lobby); const p = monoP(lobby, pid);
  const pos = p.pos; const s = MONO_BOARD[pos]; const sum = m.dice[0]+m.dice[1];
  if (s.t==='prop' || s.t==='rail' || s.t==='util') {
    const owner = lobby.owner[pos];
    if (!owner) {
      if (p.money >= s.price) { m.pending = { type:'buy', pos, price:s.price, name:s.name }; m.phase='buy'; return monoBroadcast(code); }
      monoLog(lobby, `${monoNick(lobby,pid)} nie stać na ${s.name}.`); return monoAfterResolve(code);
    }
    if (owner === pid) return monoAfterResolve(code);
    const rent = monoRent(lobby, pos, sum);
    monoLog(lobby, `💸 ${monoNick(lobby,pid)} płaci $${rent} czynszu dla ${monoNick(lobby,owner)} (${s.name}).`);
    return monoCharge(lobby, code, pid, rent, owner, () => monoAfterResolve(code));
  }
  if (s.t==='tax') { monoLog(lobby, `🏛️ ${monoNick(lobby,pid)} płaci ${s.name} $${s.amount}.`); return monoCharge(lobby, code, pid, s.amount, null, () => monoAfterResolve(code)); }
  if (s.t==='chance') return monoDraw(lobby, code, 'chance');
  if (s.t==='chest')  return monoDraw(lobby, code, 'chest');
  if (s.t==='gotojail') { monoGoToJail(lobby, code, pid); return monoEndTurn(code, true); }
  return monoAfterResolve(code);   // go / parking / jail(odwiedziny)
}
// Po rozpatrzeniu pola: jeśli nie ma zaległości, pozwól budować / zakończyć / rzucić ponownie.
function monoAfterResolve(code) {
  const lobby = lobbies[code]; const m = lobby.mono;
  if (m.pending && m.pending.type==='debt') { m.phase='debt'; return monoBroadcast(code); }
  m.pending = null; m.phase = 'action';
  monoBroadcast(code);
}
// Pobranie kwoty; jeśli nie stać → tryb długu (sprzedaż domów / bankructwo).
function monoCharge(lobby, code, pid, amount, toPid, done) {
  const p = monoP(lobby, pid);
  if (p.money >= amount) { p.money -= amount; if (toPid) monoP(lobby,toPid).money += amount; lobby.mono._done=null; return done(); }
  lobby.mono.pending = { type:'debt', amount, to: toPid||null };
  lobby.mono._done = done ? true : false;   // wznowienie po spłacie
  lobby.mono._doneFn = done;
  lobby.mono.phase = 'debt';
  monoBroadcast(code);
}
function monoTrySettleDebt(code) {
  const lobby = lobbies[code]; const m = lobby.mono; const pend = m.pending;
  if (!pend || pend.type!=='debt') return;
  const pid = monoCurrent(lobby); const p = monoP(lobby, pid);
  if (p.money >= pend.amount) {
    p.money -= pend.amount; if (pend.to) monoP(lobby,pend.to).money += pend.amount;
    m.pending = null; const fn = m._doneFn; m._doneFn=null;
    if (fn) fn(); else monoAfterResolve(code);
  } else { monoBroadcast(code); }
}
function monoBankrupt(code, pid) {
  const lobby = lobbies[code]; const m = lobby.mono; const p = monoP(lobby, pid);
  const cred = (m.pending && m.pending.type==='debt') ? m.pending.to : null;
  monoPositionsOf(lobby, pid).forEach(pos => { lobby.houses[pos]=0; if (cred) lobby.owner[pos]=cred; else delete lobby.owner[pos]; });
  if (cred) monoP(lobby, cred).money += Math.max(0, p.money);
  p.money = 0; p.bankrupt = true;
  monoLog(lobby, `💀 ${monoNick(lobby,pid)} bankrutuje!${cred?` Majątek przejmuje ${monoNick(lobby,cred)}.`:''}`);
  m.pending = null; m._doneFn = null;
  if (m.trade && (m.trade.from===pid || m.trade.to===pid)) m.trade = null;
  const active = monoActive(lobby);
  if (active.length <= 1) { m.phase='finished'; m.winner = active[0]||null; lobby.phase='finished'; monoLog(lobby, `🏆 Wygrywa ${monoNick(lobby, m.winner)}!`); return monoBroadcast(code); }
  // Był to bankrut aktualnego gracza → następna kolej.
  monoNextTurn(code, true);
}
function monoEndTurn(code, force) {
  const lobby = lobbies[code]; const m = lobby.mono;
  if (m.pending && m.pending.type==='debt' && !force) return;
  const pid = monoCurrent(lobby); const p = monoP(lobby, pid);
  // Dublet (i nie w więzieniu, nie force) → ten sam gracz rzuca ponownie.
  if (!force && m.doubles>0 && m.doubles<3 && !p.jail && m.rolledThisTurn) {
    m.phase='preroll'; m.rolledThisTurn=false; m.pending=null; monoLog(lobby, `↻ ${monoNick(lobby,pid)} rzuca ponownie (dublet).`); return monoBroadcast(code);
  }
  monoNextTurn(code, false);
}
function monoNextTurn(code, fromBankrupt) {
  const lobby = lobbies[code]; const m = lobby.mono;
  m.doubles=0; m.rolledThisTurn=false; m.pending=null; m._doneFn=null;
  let guard=0;
  do { m.turn = (m.turn+1) % m.order.length; guard++; }
  while (guard <= m.order.length && monoP(lobby, m.order[m.turn]).bankrupt);
  m.phase='preroll';
  monoBroadcast(code);
}
// Wyjście/rozłączenie gracza w trakcie gry.
function monoAfterDepart(code, pid) {
  const lobby = lobbies[code]; if (!lobby || lobby.game!=='monopoly' || !lobby.mono || lobby.phase!=='playing') return;
  const m = lobby.mono; const p = m.pl[pid]; if (!p || p.bankrupt) return;
  // Traktuj wyjście jak bankructwo (zwrot majątku do banku).
  monoPositionsOf(lobby, pid).forEach(pos => { lobby.houses[pos]=0; delete lobby.owner[pos]; });
  p.bankrupt = true; p.money = 0;
  if (m.trade && (m.trade.from===pid || m.trade.to===pid)) m.trade = null;
  monoLog(lobby, `👋 ${monoNick(lobby,pid)} opuścił grę.`);
  const active = monoActive(lobby);
  if (active.length <= 1) { m.phase='finished'; m.winner=active[0]||null; lobby.phase='finished'; if (m.winner) monoLog(lobby, `🏆 Wygrywa ${monoNick(lobby,m.winner)}!`); return monoBroadcast(code); }
  if (monoCurrent(lobby)===pid) return monoNextTurn(code, true);
  monoBroadcast(code);
}

io.on('connection', socket => {

  // CREATE LOBBY
  socket.on('createLobby', ({ nickname, playerId, game, visibility, password }) => {
    const pid      = playerId || generateId();
    const code     = generateCode();
    const valid    = ['czolko','panstwa','monopoly', ...ARCADE_GAME_TYPES];
    const gameType = valid.includes(game) ? game : 'czolko';

    const basePlayer = { playerId: pid, socketId: socket.id, nickname, connected: true, disconnectTimer: null, word: null, score: 0 };

    if (gameType === 'czolko') {
      lobbies[code] = { game: 'czolko', admin: pid, players: [basePlayer], phase: 'waiting', assignments: [], assignTimeout: null, winner: null, endVotes: {}, endVoteTimeout: null };
    } else if (gameType === 'monopoly') {
      lobbies[code] = { game: 'monopoly', admin: pid, players: [basePlayer], phase: 'waiting', mono: null, owner: {}, houses: {} };
    } else if (gameType === 'panstwa') {
      lobbies[code] = { game: 'panstwa', admin: pid, players: [basePlayer], phase: 'waiting', categories: DEFAULT_CATEGORIES.slice(), availableCategories: ALL_CATEGORIES.slice(), maxRounds: DEFAULT_MAX_ROUNDS, roundMs: ROUND_MS, round: 0, currentLetter: null, answers: {}, roundTimeout: null, roundEndsAt: 0, stopping: false, lastResults: null, reviewData: null, reviewVotes: {}, aiVerdicts: {}, roundFinalized: false };
    } else {
      const settings = gameType === 'quiz'  ? { questions: 10, difficulty: 'medium' }
                     : gameType === 'draw'  ? { laps: 2 }
                     : gameType === 'dance' ? { rounds: 5, danceMs: 120_000 }
                     :                        { rounds: 5 };   // bluff / truths / assoc
      lobbies[code] = { game: gameType, admin: pid, players: [basePlayer], phase: 'waiting', settings, timer: null, customPrompts: [] };
    }

    // Public / private visibility + optional password (public only).
    lobbies[code].visibility = visibility === 'public' ? 'public' : 'private';
    lobbies[code].password   = (lobbies[code].visibility === 'public' && typeof password === 'string')
      ? password.trim().slice(0, 20) : '';

    socket.join(code);
    socket.leave('lobby-browser');
    socket.lobbyCode = code;
    socket.playerId  = pid;
    socket.emit('lobbyCreated', {
      code, playerId: pid, game: gameType,
      allCategories: gameType === 'panstwa' ? lobbies[code].availableCategories : undefined,
      maxRounds:     gameType === 'panstwa' ? lobbies[code].maxRounds : undefined,
      roundOptions:  gameType === 'panstwa' ? ROUND_OPTIONS : undefined,
      roundMs:       gameType === 'panstwa' ? lobbies[code].roundMs : undefined,
      settings:      lobbies[code].settings,
      settingOptions: ARCADE_SETTING_OPTIONS[gameType],
    });
    if (ARCADE_GAME_TYPES.includes(gameType)) broadcastArcadeLobby(code);
    else broadcastLobby(code);
  });

  // JOIN LOBBY
  socket.on('joinLobby', ({ code, nickname, playerId, password }) => {
    code = (typeof code === 'string' ? code : '').trim().toUpperCase();
    const lobby = lobbies[code];
    if (!lobby)                                              return socket.emit('error', 'Nie ma takiego lobby!');
    if (lobby.phase !== 'waiting')                           return socket.emit('error', 'Gra już trwa!');
    if (lobby.password && (password || '').trim() !== lobby.password) return socket.emit('joinNeedsPassword', { code, wrong: !!(password || '').trim() });
    if (lobby.game === 'panstwa' && lobby.players.length >= MAX_PM_PLAYERS) return socket.emit('error', 'Lobby jest pełne (max 15 graczy)!');
    if (lobby.game === 'monopoly' && lobby.players.length >= 8) return socket.emit('error', 'Lobby jest pełne (max 8 graczy)!');

    const pid = playerId || generateId();
    lobby.players.push({ playerId: pid, socketId: socket.id, nickname, connected: true, disconnectTimer: null, word: null, score: 0 });
    socket.join(code);
    socket.leave('lobby-browser');
    socket.lobbyCode = code;
    socket.playerId  = pid;
    socket.emit('joinedLobby', {
      code, playerId: pid, game: lobby.game,
      allCategories: lobby.game === 'panstwa' ? lobby.availableCategories : undefined,
      maxRounds:     lobby.game === 'panstwa' ? lobby.maxRounds : undefined,
      roundOptions:  lobby.game === 'panstwa' ? ROUND_OPTIONS : undefined,
      roundMs:       lobby.game === 'panstwa' ? lobby.roundMs : undefined,
      settings:      lobby.settings,
      settingOptions: ARCADE_SETTING_OPTIONS[lobby.game],
    });
    if (ARCADE_GAME_TYPES.includes(lobby.game)) broadcastArcadeLobby(code);
    else broadcastLobby(code);
  });

  // PUBLIC LOBBY BROWSER (home screen list)
  socket.on('browsePublic', () => {
    socket.join('lobby-browser');
    socket.emit('publicLobbies', publicLobbyList());
  });
  socket.on('stopBrowse', () => socket.leave('lobby-browser'));

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

    if (ARCADE_GAME_TYPES.includes(lobby.game)) {
      socket.emit('arcadeRejoin', arcadeRejoinSnapshot(lobby, playerId, isAdmin, code));
      broadcastArcadeLobby(code);
      return;
    }

    if (lobby.game === 'monopoly') {
      if (lobby.phase === 'waiting') socket.emit('rejoinState', { ...base, phase: 'waiting' });
      else socket.emit('monoState', monoStateFor(lobby, playerId));
      broadcastLobby(code);
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
      const extra = { allCategories: lobby.availableCategories, categories: lobby.categories, maxRounds: lobby.maxRounds, roundOptions: ROUND_OPTIONS, roundMs: lobby.roundMs, scoreboard: publicPlayers(lobby).sort((a,b) => b.score - a.score) };
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
    broadcastPublicLobbies();
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

  // Admin adjusts the round length by ±15 s.
  socket.on('setRoundTime', ({ delta }) => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    if (delta !== ROUND_MS_STEP && delta !== -ROUND_MS_STEP) return;
    lobby.roundMs = Math.max(ROUND_MS_MIN, Math.min(ROUND_MS_MAX, (lobby.roundMs || ROUND_MS) + delta));
    broadcastLobby(code);
  });

  socket.on('startGame', () => {
    const code  = socket.lobbyCode;
    const lobby = lobbies[code];
    if (!lobby || lobby.game !== 'panstwa' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    if (lobby.players.length < 2)   return socket.emit('error', 'Potrzeba minimum 2 graczy!');
    if (lobby.categories.length < 3) return socket.emit('error', 'Wybierz minimum 3 kategorie!');
    pmBeginRound(code);
    broadcastPublicLobbies();
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

  const isArcade = l => l && ARCADE_GAME_TYPES.includes(l.game);

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
    if (lobby.game === 'dance' && lobby.players.length < 3) return socket.emit('error', 'Tańczereczki: potrzeba minimum 3 graczy!');
    if (lobby.game === 'quiz')        quizStart(code);
    else if (lobby.game === 'bluff')  bluffStart(code);
    else if (lobby.game === 'draw')   drawStart(code);
    else if (lobby.game === 'truths') truthsStart(code);
    else if (lobby.game === 'assoc')  assocStart(code);
    else if (lobby.game === 'who')    whoStart(code);
    else if (lobby.game === 'dance')  danceStart(code);
    broadcastPublicLobbies();
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
    const total = lobby.players.filter(p => p.connected).length;
    io.to(socket.lobbyCode).emit('quizProgress', { answered, total });
    // Everyone answered → don't sit on an easy question: cut remaining to 5 s.
    if (answered >= total && total > 0 && lobby.qEndsAt - Date.now() > 5000) {
      lobby.qEndsAt = Date.now() + 5000;
      clearGameTimer(lobby);
      lobby.timer = setTimeout(() => quizReveal(socket.lobbyCode), 5000);
      io.to(socket.lobbyCode).emit('quizHurry', { endsAt: lobby.qEndsAt });
    }
  });

  socket.on('quizDifficulty', ({ level }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'quiz' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    if (!['easy','medium','hard'].includes(level)) return;
    lobby.settings.difficulty = level;
    broadcastArcadeLobby(code);
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
  // Live stroke segments (for smooth real-time drawing) – not stored; the
  // finished stroke arrives as an op via drawOp for undo/rejoin.
  socket.on('drawStroke', (data) => {
    const lobby = lobbies[socket.lobbyCode];
    if (!lobby || lobby.game !== 'draw' || lobby.phase !== 'drawing' || socket.playerId !== lobby.drawerId) return;
    if (!data || typeof data !== 'object') return;
    socket.to(socket.lobbyCode).emit('drawStroke', data);       // to everyone except drawer
  });

  // A completed operation (finished stroke, fill or shape) – stored for undo
  // and replayed for players who (re)join mid-turn.
  socket.on('drawOp', (op) => {
    const lobby = lobbies[socket.lobbyCode];
    if (!lobby || lobby.game !== 'draw' || lobby.phase !== 'drawing' || socket.playerId !== lobby.drawerId) return;
    if (!op || typeof op !== 'object') return;
    lobby.ops.push(op);
    if (lobby.ops.length > 2000) lobby.ops.shift();             // cap memory
    socket.to(socket.lobbyCode).emit('drawOp', op);             // everyone except drawer
  });

  socket.on('drawUndo', () => {
    const lobby = lobbies[socket.lobbyCode];
    if (!lobby || lobby.game !== 'draw' || lobby.phase !== 'drawing' || socket.playerId !== lobby.drawerId) return;
    lobby.ops.pop();
    socket.to(socket.lobbyCode).emit('drawUndo');
  });

  socket.on('drawClear', () => {
    const lobby = lobbies[socket.lobbyCode];
    if (!lobby || lobby.game !== 'draw' || lobby.phase !== 'drawing' || socket.playerId !== lobby.drawerId) return;
    lobby.ops = [];
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

  // 2 PRAWDY 1 KŁAMSTWO
  socket.on('truthsSubmit', ({ statements, lieIndex }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'truths' || lobby.phase !== 'telling' || socket.playerId !== lobby.authorId) return;
    if (!Array.isArray(statements) || statements.length !== 3) return;
    const clean = statements.map(s => (s || '').trim().slice(0, 100));
    if (clean.some(s => !s)) return socket.emit('error', 'Wpisz wszystkie 3 zdania!');
    if (typeof lieIndex !== 'number' || lieIndex < 0 || lieIndex > 2) return;
    lobby.statements = clean; lobby.lieIndex = lieIndex;
    truthsToGuessing(code);
  });
  socket.on('truthsGuess', ({ index }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'truths' || lobby.phase !== 'guessing' || !socket.playerId) return;
    if (socket.playerId === lobby.authorId) return;
    if (typeof index !== 'number' || index < 0 || index > 2) return;
    lobby.guesses[socket.playerId] = index;
    const need = lobby.players.filter(p => p.connected && p.playerId !== lobby.authorId).length;
    const have = lobby.players.filter(p => p.connected && p.playerId !== lobby.authorId && lobby.guesses[p.playerId] != null).length;
    io.to(code).emit('truthsProgress', { have, need });
    truthsMaybeAdvanceGuess(code);
  });

  // NAJGORSZE SKOJARZENIA
  socket.on('assocSubmit', ({ text }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'assoc' || lobby.phase !== 'writing' || !socket.playerId) return;
    const clean = (text || '').trim().slice(0, 80);
    if (!clean) return;
    lobby.answers[socket.playerId] = clean;
    const need = lobby.players.filter(p => p.connected).length;
    const have = lobby.players.filter(p => p.connected && (lobby.answers[p.playerId] || '').trim()).length;
    io.to(code).emit('assocWriteProgress', { have, need });
    assocMaybeAdvanceWrite(code);
  });
  socket.on('assocVote', ({ optionId }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'assoc' || lobby.phase !== 'voting' || !socket.playerId) return;
    const opt = (lobby.options || []).find(o => o.id === optionId);
    if (!opt || opt.ownerId === socket.playerId) return;         // can't vote your own
    lobby.votes[socket.playerId] = optionId;
    const need = lobby.players.filter(p => p.connected).length;
    const have = lobby.players.filter(p => p.connected && lobby.votes[p.playerId]).length;
    io.to(code).emit('assocVoteProgress', { have, need });
    assocMaybeAdvanceVote(code);
  });

  // KTO Z NAS?
  socket.on('whoVote', ({ targetId }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'who' || lobby.phase !== 'voting' || !socket.playerId) return;
    if (!lobby.players.some(p => p.playerId === targetId)) return;   // must vote for a real player
    lobby.votes[socket.playerId] = targetId;
    const need = lobby.players.filter(p => p.connected).length;
    const have = lobby.players.filter(p => p.connected && lobby.votes[p.playerId]).length;
    io.to(code).emit('whoVoteProgress', { have, need });
    whoMaybeAdvanceVote(code);
  });
  // Admin adds a custom "Kto z nas...?" prompt (used in this lobby's game).
  socket.on('whoAddPrompt', ({ text }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'who' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    lobby.customPrompts = lobby.customPrompts || [];
    let clean = (text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!clean) return socket.emit('error', 'Wpisz treść pytania!');
    if (!/[?？]$/.test(clean)) clean += '?';
    const dupe = p => p.toLowerCase() === clean.toLowerCase();
    if (lobby.customPrompts.some(dupe) || WHO_PROMPTS.some(dupe))
      return socket.emit('error', 'Takie pytanie już jest!');
    if (lobby.customPrompts.length >= 50) return socket.emit('error', 'Maksymalnie 50 własnych pytań!');
    lobby.customPrompts.push(clean);
    broadcastArcadeLobby(code);
  });
  socket.on('whoRemovePrompt', ({ index }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'who' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    if (!Array.isArray(lobby.customPrompts) || index < 0 || index >= lobby.customPrompts.length) return;
    lobby.customPrompts.splice(index, 1);
    broadcastArcadeLobby(code);
  });

  // TAŃCZERECZKI
  socket.on('danceReady', () => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'dance' || lobby.phase !== 'ready' || !socket.playerId) return;
    lobby.ready[socket.playerId] = true;
    const have = lobby.players.filter(p => p.connected && lobby.ready[p.playerId]).length;
    io.to(code).emit('danceReadyProgress', { have, need: danceReadyNeed(lobby) });
    danceMaybeAdvanceReady(code);
  });
  // W trakcie tańca: „kończymy muzykę i głosujemy" — gdy 80% za, przejście do głosowania.
  socket.on('danceSkipVote', () => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'dance' || lobby.phase !== 'dancing' || !socket.playerId) return;
    lobby.skip = lobby.skip || {};
    lobby.skip[socket.playerId] = true;
    const have = lobby.players.filter(p => p.connected && lobby.skip[p.playerId]).length;
    io.to(code).emit('danceSkipProgress', { have, need: danceReadyNeed(lobby) });
    danceMaybeAdvanceSkip(code);
  });
  // Admin ustawia długość tańca (przed startem gry).
  socket.on('danceSetTime', ({ ms }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'dance' || lobby.admin !== socket.playerId || lobby.phase !== 'waiting') return;
    if (!DANCE_DURATIONS.includes(ms)) return;
    lobby.settings.danceMs = ms;
    broadcastArcadeLobby(code);
  });
  socket.on('danceVote', ({ targetId }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game !== 'dance' || lobby.phase !== 'voting' || !socket.playerId) return;
    if (targetId === socket.playerId) return;                        // can't vote yourself
    if (!lobby.players.some(p => p.playerId === targetId)) return;
    lobby.votes[socket.playerId] = targetId;
    const need = lobby.players.filter(p => p.connected).length;
    const have = lobby.players.filter(p => p.connected && lobby.votes[p.playerId]).length;
    io.to(code).emit('danceVoteProgress', { have, need });
    danceMaybeAdvanceVote(code);
  });

  // ── MONOPOLY ─────────────────────────────────────────────────────────────────
  function monoIsCurrent(lobby) { return lobby && lobby.game==='monopoly' && lobby.phase==='playing' && monoCurrent(lobby)===socket.playerId; }
  socket.on('monoStart', () => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game!=='monopoly' || lobby.admin!==socket.playerId || lobby.phase!=='waiting') return;
    if (lobby.players.length < 2) return socket.emit('error', 'Monopoly: potrzeba minimum 2 graczy!');
    monoStart(code);
  });
  socket.on('monoRoll', () => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!monoIsCurrent(lobby) || lobby.mono.phase!=='preroll') return;
    monoRoll(code);
  });
  socket.on('monoBuy', () => {
    const code = socket.lobbyCode, lobby = lobbies[code]; if (!monoIsCurrent(lobby)) return;
    const m = lobby.mono; if (m.phase!=='buy' || !m.pending || m.pending.type!=='buy') return;
    const pid = socket.playerId, p = monoP(lobby, pid), pos = m.pending.pos, s = MONO_BOARD[pos];
    if (p.money < s.price || lobby.owner[pos]) return;
    p.money -= s.price; lobby.owner[pos] = pid;
    monoLog(lobby, `🏠 ${monoNick(lobby,pid)} kupuje ${s.name} za $${s.price}.`);
    m.pending = null; m.phase = 'action'; monoBroadcast(code);
  });
  socket.on('monoDecline', () => {
    const code = socket.lobbyCode, lobby = lobbies[code]; if (!monoIsCurrent(lobby)) return;
    const m = lobby.mono; if (m.phase!=='buy') return;
    m.pending = null; m.phase = 'action'; monoBroadcast(code);
  });
  socket.on('monoBuild', ({ pos }) => {
    const code = socket.lobbyCode, lobby = lobbies[code]; if (!monoIsCurrent(lobby)) return;
    const m = lobby.mono; if (!['preroll','action'].includes(m.phase)) return;
    const s = MONO_BOARD[pos]; if (!s || s.t!=='prop') return;
    const pid = socket.playerId, p = monoP(lobby, pid);
    if (lobby.owner[pos]!==pid || !monoOwnsFullGroup(lobby, pid, s.group)) return;
    const h = lobby.houses[pos]||0; if (h>=5) return;
    const b = monoGroupHouseBounds(lobby, s.group); if (h !== b.min) return;    // buduj równo
    if (p.money < s.h) return socket.emit('error', 'Za mało gotówki na dom!');
    p.money -= s.h; lobby.houses[pos] = h+1;
    monoLog(lobby, `🏗️ ${monoNick(lobby,pid)} buduje ${h+1===5?'hotel':'dom'} na ${s.name}.`);
    monoBroadcast(code);
  });
  socket.on('monoSellHouse', ({ pos }) => {
    const code = socket.lobbyCode, lobby = lobbies[code]; if (!monoIsCurrent(lobby)) return;
    const m = lobby.mono; if (!['preroll','action','debt'].includes(m.phase)) return;
    const s = MONO_BOARD[pos]; if (!s || s.t!=='prop') return;
    const pid = socket.playerId, p = monoP(lobby, pid);
    if (lobby.owner[pos]!==pid) return;
    const h = lobby.houses[pos]||0; if (h<=0) return;
    const b = monoGroupHouseBounds(lobby, s.group); if (h !== b.max) return;    // sprzedawaj równo
    lobby.houses[pos] = h-1; p.money += Math.floor(s.h/2);
    monoLog(lobby, `💰 ${monoNick(lobby,pid)} sprzedaje ${h===5?'hotel':'dom'} na ${s.name} (+$${Math.floor(s.h/2)}).`);
    if (m.phase==='debt') monoTrySettleDebt(code); else monoBroadcast(code);
  });
  socket.on('monoEndTurn', () => {
    const code = socket.lobbyCode, lobby = lobbies[code]; if (!monoIsCurrent(lobby)) return;
    if (lobby.mono.phase!=='action') return;
    monoEndTurn(code, false);
  });
  socket.on('monoPayJail', () => {
    const code = socket.lobbyCode, lobby = lobbies[code]; if (!monoIsCurrent(lobby)) return;
    const m = lobby.mono; const pid = socket.playerId, p = monoP(lobby, pid);
    if (m.phase!=='preroll' || !p.jail) return;
    monoCharge(lobby, code, pid, 50, null, () => { p.jail=false; p.jailTurns=0; monoLog(lobby, `🔓 ${monoNick(lobby,pid)} płaci $50 i wychodzi z więzienia.`); monoBroadcast(code); });
  });
  socket.on('monoUseJailCard', () => {
    const code = socket.lobbyCode, lobby = lobbies[code]; if (!monoIsCurrent(lobby)) return;
    const m = lobby.mono; const pid = socket.playerId, p = monoP(lobby, pid);
    if (m.phase!=='preroll' || !p.jail || p.jailCards<=0) return;
    p.jailCards -= 1; p.jail=false; p.jailTurns=0;
    monoLog(lobby, `🔓 ${monoNick(lobby,pid)} używa karty i wychodzi z więzienia.`);
    monoBroadcast(code);
  });
  socket.on('monoBankrupt', () => {
    const code = socket.lobbyCode, lobby = lobbies[code]; if (!monoIsCurrent(lobby)) return;
    if (lobby.mono.phase!=='debt') return;
    monoBankrupt(code, socket.playerId);
  });
  // Handel — dowolny gracz może zaproponować wymianę innemu (w każdej chwili).
  socket.on('monoProposeTrade', ({ to, giveProps, giveMoney, getProps, getMoney }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game!=='monopoly' || lobby.phase!=='playing') return;
    const m = lobby.mono; const from = socket.playerId;
    if (m.trade) return socket.emit('error', 'Trwa już inna wymiana — poczekaj.');
    if (!m.pl[from] || m.pl[from].bankrupt || !m.pl[to] || m.pl[to].bankrupt || from===to) return;
    giveProps = (giveProps||[]).map(Number); getProps = (getProps||[]).map(Number);
    giveMoney = Math.max(0, Math.floor(giveMoney||0)); getMoney = Math.max(0, Math.floor(getMoney||0));
    if (giveProps.length+getProps.length===0 && giveMoney===0 && getMoney===0) return;
    if (!giveProps.every(pos => lobby.owner[pos]===from && monoPropTradeable(lobby,pos))) return socket.emit('error', 'Nie możesz oddać tych pól (domy?).');
    if (!getProps.every(pos => lobby.owner[pos]===to && monoPropTradeable(lobby,pos)))   return socket.emit('error', 'Te pola nie należą do gracza.');
    if (giveMoney > m.pl[from].money) return socket.emit('error', 'Za mało gotówki.');
    if (getMoney  > m.pl[to].money)   return socket.emit('error', 'Partner nie ma tyle gotówki.');
    m.trade = { from, to, giveProps, getProps, giveMoney, getMoney };
    const detail = {
      from, fromNick: monoNick(lobby, from),
      giveProps, getProps, giveMoney, getMoney,
      giveNames: giveProps.map(p=>MONO_BOARD[p].name), getNames: getProps.map(p=>MONO_BOARD[p].name),
    };
    io.to((lobby.players.find(p=>p.playerId===to)||{}).socketId).emit('monoTradeOffer', detail);
    monoLog(lobby, `🤝 ${monoNick(lobby,from)} proponuje wymianę graczowi ${monoNick(lobby,to)}.`);
    monoBroadcast(code);
  });
  socket.on('monoRespondTrade', ({ accept }) => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || lobby.game!=='monopoly' || !lobby.mono || !lobby.mono.trade) return;
    const m = lobby.mono; if (m.trade.to !== socket.playerId) return;
    const t = m.trade;
    if (!accept) {
      m.trade = null; monoLog(lobby, `❌ ${monoNick(lobby,t.to)} odrzucił wymianę.`);
      io.to((lobby.players.find(p=>p.playerId===t.from)||{}).socketId).emit('monoTradeResult', { accepted:false });
      return monoBroadcast(code);
    }
    // Re-walidacja przed wykonaniem.
    const ok = t.giveProps.every(pos=>lobby.owner[pos]===t.from) && t.getProps.every(pos=>lobby.owner[pos]===t.to)
      && m.pl[t.from].money>=t.giveMoney && m.pl[t.to].money>=t.getMoney;
    if (!ok) { m.trade=null; return monoBroadcast(code); }
    io.to((lobby.players.find(p=>p.playerId===t.from)||{}).socketId).emit('monoTradeResult', { accepted:true });
    monoExecTrade(code);
  });
  socket.on('monoCancelTrade', () => {
    const code = socket.lobbyCode, lobby = lobbies[code];
    if (!lobby || !lobby.mono || !lobby.mono.trade) return;
    if (lobby.mono.trade.from !== socket.playerId) return;
    lobby.mono.trade = null; monoBroadcast(code);
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
      broadcastPublicLobbies();
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
    // Keep the game moving after someone leaves mid-round.
    arcadeAfterDepart(code, pid);
    monoAfterDepart(code, pid);
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
    arcadeAfterDepart(code, playerId);
    monoAfterDepart(code, playerId);
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
        broadcastPublicLobbies();
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
