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

function getCanonicalKey(xBoard, oBoard, bBoard, size, isMax, xbl, obl, xrm, orm, canSpec) {
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
            if (v > 0 || restrictTo !== undefined) list.push({ sq: i, v });
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
        const winMove = lowIdx(aw);
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
// positions just to gain a small positional edge.
const BLOCK_VALUE = 500, REMOVE_VALUE = 1200;

function evaluateBoard(xBoard, oBoard, bBoard, xWinMasks, oWinMasks, xbl, obl, xrm, orm) {
    let score = ((obl || 0) - (xbl || 0)) * BLOCK_VALUE + ((orm || 0) - (xrm || 0)) * REMOVE_VALUE;
    for (let i=0; i<oWinMasks.length; i++) {
        let mask = oWinMasks[i];
        if (((xBoard | bBoard) & mask) === ZERO) { // no X (or block) in this line
            let count = popcount(oBoard & mask);
            if (count > 0) score += Math.pow(10, count);
        }
    }
    for (let i=0; i<xWinMasks.length; i++) {
        let mask = xWinMasks[i];
        if (((oBoard | bBoard) & mask) === ZERO) { // no O (or block) in this line
            let count = popcount(xBoard & mask);
            if (count > 0) score -= Math.pow(10, count);
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

// action: 'move' (place a mark), 'block' (fill an empty square) or 'remove' (empty a filled square)
function sendMove(move, action) {
    postMessage({ type: 'MOVE', move: move, action: action || 'move' });
}

onmessage = function(e) {
    let msg = e.data;
    if (msg.type === 'START_SEARCH') {
        isPondering = false;
        let { board, size, xhc, ohc, xbl, obl, timeLimit, isO } = msg;
        let xrm = msg.xrm || 0, orm = msg.orm || 0;
        let allowRemoveBlocks = msg.allowRemoveBlocks !== false;

        // Convert board to bitboards
        let { xBoard, oBoard, bBoard } = toBitboards(board, size);

        let xWinMasks = getWinMasks(size, xhc);
        let oWinMasks = getWinMasks(size, ohc);

        // Iterative deepening
        stopTime = Date.now() + timeLimit;
        vcfHardDeadline = Date.now() + timeLimit;
        shouldStopSearch = false;
        nodesCount = 0;
        let depth = 1;
        let localBestMove = -1;
        let localBestAction = 'move';

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

        // Find available moves, ordered by positional strength (number of win-lines through square)
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
        availableMoves.sort((a, b) => posWeight(b) - posWeight(a));
        // Removable squares at the root (most valuable first).
        const rootRemoves = myRm > 0
            ? removalCandidates(oppBoard, meBoard, bBoard, oppMasks, meMasks, size, undefined, undefined, allowRemoveBlocks)
            : [];

        if (availableMoves.length === 0) {
            // Board is full: the only legal action is a remove (if any are left).
            if (rootRemoves.length > 0) sendMove(rootRemoves[0], 'remove');
            else sendMove(-1, 'move');
            return;
        }

        // ---- Tactical pre-search (the side to move is O when isO, else X) ----
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
                sendMove(myWins[0], 'move');
                return;
            }
            if (myRm > 0) {
                const bw = blockedWinSquares(meBoard, meMasks, removableOcc);
                if (bw !== ZERO) {
                    sendMove(lowIdx(bw), 'remove');
                    return;
                }
            }

            // 2. Opponent threatens to win next move: must defend.
            let oppWins = winsFor(oppBoard, oppMasks, occAll);
            // If the opponent has a remove, any line where they already have (oppHc - 1) stones and
            // the last square is occupied by a removable piece is ALSO a next-turn win threat for them.
            const oppBlockedWins = oppRm > 0 ? blockedWinSquares(oppBoard, oppMasks, removableOcc) : ZERO;
            if (oppWins.length === 1 && oppBlockedWins === ZERO && oppRm === 0) {
                sendMove(oppWins[0], 'move');
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
                        if (left < bestLeft) { bestLeft = left; bestS = s; }
                    }
                    if (bestS !== -1 && bestLeft === 0) {
                        sendMove(bestS, 'remove');
                        return;
                    }
                    if (bestS !== -1 && oppWins.length > 1) {
                        sendMove(bestS, 'remove');
                        return;
                    }
                }
                if (oppWins.length === 1) {
                    // When blocks are unremovable and the opponent has a remove, plugging the threat
                    // square with a block stops them from removing our piece on their turn.
                    sendMove(oppWins[0], (!allowRemoveBlocks && oppRm > 0 && myBl > 0) ? 'block' : 'move');
                    return;
                }
                if (oppWins.length > 1) {
                    // Otherwise every placement loses to a perfect opponent, so the search can't tell them
                    // apart. At least take (or block) the most valuable winning square.
                    let bestM = oppWins[0], bestV = -Infinity;
                    for (const m of oppWins) {
                        let nx = isO ? xBoard : xBoard | BIT[m];
                        let no = isO ? oBoard | BIT[m] : oBoard;
                        let v = evaluateBoard(nx, no, bBoard, xWinMasks, oWinMasks, xbl, obl, xrm, orm);
                        if (!isO) v = -v;
                        if (v > bestV) { bestV = v; bestM = m; }
                    }
                    // With a block we can plug one square now (turn continues) and occupy the other next.
                    sendMove(bestM, myBl > 0 ? 'block' : 'move');
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
                sendMove(atk, 'move');
                return;
            }

            // 4. Defend: drop any move after which the opponent has a forced win.
            //    Only narrow the candidate list when at least one move is genuinely verified safe;
            //    if every move examined before the deadline was refuted, keep the full list so we
            //    never discard the best central moves in favour of unexamined edge moves.
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
            let safe = stageAVerified.length > 0 ? stageAVerified.concat(stageAUnchecked) : availableMoves;
            //    Stage B (deeper, time-boxed): the opponent plays a quiet setup move that threatens a chain
            //    and no reply stops it. Skip on the very first move of bigger boards where no multi-stone
            //    setup exists yet.
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
        while (Date.now() < stopTime && depth <= maxSearchDepth) {
            let bestScore = isO ? -Infinity : Infinity;
            let tempBestMove = -1;
            let tempBestAction = 'move';

            // To do top-level search
            // For O (isO=true), O wants to maximize
            for (let i = 0; i < availableMoves.length; i++) {
                let m = availableMoves[i];
                let bit = BIT[m];
                let score = 0;

                if (isO) {
                    score = minimax(xBoard, oBoard | bit, bBoard, size, 1, depth, false, bestScore, Infinity, xWinMasks, oWinMasks, xbl, obl, xrm, orm, true, allowRemoveBlocks);
                    if (shouldStopSearch) break;
                    if (score > bestScore) {
                        bestScore = score;
                        tempBestMove = m;
                        tempBestAction = 'move';
                    }
                    if (obl > 0) {
                        let bScore = minimax(xBoard, oBoard, bBoard | bit, size, 0, depth, true, bestScore, Infinity, xWinMasks, oWinMasks, xbl, obl - 1, xrm, orm, false, allowRemoveBlocks);
                        if (shouldStopSearch) break;
                        if (bScore > bestScore) {
                            bestScore = bScore;
                            tempBestMove = m;
                            tempBestAction = 'block';
                        }
                    }
                } else {
                    // For X (isO=false), X wants to minimize (in our minimax view, O is maximizing, X is minimizing)
                    score = minimax(xBoard | bit, oBoard, bBoard, size, 1, depth, true, -Infinity, bestScore, xWinMasks, oWinMasks, xbl, obl, xrm, orm, true, allowRemoveBlocks);
                    if (shouldStopSearch) break;
                    if (score < bestScore) {
                        bestScore = score;
                        tempBestMove = m;
                        tempBestAction = 'move';
                    }
                    if (xbl > 0) {
                        let bScore = minimax(xBoard, oBoard, bBoard | bit, size, 0, depth, false, -Infinity, bestScore, xWinMasks, oWinMasks, xbl - 1, obl, xrm, orm, false, allowRemoveBlocks);
                        if (shouldStopSearch) break;
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
                    const rScore = minimax(xBoard & ~rBit, oBoard & ~rBit, bBoard & ~rBit, size, 0, depth, true, bestScore, Infinity, xWinMasks, oWinMasks, xbl, obl, xrm, orm - 1, false, allowRemoveBlocks);
                    if (shouldStopSearch) break;
                    if (rScore > bestScore) { bestScore = rScore; tempBestMove = s; tempBestAction = 'remove'; }
                } else {
                    const rScore = minimax(xBoard & ~rBit, oBoard & ~rBit, bBoard & ~rBit, size, 0, depth, false, -Infinity, bestScore, xWinMasks, oWinMasks, xbl, obl, xrm - 1, orm, false, allowRemoveBlocks);
                    if (shouldStopSearch) break;
                    if (rScore < bestScore) { bestScore = rScore; tempBestMove = s; tempBestAction = 'remove'; }
                }
            }
            if (!shouldStopSearch && tempBestMove !== -1) {
                localBestMove = tempBestMove;
                localBestAction = tempBestAction;
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

        if (localBestMove === -1 && availableMoves.length > 0) {
            localBestMove = availableMoves[Math.floor(Math.random() * availableMoves.length)];
            localBestAction = 'move';
        }

        sendMove(localBestMove, localBestAction);
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
    let { xBoard, oBoard, bBoard } = toBitboards(board, size);
    let occ = xBoard | oBoard | bBoard;
    let xWinMasks = getWinMasks(size, xhc);
    let oWinMasks = getWinMasks(size, ohc);

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
