// Trystero P2P — Firebase 시그널링 전략 (0.21.x 클래식 API).
// 공개 torrent/nostr/mqtt 릴레이는 rate-limit·트래커 사멸로 불안정하여
// 무료 Firebase Realtime DB 를 시그널링 채널로 사용한다(서버 운영 불필요).
//
// 로컬 esbuild 번들 사용: esm.sh 런타임 번들은 재빌드/캐시로 불안정할 수 있어
// firebase 를 로컬에 미리 번들해 저장소에 포함(vendor/). CDN 런타임 의존 제거.
// 번들은 firebase 헬퍼(initializeApp/getDatabase/ref/onValue/onDisconnect)도 export.
import {
  joinRoom, selfId,
  initializeApp, getDatabase, ref, onValue, set, onDisconnect,
} from './vendor/trystero-firebase.js';

// ═══════════════════════════════════════════════
//  TETRIS ENGINE
// ═══════════════════════════════════════════════

const COLS = 10;
const ROWS = 20;
const CELL = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cell-size')) || 28;

const COLORS = {
  0: null,
  1: '#00f5ff', // I
  2: '#ffd700', // O
  3: '#9b59b6', // T
  4: '#2ecc71', // S
  5: '#e74c3c', // Z
  6: '#3498db', // J
  7: '#f39c12', // L
  8: '#444466', // garbage
};

const PIECES = [
  null,
  { type: 1, shape: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]] },  // I
  { type: 2, shape: [[1,1],[1,1]] },                                 // O
  { type: 3, shape: [[0,1,0],[1,1,1],[0,0,0]] },                    // T
  { type: 4, shape: [[0,1,1],[1,1,0],[0,0,0]] },                    // S
  { type: 5, shape: [[1,1,0],[0,1,1],[0,0,0]] },                    // Z
  { type: 6, shape: [[1,0,0],[1,1,1],[0,0,0]] },                    // J
  { type: 7, shape: [[0,0,1],[1,1,1],[0,0,0]] },                    // L
];

// Wall kick data (SRS)
const KICKS = {
  '0>1': [[-1,0],[-1,1],[0,-2],[-1,-2]],
  '1>0': [[1,0],[1,-1],[0,2],[1,2]],
  '1>2': [[1,0],[1,-1],[0,2],[1,2]],
  '2>1': [[-1,0],[-1,1],[0,-2],[-1,-2]],
  '2>3': [[1,0],[1,1],[0,-2],[1,-2]],
  '3>2': [[-1,0],[-1,-1],[0,2],[-1,2]],
  '3>0': [[-1,0],[-1,-1],[0,2],[-1,2]],
  '0>3': [[1,0],[1,1],[0,-2],[1,-2]],
};
const KICKS_I = {
  '0>1': [[-2,0],[1,0],[-2,-1],[1,2]],
  '1>0': [[2,0],[-1,0],[2,1],[-1,-2]],
  '1>2': [[-1,0],[2,0],[-1,2],[2,-1]],
  '2>1': [[1,0],[-2,0],[1,-2],[-2,1]],
  '2>3': [[2,0],[-1,0],[2,1],[-1,-2]],
  '3>2': [[-2,0],[1,0],[-2,-1],[1,2]],
  '3>0': [[1,0],[-2,0],[1,-2],[-2,1]],
  '0>3': [[-1,0],[2,0],[-1,2],[2,-1]],
};

function rotateCW(matrix) {
  const N = matrix.length;
  const M = matrix[0].length;
  const result = Array.from({ length: M }, () => Array(N).fill(0));
  for (let r = 0; r < N; r++)
    for (let c = 0; c < M; c++)
      result[c][N - 1 - r] = matrix[r][c];
  return result;
}

function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

class TetrisGame {
  constructor() {
    this.board = emptyBoard();
    this.current = null;
    this.next = null;
    this.hold = null;
    this.holdUsed = false;
    this.score = 0;
    this.level = 1;
    this.lines = 0;
    this.running = false;
    this.bag = [];
    this.rot = 0;
    this.pos = { x: 0, y: 0 };
    this.dropTimer = null;
    this.lockDelay = null;
    this.garbageQueue = [];
    this.onUpdate = null;
    this.onGameOver = null;
    this.onLinesCleared = null;
  }

  start() {
    this.board = emptyBoard();
    this.score = 0;
    this.level = 1;
    this.lines = 0;
    this.hold = null;
    this.holdUsed = false;
    this.bag = [];
    this.garbageQueue = [];
    this.running = true;
    this.next = this.drawBag();
    this.spawn();
    this.scheduleDrop();
  }

  stop() {
    this.running = false;
    clearInterval(this.dropTimer);
    clearTimeout(this.lockDelay);
  }

  drawBag() {
    if (this.bag.length === 0) {
      this.bag = [1,2,3,4,5,6,7].sort(() => Math.random() - 0.5);
    }
    return PIECES[this.bag.shift()];
  }

