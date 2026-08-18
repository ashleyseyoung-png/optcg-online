// Authoritative game state machine for a single 1v1 match.
// Automates: shuffling, drawing, DON!! gain/attach, turn phases, life/damage,
// trigger reveals, Rush/Blocker/Double Attack/Banish keywords, win conditions.
// For card-ability text it can't safely auto-resolve, it exposes the printed
// text plus a small generic toolbox so players apply the result themselves —
// see server/game/effects.js for what's auto-handled.
'use strict';
const { getCard } = require('../cards');
const { tryAutoResolve } = require('./effects');

let uidCounter = 1;
const nextUid = () => uidCounter++;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function expandDeck(cardCounts) {
  const out = [];
  for (const [id, count] of Object.entries(cardCounts)) {
    for (let i = 0; i < count; i++) out.push(id);
  }
  return out;
}

class Player {
  constructor(seat, session, deckDoc) {
    this.seat = seat;
    this.userId = session.id;
    this.username = session.username;
    this.leaderId = deckDoc.leaderId;
    this.deck = shuffle(expandDeck(deckDoc.cards));
    this.hand = [];
    this.life = [];
    this.trash = [];
    this.characterArea = [null, null, null, null, null];
    this.stage = null;
    this.leaderState = { rested: false, donAttached: 0, powerMod: 0 };
    this.cost = { active: 0, rested: 0 };
    this.donDeckCount = 10;
    this.mulliganUsed = false;
    this.hasMulliganed = false;
    // per-player convenience settings (sent by the client; bots keep the defaults)
    this.prefs = { autoDraw: true, autoSkipTrigger: true };
  }
  boardCard(id) { return { uid: nextUid(), cardId: id, rested: false, donAttached: 0, powerMod: 0, canAttack: false }; }
}

class Game {
  constructor(roomCode, sessions, deckDocs) {
    this.roomCode = roomCode;
    this.players = [new Player(0, sessions[0], deckDocs[0]), new Player(1, sessions[1], deckDocs[1])];
    this.startingPlayer = Math.random() < 0.5 ? 0 : 1; // coin flip stands in for the paper game's rock-paper-scissors
    this.turnPlayer = this.startingPlayer;
    this.turnNumber = 1;
    this.phase = 'setup'; // setup -> mulligan -> refresh -> draw -> don -> main -> end
    this.log = [];
    this.winner = null;
    this.pendingEffect = null; // { playerSeat, cardId, text, pool, min, max, apply, kind }
    this.pendingBattle = null; // combat sub-state machine
    this.pendingTrigger = null; // life-card trigger reveal choice
    this.pendingDraw = null;    // seat waiting to click Draw ("Auto Draw" off)
    this.pendingMulligan = [false, false];
    this._setup();
  }

  _log(text) { this.log.push({ text, ts: Date.now() }); if (this.log.length > 300) this.log.shift(); }

  _setup() {
    for (const p of this.players) {
      const leader = getCard(p.leaderId);
      const lifeCount = (leader && leader.life) || 5;
      for (let i = 0; i < lifeCount; i++) p.life.push(p.deck.shift());
      for (let i = 0; i < 5; i++) p.hand.push(p.deck.shift());
    }
    this.phase = 'mulligan';
    this._log(`Game started. ${this.players[this.startingPlayer].username} won the flip and goes first.`);
    this._log('Both players may mulligan their opening hand once.');
  }

  other(seat) { return seat === 0 ? 1 : 0; }
  playerBySeat(seat) { return this.players[seat]; }

  // ---------- mulligan ----------
  mulligan(seat, keep) {
    if (this.phase !== 'mulligan') throw new Error('Not in mulligan phase');
    const p = this.players[seat];
    if (p.hasMulliganed) throw new Error('Already decided');
    p.hasMulliganed = true;
    if (!keep) {
      p.deck.push(...p.hand.splice(0));
      shuffle(p.deck);
      for (let i = 0; i < 5; i++) p.hand.push(p.deck.shift());
      this._log(`${p.username} mulligans their hand.`);
    } else {
      this._log(`${p.username} keeps their hand.`);
    }
    if (this.players.every((pl) => pl.hasMulliganed)) {
      this.turnNumber = 1;
      this._startTurn(this.turnPlayer, true);
    }
  }

