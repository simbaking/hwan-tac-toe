// ai-worker.js
//
// Bitboards: boards up to 5x5 (25 squares) use plain 32-bit Numbers for speed. 6x6 and 7x7 boards
// need up to 49 bits, so the page starts this worker as 'ai-worker.js?big=1' and every bitboard is
// a BigInt instead. All bit logic goes through ZERO / ONE / BIT[i] / lowIdx / popcount so the same
// code works in both modes (a worker only ever runs in one mode, so V8 keeps it monomorphic).

const BIG = new URLSearchParams(self.location.search).get('big') === '1';
const ZERO = BIG ? 0n : 0;
const ONE = BIG ? 1n : 1;
const BIT = [];
for (let i = 0; i < 64; i++) BIT.push(BIG ? (1n << BigInt(i)) : (i < 31 ? (1 << i) : 0));
const MASK32 = 0xFFFFFFFFn;

function popcount32(n) {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return Math.imul((n + (n >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24;
}
const popcount = BIG
    ? (b) => popcount32(Number(b & MASK32)) + popcount32(Number(b >> 32n))
    : popcount32;
// Index of the highest set bit (for a single-bit value: its square index).
const lowIdx = BIG
    ? (b) => { const hi = Number(b >> 32n); return hi !== 0 ? 63 - Math.clz32(hi) : 31 - Math.clz32(Number(b & MASK32)); }
    : (b) => 31 - Math.clz32(b);

function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
}

function pickRandomBit(mask) {
    if (mask === ZERO) return -1;
    const indices = [];
    let t = mask;
    while (t !== ZERO) {
        const idx = lowIdx(t);
        indices.push(idx);
        t ^= BIT[idx];
    }
    return indices[Math.floor(Math.random() * indices.length)];
}

let tt = new Map();
const EXACT = 0, LOWERBOUND = 1, UPPERBOUND = 2;
let globalWinMasks = {};
let symmetriesCache = {};

function getSymmetries(size) {
    if (symmetriesCache[size]) return symmetriesCache[size];
    let syms = [];
    for (let i = 0; i < 8; i++) syms.push(new Array(size * size));
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            let i = r * size + c;
            syms[0][i] = r * size + c;
            syms[1][i] = c * size + (size - 1 - r);
            syms[2][i] = (size - 1 - r) * size + (size - 1 - c);
            syms[3][i] = (size - 1 - c) * size + r;
            syms[4][i] = r * size + (size - 1 - c);
            syms[5][i] = (size - 1 - r) * size + c;
            syms[6][i] = c * size + r;
            syms[7][i] = (size - 1 - c) * size + (size - 1 - r);
        }
    }
    symmetriesCache[size] = syms;
    return syms;
}

function mapBits(b, sym) {
    let out = ZERO;
    while (b !== ZERO) {
        const idx = lowIdx(b);
        out |= BIT[sym[idx]];
        b ^= BIT[idx];
    }
    return out;
}

let hasActiveIgnoredLines = false;

function getCanonicalKey(xBoard, oBoard, bBoard, size, isMax, xbl, obl, xrm, orm, canSpec) {
    if (hasActiveIgnoredLines) {
        return xBoard + '_' + oBoard + '_' + bBoard + '_' + (isMax ? 1 : 0) + '_' + xbl + '_' + obl + '_' + xrm + '_' + orm + '_' + (canSpec ? 1 : 0);
    }
    let syms = getSymmetries(size);
    let minNx = xBoard, minNo = oBoard, minNb = bBoard;

    for (let k = 1; k < 8; k++) {
        let sym = syms[k];
        let nx = mapBits(xBoard, sym);
        let no = mapBits(oBoard, sym);
        let nb = mapBits(bBoard, sym);

        if (nx < minNx) {
            minNx = nx; minNo = no; minNb = nb;
        } else if (nx === minNx) {
            if (no < minNo) {
                minNo = no; minNb = nb;
            } else if (no === minNo) {
                if (nb < minNb) {
                    minNb = nb;
                }
            }
        }
    }
    return minNx + '_' + minNo + '_' + minNb + '_' + (isMax ? 1 : 0) + '_' + xbl + '_' + obl + '_' + xrm + '_' + orm + '_' + (canSpec ? 1 : 0);
}

function getWinMasks(size, hc) {
    let key = size + '_' + hc;
    if (globalWinMasks[key]) return globalWinMasks[key];
    let masks = [];
    const dirs = [[0, 1], [1, 0], [1, 1], [-1, 1]];
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            for (let [dr, dc] of dirs) {
                let mask = ZERO;
                let valid = true;
                for (let step = 0; step < hc; step++) {
                    let nr = r + dr * step;
                    let nc = c + dc * step;
                    if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
                        mask |= BIT[nr * size + nc];
                    } else {
                        valid = false;
                        break;
                    }
                }
                if (valid) masks.push(mask);
            }
        }
    }
    globalWinMasks[key] = masks;
    return masks;
}

function getFilteredWinMasks(size, hc, ignoredLines) {
    const base = getWinMasks(size, hc);
    if (!ignoredLines || ignoredLines.length === 0) return base;
    const ignoredMasks = new Set();
    for (let i = 0; i < ignoredLines.length; i++) {
        const line = ignoredLines[i];
        let m = ZERO;
        for (let j = 0; j < line.length; j++) {
            m |= BIT[line[j]];
        }
        ignoredMasks.add(m);
    }
    return base.filter((m) => !ignoredMasks.has(m));
}

function checkWinBitboard(boardBits, masks) {
    for (let i = 0; i < masks.length; i++) {
        if ((boardBits & masks[i]) === masks[i]) return true;
    }
    return false;
}

// Bitmask of empty squares where `mine` would complete a winning line.
function winSquares(mine, masks, occ) {
    let res = ZERO;
    for (let i = 0; i < masks.length; i++) {
        let rem = masks[i] & ~mine;
        if (rem !== ZERO && (rem & (rem - ONE)) === ZERO && !(occ & rem)) res |= rem;
    }
    return res;
}

// Bitmask of OCCUPIED squares that are removable (`removableOcc`) and whose removal would give
// `mine` an immediate winning square on the same turn.
function blockedWinSquares(mine, masks, removableOcc) {
    let res = ZERO;
    for (let i = 0; i < masks.length; i++) {
        let rem = masks[i] & ~mine;
        if (rem !== ZERO && (rem & (rem - ONE)) === ZERO && (removableOcc & rem)) res |= rem;
    }
    return res;
}

// Stones of `opp` that sit in a line where opp is one move from winning (i.e. the line's only
// missing square is in `threatSquares`). Removing one of these breaks that threat.
function threatStones(opp, oppMasks, threatSquares) {
    let res = ZERO;
    for (let i = 0; i < oppMasks.length; i++) {
        const mk = oppMasks[i];
        const rem = mk & ~opp;
        if (rem !== ZERO && (rem & (rem - ONE)) === ZERO && (rem & threatSquares)) res |= (mk & opp);
    }
    return res;
}

// How valuable removing a square `sq` (opponent stone or block) is: sum of opponent line threats
// running through `sq` plus our own lines that `sq` is currently obstructing.
function removalValue(sq, opp, me, bBoard, oppMasks, meMasks) {
    const bit = BIT[sq];
    let v = 0;
    if (opp & bit) {
        for (let i = 0; i < oppMasks.length; i++) {
            const mk = oppMasks[i];
            if ((mk & bit) && !(mk & (me | bBoard))) v += Math.pow(10, popcount(mk & opp));
        }
    }
    // Also value freeing a square on one of our own lines that was blocked only by `sq`.
    const otherBlockers = (opp | bBoard) & ~bit;
    for (let i = 0; i < meMasks.length; i++) {
        const mk = meMasks[i];
        if ((mk & bit) && !(mk & otherBlockers)) {
            const myCnt = popcount(mk & me);
            if (myCnt > 0) v += Math.pow(10, myCnt);
        }
    }
    return v;
}

// Removable squares (opponent stones, plus blocks on our lines when `allowRemoveBlocks` is true)
// ordered by value, optionally capped.
function removalCandidates(opp, me, bBoard, oppMasks, meMasks, size, limit, restrictTo, allowRemoveBlocks = true) {
    let pool = restrictTo !== undefined ? restrictTo : (allowRemoveBlocks ? (opp | bBoard) : opp);
    if (!allowRemoveBlocks) pool &= ~bBoard;
    const list = [];
    for (let i = 0; i < size * size; i++) {
        if (pool & BIT[i]) {
            const v = removalValue(i, opp, me, bBoard, oppMasks, meMasks);
            if (v > 0 || restrictTo !== undefined) {
                const jitter = v * (Math.random() - 0.5) * 0.22 + (Math.random() - 0.5) * 4;
                list.push({ sq: i, v: v + jitter });
            }
        }
    }
    list.sort((a, b) => b.v - a.v);
    const out = [];
    for (let i = 0; i < list.length && (limit === undefined || out.length < limit); i++) out.push(list[i].sq);
    return out;
}

// Threat-space search ("victory by continuous forcing"): the attacker only plays moves that
// create a winning threat, so the defender's reply is forced. Finds forks (two winning squares)
// several moves deep without searching every quiet move. Returns the attacker's first move of a
// forced win, or -1 if none was found within depthLeft attacker moves.
let vcfNodes = 0;
let vcfAborted = false;
let vcfHardDeadline = Infinity; // wall-clock cap so the forcing search can never stall a big board
let forceTT = new Map(); // Persistent cache of forcing-search results across turns and branches
// Tuning: share of each move's time budget given to the forcing (threat) search, and how many
// quiet "setup" moves it may look through. The regular search keeps REGULAR_SEARCH_FLOOR at minimum.
const FORCE_ATTACK_SHARE = 0.5, FORCE_ATTACK_DEPTH = 3;
const FORCE_DEFENCE_SHARE = 0.7, FORCE_DEFENCE_DEPTH = 2;
const REGULAR_SEARCH_FLOOR = 0.3;
const VCF_NODE_CAP = 8000;
// In-tree cap on how many removal options are tried per node (the root tries them all).
const TREE_REMOVE_LIMIT = 3;

