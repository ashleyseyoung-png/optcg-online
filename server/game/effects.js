// Template-based auto-resolver for common card-effect text patterns.
// This is NOT a full rules engine for all ~2200 cards (that's not realistically
// hand-codeable) — it recognizes a curated set of frequent phrasings and computes
// their result automatically. Anything it doesn't recognize is handed back to the
// players as a "resolve manually" prompt with the printed text + generic board
// tools (move/KO/rest/draw/DON), so play stays fair and in sync either way.
'use strict';

// Each matcher: { re, describe(match), run(match, ctx) }
// ctx gives helpers: ctx.self, ctx.opp, ctx.game, ctx.chooseTargets(pool, count), etc.
// run() returns an object describing what happened (for animation/log), or
// { needsTarget: true, pool, min, max, apply(selectedIndexes) } if it needs the
// acting player to pick targets client-side before it can finish resolving.

const PATTERNS = [
  {
    key: 'draw_n',
    re: /Draw (\d+) cards?\b/i,
    run: (m, ctx) => ctx.draw(ctx.self, parseInt(m[1], 10)),
  },
  {
    key: 'ko_cost_or_less',
    re: /K\.?O\.? up to (\d+|1) of your opponent'?s Characters? with a cost of (\d+) or less/i,
    run: (m, ctx) => {
      const max = m[1].toLowerCase() === 'up to 1' || m[1] === '1' ? 1 : parseInt(m[1], 10) || 1;
      const cap = parseInt(m[2], 10);
      const pool = ctx.opp.characterArea
        .map((c, i) => ({ i, c }))
        .filter(({ c }) => c && ctx.cardCost(c.cardId) <= cap);
      return ctx.pickAndApply(pool.map((p) => p.i), 0, max, (idx) => ctx.koCharacter(ctx.opp, idx), 'opp');
    },
  },
  {
    key: 'ko_power_or_less',
    re: /K\.?O\.? up to 1 of your opponent'?s Characters? with (\d+) power or less/i,
    run: (m, ctx) => {
      const cap = parseInt(m[1], 10);
      const pool = ctx.opp.characterArea
        .map((c, i) => ({ i, c }))
        .filter(({ c }) => c && ctx.currentPower(ctx.opp, c) <= cap);
      return ctx.pickAndApply(pool.map((p) => p.i), 0, 1, (idx) => ctx.koCharacter(ctx.opp, idx), 'opp');
    },
  },
  {
    key: 'rest_opponent_cost_or_less',
    re: /Rest up to (\d+|1) of your opponent'?s Characters?(?: with a cost of (\d+) or less)?/i,
    run: (m, ctx) => {
      const max = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : 1;
      const cap = m[2] ? parseInt(m[2], 10) : Infinity;
      const pool = ctx.opp.characterArea
        .map((c, i) => ({ i, c }))
        .filter(({ c }) => c && !c.rested && ctx.cardCost(c.cardId) <= cap);
      return ctx.pickAndApply(pool.map((p) => p.i), 0, max, (idx) => ctx.setRested(ctx.opp, idx, true), 'opp');
    },
  },
  {
    key: 'power_buff_self_up_to_1',
    re: /Up to 1 of your Leader or Character cards? gains \+(\d+) power during this (battle|turn)/i,
    run: (m, ctx) => {
      const amt = parseInt(m[1], 10);
      const pool = ['leader', ...ctx.self.characterArea.map((c, i) => (c ? i : null)).filter((v) => v !== null)];
      return ctx.pickAndApply(pool, 0, 1, (target) => ctx.buffPower(ctx.self, target, amt), 'self');
    },
  },
  {
    key: 'debuff_opponent_up_to_1',
    re: /[Gg]ive up to 1 of your opponent'?s Characters? -(\d+) power during this turn/i,
    run: (m, ctx) => {
      const amt = -parseInt(m[1], 10);
      const pool = ctx.opp.characterArea.map((c, i) => (c ? i : null)).filter((v) => v !== null);
      return ctx.pickAndApply(pool, 0, 1, (target) => ctx.buffPower(ctx.opp, target, amt), 'opp');
    },
  },
  {
    key: 'add_don_from_deck_rested',
    re: /[Aa]dd up to 1 DON!! card from your DON!! deck and rest it/i,
    run: (m, ctx) => ctx.addDonFromDeck(ctx.self, 1, true),
  },
  {
    key: 'add_don_from_deck_active',
    re: /[Aa]dd up to 1 DON!! card from your DON!! deck and set it as active/i,
    run: (m, ctx) => ctx.addDonFromDeck(ctx.self, 1, false),
  },
  {
    key: 'set_active_own',
    re: /[Ss]et up to 1 of your (?:DON!! cards|Characters) as active/i,
    run: (m, ctx) => ({ manual: true }), // ambiguous target type — defer to manual tools
  },
  {
    key: 'trash_from_hand_n',
    re: /trash (\d+) cards? from your hand/i,
    run: (m, ctx) => ctx.trashFromHand(ctx.self, parseInt(m[1], 10)),
  },
  {
    key: 'opponent_trashes_n',
    re: /your opponent trashes (\d+) cards? from their hand/i,
    run: (m, ctx) => ctx.trashFromHand(ctx.opp, parseInt(m[1], 10)),
  },
];

function tryAutoResolve(effectText, ctx) {
  for (const pattern of PATTERNS) {
    const m = effectText.match(pattern.re);
    if (m) {
      try {
        const result = pattern.run(m, ctx);
        if (result) return { matched: true, key: pattern.key, ...result };
      } catch (e) {
        return { matched: false, error: e.message };
      }
    }
  }
  return { matched: false };
}

module.exports = { tryAutoResolve, PATTERNS };