  spawn() {
    this.current = this.next;
    this.next = this.drawBag();
    this.rot = 0;
    this.pos = { x: Math.floor(COLS / 2) - Math.ceil(this.current.shape[0].length / 2), y: 0 };

    if (this.collides(this.current.shape, this.pos.x, this.pos.y)) {
      this.running = false;
      if (this.onGameOver) this.onGameOver();
    }
    this.holdUsed = false;
  }

  collides(shape, ox, oy) {
    for (let r = 0; r < shape.length; r++) {
      for (let c = 0; c < shape[r].length; c++) {
        if (!shape[r][c]) continue;
        const nx = ox + c, ny = oy + r;
        if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
        if (ny >= 0 && this.board[ny][nx]) return true;
      }
    }
    return false;
  }

  move(dx) {
    if (!this.running) return;
    if (!this.collides(this.current.shape, this.pos.x + dx, this.pos.y)) {
      this.pos.x += dx;
      this.resetLockDelay();
    }
  }

  rotate(dir = 1) {
    if (!this.running) return;
    const shape = this.current.shape;
    const newShape = dir === 1 ? rotateCW(shape) : rotateCW(rotateCW(rotateCW(shape)));
    const newRot = (this.rot + dir + 4) % 4;
    const key = `${this.rot}>${newRot}`;
    const kicks = this.current.type === 1 ? (KICKS_I[key] || []) : (KICKS[key] || []);

    if (!this.collides(newShape, this.pos.x, this.pos.y)) {
      this.current = { ...this.current, shape: newShape };
      this.rot = newRot;
      this.resetLockDelay();
      return;
    }
    for (const [kx, ky] of kicks) {
      if (!this.collides(newShape, this.pos.x + kx, this.pos.y + ky)) {
        this.current = { ...this.current, shape: newShape };
        this.pos.x += kx;
        this.pos.y += ky;
        this.rot = newRot;
        this.resetLockDelay();
        return;
      }
    }
  }

  softDrop() {
    if (!this.running) return;
    if (!this.collides(this.current.shape, this.pos.x, this.pos.y + 1)) {
      this.pos.y++;
      this.score += 1;
    } else {
      this.lock();
    }
  }

  hardDrop() {
    if (!this.running) return;
    let dropped = 0;
    while (!this.collides(this.current.shape, this.pos.x, this.pos.y + 1)) {
      this.pos.y++;
      dropped++;
    }
    this.score += dropped * 2;
    this.lock();
  }

  holdPiece() {
    if (!this.running || this.holdUsed) return;
    const prev = this.hold;
    this.hold = PIECES[this.current.type];
    this.holdUsed = true;
    if (prev) {
      this.current = prev;
      this.rot = 0;
      this.pos = { x: Math.floor(COLS / 2) - Math.ceil(this.current.shape[0].length / 2), y: 0 };
    } else {
      this.spawn();
    }
  }

  ghostY() {
    let gy = this.pos.y;
    while (!this.collides(this.current.shape, this.pos.x, gy + 1)) gy++;
    return gy;
  }

  lock() {
    clearTimeout(this.lockDelay);
    const { shape } = this.current;
    for (let r = 0; r < shape.length; r++)
      for (let c = 0; c < shape[r].length; c++)
        if (shape[r][c] && this.pos.y + r >= 0)
          this.board[this.pos.y + r][this.pos.x + c] = this.current.type;

    this.clearLines();
    this.applyGarbage();
    this.spawn();
    this.notifyUpdate();
  }

  clearLines() {
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (this.board[r].every(c => c !== 0)) {
        this.board.splice(r, 1);
        this.board.unshift(Array(COLS).fill(0));
        cleared++;
        r++;
      }
    }
    if (cleared > 0) {
      const points = [0, 100, 300, 500, 800];
      this.score += (points[cleared] || 800) * this.level;
      this.lines += cleared;
      this.level = Math.floor(this.lines / 10) + 1;
      if (this.onLinesCleared) this.onLinesCleared(cleared);
    }
  }

  applyGarbage() {
    while (this.garbageQueue.length > 0) {
      const n = this.garbageQueue.shift();
      for (let i = 0; i < n; i++) {
        this.board.shift();
        const hole = Math.floor(Math.random() * COLS);
        const row = Array(COLS).fill(8);
        row[hole] = 0;
        this.board.push(row);
      }
    }
  }

  receiveGarbage(n) {
    this.garbageQueue.push(n);
  }

  scheduleDrop() {
    clearInterval(this.dropTimer);
    const delay = Math.max(100, 1000 - (this.level - 1) * 85);
    this.dropTimer = setInterval(() => {
      if (!this.running) return;
      if (!this.collides(this.current.shape, this.pos.x, this.pos.y + 1)) {
        this.pos.y++;
      } else {
        this.startLockDelay();
      }
    }, delay);
  }

  startLockDelay() {
    if (this.lockDelay) return;
    this.lockDelay = setTimeout(() => {
      this.lockDelay = null;
      if (this.collides(this.current.shape, this.pos.x, this.pos.y + 1)) {
        this.lock();
      }
    }, 500);
  }

  resetLockDelay() {
    if (this.lockDelay) {
      clearTimeout(this.lockDelay);
      this.lockDelay = null;
    }
  }

  notifyUpdate() {
    if (this.onUpdate) this.onUpdate(this.getState());
    const lvl = Math.floor(this.lines / 10) + 1;
    if (lvl !== this.level) {
      this.level = lvl;
      this.scheduleDrop();
    }
  }

  getState() {
    return {
      board: this.board.map(r => [...r]),
      score: this.score,
      level: this.level,
      lines: this.lines,
    };
  }

  getBoardSnapshot() {
    const snap = this.board.map(r => [...r]);
    const { shape } = this.current;
    for (let r = 0; r < shape.length; r++)
      for (let c = 0; c < shape[r].length; c++)
        if (shape[r][c] && this.pos.y + r >= 0)
          snap[this.pos.y + r][this.pos.x + c] = this.current.type;
    return snap;
  }
}