  // ---------- turn structure ----------
  _startTurn(seat, isFirstTurnOfGame) {
    this.turnPlayer = seat;
    const p = this.players[seat];
    this.phase = 'refresh';
    // Refresh: everything untaps, and every DON!! given to the Leader/Characters
    // returns to the cost area active (the +1000s only last the owner's own turn).
    let returned = 0;
    p.characterArea.forEach((c) => { if (c) { c.rested = false; c.canAttack = true; returned += c.donAttached; c.donAttached = 0; } });
    p.leaderState.rested = false;
    returned += p.leaderState.donAttached;
    p.leaderState.donAttached = 0;
    p.cost.active += p.cost.rested + returned;
    p.cost.rested = 0;
    this._log(`— Turn ${this.turnNumber}: ${p.username}'s Refresh Phase —`);

    this.phase = 'draw';
    const isVeryFirstTurn = isFirstTurnOfGame && this.turnNumber === 1 && seat === this.startingPlayer;
    if (!isVeryFirstTurn) {
      if (p.prefs.autoDraw === false) {
        // "Auto Draw" off: wait for the player to click Draw (like drawing by hand at a table)
        this.pendingDraw = seat;
        this._log(`${p.username}'s Draw Phase — waiting for them to draw.`);
        return;
      }
      this._drawCards(p, 1);
    }
    this._afterDraw(p, isVeryFirstTurn);
  }

  // Draw Phase → DON!! Phase → Main Phase
  _afterDraw(p, isVeryFirstTurn) {
    this.pendingDraw = null;
    this.phase = 'don';
    const donGain = isVeryFirstTurn ? 1 : 2;
    this._giveDon(p, donGain);

    this.phase = 'main';
    this._log(`${p.username}'s Main Phase.`);
  }

  // Manual draw when the player has "Auto Draw" turned off.
  drawPhaseDraw(seat) {
    this._assertTurn(seat);
    if (this.phase !== 'draw' || this.pendingDraw !== seat) throw new Error('Nothing to draw right now');
    const p = this.players[seat];
    this._drawCards(p, 1);
    if (this.winner !== null) return;
    this._afterDraw(p, false);
  }

  setPrefs(seat, prefs) {
    const p = this.players[seat];
    if (!p || !prefs || typeof prefs !== 'object') return;
    if ('autoDraw' in prefs) p.prefs.autoDraw = !!prefs.autoDraw;
    if ('autoSkipTrigger' in prefs) p.prefs.autoSkipTrigger = !!prefs.autoSkipTrigger;
  }

  _drawCards(p, n) {
    for (let i = 0; i < n; i++) {
      if (p.deck.length === 0) { this._endGame(this.other(p.seat), `${p.username} tried to draw from an empty deck.`); return; }
      p.hand.push(p.deck.shift());
    }
  }

  _giveDon(p, n) {
    const give = Math.min(n, p.donDeckCount);
    p.donDeckCount -= give;
    p.cost.active += give;
    this._log(`${p.username} adds ${give} DON!! card${give === 1 ? '' : 's'} to their cost area.`);
  }

  setStartingPlayer(seat) {
    if (this.phase !== 'mulligan' || this.turnNumber !== 1) return;
    this.startingPlayer = seat;
    this.turnPlayer = seat;
  }

  endMainPhase(seat) {
    this._assertTurn(seat);
    if (this.phase !== 'main') throw new Error('Not in main phase');
    this.phase = 'end';
    const p = this.players[seat];
    this._log(`${p.username}'s End Phase.`);
    // "During this turn" power modifiers (buffs, debuffs) expire for everyone.
    for (const pl of this.players) {
      pl.leaderState.powerMod = 0;
      pl.characterArea.forEach((c) => { if (c) c.powerMod = 0; });
    }
    const next = this.other(seat);
    this.turnNumber += 1;
    this._startTurn(next, false);
  }