function hasCachedForceWin(att, def, occ) {
    const f = forceTT.get('F_' + att + '_' + def + '_' + occ);
    if (f && f.move !== -1) return f.move;
    const t = forceTT.get('T_' + att + '_' + def + '_' + occ);
    if (t && t.move !== -1) return t.move;
    return -1;
}

function vcfSearch(att, def, attMasks, defMasks, occ, size, depthLeft) {
    if (depthLeft <= 0 || attMasks.length === 0) return -1;
    if (vcfNodes++ > VCF_NODE_CAP || ((vcfNodes & 63) === 0 && Date.now() > vcfHardDeadline)) {
        vcfAborted = true;
        return -1;
    }
    if (vcfAborted) return -1;
    const key = 'F_' + att + '_' + def + '_' + occ;
    const cached = forceTT.get(key);
    if (cached !== undefined) {
        if (cached.move !== -1 && !(occ & BIT[cached.move])) return cached.move;
        if (cached.move === -1 && cached.depth >= depthLeft) return -1;
    }

    let aw = winSquares(att, attMasks, occ);
    if (aw !== ZERO) {
        const winMove = pickRandomBit(aw);
        forceTT.set(key, { move: winMove, depth: 99 });
        return winMove;
    }

    // Mathematical lower bound: to create a threat in 1 move, `att` must already have at least
    // `attHc - 2` stones on the board.
    const attHc = popcount(attMasks[0]);
    if (popcount(att) < attHc - 2) return -1;

    let cand = [];
    let dw = winSquares(def, defMasks, occ);
    if (dw !== ZERO) {
        if ((dw & (dw - ONE)) !== ZERO) {
            forceTT.set(key, { move: -1, depth: 99 });
            return -1; // defender wins first; can't stop both
        }
        cand.push(lowIdx(dw));       // attacker must block
    } else {
        for (let i = 0; i < size * size; i++) if (!(occ & BIT[i])) cand.push(i);
        shuffleInPlace(cand);
    }
    const startAborted = vcfAborted;
    for (const m of cand) {
        const bit = BIT[m];
        const nAtt = att | bit, nOcc = occ | bit;
        const t = winSquares(nAtt, attMasks, nOcc);
        if (t === ZERO) continue;                                  // not a forcing move
        if (winSquares(def, defMasks, nOcc) !== ZERO) continue;    // defender wins instead
        if ((t & (t - ONE)) !== ZERO) {
            forceTT.set(key, { move: m, depth: 99 });
            return m;                                           // double threat -> win
        }
        const bsq = t;                                          // defender is forced to block here
        const nDef = def | bsq;
        if (checkWinBitboard(nDef, defMasks)) continue;
        if (vcfSearch(nAtt, nDef, attMasks, defMasks, nOcc | bsq, size, depthLeft - 1) !== -1) {
            forceTT.set(key, { move: m, depth: depthLeft });
            return m;
        }
        if (vcfAborted) break;
    }
    if (!vcfAborted && !startAborted) {
        if (!cached || cached.depth < depthLeft) {
            forceTT.set(key, { move: -1, depth: depthLeft });
        }
    }
    return -1;
}

// Deeper threat-space search: if no pure forcing chain wins, the attacker may also make one quiet
// "setup" move that *threatens* to start a winning forcing chain. The defender then gets any reply;
// if every reply still loses to the attacker (recursively), the setup move wins by force.
// Bounded by vctDeadline so it can never stall the AI. Returns the attacker's move or -1.
let vctDeadline = 0;
function vctSearch(att, def, attMasks, defMasks, occ, size, depth) {
    if (attMasks.length === 0) return -1;
    const key = 'T_' + att + '_' + def + '_' + occ;
    const cached = forceTT.get(key);
    if (cached !== undefined) {
        if (cached.move !== -1 && !(occ & BIT[cached.move])) return cached.move;
        if (cached.move === -1 && cached.depth >= depth) return -1;
    }

    vcfNodes = 0;
    vcfAborted = false;
    let f = vcfSearch(att, def, attMasks, defMasks, occ, size, 8);
    if (f !== -1) {
        forceTT.set(key, { move: f, depth: 99 });
        return f;
    }
    if (depth <= 0 || Date.now() > vctDeadline) return -1;
    const attHc = popcount(attMasks[0]);
    if (popcount(att) + depth < attHc - 2) return -1;
    if (winSquares(def, defMasks, occ) !== ZERO) return -1; // defender has a threat of their own: don't assume a win

    const n = size * size;
    const empties = [];
    for (let i = 0; i < n; i++) if (!(occ & BIT[i])) empties.push(i);

    // Order defender replies by how much they hinder the attacker (lines through the square that
    // the attacker still has open), so a refuting reply is found quickly.
    const hinder = (sq) => {
        const bit = BIT[sq];
        let s = 0;
        for (let i = 0; i < attMasks.length; i++) {
            const mk = attMasks[i];
            if ((mk & bit) && (mk & def) === ZERO) s += popcount(mk & att) + 1;
        }
        return s;
    };

    let timedOut = false;
    for (const m of empties) {
        if (Date.now() > vctDeadline) { timedOut = true; break; }
        const bit = BIT[m];
        const nAtt = att | bit, nOcc = occ | bit;
        // Only a real setup if, were the defender to pass, the attacker would have a forcing win.
        vcfNodes = 0;
        vcfAborted = false;
        if (vcfSearch(nAtt, def, attMasks, defMasks, nOcc, size, 6) === -1) continue;

        const replies = empties.filter(d => d !== m);
        const hs = {};
        for (const d of replies) hs[d] = hinder(d);
        replies.sort((a, b) => hs[b] - hs[a]);

        let allWin = true;
        for (const d of replies) {
            if (Date.now() > vctDeadline) { timedOut = true; allWin = false; break; }
            const dbit = BIT[d];
            const nDef = def | dbit;
            if (checkWinBitboard(nDef, defMasks)) { allWin = false; break; }
            if (vctSearch(nAtt, nDef, attMasks, defMasks, nOcc | dbit, size, depth - 1) === -1) {
                allWin = false;
                break;
            }
        }
        if (allWin) {
            forceTT.set(key, { move: m, depth: depth });
            return m;
        }
        if (timedOut) break;
    }
    if (!timedOut && Date.now() <= vctDeadline) {
        if (!cached || cached.depth < depth) {
            forceTT.set(key, { move: -1, depth: depth });
        }
    }
    return -1;
}

// Unspent blocks/removes are worth something; without this the search would burn them in quiet
// positions just to gain a small positional edge. Sampled per turn so CPU style varies slightly.
let BLOCK_VALUE = 500, REMOVE_VALUE = 1200;
let styleAggression = 1.0;

function sampleTurnStyle() {
    BLOCK_VALUE = Math.round(390 + Math.random() * 240);
    REMOVE_VALUE = Math.round(920 + Math.random() * 520);
    styleAggression = 0.88 + Math.random() * 0.26;
}

function evaluateBoard(xBoard, oBoard, bBoard, xWinMasks, oWinMasks, xbl, obl, xrm, orm) {
    let score = ((obl || 0) - (xbl || 0)) * BLOCK_VALUE + ((orm || 0) - (xrm || 0)) * REMOVE_VALUE;
    for (let i=0; i<oWinMasks.length; i++) {
        let mask = oWinMasks[i];
        if (((xBoard | bBoard) & mask) === ZERO) { // no X (or block) in this line
            let count = popcount(oBoard & mask);
            if (count > 0) score += Math.pow(10, count) * styleAggression;
        }
    }
    for (let i=0; i<xWinMasks.length; i++) {
        let mask = xWinMasks[i];
        if (((oBoard | bBoard) & mask) === ZERO) { // no O (or block) in this line
            let count = popcount(xBoard & mask);
            if (count > 0) score -= Math.pow(10, count) * (2.0 - styleAggression);
        }
    }
    return score;
}

let shouldStopSearch = false;
let stopTime = 0;
let nodesCount = 0;

