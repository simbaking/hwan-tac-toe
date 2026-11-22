const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

function randomInt(max) {
  if (max <= 1) return 0;
  return crypto.randomInt(0, max);
}

function randomChoice(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[randomInt(arr.length)];
}

function shuffleArray(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const PORT = 8086;
const PUBLIC_DIR = path.join(__dirname, 'public');

function getLanUrls() {
  const urls = [];
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          urls.push(`http://${net.address}:${PORT}`);
        }
      }
    }
  } catch (e) {
    // ignore interface lookup errors in restricted environments
  }
  return urls;
}

const ALL_PLAYERS = ['X', 'O', 'T', 'S', 'D'];
const DEFAULT_PLAYER_NAMES = {
  X: 'Player X',
  O: 'Player O',
  T: 'Player △',
  S: 'Player □',
  D: 'Player —',
};

function normalizePlayerId(val) {
  if (!val) return null;
  const s = String(val).trim().toUpperCase();
  if (s === 'X' || s === '✕' || s === 'CROSS') return 'X';
  if (s === 'O' || s === '◯' || s === 'CIRCLE') return 'O';
  if (s === 'T' || s === '△' || s === '▲' || s === 'TRIANGLE') return 'T';
  if (s === 'S' || s === '□' || s === '■' || s === 'SQUARE') return 'S';
  if (s === 'D' || s === '—' || s === '-' || s === '–' || s === 'DASH' || s === 'LINE') return 'D';
  return null;
}

function parseIntOrNull(val) {
  if (val === undefined || val === null || val === '') return null;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? null : n;
}

function lineKey(cells) {
  return cells.join(',');
}

function getAllLinesOfLength(n, len) {
  if (!len || len < 1 || len > n) return [];
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [-1, 1],
  ];
  const lines = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      for (const [dr, dc] of directions) {
        const endR = r + dr * (len - 1);
        const endC = c + dc * (len - 1);
        if (endR >= 0 && endR < n && endC >= 0 && endC < n) {
          const cells = [];
          for (let step = 0; step < len; step++) {
            const nr = r + dr * step;
            const nc = c + dc * step;
            cells.push(nr * n + nc);
          }
          cells.sort((a, b) => a - b);
          lines.push(cells);
        }
      }
    }
  }
  return lines;
}

function normalizeWinReductionMode(val, fallback = 'standard') {
  if (val === undefined || val === null || val === '') return fallback;
  const s = String(val).toLowerCase();
  if (s === '0' || s === 'false' || s === 'off') return 'off';
  if (s === '1' || s === 'true' || s === 'on' || s === 'standard') return 'standard';
  if (s === 'infinite') return 'infinite';
  if (s === 'lockdown') return 'lockdown';
  if (s === 'lockattack') return 'lockattack';
  return 'standard';
}

// ============================================================================
// Game Instance Class (supports 2 to 5 Players: X, O, T=△, S=□, D=—)
// ============================================================================
class TicTacToeGame {
  constructor(gameId = 'default', onGameOver = null) {
    this.gameId = gameId;
    this.onGameOver = onGameOver;
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.lastTimerTick = Date.now();
    this.resultRecorded = false;

    this.boardSize = 3;
    this.board = new Array(9).fill(null);
    this.numPlayers = 2;
    this.activePlayers = ['X', 'O'];
    this.eliminatedPlayers = [];
    this.eliminationReasons = {};
    this.playerTypes = { X: 'human', O: 'cpu', T: 'cpu', S: 'cpu', D: 'cpu' };
    this.playerNames = { ...DEFAULT_PLAYER_NAMES };
    this.playerBrowserIds = { X: null, O: null, T: null, S: null, D: null };
    this.currentPlayer = 'X';
    this.winner = null;
    this.draw = false;

    this.handicaps = { X: 3, O: 3, T: 3, S: 3, D: 3 };
    this.blocks = { X: 0, O: 0, T: 0, S: 0, D: 0 };
    this.removes = { X: 0, O: 0, T: 0, S: 0, D: 0 };
    this.allowRemoveBlocks = true;
    this.winReductionMode = 'standard';
    this.reductionModes = {
      X: 'standard',
      O: 'standard',
      T: 'standard',
      S: 'standard',
      D: 'standard',
    };
    this.ignoredWinLines = { X: [], O: [], T: [], S: [], D: [] };
    this.agreeReduce = { X: false, O: false, T: false, S: false, D: false };
    this.declineReduce = { X: false, O: false, T: false, S: false, D: false };

    this.predictedDraw = false;
    this.winningCells = null;
    this.winReason = null;
    this.resignedBy = null;
    this.drawReason = null;
    this.tieOfferedBy = null;
    this.tieAgreedBy = [];
    this.tieDeclinedBy = null;
    this.lastAiTieOfferMove = -10;
    this.moveCount = 0;
    this.initialTime = 300;
    this.playerTimes = { X: 300, O: 300, T: 300, S: 300, D: 300 };
    this.gameHistory = [];

    this.reset({ size: 3, numPlayers: 2, handicaps: { X: 3, O: 3, T: 3, S: 3, D: 3 } });
  }

  getLivePlayers() {
    return this.activePlayers.filter((p) => !this.eliminatedPlayers.includes(p));
  }

  canBrowserControlSeat(playerSym, browserId) {
    if (!playerSym || !this.activePlayers.includes(playerSym)) return false;
    if (this.playerTypes[playerSym] === 'cpu') return true;
    const ownerBid = this.playerBrowserIds && this.playerBrowserIds[playerSym];
    if (this.gameId !== 'default') {
      return Boolean(ownerBid && browserId && ownerBid === browserId);
    }
    if (ownerBid && browserId && ownerBid !== browserId) {
      return false;
    }
    return true;
  }

  getNextTurnPlayer(fromPlayer = this.currentPlayer) {
    const live = this.getLivePlayers();
    if (live.length === 0) return fromPlayer;
    const startIdx = this.activePlayers.indexOf(fromPlayer);
    if (startIdx === -1) return live[0];
    for (let step = 1; step <= this.activePlayers.length; step++) {
      const candidate = this.activePlayers[(startIdx + step) % this.activePlayers.length];
      if (!this.eliminatedPlayers.includes(candidate)) {
        return candidate;
      }
    }
    return live[0];
  }

  pruneBrokenIgnoredLines() {
    for (const p of ALL_PLAYERS) {
      this.ignoredWinLines[p] = (this.ignoredWinLines[p] || []).filter((cells) =>
        cells.every((idx) => this.board[idx] === p)
      );
    }
  }

  getTintedCells() {
    const winSet = new Set(this.winningCells || []);
    const tinted = new Set();
    for (const p of this.activePlayers) {
      for (const cells of this.ignoredWinLines[p] || []) {
        if (cells.every((idx) => this.board[idx] === p)) {
          for (const idx of cells) {
            if (!winSet.has(idx)) tinted.add(idx);
          }
        }
      }
    }
    return Array.from(tinted).sort((a, b) => a - b);
  }

  assignPlayerReductionModes(mode) {
    if (mode === 'lockattack') {
      const shuffled = shuffleArray(this.activePlayers);
      const half =
        shuffled.length % 2 === 1 && randomInt(2) === 1
          ? Math.ceil(shuffled.length / 2)
          : Math.max(1, Math.floor(shuffled.length / 2));
      for (const p of ALL_PLAYERS) {
        this.reductionModes[p] = 'lockdown';
      }
      for (let i = 0; i < half; i++) {
        this.reductionModes[shuffled[i]] = 'infinite';
      }
    } else {
      for (const p of ALL_PLAYERS) {
        this.reductionModes[p] = mode;
      }
    }
  }

  canReduceWinAmount() {
    const live = this.getLivePlayers();
    return Boolean(
      this.winReductionMode !== 'off' &&
        !this.winner &&
        !this.draw &&
        live.some((p) => this.handicaps[p] > 1) &&
        this.predictedDraw
    );
  }

  tickServerClock() {
    const now = Date.now();
    const dt = (now - this.lastTimerTick) / 1000;
    this.lastTimerTick = now;
    if (this.winner || this.draw || this.gameId === 'default') return;
    if (dt > 0 && dt < 30) {
      const cur = this.currentPlayer;
      if (cur && this.playerTimes[cur] !== undefined) {
        this.playerTimes[cur] = Math.max(0, this.playerTimes[cur] - dt);
        if (this.playerTimes[cur] <= 0) {
          this.handlePlayerEliminationOrEnd(cur, 'timeout');
        }
      }
    }
  }

  getStateObject() {
    this.tickServerClock();
    const copyIgnored = {};
    for (const p of ALL_PLAYERS) {
      copyIgnored[p] = (this.ignoredWinLines[p] || []).map((l) => l.slice());
    }
    return {
      gameId: this.gameId,
      board: this.board.slice(),
      boardSize: this.boardSize,
      numPlayers: this.numPlayers,
      activePlayers: this.activePlayers.slice(),
      eliminatedPlayers: this.eliminatedPlayers.slice(),
      eliminationReasons: { ...this.eliminationReasons },
      playerTypes: { ...this.playerTypes },
      playerNames: { ...this.playerNames },
      playerBrowserIds: { ...this.playerBrowserIds },
      currentPlayer: this.currentPlayer,
      winner: this.winner,
      winReason: this.winReason,
      resignedBy: this.resignedBy,
      draw: this.draw ? true : null,
      drawReason: this.drawReason,
      handicaps: { ...this.handicaps },
      blocks: { ...this.blocks },
      removes: { ...this.removes },
      xHandicap: this.handicaps.X,
      oHandicap: this.handicaps.O,
      tHandicap: this.handicaps.T,
      sHandicap: this.handicaps.S,
      dHandicap: this.handicaps.D,
      xBlocks: this.blocks.X,
      oBlocks: this.blocks.O,
      tBlocks: this.blocks.T,
      sBlocks: this.blocks.S,
      dBlocks: this.blocks.D,
      xRemoves: this.removes.X,
      oRemoves: this.removes.O,
      tRemoves: this.removes.T,
      sRemoves: this.removes.S,
      dRemoves: this.removes.D,
      allowRemoveBlocks: this.allowRemoveBlocks ? true : null,
      winReductionMode: this.winReductionMode,
      reductionModes: { ...this.reductionModes },
      xReductionMode: this.reductionModes.X,
      oReductionMode: this.reductionModes.O,
      predictedDraw: this.predictedDraw ? true : null,
      canReduceWinAmount: this.canReduceWinAmount() ? true : null,
      agreeReduce: { ...this.agreeReduce },
      declineReduce: { ...this.declineReduce },
      xAgreeReduce: this.agreeReduce.X ? true : null,
      oAgreeReduce: this.agreeReduce.O ? true : null,
      xDeclineReduce: this.declineReduce.X ? true : null,
      oDeclineReduce: this.declineReduce.O ? true : null,
      tieOfferedBy: this.tieOfferedBy,
      tieAgreedBy: this.tieAgreedBy.slice(),
      tieDeclinedBy: this.tieDeclinedBy,
      tintedCells: this.getTintedCells(),
      ignoredWinLines: copyIgnored,
      winningCells: this.winningCells ? this.winningCells.slice() : null,
      moveCount: this.moveCount,
      initialTime: this.initialTime,
      playerTimes: { ...this.playerTimes },
      playerScores: (() => {
        const sc = {};
        for (const p of ALL_PLAYERS) {
          const reg = getRegisteredPlayer(this.playerNames[p]);
          sc[p] = reg ? reg.score || 0 : 0;
        }
        return sc;
      })(),
    };
  }