  _assertTurn(seat) {
    if (this.winner !== null) throw new Error('Game is over');
    if (this.turnPlayer !== seat) throw new Error("It's not your turn");
  }

  // ---------- playing cards ----------
  playCard(seat, handIndex, opts = {}) {
    this._assertTurn(seat);
    if (this.phase !== 'main') throw new Error('You can only play cards during your Main Phase');
    const p = this.players[seat];
    const cardId = p.hand[handIndex];
    if (!cardId) throw new Error('No such card in hand');
    const card = getCard(cardId);
    if (!card) throw new Error('Unknown card');
    if (card.cost === null || card.cost === undefined) throw new Error('This card has no printed cost');
    if (p.cost.active < card.cost) throw new Error('Not enough active DON!! to pay the cost');
    if (card.type === 'Character' && p.characterArea.filter(Boolean).length >= 5) {
      throw new Error('Your Character Area is full (5 max)');
    }
    if (card.type === 'Stage' && p.stage) {
      this._log(`${card.name} replaces ${getCard(p.stage).name} in the Stage Area.`);
    }
    p.hand.splice(handIndex, 1);
    p.cost.active -= card.cost;
    p.cost.rested += card.cost;

    if (card.type === 'Character') {
      const slot = p.characterArea.findIndex((s) => s === null);
      const bc = p.boardCard(cardId);
      bc.canAttack = card.keywords.includes('Rush');
      p.characterArea[slot] = bc;
      this._log(`${p.username} plays ${card.name} (cost ${card.cost}).`);
      this._triggerEffect(seat, card, 'On Play', { slot });
    } else if (card.type === 'Stage') {
      if (p.stage) p.trash.unshift(p.stage);
      p.stage = cardId;
      this._log(`${p.username} plays the Stage ${card.name}.`);
      this._triggerEffect(seat, card, 'On Play', {});
    } else if (card.type === 'Event') {
      this._log(`${p.username} plays the Event ${card.name}.`);
      this._triggerEffect(seat, card, 'Main', {});
      p.trash.unshift(cardId);
    }
    return { ok: true };
  }

  attachDon(seat, count, target) {
    this._assertTurn(seat);
    if (this.phase !== 'main') throw new Error('You can only give DON!! during your Main Phase');
    const p = this.players[seat];
    count = Math.max(1, Math.floor(Number(count) || 1));
    if (p.cost.active < count) throw new Error('Not enough active DON!!');
    p.cost.active -= count;
    if (target === 'leader') {
      p.leaderState.donAttached += count;
    } else {
      const c = p.characterArea[target];
      if (!c) throw new Error('No character there');
      c.donAttached += count;
    }
    this._log(`${p.username} attaches ${count} DON!! (+${count * 1000} power).`);
  }

  // ---------- effect resolution ----------
  _buildCtx(seat) {
    const self = this.players[seat];
    const opp = this.players[this.other(seat)];
    const game = this;
    return {
      self, opp, game,
      cardCost: (id) => (getCard(id) ? getCard(id).cost || 0 : 0),
      currentPower: (owner, boardCard) => game._power(owner, boardCard),
      draw: (owner, n) => { game._drawCards(owner, n); return { drew: n }; },
      koCharacter: (owner, idx) => game._koCharacter(owner, idx),
      setRested: (owner, idx, val) => { const c = owner.characterArea[idx]; if (c) c.rested = val; },
      buffPower: (owner, target, amt) => {
        if (target === 'leader') owner.leaderState.powerMod += amt;
        else { const c = owner.characterArea[target]; if (c) c.powerMod += amt; }
      },
      addDonFromDeck: (owner, n, rested) => {
        const give = Math.min(n, owner.donDeckCount);
        owner.donDeckCount -= give;
        if (rested) owner.cost.rested += give; else owner.cost.active += give;
        return { donGained: give };
      },
      trashFromHand: (owner, n) => {
        const removed = owner.hand.splice(0, Math.min(n, owner.hand.length));
        owner.trash.unshift(...removed);
        return { trashed: removed.length };
      },
      pickAndApply: (pool, min, max, applyFn, side) => {
        if (pool.length === 0) return { targets: [] };
        if (pool.length <= max) { applyFn(pool); return { targets: pool }; }
        return { needsTarget: true, pool, min, max, apply: applyFn, side };
      },
    };
  }

