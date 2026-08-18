// Player settings — gameplay conveniences + audio. Stored in localStorage on this device
// (they're personal UI preferences, so they don't need an account). Load this BEFORE
// sfx.js / bgm.js / game.js. Same list on the Settings page and in the in-game ⚙ panel.
(function () {
  const KEY = 'gl_settings_v1';
  const DEFS = [
    { group: 'Gameplay', key: 'autoDraw', label: 'Auto Draw', desc: 'Automatically draw at the start of each of your turns without clicking a Draw button.', def: true },
    { group: 'Gameplay', key: 'autoSkipBlock', label: 'Auto Skip Block', desc: 'Automatically skip the Block step when you are attacked and have no active [Blocker].', def: false },
    { group: 'Gameplay', key: 'autoSkipTrigger', label: 'Auto Skip Trigger', desc: 'When a Life card you take has no [Trigger], add it to your hand automatically instead of asking. (Caution: your opponent can tell the card had no Trigger.)', def: false },
    { group: 'Gameplay', key: 'confirmDonAttach', label: 'Confirm DON!! Attach', desc: 'After choosing where a DON!! goes, ask you to confirm (or cancel) before it is attached.', def: false },
    { group: 'Gameplay', key: 'confirmEndTurn', label: 'Confirm End Turn', desc: 'The End Turn button must be clicked twice before your turn ends — no more accidental turn passes.', def: true },
    { group: 'Gameplay', key: 'dynamicPlaysheets', label: 'Dynamic Playsheets', desc: "Tint each player's side of the table in their Leader's color instead of one green mat for everyone.", def: true },
    { group: 'Gameplay', key: 'confirmCounter', label: 'Confirm Before Countering', desc: "Don't trash a Character card from your hand for its Counter until you confirm it.", def: false },
    { group: 'Gameplay', key: 'attachAllDon', label: 'Enable Attach All DON!!', desc: 'Show an "Attach ALL active DON!!" option next to the regular one-at-a-time attach.', def: false },
    { group: 'Audio', key: 'music', label: 'Music', desc: 'Background music: an original nautical instrumental loop. Starts after your first click on the page (browser rule).', def: true },
    { group: 'Audio', key: 'musicVolume', label: 'Music volume', desc: '', def: 35, type: 'range' },
    { group: 'Audio', key: 'sfxVolume', label: 'Sound effects volume', desc: '', def: 55, type: 'range' },
  ];
  const DEFAULTS = Object.fromEntries(DEFS.map((d) => [d.key, d.def]));
  let store = {};
  try { store = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { store = {}; }
  // legacy mute button state -> sfx volume 0
  try { if (localStorage.getItem('gl_sfx_muted') === '1' && store.sfxVolume === undefined) store.sfxVolume = 0; } catch (e) {}
  const listeners = [];

  function get(k) { return store[k] !== undefined ? store[k] : DEFAULTS[k]; }
  function set(k, v) {
    store[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
    listeners.forEach((fn) => { try { fn(k, v); } catch (e) {} });
  }
  function all() { const o = {}; DEFS.forEach((d) => { o[d.key] = get(d.key); }); return o; }
  function onChange(fn) { listeners.push(fn); }
  function reset() { store = {}; try { localStorage.removeItem(KEY); } catch (e) {} DEFS.forEach((d) => listeners.forEach((fn) => fn(d.key, d.def))); }

  // Renders the settings form into a container (used by settings.html and the in-game panel)
  function renderPanel(container, opts = {}) {
    const groups = [...new Set(DEFS.map((d) => d.group))];
    container.innerHTML = groups.map((g) => `
      <div class="settings-group">
        <h3 class="settings-group-title">${g}</h3>
        ${DEFS.filter((d) => d.group === g).map((d) => d.type === 'range' ? `
          <label class="setting-row range" data-key="${d.key}">
            <span class="setting-main"><span class="setting-label">${d.label}</span><span class="setting-value" data-val="${d.key}">${get(d.key)}%</span></span>
            <input type="range" min="0" max="100" step="5" value="${get(d.key)}" data-setting="${d.key}" />
          </label>` : `
          <label class="setting-row" data-key="${d.key}">
            <span class="switch"><input type="checkbox" data-setting="${d.key}" ${get(d.key) ? 'checked' : ''} /><span class="knob"></span></span>
            <span class="setting-main"><span class="setting-label">${d.label}</span>${d.desc ? `<span class="setting-desc">${d.desc}</span>` : ''}</span>
          </label>`).join('')}
      </div>`).join('') + (opts.showReset === false ? '' : `<div class="settings-actions"><button class="btn small secondary" data-settings-reset>Reset to defaults</button></div>`);
    container.querySelectorAll('[data-setting]').forEach((input) => {
      input.addEventListener('input', () => {
        const k = input.dataset.setting;
        if (input.type === 'checkbox') set(k, input.checked);
        else { set(k, Number(input.value)); const v = container.querySelector(`[data-val="${k}"]`); if (v) v.textContent = input.value + '%'; }
        if (input.type === 'checkbox' && window.SFX) SFX.play(input.checked ? 'toggle' : 'click');
      });
    });
    const rst = container.querySelector('[data-settings-reset]');
    if (rst) rst.onclick = () => { reset(); renderPanel(container, opts); };
  }

  window.Settings = { get, set, all, onChange, reset, renderPanel, DEFS };
})();