  saveHistory() {
    this.lastActivityAt = Date.now();
    this.lastTimerTick = Date.now();
    this.gameHistory.push(this.getStateObject());
    this.moveCount += 1;
    if ((this.winner || this.draw) && !this.resultRecorded && this.onGameOver) {
      this.resultRecorded = true;
      try {
        this.onGameOver(this);
      } catch (e) {
        console.error('Error in onGameOver callback:', e);
      }
    }
  }

  reset(options = {}) {
    const size = options.size !== undefined && options.size !== null ? options.size : this.boardSize;
    const nPlayers =
      options.numPlayers !== undefined && options.numPlayers !== null
        ? Math.min(5, Math.max(2, options.numPlayers))
        : this.numPlayers;

    this.gameHistory = [];
    this.moveCount = 0;
    this.resultRecorded = false;
    this.boardSize = size;
    this.numPlayers = nPlayers;
    this.activePlayers = ALL_PLAYERS.slice(0, this.numPlayers);
    this.eliminatedPlayers = [];
    this.eliminationReasons = {};
    this.board = new Array(size * size).fill(null);

    if (options.playerTypes) {
      for (const p of ALL_PLAYERS) {
        if (options.playerTypes[p] === 'human' || options.playerTypes[p] === 'cpu') {
          this.playerTypes[p] = options.playerTypes[p];
        }
      }
    }
    if (options.playerNames) {
      for (const p of ALL_PLAYERS) {
        if (options.playerNames[p]) {
          this.playerNames[p] = String(options.playerNames[p]).slice(0, 24);
        }
      }
    }
    this.playerBrowserIds = { X: null, O: null, T: null, S: null, D: null };
    if (options.playerBrowserIds) {
      for (const p of ALL_PLAYERS) {
        if (options.playerBrowserIds[p]) {
          this.playerBrowserIds[p] = String(options.playerBrowserIds[p]);
        }
      }
    }
    if (options.initialTime && options.initialTime > 0) {
      this.initialTime = options.initialTime;
    }

    const startCandidate =
      options.starting && String(options.starting).toLowerCase() !== 'random'
        ? normalizePlayerId(options.starting)
        : null;
    if (startCandidate && this.activePlayers.includes(startCandidate)) {
      this.currentPlayer = startCandidate;
    } else {
      let pool = this.activePlayers;
      // Avoid picking the exact same starting player 3+ times in a row when resetting with random starter
      if (
        pool.length > 1 &&
        this.lastStartingPlayer &&
        this.sameStarterStreak >= 2 &&
        pool.includes(this.lastStartingPlayer)
      ) {
        pool = pool.filter((p) => p !== this.lastStartingPlayer);
      }
      this.currentPlayer = randomChoice(pool) || this.activePlayers[0];
    }
    if (this.currentPlayer === this.lastStartingPlayer) {
      this.sameStarterStreak = (this.sameStarterStreak || 0) + 1;
    } else {
      this.lastStartingPlayer = this.currentPlayer;
      this.sameStarterStreak = 1;
    }

    this.winner = null;
    this.winReason = null;
    this.resignedBy = null;
    this.draw = false;
    this.drawReason = null;

    for (const p of ALL_PLAYERS) {
      const hcOpt =
        options.handicaps && options.handicaps[p] !== undefined ? options.handicaps[p] : null;
      const blOpt =
        options.blocks && options.blocks[p] !== undefined ? options.blocks[p] : null;
      const rmOpt =
        options.removes && options.removes[p] !== undefined ? options.removes[p] : null;
      this.handicaps[p] = Math.min(size, Math.max(1, hcOpt !== null ? hcOpt : size));
      this.blocks[p] = blOpt !== null ? Math.max(0, blOpt) : 0;
      this.removes[p] = rmOpt !== null ? Math.max(0, rmOpt) : 0;
      this.ignoredWinLines[p] = [];
      this.agreeReduce[p] = false;
      this.declineReduce[p] = false;
      this.playerTimes[p] = this.initialTime;
    }

    if (options.allowRemoveBlocks !== undefined && options.allowRemoveBlocks !== null) {
      this.allowRemoveBlocks = Boolean(options.allowRemoveBlocks);
    }
    if (options.winReductionMode !== undefined && options.winReductionMode !== null) {
      this.winReductionMode = normalizeWinReductionMode(
        options.winReductionMode,
        this.winReductionMode
      );
    }
    this.assignPlayerReductionModes(this.winReductionMode);

    this.tieOfferedBy = null;
    this.tieAgreedBy = [];
    this.tieDeclinedBy = null;
    this.lastAiTieOfferMove = -10;
    this.predictedDraw = false;
    this.winningCells = null;
    this.createdAt = Date.now();
    this.lastTimerTick = Date.now();
    this.saveHistory();
  }

  currentRemoves() {
    return this.removes[this.currentPlayer] || 0;
  }

  removableSquareP(val) {
    return Boolean(val && (this.allowRemoveBlocks || val !== 'B'));
  }

  getValidWinLinesForPlayer(player, hc = null) {
    const req = hc !== null ? hc : this.handicaps[player] || this.boardSize;
    const allLines = getAllLinesOfLength(this.boardSize, req);
    const ignoredSet = new Set((this.ignoredWinLines[player] || []).map(lineKey));
    return allLines.filter((cells) => !ignoredSet.has(lineKey(cells)));
  }

  checkWin() {
    for (const player of this.activePlayers) {
      if (this.eliminatedPlayers.includes(player)) continue;
      const validLines = this.getValidWinLinesForPlayer(player);
      for (const cells of validLines) {
        if (cells.every((idx) => this.board[idx] === player)) {
          return { winner: player, cells };
        }
      }
    }
    return null;
  }

  checkDraw() {
    const live = this.getLivePlayers();
    if (live.length === 0) return true;
    const hasEmpty = this.board.some((cell) => cell === null);
    if (hasEmpty) return false;
    const canRemove =
      this.currentRemoves() > 0 && this.board.some((v) => this.removableSquareP(v));
    return !canRemove;
  }

  computePredictedDraw() {
    if (this.winner || this.draw) return false;
    const live = this.getLivePlayers();
    if (live.length === 0) return false;
    if (live.every((p) => this.handicaps[p] <= 1)) return false;

    const playerLines = {};
    let totalLines = 0;
    for (const p of live) {
      playerLines[p] = this.getValidWinLinesForPlayer(p);
      totalLines += playerLines[p].length;
    }
    if (totalLines === 0) return true;

    const isLineOpenFor = (cells, player, bState, rmCount) => {
      let removableBlockers = 0;
      for (const idx of cells) {
        const v = bState[idx];
        if (v === null || v === player) continue;
        if (v === 'B') {
          if (!this.allowRemoveBlocks) return false;
          removableBlockers += 1;
        } else {
          removableBlockers += 1;
        }
      }
      return removableBlockers <= rmCount;
    };

    const openWithRm = {};
    const openStrict = {};
    let anyOpenWithRm = false;
    let strictOpenTotal = 0;

    for (const p of live) {
      openWithRm[p] = playerLines[p].filter((c) =>
        isLineOpenFor(c, p, this.board, this.removes[p] || 0)
      );
      openStrict[p] = playerLines[p].filter((c) => isLineOpenFor(c, p, this.board, 0));
      if (openWithRm[p].length > 0) anyOpenWithRm = true;
      strictOpenTotal += openStrict[p].length;
    }

    if (!anyOpenWithRm) return true;

    const emptySquares = [];
    let filledCount = 0;
    for (let i = 0; i < this.boardSize * this.boardSize; i++) {
      if (this.board[i] === null) emptySquares.push(i);
      else filledCount += 1;
    }
    if (emptySquares.length === 0) return false;

    const nLive = live.length;
    const moverIdxInLive = Math.max(0, live.indexOf(this.currentPlayer));
    const minNeededFor = (lines, player) => {
      let minNeed = Infinity;
      for (const cells of lines) {
        let need = 0;
        for (const idx of cells) {
          if (this.board[idx] !== player) need += 1;
        }
        if (need < minNeed) minNeed = need;
      }
      return minNeed;
    };

    let someoneHasEnoughTurns = false;
    for (let offset = 0; offset < nLive; offset++) {
      const p = live[(moverIdxInLive + offset) % nLive];
      const turnsForP =
        Math.floor((emptySquares.length - offset + nLive - 1) / nLive) + (this.removes[p] || 0);
      const needForP = minNeededFor(openWithRm[p], p);
      if (needForP <= turnsForP) {
        someoneHasEnoughTurns = true;
        break;
      }
    }
    if (!someoneHasEnoughTurns) return true;

    const immediateWinSquares = (player, bState) => {
      const lines = playerLines[player] || [];
      const wins = new Set();
      for (const cells of lines) {
        let emptyIdx = -1;
        let count = 0;
        let blocked = false;
        for (const idx of cells) {
          const v = bState[idx];
          if (v === player) count += 1;
          else if (v === null) {
            if (emptyIdx === -1) emptyIdx = idx;
            else {
              blocked = true;
              break;
            }
          } else {
            blocked = true;
            break;
          }
        }
        if (!blocked && count === cells.length - 1 && emptyIdx !== -1) {
          wins.add(emptyIdx);
        }
      }
      return wins;
    };

    const canRemoveAndWinNow = (player, bState, rmLeft) => {
      if (rmLeft <= 0) return false;
      const lines = playerLines[player] || [];
      for (const cells of lines) {
        let blockerIdx = -1;
        let count = 0;
        for (const idx of cells) {
          const v = bState[idx];
          if (v === player) count += 1;
          else if (this.removableSquareP(v)) {
            if (blockerIdx === -1) blockerIdx = idx;
            else {
              blockerIdx = -2;
              break;
            }
          } else {
            blockerIdx = -2;
            break;
          }
        }
        if (count === cells.length - 1 && blockerIdx >= 0) return true;
      }
      return false;
    };

    const mover = this.currentPlayer;
    const moverRm = this.removes[mover] || 0;
    const moverBl = this.blocks[mover] || 0;

    if (
      immediateWinSquares(mover, this.board).size > 0 ||
      canRemoveAndWinNow(mover, this.board, moverRm)
    ) {
      return false;
    }

    const nextP = this.getNextTurnPlayer(mover);
    const nextWinsNow = immediateWinSquares(nextP, this.board);
    if (nextWinsNow.size >= 2 && moverBl === 0 && moverRm === 0) {
      return false;
    }

    const openRatio = totalLines > 0 ? strictOpenTotal / totalLines : 0;
    const baseMinFilled =
      this.boardSize <= 2
        ? 1
        : this.boardSize === 3
        ? 4
        : this.boardSize === 4
        ? 6
        : this.boardSize === 5
        ? 7
        : 9;
    const minFilled = openRatio <= 0.25 ? Math.max(2, baseMinFilled - 2) : baseMinFilled;
    if (filledCount < minFilled) return false;

    const rankSmartMoves = (player, bState) => {
      const myImmediate = immediateWinSquares(player, bState);
      if (myImmediate.size > 0) return Array.from(myImmediate);

      const pIdx = Math.max(0, live.indexOf(player));
      for (let step = 1; step < nLive; step++) {
        const opp = live[(pIdx + step) % nLive];
        const oppImm = immediateWinSquares(opp, bState);
        if (oppImm.size > 0) return Array.from(oppImm);
      }

      const empties = [];
      for (let i = 0; i < bState.length; i++) {
        if (bState[i] === null) empties.push(i);
      }
      if (empties.length <= 1) return empties;

      const center = (this.boardSize - 1) / 2;
      const scores = new Map();
      const myLines = playerLines[player] || [];

      for (const sq of empties) {
        let s = 0;
        bState[sq] = player;
        const myThreatsAfter = immediateWinSquares(player, bState).size;
        bState[sq] = null;

        if (myThreatsAfter >= 2) s += 500000;
        else if (myThreatsAfter === 1) s += 8000;

        for (const cells of myLines) {
          if (!cells.includes(sq)) continue;
          if (isLineOpenFor(cells, player, bState, 0)) {
            let cnt = 0;
            for (const idx of cells) if (bState[idx] === player) cnt += 1;
            s += Math.pow(10, cnt + 1);
          }
        }

        for (let step = 1; step < nLive; step++) {
          const opp = live[(pIdx + step) % nLive];
          const urgencyWeight = step === 1 ? 1.25 : 0.9;
          bState[sq] = opp;
          const oppThreatsAfter = immediateWinSquares(opp, bState).size;
          bState[sq] = null;
          if (oppThreatsAfter >= 2) s += 400000 * urgencyWeight;
          else if (oppThreatsAfter === 1) s += 6000 * urgencyWeight;

          for (const cells of playerLines[opp] || []) {
            if (!cells.includes(sq)) continue;
            if (isLineOpenFor(cells, opp, bState, 0)) {
              let cnt = 0;
              for (const idx of cells) if (bState[idx] === opp) cnt += 1;
              s += Math.pow(10, cnt + 1) * 1.1 * urgencyWeight;
            }
          }
        }

        const r = Math.floor(sq / this.boardSize);
        const c = sq % this.boardSize;
        const dist = Math.abs(r - center) + Math.abs(c - center);
        s += Math.max(0, 10 - dist);
        scores.set(sq, s);
      }

      empties.sort((a, b) => scores.get(b) - scores.get(a));
      return empties;
    };

    const hasWinnerOnBoard = (bState, lastPlayer, lastMove) => {
      const lines = playerLines[lastPlayer] || [];
      for (const cells of lines) {
        if (cells.includes(lastMove) && cells.every((idx) => bState[idx] === lastPlayer)) {
          return true;
        }
      }
      return false;
    };

    const simulateSmartPlayout = (startBoard, nextTurn) => {
      const b = startBoard.slice();
      let turn = nextTurn;
      let remaining = 0;
      for (let i = 0; i < b.length; i++) if (b[i] === null) remaining += 1;

      while (remaining > 0) {
        const ranked = rankSmartMoves(turn, b);
        if (ranked.length === 0) break;
        const chosen = ranked[0];
        b[chosen] = turn;
        remaining -= 1;
        if (hasWinnerOnBoard(b, turn, chosen)) {
          return turn;
        }
        turn = this.getNextTurnPlayer(turn);
      }
      return null;
    };

    const rootCandidates = rankSmartMoves(mover, this.board);
    const branchCount = Math.min(4, rootCandidates.length);
    let moverHasSafeDrawMove = false;
    for (let i = 0; i < branchCount; i++) {
      const m = rootCandidates[i];
      const nextB = this.board.slice();
      nextB[m] = mover;
      if (hasWinnerOnBoard(nextB, mover, m)) return false;
      const rolloutWinner = simulateSmartPlayout(nextB, nextP);
      if (rolloutWinner === mover) return false;
      if (rolloutWinner === null) {
        moverHasSafeDrawMove = true;
      }
    }
    if (!moverHasSafeDrawMove) return false;

    const countAdvancedLines = (lines, player, hc) => {
      if (hc <= 2) return lines.length;
      let adv = 0;
      for (const cells of lines) {
        let cnt = 0;
        for (const idx of cells) if (this.board[idx] === player) cnt += 1;
        if (cnt >= hc - 2) adv += 1;
      }
      return adv;
    };

    const allAdvLow = live.every(
      (p) => countAdvancedLines(openStrict[p], p, this.handicaps[p]) <= 2
    );

    return openRatio <= 0.55 || allAdvLow;
  }