  _triggerEffect(seat, card, timing, meta) {
    if (!card.text || !card.text.includes(`[${timing}]`)) {
      if (timing !== 'Main') return; // events always attempt to resolve their [Main] text
    }
    const ctx = this._buildCtx(seat);
    const result = tryAutoResolve(card.text, ctx);
    if (result.matched && result.needsTarget) {
      this.pendingEffect = { seat, cardName: card.name, text: card.text, pool: result.pool, min: result.min, max: result.max, apply: result.apply, side: result.side };
      this._log(`${card.name}'s effect needs a target — waiting on ${this.players[seat].username}.`);
    } else if (result.matched) {
      this._log(`${card.name}'s effect resolved automatically.`);
    } else {
      this._log(`${card.name}: "${card.text}" — not auto-resolvable, use the board tools to apply it.`);
    }
  }

  resolveEffectTargets(seat, selected) {
    if (!this.pendingEffect || this.pendingEffect.seat !== seat) throw new Error('No pending effect for you');
    const { pool, max, apply } = this.pendingEffect;
    if (selected.length > max) throw new Error('Too many targets selected');
    for (const s of selected) if (!pool.includes(s)) throw new Error('Illegal target');
    apply(selected);
    this.pendingEffect = null;
    this._log('Effect target resolved.');
  }

  _power(owner, boardCardOrLeader) {
    if (boardCardOrLeader === 'leader') {
      const leader = getCard(owner.leaderId);
      return Math.max(0, leader.power + owner.leaderState.donAttached * 1000 + owner.leaderState.powerMod);
    }
    const card = getCard(boardCardOrLeader.cardId);
    return Math.max(0, card.power + boardCardOrLeader.donAttached * 1000 + boardCardOrLeader.powerMod);
  }

  _koCharacter(owner, idx) {
    const c = owner.characterArea[idx];
    if (!c) return { koed: false };
    owner.characterArea[idx] = null;
    owner.trash.unshift(c.cardId);
    // Rule: DON!! given to a card that leaves the field go back to its owner's cost area, RESTED
    // (they become active again at that player's next Refresh Phase). They do NOT go to the DON!! deck.
    owner.cost.rested += c.donAttached;
    this._log(`${getCard(c.cardId).name} was K.O.'d.`);
    return { koed: true };
  }

  // ---------- combat ----------
  declareAttack(seat, attacker, target) {
    this._assertTurn(seat);
    if (this.phase !== 'main') throw new Error('You can only attack during your Main Phase');
    if (this.pendingBattle) throw new Error('A battle is already in progress');
    const p = this.players[seat];
    const opp = this.players[this.other(seat)];
    const atkCard = attacker === 'leader' ? { boardRef: 'leader', rested: p.leaderState.rested } : p.characterArea[attacker];
    if (!atkCard) throw new Error('No attacker there');
    if (attacker !== 'leader') {
      if (atkCard.rested) throw new Error('That character is already rested');
      if (!atkCard.canAttack) throw new Error('That character can\'t attack this turn (summoning sick — no Rush)');
    } else if (p.leaderState.rested) throw new Error('Your Leader is already rested');

    const targetCard = target === 'leader' ? 'leader' : opp.characterArea[target];
    if (!targetCard) throw new Error('No legal target there');
    if (target !== 'leader' && !targetCard.rested) throw new Error("You can only attack the opponent's Leader or a Rested Character");

    if (attacker === 'leader') p.leaderState.rested = true; else atkCard.rested = true;

    const attackerCardDef = attacker === 'leader' ? getCard(p.leaderId) : getCard(atkCard.cardId);
    this._log(`${p.username} attacks with ${attackerCardDef.name} → ${target === 'leader' ? opp.username + "'s Leader" : getCard(targetCard.cardId).name}.`);

    this.pendingBattle = {
      attackerSeat: seat, attacker, target, step: 'block',
      counterPower: 0,
    };
  }