// Turn structure: placing a mark ends the turn (incrementing `depth`); using a block (fill an empty
// square) or a remove (empty a filled square) does NOT end the turn, so it stays at the same `depth`
// with `canUseSpecial = false` and the player then makes their normal placement. Keeping `depth` as
// full turns ensures every branch reaches `maxDepth` with the same side to move.
function minimax(xBoard, oBoard, bBoard, size, depth, maxDepth, isMaximizing, alpha, beta, xWinMasks, oWinMasks, xbl, obl, xrm, orm, canUseSpecial = true, allowRemoveBlocks = true) {
    if ((nodesCount++ & 1023) === 0) {
        if (Date.now() >= stopTime) {
            shouldStopSearch = true;
        }
    }
    if (shouldStopSearch) return 0;

    let origAlpha = alpha;
    let origBeta = beta;
    let key = getCanonicalKey(xBoard, oBoard, bBoard, size, isMaximizing, xbl, obl, xrm, orm, canUseSpecial);
    let entry = tt.get(key);

    // Check TT with depth condition
    if (entry && entry.depth >= (maxDepth - depth)) {
        let score = entry.score;
        if (score > 50000) score -= depth;
        else if (score < -50000) score += depth;

        if (entry.flag === EXACT) return score;
        if (entry.flag === LOWERBOUND) alpha = Math.max(alpha, score);
        else if (entry.flag === UPPERBOUND) beta = Math.min(beta, score);
        if (alpha >= beta) return score;
    }

    if (checkWinBitboard(oBoard, oWinMasks)) return 100000 - depth;
    if (checkWinBitboard(xBoard, xWinMasks)) return -100000 + depth;

    const myBl = isMaximizing ? obl : xbl;
    const myRm = isMaximizing ? orm : xrm;
    const oppBl = isMaximizing ? xbl : obl;
    const oppRm = isMaximizing ? xrm : orm;

    let fullMask = BIT[size * size] - ONE;
    let occ = xBoard | oBoard | bBoard;
    const removableOcc = allowRemoveBlocks ? occ : (xBoard | oBoard);
    const boardFull = (occ & fullMask) === fullMask;
    if (boardFull && (myRm === 0 || !canUseSpecial || removableOcc === ZERO)) return 0;

    // Threat detection (done before the horizon so a win-in-1 is never missed).
    const myBoard = isMaximizing ? oBoard : xBoard;
    const oppBoard = isMaximizing ? xBoard : oBoard;
    const myMasks = isMaximizing ? oWinMasks : xWinMasks;
    const oppMasks = isMaximizing ? xWinMasks : oWinMasks;

    // Mover can win right now (either on an empty square, or by removing the 1 blocker on a winning line).
    if (winSquares(myBoard, myMasks, occ) !== ZERO) {
        return isMaximizing ? 100000 - (depth + 1) : -100000 + (depth + 1);
    }
    if (canUseSpecial && myRm > 0 && blockedWinSquares(myBoard, myMasks, removableOcc) !== ZERO) {
        return isMaximizing ? 100000 - (depth + 1) : -100000 + (depth + 1);
    }
    // If the forcing-search cache already solved this position as a forced win for the mover,
    // score it immediately without re-searching the tree. (Only trusted when the opponent has no
    // blocks/removes, since the forcing search doesn't model them.)
    if (oppRm === 0 && oppBl === 0 && hasCachedForceWin(myBoard, oppBoard, occ) !== -1) {
        return isMaximizing ? 90000 - (depth + 2) : -90000 + (depth + 2);
    }
    // Opponent threatens to win next move.
    let oppW = winSquares(oppBoard, oppMasks, occ);
    const multiThreat = oppW !== ZERO && (oppW & (oppW - ONE)) !== ZERO;
    if (multiThreat && (!canUseSpecial || (myBl === 0 && myRm === 0))) {
        // Two or more winning squares and no block/remove to buy time: mover can only stop one -> lost.
        return isMaximizing ? -100000 + (depth + 2) : 100000 - (depth + 2);
    }

    if (depth >= maxDepth) {
        return evaluateBoard(xBoard, oBoard, bBoard, xWinMasks, oWinMasks, xbl, obl, xrm, orm);
    }

    let availableMoves = [];
    let removeMoves = [];
    if (oppW !== ZERO) {
        // Must deal with the threat: occupy (or block) a winning square, or remove a stone from the line.
        let t = oppW;
        while (t !== ZERO) { const i = lowIdx(t); availableMoves.push(i); t ^= BIT[i]; }
        if (canUseSpecial && myRm > 0) {
            removeMoves = removalCandidates(oppBoard, myBoard, bBoard, oppMasks, myMasks, size, TREE_REMOVE_LIMIT,
                                            threatStones(oppBoard, oppMasks, oppW), allowRemoveBlocks);
        }
    } else {
        for (let i = 0; i < size * size; i++) {
            if (!(occ & BIT[i])) availableMoves.push(i);
        }
        // Move ordering: prioritise squares that create threats (esp. doubles) for the mover,
        // deny the opponent's threat-creating squares, and consult the forcing-search cache.
        const center = Math.floor(size / 2);
        const scores = {};
        for (const m of availableMoves) {
            const bit = BIT[m];
            const nMy = myBoard | bit, nOcc = occ | bit;
            let s = 0;
            const myT = popcount(winSquares(nMy, myMasks, nOcc));
            const oppT = popcount(winSquares(oppBoard | bit, oppMasks, nOcc));
            if (myT >= 2) s += 20000;
            else if (myT === 1) s += 3000;
            if (oppT >= 2) s += 10000;
            else if (oppT === 1) s += 1500;
            if (hasCachedForceWin(oppBoard, nMy, nOcc) !== -1) s -= 50000;
            if (Math.floor(m / size) === center && m % size === center) s += 100;
            scores[m] = s;
        }
        availableMoves.sort((a, b) => scores[b] - scores[a]);
        if (canUseSpecial && myRm > 0) {
            removeMoves = removalCandidates(oppBoard, myBoard, bBoard, oppMasks, myMasks, size, TREE_REMOVE_LIMIT,
                                            undefined, allowRemoveBlocks);
        }
    }

    let bestScore = isMaximizing ? -Infinity : Infinity;

    if (isMaximizing) {
        for (let i = 0; i < availableMoves.length; i++) {
            let move = availableMoves[i];
            let bit = BIT[move];

            let score = minimax(xBoard, oBoard | bit, bBoard, size, depth + 1, maxDepth, false, alpha, beta, xWinMasks, oWinMasks, xbl, obl, xrm, orm, true, allowRemoveBlocks);
            if (shouldStopSearch) return 0;
            bestScore = Math.max(bestScore, score);
            alpha = Math.max(alpha, bestScore);
            if (beta <= alpha) break;

            if (canUseSpecial && obl > 0) {
                let bScore = minimax(xBoard, oBoard, bBoard | bit, size, depth, maxDepth, true, alpha, beta, xWinMasks, oWinMasks, xbl, obl - 1, xrm, orm, false, allowRemoveBlocks);
                if (shouldStopSearch) return 0;
                bestScore = Math.max(bestScore, bScore);
                alpha = Math.max(alpha, bestScore);
                if (beta <= alpha) break;
            }
        }
        if (beta > alpha) {
            for (let i = 0; i < removeMoves.length; i++) {
                const rBit = BIT[removeMoves[i]];
                let rScore = minimax(xBoard & ~rBit, oBoard & ~rBit, bBoard & ~rBit, size, depth, maxDepth, true, alpha, beta, xWinMasks, oWinMasks, xbl, obl, xrm, orm - 1, false, allowRemoveBlocks);
                if (shouldStopSearch) return 0;
                bestScore = Math.max(bestScore, rScore);
                alpha = Math.max(alpha, bestScore);
                if (beta <= alpha) break;
            }
        }
    } else {
        for (let i = 0; i < availableMoves.length; i++) {
            let move = availableMoves[i];
            let bit = BIT[move];

            let score = minimax(xBoard | bit, oBoard, bBoard, size, depth + 1, maxDepth, true, alpha, beta, xWinMasks, oWinMasks, xbl, obl, xrm, orm, true, allowRemoveBlocks);
            if (shouldStopSearch) return 0;
            bestScore = Math.min(bestScore, score);
            beta = Math.min(beta, bestScore);
            if (beta <= alpha) break;

            if (canUseSpecial && xbl > 0) {
                let bScore = minimax(xBoard, oBoard, bBoard | bit, size, depth, maxDepth, false, alpha, beta, xWinMasks, oWinMasks, xbl - 1, obl, xrm, orm, false, allowRemoveBlocks);
                if (shouldStopSearch) return 0;
                bestScore = Math.min(bestScore, bScore);
                beta = Math.min(beta, bestScore);
                if (beta <= alpha) break;
            }
        }
        if (beta > alpha) {
            for (let i = 0; i < removeMoves.length; i++) {
                const rBit = BIT[removeMoves[i]];
                let rScore = minimax(xBoard & ~rBit, oBoard & ~rBit, bBoard & ~rBit, size, depth, maxDepth, false, alpha, beta, xWinMasks, oWinMasks, xbl, obl, xrm - 1, orm, false, allowRemoveBlocks);
                if (shouldStopSearch) return 0;
                bestScore = Math.min(bestScore, rScore);
                beta = Math.min(beta, bestScore);
                if (beta <= alpha) break;
            }
        }
    }

    if (!shouldStopSearch) {
        let ttScore = bestScore;
        if (bestScore > 50000) ttScore = bestScore + depth;
        else if (bestScore < -50000) ttScore = bestScore - depth;

        let flag = EXACT;
        if (bestScore <= origAlpha) flag = UPPERBOUND;
        else if (bestScore >= origBeta) flag = LOWERBOUND;
        tt.set(key, { score: ttScore, flag: flag, depth: maxDepth - depth });
    }

    return bestScore;
}


// Worker State
let currentBoardData = null;
let currentDepth = 1;
let isPondering = false;

function toBitboards(board, size) {
    let xBoard = ZERO, oBoard = ZERO, bBoard = ZERO;
    for (let i = 0; i < size * size; i++) {
        if (board[i] === 'X') xBoard |= BIT[i];
        else if (board[i] === 'O') oBoard |= BIT[i];
        else if (board[i] === 'B') bBoard |= BIT[i];
    }
    return { xBoard, oBoard, bBoard };
}

// action: 'move' (place a mark), 'block' (fill an empty square), 'remove' (empty a filled square), or 'resign'
let activeSearchPlayer = 'O';
let activeSearchId = undefined;
function sendMove(move, action, score, resign) {
    postMessage({
        type: 'MOVE',
        searchId: activeSearchId,
        player: activeSearchPlayer,
        move: move,
        action: action || 'move',
        score: score !== undefined ? score : null,
        resign: Boolean(resign)
    });
}

// ============================================================================
// Multi-Player (2 to 5 Players: X, O, T, S, D) Bitboard Search Engine
// ============================================================================
let multiPlayerScores = {};
let multiHcMap = {};

