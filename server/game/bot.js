// A simple but competent AI opponent ("Captain Bot") for practice / tutorial matches.
// It drives one seat of a Game entirely through the same public Game methods a human
// client would trigger over the WebSocket, so it can never do anything a player
// couldn't. Strategy is deliberately straightforward and readable:
//   - keep any hand with a playable early Character, otherwise mulligan
//   - each turn: play the most expensive Character it can afford (repeat), then
//     put leftover DON!! on its Leader, then attack with everything that has a
//     favourable matchup (prefers K.O.-ing rested Characters, else hits the Leader)
//   - defends by blocking with a Blocker when its Leader is attacked and it would
//     otherwise take damage, and by discarding counter Characters when that flips
//     the battle
//   - takes revealed [Trigger] cards to hand (safe default; no manual resolution)
//   - picks targets for auto-resolved effects (highest-value target)
// One decision per tick, with a short delay between ticks so it feels like a turn
// is being taken rather than teleporting through the whole phase.
'use strict';
const { getCard } = require('../cards');

const BOT_NAMES = ['Captain Bot', 'Bot Buggy', 'Automaton Ace', 'Clockwork Zoro', 'Den Den Bot'];
const TICK_MS = 650;

function pickBotName() { return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]; }

class Bot {
  constructor(room, seat) {
    this.room = room;
    this.seat = seat;
    this.timer = null;
    this.memory = { turnNumber: -1, skippedAttackers: new Set(), playsThisTick: 0 };
  }