  respondBlock(seat, blockerIdx) {
    const b = this.pendingBattle;
    if (!b || b.step !== 'block') throw new Error('No block decision pending');
    const defenderSeat = this.other(b.attackerSeat);
    if (seat !== defenderSeat) throw new Error('Not your decision');
    const defender = this.players[defenderSeat];
    if (blockerIdx !== null && blockerIdx !== undefined) {
      const blocker = defender.characterArea[blockerIdx];
      if (!blocker) throw new Error('No such blocker');
      if (blocker.rested) throw new Error('That character is rested and cannot block');
      const def = getCard(blocker.cardId);
      if (!def.keywords.includes('Blocker')) throw new Error('That character does not have [Blocker]');
      blocker.rested = true;
      b.target = blockerIdx;
      this._log(`${defender.username} blocks with ${def.name}!`);
    }
    b.step = 'counter';
  }

  respondCounter(seat, boost) {
    const b = this.pendingBattle;
    if (!b || b.step !== 'counter') throw new Error('No counter step pending');
    const defenderSeat = this.other(b.attackerSeat);
    if (seat !== defenderSeat) throw new Error('Not your decision');
    b.counterPower = (b.counterPower || 0) + (boost || 0);
    b.step = 'damage';
    this._resolveDamageStep();
  }

  playCounterEvent(seat, handIndex) {
    const b = this.pendingBattle;
    if (!b || b.step !== 'counter') throw new Error('No counter step pending');
    const defenderSeat = this.other(b.attackerSeat);
    if (seat !== defenderSeat) throw new Error('Not your decision');
    const p = this.players[seat];
    const cardId = p.hand[handIndex];
    const card = getCard(cardId);
    if (!card || !card.text.includes('[Counter]')) throw new Error('That card has no [Counter] effect');
    p.hand.splice(handIndex, 1);
    const m = card.text.match(/\[Counter\][^.]*?\+(\d+)\s*power/i);
    const boost = m ? parseInt(m[1], 10) : 0;
    b.counterPower = (b.counterPower || 0) + boost;
    p.trash.unshift(cardId);
    this._log(`${p.username} plays ${card.name} as a Counter (+${boost} power).`);
  }

  // Discard a Character with a printed counter value from hand for its power boost.
  playCounterCharacter(seat, handIndex) {
    const b = this.pendingBattle;
    if (!b || b.step !== 'counter') throw new Error('No counter step pending');
    const defenderSeat = this.other(b.attackerSeat);
    if (seat !== defenderSeat) throw new Error('Not your decision');
    const p = this.players[seat];
    const cardId = p.hand[handIndex];
    const card = getCard(cardId);
    if (!card || card.type !== 'Character' || !card.counter) throw new Error('That card has no printed counter value');
    p.hand.splice(handIndex, 1);
    b.counterPower = (b.counterPower || 0) + card.counter;
    p.trash.unshift(cardId);
    this._log(`${p.username} discards ${card.name} as a Counter (+${card.counter} power).`);
  }