// ═══════════════════════════════════════════════
//  RENDERING
// ═══════════════════════════════════════════════

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
canvas.width = COLS * CELL;
canvas.height = ROWS * CELL;

const nextCanvas = document.getElementById('next-canvas');
const nextCtx = nextCanvas.getContext('2d');

function drawCell(context, x, y, color, size = CELL, alpha = 1) {
  if (!color) return;
  context.globalAlpha = alpha;
  context.fillStyle = color;
  context.fillRect(x * size + 1, y * size + 1, size - 2, size - 2);
  context.fillStyle = 'rgba(255,255,255,0.15)';
  context.fillRect(x * size + 1, y * size + 1, size - 2, 4);
  context.fillStyle = 'rgba(0,0,0,0.2)';
  context.fillRect(x * size + 1, y * size + size - 4, size - 2, 3);
  context.globalAlpha = 1;
}

function drawBoard(ctx, board, size = CELL) {
  ctx.fillStyle = '#0d0d1a';
  ctx.fillRect(0, 0, COLS * size, ROWS * size);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      ctx.strokeRect(c * size, r * size, size, size);
    }
  }

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c]) drawCell(ctx, c, r, COLORS[board[r][c]], size);
    }
  }
}

function drawPiece(ctx, piece, pos, rot, ghostY, size = CELL) {
  const shape = piece.shape;
  // Ghost
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (shape[r][c]) {
        const x = (pos.x + c) * size;
        const y = (ghostY + r) * size;
        ctx.globalAlpha = 0.2;
        ctx.fillStyle = COLORS[piece.type];
        ctx.fillRect(x + 1, y + 1, size - 2, size - 2);
        ctx.globalAlpha = 1;
      }
    }
  }
  // Real piece
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (shape[r][c]) drawCell(ctx, pos.x + c, pos.y + r, COLORS[piece.type], size);
    }
  }
}

function drawNext(piece) {
  nextCtx.clearRect(0, 0, 80, 80);
  if (!piece) return;
  const size = 16;
  const shape = piece.shape;
  const offX = Math.floor((5 - shape[0].length) / 2);
  const offY = Math.floor((5 - shape.length) / 2);
  for (let r = 0; r < shape.length; r++)
    for (let c = 0; c < shape[r].length; c++)
      if (shape[r][c]) drawCell(nextCtx, offX + c, offY + r, COLORS[piece.type], size);
}

function render(game) {
  const snap = game.getBoardSnapshot();
  drawBoard(ctx, game.board);
  if (game.running && game.current) {
    drawPiece(ctx, game.current, game.pos, game.rot, game.ghostY());
  }
  drawNext(game.next);
  document.getElementById('score-display').textContent = game.score.toLocaleString();
  document.getElementById('level-display').textContent = game.level;
  document.getElementById('lines-display').textContent = game.lines;
}

// ═══════════════════════════════════════════════
//  OPPONENT BOARDS
// ═══════════════════════════════════════════════

const OSIZE = 10; // small cell size for opponents
const opponents = new Map(); // peerId → { card, canvas, ctx, data }