  simulateWinReductionState() {
    const live = this.getLivePlayers();
    const nextHc = { ...this.handicaps };
    for (const p of live) {
      if (nextHc[p] > 1) nextHc[p] -= 1;
    }

    const simBoard = this.board.slice();
    const simIgnored = {};
    const newWinLines = {};

    for (const p of live) {
      simIgnored[p] = (this.ignoredWinLines[p] || []).map((l) => l.slice());
      newWinLines[p] = [];
      for (const cells of getAllLinesOfLength(this.boardSize, nextHc[p])) {
        if (cells.every((idx) => simBoard[idx] === p)) {
          newWinLines[p].push(cells);
        }
      }
    }

    for (const p of live) {
      const rMode = this.reductionModes[p] || this.winReductionMode;
      if (rMode === 'infinite') {
        for (const cells of newWinLines[p]) {
          for (const idx of cells) simBoard[idx] = null;
        }
      } else if (rMode === 'lockdown') {
        for (const cells of newWinLines[p]) {
          for (const idx of cells) simBoard[idx] = 'B';
        }
      } else {
        const existingKeys = new Set(simIgnored[p].map(lineKey));
        for (const cells of newWinLines[p]) {
          const k = lineKey(cells);
          if (!existingKeys.has(k)) {
            simIgnored[p].push(cells);
            existingKeys.add(k);
          }
        }
      }
    }

    const simLines = {};
    for (const p of live) {
      const validIgnored = simIgnored[p].filter((cells) =>
        cells.every((idx) => simBoard[idx] === p)
      );
      const ignoredSet = new Set(validIgnored.map(lineKey));
      simLines[p] = getAllLinesOfLength(this.boardSize, nextHc[p]).filter(
        (cells) => !ignoredSet.has(lineKey(cells))
      );
    }

    return {
      simBoard,
      nextHc,
      simLines,
    };
  }

  evaluateBoardHeuristics(player, bState, linesByPlayer, hcByPlayer) {
    const live = this.getLivePlayers();
    const opponents = live.filter((p) => p !== player);
    const myLines = linesByPlayer[player] || [];
    const myHc = hcByPlayer[player] || this.boardSize;
    const myBl = this.blocks[player] || 0;
    const myRm = this.removes[player] || 0;

    let maxOppBl = 0;
    let maxOppRm = 0;
    for (const opp of opponents) {
      if ((this.blocks[opp] || 0) > maxOppBl) maxOppBl = this.blocks[opp] || 0;
      if ((this.removes[opp] || 0) > maxOppRm) maxOppRm = this.removes[opp] || 0;
    }

    // Identify tournament scores/leader and board leader (1st place) among live players
    const tourneyScores = {};
    let maxTourneyScore = 0;
    for (const p of live) {
      const reg = getRegisteredPlayer(this.playerNames[p]);
      const sc = reg ? reg.score || 0 : 0;
      tourneyScores[p] = sc;
      if (sc > maxTourneyScore) maxTourneyScore = sc;
    }

    const isLineOpen = (cells, p, rmCount) => {
      let blockers = 0;
      for (const idx of cells) {
        const v = bState[idx];
        if (v === null || v === p) continue;
        if (v === 'B') {
          if (!this.allowRemoveBlocks) return false;
          blockers += 1;
        } else {
          blockers += 1;
        }
      }
      return blockers <= rmCount;
    };

    const getImmWins = (p, lines) => {
      const wins = new Set();
      for (const cells of lines) {
        let emptyIdx = -1;
        let count = 0;
        let blocked = false;
        for (const idx of cells) {
          const v = bState[idx];
          if (v === p) count += 1;
          else if (v === null) {
            if (emptyIdx === -1) emptyIdx = idx;
            else {
              blocked = true;
              break;
            }
          } else {
            blocked = true;
            break;
          }
        }
        if (!blocked && count === cells.length - 1 && emptyIdx !== -1) {
          wins.add(emptyIdx);
        }
      }
      return wins;
    };

    const canRmWin = (p, lines, rmLeft) => {
      if (rmLeft <= 0) return false;
      for (const cells of lines) {
        let blockerIdx = -1;
        let count = 0;
        for (const idx of cells) {
          const v = bState[idx];
          if (v === p) count += 1;
          else if (this.removableSquareP(v)) {
            if (blockerIdx === -1) blockerIdx = idx;
            else {
              blockerIdx = -2;
              break;
            }
          } else {
            blockerIdx = -2;
            break;
          }
        }
        if (count === cells.length - 1 && blockerIdx >= 0) return true;
      }
      return false;
    };

    const myImm = getImmWins(player, myLines);
    const myRmWin = canRmWin(player, myLines, myRm);
    const myOpenStrict = myLines.filter((c) => isLineOpen(c, player, 0));
    const myOpenWithRm = myLines.filter((c) => isLineOpen(c, player, myRm));

    const oppImm = new Set();
    let oppRmWin = false;
    const oppOpenStrict = [];
    const oppOpenWithRm = [];
    let maxSingleOppLineScore = 0;
    let minNeedOpp = Infinity;
    let oppTwoAway = 0;
    let leaderOpp = null;
    let leaderNeed = Infinity;
    let leaderImm = new Set();
    let leaderRmWin = false;

    // First pass: find each opponent's minimum stones needed to win (to know who is in 1st place on the board)
    const oppMinNeedMap = {};
    const oppRawScoreMap = {};
    for (const opp of opponents) {
      const oLines = linesByPlayer[opp] || [];
      const oHc = hcByPlayer[opp] || this.boardSize;
      const oRm = this.removes[opp] || 0;
      const oStrict = oLines.filter((c) => isLineOpen(c, opp, 0));
      let bestNeed = oHc;
      let rawScore = 0;
      for (const cells of oStrict) {
        let cnt = 0;
        for (const idx of cells) if (bState[idx] === opp) cnt += 1;
        const need = Math.max(1, oHc - cnt);
        if (need < bestNeed) bestNeed = need;
        if (need === 1) rawScore += 320;
        else if (need === 2) rawScore += 90;
        else if (need === 3) rawScore += 22;
        else rawScore += 6;
      }
      oppMinNeedMap[opp] = oStrict.length > 0 ? bestNeed : Infinity;
      oppRawScoreMap[opp] = rawScore;
      if (oppMinNeedMap[opp] < minNeedOpp) {
        minNeedOpp = oppMinNeedMap[opp];
      }
    }

    // Determine the primary 1st-place opponent (closest to winning on board or tournament leader)
    let bestLeaderMetric = -Infinity;
    for (const opp of opponents) {
      const need = oppMinNeedMap[opp];
      const raw = oppRawScoreMap[opp];
      const tLead = maxTourneyScore > 0 ? (tourneyScores[opp] - (tourneyScores[player] || 0)) : 0;
      const metric = (need < Infinity ? (10 - need) * 500 : 0) + raw + Math.max(0, tLead * 2.5);
      if (metric > bestLeaderMetric) {
        bestLeaderMetric = metric;
        leaderOpp = opp;
        leaderNeed = need;
      }
    }

    for (const opp of opponents) {
      const oLines = linesByPlayer[opp] || [];
      const oHc = hcByPlayer[opp] || this.boardSize;
      const oRm = this.removes[opp] || 0;
      const immSet = getImmWins(opp, oLines);
      for (const sq of immSet) oppImm.add(sq);
      const rmWin = canRmWin(opp, oLines, oRm);
      if (rmWin) oppRmWin = true;
      if (opp === leaderOpp) {
        leaderImm = immSet;
        leaderRmWin = rmWin;
      }

      const oStrict = oLines.filter((c) => isLineOpen(c, opp, 0));
      const oWithRm = oLines.filter((c) => isLineOpen(c, opp, oRm));
      oppOpenStrict.push(...oStrict);
      oppOpenWithRm.push(...oWithRm);

      // Weight 1st-place opponent higher based on how close they are to winning & tournament lead
      let leaderWeight = 1.0;
      if (opp === leaderOpp) {
        leaderWeight += 0.35;
        if (oppMinNeedMap[opp] <= 2) leaderWeight += 0.35;
      }
      if (maxTourneyScore > 0 && tourneyScores[opp] === maxTourneyScore && tourneyScores[opp] > (tourneyScores[player] || 0)) {
        const gapRatio = Math.min(1.0, (tourneyScores[opp] - (tourneyScores[player] || 0)) / Math.max(200, maxTourneyScore));
        leaderWeight += 0.3 + gapRatio * 0.45;
      }

      let thisOppScore = 0;
      for (const cells of oStrict) {
        let cnt = 0;
        for (const idx of cells) if (bState[idx] === opp) cnt += 1;
        const need = Math.max(1, oHc - cnt);
        if (need === 1) thisOppScore += 320 * leaderWeight;
        else if (need === 2) {
          oppTwoAway += 1;
          thisOppScore += 90 * leaderWeight;
        } else if (need === 3) thisOppScore += 22 * leaderWeight;
        else thisOppScore += 6 * leaderWeight;
      }
      if (thisOppScore > maxSingleOppLineScore) {
        maxSingleOppLineScore = thisOppScore;
      }
    }

    let myTwoAway = 0;
    let myLineScore = 0;
    let minNeedMy = Infinity;

    for (const cells of myOpenStrict) {
      let cnt = 0;
      for (const idx of cells) if (bState[idx] === player) cnt += 1;
      const need = Math.max(1, myHc - cnt);
      if (need < minNeedMy) minNeedMy = need;
      if (need === 1) myLineScore += 320;
      else if (need === 2) {
        myTwoAway += 1;
        myLineScore += 90;
      } else if (need === 3) myLineScore += 22;
      else myLineScore += 6;
    }

    const abilityScore = (myBl - maxOppBl) * 120 + (myRm - maxOppRm) * 240;
    const turnBonus = this.currentPlayer === player ? 65 : -45;
    const netScore = myLineScore - maxSingleOppLineScore + abilityScore + turnBonus;

    return {
      myImm,
      oppImm,
      myRmWin,
      oppRmWin,
      myOpenStrict,
      oppOpenStrict,
      myOpenWithRm,
      oppOpenWithRm,
      myTwoAway,
      oppTwoAway,
      minNeedMy,
      minNeedOpp,
      leaderOpp,
      leaderNeed,
      leaderImm,
      leaderRmWin,
      netScore,
    };
  }