  _resolveDamageStep() {
    const b = this.pendingBattle;
    const attackerP = this.players[b.attackerSeat];
    const defenderP = this.players[this.other(b.attackerSeat)];
    const atkPower = b.attacker === 'leader' ? this._power(attackerP, 'leader') : this._power(attackerP, attackerP.characterArea[b.attacker]);
    const baseDefPower = b.target === 'leader' ? this._power(defenderP, 'leader') : this._power(defenderP, defenderP.characterArea[b.target]);
    const defPower = baseDefPower + (b.counterPower || 0);

    const win = atkPower >= defPower;
    this._log(`Battle: ${atkPower} power vs ${defPower} power — ${win ? 'attacker wins!' : 'attack fails.'}`);

    if (win) {
      if (b.target === 'leader') {
        const attackerCardDef = b.attacker === 'leader' ? getCard(attackerP.leaderId) : getCard(attackerP.characterArea[b.attacker].cardId);
        const damage = attackerCardDef.keywords.includes('Double Attack') ? 2 : 1;
        const banish = attackerCardDef.keywords.includes('Banish');
        for (let i = 0; i < damage; i++) this._dealDamage(defenderP, banish);
      } else {
        this._koCharacter(defenderP, b.target);
      }
    }
    this.pendingBattle = null;
  }

  _dealDamage(defenderP, banish) {
    if (this.winner !== null) return;
    if (defenderP.life.length === 0) {
      this._endGame(this.other(defenderP.seat), `${defenderP.username}'s Leader took damage with no Life cards left!`);
      return;
    }
    const cardId = defenderP.life.shift();
    const card = getCard(cardId);
    if (banish) {
      defenderP.trash.unshift(cardId);
      this._log(`${defenderP.username} takes damage — life card is [Banish]ed straight to the trash.`);
      return;
    }
    if (card && card.keywords.includes('Trigger')) {
      this.pendingTrigger = { seat: defenderP.seat, cardId };
      this._log(`${defenderP.username} takes damage and reveals a card with [Trigger] — waiting on their choice.`);
    } else if (defenderP.prefs.autoSkipTrigger === false) {
      // "Auto Skip Trigger" off: the player looks at every life card themselves, so the
      // opponent can't tell from timing whether it had a Trigger.
      this.pendingTrigger = { seat: defenderP.seat, cardId, noTrigger: true };
      this._log(`${defenderP.username} takes damage and looks at the life card…`);
    } else {
      defenderP.hand.push(cardId);
      this._log(`${defenderP.username} takes damage — life card added to hand.`);
    }
  }

  respondTrigger(seat, activate) {
    const t = this.pendingTrigger;
    if (!t || t.seat !== seat) throw new Error('No pending trigger for you');
    const p = this.players[seat];
    const card = getCard(t.cardId);
    if (t.noTrigger) activate = false; // nothing to activate — it just goes to hand
    if (activate) {
      this._log(`${p.username} activates ${card.name}'s [Trigger]!`);
      const m = card.text.match(/\[Trigger\]\s*(.*?)(?:\.|$)/i);
      const ctx = this._buildCtx(seat);
      if (m) {
        const result = tryAutoResolve('[On Play] ' + m[1], ctx); // reuse same pattern lib
        if (!result.matched) this._log(`Trigger text: "${m[0]}" — apply manually.`);
      }
      p.trash.unshift(t.cardId);
    } else {
      p.hand.push(t.cardId);
      this._log(t.noTrigger ? `${p.username} adds the life card to their hand.` : `${p.username} adds the revealed card to their hand instead.`);
    }
    this.pendingTrigger = null;
  }