function createOpponentCard(player) {
  const card = document.createElement('div');
  card.className = 'opponent-card';
  card.dataset.id = player.id;

  const nameRow = document.createElement('div');
  nameRow.className = 'opp-name';
  nameRow.innerHTML = `<span>${escapeHtml(player.name)}</span><span class="opp-score">0</span>`;
  card.appendChild(nameRow);

  const cvs = document.createElement('canvas');
  cvs.width = COLS * OSIZE;
  cvs.height = ROWS * OSIZE;
  card.appendChild(cvs);

  const targetArrow = document.createElement('div');
  targetArrow.className = 'target-arrow';
  targetArrow.textContent = '🎯 공격 대상';
  targetArrow.style.display = 'none';
  card.appendChild(targetArrow);

  card.addEventListener('click', () => {
    if (card.classList.contains('dead')) return;
    setTarget(player.id, player.name);
  });

  document.getElementById('opponents-area').appendChild(card);
  const c = cvs.getContext('2d');
  drawBoard(c, emptyBoard(), OSIZE);

  opponents.set(player.id, { card, canvas: cvs, ctx: c, arrowEl: targetArrow });
}

function updateOpponentCard(id, board, score, alive) {
  const opp = opponents.get(id);
  if (!opp) return;
  if (board) drawBoard(opp.ctx, board, OSIZE);
  const scoreEl = opp.card.querySelector('.opp-score');
  if (scoreEl) scoreEl.textContent = score?.toLocaleString() ?? '';
  if (!alive) opp.card.classList.add('dead');
  else opp.card.classList.remove('dead');
}

function removeOpponentCard(id) {
  const opp = opponents.get(id);
  if (opp) opp.card.remove();
  opponents.delete(id);
}

function clearOpponents() {
  document.getElementById('opponents-area').innerHTML = '';
  opponents.clear();
}

// ═══════════════════════════════════════════════
//  TARGET SYSTEM
// ═══════════════════════════════════════════════

let currentTargetId = null;
let currentTargetName = null;

function setTarget(id, name) {
  currentTargetId = id;
  currentTargetName = name;
  document.getElementById('target-panel').style.display = 'block';
  document.getElementById('target-name').textContent = name;

  for (const [pid, opp] of opponents) {
    opp.card.classList.toggle('targeted', pid === id);
    opp.arrowEl.style.display = pid === id ? 'block' : 'none';
  }
}