  getAllCurrentValidLines() {
    const map = {};
    for (const p of this.getLivePlayers()) {
      map[p] = this.getValidWinLinesForPlayer(p);
    }
    return map;
  }

  evaluateWinReductionForPlayer(player = 'O') {
    if (!this.canReduceWinAmount()) return { agree: false, reason: 'unavailable' };
    const myBl = this.blocks[player] || 0;
    const myRm = this.removes[player] || 0;

    const curLines = this.getAllCurrentValidLines();
    const curEval = this.evaluateBoardHeuristics(player, this.board, curLines, this.handicaps);

    const sim = this.simulateWinReductionState();
    const simEval = this.evaluateBoardHeuristics(
      player,
      sim.simBoard,
      sim.simLines,
      sim.nextHc
    );

    if (this.currentPlayer === player && (simEval.myImm.size > 0 || simEval.myRmWin)) {
      return { agree: true, reason: 'immediate_win' };
    }

    if (simEval.myOpenWithRm.length === 0 && simEval.oppOpenWithRm.length > 0) {
      return { agree: false, reason: 'no_open_lines' };
    }
    if (simEval.oppOpenWithRm.length === 0 && simEval.myOpenWithRm.length > 0) {
      return { agree: true, reason: 'only_my_lines_open' };
    }

    if (simEval.oppImm.size >= 2 && simEval.myImm.size === 0 && myBl === 0 && myRm === 0) {
      return { agree: false, reason: 'opp_double_threat' };
    }
    // Never agree to win reduction if it gives the 1st-place opponent an immediate win or 1-away threat before our turn
    if (
      this.currentPlayer !== player &&
      (simEval.leaderImm.size > 0 || simEval.leaderRmWin || simEval.oppImm.size > 0 || simEval.oppRmWin) &&
      simEval.oppImm.size >= simEval.myImm.size
    ) {
      return { agree: false, reason: 'stop_first_place_win' };
    }
    if (simEval.leaderNeed < simEval.minNeedMy && simEval.leaderNeed <= 2) {
      return { agree: false, reason: 'first_place_closer_to_win' };
    }

    const jitter = (Math.random() - 0.5) * 160;
    const effectiveSimScore = simEval.netScore + jitter;

    if (effectiveSimScore < -220) {
      return { agree: false, reason: 'unfavorable_post_reduction' };
    }
    if (effectiveSimScore < -90 && simEval.netScore + jitter * 0.5 < curEval.netScore - 140) {
      return { agree: false, reason: 'worse_than_current' };
    }
    if (effectiveSimScore < 40 && Math.random() < 0.18) {
      return { agree: false, reason: 'random_caution' };
    }

    return { agree: true, reason: 'favorable_or_fair' };
  }

  evaluateTieResponseForPlayer(player = 'O', searchScore = null) {
    let filledCount = 0;
    for (let i = 0; i < this.boardSize * this.boardSize; i++) {
      if (this.board[i] !== null) filledCount += 1;
    }
    if (this.boardSize >= 3 && filledCount < 2) {
      return { accept: false, reason: 'too_early' };
    }

    const curLines = this.getAllCurrentValidLines();
    const curEval = this.evaluateBoardHeuristics(player, this.board, curLines, this.handicaps);

    if (curEval.myImm.size > 0 || curEval.myRmWin) {
      return { accept: false, reason: 'has_immediate_win' };
    }
    if (searchScore !== null && searchScore >= 40000) {
      return { accept: false, reason: 'has_forced_win' };
    }

    const jitter = (Math.random() - 0.5) * 140;
    if (curEval.myOpenStrict.length > 0) {
      if (curEval.netScore + jitter > 210) {
        return { accept: false, reason: 'ahead_on_board' };
      }
      if (searchScore !== null && searchScore + jitter > 240 && !this.predictedDraw) {
        return { accept: false, reason: 'ahead_in_search' };
      }
      if (!this.predictedDraw && curEval.netScore + jitter > -40 && Math.random() < 0.25) {
        return { accept: false, reason: 'wants_to_play_on' };
      }
    }

    return { accept: true, reason: 'fair_or_behind' };
  }

  evaluateOfferTieForPlayer(player = 'O', searchScore = null) {
    if (this.winner || this.draw || this.tieOfferedBy || this.tieDeclinedBy) return false;
    if (this.moveCount < this.lastAiTieOfferMove + 2) return false;

    let filledCount = 0;
    for (let i = 0; i < this.boardSize * this.boardSize; i++) {
      if (this.board[i] !== null) filledCount += 1;
    }
    if (filledCount < Math.max(3, Math.floor(this.boardSize * this.boardSize * 0.4))) {
      return false;
    }

    const curLines = this.getAllCurrentValidLines();
    const curEval = this.evaluateBoardHeuristics(player, this.board, curLines, this.handicaps);

    if (curEval.myImm.size > 0 || curEval.myRmWin || curEval.netScore > 200) return false;
    if (searchScore !== null && searchScore > 250) return false;

    const someoneDeclinedReduce = this.getLivePlayers().some((p) => this.declineReduce[p]);
    if (this.predictedDraw && (!this.canReduceWinAmount() || someoneDeclinedReduce)) {
      return Math.random() < 0.85;
    }

    let totalLines = 0;
    for (const p of this.getLivePlayers()) totalLines += (curLines[p] || []).length;
    const openStrictTotal = curEval.myOpenStrict.length + curEval.oppOpenStrict.length;
    const openRatio = totalLines > 0 ? openStrictTotal / totalLines : 0;

    if (
      filledCount >= Math.ceil(this.boardSize * this.boardSize * 0.5) &&
      openRatio <= 0.4 &&
      curEval.myImm.size === 0 &&
      curEval.oppImm.size === 0 &&
      Math.abs(curEval.netScore) <= 190
    ) {
      return Math.random() < 0.45;
    }

    return false;
  }

  evaluateResignForPlayer(player = 'O', searchScore = null) {
    if (this.winner || this.draw || this.eliminatedPlayers.includes(player)) return false;
    let filledCount = 0;
    for (let i = 0; i < this.boardSize * this.boardSize; i++) {
      if (this.board[i] !== null) filledCount += 1;
    }
    if (filledCount < Math.max(3, this.boardSize - 1)) return false;

    const myBl = this.blocks[player] || 0;
    const myRm = this.removes[player] || 0;
    const curLines = this.getAllCurrentValidLines();
    const curEval = this.evaluateBoardHeuristics(player, this.board, curLines, this.handicaps);

    if (curEval.myImm.size > 0 || curEval.myRmWin) return false;

    if (searchScore !== null && searchScore <= -50000) {
      return Math.random() < 0.94;
    }

    if (
      this.currentPlayer === player &&
      curEval.oppImm.size >= 2 &&
      myBl === 0 &&
      myRm === 0
    ) {
      return Math.random() < 0.95;
    }

    const someoneDeclinedReduce = this.getLivePlayers().some((p) => this.declineReduce[p]);
    if (
      curEval.myOpenWithRm.length === 0 &&
      (!this.canReduceWinAmount() || someoneDeclinedReduce) &&
      curEval.oppOpenStrict.length > 0 &&
      curEval.minNeedOpp <= 2 &&
      myBl === 0 &&
      myRm === 0 &&
      curEval.netScore < -300
    ) {
      return Math.random() < 0.88;
    }

    return false;
  }

  clearTurnPrompts(resetAgreeReduce = false) {
    for (const p of ALL_PLAYERS) {
      if (resetAgreeReduce) {
        this.agreeReduce[p] = false;
      }
      this.declineReduce[p] = false;
    }
    this.tieOfferedBy = null;
    this.tieAgreedBy = [];
    this.tieDeclinedBy = null;
  }

  updatePostActionState() {
    this.pruneBrokenIgnoredLines();
    this.clearTurnPrompts(false);
    const winResult = this.checkWin();
    if (winResult) {
      this.winner = winResult.winner;
      this.winReason = 'line';
      this.winningCells = winResult.cells;
      this.predictedDraw = false;
      this.clearTurnPrompts(true);
      return true;
    }
    this.winningCells = null;
    if (this.checkDraw()) {
      this.draw = true;
      this.drawReason = 'full';
      this.predictedDraw = false;
      this.clearTurnPrompts(true);
      return true;
    }
    this.predictedDraw = this.computePredictedDraw();
    if (!this.predictedDraw) {
      for (const p of ALL_PLAYERS) {
        this.agreeReduce[p] = false;
      }
    } else if (this.canReduceWinAmount() && this.checkAllLiveAgreedReduce()) {
      this.reduceWinAmounts();
    }
    return false;
  }

  checkAllLiveAgreedReduce() {
    const live = this.getLivePlayers();
    return live.length > 0 && live.every((p) => this.agreeReduce[p]);
  }