  // ---------- manual toolbox (fallback for un-auto-resolved effects) ----------
  // Every tool is bounded by what the printed rules could ever produce, so the toolbox
  // can apply a card's effect but can't conjure resources out of nothing:
  //   • DON!! is conserved — a player always has exactly 10 across DON!! deck + cost area
  //     + attached. Tools MOVE DON!! between those places; they never create it.
  //   • Draw is capped at 2 per use and only from a non-empty deck.
  //   • Power tweaks are ±1000/±2000 per use, only during the current turn (they clear at
  //     end of turn), and only on the acting player's own turn or during a battle they're in.
  //   • Everything is announced loudly in the log so the opponent sees exactly what was done.
  manualAction(seat, action) {
    if (this.winner !== null) throw new Error('Game is over');
    const p = this.players[seat];
    const opp = this.players[this.other(seat)];
    const battleInvolvesMe = this.pendingBattle && (this.pendingBattle.attackerSeat === seat || this.other(this.pendingBattle.attackerSeat) === seat);
    if (this.turnPlayer !== seat && !battleInvolvesMe && !(this.pendingTrigger && this.pendingTrigger.seat === seat) && !(this.pendingEffect && this.pendingEffect.seat === seat)) {
      throw new Error("You can only use the toolbox on your own turn (or while resolving a battle/trigger/effect that involves you)");
    }
    const donOnField = (o) => o.cost.active + o.cost.rested + o.leaderState.donAttached + o.characterArea.reduce((n, c) => n + (c ? c.donAttached : 0), 0);
    let what = action.type;
    switch (action.type) {
      case 'draw': {
        const n = Math.max(1, Math.min(2, Number(action.count) || 1));
        if (p.deck.length === 0) throw new Error('Your deck is empty');
        this._drawCards(p, n);
        what = `drew ${n} card${n === 1 ? '' : 's'}`;
        break;
      }
      case 'adjustPower': {
        const owner = action.side === 'opp' ? opp : p;
        const amt = Math.max(-2000, Math.min(2000, Math.round((Number(action.amount) || 0) / 1000) * 1000));
        if (!amt) throw new Error('Power change must be ±1000 or ±2000');
        let target;
        if (action.target === 'leader') { owner.leaderState.powerMod += amt; target = getCard(owner.leaderId).name; }
        else { const c = owner.characterArea[action.target]; if (!c) throw new Error('No character there'); c.powerMod += amt; target = getCard(c.cardId).name; }
        what = `gave ${owner.username}'s ${target} ${amt > 0 ? '+' : ''}${amt} power (this turn)`;
        break;
      }
      case 'toggleRest': {
        const owner = action.side === 'opp' ? opp : p;
        let target;
        if (action.target === 'leader') { owner.leaderState.rested = !owner.leaderState.rested; target = getCard(owner.leaderId).name + (owner.leaderState.rested ? ' → rested' : ' → active'); }
        else { const c = owner.characterArea[action.target]; if (!c) throw new Error('No character there'); c.rested = !c.rested; target = getCard(c.cardId).name + (c.rested ? ' → rested' : ' → active'); }
        what = `set ${owner.username}'s ${target}`;
        break;
      }
      case 'ko': {
        const owner = action.side === 'opp' ? opp : p;
        const c = owner.characterArea[action.target];
        if (!c) throw new Error('No character there');
        const name = getCard(c.cardId).name;
        this._koCharacter(owner, action.target);
        what = `K.O.'d ${owner.username}'s ${name}`;
        break;
      }
      case 'donFromDeck': { // DON!! deck → cost area (active or rested). "Add up to 1 DON!! card from your DON!! deck"
        if (p.donDeckCount <= 0) throw new Error('Your DON!! deck is empty (all 10 DON!! are already on the field)');
        p.donDeckCount -= 1;
        if (action.rested) p.cost.rested += 1; else p.cost.active += 1;
        what = `added 1 DON!! from the DON!! deck (${action.rested ? 'rested' : 'active'})`;
        break;
      }
      case 'donToDeck': { // cost area → DON!! deck. "Return 1 DON!! card to your DON!! deck"
        if (p.cost.rested > 0) p.cost.rested -= 1;
        else if (p.cost.active > 0) p.cost.active -= 1;
        else throw new Error('No DON!! in your cost area to return');
        p.donDeckCount += 1;
        what = 'returned 1 DON!! to the DON!! deck';
        break;
      }
      case 'donRest': { // set 1 active DON!! rested (paying an "(1)" cost) or 1 rested DON!! active
        if (action.activate) {
          if (p.cost.rested <= 0) throw new Error('No rested DON!! to set active');
          p.cost.rested -= 1; p.cost.active += 1; what = 'set 1 DON!! active';
        } else {
          if (p.cost.active <= 0) throw new Error('No active DON!! to rest');
          p.cost.active -= 1; p.cost.rested += 1; what = 'rested 1 DON!!';
        }
        break;
      }
      case 'donDetach': { // return DON!! given to a card back to the cost area (rested)
        const owner = p;
        if (action.target === 'leader') {
          if (owner.leaderState.donAttached <= 0) throw new Error('No DON!! on your Leader');
          owner.leaderState.donAttached -= 1;
        } else {
          const c = owner.characterArea[action.target];
          if (!c || c.donAttached <= 0) throw new Error('No DON!! on that character');
          c.donAttached -= 1;
        }
        owner.cost.rested += 1;
        what = 'returned 1 attached DON!! to the cost area';
        break;
      }
      case 'donAdjust': throw new Error('That tool has been replaced by the DON!! move tools');
      case 'moveHandToTrash': {
        const idx = action.handIndex;
        const id = p.hand[idx];
        if (!id) throw new Error('No such card in hand');
        p.hand.splice(idx, 1); p.trash.unshift(id);
        what = `trashed ${getCard(id).name} from hand`;
        break;
      }
      default: throw new Error('Unknown manual action');
    }
    // invariant check — should be impossible to violate now, but never let it slide silently
    for (const pl of this.players) {
      const total = pl.donDeckCount + donOnField(pl);
      if (total !== 10) { pl.donDeckCount = Math.max(0, 10 - donOnField(pl)); }
    }
    this._log(`🛠 ${p.username} used the toolbox: ${what}.`);
  }