function clearTarget() {
  currentTargetId = null;
  currentTargetName = null;
  document.getElementById('target-panel').style.display = 'none';
  for (const opp of opponents.values()) {
    opp.card.classList.remove('targeted');
    opp.arrowEl.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════
//  NETWORKING (Trystero P2P — 서버 없음)
// ═══════════════════════════════════════════════
//
//  구조: 방장(방 생성자)이 "호스트 권한"을 갖고 로스터 관리·
//  카운트다운·승자 판정을 담당한다. 보드 갱신과 공격 라인은
//  피어끼리 직접 주고받는다(중계 서버 불필요).

// ▼▼▼ 반드시 본인 Firebase Realtime Database URL 로 교체하세요 ▼▼▼
// Firebase 콘솔 → Realtime Database 생성 후 나오는 URL.
// 예: 'https://tetris-xxxx-default-rtdb.firebaseio.com'
//     또는 지역형 'https://tetris-xxxx-default-rtdb.asia-southeast1.firebasedatabase.app'
const FIREBASE_DB_URL = 'https://tetris-1cbf7-default-rtdb.firebaseio.com/';
// ▲▲▲ 이 값을 바꾸지 않으면 멀티플레이 연결이 되지 않습니다 ▲▲▲

// ── TURN 서버 (NAT 통과용) ──────────────────────────────────────
// Trystero 는 기본 STUN 에 아래 turnConfig 를 "더해서" 사용한다.
// 회사망·대칭 NAT·엄격한 방화벽 뒤 사용자끼리는 STUN 만으로 연결이 실패하므로
// TURN(중계)이 필요하다.
//
// ⚠️ 과거의 무료 공개 서버(openrelay.metered.ca / openrelayproject)는 현재
//    relay 후보를 전혀 주지 않아 무의미함(브라우저 ICE 수집으로 실측 확인).
//    죽은 TURN 을 넣으면 ICE 완료가 지연될 수 있어 오히려 해롭다.
//
// ✅ 실제로 작동시키려면: https://dashboard.metered.ca 무료 계정(월 50GB) 생성 →
//    "TURN Credentials" 의 username / password(credential) 를 아래에 채운다.
//    비워두면 TURN 없이 STUN 만 사용한다(대부분의 가정용 NAT 는 STUN 으로 충분).
const TURN_USERNAME   = 'f04f74ed68ea84c495df7fec';   // metered 대시보드 username
const TURN_CREDENTIAL = '9qg6O1vVOat4vWYG';           // metered 대시보드 credential(password)
const TURN_SERVERS = (TURN_USERNAME && TURN_CREDENTIAL) ? [
  { urls: 'turn:global.relay.metered.ca:80',                  username: TURN_USERNAME, credential: TURN_CREDENTIAL },
  { urls: 'turn:global.relay.metered.ca:80?transport=tcp',    username: TURN_USERNAME, credential: TURN_CREDENTIAL },
  { urls: 'turn:global.relay.metered.ca:443',                 username: TURN_USERNAME, credential: TURN_CREDENTIAL },
  { urls: 'turns:global.relay.metered.ca:443?transport=tcp',  username: TURN_USERNAME, credential: TURN_CREDENTIAL },
] : [];

const game = new TetrisGame();
const mySocketId = selfId;      // Trystero 피어 ID (자기 자신)
let isHost = false;
let currentRoomId = null;
let hostId = null;
let myName = '';
let gameStarted = false;
let soloMode = false;           // 솔로(1인 연습) 모드 여부

const roster = new Map();       // 호스트 권한: id → player (전체 명단)
const peerNames = new Map();    // id → name
const alivePeers = new Set();   // 이번 게임에서 살아있는 id들

// 액션 송신 함수 (setupRoom에서 할당)
let sendHello, sendRoster, sendCountdown, sendStart, sendBoard, sendGarbage, sendDied, sendGameEnd;
let room = null;
let joinTimeout = null;

// ── 연결 진단 (문제 해결용) ──
const DEBUG = true;
function dbg(msg) {
  if (!DEBUG) return;
  const el = document.getElementById('debug-log');
  if (!el) return;
  const t = new Date().toTimeString().slice(0, 8);
  const line = document.createElement('div');
  line.textContent = `${t}  ${msg}`;
  el.prepend(line);
}
// WebRTC 와 무관하게 "Firebase 시그널링(발견) 자체가 되는지"를 직접 검증한다.
// 각 피어가 __diag/<room>/<selfId> 에 이름을 쓰고, 같은 경로를 구독한다.
// 상대의 항목이 보이면 = 두 기기 사이 Firebase 실시간 동기화 정상(발견 OK).
// 이게 뜨는데도 게임 연결이 안 되면 → 원인은 WebRTC/TURN(발견은 정상).
let diagStarted = false;
function startDiscoveryProbe(roomCode) {
  if (!DEBUG || diagStarted) return;
  diagStarted = true;
  try {
    const app = initializeApp({ databaseURL: FIREBASE_DB_URL }, 'diag');
    const db = getDatabase(app);
    const base = `__diag/${roomCode}`;
    const mine = ref(db, `${base}/${mySocketId}`);
    set(mine, { name: myName || (isHost ? 'host' : 'guest'), t: Date.now() });
    onDisconnect(mine).remove();
    const seen = new Set();
    onValue(ref(db, base), (snap) => {
      const val = snap.val() || {};
      for (const id of Object.keys(val)) {
        if (id !== mySocketId && !seen.has(id)) {
          seen.add(id);
          dbg(`🔎 [발견진단] 상대를 Firebase에서 감지: ${id.slice(0, 4)} (${val[id]?.name}) → 시그널링 정상`);
        }
      }
    });
    dbg('[발견진단] Firebase presence 감시 시작');
  } catch (e) {
    dbg('[발견진단] 실패: ' + String(e).slice(0, 60));
  }
}

let dbgTimer = null;
function startDbgMonitor() {
  if (!DEBUG || dbgTimer) return;
  dbgTimer = setInterval(() => {
    const st = document.getElementById('debug-status');
    if (!st || !room || !room.getPeers) return;
    let peers = {};
    try { peers = room.getPeers() || {}; } catch { /* noop */ }
    const ids = Object.keys(peers);
    const states = ids.map(id => `${id.slice(0, 4)}:${peers[id]?.iceConnectionState || '?'}`);
    st.textContent = ids.length
      ? `peers=${ids.length} [${states.join(', ')}]`
      : '피어 대기 중(아직 발견 안 됨)';
  }, 1000);
}

function makePlayer(id, name) {
  return { id, name, board: null, score: 0, level: 1, lines: 0, alive: false };
}
function rosterArray() {
  return [...roster.values()].map(({ id, name, score, level, lines, alive }) =>
    ({ id, name, score, level, lines, alive }));
}
function randomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function setupRoom(roomCode, asHost) {
  currentRoomId = roomCode;
  isHost = asHost;
  dbg(`Firebase 연결 시도… room=${roomCode} host=${asHost} self=${mySocketId.slice(0, 4)} TURN=${TURN_SERVERS.length > 0}`);
  room = joinRoom({ appId: FIREBASE_DB_URL, turnConfig: TURN_SERVERS }, roomCode);
  startDbgMonitor();
  startDiscoveryProbe(roomCode);

  // Trystero 0.21.x 클래식 API: makeAction 은 [send, get] 배열을 반환.
  const [aHello, onHello]     = room.makeAction('hello');
  const [aRoster, onRoster]   = room.makeAction('roster');
  const [aCount, onCount]     = room.makeAction('cntdwn');
  const [aStart, onStart]     = room.makeAction('start');
  const [aBoard, onBoard]     = room.makeAction('board');
  const [aGarbage, onGarbage] = room.makeAction('garbage');
  const [aDied, onDied]       = room.makeAction('died');
  const [aEnd, onEnd]         = room.makeAction('gameend');

  sendHello = aHello; sendRoster = aRoster; sendCountdown = aCount; sendStart = aStart;
  sendBoard = aBoard; sendGarbage = aGarbage; sendDied = aDied; sendGameEnd = aEnd;

  // 새 피어가 붙으면 서로 인사. 호스트는 인사를 받아 로스터를 재전파한다.
  room.onPeerJoin((peerId) => {
    dbg(`✅ 피어 발견(WebRTC 연결됨): ${peerId.slice(0, 4)}`);
    sendHello({ name: myName, host: isHost }, peerId);
  });

  onHello((data, peerId) => {
    dbg(`hello 수신: ${data.name} (host=${data.host})`);
    peerNames.set(peerId, data.name);
    if (data.host) hostId = peerId;
    if (isHost) {
      if (gameStarted) return;             // 게임 중에는 신규 입장 무시
      if (!roster.has(peerId)) roster.set(peerId, makePlayer(peerId, data.name));
      else roster.get(peerId).name = data.name;
      broadcastRoster();
    }
  });

  onRoster((data) => { dbg(`roster 수신: ${data.players?.length}명 → 대기실 입장`); applyRoster(data.players); });
  onCount((data) => handleCountdown(data.count));
  onStart((data) => handleGameStart(data.players));

  onBoard((data, peerId) => {
    updateOpponentCard(peerId, data.board, data.score, alivePeers.has(peerId));
    if (isHost) {
      const p = roster.get(peerId);
      if (p) { p.score = data.score; p.level = data.level; p.lines = data.lines; }
    }
  });

  onGarbage((data) => {
    game.receiveGarbage(data.lines);
    showGarbageToast(`⚠️ ${data.from}이(가) ${data.lines}줄 쓰레기 공격!`);
  });

  onDied((data, peerId) => {
    const id = data.id || peerId;
    alivePeers.delete(id);
    updateOpponentCard(id, null, null, false);
    if (id === currentTargetId) clearTarget();
    if (isHost) {
      const p = roster.get(id);
      if (p) p.alive = false;
      hostCheckGameEnd();
    }
  });

  onEnd((data) => handleGameEnd(data));

  room.onPeerLeave((peerId) => {
    dbg(`피어 나감: ${peerId.slice(0, 4)}`);
    peerNames.delete(peerId);
    alivePeers.delete(peerId);
    removeOpponentCard(peerId);
    if (peerId === hostId && !isHost) {
      alert('방장이 나갔습니다. 로비로 돌아갑니다.');
      location.reload();
      return;
    }
    if (isHost) {
      roster.delete(peerId);
      if (currentScreen() === 'waiting-screen') broadcastRoster();
      if (gameStarted) hostCheckGameEnd();
    }
  });
}

// ── 로스터 (호스트 권한) ──
function broadcastRoster() {
  const players = rosterArray();
  sendRoster({ players });
  applyRoster(players);
}

function applyRoster(players) {
  hostId = players[0]?.id ?? hostId;
  for (const p of players) peerNames.set(p.id, p.name);

  if (currentScreen() === 'lobby-screen') {
    // 참가자가 처음으로 로스터를 받음 → 대기실 입장
    if (joinTimeout) { clearTimeout(joinTimeout); joinTimeout = null; }
    document.getElementById('room-code-display').textContent = currentRoomId;
    showScreen('waiting-screen');
    document.getElementById('start-btn').textContent = isHost ? '게임 시작' : '게임 시작 (방장만 가능)';
    document.getElementById('start-btn').disabled = !isHost;
  }
  if (currentScreen() === 'waiting-screen') updateWaitingPlayers(players);
}

// ── 로비 액션 ──
function createRoom(name) {
  myName = name;
  isHost = true;
  const code = randomCode();
  setupRoom(code, true);
  roster.set(mySocketId, makePlayer(mySocketId, name));
  hostId = mySocketId;
  document.getElementById('room-code-display').textContent = code;
  updateWaitingPlayers(rosterArray());
  showScreen('waiting-screen');
  document.getElementById('start-btn').textContent = '게임 시작';
  document.getElementById('start-btn').disabled = false;
}

function joinRoomByCode(code, name) {
  myName = name;
  isHost = false;
  setupRoom(code, false);
  // 호스트의 로스터를 기다린다. 방이 없으면 타임아웃 처리.
  // TURN 중계 연결은 지연이 커서 여유를 둔다(너무 짧으면 정상 연결도 오인 실패).
  joinTimeout = setTimeout(() => {
    dbg('❌ 25초 타임아웃 — 위 로그로 어디서 막혔는지 확인하세요');
    alert('연결에 실패했습니다.\n· 방 코드가 맞는지\n· 방장이 아직 대기 중인지\n· (회사망 등) 네트워크 제한이 없는지\n확인 후 다시 시도해주세요.\n\n(화면 좌하단 "연결 진단" 로그를 캡처해 주세요)');
    location.reload();
  }, 25000);
}

// ── 카운트다운 / 시작 (호스트가 구동) ──
function handleCountdown(count) {
  showOverlay('countdown-overlay');
  const el = document.getElementById('countdown-num');
  el.textContent = count;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = 'pulse 0.8s ease-in-out';
}

function hostStartGame() {
  if (!isHost || gameStarted || roster.size < 1) return;
  for (const p of roster.values()) {
    p.alive = true; p.score = 0; p.level = 1; p.lines = 0; p.board = null;
  }
  let count = 3;
  sendCountdown({ count }); handleCountdown(count);
  const timer = setInterval(() => {
    count--;
    if (count > 0) {
      sendCountdown({ count }); handleCountdown(count);
    } else {
      clearInterval(timer);
      const players = rosterArray();
      sendStart({ players }); handleGameStart(players);
    }
  }, 1000);
}

function handleGameStart(players) {
  gameStarted = true;
  hideAllOverlays();
  clearOpponents();
  clearTarget();

  alivePeers.clear();
  for (const p of players) {
    alivePeers.add(p.id);
    if (p.id !== mySocketId) createOpponentCard(p);
  }

  showScreen('game-screen');
  game.start();

  game.onUpdate = (state) => {
    render(game);
    sendBoard({
      board: game.getBoardSnapshot(),
      score: state.score,
      level: state.level,
      lines: state.lines,
    });
    if (isHost) {
      const me = roster.get(mySocketId);
      if (me) { me.score = state.score; me.level = state.level; me.lines = state.lines; }
    }
  };

  game.onLinesCleared = (count) => {
    const garbageMap = { 2: 1, 3: 2, 4: 4 };
    const garbage = garbageMap[count] ?? 0;
    if (garbage === 0) return;
    const targetId = pickTarget();
    if (targetId) sendGarbage({ lines: garbage, from: myName }, targetId);
  };

  game.onGameOver = () => {
    sendDied({ id: mySocketId });
    alivePeers.delete(mySocketId);
    if (isHost) {
      const me = roster.get(mySocketId);
      if (me) me.alive = false;
      hostCheckGameEnd();
    }
    showOverlay('gameover-overlay');
  };

  startRenderLoop();
}

function pickTarget() {
  const aliveOpps = [...alivePeers].filter(id => id !== mySocketId);
  if (aliveOpps.length === 0) return null;
  if (currentTargetId && aliveOpps.includes(currentTargetId)) return currentTargetId;
  return aliveOpps[Math.floor(Math.random() * aliveOpps.length)];
}

// ── 게임 종료 (호스트가 승자 판정) ──
function hostCheckGameEnd() {
  if (!isHost || !gameStarted) return;
  const alive = rosterArray().filter(p => p.alive);
  if (alive.length <= 1) {
    gameStarted = false;
    const winner = alive[0];
    const payload = {
      winnerId: winner?.id ?? null,
      winnerName: winner?.name ?? null,
      players: rosterArray(),
    };
    sendGameEnd(payload);
    handleGameEnd(payload);
  }
}

function handleGameEnd({ winnerId, winnerName, players }) {
  gameStarted = false;
  game.stop();
  hideAllOverlays();
  stopRenderLoop();

  const isWinner = winnerId === mySocketId;
  document.getElementById('result-emoji').textContent = isWinner ? '🏆' : '😭';
  document.getElementById('result-title').textContent = isWinner ? '승리!' : '게임 종료';
  document.getElementById('result-winner').textContent = winnerName ? `${winnerName} 승리!` : '무승부';

  const sorted = [...players].sort((a, b) => b.score - a.score);
  document.getElementById('result-scores').innerHTML = sorted
    .map((p, i) => `${i + 1}. ${escapeHtml(p.name)} — ${p.score.toLocaleString()}점`)
    .join('<br>');

  document.getElementById('retry-btn').style.display = 'none'; // 재도전은 솔로 전용
  showOverlay('result-overlay');
}

// ═══════════════════════════════════════════════
//  SOLO MODE (1인 연습 — 네트워크 없음)
// ═══════════════════════════════════════════════

function startSoloGame() {
  soloMode = true;
  gameStarted = true;
  hideAllOverlays();
  clearOpponents();
  clearTarget();
  showScreen('game-screen');
  game.start();

  game.onUpdate = () => render(game);
  game.onLinesCleared = () => {};   // 솔로에는 공격 없음
  game.onGameOver = () => {
    gameStarted = false;
    game.stop();
    stopRenderLoop();
    showSoloResult();
  };

  startRenderLoop();
}

function showSoloResult() {
  document.getElementById('result-emoji').textContent = '🎮';
  document.getElementById('result-title').textContent = '게임 오버';
  document.getElementById('result-winner').textContent = `최종 점수 ${game.score.toLocaleString()}점`;
  document.getElementById('result-scores').innerHTML = `레벨 ${game.level} · ${game.lines}줄 클리어`;
  document.getElementById('retry-btn').style.display = 'inline-block';
  showOverlay('result-overlay');
}

// ═══════════════════════════════════════════════
//  RENDER LOOP
// ═══════════════════════════════════════════════

let rafId = null;

function startRenderLoop() {
  function loop() {
    if (game.running) render(game);
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
}

function stopRenderLoop() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

// ═══════════════════════════════════════════════
//  INPUT
// ═══════════════════════════════════════════════

const keyState = {};
const DAS = 150, ARR = 50;
let dasTimer = null, arrTimer = null;

document.addEventListener('keydown', (e) => {
  if (keyState[e.code]) return;
  keyState[e.code] = true;

  if (!game.running) return;

  switch (e.code) {
    case 'ArrowLeft':
      e.preventDefault();
      game.move(-1);
      clearTimeout(dasTimer); clearInterval(arrTimer);
      dasTimer = setTimeout(() => {
        arrTimer = setInterval(() => game.move(-1), ARR);
      }, DAS);
      break;
    case 'ArrowRight':
      e.preventDefault();
      game.move(1);
      clearTimeout(dasTimer); clearInterval(arrTimer);
      dasTimer = setTimeout(() => {
        arrTimer = setInterval(() => game.move(1), ARR);
      }, DAS);
      break;
    case 'ArrowUp':
      e.preventDefault();
      game.rotate(1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      game.softDrop();
      break;
    case 'Space':
      e.preventDefault();
      game.hardDrop();
      break;
    case 'KeyC':
    case 'ShiftLeft':
    case 'ShiftRight':
      e.preventDefault();
      game.holdPiece();
      break;
    case 'KeyZ':
      e.preventDefault();
      game.rotate(-1);
      break;
  }
});

document.addEventListener('keyup', (e) => {
  keyState[e.code] = false;
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    clearTimeout(dasTimer);
    clearInterval(arrTimer);
  }
});

// ═══════════════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════════════

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function currentScreen() {
  return [...document.querySelectorAll('.screen')].find(s => s.classList.contains('active'))?.id;
}

function showOverlay(id) {
  document.getElementById(id).classList.add('active');
}

function hideAllOverlays() {
  document.querySelectorAll('.overlay').forEach(o => o.classList.remove('active'));
}

let toastTimer = null;
function showGarbageToast(msg) {
  const toast = document.getElementById('garbage-toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

const AVATAR_COLORS = ['#6c63ff','#ff6584','#43e97b','#f7971e','#00c6ff','#fc00ff'];

function updateWaitingPlayers(players) {
  const list = document.getElementById('waiting-player-list');
  list.innerHTML = players.map((p, i) => `
    <div class="player-card ${p.id === mySocketId ? 'me' : ''}">
      <div class="avatar" style="background:${AVATAR_COLORS[i % AVATAR_COLORS.length]}22; color:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">
        ${escapeHtml(p.name[0].toUpperCase())}
      </div>
      <div class="p-name">${escapeHtml(p.name)}</div>
      ${i === 0 ? '<div style="font-size:0.65rem;color:var(--muted);margin-top:3px">방장</div>' : ''}
    </div>
  `).join('');
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ═══════════════════════════════════════════════
//  BUTTON HANDLERS
// ═══════════════════════════════════════════════

function getName() {
  const name = document.getElementById('name-input').value.trim();
  if (!name) { alert('닉네임을 입력해주세요!'); return null; }
  return name;
}

document.getElementById('create-btn').addEventListener('click', () => {
  const name = getName();
  if (!name) return;
  createRoom(name);
});

document.getElementById('join-btn').addEventListener('click', () => {
  const name = getName();
  if (!name) return;
  const code = document.getElementById('code-input').value.trim().toUpperCase();
  if (!code) { alert('방 코드를 입력해주세요!'); return; }
  joinRoomByCode(code, name);
});

document.getElementById('debug-close').addEventListener('click', () => {
  document.getElementById('debug-panel').style.display = 'none';
});

document.getElementById('solo-btn').addEventListener('click', () => {
  startSoloGame();
});

document.getElementById('retry-btn').addEventListener('click', () => {
  hideAllOverlays();
  startSoloGame();
});

document.getElementById('start-btn').addEventListener('click', () => {
  if (!isHost) return;
  hostStartGame();
});

document.getElementById('leave-btn').addEventListener('click', () => {
  if (room) room.leave();
  location.reload();
});

document.getElementById('result-btn').addEventListener('click', () => {
  if (room) room.leave();
  location.reload();
});

document.getElementById('name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('create-btn').click();
});
document.getElementById('code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('join-btn').click();
});