// Compute how close each player is to winning on the board and their tournament 1st-place status,
// returning a per-opponent priority multiplier so the CPU focuses on stopping 1st place from winning.
function computeOpponentStopPriorities(pBoards, occAll, liveOrder, pMasks) {
    const me = liveOrder[0];
    const myTourneyScore = multiPlayerScores[me] || 0;
    let maxTourneyScore = 0;
    for (let i = 0; i < liveOrder.length; i++) {
        const sc = multiPlayerScores[liveOrder[i]] || 0;
        if (sc > maxTourneyScore) maxTourneyScore = sc;
    }

    let minOppNeed = Infinity;
    let maxOppBoardProgress = -1;
    let boardLeader = null;
    const oppStats = {};

    for (let idx = 1; idx < liveOrder.length; idx++) {
        const op = liveOrder[idx];
        const opBit = pBoards[op];
        const notOpOcc = occAll & ~opBit;
        const opMasks = pMasks[op] || [];
        const opHc = multiHcMap[op] || (opMasks.length > 0 ? popcount(opMasks[0]) : 4);
        let bestNeed = opHc;
        let openLines = 0;
        let maxCnt = 0;
        let twoAwayCount = 0;
        let oneAwayCount = 0;

        for (let i = 0; i < opMasks.length; i++) {
            const mk = opMasks[i];
            if ((notOpOcc & mk) === ZERO) {
                openLines++;
                const cnt = popcount(opBit & mk);
                if (cnt > maxCnt) maxCnt = cnt;
                const need = Math.max(1, opHc - cnt);
                if (need < bestNeed) bestNeed = need;
                if (need === 1) oneAwayCount++;
                else if (need === 2) twoAwayCount++;
            }
        }

        const effectiveNeed = openLines > 0 ? bestNeed : Infinity;
        const progressScore =
            openLines > 0
                ? (10 - effectiveNeed) * 1000 + oneAwayCount * 450 + twoAwayCount * 140 + openLines * 8 + (multiPlayerScores[op] || 0) * 0.5
                : -1;
        oppStats[op] = {
            need: effectiveNeed,
            maxCnt,
            openLines,
            oneAwayCount,
            twoAwayCount,
            progressScore,
            tourneyScore: multiPlayerScores[op] || 0
        };

        if (effectiveNeed < minOppNeed) minOppNeed = effectiveNeed;
        if (progressScore > maxOppBoardProgress) {
            maxOppBoardProgress = progressScore;
            boardLeader = op;
        }
    }

    const priorities = {};
    for (let idx = 1; idx < liveOrder.length; idx++) {
        const op = liveOrder[idx];
        const st = oppStats[op];
        let mult = idx === 1 ? 1.25 : idx === 2 ? 1.1 : 0.95;

        // Boost priority for the 1st-place player on the board (closest to their win requirement)
        if (op === boardLeader && st.openLines > 0) {
            mult += 0.45;
            if (st.need <= 2) mult += 0.45;
            if (st.oneAwayCount >= 1 || st.twoAwayCount >= 2) mult += 0.35;
        } else if (st.need < Infinity && st.need === minOppNeed && st.need <= 2) {
            mult += 0.35;
        }

        // Boost priority for the 1st-place player in the tournament standings based on their score lead
        if (maxTourneyScore > 0 && st.tourneyScore === maxTourneyScore && st.tourneyScore > myTourneyScore) {
            const leadAmount = st.tourneyScore - myTourneyScore;
            const leadBoost = Math.min(0.85, 0.3 + (leadAmount / Math.max(200, maxTourneyScore)) * 0.55);
            mult += leadBoost;
        }

        priorities[op] = mult;
    }

    return { priorities, boardLeader, minOppNeed, oppStats };
}

function evaluateMultiBoard(pBoards, bBoard, elimBoard, liveOrder, pMasks, blMap, rmMap) {
    const me = liveOrder[0];
    let occAll = bBoard | elimBoard;
    for (let i = 0; i < liveOrder.length; i++) {
        occAll |= pBoards[liveOrder[i]];
    }

    const myBl = blMap[me] || 0;
    const myRm = rmMap[me] || 0;
    let maxOppBl = 0;
    let maxOppRm = 0;
    for (let i = 1; i < liveOrder.length; i++) {
        const op = liveOrder[i];
        if ((blMap[op] || 0) > maxOppBl) maxOppBl = blMap[op] || 0;
        if ((rmMap[op] || 0) > maxOppRm) maxOppRm = rmMap[op] || 0;
    }

    let score = (myBl - maxOppBl) * BLOCK_VALUE + (myRm - maxOppRm) * REMOVE_VALUE;

    const myBit = pBoards[me];
    const notMeOcc = occAll & ~myBit;
    const myMasks = pMasks[me] || [];
    for (let i = 0; i < myMasks.length; i++) {
        const mk = myMasks[i];
        if ((notMeOcc & mk) === ZERO) {
            const cnt = popcount(myBit & mk);
            if (cnt > 0) score += Math.pow(10, cnt) * styleAggression;
        }
    }

    // Weight opponents by turn urgency AND by 1st-place status (closest to winning on board / tournament lead)
    const { priorities } = computeOpponentStopPriorities(pBoards, occAll, liveOrder, pMasks);
    for (let idx = 1; idx < liveOrder.length; idx++) {
        const op = liveOrder[idx];
        const opBit = pBoards[op];
        const notOpOcc = occAll & ~opBit;
        const opMasks = pMasks[op] || [];
        const urgency = (priorities[op] || 1.0) * (2.0 - styleAggression);
        for (let i = 0; i < opMasks.length; i++) {
            const mk = opMasks[i];
            if ((notOpOcc & mk) === ZERO) {
                const cnt = popcount(opBit & mk);
                if (cnt > 0) score -= Math.pow(10, cnt) * urgency;
            }
        }
    }

    return score;
}

function multiRemovalValue(sq, pBoards, bBoard, elimBoard, liveOrder, pMasks) {
    const me = liveOrder[0];
    const bit = BIT[sq];
    let occAll = bBoard | elimBoard;
    for (let i = 0; i < liveOrder.length; i++) occAll |= pBoards[liveOrder[i]];

    const { priorities } = computeOpponentStopPriorities(pBoards, occAll, liveOrder, pMasks);

    let v = 0;
    for (let idx = 1; idx < liveOrder.length; idx++) {
        const op = liveOrder[idx];
        const opBit = pBoards[op];
        if (opBit & bit) {
            const notOpOcc = occAll & ~opBit;
            const opMasks = pMasks[op] || [];
            const urgency = priorities[op] || (idx === 1 ? 1.3 : 1.0);
            for (let i = 0; i < opMasks.length; i++) {
                const mk = opMasks[i];
                if ((mk & bit) && !(mk & notOpOcc)) {
                    v += Math.pow(10, popcount(mk & opBit)) * urgency;
                }
            }
        }
    }

    const myBit = pBoards[me];
    const otherBlockers = (occAll & ~myBit) & ~bit;
    const myMasks = pMasks[me] || [];
    for (let i = 0; i < myMasks.length; i++) {
        const mk = myMasks[i];
        if ((mk & bit) && !(mk & otherBlockers)) {
            const myCnt = popcount(mk & myBit);
            if (myCnt > 0) v += Math.pow(10, myCnt);
        }
    }
    return v;
}

function multiRemovalCandidates(pBoards, bBoard, elimBoard, liveOrder, pMasks, size, limit, allowRemoveBlocks) {
    const me = liveOrder[0];
    let occAll = bBoard | elimBoard;
    for (let i = 0; i < liveOrder.length; i++) occAll |= pBoards[liveOrder[i]];
    let pool = occAll & ~pBoards[me];
    if (!allowRemoveBlocks) pool &= ~bBoard;

    const list = [];
    for (let i = 0; i < size * size; i++) {
        if (pool & BIT[i]) {
            const v = multiRemovalValue(i, pBoards, bBoard, elimBoard, liveOrder, pMasks);
            if (v > 0) {
                const jitter = v * (Math.random() - 0.5) * 0.25 + (Math.random() - 0.5) * 6;
                list.push({ sq: i, v: v + jitter });
            }
        }
    }
    list.sort((a, b) => b.v - a.v);
    const out = [];
    for (let i = 0; i < list.length && (limit === undefined || out.length < limit); i++) {
        out.push(list[i].sq);
    }
    return out;
}