  concede(seat) {
    if (this.winner !== null) return;
    this._endGame(this.other(seat), `${this.players[seat].username} conceded.`);
  }

  _endGame(winnerSeat, reason) {
    this.winner = winnerSeat;
    this.phase = 'gameover';
    this.pendingBattle = null;
    this.pendingEffect = null;
    this.pendingTrigger = null;
    this._log(`🏆 ${this.players[winnerSeat].username} wins! (${reason})`);
  }

  // ---------- serialization (hide hidden info per-viewer) ----------
  serializeFor(viewerSeat) {
    const view = (p, isSelf) => ({
      seat: p.seat,
      username: p.username,
      leaderId: p.leaderId,
      leaderState: p.leaderState,
      characterArea: p.characterArea.map((c) => c && ({ uid: c.uid, cardId: c.cardId, rested: c.rested, donAttached: c.donAttached, powerMod: c.powerMod, canAttack: c.canAttack })),
      stage: p.stage,
      trash: p.trash,
      cost: p.cost,
      donDeckCount: p.donDeckCount,
      deckCount: p.deck.length,
      lifeCount: p.life.length,
      hand: isSelf ? p.hand : p.hand.map(() => null),
      handCount: p.hand.length,
      mulliganDone: p.hasMulliganed,
    });
    return {
      roomCode: this.roomCode,
      phase: this.phase,
      turnPlayer: this.turnPlayer,
      turnNumber: this.turnNumber,
      winner: this.winner,
      you: viewerSeat,
      players: this.players.map((p, i) => view(p, i === viewerSeat)),
      pendingBattle: this.pendingBattle,
      pendingEffect: this.pendingEffect && { seat: this.pendingEffect.seat, cardName: this.pendingEffect.cardName, text: this.pendingEffect.text, pool: this.pendingEffect.pool, max: this.pendingEffect.max, side: this.pendingEffect.side },
      pendingTrigger: this.pendingTrigger && { seat: this.pendingTrigger.seat, cardId: this.pendingTrigger.seat === viewerSeat ? this.pendingTrigger.cardId : null, noTrigger: this.pendingTrigger.seat === viewerSeat ? !!this.pendingTrigger.noTrigger : undefined },
      pendingDraw: this.pendingDraw,
      log: this.log.slice(-60),
    };
  }
}

module.exports = { Game };