  reduceWinAmounts() {
    if (!this.canReduceWinAmount()) return false;
    const live = this.getLivePlayers();
    for (const p of live) {
      if (this.handicaps[p] > 1) this.handicaps[p] -= 1;
    }

    const preExistingWins = {};
    for (const p of live) {
      preExistingWins[p] = [];
      for (const cells of getAllLinesOfLength(this.boardSize, this.handicaps[p])) {
        if (cells.every((idx) => this.board[idx] === p)) {
          preExistingWins[p].push(cells);
        }
      }
    }

    for (const p of live) {
      const rMode = this.reductionModes[p] || this.winReductionMode;
      if (rMode === 'infinite') {
        for (const cells of preExistingWins[p]) {
          for (const idx of cells) {
            this.board[idx] = null;
          }
        }
      } else if (rMode === 'lockdown') {
        for (const cells of preExistingWins[p]) {
          for (const idx of cells) {
            this.board[idx] = 'B';
          }
        }
      } else {
        const existingKeys = new Set((this.ignoredWinLines[p] || []).map(lineKey));
        for (const cells of preExistingWins[p]) {
          const k = lineKey(cells);
          if (!existingKeys.has(k)) {
            this.ignoredWinLines[p].push(cells);
            existingKeys.add(k);
          }
        }
      }
    }

    this.pruneBrokenIgnoredLines();
    this.clearTurnPrompts(true);
    if (this.checkDraw()) {
      this.draw = true;
      this.drawReason = 'full';
      this.predictedDraw = false;
    } else {
      this.predictedDraw = this.computePredictedDraw();
    }
    this.saveHistory();
    return true;
  }

  handleMove(pos) {
    this.tickServerClock();
    if (!this.winner && !this.draw && this.board[pos] === null) {
      this.board[pos] = this.currentPlayer;
      this.pruneBrokenIgnoredLines();
      this.clearTurnPrompts(false);
      const winResult = this.checkWin();
      if (winResult) {
        this.winner = winResult.winner;
        this.winReason = 'line';
        this.winningCells = winResult.cells;
        this.predictedDraw = false;
        this.clearTurnPrompts(true);
      } else {
        this.currentPlayer = this.getNextTurnPlayer(this.currentPlayer);
        if (this.checkDraw()) {
          this.draw = true;
          this.drawReason = 'full';
          this.predictedDraw = false;
          this.clearTurnPrompts(true);
        } else {
          this.predictedDraw = this.computePredictedDraw();
          if (!this.predictedDraw) {
            for (const p of ALL_PLAYERS) {
              this.agreeReduce[p] = false;
            }
          } else if (this.canReduceWinAmount() && this.checkAllLiveAgreedReduce()) {
            this.reduceWinAmounts();
            return;
          }
        }
      }
      this.saveHistory();
    }
  }

  handlePlayerEliminationOrEnd(player, reason) {
    if (
      this.winner ||
      this.draw ||
      !this.activePlayers.includes(player) ||
      this.eliminatedPlayers.includes(player)
    ) {
      return;
    }
    const liveBefore = this.getLivePlayers();
    if (liveBefore.length <= 2) {
      const remaining = liveBefore.find((p) => p !== player) || liveBefore[0];
      this.winner = remaining;
      this.winReason = reason;
      this.resignedBy = player;
      this.predictedDraw = false;
      this.clearTurnPrompts();
      this.saveHistory();
    } else {
      this.eliminatedPlayers.push(player);
      this.eliminationReasons[player] = reason;
      this.resignedBy = player;
      if (this.currentPlayer === player) {
        this.currentPlayer = this.getNextTurnPlayer(player);
      }
      if (this.tieOfferedBy === player) {
        this.tieOfferedBy = null;
        this.tieAgreedBy = [];
      } else if (this.tieOfferedBy) {
        const liveNow = this.getLivePlayers();
        if (liveNow.every((p) => this.tieAgreedBy.includes(p))) {
          this.draw = true;
          this.drawReason = 'mutual';
          this.predictedDraw = false;
          this.clearTurnPrompts();
          this.saveHistory();
          return;
        }
      }
      if (this.canReduceWinAmount() && this.checkAllLiveAgreedReduce()) {
        this.reduceWinAmounts();
        return;
      }
      if (this.checkDraw()) {
        this.draw = true;
        this.drawReason = 'full';
        this.predictedDraw = false;
      } else {
        this.predictedDraw = this.computePredictedDraw();
      }
      this.saveHistory();
    }
  }
}

// ============================================================================
// TAT-Style Matchmaking, Lobby & Tournament Manager
// ============================================================================
const registeredPlayers = new Map(); // lowerName -> { name, isComputer, elo, score, wins, draws, losses, gamesPlayed, browserId, activeGameId }
const activeGames = new Map();
const defaultGame = new TicTacToeGame('default');
activeGames.set('default', defaultGame);
let gameOffers = [];
let offerIdCounter = 1;
const HUMAN_PRIORITY_DELAY = 6000; // 6 seconds priority for humans before bots auto-join offers

const tournamentState = {
  isRunning: false,
  mode: 'score', // 'score' or 'survival'
  startTime: null,
  durationMs: 0,
};

function getRegisteredPlayer(name) {
  if (!name) return null;
  return registeredPlayers.get(String(name).trim().toLowerCase()) || null;
}

function isPlayerBusy(name) {
  const p = getRegisteredPlayer(name);
  if (!p || !p.activeGameId) return false;
  const g = activeGames.get(p.activeGameId);
  if (!g || g.winner || g.draw) {
    p.activeGameId = null;
    return false;
  }
  return true;
}

function recordMatchResult(game) {
  if (!game || game.gameId === 'default') return;
  const durationSec = Math.max(5, Math.round((Date.now() - game.createdAt) / 1000));
  const participants = game.activePlayers
    .map((sym) => ({ sym, p: getRegisteredPlayer(game.playerNames[sym]) }))
    .filter((x) => x.p);

  if (participants.length === 0) return;

  if (game.winner) {
    const winEntry = participants.find((x) => x.sym === game.winner);
    for (const { sym, p } of participants) {
      p.gamesPlayed += 1;
      if (sym === game.winner) {
        p.wins += 1;
        p.score += 100 + durationSec * (game.numPlayers - 1);
        p.elo = Math.round(p.elo + 24 * (1 - 1 / game.numPlayers));
      } else {
        p.losses += 1;
        p.elo = Math.max(100, Math.round(p.elo - 24 / game.numPlayers));
      }
      if (p.activeGameId === game.gameId) p.activeGameId = null;
    }
    if (winEntry) {
      console.log(`[MATCH END] ${game.gameId}: Winner ${winEntry.p.name} (${game.winner})`);
    }
  } else if (game.draw) {
    for (const { p } of participants) {
      p.gamesPlayed += 1;
      p.draws += 1;
      p.score += 40 + Math.round(durationSec * 0.5);
      if (p.activeGameId === game.gameId) p.activeGameId = null;
    }
  }
}