function multiMinimax(pBoards, bBoard, elimBoard, size, turnIdx, depth, maxDepth, alpha, beta, liveOrder, pMasks, blMap, rmMap, canUseSpecial, allowRemoveBlocks) {
    if ((nodesCount++ & 1023) === 0) {
        if (Date.now() >= stopTime) shouldStopSearch = true;
    }
    if (shouldStopSearch) return 0;

    const nLive = liveOrder.length;
    const me = liveOrder[0];
    const curP = liveOrder[turnIdx];

    if (checkWinBitboard(pBoards[me], pMasks[me])) return 100000 - depth;
    for (let i = 1; i < nLive; i++) {
        const op = liveOrder[i];
        if (checkWinBitboard(pBoards[op], pMasks[op])) return -100000 + depth;
    }

    let occ = bBoard | elimBoard;
    for (let i = 0; i < nLive; i++) occ |= pBoards[liveOrder[i]];

    const fullMask = BIT[size * size] - ONE;
    const curRm = rmMap[curP] || 0;
    const curBl = blMap[curP] || 0;
    const removableOcc = (allowRemoveBlocks ? occ : (occ & ~bBoard)) & ~pBoards[curP];
    const boardFull = (occ & fullMask) === fullMask;
    if (boardFull && (curRm === 0 || !canUseSpecial || removableOcc === ZERO)) return 0;

    // Immediate win check for current mover
    const curWins = winSquares(pBoards[curP], pMasks[curP], occ);
    if (curWins !== ZERO) {
        return curP === me ? 100000 - (depth + 1) : -100000 + (depth + 1);
    }
    if (canUseSpecial && curRm > 0 && blockedWinSquares(pBoards[curP], pMasks[curP], removableOcc) !== ZERO) {
        return curP === me ? 100000 - (depth + 1) : -100000 + (depth + 1);
    }

    if (depth >= maxDepth) {
        return evaluateMultiBoard(pBoards, bBoard, elimBoard, liveOrder, pMasks, blMap, rmMap);
    }

    // Check if the NEXT player in turn order has an immediate win threat
    const nextIdx = (turnIdx + 1) % nLive;
    const nextP = liveOrder[nextIdx];
    const nextW = winSquares(pBoards[nextP], pMasks[nextP], occ);

    let availableMoves = [];
    if (nextW !== ZERO) {
        let t = nextW;
        while (t !== ZERO) {
            const sq = lowIdx(t);
            availableMoves.push(sq);
            t ^= BIT[sq];
        }
        shuffleInPlace(availableMoves);
    } else {
        for (let i = 0; i < size * size; i++) {
            if (!(occ & BIT[i])) availableMoves.push(i);
        }
        const center = (size - 1) / 2;
        const scores = {};
        const curMasks = pMasks[curP] || [];
        const notCurOcc = occ & ~pBoards[curP];
        const { priorities } = computeOpponentStopPriorities(pBoards, occ, liveOrder, pMasks);
        for (const m of availableMoves) {
            const bit = BIT[m];
            const nOcc = occ | bit;
            let s = (Math.random() - 0.5) * 35;
            const myT = popcount(winSquares(pBoards[curP] | bit, curMasks, nOcc));
            if (myT >= 2) s += 20000;
            else if (myT === 1) s += 3000;
            for (let i = 0; i < curMasks.length; i++) {
                const mk = curMasks[i];
                if ((mk & bit) && (mk & notCurOcc) === ZERO) {
                    s += (popcount(mk & pBoards[curP]) + 1) * 14;
                }
            }
            for (let k = 1; k < nLive; k++) {
                const otherP = liveOrder[(turnIdx + k) % nLive];
                const stopWeight = priorities[otherP] || 1.0;
                const oT = popcount(winSquares(pBoards[otherP] | bit, pMasks[otherP], nOcc));
                if (oT >= 2) s += 10000 * stopWeight;
                else if (oT === 1) s += 1500 * stopWeight;
            }
            const r = Math.floor(m / size);
            const c = m % size;
            const dist = Math.abs(r - center) + Math.abs(c - center);
            s += Math.max(0, (size - dist) * 12);
            scores[m] = s;
        }
        availableMoves.sort((a, b) => scores[b] - scores[a]);
        if (availableMoves.length > 10) {
            availableMoves = availableMoves.slice(0, 10);
        }
    }

    if (turnIdx === 0) {
        let bestScore = -Infinity;
        for (let i = 0; i < availableMoves.length; i++) {
            const m = availableMoves[i];
            const bit = BIT[m];
            const nextBoards = { ...pBoards, [me]: pBoards[me] | bit };
            const score = multiMinimax(nextBoards, bBoard, elimBoard, size, nextIdx, depth + 1, maxDepth, alpha, beta, liveOrder, pMasks, blMap, rmMap, true, allowRemoveBlocks);
            if (shouldStopSearch) return 0;
            if (score > bestScore) bestScore = score;
            if (bestScore > alpha) alpha = bestScore;
            if (beta <= alpha) break;

            if (canUseSpecial && curBl > 0) {
                const nextBl = { ...blMap, [me]: curBl - 1 };
                const bScore = multiMinimax(pBoards, bBoard | bit, elimBoard, size, 0, depth, maxDepth, alpha, beta, liveOrder, pMasks, nextBl, rmMap, false, allowRemoveBlocks);
                if (shouldStopSearch) return 0;
                if (bScore > bestScore) bestScore = bScore;
                if (bestScore > alpha) alpha = bestScore;
                if (beta <= alpha) break;
            }
        }
        return bestScore;
    } else {
        let bestScore = Infinity;
        for (let i = 0; i < availableMoves.length; i++) {
            const m = availableMoves[i];
            const bit = BIT[m];
            const nextBoards = { ...pBoards, [curP]: pBoards[curP] | bit };
            const score = multiMinimax(nextBoards, bBoard, elimBoard, size, nextIdx, depth + 1, maxDepth, alpha, beta, liveOrder, pMasks, blMap, rmMap, true, allowRemoveBlocks);
            if (shouldStopSearch) return 0;
            if (score < bestScore) bestScore = score;
            if (bestScore < beta) beta = bestScore;
            if (beta <= alpha) break;
        }
        return bestScore;
    }
}