  schedule(delay = TICK_MS) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.tick(); }, delay);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  tick() {
    const g = this.room.game;
    if (!g || g.winner !== null) return;
    let acted = false;
    try {
      acted = this.decide(g);
    } catch (e) {
      // Any rejected action means our heuristic guessed wrong about legality —
      // log it and fall through to ending the phase so the game never hangs.
      g._log(`🤖 ${g.players[this.seat].username} hesitates (${e.message}).`);
      acted = this.bailOut(g);
    }
    if (acted) {
      this.room.broadcast();
      // Something changed; there may be more to do (or a human decision to wait on).
      this.schedule();
    }
  }

  bailOut(g) {
    if (g.turnPlayer === this.seat && g.phase === 'main' && !g.pendingBattle && !g.pendingEffect && !g.pendingTrigger) {
      g.endMainPhase(this.seat);
      return true;
    }
    return false;
  }

  // Returns true if it took an action.
  decide(g) {
    const me = g.players[this.seat];
    const opp = g.players[g.other(this.seat)];

    if (this.memory.turnNumber !== g.turnNumber) {
      this.memory = { turnNumber: g.turnNumber, skippedAttackers: new Set(), playsThisTick: 0 };
    }

    // ---- setup ----
    if (g.phase === 'mulligan') {
      if (me.hasMulliganed) return false;
      const hasEarlyPlay = me.hand.some((id) => { const c = getCard(id); return c && c.type === 'Character' && c.cost !== null && c.cost <= 3; });
      g.mulligan(this.seat, hasEarlyPlay);
      return true;
    }

    // ---- reactive decisions (any turn) ----
    if (g.pendingTrigger && g.pendingTrigger.seat === this.seat) {
      g.respondTrigger(this.seat, false);
      return true;
    }
    if (g.pendingEffect && g.pendingEffect.seat === this.seat) {
      const eff = g.pendingEffect;
      const side = eff.side === 'opp' ? opp : me;
      const scored = eff.pool.map((t) => {
        if (t === 'leader') return { t, score: eff.side === 'opp' ? 0 : 5 };
        const bc = side.characterArea[t];
        const card = bc && getCard(bc.cardId);
        return { t, score: card ? (card.cost || 0) * 1000 + (card.power || 0) : 0 };
      }).sort((a, b) => b.score - a.score);
      const chosen = scored.slice(0, Math.max(1, eff.max)).map((s) => s.t);
      g.resolveEffectTargets(this.seat, chosen);
      return true;
    }
    if (g.pendingBattle) {
      const b = g.pendingBattle;
      const defenderSeat = g.other(b.attackerSeat);
      if (defenderSeat !== this.seat) return false; // waiting on the human
      if (b.step === 'block') return this.decideBlock(g, b, me, opp);
      if (b.step === 'counter') return this.decideCounter(g, b, me, opp);
      return false;
    }

    // ---- my main phase ----
    if (g.turnPlayer !== this.seat || g.phase !== 'main') return false;

    // 1. Play the most expensive affordable Character (one per tick).
    const openSlot = me.characterArea.some((s) => s === null);
    if (openSlot) {
      let best = -1, bestCost = -1;
      me.hand.forEach((id, i) => {
        const c = getCard(id);
        if (!c || c.type !== 'Character' || c.cost === null || c.cost > me.cost.active) return;
        if (c.cost > bestCost) { bestCost = c.cost; best = i; }
      });
      if (best >= 0) { g.playCard(this.seat, best); return true; }
    }

    // 2. Attach any spare DON!! to the Leader for the attack.
    if (me.cost.active > 0) {
      g.attachDon(this.seat, me.cost.active, 'leader');
      return true;
    }

    // 3. Attack with anything favourable.
    const attackers = [];
    if (!me.leaderState.rested) attackers.push({ sel: 'leader', power: g._power(me, 'leader') });
    me.characterArea.forEach((c, i) => { if (c && !c.rested && c.canAttack) attackers.push({ sel: i, power: g._power(me, c) }); });
    for (const a of attackers) {
      const key = String(a.sel);
      if (this.memory.skippedAttackers.has(key)) continue;
      // Prefer K.O.-ing a rested opposing Character we can beat, most valuable first.
      let bestTarget = null, bestVal = -1;
      opp.characterArea.forEach((c, i) => {
        if (!c || !c.rested) return;
        const p = g._power(opp, c);
        if (a.power >= p) {
          const card = getCard(c.cardId);
          const val = (card.cost || 0) * 1000 + p;
          if (val > bestVal) { bestVal = val; bestTarget = i; }
        }
      });
      if (bestTarget !== null) { g.declareAttack(this.seat, a.sel, bestTarget); return true; }
      const leaderPower = g._power(opp, 'leader');
      if (a.power >= leaderPower) { g.declareAttack(this.seat, a.sel, 'leader'); return true; }
      this.memory.skippedAttackers.add(key);
    }

    // 4. Nothing left worth doing.
    g.endMainPhase(this.seat);
    return true;
  }

  decideBlock(g, b, me, opp) {
    // Only bother blocking hits on the Leader that would actually connect.
    if (b.target === 'leader') {
      const atkPower = b.attacker === 'leader' ? g._power(opp, 'leader') : g._power(opp, opp.characterArea[b.attacker]);
      const myLeaderPower = g._power(me, 'leader');
      if (atkPower >= myLeaderPower) {
        let blockerIdx = null, blockerPower = -1;
        me.characterArea.forEach((c, i) => {
          if (!c || c.rested) return;
          const card = getCard(c.cardId);
          if (!card || !card.keywords.includes('Blocker')) return;
          const p = g._power(me, c);
          // prefer a blocker that survives, else the cheapest one to lose
          const score = p >= atkPower ? 10000 + p : -(card.cost || 0);
          if (score > blockerPower) { blockerPower = score; blockerIdx = i; }
        });
        if (blockerIdx !== null && (blockerPower >= 10000 || me.life.length <= 2)) {
          g.respondBlock(this.seat, blockerIdx);
          return true;
        }
      }
    }
    g.respondBlock(this.seat, null);
    return true;
  }

  decideCounter(g, b, me, opp) {
    const atkPower = b.attacker === 'leader' ? g._power(opp, 'leader') : g._power(opp, opp.characterArea[b.attacker]);
    const baseDef = b.target === 'leader' ? g._power(me, 'leader') : g._power(me, me.characterArea[b.target]);
    const defPower = baseDef + (b.counterPower || 0);
    const deficit = atkPower - defPower; // need defPower > atkPower... rules: attacker wins ties, so need defPower > atkPower
    if (deficit >= 0) {
      // Find the cheapest counter card that flips the battle (need boost > deficit).
      let bestIdx = -1, bestBoost = Infinity, bestKind = null;
      me.hand.forEach((id, i) => {
        const c = getCard(id);
        if (!c) return;
        let boost = 0, kind = null;
        if (c.type === 'Character' && c.counter) { boost = c.counter; kind = 'char'; }
        else if (c.type === 'Event' && c.text && /\[Counter\]/.test(c.text)) {
          const m = c.text.match(/\[Counter\][^.]*?\+(\d+)\s*power/i);
          boost = m ? parseInt(m[1], 10) : 0; kind = 'event';
        }
        if (boost > deficit && boost < bestBoost) { bestBoost = boost; bestIdx = i; bestKind = kind; }
      });
      // Only spend a card to save the Leader, or to save a Character worth >= 4 cost.
      const worthIt = b.target === 'leader' || (getCard(me.characterArea[b.target].cardId).cost || 0) >= 4;
      if (bestIdx >= 0 && worthIt) {
        if (bestKind === 'char') g.playCounterCharacter(this.seat, bestIdx);
        else g.playCounterEvent(this.seat, bestIdx);
        return true; // next tick will re-evaluate (may now be safe) and finish
      }
    }
    g.respondCounter(this.seat, 0);
    return true;
  }
}

module.exports = { Bot, pickBotName };