function createMatchFromOffer(offer) {
  const gameId = `game_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
  // Randomize symbol assignment (like TAT randomizing colors)
  const playersList = shuffleArray(offer.acceptedBy.slice(0, offer.requiredPlayers));

  const symbols = ALL_PLAYERS.slice(0, offer.requiredPlayers);
  const pTypes = { X: 'human', O: 'human', T: 'human', S: 'human', D: 'human' };
  const pNames = { ...DEFAULT_PLAYER_NAMES };
  const pBrowserIds = { X: null, O: null, T: null, S: null, D: null };
  const hcMap = {};
  const blMap = {};
  const rmMap = {};

  symbols.forEach((sym, idx) => {
    const pName = playersList[idx];
    const reg = getRegisteredPlayer(pName);
    pNames[sym] = pName;
    pTypes[sym] = reg && reg.isComputer ? 'cpu' : 'human';
    pBrowserIds[sym] = reg && !reg.isComputer ? reg.browserId : null;
    hcMap[sym] = offer.handicap || offer.boardSize || 4;
    blMap[sym] = offer.blocks || 0;
    rmMap[sym] = offer.removes || 0;
    if (reg) {
      reg.activeGameId = gameId;
    }
  });

  const game = new TicTacToeGame(gameId, recordMatchResult);
  game.reset({
    size: offer.boardSize || 5,
    numPlayers: offer.requiredPlayers,
    handicaps: hcMap,
    blocks: blMap,
    removes: rmMap,
    playerTypes: pTypes,
    playerNames: pNames,
    playerBrowserIds: pBrowserIds,
    allowRemoveBlocks: offer.allowRemoveBlocks !== false,
    winReductionMode: offer.winReductionMode || 'standard',
    initialTime: (offer.timeControl || 5) * 60,
    starting: 'random',
  });

  activeGames.set(gameId, game);
  return { success: true, gameStarted: true, gameId, game: game.getStateObject() };
}

function ensureCpuBotExists(indexHint = 1) {
  const botNames = shuffleArray([
    'PS-Bot Alpha',
    'PS-Bot Beta',
    'PS-Bot Gamma',
    'PS-Bot Delta',
    'PS-Bot Omega',
  ]);
  for (let i = 0; i < botNames.length; i++) {
    const candidate = botNames[i];
    const existing = getRegisteredPlayer(candidate);
    if (!existing) {
      const bot = {
        name: candidate,
        isComputer: true,
        elo: 1200,
        score: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        gamesPlayed: 0,
        browserId: null,
        activeGameId: null,
      };
      registeredPlayers.set(candidate.toLowerCase(), bot);
      return bot;
    }
    if (existing.isComputer && !isPlayerBusy(existing.name)) {
      return existing;
    }
  }
  const customName = `CPU-${100 + randomInt(900)}`;
  const bot = {
    name: customName,
    isComputer: true,
    elo: 1200,
    score: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    gamesPlayed: 0,
    browserId: null,
    activeGameId: null,
  };
  registeredPlayers.set(customName.toLowerCase(), bot);
  return bot;
}

// Background matchmaking & tournament monitor loop (runs every 1s like TAT/TAT2)
setInterval(() => {
  const now = Date.now();

  // 1. Check tournament expiration
  if (tournamentState.isRunning && tournamentState.startTime) {
    const elapsed = now - tournamentState.startTime;
    if (elapsed >= tournamentState.durationMs) {
      tournamentState.isRunning = false;
      gameOffers = [];
    }
  }

  // 2. Tick clocks on active matchmade games & clean up finished games after 60s
  for (const [id, g] of activeGames.entries()) {
    if (id === 'default') continue;
    g.tickServerClock();
    if ((g.winner || g.draw) && now - g.lastActivityAt > 60000) {
      activeGames.delete(id);
    }
  }

  // 3. Clear stuck busy flags
  for (const p of registeredPlayers.values()) {
    if (p.activeGameId) {
      const g = activeGames.get(p.activeGameId);
      if (!g || g.winner || g.draw) {
        p.activeGameId = null;
      }
    }
  }

  // 4. Auto-accept open offers with registered idle CPUs after HUMAN_PRIORITY_DELAY
  const allReg = Array.from(registeredPlayers.values());
  const sortedByScore = [...allReg].sort((a, b) => (b.score || 0) - (a.score || 0));
  const firstPlacePlayer = sortedByScore.length > 0 ? sortedByScore[0] : null;
  const secondPlacePlayer = sortedByScore.length > 1 ? sortedByScore[1] : null;
  const firstPlaceScore = firstPlacePlayer ? firstPlacePlayer.score || 0 : 0;

  const idleBots = shuffleArray(
    allReg.filter((p) => p.isComputer && !isPlayerBusy(p.name))
  );

  if (idleBots.length > 0 && gameOffers.length > 0) {
    for (const offer of shuffleArray(gameOffers)) {
      if (!gameOffers.some((o) => o.id === offer.id)) continue;
      if (now - offer.timestamp < HUMAN_PRIORITY_DELAY) continue;

      // Sort bots so the best-positioned challenger joins offers against 1st place first
      const candidateBots = [...idleBots].sort((a, b) => {
        const offerHasLeader =
          firstPlacePlayer &&
          firstPlaceScore > 0 &&
          offer.acceptedBy.some((n) => n.toLowerCase() === firstPlacePlayer.name.toLowerCase());
        if (offerHasLeader) {
          // Prefer higher-ELO / higher-score bots to challenge & stop 1st place
          return (b.elo + b.score * 0.5) - (a.elo + a.score * 0.5);
        }
        return 0;
      });

      for (const bot of candidateBots) {
        if (isPlayerBusy(bot.name)) continue;
        if (offer.acceptedBy.includes(bot.name)) continue;
        const targeted =
          !offer.targets ||
          offer.targets.length === 0 ||
          offer.targets.includes('Any') ||
          offer.targets.includes(bot.name);
        if (!targeted) continue;

        // Tournament strategy: consider 1st place's score lead and how best to stop them from winning
        if (tournamentState.isRunning && firstPlacePlayer && firstPlaceScore > 0) {
          const isBotLeader = bot.name.toLowerCase() === firstPlacePlayer.name.toLowerCase();
          const scoreDeficit = Math.max(0, firstPlaceScore - (bot.score || 0));
          const offerHasLeader = offer.acceptedBy.some(
            (n) => n.toLowerCase() === firstPlacePlayer.name.toLowerCase()
          );
          // If 1st place is in a 2-player offer with huge advantage settings and this bot is weak, wait briefly if stronger bots are available
          if (
            !isBotLeader &&
            offerHasLeader &&
            offer.requiredPlayers === 2 &&
            bot.elo < firstPlacePlayer.elo - 120 &&
            candidateBots.some((other) => other.name !== bot.name && other.elo >= firstPlacePlayer.elo) &&
            now - offer.timestamp < HUMAN_PRIORITY_DELAY + 5000
          ) {
            continue;
          }
          // If 1st place is far ahead (scoreDeficit >= 150) and this offer doesn't involve 1st place,
          // while 1st place is currently idle, bots may briefly prioritize confronting 1st place directly
          if (
            !isBotLeader &&
            scoreDeficit >= 150 &&
            !offerHasLeader &&
            !isPlayerBusy(firstPlacePlayer.name) &&
            now - offer.timestamp < HUMAN_PRIORITY_DELAY + 3000 &&
            Math.random() < 0.5
          ) {
            continue;
          }
        }

        offer.acceptedBy.push(bot.name);
        if (offer.acceptedBy.length >= offer.requiredPlayers) {
          createMatchFromOffer(offer);
          gameOffers = gameOffers.filter((o) => o.id !== offer.id);
          gameOffers = gameOffers.filter(
            (o) => !o.acceptedBy.some((name) => offer.acceptedBy.includes(name))
          );
          break;
        }
      }
    }
  }

  // 5. During an active tournament, if there are idle bots and fewer than 2 open offers, bots post offers
  if (tournamentState.isRunning && idleBots.length > 0 && gameOffers.length < 2) {
    const freeBots = idleBots.filter(
      (b) => !gameOffers.some((o) => o.acceptedBy.includes(b.name))
    );
    if (freeBots.length > 0 && Math.random() < 0.35) {
      const bot = randomChoice(freeBots);
      const totalReg = registeredPlayers.size;
      const maxP = Math.min(5, Math.max(2, totalReg));
      const possibleCounts = [];
      for (let k = 2; k <= maxP; k++) possibleCounts.push(k);

      const isBotFirst =
        firstPlacePlayer && bot.name.toLowerCase() === firstPlacePlayer.name.toLowerCase();
      const leaderLead = firstPlacePlayer
        ? isBotFirst
          ? (bot.score || 0) - (secondPlacePlayer ? secondPlacePlayer.score || 0 : 0)
          : firstPlaceScore - (bot.score || 0)
        : 0;

      let reqP = randomChoice(possibleCounts) || 2;
      let targets = ['Any'];
      let blocksCount = randomChoice([0, 1, 2]);
      let removesCount = randomChoice([0, 1, 2]);
      let timeCtrl = randomChoice([2, 3, 5]);

      if (!isBotFirst && firstPlacePlayer && leaderLead > 0) {
        // Trailing bot strategy: consider how far ahead 1st place is and the best way to stop them
        const leaderIdle = !isPlayerBusy(firstPlacePlayer.name);
        if (leaderIdle && Math.random() < 0.7) {
          // Challenge 1st place directly or in a 3+ player match where multiple players can block/remove 1st place's lines
          if (maxP >= 3 && (leaderLead >= 120 || bot.elo <= firstPlacePlayer.elo) && Math.random() < 0.75) {
            const multiCounts = possibleCounts.filter((k) => k >= 3);
            reqP = randomChoice(multiCounts) || 3;
          } else {
            reqP = 2;
          }
          // Include 1st place as a primary target (or 'Any' if multi-player so others join to gang up on 1st place)
          targets = reqP === 2 && Math.random() < 0.65 ? [firstPlacePlayer.name, 'Any'] : ['Any'];
          // Equip blocks & removes so players have tactical tools to stop 1st place from completing lines
          blocksCount = randomChoice([1, 2]);
          removesCount = randomChoice([1, 2]);
        } else if (!leaderIdle && leaderLead >= 120) {
          // 1st place is busy: play high-point multi-player or faster games to close the score gap
          if (maxP >= 3 && Math.random() < 0.7) {
            reqP = randomChoice(possibleCounts.filter((k) => k >= 3)) || 3;
          }
          timeCtrl = leaderLead >= 250 ? randomChoice([2, 3]) : randomChoice([3, 5]);
        }
      }

      const bSize = reqP >= 4 ? randomChoice([5, 6, 7]) : randomChoice([4, 5, 6]);
      const winHc = reqP >= 4 ? randomChoice([3, 4]) : Math.min(bSize, randomChoice([3, 4]));
      const reductionOptions = ['standard', 'infinite', 'lockdown', 'lockattack'];
      gameOffers.push({
        id: offerIdCounter++,
        creator: bot.name,
        acceptedBy: [bot.name],
        requiredPlayers: reqP,
        boardSize: bSize,
        handicap: winHc,
        blocks: blocksCount,
        removes: removesCount,
        timeControl: timeCtrl,
        allowRemoveBlocks: Math.random() < 0.85,
        winReductionMode: randomChoice(reductionOptions),
        targets,
        timestamp: now,
      });
    }
  }
}, 1000);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, obj, statusCode = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function getTargetGame(params) {
  const gid = params.get('gameId') || 'default';
  return activeGames.get(gid) || defaultGame;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const params = parsedUrl.searchParams;

  // ==================== Lobby & Matchmaking Endpoints ====================
  if (pathname === '/api/lobby/status') {
    const playersArr = Array.from(registeredPlayers.values()).map((p) => ({
      ...p,
      busy: isPlayerBusy(p.name),
    }));
    playersArr.sort((a, b) => b.score - a.score || b.elo - a.elo);

    const gamesArr = [];
    for (const [id, g] of activeGames.entries()) {
      if (id === 'default') continue;
      gamesArr.push({
        gameId: g.gameId,
        numPlayers: g.numPlayers,
        boardSize: g.boardSize,
        activePlayers: g.activePlayers,
        eliminatedPlayers: g.eliminatedPlayers,
        playerNames: g.playerNames,
        playerTypes: g.playerTypes,
        currentPlayer: g.currentPlayer,
        winner: g.winner,
        draw: g.draw,
        moveCount: g.moveCount,
        durationMs: Date.now() - g.createdAt,
      });
    }

    const remTime =
      tournamentState.isRunning && tournamentState.startTime
        ? Math.max(0, tournamentState.durationMs - (Date.now() - tournamentState.startTime))
        : 0;

    return sendJson(res, {
      players: playersArr,
      offers: gameOffers,
      games: gamesArr,
      lanUrls: getLanUrls(),
      tournament: {
        isRunning: tournamentState.isRunning,
        mode: tournamentState.mode,
        remainingTime: remTime,
        durationMs: tournamentState.durationMs,
      },
    });
  }

  if (pathname === '/api/lobby/register') {
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const rawName = (body.name || params.get('name') || '').trim();
    const isComputer = Boolean(body.isComputer || params.get('isComputer') === '1');
    const browserId = body.browserId || params.get('browserId') || null;

    if (!rawName) {
      return sendJson(res, { error: 'Player name is required' }, 400);
    }
    const cleanName = rawName.slice(0, 22);
    const key = cleanName.toLowerCase();
    const existing = registeredPlayers.get(key);
    if (existing) {
      if (!existing.isComputer && existing.browserId && browserId && existing.browserId !== browserId) {
        return sendJson(
          res,
          { error: `Player name "${existing.name}" is already registered on another computer!` },
          403
        );
      }
      if (!existing.isComputer && browserId && !existing.browserId) {
        existing.browserId = browserId;
      }
      return sendJson(res, {
        success: true,
        message: `Synced as ${existing.name}`,
        player: existing,
      });
    }

    const newPlayer = {
      name: cleanName,
      isComputer,
      elo: 1200,
      score: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      gamesPlayed: 0,
      browserId,
      activeGameId: null,
    };
    registeredPlayers.set(key, newPlayer);
    return sendJson(res, {
      success: true,
      message: `${cleanName} registered${isComputer ? ' (CPU)' : ''}!`,
      player: newPlayer,
    });
  }

  if (pathname === '/api/lobby/unregister') {
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const rawName = (body.name || params.get('name') || '').trim().toLowerCase();
    if (rawName && registeredPlayers.has(rawName)) {
      const p = registeredPlayers.get(rawName);
      registeredPlayers.delete(rawName);
      gameOffers = gameOffers.filter((o) => !o.acceptedBy.includes(p.name));
    }
    return sendJson(res, { success: true });
  }

  if (pathname === '/api/lobby/offers/create') {
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const creator = (body.creator || params.get('creator') || '').trim();
    const browserId = body.browserId || params.get('browserId') || null;
    if (!creator) {
      return sendJson(res, { error: 'Please register your player name first' }, 400);
    }
    const existingCreator = getRegisteredPlayer(creator);
    if (!existingCreator) {
      registeredPlayers.set(creator.toLowerCase(), {
        name: creator,
        isComputer: false,
        elo: 1200,
        score: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        gamesPlayed: 0,
        browserId,
        activeGameId: null,
      });
    } else if (!existingCreator.isComputer && browserId) {
      if (existingCreator.browserId && existingCreator.browserId !== browserId) {
        return sendJson(res, { error: 'Cannot create an offer using another computer\'s player name' }, 403);
      }
      existingCreator.browserId = browserId;
    }
    if (isPlayerBusy(creator)) {
      return sendJson(res, { error: `${creator} is already in an active game` }, 400);
    }

    const reqPlayers = Math.min(
      5,
      Math.max(2, parseInt(body.requiredPlayers || params.get('requiredPlayers') || '2', 10) || 2)
    );
    const bSize = Math.min(
      7,
      Math.max(1, parseInt(body.boardSize || params.get('boardSize') || '5', 10) || 5)
    );
    const hc = Math.min(
      bSize,
      Math.max(1, parseInt(body.handicap || params.get('handicap') || String(bSize), 10) || bSize)
    );
    const bl = Math.min(
      3,
      Math.max(0, parseInt(body.blocks || params.get('blocks') || '0', 10) || 0)
    );
    const rm = Math.min(
      3,
      Math.max(0, parseInt(body.removes || params.get('removes') || '0', 10) || 0)
    );
    const tc = Math.min(
      15,
      Math.max(1, parseInt(body.timeControl || params.get('timeControl') || '5', 10) || 5)
    );
    const allowRb = body.allowRemoveBlocks !== undefined ? Boolean(body.allowRemoveBlocks) : true;
    const winRed = normalizeWinReductionMode(body.winReductionMode || 'standard');
    const targets =
      Array.isArray(body.targets) && body.targets.length > 0 ? body.targets : ['Any'];

    const offer = {
      id: offerIdCounter++,
      creator,
      acceptedBy: [creator],
      requiredPlayers: reqPlayers,
      boardSize: bSize,
      handicap: hc,
      blocks: bl,
      removes: rm,
      timeControl: tc,
      allowRemoveBlocks: allowRb,
      winReductionMode: winRed,
      targets,
      timestamp: Date.now(),
    };
    gameOffers.push(offer);
    return sendJson(res, {
      success: true,
      gameStarted: false,
      offer,
      message: `Created ${reqPlayers}-player offer (${bSize}x${bSize}, Win ${hc})`,
    });
  }

  if (pathname === '/api/lobby/offers/accept') {
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const offerId = parseInt(body.offerId || params.get('offerId') || '0', 10);
    const playerName = (body.playerName || params.get('playerName') || '').trim();
    const browserId = body.browserId || params.get('browserId') || null;

    if (!playerName) {
      return sendJson(res, { error: 'Please register your player name first' }, 400);
    }
    const existingJoiner = getRegisteredPlayer(playerName);
    if (!existingJoiner) {
      registeredPlayers.set(playerName.toLowerCase(), {
        name: playerName,
        isComputer: false,
        elo: 1200,
        score: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        gamesPlayed: 0,
        browserId,
        activeGameId: null,
      });
    } else if (!existingJoiner.isComputer && browserId) {
      if (existingJoiner.browserId && existingJoiner.browserId !== browserId) {
        return sendJson(res, { error: 'Cannot accept an offer using another computer\'s player name' }, 403);
      }
      existingJoiner.browserId = browserId;
    }
    if (isPlayerBusy(playerName)) {
      return sendJson(res, { error: `${playerName} is currently in an active game` }, 400);
    }

    const idx = gameOffers.findIndex((o) => o.id === offerId);
    if (idx === -1) {
      return sendJson(res, { error: 'Offer not found or already started' }, 404);
    }
    const offer = gameOffers[idx];
    if (offer.acceptedBy.some((n) => n.toLowerCase() === playerName.toLowerCase())) {
      return sendJson(res, { error: 'You already joined this offer' }, 400);
    }
    if (
      offer.targets &&
      !offer.targets.includes('Any') &&
      !offer.targets.some((t) => t.toLowerCase() === playerName.toLowerCase())
    ) {
      return sendJson(res, { error: 'This offer is targeted to specific players' }, 403);
    }

    offer.acceptedBy.push(playerName);
    if (offer.acceptedBy.length < offer.requiredPlayers) {
      return sendJson(res, {
        success: true,
        gameStarted: false,
        offer,
        message: `Joined lobby (${offer.acceptedBy.length}/${offer.requiredPlayers} players)`,
      });
    }

    const resMatch = createMatchFromOffer(offer);
    gameOffers.splice(idx, 1);
    gameOffers = gameOffers.filter(
      (o) => !o.acceptedBy.some((p) => offer.acceptedBy.includes(p))
    );
    return sendJson(res, resMatch);
  }

  if (pathname === '/api/lobby/offers/fill-cpu') {
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const offerId = parseInt(body.offerId || params.get('offerId') || '0', 10);
    const idx = gameOffers.findIndex((o) => o.id === offerId);
    if (idx === -1) {
      return sendJson(res, { error: 'Offer not found' }, 404);
    }
    const offer = gameOffers[idx];
    let botHint = 1;
    while (offer.acceptedBy.length < offer.requiredPlayers) {
      const bot = ensureCpuBotExists(botHint++);
      if (!offer.acceptedBy.includes(bot.name)) {
        offer.acceptedBy.push(bot.name);
      }
    }
    const resMatch = createMatchFromOffer(offer);
    gameOffers.splice(idx, 1);
    gameOffers = gameOffers.filter(
      (o) => !o.acceptedBy.some((p) => offer.acceptedBy.includes(p))
    );
    return sendJson(res, resMatch);
  }

  if (pathname === '/api/lobby/offers/cancel') {
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const offerId = parseInt(body.offerId || params.get('offerId') || '0', 10);
    gameOffers = gameOffers.filter((o) => o.id !== offerId);
    return sendJson(res, { success: true });
  }

  if (pathname === '/api/lobby/tournament/start') {
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const minutes = Math.max(1, parseInt(body.durationMinutes || params.get('minutes') || '10', 10) || 10);
    tournamentState.isRunning = true;
    tournamentState.startTime = Date.now();
    tournamentState.durationMs = minutes * 60 * 1000;
    return sendJson(res, {
      success: true,
      message: `Tournament started for ${minutes} minutes!`,
    });
  }

  if (pathname === '/api/lobby/tournament/clear-scores') {
    for (const p of registeredPlayers.values()) {
      p.score = 0;
      p.wins = 0;
      p.draws = 0;
      p.losses = 0;
      p.gamesPlayed = 0;
    }
    return sendJson(res, { success: true, message: 'Scores cleared!' });
  }

  if (pathname === '/api/lobby/tournament/reset') {
    tournamentState.isRunning = false;
    tournamentState.startTime = null;
    tournamentState.durationMs = 0;
    gameOffers = [];
    for (const [id] of activeGames.entries()) {
      if (id !== 'default') activeGames.delete(id);
    }
    registeredPlayers.clear();
    return sendJson(res, { success: true, message: 'Tournament & lobby reset!' });
  }

  // ==================== Core Game Endpoints (Default or by ?gameId=...) ====================
  const game = getTargetGame(params);

  if (pathname === '/api/state') {
    return sendJson(res, game.getStateObject());
  }

  if (pathname === '/api/history') {
    return sendJson(res, game.gameHistory);
  }

  const browserId = params.get('browserId') || null;

  if (pathname === '/api/claim-seat') {
    const p = normalizePlayerId(params.get('player'));
    const release = params.get('release') === '1';
    if (p && game.gameId === 'default' && browserId) {
      const currentOwner = game.playerBrowserIds[p];
      if (release) {
        if (!currentOwner || currentOwner === browserId) {
          game.playerBrowserIds[p] = null;
        }
      } else if (!currentOwner || currentOwner === browserId) {
        game.playerBrowserIds[p] = browserId;
        const pName = params.get('name');
        if (pName) {
          game.playerNames[p] = String(pName).trim().slice(0, 22);
        }
      } else {
        return sendJson(res, { error: 'That seat is already claimed by another computer' }, 403);
      }
    }
    return sendJson(res, game.getStateObject());
  }

  if (pathname === '/api/move') {
    const p = parseIntOrNull(params.get('pos'));
    const actingPlayer = normalizePlayerId(params.get('player')) || game.currentPlayer;
    if (game.currentPlayer !== actingPlayer) {
      return sendJson(res, { status: 'ignored_stale_turn' });
    }
    if (!game.canBrowserControlSeat(actingPlayer, browserId)) {
      return sendJson(res, { error: 'You cannot control another computer\'s player' }, 403);
    }
    if (p !== null && p >= 0 && p < game.boardSize * game.boardSize) {
      game.handleMove(p);
    }
    return sendJson(res, { status: 'ok' });
  }

  if (pathname === '/api/block') {
    const p = parseIntOrNull(params.get('pos'));
    const actingPlayer = normalizePlayerId(params.get('player')) || game.currentPlayer;
    if (game.currentPlayer !== actingPlayer) {
      return sendJson(res, { status: 'ignored_stale_turn' });
    }
    if (!game.canBrowserControlSeat(actingPlayer, browserId)) {
      return sendJson(res, { error: 'You cannot control another computer\'s player' }, 403);
    }
    if (p !== null && p >= 0 && p < game.boardSize * game.boardSize) {
      if (!game.winner && !game.draw && game.board[p] === null) {
        const blocksLeft = game.blocks[game.currentPlayer] || 0;
        if (blocksLeft > 0) {
          game.board[p] = 'B';
          game.blocks[game.currentPlayer] -= 1;
          game.updatePostActionState();
          game.saveHistory();
        }
      }
    }
    return sendJson(res, { status: 'ok' });
  }

  if (pathname === '/api/remove') {
    const p = parseIntOrNull(params.get('pos'));
    const actingPlayer = normalizePlayerId(params.get('player')) || game.currentPlayer;
    if (game.currentPlayer !== actingPlayer) {
      return sendJson(res, { status: 'ignored_stale_turn' });
    }
    if (!game.canBrowserControlSeat(actingPlayer, browserId)) {
      return sendJson(res, { error: 'You cannot control another computer\'s player' }, 403);
    }
    if (p !== null && p >= 0 && p < game.boardSize * game.boardSize) {
      if (!game.winner && !game.draw && game.removableSquareP(game.board[p])) {
        if (game.currentRemoves() > 0) {
          game.board[p] = null;
          game.removes[game.currentPlayer] -= 1;
          game.updatePostActionState();
          game.saveHistory();
        }
      }
    }
    return sendJson(res, { status: 'ok' });
  }

  if (pathname === '/api/set-player-type') {
    if (game.gameId !== 'default') {
      return sendJson(res, { error: 'Cannot change player types in a matchmade game' }, 403);
    }
    const p = normalizePlayerId(params.get('player'));
    if (p && !game.canBrowserControlSeat(p, browserId)) {
      return sendJson(res, { error: 'Seat is locked to another computer' }, 403);
    }
    const type = params.get('type');
    const name = params.get('name');
    if (p && (type === 'human' || type === 'cpu')) {
      game.playerTypes[p] = type;
      if (type === 'cpu') game.playerBrowserIds[p] = null;
    }
    if (p && name !== null && name !== undefined) {
      game.playerNames[p] = String(name).trim().slice(0, 24) || DEFAULT_PLAYER_NAMES[p];
    }
    return sendJson(res, game.getStateObject());
  }

  if (pathname === '/api/set-remove-blocks') {
    const allow = params.get('allow');
    game.allowRemoveBlocks = !(
      allow === null ||
      allow === '0' ||
      allow.toLowerCase() === 'false'
    );
    if (!game.winner && !game.draw) {
      game.updatePostActionState();
    }
    return sendJson(res, { status: 'ok' });
  }

  if (pathname === '/api/set-win-reduction') {
    const modeParam = params.get('mode') !== null ? params.get('mode') : params.get('allow');
    game.winReductionMode = normalizeWinReductionMode(modeParam, game.winReductionMode);
    game.assignPlayerReductionModes(game.winReductionMode);
    if (!game.winner && !game.draw) {
      game.predictedDraw = game.computePredictedDraw();
      for (const p of ALL_PLAYERS) {
        game.agreeReduce[p] = false;
        game.declineReduce[p] = false;
      }
    }
    return sendJson(res, { status: 'ok' });
  }

  if (pathname === '/api/agree-reduce') {
    if (game.canReduceWinAmount()) {
      const player = normalizePlayerId(params.get('player'));
      if (player && !game.canBrowserControlSeat(player, browserId)) {
        return sendJson(res, { error: 'You cannot vote for another computer\'s player' }, 403);
      }
      const ai = params.get('ai') === '1';
      const live = game.getLivePlayers();
      if (player && live.includes(player)) {
        game.agreeReduce[player] = true;
        game.declineReduce[player] = false;

        for (const p of live) {
          const isCpu = game.playerTypes[p] === 'cpu' || (ai && p !== 'X');
          if (isCpu && !game.agreeReduce[p] && !game.declineReduce[p]) {
            const decision = game.evaluateWinReductionForPlayer(p);
            if (decision.agree) {
              game.agreeReduce[p] = true;
              game.declineReduce[p] = false;
            } else {
              game.declineReduce[p] = true;
              game.agreeReduce[p] = false;
              if (
                !game.tieOfferedBy &&
                !game.tieDeclinedBy &&
                game.moveCount >= game.lastAiTieOfferMove + 2
              ) {
                game.tieOfferedBy = p;
                game.tieAgreedBy = [p];
                game.lastAiTieOfferMove = game.moveCount;
              }
            }
          }
        }

        if (game.checkAllLiveAgreedReduce()) {
          game.reduceWinAmounts();
        }
      }
    }
    return sendJson(res, { status: 'ok' });
  }

  if (pathname === '/api/decline-reduce') {
    if (game.canReduceWinAmount()) {
      const player = normalizePlayerId(params.get('player'));
      if (player && !game.canBrowserControlSeat(player, browserId)) {
        return sendJson(res, { error: 'You cannot vote for another computer\'s player' }, 403);
      }
      if (player && game.agreeReduce[player]) {
        return sendJson(res, { error: 'Win reduction agreement cannot be taken back once accepted' }, 400);
      }
      const ai = params.get('ai') === '1';
      const live = game.getLivePlayers();
      if (player && live.includes(player) && !game.agreeReduce[player]) {
        game.declineReduce[player] = true;
        game.agreeReduce[player] = false;

        if (
          game.predictedDraw &&
          !game.tieOfferedBy &&
          !game.tieDeclinedBy &&
          game.moveCount >= game.lastAiTieOfferMove + 2
        ) {
          for (const p of live) {
            const isCpu = game.playerTypes[p] === 'cpu' || (ai && p !== 'X');
            if (isCpu && p !== player) {
              const tieEval = game.evaluateTieResponseForPlayer(p);
              if (tieEval.accept) {
                game.tieOfferedBy = p;
                game.tieAgreedBy = [p];
                game.lastAiTieOfferMove = game.moveCount;
                break;
              }
            }
          }
        }
      }
    }
    return sendJson(res, { status: 'ok' });
  }

  if (pathname === '/api/resign') {
    const player = normalizePlayerId(params.get('player'));
    if (player && !game.canBrowserControlSeat(player, browserId)) {
      return sendJson(res, { error: 'You cannot resign for another computer\'s player' }, 403);
    }
    if (player && !game.winner && !game.draw) {
      game.handlePlayerEliminationOrEnd(player, 'resign');
    }
    return sendJson(res, { status: 'ok' });
  }

  if (pathname === '/api/offer-tie') {
    const player = normalizePlayerId(params.get('player'));
    if (player && !game.canBrowserControlSeat(player, browserId)) {
      return sendJson(res, { error: 'You cannot offer a tie for another computer\'s player' }, 403);
    }
    const live = game.getLivePlayers();
    if (player && !game.winner && !game.draw && live.includes(player)) {
      if (game.tieOfferedBy && game.tieOfferedBy !== player) {
        if (!game.tieAgreedBy.includes(player)) game.tieAgreedBy.push(player);
        if (live.every((p) => game.tieAgreedBy.includes(p))) {
          game.draw = true;
          game.drawReason = 'mutual';
          game.predictedDraw = false;
          game.clearTurnPrompts();
          game.saveHistory();
        }
      } else {
        game.tieOfferedBy = player;
        game.tieAgreedBy = [player];
        game.tieDeclinedBy = null;
        if (game.playerTypes[player] === 'cpu' || player === 'O') {
          game.lastAiTieOfferMove = game.moveCount;
        }
        game.predictedDraw = game.computePredictedDraw();
      }
    }
    return sendJson(res, { status: 'ok' });
  }

  if (pathname === '/api/respond-tie') {
    const player = normalizePlayerId(params.get('player'));
    if (player && !game.canBrowserControlSeat(player, browserId)) {
      return sendJson(res, { error: 'You cannot respond to a tie for another computer\'s player' }, 403);
    }
    const accept = params.get('accept') === '1';
    const live = game.getLivePlayers();
    if (
      player &&
      !game.winner &&
      !game.draw &&
      game.tieOfferedBy &&
      game.tieOfferedBy !== player &&
      live.includes(player)
    ) {
      if (accept) {
        const someoneDeclinedReduce = live.some((p) => game.declineReduce[p]);
        if (
          params.get('preferReduce') === '1' &&
          game.canReduceWinAmount() &&
          !someoneDeclinedReduce
        ) {
          game.tieOfferedBy = null;
          game.tieAgreedBy = [];
          game.agreeReduce[player] = true;
          if (game.checkAllLiveAgreedReduce()) game.reduceWinAmounts();
        } else {
          if (!game.tieAgreedBy.includes(player)) game.tieAgreedBy.push(player);
          if (live.every((p) => game.tieAgreedBy.includes(p))) {
            game.draw = true;
            game.drawReason = 'mutual';
            game.predictedDraw = false;
            game.clearTurnPrompts();
            game.saveHistory();
          }
        }
      } else {
        game.tieOfferedBy = null;
        game.tieAgreedBy = [];
        game.tieDeclinedBy = player;
      }
    }
    return sendJson(res, { status: 'ok' });
  }

  if (pathname === '/api/ai-diplomacy') {
    const action = params.get('action') || 'check-status';
    const targetParam = normalizePlayerId(params.get('player'));
    const scoreParam = params.get('score');
    const searchScore =
      scoreParam !== null && scoreParam !== '' && !Number.isNaN(Number(scoreParam))
        ? Number(scoreParam)
        : null;

    if (!game.winner && !game.draw) {
      const live = game.getLivePlayers();
      const cpuPlayers = targetParam
        ? [targetParam].filter((p) => live.includes(p))
        : live.filter((p) => game.playerTypes[p] === 'cpu');

      if (action === 'evaluate-reduce') {
        if (game.canReduceWinAmount()) {
          for (const cpu of cpuPlayers) {
            if (!game.agreeReduce[cpu] && !game.declineReduce[cpu]) {
              const decision = game.evaluateWinReductionForPlayer(cpu);
              if (decision.agree) {
                game.agreeReduce[cpu] = true;
                game.declineReduce[cpu] = false;
              } else {
                game.declineReduce[cpu] = true;
                game.agreeReduce[cpu] = false;
                if (
                  game.predictedDraw &&
                  !game.tieOfferedBy &&
                  !game.tieDeclinedBy &&
                  game.moveCount >= game.lastAiTieOfferMove + 2
                ) {
                  game.tieOfferedBy = cpu;
                  game.tieAgreedBy = [cpu];
                  game.lastAiTieOfferMove = game.moveCount;
                }
              }
            }
          }
          if (game.checkAllLiveAgreedReduce()) {
            game.reduceWinAmounts();
          }
        }
      } else if (action === 'respond-tie') {
        if (game.tieOfferedBy) {
          for (const cpu of cpuPlayers) {
            if (
              game.tieOfferedBy &&
              game.tieOfferedBy !== cpu &&
              !game.tieAgreedBy.includes(cpu)
            ) {
              const decision = game.evaluateTieResponseForPlayer(
                cpu,
                cpu === targetParam ? searchScore : null
              );
              if (decision.accept) {
                game.tieAgreedBy.push(cpu);
              } else {
                game.tieOfferedBy = null;
                game.tieAgreedBy = [];
                game.tieDeclinedBy = cpu;
                break;
              }
            }
          }
          if (game.tieOfferedBy && live.every((p) => game.tieAgreedBy.includes(p))) {
            game.draw = true;
            game.drawReason = 'mutual';
            game.predictedDraw = false;
            game.clearTurnPrompts();
            game.saveHistory();
          }
        }
      } else if (action === 'check-status') {
        const checkP = targetParam || 'O';
        if (live.includes(checkP) && game.evaluateResignForPlayer(checkP, searchScore)) {
          game.handlePlayerEliminationOrEnd(checkP, 'resign');
        } else {
          for (const cpu of cpuPlayers) {
            if (game.canReduceWinAmount() && !game.agreeReduce[cpu] && !game.declineReduce[cpu]) {
              const decision = game.evaluateWinReductionForPlayer(cpu);
              if (decision.agree) {
                game.agreeReduce[cpu] = true;
                game.declineReduce[cpu] = false;
              } else {
                game.declineReduce[cpu] = true;
                game.agreeReduce[cpu] = false;
              }
            }
          }
          if (game.canReduceWinAmount() && game.checkAllLiveAgreedReduce()) {
            game.reduceWinAmounts();
          }
          if (!game.winner && !game.draw && live.includes(checkP)) {
            if (game.evaluateOfferTieForPlayer(checkP, searchScore)) {
              game.tieOfferedBy = checkP;
              game.tieAgreedBy = [checkP];
              game.lastAiTieOfferMove = game.moveCount;
            }
          }
        }
      }
    }
    return sendJson(res, game.getStateObject());
  }

  if (pathname === '/api/timeout') {
    const player = normalizePlayerId(params.get('player'));
    if (player && !game.winner && !game.draw) {
      game.handlePlayerEliminationOrEnd(player, 'timeout');
    }
    return sendJson(res, { status: 'ok' });
  }

  if (pathname === '/api/reset') {
    const sz = parseIntOrNull(params.get('size'));
    const np = parseIntOrNull(params.get('players'));
    const targetSize = sz !== null && sz >= 1 && sz <= 7 ? sz : game.boardSize;
    const targetPlayers = np !== null && np >= 2 && np <= 5 ? np : game.numPlayers;

    const hcMap = {};
    const blMap = {};
    const rmMap = {};
    const typesMap = {};
    const namesMap = {};

    for (const p of ALL_PLAYERS) {
      const lower = p.toLowerCase();
      const hcVal = parseIntOrNull(params.get(`${lower}hc`));
      const blVal = parseIntOrNull(params.get(`${lower}blocks`));
      const rmVal = parseIntOrNull(params.get(`${lower}removes`));
      const tVal = params.get(`${lower}type`);
      const nVal = params.get(`${lower}name`);
      if (hcVal !== null) hcMap[p] = hcVal;
      if (blVal !== null) blMap[p] = blVal;
      if (rmVal !== null) rmMap[p] = rmVal;
      if (tVal === 'human' || tVal === 'cpu') typesMap[p] = tVal;
      if (nVal) namesMap[p] = nVal;
    }

    const removeBlocksParam = params.get('removeblocks');
    const rbVal =
      removeBlocksParam !== null
        ? !(removeBlocksParam === '0' || removeBlocksParam.toLowerCase() === 'false')
        : game.allowRemoveBlocks;
    const winRedParam = params.get('winreduction');
    const wrVal =
      winRedParam !== null
        ? normalizeWinReductionMode(winRedParam, game.winReductionMode)
        : game.winReductionMode;
    const rawStarting = params.get('starting');
    const startingParam =
      rawStarting && rawStarting.toLowerCase() !== 'random'
        ? normalizePlayerId(rawStarting)
        : 'random';
    const timeParam = parseIntOrNull(params.get('time'));

    game.reset({
      size: targetSize,
      numPlayers: targetPlayers,
      handicaps: hcMap,
      blocks: blMap,
      removes: rmMap,
      playerTypes: Object.keys(typesMap).length > 0 ? typesMap : null,
      playerNames: Object.keys(namesMap).length > 0 ? namesMap : null,
      allowRemoveBlocks: rbVal,
      starting: startingParam,
      winReductionMode: wrVal,
      initialTime: timeParam,
    });
    return sendJson(res, { status: 'ok' });
  }

  // Serve static files from public/
  let relPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = getLanUrls();
  console.log(`GUI Server started on http://localhost:${PORT}`);
  if (lan.length > 0) {
    console.log(`LAN Multiplayer URL(s): ${lan.join(', ')}`);
  }
});