function runMultiPlayerSearch(msg) {
    const { board, size, timeLimit } = msg;
    const allowRemoveBlocks = msg.allowRemoveBlocks !== false;
    const me = msg.player || 'O';
    activeSearchPlayer = me;

    const allActive = Array.isArray(msg.activePlayers) && msg.activePlayers.length >= 2
        ? msg.activePlayers
        : ['X', 'O'];
    const elimSet = new Set(msg.eliminatedPlayers || []);
    const livePlayers = allActive.filter((p) => !elimSet.has(p));
    const meIdx = Math.max(0, livePlayers.indexOf(me));
    const liveOrder = [];
    for (let i = 0; i < livePlayers.length; i++) {
        liveOrder.push(livePlayers[(meIdx + i) % livePlayers.length]);
    }

    const pBoards = {};
    for (const p of liveOrder) pBoards[p] = ZERO;
    let bBoard = ZERO;
    let elimBoard = ZERO;

    for (let i = 0; i < size * size; i++) {
        const v = board[i];
        if (!v) continue;
        if (v === 'B') bBoard |= BIT[i];
        else if (pBoards[v] !== undefined) pBoards[v] |= BIT[i];
        else elimBoard |= BIT[i];
    }

    const hcMap = msg.handicaps || { X: msg.xhc || size, O: msg.ohc || size };
    const blMap = msg.blocks || { X: msg.xbl || 0, O: msg.obl || 0 };
    const rmMap = msg.removes || { X: msg.xrm || 0, O: msg.orm || 0 };
    const ignoredMap = msg.ignoredWinLines || { X: msg.ignoredXLines || [], O: msg.ignoredOLines || [] };
    multiHcMap = hcMap;
    multiPlayerScores = msg.playerScores || {};

    const pMasks = {};
    for (const p of liveOrder) {
        pMasks[p] = getFilteredWinMasks(size, hcMap[p] || size, ignoredMap[p] || []);
    }

    let occAll = bBoard | elimBoard;
    for (const p of liveOrder) occAll |= pBoards[p];
    const removableOcc = (allowRemoveBlocks ? occAll : (occAll & ~bBoard)) & ~pBoards[me];
    const myBl = blMap[me] || 0;
    const myRm = rmMap[me] || 0;

    // 1. Immediate win for `me`
    const myImmMask = winSquares(pBoards[me], pMasks[me], occAll);
    if (myImmMask !== ZERO) {
        sendMove(pickRandomBit(myImmMask), 'move', 100000, false);
        return;
    }
    if (myRm > 0) {
        const bw = blockedWinSquares(pBoards[me], pMasks[me], removableOcc);
        if (bw !== ZERO) {
            sendMove(pickRandomBit(bw), 'remove', 100000, false);
            return;
        }
    }

    // 2. Check urgent opponent threats, prioritizing the next mover if they have an immediate win,
    //    and otherwise prioritizing the 1st-place player (closest to winning / tournament leader)
    const { priorities: oppStopPriorities, boardLeader } = computeOpponentStopPriorities(pBoards, occAll, liveOrder, pMasks);
    const oppOrder = liveOrder.slice(1).sort((a, b) => {
        const aTurnIdx = liveOrder.indexOf(a);
        const bTurnIdx = liveOrder.indexOf(b);
        const aHasImm =
            winSquares(pBoards[a], pMasks[a], occAll) !== ZERO ||
            ((rmMap[a] || 0) > 0 && blockedWinSquares(pBoards[a], pMasks[a], (allowRemoveBlocks ? occAll : (occAll & ~bBoard)) & ~pBoards[a]) !== ZERO);
        const bHasImm =
            winSquares(pBoards[b], pMasks[b], occAll) !== ZERO ||
            ((rmMap[b] || 0) > 0 && blockedWinSquares(pBoards[b], pMasks[b], (allowRemoveBlocks ? occAll : (occAll & ~bBoard)) & ~pBoards[b]) !== ZERO);
        if (aHasImm && !bHasImm) return -1;
        if (!aHasImm && bHasImm) return 1;
        if (aTurnIdx === 1 && aHasImm) return -1;
        if (bTurnIdx === 1 && bHasImm) return 1;
        return (oppStopPriorities[b] || 1.0) - (oppStopPriorities[a] || 1.0);
    });

    for (let idx = 0; idx < oppOrder.length; idx++) {
        const opp = oppOrder[idx];
        const isFirstPlaceOpp = opp === boardLeader || (oppStopPriorities[opp] || 1.0) >= 1.5;
        const oppW = winSquares(pBoards[opp], pMasks[opp], occAll);
        const oppRm = rmMap[opp] || 0;
        const oppRemOcc = (allowRemoveBlocks ? occAll : (occAll & ~bBoard)) & ~pBoards[opp];
        const oppBlockedW = oppRm > 0 ? blockedWinSquares(pBoards[opp], pMasks[opp], oppRemOcc) : ZERO;

        if (oppW !== ZERO || oppBlockedW !== ZERO) {
            const threatCount = popcount(oppW);
            // Best way to stop 1st place from winning: if they have a double threat, a remove-win threat,
            // or are 1st place with an open threat, use a remove to dismantle their threat line directly
            if (myRm > 0 && (threatCount > 1 || oppBlockedW !== ZERO || (threatCount === 1 && (isFirstPlaceOpp ? Math.random() < 0.55 : Math.random() < 0.25)))) {
                const stones = threatStones(pBoards[opp], pMasks[opp], oppW | oppBlockedW);
                if (stones !== ZERO) {
                    sendMove(pickRandomBit(stones), 'remove', null, false);
                    return;
                }
            }
            if (oppW !== ZERO) {
                // Pick among the threat squares that block 1st place / opponent threats and help `me`
                let bestSq = pickRandomBit(oppW);
                let bestVal = -Infinity;
                let t = oppW;
                while (t !== ZERO) {
                    const sq = lowIdx(t);
                    t ^= BIT[sq];
                    const nextBoards = { ...pBoards, [me]: pBoards[me] | BIT[sq] };
                    const v = evaluateMultiBoard(nextBoards, bBoard, elimBoard, liveOrder, pMasks, blMap, rmMap) + (Math.random() - 0.5) * 35;
                    if (v > bestVal) {
                        bestVal = v;
                        bestSq = sq;
                    }
                }
                const useBlock = myBl > 0 && (threatCount > 1 || (!allowRemoveBlocks && oppRm > 0) || (isFirstPlaceOpp && oppRm === 0 && Math.random() < 0.4) || Math.random() < 0.22);
                sendMove(bestSq, useBlock ? 'block' : 'move', null, false);
                return;
            }
        }
    }

    // 3. Iterative Deepening Multi-Player Search
    let availableMoves = [];
    for (let i = 0; i < size * size; i++) {
        if (!(occAll & BIT[i])) availableMoves.push(i);
    }
    const myWinMasks = pMasks[me] || [];
    const posWeight = (sq) => {
        const bit = BIT[sq];
        let w = 0;
        for (let i = 0; i < myWinMasks.length; i++) if (myWinMasks[i] & bit) w++;
        return w;
    };
    const rootOrderJitter = {};
    for (let i = 0; i < availableMoves.length; i++) {
        rootOrderJitter[availableMoves[i]] = (Math.random() - 0.5) * 2.6;
    }
    availableMoves.sort((a, b) => (posWeight(b) + rootOrderJitter[b]) - (posWeight(a) + rootOrderJitter[a]));

    const rootRemoves = myRm > 0
        ? multiRemovalCandidates(pBoards, bBoard, elimBoard, liveOrder, pMasks, size, TREE_REMOVE_LIMIT, allowRemoveBlocks)
        : [];

    if (availableMoves.length === 0) {
        if (rootRemoves.length > 0) sendMove(rootRemoves[Math.floor(Math.random() * Math.min(2, rootRemoves.length))], 'remove', 0, false);
        else sendMove(-1, 'move', 0, false);
        return;
    }

    stopTime = Date.now() + (timeLimit || 1000);
    shouldStopSearch = false;
    nodesCount = 0;

    let localBestMove = availableMoves[0];
    let localBestAction = 'move';
    let localBestScore = null;
    let completedCandidates = [];
    const maxSearchDepth = Math.min(8, Math.max(1, availableMoves.length));
    const rootMargin = 60;

    for (let depth = 1; depth <= maxSearchDepth && Date.now() < stopTime; depth++) {
        let bestScore = -Infinity;
        let tempBestMove = -1;
        let tempBestAction = 'move';
        let iterCandidates = [];

        for (let i = 0; i < availableMoves.length; i++) {
            const m = availableMoves[i];
            const bit = BIT[m];
            const nextBoards = { ...pBoards, [me]: pBoards[me] | bit };
            const searchAlpha = bestScore > -50000 && bestScore < 50000 ? bestScore - rootMargin : bestScore;
            const score = multiMinimax(
                nextBoards, bBoard, elimBoard, size,
                1 % liveOrder.length, 1, depth,
                searchAlpha, Infinity,
                liveOrder, pMasks, blMap, rmMap, true, allowRemoveBlocks
            );
            if (shouldStopSearch) break;
            iterCandidates.push({ move: m, action: 'move', score });
            if (score > bestScore) {
                bestScore = score;
                tempBestMove = m;
                tempBestAction = 'move';
            }
            if (myBl > 0) {
                const nextBl = { ...blMap, [me]: myBl - 1 };
                const bAlpha = bestScore > -50000 && bestScore < 50000 ? bestScore - rootMargin : bestScore;
                const bScore = multiMinimax(
                    pBoards, bBoard | bit, elimBoard, size,
                    0, 0, depth,
                    bAlpha, Infinity,
                    liveOrder, pMasks, nextBl, rmMap, false, allowRemoveBlocks
                );
                if (shouldStopSearch) break;
                iterCandidates.push({ move: m, action: 'block', score: bScore });
                if (bScore > bestScore) {
                    bestScore = bScore;
                    tempBestMove = m;
                    tempBestAction = 'block';
                }
            }
        }

        for (let i = 0; i < rootRemoves.length && !shouldStopSearch; i++) {
            const s = rootRemoves[i];
            const rBit = BIT[s];
            const nextBoards = {};
            for (const p of liveOrder) nextBoards[p] = pBoards[p] & ~rBit;
            const nextRm = { ...rmMap, [me]: myRm - 1 };
            const rAlpha = bestScore > -50000 && bestScore < 50000 ? bestScore - rootMargin : bestScore;
            const rScore = multiMinimax(
                nextBoards, bBoard & ~rBit, elimBoard & ~rBit, size,
                0, 0, depth,
                rAlpha, Infinity,
                liveOrder, pMasks, blMap, nextRm, false, allowRemoveBlocks
            );
            if (shouldStopSearch) break;
            iterCandidates.push({ move: s, action: 'remove', score: rScore });
            if (rScore > bestScore) {
                bestScore = rScore;
                tempBestMove = s;
                tempBestAction = 'remove';
            }
        }

        if (!shouldStopSearch && tempBestMove !== -1) {
            localBestMove = tempBestMove;
            localBestAction = tempBestAction;
            localBestScore = bestScore;
            completedCandidates = iterCandidates;
            if (tempBestAction === 'move') {
                const idx = availableMoves.indexOf(localBestMove);
                if (idx > 0) {
                    availableMoves.splice(idx, 1);
                    availableMoves.unshift(localBestMove);
                }
            }
        }
    }

    const filledCount = popcount(occAll);
    if (localBestScore !== null && localBestScore <= -50000 && filledCount >= Math.max(3, size - 1) && Math.random() < 0.88) {
        sendMove(-1, 'resign', localBestScore, true);
        return;
    }

    if (completedCandidates.length > 1 && localBestScore !== null && Math.abs(localBestScore) < 50000) {
        const baseTol = filledCount <= liveOrder.length ? 45 : 32;
        const tolerance = Math.min(65, Math.max(baseTol, Math.abs(localBestScore) * 0.14));
        const nearBest = completedCandidates.filter((c) => c.score >= localBestScore - tolerance);
        if (nearBest.length > 1) {
            let bestNoisy = -Infinity;
            for (const c of nearBest) {
                const noisy = c.score + (Math.random() - 0.5) * tolerance * 1.45;
                if (noisy > bestNoisy) {
                    bestNoisy = noisy;
                    localBestMove = c.move;
                    localBestAction = c.action;
                    localBestScore = c.score;
                }
            }
        }
    }

    sendMove(localBestMove, localBestAction, localBestScore, false);
}

onmessage = function(e) {
    let msg = e.data;
    if (msg.type === 'START_SEARCH') {
        isPondering = false;
        activeSearchId = msg.searchId;
        activeSearchPlayer = msg.player || (msg.isO !== false ? 'O' : 'X');
        sampleTurnStyle();
        const activeList = Array.isArray(msg.activePlayers) ? msg.activePlayers : ['X', 'O'];
        const elimList = Array.isArray(msg.eliminatedPlayers) ? msg.eliminatedPlayers : [];
        const liveList = activeList.filter((p) => !elimList.includes(p));
        const hasExtraSymbols = msg.board && msg.board.some((c) => c && c !== 'X' && c !== 'O' && c !== 'B');
        if (liveList.length > 2 || hasExtraSymbols || (activeSearchPlayer !== 'X' && activeSearchPlayer !== 'O')) {
            runMultiPlayerSearch(msg);
            return;
        }
        let { board, size, xhc, ohc, xbl, obl, timeLimit, isO } = msg;
        let xrm = msg.xrm || 0, orm = msg.orm || 0;
        let allowRemoveBlocks = msg.allowRemoveBlocks !== false;

        // Convert board to bitboards
        let { xBoard, oBoard, bBoard } = toBitboards(board, size);

        let ignoredX = msg.ignoredXLines || [];
        let ignoredO = msg.ignoredOLines || [];
        hasActiveIgnoredLines = (ignoredX.length > 0 || ignoredO.length > 0);

        let xWinMasks = getFilteredWinMasks(size, xhc, ignoredX);
        let oWinMasks = getFilteredWinMasks(size, ohc, ignoredO);

        // Iterative deepening
        stopTime = Date.now() + timeLimit;
        vcfHardDeadline = Date.now() + timeLimit;
        shouldStopSearch = false;
        nodesCount = 0;
        let depth = 1;
        let localBestMove = -1;
        let localBestAction = 'move';
        let localBestScore = null;

        const meBoard = isO ? oBoard : xBoard;
        const oppBoard = isO ? xBoard : oBoard;
        const meMasks = isO ? oWinMasks : xWinMasks;
        const oppMasks = isO ? xWinMasks : oWinMasks;
        const oppHc = isO ? xhc : ohc;
        const myBl = isO ? obl : xbl;
        const myRm = isO ? orm : xrm;
        const oppRm = isO ? xrm : orm;
        const occAll = xBoard | oBoard | bBoard;
        const removableOcc = allowRemoveBlocks ? occAll : (xBoard | oBoard);
        const filledCount = popcount(occAll);

        // Find available moves, ordered by positional strength (with a small random tie-breaker)
        let availableMoves = [];
        for (let i = 0; i < size*size; i++) {
            if (!(occAll & BIT[i])) availableMoves.push(i);
        }
        const posWeight = (sq) => {
            const bit = BIT[sq];
            let w = 0;
            for (let i = 0; i < oWinMasks.length; i++) if (oWinMasks[i] & bit) w++;
            return w;
        };
        const rootOrderJitter = {};
        for (let i = 0; i < availableMoves.length; i++) {
            rootOrderJitter[availableMoves[i]] = (Math.random() - 0.5) * 2.4;
        }
        availableMoves.sort((a, b) => (posWeight(b) + rootOrderJitter[b]) - (posWeight(a) + rootOrderJitter[a]));
        // Removable squares at the root (most valuable first).
        const rootRemoves = myRm > 0
            ? removalCandidates(oppBoard, meBoard, bBoard, oppMasks, meMasks, size, undefined, undefined, allowRemoveBlocks)
            : [];

        if (availableMoves.length === 0) {
            // Board is full: the only legal action is a remove (if any are left).
            if (rootRemoves.length > 0) sendMove(rootRemoves[Math.floor(Math.random() * Math.min(2, rootRemoves.length))], 'remove', 0, false);
            else sendMove(-1, 'move', 0, false);
            return;
        }

        // ---- Tactical pre-search (the side to move is O when isO, else X) ----
        let allMovesRefutedByVcf = false;
        {
            const winsFor = (mine, masks, occ) => {
                let res = [];
                for (let i = 0; i < size * size; i++) {
                    let bit = BIT[i];
                    if (!(occ & bit) && checkWinBitboard(mine | bit, masks)) res.push(i);
                }
                return res;
            };

            // 1. Win immediately if possible (either on an empty square, or by removing the single
            //    removable blocker on our completed line so we can play there on the next action of this turn).
            let myWins = winsFor(meBoard, meMasks, occAll);
            if (myWins.length > 0) {
                const chosenWin = myWins[Math.floor(Math.random() * myWins.length)];
                sendMove(chosenWin, 'move', isO ? 100000 : -100000, false);
                return;
            }
            if (myRm > 0) {
                const bw = blockedWinSquares(meBoard, meMasks, removableOcc);
                if (bw !== ZERO) {
                    sendMove(pickRandomBit(bw), 'remove', isO ? 100000 : -100000, false);
                    return;
                }
            }

            // 2. Opponent threatens to win next move: must defend.
            let oppWins = winsFor(oppBoard, oppMasks, occAll);
            // If the opponent has a remove, any line where they already have (oppHc - 1) stones and
            // the last square is occupied by a removable piece is ALSO a next-turn win threat for them.
            const oppBlockedWins = oppRm > 0 ? blockedWinSquares(oppBoard, oppMasks, removableOcc) : ZERO;
            if (oppWins.length === 1 && oppBlockedWins === ZERO && oppRm === 0) {
                if (myRm > 0 && Math.random() < 0.25) {
                    const stones = threatStones(oppBoard, oppMasks, BIT[oppWins[0]]);
                    if (stones !== ZERO) {
                        sendMove(pickRandomBit(stones), 'remove', null, false);
                        return;
                    }
                }
                const useBlock = myBl > 0 && Math.random() < 0.2;
                sendMove(oppWins[0], useBlock ? 'block' : 'move', null, false);
                return;
            }
            if (oppWins.length > 1 || (oppWins.length >= 1 && oppRm > 0) || oppBlockedWins !== ZERO) {
                // Facing a double threat (or a threat backed by an opponent remove). Removing an
                // opponent stone that participates in the threat can break it while keeping our turn.
                if (myRm > 0) {
                    let threatSq = oppBlockedWins;
                    for (const m of oppWins) threatSq |= BIT[m];
                    const stones = threatStones(oppBoard, oppMasks, threatSq);
                    let bestS = -1, bestLeft = Infinity;
                    let t = stones;
                    while (t !== ZERO) {
                        const s = lowIdx(t); t ^= BIT[s];
                        const nOpp = oppBoard ^ BIT[s], nOcc = occAll ^ BIT[s];
                        const nRemOcc = allowRemoveBlocks ? nOcc : (nOcc & ~bBoard);
                        const left = popcount(winSquares(nOpp, oppMasks, nOcc))
                                   + (oppRm > 0 ? popcount(blockedWinSquares(nOpp, oppMasks, nRemOcc)) : 0);
                        if (left < bestLeft || (left === bestLeft && Math.random() < 0.5)) { bestLeft = left; bestS = s; }
                    }
                    if (bestS !== -1 && bestLeft === 0) {
                        sendMove(bestS, 'remove', null, false);
                        return;
                    }
                    if (bestS !== -1 && oppWins.length > 1 && bestLeft <= 1) {
                        sendMove(bestS, 'remove', null, false);
                        return;
                    }
                }
                if (oppWins.length === 1) {
                    // When blocks are unremovable and the opponent has a remove, plugging the threat
                    // square with a block stops them from removing our piece on their turn.
                    const useBlock = myBl > 0 && ((!allowRemoveBlocks && oppRm > 0) || Math.random() < 0.22);
                    sendMove(oppWins[0], useBlock ? 'block' : 'move', null, false);
                    return;
                }
                if (oppWins.length > 1) {
                    // If we cannot stop all winning squares even with our blocks/removes, opponent has an unstoppable win next turn!
                    const canStopAllWithBlocks = myBl >= oppWins.length - 1;
                    if (!canStopAllWithBlocks && filledCount >= Math.max(3, size - 1) && Math.random() < 0.94) {
                        sendMove(-1, 'resign', isO ? -99999 : 99999, true);
                        return;
                    }
                    // Otherwise take (or block) the most valuable winning square.
                    let bestM = oppWins[0], bestV = -Infinity;
                    for (const m of oppWins) {
                        let nx = isO ? xBoard : xBoard | BIT[m];
                        let no = isO ? oBoard | BIT[m] : oBoard;
                        let v = evaluateBoard(nx, no, bBoard, xWinMasks, oWinMasks, xbl, obl, xrm, orm) + (Math.random() - 0.5) * 35;
                        if (!isO) v = -v;
                        if (v > bestV) { bestV = v; bestM = m; }
                    }
                    sendMove(bestM, myBl > 0 ? 'block' : 'move', isO ? -95000 : 95000, false);
                    return;
                }
            }

            // 3. Attack: forced win via a chain of threats ending in a double?
            vcfNodes = 0;
            vcfAborted = false;
            let atk = vcfSearch(meBoard, oppBoard, meMasks, oppMasks, occAll, size, 8);
            if (atk === -1) {
                // ...or via one/two quiet setup moves that each threaten such a chain.
                vctDeadline = Date.now() + timeLimit * FORCE_ATTACK_SHARE;
                atk = vctSearch(meBoard, oppBoard, meMasks, oppMasks, occAll, size, FORCE_ATTACK_DEPTH);
            }
            if (atk !== -1) {
                sendMove(atk, 'move', isO ? 90000 : -90000, false);
                return;
            }

            // 4. Defend: drop any move after which the opponent has a forced win.
            const afterMove = (m) => ({ nMe: meBoard | BIT[m], occ1: occAll | BIT[m] });
            const stageADeadline = Date.now() + timeLimit * FORCE_DEFENCE_SHARE * 0.5;
            const stageAVerified = [];
            const stageAUnchecked = [];
            for (const m of availableMoves) {
                if (Date.now() > stageADeadline) { stageAUnchecked.push(m); continue; }
                const { nMe, occ1 } = afterMove(m);
                vcfNodes = 0;
                vcfAborted = false;
                if (vcfSearch(oppBoard, nMe, oppMasks, meMasks, occ1, size, 8) === -1) stageAVerified.push(m);
            }
            if (stageAVerified.length === 0 && stageAUnchecked.length === 0 && myBl === 0 && myRm === 0) {
                allMovesRefutedByVcf = true;
            }
            let safe = stageAVerified.length > 0 ? stageAVerified.concat(stageAUnchecked) : availableMoves;
            //    Stage B (deeper, time-boxed): the opponent plays a quiet setup move that threatens a chain
            //    and no reply stops it.
            const oppStones = popcount(oppBoard);
            if (safe.length > 1 && oppStones >= 2 && oppStones + FORCE_DEFENCE_DEPTH >= oppHc - 2) {
                vctDeadline = Date.now() + timeLimit * FORCE_DEFENCE_SHARE;
                const stageBVerified = [];
                const stageBUnchecked = [];
                for (const m of safe) {
                    if (Date.now() > vctDeadline) { stageBUnchecked.push(m); continue; }
                    const { nMe, occ1 } = afterMove(m);
                    if (vctSearch(oppBoard, nMe, oppMasks, meMasks, occ1, size, FORCE_DEFENCE_DEPTH) === -1) stageBVerified.push(m);
                }
                if (stageBVerified.length > 0) safe = stageBVerified.concat(stageBUnchecked);
            }
            if (safe.length > 0 && safe.length < availableMoves.length) {
                availableMoves = safe;
            }
        }
        // The regular search keeps a smaller floor of the time budget; the forcing search matters more.
        stopTime = Math.max(stopTime, Date.now() + timeLimit * REGULAR_SEARCH_FLOOR);

        const emptyCount = size * size - popcount(occAll);
        const maxSearchDepth = Math.max(1, emptyCount);
        const rootMargin = 35;
        let completedCandidates = [];

        while (Date.now() < stopTime && depth <= maxSearchDepth) {
            let bestScore = isO ? -Infinity : Infinity;
            let tempBestMove = -1;
            let tempBestAction = 'move';
            let iterCandidates = [];

            for (let i = 0; i < availableMoves.length; i++) {
                let m = availableMoves[i];
                let bit = BIT[m];
                let score = 0;

                if (isO) {
                    const searchAlpha = bestScore > -50000 && bestScore < 50000 ? bestScore - rootMargin : bestScore;
                    score = minimax(xBoard, oBoard | bit, bBoard, size, 1, depth, false, searchAlpha, Infinity, xWinMasks, oWinMasks, xbl, obl, xrm, orm, true, allowRemoveBlocks);
                    if (shouldStopSearch) break;
                    iterCandidates.push({ move: m, action: 'move', score });
                    if (score > bestScore) {
                        bestScore = score;
                        tempBestMove = m;
                        tempBestAction = 'move';
                    }
                    if (obl > 0) {
                        const bAlpha = bestScore > -50000 && bestScore < 50000 ? bestScore - rootMargin : bestScore;
                        let bScore = minimax(xBoard, oBoard, bBoard | bit, size, 0, depth, true, bAlpha, Infinity, xWinMasks, oWinMasks, xbl, obl - 1, xrm, orm, false, allowRemoveBlocks);
                        if (shouldStopSearch) break;
                        iterCandidates.push({ move: m, action: 'block', score: bScore });
                        if (bScore > bestScore) {
                            bestScore = bScore;
                            tempBestMove = m;
                            tempBestAction = 'block';
                        }
                    }
                } else {
                    const searchBeta = bestScore > -50000 && bestScore < 50000 ? bestScore + rootMargin : bestScore;
                    score = minimax(xBoard | bit, oBoard, bBoard, size, 1, depth, true, -Infinity, searchBeta, xWinMasks, oWinMasks, xbl, obl, xrm, orm, true, allowRemoveBlocks);
                    if (shouldStopSearch) break;
                    iterCandidates.push({ move: m, action: 'move', score });
                    if (score < bestScore) {
                        bestScore = score;
                        tempBestMove = m;
                        tempBestAction = 'move';
                    }
                    if (xbl > 0) {
                        const bBeta = bestScore > -50000 && bestScore < 50000 ? bestScore + rootMargin : bestScore;
                        let bScore = minimax(xBoard, oBoard, bBoard | bit, size, 0, depth, false, -Infinity, bBeta, xWinMasks, oWinMasks, xbl - 1, obl, xrm, orm, false, allowRemoveBlocks);
                        if (shouldStopSearch) break;
                        iterCandidates.push({ move: m, action: 'block', score: bScore });
                        if (bScore < bestScore) {
                            bestScore = bScore;
                            tempBestMove = m;
                            tempBestAction = 'block';
                        }
                    }
                }
            }
            // Removal options: empty a square, then the same player makes their normal placement in the
            // same turn (depth 0 with canUseSpecial = false).
            for (let i = 0; i < rootRemoves.length && !shouldStopSearch; i++) {
                const s = rootRemoves[i];
                const rBit = BIT[s];
                if (isO) {
                    const rAlpha = bestScore > -50000 && bestScore < 50000 ? bestScore - rootMargin : bestScore;
                    const rScore = minimax(xBoard & ~rBit, oBoard & ~rBit, bBoard & ~rBit, size, 0, depth, true, rAlpha, Infinity, xWinMasks, oWinMasks, xbl, obl, xrm, orm - 1, false, allowRemoveBlocks);
                    if (shouldStopSearch) break;
                    iterCandidates.push({ move: s, action: 'remove', score: rScore });
                    if (rScore > bestScore) { bestScore = rScore; tempBestMove = s; tempBestAction = 'remove'; }
                } else {
                    const rBeta = bestScore > -50000 && bestScore < 50000 ? bestScore + rootMargin : bestScore;
                    const rScore = minimax(xBoard & ~rBit, oBoard & ~rBit, bBoard & ~rBit, size, 0, depth, false, -Infinity, rBeta, xWinMasks, oWinMasks, xbl, obl, xrm - 1, orm, false, allowRemoveBlocks);
                    if (shouldStopSearch) break;
                    iterCandidates.push({ move: s, action: 'remove', score: rScore });
                    if (rScore < bestScore) { bestScore = rScore; tempBestMove = s; tempBestAction = 'remove'; }
                }
            }
            if (!shouldStopSearch && tempBestMove !== -1) {
                localBestMove = tempBestMove;
                localBestAction = tempBestAction;
                localBestScore = bestScore;
                completedCandidates = iterCandidates;
                // Move the best move to the front for the next iteration (PV ordering)
                const list = tempBestAction === 'remove' ? rootRemoves : availableMoves;
                let idx = list.indexOf(localBestMove);
                if (idx > 0) {
                    list.splice(idx, 1);
                    list.unshift(localBestMove);
                }
            }
            depth++;
        }

        // Check if CPU is in a forced loss and should resign
        const isLostPosition =
            allMovesRefutedByVcf ||
            (localBestScore !== null && (isO ? localBestScore <= -50000 : localBestScore >= 50000));
        if (isLostPosition && filledCount >= Math.max(3, size - 1) && Math.random() < 0.92) {
            sendMove(-1, 'resign', localBestScore !== null ? localBestScore : (isO ? -90000 : 90000), true);
            return;
        }

        // Apply randomness among top candidates so CPU decisions feel dynamic and varied
        if (completedCandidates.length > 1 && localBestScore !== null && Math.abs(localBestScore) < 50000) {
            const baseTol = filledCount <= 2 ? 42 : 28;
            const tolerance = Math.min(60, Math.max(baseTol, Math.abs(localBestScore) * 0.12));
            const nearBest = completedCandidates.filter((c) =>
                isO ? c.score >= localBestScore - tolerance : c.score <= localBestScore + tolerance
            );
            if (nearBest.length > 1) {
                let bestNoisy = isO ? -Infinity : Infinity;
                for (const c of nearBest) {
                    const noisy = c.score + (Math.random() - 0.5) * tolerance * 1.4;
                    if ((isO && noisy > bestNoisy) || (!isO && noisy < bestNoisy)) {
                        bestNoisy = noisy;
                        localBestMove = c.move;
                        localBestAction = c.action;
                        localBestScore = c.score;
                    }
                }
            }
        }

        if (localBestMove === -1 && availableMoves.length > 0) {
            localBestMove = availableMoves[Math.floor(Math.random() * availableMoves.length)];
            localBestAction = 'move';
        }

        sendMove(localBestMove, localBestAction, localBestScore, false);
    } else if (msg.type === 'START_PONDER') {
        currentBoardData = msg;
        isPondering = true;
        currentDepth = 1;
        ponderMoveIdx = 0;
        ponderVctDepth = 1;
        ponderLoop();
    } else if (msg.type === 'STOP_PONDER') {
        isPondering = false;
        shouldStopSearch = true;
    } else if (msg.type === 'CLEAR_TT') {
        tt.clear();
        forceTT.clear();
    }
}

let ponderMoveIdx = 0;
let ponderVctDepth = 1;

function ponderLoop() {
    if (!isPondering) return;

    let { board, size, xhc, ohc, xbl, obl } = currentBoardData;
    let xrm = currentBoardData.xrm || 0, orm = currentBoardData.orm || 0;
    let allowRemoveBlocks = currentBoardData.allowRemoveBlocks !== false;
    let ignoredX = currentBoardData.ignoredXLines || [];
    let ignoredO = currentBoardData.ignoredOLines || [];
    hasActiveIgnoredLines = (ignoredX.length > 0 || ignoredO.length > 0);
    let { xBoard, oBoard, bBoard } = toBitboards(board, size);
    let occ = xBoard | oBoard | bBoard;
    let xWinMasks = getFilteredWinMasks(size, xhc, ignoredX);
    let oWinMasks = getFilteredWinMasks(size, ohc, ignoredO);

    // 1. Ponder forcing sequences first across candidate X moves (in 150ms slices)
    let empties = [];
    for (let i = 0; i < size * size; i++) {
        if (!(occ & BIT[i])) empties.push(i);
    }
    if (ponderVctDepth <= FORCE_DEFENCE_DEPTH && empties.length > 0) {
        vctDeadline = Date.now() + 150;
        vcfHardDeadline = vctDeadline;
        while (ponderMoveIdx < empties.length && Date.now() <= vctDeadline) {
            const xm = empties[ponderMoveIdx];
            const xBit = BIT[xm];
            const nx = xBoard | xBit;
            const occ1 = occ | xBit;
            // Pre-cache whether O has a forcing win in reply to X playing xm
            vctSearch(oBoard, nx, oWinMasks, xWinMasks, occ1, size, FORCE_ATTACK_DEPTH);
            // Pre-cache which O replies are safe against X's forcing chains after xm
            for (const om of empties) {
                if (om === xm || Date.now() > vctDeadline) break;
                const oBit = BIT[om];
                const no = oBoard | oBit;
                const occ2 = occ1 | oBit;
                vctSearch(nx, no, xWinMasks, oWinMasks, occ2, size, ponderVctDepth);
            }
            if (Date.now() <= vctDeadline) {
                ponderMoveIdx++;
            }
        }
        if (ponderMoveIdx >= empties.length) {
            ponderMoveIdx = 0;
            ponderVctDepth++;
        }
        vcfHardDeadline = Infinity;
    }

    // 2. Also deepen the regular minimax transposition table in 150ms slices
    const maxPonderDepth = Math.max(1, empties.length);
    if (currentDepth <= maxPonderDepth) {
        stopTime = Date.now() + 150;
        shouldStopSearch = false;
        nodesCount = 0;
        minimax(xBoard, oBoard, bBoard, size, 0, currentDepth, false, -Infinity, Infinity, xWinMasks, oWinMasks, xbl, obl, xrm, orm, true, allowRemoveBlocks);
        if (!shouldStopSearch) {
            currentDepth++;
        }
    }

    if (isPondering && (ponderVctDepth <= FORCE_DEFENCE_DEPTH || currentDepth <= maxPonderDepth)) {
        setTimeout(ponderLoop, 0);
    }
}
