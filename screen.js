// Piano Highway visualization plugin — Synthesia-style scrolling
// piano renderer with MIDI keyboard input, WebAudioFont synthesizer,
// and accuracy scoring.
//
// Wave C (slopsmith#36): per-instance refactor. Earlier Wave B
// landed setRenderer support with an explicit single-instance
// module-state assumption. Wave C lifts that: rendering, scoring,
// display range, settings UI, held-notes state, and listeners are
// now all per-instance (closured inside createFactory). Main-player
// usage keeps its single-instance fast path via the
// window.slopsmithSplitscreen helper surface — its absence OR
// isActive()===false means "we're the only instance, always
// focused."
//
// Under splitscreen (N panels, N simultaneous piano instances):
//   - each panel hosts its own overlay canvas, scoring, display
//     range, settings panel + gear docked inside the panel's bar
//   - MIDI input is a browser singleton; the currently-focused
//     panel (clicked most recently) is the sole recipient of
//     note-on / note-off / sustain events
//   - focus-change releases held notes on the outgoing panel and
//     starts fresh on the incoming one
//   - settings changes persist into _cfg and are reflected on the
//     next open of any other panel's settings.
//
// song:ready event subscription is gone: each draw() edge-detects
// bundle.isReady false→true per-instance, which is correct for N
// panels without the cross-instance fan-out of the global bus.

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════

const KEYS_PATTERNS = /\b(?:keys|piano|keyboard|synth)\b/i;
const VISIBLE_SECONDS = 3.0;
const NOW_LINE_Y_FRAC = 0.82;
const KEYBOARD_H_FRAC = 0.15;
const NOTE_LABEL_MIN_H = 16;
const HIT_TOLERANCE = 0.10;        // seconds

// ── Persisted settings ───────────────────────────────────────────────

const STORE_KEYS = {
    midiInputId:   'piano_midi_input',
    instrumentIdx: 'piano_instrument',
    synthVolume:   'piano_synth_vol',
    midiChannel:   'piano_midi_ch',
    transpose:     'piano_transpose',
    showNoteNames: 'piano_note_names',
    hitDetection:  'piano_hit_detect',
};

function _readStore(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}

const _cfg = {
    midiInputId:   _readStore(STORE_KEYS.midiInputId) || '',
    instrumentIdx: parseInt(_readStore(STORE_KEYS.instrumentIdx) || '0'),
    synthVolume:   parseFloat(_readStore(STORE_KEYS.synthVolume) || '0.7'),
    midiChannel:   parseInt(_readStore(STORE_KEYS.midiChannel) || '-1'),
    transpose:     parseInt(_readStore(STORE_KEYS.transpose) || '0'),
    showNoteNames: _readStore(STORE_KEYS.showNoteNames) !== 'false',
    hitDetection:  _readStore(STORE_KEYS.hitDetection) === 'true',
};

function _saveCfg(key, val) {
    _cfg[key] = val;
    const storeKey = STORE_KEYS[key];
    if (!storeKey) return;
    try { localStorage.setItem(storeKey, String(val)); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════
// Module-level singletons (browser-unique resources)
// ═══════════════════════════════════════════════════════════════════════

// ── MIDI input ────────────────────────────────────────────────────────
// MIDI is sourced from the core `midi-input` capability domain
// (window.slopsmith.midiInput) rather than a private requestMIDIAccess() — one
// device-access boundary shared with drums/keys/onboarding.
let _midiReady = false;      // discover() has run
let _midiHandle = null;      // live domain session handle (addListener/removeListener)
let _midiListener = null;    // the addListener callback wrapping _midiOnMessage
let _midiStateSub = false;   // subscribed to midi-input:sources-changed
let _midiInput = null;       // selected source descriptor { id, name, key } (UI selection state)
let _midiActive = false;     // gates the live listener wiring
let _midiConnectSeq = 0;     // generation guard for async _midiConnect races
// Wave C: routes incoming MIDI events to the currently-focused piano
// instance (null when no instance is active). Instances claim this
// on focus-change and release it on defocus / destroy.
let _activeInstance = null;
// Registry of live factory instances so module-level helpers (device-
// list refresh, shutdown-when-last-destroys) can iterate.
const _instances = new Set();
// Monotonic id for per-instance DOM tagging (useful for debugging).
let _nextInstanceId = 0;

// ── Synth ─────────────────────────────────────────────────────────────
let _audioCtx = null;
let _synthPlayer = null;
let _synthPreset = null;
let _synthGain = null;
const _noteEnvelopes = new Map();   // shared: transposed midi → envelope
let _synthLoading = false;
let _playerScriptLoaded = false;

// ═══════════════════════════════════════════════════════════════════════
// MIDI / Color Helpers
// ═══════════════════════════════════════════════════════════════════════

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteToMidi(string, fret) { return string * 24 + fret; }

function midiToNoteName(midi) {
    return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

function isBlackKey(midi) {
    const pc = midi % 12;
    return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

function _noteKey(time, midi) {
    return time.toFixed(3) + '|' + midi;
}

// ── Neon rainbow per chromatic note (Openthesia-style) ────────────────

const NEON_RGB = [
    [1.0, 0.2, 0.3],
    [1.0, 0.4, 0.4],
    [1.0, 0.9, 0.2],
    [1.0, 0.8, 0.4],
    [0.2, 0.8, 1.0],
    [1.0, 0.6, 0.1],
    [1.0, 0.5, 0.3],
    [0.3, 1.0, 0.3],
    [0.4, 1.0, 0.4],
    [0.6, 0.3, 1.0],
    [0.7, 0.4, 1.0],
    [1.0, 0.3, 1.0],
];

function _neonRGB(midi) { return NEON_RGB[midi % 12]; }

function _rgbStr(r, g, b, a) {
    return a !== undefined
        ? `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`
        : `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`;
}

// ═══════════════════════════════════════════════════════════════════════
// Instruments (WebAudioFont — GM via JCLive soundfont)
// ═══════════════════════════════════════════════════════════════════════

const WAF_BASE = 'https://surikov.github.io/webaudiofontdata/sound/';
const WAF_PLAYER_URL = 'https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js';
const WAF_SF = 'JCLive_sf2_file';

const INSTRUMENTS = [
    { name: 'Grand Piano',    gm: 0  },
    { name: 'Electric Piano',  gm: 4  },
    { name: 'Honky-tonk',      gm: 3  },
    { name: 'Organ',            gm: 19 },
    { name: 'Strings',          gm: 48 },
    { name: 'Synth Lead',       gm: 80 },
    { name: 'Synth Pad',        gm: 88 },
    { name: 'Harpsichord',      gm: 6  },
    { name: 'Vibraphone',       gm: 11 },
    { name: 'Music Box',        gm: 10 },
];

function _wafFile(gm) {
    return String(gm * 10).padStart(4, '0') + '_' + WAF_SF;
}
function _wafVar(gm)  { return '_tone_' + _wafFile(gm); }
function _wafUrl(gm)  { return WAF_BASE + _wafFile(gm) + '.js'; }

function _loadScript(url) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load ' + url));
        document.head.appendChild(s);
    });
}

// ═══════════════════════════════════════════════════════════════════════
// WebAudioFont synth (module-level — one audio context per tab)
// ═══════════════════════════════════════════════════════════════════════

async function _synthInit() {
    if (_synthPlayer) return;
    try {
        if (!_playerScriptLoaded) {
            await _loadScript(WAF_PLAYER_URL);
            _playerScriptLoaded = true;
        }
        if (typeof WebAudioFontPlayer === 'undefined') return;

        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        _synthGain = _audioCtx.createGain();
        _synthGain.gain.value = _cfg.synthVolume;
        _synthGain.connect(_audioCtx.destination);
        _synthPlayer = new WebAudioFontPlayer();

        await _synthLoadInstrument(_cfg.instrumentIdx);
    } catch (e) {
        console.warn('[Piano] Synth init failed:', e);
    }
}

async function _synthLoadInstrument(idx) {
    const inst = INSTRUMENTS[idx];
    if (!inst || !_synthPlayer || !_audioCtx) return;
    _synthLoading = true;
    const varName = _wafVar(inst.gm);

    try {
        if (!window[varName]) {
            await _loadScript(_wafUrl(inst.gm));
        }
        const preset = window[varName];
        if (preset) {
            _synthPlayer.adjustPreset(_audioCtx, preset);
            _synthPreset = preset;
        }
    } catch (e) {
        console.warn('[Piano] Failed to load instrument:', inst.name, e);
    }
    _synthLoading = false;
}

function _synthEnsureCtx() {
    if (_audioCtx && _audioCtx.state === 'suspended') {
        _audioCtx.resume();
    }
}

function _synthNoteOn(midi, velocity) {
    if (!_synthPlayer || !_synthPreset || !_audioCtx || !_synthGain) return;
    _synthEnsureCtx();

    const existing = _noteEnvelopes.get(midi);
    if (existing) { try { existing.cancel(); } catch (_) {} }

    const vol = (velocity / 127) * _cfg.synthVolume;
    const envelope = _synthPlayer.queueWaveTable(
        _audioCtx, _synthGain, _synthPreset, 0, midi, 999, vol
    );
    _noteEnvelopes.set(midi, envelope);
}

function _synthNoteOff(midi) {
    const env = _noteEnvelopes.get(midi);
    if (env) {
        try { env.cancel(); } catch (_) {}
        _noteEnvelopes.delete(midi);
    }
}

function _synthReleaseAll() {
    for (const env of _noteEnvelopes.values()) {
        try { env.cancel(); } catch (_) {}
    }
    _noteEnvelopes.clear();
}

function _synthSetVolume(vol) {
    _saveCfg('synthVolume', vol);
    if (_synthGain) _synthGain.gain.value = vol;
}

// ═══════════════════════════════════════════════════════════════════════
// Web MIDI input (module-level — one MIDI access per tab)
// ═══════════════════════════════════════════════════════════════════════

// The core midi-input domain, if present (it ships with core).
function _mi() {
    const m = window.slopsmith && window.slopsmith.midiInput;
    return (m && m.version === 1) ? m : null;
}

// Domain sources shaped like the old MIDIInput list: { id, name, key }.
// sourceId == the old MIDIInput.id, so stored `midiInputId` stays compatible.
function _midiSources() {
    const mi = _mi();
    if (!mi) return [];
    return mi.listSources().map(s => ({ id: s.sourceId, name: s.label, key: s.logicalSourceKey }));
}

// In-flight guard around discover(): splitscreen calls _midiInit() once per
// instance; N concurrent inits would otherwise issue N discover() calls (each a
// requestMIDIAccess via the provider) and race through _midiAutoConnect() before
// the first resolves. Concurrent inits share the same discovery attempt.
let _midiInitPromise = null;

async function _midiInit() {
    const mi = _mi();
    if (!mi) return;
    // Already discovered: re-run auto-connect so a re-mount after a full release
    // (or a settings re-open) reconnects from the saved pick instead of no-opping.
    // Already discovered: only (re)connect when there's no live session. A
    // repeated _midiInit (settings panel open, extra splitscreen instance) must
    // NOT re-enter _midiConnect on an active handle — that tears down the live
    // session and releases held notes for no reason. After a full release the
    // handle is null, so reconnect happens then.
    if (_midiReady) { if (!_midiHandle) _midiAutoConnect(); return; }
    if (_midiInitPromise) return _midiInitPromise;
    _midiInitPromise = (async () => {
        try {
            const r = await mi.discover();  // permission boundary (requestMIDIAccess)
            // Only latch ready on a successful discovery — a denied/unavailable
            // outcome must NOT latch, or reopening the panel never retries and MIDI
            // stays unavailable until a page reload.
            if (!r || r.outcome !== 'handled') return;
            _midiReady = true;
            // Refresh device lists on plug/unplug (replaces MIDIAccess.onstatechange).
            if (!_midiStateSub && window.slopsmith && typeof window.slopsmith.on === 'function') {
                _midiStateSub = true;
                window.slopsmith.on('midi-input:sources-changed', () => _midiReconcileSources());
            }
            _midiAutoConnect();
            // Populate whatever settings panels are open.
            _midiUpdateAllDeviceLists();
        } catch (e) {
            console.warn('[Piano] MIDI access denied:', e);
        } finally {
            // On success future calls short-circuit on `_midiReady`; on rejection,
            // releasing the slot lets a later init() retry.
            _midiInitPromise = null;
        }
    })();
    return _midiInitPromise;
}

// Plug/unplug reconciliation (midi-input:sources-changed). The domain closes +
// deletes a session when its device is unplugged, so refreshing the dropdown
// isn't enough: if OUR selected device vanished, drop the now-stale
// handle/selection (keeping _midiActive) and re-auto-connect — that reattaches
// the saved device when it's replugged, or falls back to another input. Then
// refresh the dropdowns. If the selected device is unaffected, just refresh.
function _midiReconcileSources() {
    if (_midiInput && !_midiSources().some(s => s.key === _midiInput.key)) {
        if (_midiHandle && _midiListener) { try { _midiHandle.removeListener(_midiListener); } catch (_) { /* best-effort */ } }
        _midiHandle = null;
        _midiListener = null;
        _midiInput = null;
        // No note-off can arrive for keys held at unplug — release sounding +
        // per-instance held state so no key stays stuck until the next note-on.
        _synthReleaseAll();
        for (const inst of _instances) {
            if (inst && typeof inst._releaseAllHeld === 'function') inst._releaseAllHeld();
        }
    }
    // Reconnect ONLY to the saved device when it's (re)present. Don't fall back to
    // another input here: _midiConnect persists its id, so a fallback during a
    // transient unplug would overwrite the user's saved device (the original
    // returns on replug and reconnects then). A deliberate switch goes via the UI.
    if (!_midiInput) {
        const sources = _midiSources();
        const raw = _readStore(STORE_KEYS.midiInputId);
        if (raw === '') {
            // explicit None — stay disconnected.
        } else {
            const key = _midiResolveSaved(raw, sources);
            if (key) _midiConnect(key);                              // saved device present → reconnect
            else if (raw == null && sources.length) _midiConnect(sources[0].key);  // never picked → first-hotplug
            // else: a saved pick exists but is absent → preserve (reconnect on replug)
        }
    }
    _midiUpdateAllDeviceLists();
}

// Resolve a persisted selection to a current source's logicalSourceKey. Handles
// both the new logicalSourceKey storage AND legacy bare web-midi sourceId saves
// (pre-domain), returning the canonical key, or null when the device is absent.
function _midiResolveSaved(saved, sources) {
    if (!saved) return null;
    let m = sources.find(s => s.key === saved);    // new: stored logicalSourceKey
    if (!m) m = sources.find(s => s.id === saved);  // legacy: bare web-midi sourceId
    return m ? m.key : null;
}

function _midiAutoConnect() {
    const sources = _midiSources();
    if (!sources.length) return;

    const raw = _readStore(STORE_KEYS.midiInputId);
    if (raw === '') return;  // explicit "None" opt-out

    // Resolve the saved selection (logicalSourceKey, or a legacy sourceId) and
    // fall back to the first input when it's absent.
    _midiConnect(_midiResolveSaved(raw, sources) || sources[0].key);
}

async function _midiConnect(key) {
    const myGen = ++_midiConnectSeq;
    const mi = _mi();
    // Tear down any existing live session.
    if (_midiHandle && _midiListener) { try { _midiHandle.removeListener(_midiListener); } catch (_) { /* best-effort */ } }
    if (mi && _midiInput) { try { mi.close({ requester: 'piano', logicalSourceKey: _midiInput.key }); } catch (_) { /* best-effort */ } }
    _midiHandle = null;
    _midiListener = null;
    _midiInput = null;

    // Release anything currently sounding + clear per-instance held state on
    // EVERY live instance, not just the focused one (see splitscreen notes).
    _synthReleaseAll();
    for (const inst of _instances) {
        if (inst && typeof inst._releaseAllHeld === 'function') {
            inst._releaseAllHeld();
        }
    }

    // Store the globally-unique logicalSourceKey (not the provider-local
    // sourceId). Empty key is the explicit "None" opt-out.
    _saveCfg('midiInputId', key || '');

    if (!key || !mi) {
        _midiUpdateAllDeviceLists();
        return;
    }
    const src = _midiSources().find(s => s.key === key);
    if (!src) { _midiUpdateAllDeviceLists(); return; }
    _midiInput = { id: src.id, name: src.name, key: src.key };   // selection descriptor for the UI
    // No live renderer to consume OR release a session — don't hold one open
    // (settings-only init, or the last instance was torn down during async
    // discovery). The pick is saved; a later renderer mount re-runs auto-connect
    // and opens for real, and its destroy() releases it.
    if (_instances.size === 0) { _midiUpdateAllDeviceLists(); return; }
    try {
        await mi.select(src.key);
        const res = await mi.open({ requester: 'piano', logicalSourceKey: src.key });
        // A newer _midiConnect (rapid device switch / None) superseded us while
        // we awaited — discard this open so we don't install a stale handle.
        if (myGen !== _midiConnectSeq) {
            if (!_midiInput || _midiInput.key !== src.key) { try { mi.close({ requester: 'piano', logicalSourceKey: src.key }); } catch (_) { /* best-effort */ } }
            return;
        }
        if (res && res.handle) {
            _midiHandle = res.handle;
            // The domain handle delivers raw MIDI data; adapt to the old
            // MIDIMessageEvent shape so _midiOnMessage stays unchanged.
            _midiListener = (data) => _midiOnMessage({ data });
            if (_midiActive) _midiHandle.addListener(_midiListener);
        } else {
            // Open yielded no live handle (device vanished post-discovery, or the
            // provider reported denied/unavailable). Clear the selection so the UI
            // doesn't show a phantom connected device and miss-counting stays off.
            _midiInput = null;
        }
    } catch (e) {
        console.warn('[Piano] MIDI open failed:', e);
        // Only clear if we're still the current connect — a stale older open's
        // rejection (rapid switch / autoconnect racing a manual pick) must not
        // wipe a newer connect's already-installed _midiInput/_midiHandle (which
        // would also leak the live handle, since closes are gated on _midiInput).
        if (myGen === _midiConnectSeq) _midiInput = null;
    }
    _midiUpdateAllDeviceLists();
}

function _midiResumeHandler() {
    // Idempotent: a second instance init (splitscreen / re-init) calls this while
    // already active. The domain handle's addListener is Set-backed, but don't
    // rely on the provider de-duping — re-adding could double-deliver each MIDI
    // event to the focused instance, doubling note-ons/hits.
    if (_midiActive) return;
    _midiActive = true;
    if (_midiHandle && _midiListener) { try { _midiHandle.addListener(_midiListener); } catch (_) { /* best-effort */ } }
}

// Called when the LAST live instance is torn down. Fully release the shared
// midi-input domain session (not just the listener), so the device/provider
// session isn't held open after the visualization is gone — and the core domain
// can close the device once other consumers release it too. Reset readiness so a
// later re-mount re-discovers and auto-connects from the saved pick.
function _midiReleaseSession() {
    _midiConnectSeq += 1;   // invalidate any in-flight _midiConnect open
    if (_midiHandle && _midiListener) { try { _midiHandle.removeListener(_midiListener); } catch (_) { /* best-effort */ } }
    const mi = _mi();
    if (mi && _midiInput) { try { mi.close({ requester: 'piano', logicalSourceKey: _midiInput.key || ('web-midi::' + _midiInput.id) }); } catch (_) { /* best-effort */ } }
    _midiActive = false;
    _midiHandle = null;
    _midiListener = null;
    _midiInput = null;
    // Intentionally leave _midiReady latched and _midiInitPromise alone: _midiInit
    // re-runs _midiAutoConnect on a ready re-mount (no re-discover needed), and
    // clearing the in-flight promise here would let a quick remount during a
    // pending discover() start a SECOND requestMIDIAccess, defeating the guard.
    // The in-flight init clears its own promise in its finally.
}

function _midiOnMessage(e) {
    // Only the focused instance receives MIDI. Module-level
    // _activeInstance is the routing slot; it points at null when
    // no instance is focused (splitscreen toggled off mid-session
    // between teardowns, or no instance initialised yet).
    if (!_activeInstance) return;

    const [status, note, velocity] = e.data;
    const ch = status & 0x0F;
    if (_cfg.midiChannel >= 0 && ch !== _cfg.midiChannel) return;

    const cmd = status & 0xF0;

    // Pass the RAW MIDI note number to instance handlers; the
    // instance applies transpose internally and remembers the
    // played value so a transpose change between note-on and
    // note-off can't strand a held note. Computing transpose
    // here would compute a different "transposed" for the same
    // raw note across messages, leaving the synth + held state
    // pointing at the wrong key.
    if (cmd === 0x90 && velocity > 0) {
        _activeInstance._handleNoteOn(note, velocity);
    } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
        _activeInstance._handleNoteOff(note);
    } else if (cmd === 0xB0 && note === 64) {
        _activeInstance._handleSustain(velocity >= 64);
    }
}

function _midiUpdateAllDeviceLists() {
    const inputs = _midiSources();

    // Every instance's settings panel (if open) has a
    // `.piano-midi-select` node. Iterate all of them so a
    // device plug/unplug reflects everywhere simultaneously.
    const selects = document.querySelectorAll('.piano-midi-select');
    for (const sel of selects) {
        sel.textContent = '';
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = 'None';
        sel.appendChild(noneOpt);
        for (const inp of inputs) {
            const opt = document.createElement('option');
            opt.value = inp.key;
            opt.textContent = inp.name || inp.manufacturer || inp.id || 'Unknown device';
            if (_midiInput && _midiInput.key === inp.key) opt.selected = true;
            sel.appendChild(opt);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Pure drawing / geometry helpers (stateless)
// ═══════════════════════════════════════════════════════════════════════

function buildKeyLayout(lo, hi, areaX, areaW) {
    const keys = [];
    let whiteCount = 0;
    for (let m = lo; m <= hi; m++) {
        if (!isBlackKey(m)) whiteCount++;
    }
    if (whiteCount === 0) return keys;

    const whiteW = areaW / whiteCount;
    const blackW = whiteW * 0.6;

    let wx = areaX;
    for (let m = lo; m <= hi; m++) {
        if (!isBlackKey(m)) {
            keys.push({ midi: m, x: wx, w: whiteW, black: false });
            wx += whiteW;
        }
    }
    for (let m = lo; m <= hi; m++) {
        if (!isBlackKey(m)) continue;
        const prevWhite = keys.find(k => !k.black && k.midi === m - 1);
        if (prevWhite) {
            keys.push({ midi: m, x: prevWhite.x + prevWhite.w - blackW / 2, w: blackW, black: true });
        }
    }
    return keys;
}

function keyForMidi(midi, layout) {
    for (const k of layout) {
        if (k.midi === midi) return k;
    }
    return null;
}

function _timeToY(dt, nowLineY, topY) {
    if (dt <= 0) return nowLineY + (-dt / 0.3) * 20;
    const frac = dt / VISIBLE_SECONDS;
    return nowLineY - frac * (nowLineY - topY);
}

function _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function _roundRectBottom(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.closePath();
}

function detectRange(notes, chords) {
    let lo = 127, hi = 0;
    if (notes) {
        for (const n of notes) {
            const m = noteToMidi(n.s, n.f);
            if (m < lo) lo = m;
            if (m > hi) hi = m;
        }
    }
    if (chords) {
        for (const c of chords) {
            for (const cn of (c.notes || [])) {
                const m = noteToMidi(cn.s, cn.f);
                if (m < lo) lo = m;
                if (m > hi) hi = m;
            }
        }
    }
    if (lo > hi) { lo = 48; hi = 84; }
    lo = Math.max(0, Math.floor(lo / 12) * 12);
    hi = Math.min(127, Math.ceil((hi + 1) / 12) * 12 - 1);
    while (hi - lo < 47) { hi = Math.min(127, hi + 12); if (hi - lo < 47 && lo > 0) lo -= 12; }
    return { lo, hi };
}

function _visibleMidiRange(notes, chords, t) {
    let lo = 127, hi = 0;
    const tMax = t + VISIBLE_SECONDS;

    if (notes) {
        for (const n of notes) {
            const end = n.t + (n.sus || 0);
            if (end < t - 0.1) continue;
            if (n.t > tMax) break;
            const m = noteToMidi(n.s, n.f);
            if (m < lo) lo = m;
            if (m > hi) hi = m;
        }
    }
    if (chords) {
        for (const c of chords) {
            if (c.t < t - 0.1) continue;
            if (c.t > tMax) break;
            for (const cn of (c.notes || [])) {
                const m = noteToMidi(cn.s, cn.f);
                if (m < lo) lo = m;
                if (m > hi) hi = m;
            }
        }
    }
    return lo <= hi ? { lo, hi } : null;
}

function _approachAlpha(midi, notes, chords, t) {
    const lookAhead = VISIBLE_SECONDS * 0.6;
    let closest = Infinity;
    if (notes) {
        for (const n of notes) {
            if (n.t < t - 0.05) continue;
            if (n.t > t + lookAhead) break;
            if (noteToMidi(n.s, n.f) === midi) {
                closest = Math.min(closest, n.t - t);
            }
        }
    }
    if (chords) {
        for (const c of chords) {
            if (c.t < t - 0.05) continue;
            if (c.t > t + lookAhead) break;
            for (const cn of (c.notes || [])) {
                if (noteToMidi(cn.s, cn.f) === midi) {
                    closest = Math.min(closest, c.t - t);
                }
            }
        }
    }
    if (closest === Infinity) return 0;
    return Math.max(0, 1 - closest / lookAhead);
}

// ═══════════════════════════════════════════════════════════════════════
// Splitscreen helper wrappers
// ═══════════════════════════════════════════════════════════════════════
//
// Centralise the "am I in splitscreen?" / "which panel are my chrome
// anchors?" queries so instance code can read the runtime environment
// cheaply. Absence of window.slopsmithSplitscreen OR isActive()===false
// means "main-player, always focused" from the plugin's POV.

function _ssActive() {
    const ss = window.slopsmithSplitscreen;
    if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
    // Validate the FULL surface this plugin consumes, not just
    // isActive(). If a future splitscreen build ships partial
    // helpers (or an older bundled splitscreen lacks one of the
    // newer methods), report "not active" so the wrappers fall
    // back to the main-player single-instance fast path rather
    // than reaching a half-broken splitscreen state where focus
    // never lands on any instance and MIDI routing dies.
    return typeof ss.isCanvasFocused === 'function'
        && typeof ss.panelChromeFor === 'function'
        && typeof ss.settingsAnchorFor === 'function'
        && typeof ss.onFocusChange === 'function'
        && typeof ss.offFocusChange === 'function';
}

function _ssPanelChrome(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return (ss && typeof ss.panelChromeFor === 'function')
        ? ss.panelChromeFor(highwayCanvas) : null;
}

function _ssSettingsAnchor(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return (ss && typeof ss.settingsAnchorFor === 'function')
        ? ss.settingsAnchorFor(highwayCanvas) : null;
}

function _ssIsCanvasFocused(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return true;  // main-player fast path
    return !!(ss && typeof ss.isCanvasFocused === 'function' &&
              ss.isCanvasFocused(highwayCanvas));
}

// ═══════════════════════════════════════════════════════════════════════
// Factory — slopsmith#36 setRenderer contract (multi-instance)
// ═══════════════════════════════════════════════════════════════════════

function createFactory() {
    const _instanceId = ++_nextInstanceId;

    // Lifecycle
    let _isReady = false;

    // Rendering state
    let _pianoCanvas = null;
    let _pianoCtx = null;
    let _highwayCanvas = null;
    let _prevHighwayDisplay = '';

    // Controls-style snapshot — only populated when we actually nudged
    // `#player-controls`, which is main-player-only. Splitscreen panels
    // already have their control bar layered above the canvas.
    let _controlsStyleTouched = false;
    let _prevControlsPosition = '';
    let _prevControlsZIndex = '';
    let _controlsAnchor = null;

    // Settings UI
    let _settingsPanel = null;
    let _settingsGear = null;
    let _settingsVisible = false;

    // MIDI held / sustain state — per-instance so each panel's
    // keyboard only shows the keys ITS user is holding, not
    // keys held on another focused panel.
    //
    // _heldNotes / _sustainedNotes are keyed by the TRANSPOSED
    // (played) midi value because that's what the keyboard draws
    // and the synth plays. _rawToPlayed is the cross-reference
    // so note-off can release the EXACT same key its matching
    // note-on opened, even if _cfg.transpose changed in between.
    // Without it, a transpose change while a note is held would
    // strand the synth envelope + the visual "held" state until
    // focus / device / destroy released them.
    const _heldNotes = new Map();
    let _sustainOn = false;
    const _sustainedNotes = new Set();
    const _rawToPlayed = new Map();

    // Scoring
    let _hits = 0, _misses = 0, _streak = 0, _bestStreak = 0;
    const _hitNoteKeys = new Set();
    const _wrongFlashes = [];
    const _missedNoteKeys = new Set();

    // Display range cache
    let _displayLo = null, _displayHi = null;
    let _cachedLayout = null, _lastLayoutW = 0;
    let _lastRangeLo = -1, _lastRangeHi = -1;

    // Latest bundle snapshot — cached each frame so MIDI handler
    // (async wrt draw) can score against the filter-aware chart
    // the user sees.
    let _latestNotes = null, _latestChords = null, _latestTime = 0;

    // Wave C: replace the module-level `song:ready` subscription
    // with a bundle.isReady edge-detect per-instance. The global
    // event fires N times under splitscreen (once per panel's
    // highway); edge-detecting locally scopes the reset correctly.
    let _lastBundleIsReady = false;

    // Wave C focus state
    let _isFocused = false;

    // ── Listener refs (per-instance so destroy() detach matches) ──
    const _onWinResize = () => _applyCanvasDims();
    const _onFocusChange = () => _updateFocusState();

    // ── Focus management ──
    //
    // _instanceDestroyed is a belt-and-suspenders gate: even if the
    // splitscreen helper ever ships without an unsubscribe (or a
    // future version renames offFocusChange), the focus-change
    // handler will no-op against a destroyed instance rather than
    // mutating torn-down state. Defensive because the helper's
    // unsubscribe pathway is the only thing standing between a
    // lingering listener and a stale closure.
    let _instanceDestroyed = false;

    function _updateFocusState() {
        if (_instanceDestroyed) return;
        // _highwayCanvas is nulled by _teardown; a focus-change
        // callback fired between destroy() and the handler
        // detaching would otherwise call isCanvasFocused(null).
        if (!_highwayCanvas) return;
        const shouldFocus = _ssIsCanvasFocused(_highwayCanvas);
        if (shouldFocus && !_isFocused) {
            _isFocused = true;
            _activeInstance = instance;
        } else if (!shouldFocus && _isFocused) {
            _isFocused = false;
            _releaseAllHeld();
            if (_activeInstance === instance) _activeInstance = null;
        }
    }

    // Called by _midiConnect and focus-change to clear any held
    // state that was being visualised when focus / device switches.
    function _releaseAllHeld() {
        for (const midi of _heldNotes.keys()) _synthNoteOff(midi);
        _heldNotes.clear();
        _sustainedNotes.clear();
        _rawToPlayed.clear();
        _sustainOn = false;
    }

    // ── MIDI event handlers (called by _midiOnMessage via _activeInstance) ──
    //
    // These receive the RAW midi note from the device. Transpose is
    // applied here and the resulting `played` value is stored under
    // the raw note so note-off can find it even if _cfg.transpose
    // shifted between the matching note-on and note-off.

    function _handleNoteOn(rawMidi, velocity) {
        if (rawMidi < 0 || rawMidi > 127) return;
        const played = rawMidi + _cfg.transpose;
        if (played < 0 || played > 127) return;
        _rawToPlayed.set(rawMidi, played);
        _heldNotes.set(played, velocity);
        _synthNoteOn(played, velocity);
        _synthEnsureCtx();
        if (_cfg.hitDetection) _checkHit(played);
    }

    function _handleNoteOff(rawMidi) {
        if (rawMidi < 0 || rawMidi > 127) return;
        const played = _rawToPlayed.get(rawMidi);
        // Stray note-off (no matching note-on, or already released).
        // Common after a focus / device switch that cleared held
        // state, or a transpose change that's been followed by a
        // note-on at the same raw midi (the most recent note-on
        // overwrites the entry, which is correct: only the latest
        // played value is the "real" held key).
        if (played == null) return;
        _rawToPlayed.delete(rawMidi);
        if (_sustainOn) {
            _sustainedNotes.add(played);
            return;
        }
        _heldNotes.delete(played);
        _synthNoteOff(played);
    }

    function _handleSustain(down) {
        if (down) {
            _sustainOn = true;
        } else {
            _sustainOn = false;
            for (const midi of _sustainedNotes) {
                _heldNotes.delete(midi);
                _synthNoteOff(midi);
            }
            _sustainedNotes.clear();
        }
    }

    // ── Hit detection / accuracy scoring ──

    function _checkHit(playedMidi) {
        const t = _latestTime;
        const notes = _latestNotes;
        const chords = _latestChords;

        const notesEmpty = !notes || notes.length === 0;
        const chordsEmpty = !chords || chords.length === 0;
        if (notesEmpty && chordsEmpty) return;

        let foundHit = false;

        if (notes) {
            for (const n of notes) {
                if (n.t > t + HIT_TOLERANCE + 0.5) break;
                if (n.t < t - HIT_TOLERANCE - 0.5) continue;
                const songMidi = noteToMidi(n.s, n.f);
                const key = _noteKey(n.t, songMidi);
                if (songMidi === playedMidi && Math.abs(n.t - t) <= HIT_TOLERANCE && !_hitNoteKeys.has(key)) {
                    _hitNoteKeys.add(key);
                    foundHit = true;
                    break;
                }
            }
        }

        if (!foundHit && chords) {
            for (const c of chords) {
                if (c.t > t + HIT_TOLERANCE + 0.5) break;
                if (c.t < t - HIT_TOLERANCE - 0.5) continue;
                for (const cn of (c.notes || [])) {
                    const songMidi = noteToMidi(cn.s, cn.f);
                    const key = _noteKey(c.t, songMidi);
                    if (songMidi === playedMidi && Math.abs(c.t - t) <= HIT_TOLERANCE && !_hitNoteKeys.has(key)) {
                        _hitNoteKeys.add(key);
                        foundHit = true;
                        break;
                    }
                }
                if (foundHit) break;
            }
        }

        if (foundHit) {
            _hits++;
            _streak++;
            if (_streak > _bestStreak) _bestStreak = _streak;
        } else {
            _misses++;
            _streak = 0;
            _wrongFlashes.push({ midi: playedMidi, wall: performance.now() });
        }
    }

    function _updateMissedNotes(t, notes, chords) {
        if (!_cfg.hitDetection) return;
        const cutoff = t - HIT_TOLERANCE - 0.05;

        if (notes) {
            for (const n of notes) {
                if (n.t > cutoff) break;
                if (n.t < cutoff - 2) continue;
                const songMidi = noteToMidi(n.s, n.f);
                const key = _noteKey(n.t, songMidi);
                if (!_hitNoteKeys.has(key) && !_missedNoteKeys.has(key) && n.t < cutoff) {
                    _missedNoteKeys.add(key);
                }
            }
        }
        if (chords) {
            for (const c of chords) {
                if (c.t > cutoff) break;
                if (c.t < cutoff - 2) continue;
                for (const cn of (c.notes || [])) {
                    const songMidi = noteToMidi(cn.s, cn.f);
                    const key = _noteKey(c.t, songMidi);
                    if (!_hitNoteKeys.has(key) && !_missedNoteKeys.has(key) && c.t < cutoff) {
                        _missedNoteKeys.add(key);
                    }
                }
            }
        }

        const now = performance.now();
        while (_wrongFlashes.length && now - _wrongFlashes[0].wall > 400) {
            _wrongFlashes.shift();
        }
    }

    function _resetScoring() {
        _hits = 0; _misses = 0; _streak = 0; _bestStreak = 0;
        _hitNoteKeys.clear();
        _missedNoteKeys.clear();
        _wrongFlashes.length = 0;
    }

    function _resetForNewChart() {
        _resetScoring();
        _cachedLayout = null;
        _lastLayoutW = 0;
        _lastRangeLo = -1;
        _lastRangeHi = -1;
        _displayLo = null;
        _displayHi = null;
        // Wave C: no _primeLatestSnapshot — we don't consult the
        // bare `window.highway` global anymore (it's the main-
        // player's highway, not ours under splitscreen). First
        // MIDI hits before the first draw() just don't score.
    }

    // ── Display range update (per-instance) ──

    function _updateDisplayRange(notes, chords, t) {
        const raw = _visibleMidiRange(notes, chords, t);
        if (!raw) {
            if (_displayLo !== null) return;
            const full = detectRange(notes, chords);
            if (full && full.lo <= full.hi) {
                _displayLo = full.lo;
                _displayHi = full.hi;
            } else {
                // 48 = C3, 95 = B6 — matches detectRange's
                // empty-chart fallback after octave-boundary
                // rounding + the 47-semitone-minimum-span while
                // loop. Keeping these in lockstep means the two
                // fallback paths produce the same visible
                // keyboard span.
                _displayLo = 48;
                _displayHi = 95;
            }
            return;
        }

        if (_displayLo !== null && raw.lo >= _displayLo && raw.hi <= _displayHi) {
            const loSlack = raw.lo - _displayLo;
            const hiSlack = _displayHi - raw.hi;
            if (loSlack < 12 && hiSlack < 12) return;
        }

        let lo = Math.max(0, raw.lo - 2);
        let hi = Math.min(127, raw.hi + 2);
        lo = Math.floor(lo / 12) * 12;
        hi = Math.ceil((hi + 1) / 12) * 12 - 1;
        while (hi - lo < 47) {
            if (lo > 0) lo -= 12; else hi = Math.min(127, hi + 12);
        }

        _displayLo = lo;
        _displayHi = hi;
    }

    // ── Canvas / overlay management ──

    function _applyCanvasDims() {
        if (!_pianoCanvas || !_pianoCtx) return;
        // Size to the host highway canvas, not the full panel/#player.
        // The panel chrome (splitscreen) and #player (main) both include
        // a control bar at the bottom; sizing the overlay to those would
        // push the keyboard (bottom 15% of canvas H) underneath the bar,
        // which paints at z-index 10 over the overlay's z-index 5 and
        // hides the lower keys. _highwayCanvas is flex:1 in both layouts,
        // so its clientHeight is exactly the visible above-bar area.
        // Fallbacks preserve existing behaviour if the highway canvas
        // happens to be missing (paranoia — init bails earlier without it).
        const panelChrome = _ssPanelChrome(_highwayCanvas);
        const srcRect = _highwayCanvas || panelChrome || document.getElementById('player');
        if (!srcRect) return;
        const w = srcRect.clientWidth;
        const h = srcRect.clientHeight;
        if (!w || !h) return;
        const dpr = window.devicePixelRatio || 1;
        _pianoCanvas.width = w * dpr;
        _pianoCanvas.height = h * dpr;
        _pianoCanvas.style.width = w + 'px';
        _pianoCanvas.style.height = h + 'px';
        _pianoCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function _createOverlayCanvas() {
        const panelChrome = _ssPanelChrome(_highwayCanvas);
        const mount = panelChrome || document.getElementById('player');
        if (!mount) return null;

        const canvas = document.createElement('canvas');
        canvas.className = 'piano-highway-canvas';
        canvas.dataset.pianoInstance = String(_instanceId);
        canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:5;pointer-events:none;';

        if (panelChrome) {
            // Splitscreen panel chrome already has a bar at the
            // bottom; appending is fine — the bar has z-index above
            // our overlay's z-index:5.
            panelChrome.appendChild(canvas);
        } else {
            // Main-player path: insert before controls so controls
            // stay clickable above the overlay. Snapshot their
            // style and nudge them above z-index 5.
            const controls = document.getElementById('player-controls');
            if (controls) {
                if (controls && controls.parentNode === mount) mount.insertBefore(canvas, controls); else mount.appendChild(canvas);
                _prevControlsPosition = controls.style.position;
                _prevControlsZIndex = controls.style.zIndex;
                _controlsStyleTouched = true;
                _controlsAnchor = controls;
                controls.style.position = 'relative';
                controls.style.zIndex = '20';
            } else {
                mount.appendChild(canvas);
            }
        }
        return canvas;
    }

    function _restoreControlsStyle() {
        if (!_controlsStyleTouched || !_controlsAnchor) return;
        _controlsAnchor.style.position = _prevControlsPosition;
        _controlsAnchor.style.zIndex = _prevControlsZIndex;
        _controlsStyleTouched = false;
        _prevControlsPosition = '';
        _prevControlsZIndex = '';
        _controlsAnchor = null;
    }

    // ── Settings panel + gear button (per-instance) ──

    function _injectSettingsGear() {
        if (_settingsGear) return;
        const anchor = _ssSettingsAnchor(_highwayCanvas) ||
                       document.getElementById('player-controls');
        if (!anchor) return;

        const gear = document.createElement('button');
        gear.className = 'btn-piano-settings px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
        gear.dataset.pianoInstance = String(_instanceId);
        gear.type = 'button';
        gear.title = 'Piano settings (MIDI, sound, scoring)';
        gear.setAttribute('aria-label', 'Piano settings');
        const glyph = document.createElement('span');
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = '⚙';
        gear.appendChild(glyph);
        gear.onclick = _toggleSettings;

        if (_ssActive()) {
            // Splitscreen: append to the panel bar.
            anchor.appendChild(gear);
        } else {
            // Main-player: insert before the last direct-child button (✕ Close).
            // Use ':scope > button' to restrict to direct children — a plain
            // 'button:last-child' traverses the full subtree and can match a
            // nested button (e.g. inside #mixer-anchor) that is not a direct
            // child of anchor, causing insertBefore to throw NotFoundError.
            const btns = anchor.querySelectorAll(':scope > button');
            const closeBtn = btns.length ? btns[btns.length - 1] : null;
            if (closeBtn && closeBtn.parentNode === anchor) anchor.insertBefore(gear, closeBtn);
            else anchor.appendChild(gear);
        }
        _settingsGear = gear;
    }

    function _removeSettingsGear() {
        if (_settingsGear) {
            _settingsGear.remove();
            _settingsGear = null;
        }
    }

    function _toggleSettings() {
        _settingsVisible = !_settingsVisible;
        if (!_settingsPanel && _settingsVisible) _createSettingsPanel();
        if (_settingsPanel) _settingsPanel.style.display = _settingsVisible ? '' : 'none';
        if (_settingsVisible) {
            _midiInit();
            _synthInit();
            _midiUpdateAllDeviceLists();
        }
    }

    function _createSettingsPanel() {
        if (_settingsPanel) return;
        const panelChrome = _ssPanelChrome(_highwayCanvas);
        const mount = panelChrome || document.getElementById('player');
        if (!mount) return;

        const panel = document.createElement('div');
        panel.className = 'piano-settings-panel';
        panel.dataset.pianoInstance = String(_instanceId);
        panel.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:25;' +
            'background:rgba(8,8,20,0.94);border-bottom:1px solid #222;padding:6px 12px;' +
            'font-family:system-ui,sans-serif;display:none;';

        const channelOpts = '<option value="-1"' + (_cfg.midiChannel === -1 ? ' selected' : '') + '>All</option>' +
            Array.from({length: 16}, (_, i) =>
                `<option value="${i}"${_cfg.midiChannel === i ? ' selected' : ''}>${i + 1}</option>`
            ).join('');

        const instrumentOpts = INSTRUMENTS.map((inst, i) =>
            `<option value="${i}"${_cfg.instrumentIdx === i ? ' selected' : ''}>${inst.name}</option>`
        ).join('');

        // All form controls use classes (not ids) so N panels don't
        // collide on getElementById lookups. Handlers bind via
        // panel.querySelector scoped to this specific panel.
        panel.innerHTML = `
            <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">MIDI</span>
                    <select class="piano-midi-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;max-width:180px;">
                        <option value="">None</option>
                    </select>
                </div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">Sound</span>
                    <select class="piano-instrument-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;">
                        ${instrumentOpts}
                    </select>
                </div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">Vol</span>
                    <input type="range" class="piano-vol-slider" min="0" max="100"
                        value="${Math.round(_cfg.synthVolume * 100)}"
                        style="width:70px;accent-color:#6366f1;height:14px;">
                </div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">Ch</span>
                    <select class="piano-channel-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;width:52px;">
                        ${channelOpts}
                    </select>
                </div>
                <div style="display:flex;align-items:center;gap:3px;">
                    <span style="font-size:10px;color:#666;">Transpose</span>
                    <button class="piano-tr-down" type="button" style="background:#1a1a2e;border:1px solid #333;border-radius:4px;
                        width:20px;height:20px;color:#aaa;font-size:12px;cursor:pointer;line-height:1;">-</button>
                    <span class="piano-tr-val" style="font-size:11px;color:#ccc;min-width:18px;text-align:center;">${_cfg.transpose}</span>
                    <button class="piano-tr-up" type="button" style="background:#1a1a2e;border:1px solid #333;border-radius:4px;
                        width:20px;height:20px;color:#aaa;font-size:12px;cursor:pointer;line-height:1;">+</button>
                </div>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;">
                    <input type="checkbox" class="piano-chk-names" ${_cfg.showNoteNames ? 'checked' : ''}
                        style="accent-color:#6366f1;"> Notes
                </label>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;">
                    <input type="checkbox" class="piano-chk-hits" ${_cfg.hitDetection ? 'checked' : ''}
                        style="accent-color:#22cc66;"> Hits
                </label>
            </div>`;

        if (panelChrome) {
            panelChrome.appendChild(panel);
        } else {
            const controls = document.getElementById('player-controls');
            if (controls && controls.parentNode === mount) mount.insertBefore(panel, controls);
            else mount.appendChild(panel);
        }
        _settingsPanel = panel;

        // Scope handler wiring to this specific panel via
        // panel.querySelector (not document.querySelector) so each
        // instance's controls drive its own state.
        panel.querySelector('.piano-midi-select').onchange = function () {
            _midiConnect(this.value);
            _synthInit();
        };
        panel.querySelector('.piano-instrument-select').onchange = async function () {
            const idx = parseInt(this.value);
            _saveCfg('instrumentIdx', idx);
            await _synthInit();
            await _synthLoadInstrument(idx);
        };
        panel.querySelector('.piano-vol-slider').oninput = function () {
            _synthSetVolume(parseInt(this.value) / 100);
        };
        panel.querySelector('.piano-channel-select').onchange = function () {
            _saveCfg('midiChannel', parseInt(this.value));
        };
        panel.querySelector('.piano-tr-down').onclick = function () {
            const v = Math.max(-12, _cfg.transpose - 1);
            _saveCfg('transpose', v);
            panel.querySelector('.piano-tr-val').textContent = v;
        };
        panel.querySelector('.piano-tr-up').onclick = function () {
            const v = Math.min(12, _cfg.transpose + 1);
            _saveCfg('transpose', v);
            panel.querySelector('.piano-tr-val').textContent = v;
        };
        panel.querySelector('.piano-chk-names').onchange = function () {
            _saveCfg('showNoteNames', this.checked);
        };
        panel.querySelector('.piano-chk-hits').onchange = function () {
            _saveCfg('hitDetection', this.checked);
            if (this.checked) _resetScoring();
        };
    }

    function _removeSettingsPanel() {
        if (_settingsPanel) {
            _settingsPanel.remove();
            _settingsPanel = null;
        }
        _settingsVisible = false;
    }

    // ── Drawing ──

    function _draw(notes, chords, t, beats) {
        if (!_pianoCanvas || !_pianoCtx) return;

        _latestNotes = notes;
        _latestChords = chords;
        _latestTime = t;

        const W = _pianoCanvas.width / (window.devicePixelRatio || 1);
        const H = _pianoCanvas.height / (window.devicePixelRatio || 1);
        const ctx = _pianoCtx;

        // Render the keyboard at the cached display range (or
        // detectRange's C3-B6 fallback) regardless of whether
        // the chart arrays happen to be empty for this frame.
        // Long rests and aggressive difficulty filtering can
        // produce zero in-window notes during normal playback —
        // the previous "empty arrays = no chart" early-return
        // collapsed those cases into the same blank-canvas path
        // we use during loading. The actual loading-state guard
        // is in draw() above (gated on bundle.isReady), so by
        // the time we get here the chart is confirmed loaded
        // even if the per-frame note window is empty.
        _updateDisplayRange(notes || [], chords || [], t);
        if (_displayLo === null) {
            ctx.fillStyle = '#040408';
            ctx.fillRect(0, 0, W, H);
            return;
        }
        const lo = _displayLo;
        const hi = _displayHi;

        const kbH = H * KEYBOARD_H_FRAC;
        const kbTop = H - kbH;
        const padL = 10, padR = 10;

        if (!_cachedLayout || _lastLayoutW !== W || lo !== _lastRangeLo || hi !== _lastRangeHi) {
            _cachedLayout = buildKeyLayout(lo, hi, padL, W - padL - padR);
            _lastLayoutW = W;
            _lastRangeLo = lo;
            _lastRangeHi = hi;
        }
        const layout = _cachedLayout;

        _updateMissedNotes(t, notes, chords);

        ctx.fillStyle = '#040408';
        ctx.fillRect(0, 0, W, H);

        const noteAreaTop = 0;
        const nowLineY = kbTop * NOW_LINE_Y_FRAC;

        for (const k of layout) {
            if (k.black) continue;
            const isC = k.midi % 12 === 0;
            ctx.strokeStyle = isC ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)';
            ctx.lineWidth = isC ? 1.5 : 0.5;
            ctx.beginPath();
            ctx.moveTo(k.x + k.w - 0.5, noteAreaTop);
            ctx.lineTo(k.x + k.w - 0.5, kbTop);
            ctx.stroke();
        }

        if (beats) {
            for (const b of beats) {
                const dt = b.time - t;
                if (dt < -0.1 || dt > VISIBLE_SECONDS) continue;
                const y = _timeToY(dt, nowLineY, noteAreaTop);
                ctx.strokeStyle = b.measure > 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)';
                ctx.lineWidth = b.measure > 0 ? 1.5 : 0.5;
                ctx.beginPath();
                ctx.moveTo(padL, y);
                ctx.lineTo(W - padR, y);
                ctx.stroke();
            }
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(padL, nowLineY);
        ctx.lineTo(W - padR, nowLineY);
        ctx.stroke();

        _drawScrollingNotes(ctx, notes, chords, t, layout, noteAreaTop, nowLineY);
        _drawKeyboard(ctx, layout, kbTop, kbH, notes, chords, t);

        if (_cfg.hitDetection && (_hits + _misses) > 0) {
            _drawAccuracyHUD(ctx, W);
        }

        // MIDI indicator — show on the focused panel only; non-focused
        // panels don't receive input so the dot would be misleading.
        if (_midiInput && _isFocused) {
            ctx.fillStyle = '#22cc66';
            ctx.beginPath();
            ctx.arc(W - 20, 16, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#22cc6688';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText('MIDI', W - 28, 16);
        }
    }

    function _drawScrollingNotes(ctx, notes, chords, t, layout, topY, nowLineY) {
        const allNotes = [];

        if (notes) {
            for (const n of notes) {
                const dt = n.t - t;
                if (dt > VISIBLE_SECONDS + 1) break;
                if (dt < -1 && (n.t + (n.sus || 0)) < t - 0.5) continue;
                allNotes.push({ midi: noteToMidi(n.s, n.f), t: n.t, sus: n.sus || 0, accent: n.ac });
            }
        }
        if (chords) {
            for (const c of chords) {
                const dt = c.t - t;
                if (dt > VISIBLE_SECONDS + 1) break;
                if (dt < -1) continue;
                for (const cn of (c.notes || [])) {
                    allNotes.push({ midi: noteToMidi(cn.s, cn.f), t: c.t, sus: cn.sus || 0, accent: cn.ac });
                }
            }
        }

        for (const n of allNotes) {
            const key = keyForMidi(n.midi, layout);
            if (!key) continue;

            const dt = n.t - t;
            const dtEnd = (n.t + n.sus) - t;

            const yBottom = _timeToY(dt, nowLineY, topY);
            const yTop = n.sus > 0.05 ? _timeToY(Math.max(dt, dtEnd), nowLineY, topY) : yBottom - 8;

            const y1 = Math.max(topY, Math.min(yTop, yBottom));
            const y2 = Math.min(nowLineY + 10, Math.max(yTop, yBottom));
            const noteH = y2 - y1;
            if (noteH < 1) continue;

            const isActive = dt <= 0.05 && dtEnd >= -0.05;
            const isOnBlack = key.black;

            const inset = isOnBlack ? 1 : 2;
            const barX = key.x + inset;
            const barW = key.w - inset * 2;
            const radius = Math.min(4, barW / 3, noteH / 2);

            const nk = _noteKey(n.t, n.midi);
            let useHitColor = false, useMissColor = false;
            if (_cfg.hitDetection) {
                if (_hitNoteKeys.has(nk)) useHitColor = true;
                else if (_missedNoteKeys.has(nk)) useMissColor = true;
            }

            const [cr, cg, cb] = _neonRGB(n.midi);
            const df = isOnBlack ? 0.7 : 1.0;
            let r = cr * df, g = cg * df, b = cb * df;

            if (useHitColor) { r = 0; g = 1; b = 0.27; }
            else if (useMissColor) { r = 0.33; g = 0.33; b = 0.4; }

            if (!useMissColor) {
                const glowAlpha = isActive ? 0.5 : 0.25;
                for (let i = 2; i >= 0; i--) {
                    const spread = (i + 1) * 2;
                    const a = glowAlpha * (0.15 + (2 - i) * 0.12);
                    ctx.strokeStyle = _rgbStr(r, g, b, a);
                    ctx.lineWidth = spread;
                    _roundRect(ctx, barX - 1, y1 - 1, barW + 2, noteH + 2, radius + 1);
                    ctx.stroke();
                }
            }

            ctx.fillStyle = _rgbStr(r, g, b, useMissColor ? 0.4 : 1);
            _roundRect(ctx, barX, y1, barW, noteH, radius);
            ctx.fill();

            if (!useMissColor && noteH > 4) {
                const grad = ctx.createLinearGradient(0, y1, 0, y1 + Math.min(noteH, 12));
                grad.addColorStop(0, _rgbStr(Math.min(r + 0.3, 1), Math.min(g + 0.3, 1), Math.min(b + 0.3, 1), 0.4));
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = grad;
                _roundRect(ctx, barX, y1, barW, noteH, radius);
                ctx.fill();
            }

            if (_cfg.showNoteNames && noteH >= NOTE_LABEL_MIN_H && barW >= 14) {
                const fontSize = Math.min(10, barW * 0.45);
                ctx.font = `bold ${fontSize}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillText(midiToNoteName(n.midi), barX + barW / 2 + 0.5, y1 + noteH / 2 + 0.5);
                ctx.fillStyle = '#fff';
                ctx.fillText(midiToNoteName(n.midi), barX + barW / 2, y1 + noteH / 2);
            }
        }
    }

    function _drawKeyboard(ctx, layout, kbTop, kbH, notes, chords, t) {
        const songActiveSet = new Set();
        const window_ = 0.06;
        if (notes) {
            for (const n of notes) {
                if (n.t > t + window_) continue;
                const end = n.t + (n.sus || 0);
                if (end < t - window_) continue;
                if (n.t <= t + window_ && end >= t - window_)
                    songActiveSet.add(noteToMidi(n.s, n.f));
            }
        }
        if (chords) {
            for (const c of chords) {
                if (c.t > t + window_) continue;
                if (c.t < t - 1) continue;
                for (const cn of (c.notes || [])) {
                    const end = c.t + (cn.sus || 0);
                    if (c.t <= t + window_ && end >= t - window_)
                        songActiveSet.add(noteToMidi(cn.s, cn.f));
                }
            }
        }

        const wrongSet = new Set();
        const now = performance.now();
        for (const wf of _wrongFlashes) {
            if (now - wf.wall < 400) wrongSet.add(wf.midi);
        }

        ctx.fillStyle = '#060610';
        ctx.fillRect(0, kbTop - 1, ctx.canvas.width / (window.devicePixelRatio || 1), kbH + 3);

        const blackH = kbH * 0.62;
        const cornerR = 5;

        for (const k of layout) {
            if (k.black) continue;
            const songActive = songActiveSet.has(k.midi);
            const playerHeld = _heldNotes.has(k.midi);
            const isWrong = wrongSet.has(k.midi);
            const pressed = songActive || playerHeld;
            const pressOffset = pressed ? 2 : 0;
            const kw = k.w - 1;

            const [nr, ng, nb] = _neonRGB(k.midi);
            let fr = 0.91, fg = 0.91, fb = 0.94;
            if (playerHeld && songActive) {
                fr = 0; fg = 1; fb = 0.27;
            } else if (isWrong && playerHeld) {
                fr = 1; fg = 0.27; fb = 0.27;
            } else if (playerHeld) {
                fr = 0.27; fg = 0.53; fb = 1;
            } else if (songActive) {
                fr = nr; fg = ng; fb = nb;
            } else {
                const ap = _approachAlpha(k.midi, notes, chords, t);
                if (ap > 0) {
                    fr += (nr - fr) * ap * 0.6;
                    fg += (ng - fg) * ap * 0.6;
                    fb += (nb - fb) * ap * 0.6;
                }
            }

            const grad = ctx.createLinearGradient(0, kbTop + pressOffset, 0, kbTop + kbH);
            grad.addColorStop(0, _rgbStr(Math.min(fr + 0.08, 1), Math.min(fg + 0.08, 1), Math.min(fb + 0.08, 1)));
            grad.addColorStop(0.85, _rgbStr(fr, fg, fb));
            grad.addColorStop(1, _rgbStr(fr * 0.75, fg * 0.75, fb * 0.75));
            ctx.fillStyle = grad;
            _roundRectBottom(ctx, k.x, kbTop + pressOffset, kw, kbH - pressOffset, cornerR);
            ctx.fill();

            ctx.strokeStyle = 'rgba(100,100,120,0.4)';
            ctx.lineWidth = 0.5;
            _roundRectBottom(ctx, k.x, kbTop + pressOffset, kw, kbH - pressOffset, cornerR);
            ctx.stroke();

            if (!pressed) {
                const ap = _approachAlpha(k.midi, notes, chords, t);
                if (ap > 0.15) {
                    const ba = Math.min((ap - 0.15) * 1.5, 1);
                    ctx.strokeStyle = _rgbStr(nr, ng, nb, ba * 0.6);
                    ctx.lineWidth = 2;
                    _roundRectBottom(ctx, k.x + 1, kbTop + 1, kw - 2, kbH - 2, cornerR);
                    ctx.stroke();
                }
            }

            if (pressed) {
                ctx.shadowColor = _rgbStr(fr, fg, fb);
                ctx.shadowBlur = 12;
                ctx.fillStyle = 'rgba(0,0,0,0)';
                _roundRectBottom(ctx, k.x, kbTop + pressOffset, kw, kbH - pressOffset, cornerR);
                ctx.fill();
                ctx.shadowBlur = 0;
            }

            const pc = k.midi % 12;
            const noteLetter = ['C','','D','','E','F','','G','','A','','B'][pc];
            if (noteLetter) {
                const isC = pc === 0;
                const label = isC ? 'C' + (Math.floor(k.midi / 12) - 1) : noteLetter;
                ctx.fillStyle = pressed ? 'rgba(0,0,0,0.7)' : 'rgba(80,80,100,0.5)';
                ctx.font = `${isC ? 'bold ' : ''}${Math.min(10, kw * 0.45)}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillText(label, k.x + kw / 2, kbTop + kbH - 3 + pressOffset);
            }
        }

        for (const k of layout) {
            if (!k.black) continue;
            const songActive = songActiveSet.has(k.midi);
            const playerHeld = _heldNotes.has(k.midi);
            const isWrong = wrongSet.has(k.midi);
            const pressed = songActive || playerHeld;
            const pressOffset = pressed ? 1 : 0;

            const [nr, ng, nb] = _neonRGB(k.midi);
            let fr = 0.1, fg = 0.1, fb = 0.12;
            if (playerHeld && songActive) {
                fr = 0; fg = 0.8; fb = 0.2;
            } else if (isWrong && playerHeld) {
                fr = 0.8; fg = 0.15; fb = 0.15;
            } else if (playerHeld) {
                fr = 0.2; fg = 0.4; fb = 0.8;
            } else if (songActive) {
                fr = nr * 0.8; fg = ng * 0.8; fb = nb * 0.8;
            } else {
                const ap = _approachAlpha(k.midi, notes, chords, t);
                if (ap > 0) {
                    fr += (nr * 0.7 - fr) * ap * 0.6;
                    fg += (ng * 0.7 - fg) * ap * 0.6;
                    fb += (nb * 0.7 - fb) * ap * 0.6;
                }
            }

            const grad = ctx.createLinearGradient(0, kbTop + pressOffset, 0, kbTop + blackH);
            grad.addColorStop(0, _rgbStr(Math.min(fr + 0.06, 1), Math.min(fg + 0.06, 1), Math.min(fb + 0.06, 1)));
            grad.addColorStop(0.7, _rgbStr(fr, fg, fb));
            grad.addColorStop(1, _rgbStr(fr * 0.6, fg * 0.6, fb * 0.6));
            ctx.fillStyle = grad;
            _roundRectBottom(ctx, k.x, kbTop + pressOffset, k.w, blackH - pressOffset, 3);
            ctx.fill();

            ctx.strokeStyle = 'rgba(50,50,60,0.5)';
            ctx.lineWidth = 0.5;
            _roundRectBottom(ctx, k.x, kbTop + pressOffset, k.w, blackH - pressOffset, 3);
            ctx.stroke();

            if (!pressed) {
                const ap = _approachAlpha(k.midi, notes, chords, t);
                if (ap > 0.15) {
                    const ba = Math.min((ap - 0.15) * 1.5, 1);
                    ctx.strokeStyle = _rgbStr(nr, ng, nb, ba * 0.5);
                    ctx.lineWidth = 1.5;
                    _roundRectBottom(ctx, k.x + 1, kbTop + 1, k.w - 2, blackH - 2, 3);
                    ctx.stroke();
                }
            }

            if (pressed) {
                ctx.shadowColor = _rgbStr(fr, fg, fb);
                ctx.shadowBlur = 10;
                ctx.fillStyle = 'rgba(0,0,0,0)';
                _roundRectBottom(ctx, k.x, kbTop + pressOffset, k.w, blackH - pressOffset, 3);
                ctx.fill();
                ctx.shadowBlur = 0;
            }
        }
    }

    function _drawAccuracyHUD(ctx, W) {
        const total = _hits + _misses;
        const pct = total > 0 ? Math.round((_hits / total) * 100) : 0;

        const hudY = 10;
        const hudH = 22;
        const text = `Accuracy: ${pct}%   Streak: ${_streak}   Best: ${_bestStreak}   ${_hits}/${total}`;

        ctx.font = 'bold 11px sans-serif';
        const tw = ctx.measureText(text).width;
        const hudX = (W - tw) / 2 - 12;
        const hudW = tw + 24;

        ctx.fillStyle = 'rgba(8,8,20,0.75)';
        _roundRect(ctx, hudX, hudY, hudW, hudH, 6);
        ctx.fill();

        ctx.fillStyle = pct >= 80 ? '#22cc66' : pct >= 50 ? '#ffcc33' : '#ff6644';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, W / 2, hudY + hudH / 2);
    }

    // ── Teardown ──

    function _teardown() {
        if (_pianoCanvas) {
            _pianoCanvas.remove();
            _pianoCanvas = null;
            _pianoCtx = null;
        }
        _removeSettingsPanel();
        _removeSettingsGear();
        _restoreControlsStyle();

        _releaseAllHeld();

        if (_highwayCanvas) {
            _highwayCanvas.style.visibility = _prevHighwayDisplay;
            _highwayCanvas = null;
            _prevHighwayDisplay = '';
        }

        // Removing our gear may unwrap #player-controls back to one
        // row, which would leave the host's canvas style.height at our
        // smaller-bar value and the next renderer drawing into an
        // undersized box. Re-trigger the host's measure pass to match
        // the post-teardown DOM. Best-effort — host may already be
        // gone if the page is unloading.
        try { window.highway && window.highway.resize && window.highway.resize(); }
        catch (e) { console.warn('[Piano] host resize on teardown failed:', e); }

        _latestNotes = null;
        _latestChords = null;
        _latestTime = 0;
    }

    // ── Factory return: setRenderer contract ──

    const instance = {
        init(canvas /* , bundle */) {
            // Defensive teardown if a prior init wasn't paired with
            // destroy. Remove listeners, restore canvas, release
            // held state — mirrors destroy() exactly, INCLUDING
            // removing from _instances and pausing MIDI if we're
            // the last live instance. Without the _instances
            // cleanup, a re-init that subsequently fails early
            // (no mount / null ctx) would leave the instance
            // orphaned in the set, making _instances.size checks
            // inaccurate and preventing _midiPauseHandler from
            // ever running.
            if (_pianoCanvas || _isReady) {
                window.removeEventListener('resize', _onWinResize);
                const ss = window.slopsmithSplitscreen;
                if (ss && typeof ss.offFocusChange === 'function') {
                    ss.offFocusChange(_onFocusChange);
                }
                _instances.delete(instance);
                if (_activeInstance === instance) _activeInstance = null;
                _teardown();
                _isReady = false;
                _isFocused = false;
                if (_instances.size === 0) _midiReleaseSession();
            }

            // Clear the destroyed sentinel so an init() following a
            // destroy() on the same factory object (e.g. highway
            // re-using a renderer across songs) re-enables focus
            // updates. Set to true in destroy() above — without this
            // reset, _updateFocusState would permanently no-op.
            _instanceDestroyed = false;

            _highwayCanvas = canvas;
            // Snapshot/restore via `visibility` (not `display`): the host's
            // rAF loop gates draw on `canvas.offsetParent !== null`, which is
            // null whenever `display:none` is on the element or any ancestor.
            // Hiding the host canvas via display:none therefore stops the
            // host from ever calling our draw() and leaves the overlay
            // permanently black. `visibility:hidden` keeps offsetParent live
            // while still hiding the host's last-painted frame.
            _prevHighwayDisplay = canvas ? canvas.style.visibility : '';

            _pianoCanvas = _createOverlayCanvas();
            if (!_pianoCanvas) {
                console.warn('[Piano] init: no mount container available; aborting');
                return;
            }
            _pianoCtx = _pianoCanvas.getContext('2d');
            if (!_pianoCtx) {
                console.warn('[Piano] init: getContext("2d") returned null; aborting');
                _pianoCanvas.remove();
                _pianoCanvas = null;
                _highwayCanvas = null;
                _prevHighwayDisplay = '';
                _restoreControlsStyle();
                return;
            }

            if (_highwayCanvas) _highwayCanvas.style.visibility = 'hidden';

            _injectSettingsGear();
            // The host sizes the highway canvas to
            // `documentElement.clientHeight - controls.offsetHeight` and
            // bakes it into the canvas's inline style — not via flex.
            // Injecting the gear above can push #player-controls onto a
            // second row, growing its offsetHeight, but the host's last
            // resize captured the PRE-injection height, so
            // _highwayCanvas.style.height is now stale (too tall) and
            // our overlay would inherit that stale height and paint
            // the keyboard down into the controls.
            //
            // Same-tick host.resize() turns out NOT to be enough: at
            // least one browser path (observed on the slopsmith web
            // app) doesn't commit the flex-wrap row change before the
            // synchronous offsetHeight read inside host.resize(), so
            // the resize uses the pre-wrap height and the canvas
            // remains too tall. A manual user-driven window resize a
            // moment later fixes it — i.e. once layout has settled.
            // Mirror that by running an initial sync pass for the
            // happy case AND a follow-up rAF pass that fires after
            // the browser's post-mutation layout commit.
            //
            // Safe during init: host.resize() only recurses into our
            // resize() when _rendererInited is true, and the host
            // hasn't flipped it yet (it does so only after init()
            // returns successfully).
            const _resyncFromHost = () => {
                try { window.highway && window.highway.resize && window.highway.resize(); }
                catch (e) { console.warn('[Piano] host resize failed:', e); }
                _applyCanvasDims();
            };
            _resyncFromHost();
            requestAnimationFrame(() => {
                // Bail if a teardown happened before the frame fired.
                if (!_pianoCanvas || !_pianoCtx) return;
                _resyncFromHost();
            });
            window.addEventListener('resize', _onWinResize);

            const ss = window.slopsmithSplitscreen;
            // Subscribe only when BOTH on/offFocusChange exist on
            // the helper. A subscribe-without-unsubscribe path
            // would leak the listener every init/destroy cycle and
            // — combined with _ssActive's strict surface check
            // returning false — also produce inconsistent focus
            // routing where the listener fires but the wrappers
            // treat splitscreen as inactive.
            if (ss && typeof ss.onFocusChange === 'function'
                   && typeof ss.offFocusChange === 'function') {
                ss.onFocusChange(_onFocusChange);
            }

            _resetForNewChart();

            _instances.add(instance);

            // Kick off MIDI + synth. One-time init — subsequent
            // instances no-op out because the module singletons are
            // already populated.
            _midiInit();
            _synthInit();

            _isReady = true;

            // Determine focus BEFORE resuming the MIDI handler so
            // _activeInstance is populated when onmidimessage gets
            // wired. Otherwise a MIDI message arriving in the
            // window between _midiResumeHandler and the first
            // focus-change event would route through _midiOnMessage
            // → null _activeInstance → silently dropped. Main-player
            // fast path takes effect synchronously here too.
            _updateFocusState();
            _midiResumeHandler();
        },
        draw(bundle) {
            if (!_isReady || !bundle) return;

            // Wave C: bundle.isReady edge detect in place of the
            // global song:ready subscription. Each panel's highway
            // emits song:ready independently; subscribing at module
            // scope would fire N×. Edge-detecting per-instance
            // correctly scopes the reset.
            const isReady = !!bundle.isReady;
            if (isReady && !_lastBundleIsReady) {
                _resetForNewChart();
            }
            _lastBundleIsReady = isReady;

            // Loading / reconnect window — chart isn't confirmed
            // yet. Paint the plugin's base background so the
            // previous chart's notes + HUD don't sit frozen on
            // screen, but DON'T render the keyboard either since
            // we don't know what tuning / range applies. Once
            // bundle.isReady flips true we hand off to _draw
            // which renders the keyboard at the discovered range
            // (or a sane default if the visible window is empty).
            if (!isReady) {
                if (_pianoCanvas && _pianoCtx) {
                    const W = _pianoCanvas.width / (window.devicePixelRatio || 1);
                    const H = _pianoCanvas.height / (window.devicePixelRatio || 1);
                    _pianoCtx.fillStyle = '#040408';
                    _pianoCtx.fillRect(0, 0, W, H);
                }
                return;
            }

            _draw(bundle.notes, bundle.chords, bundle.currentTime, bundle.beats);
        },
        resize(/* w, h */) {
            if (!_isReady) return;
            _applyCanvasDims();
        },
        destroy() {
            _isReady = false;
            // Set BEFORE attempting the (best-effort) unsubscribe so
            // the focus-change handler's _instanceDestroyed guard
            // catches any event that sneaks through a failed /
            // missing offFocusChange call.
            _instanceDestroyed = true;
            window.removeEventListener('resize', _onWinResize);
            const ss = window.slopsmithSplitscreen;
            if (ss && typeof ss.offFocusChange === 'function') {
                ss.offFocusChange(_onFocusChange);
            }
            _instances.delete(instance);
            if (_activeInstance === instance) _activeInstance = null;
            _isFocused = false;
            // Pause the MIDI handler only if we're the last instance
            // standing. Otherwise other instances still need MIDI
            // events flowing into _midiOnMessage (which routes to the
            // currently-focused instance).
            if (_instances.size === 0) {
                _midiReleaseSession();
            }
            _teardown();
        },
        // Internal hooks used by module-level MIDI router.
        _handleNoteOn,
        _handleNoteOff,
        _handleSustain,
        _releaseAllHeld,
    };

    return instance;
}

createFactory.matchesArrangement = function (songInfo) {
    if (!songInfo) return false;
    // Notation-only arrangements (sloppak-spec §5.3: `notation:` present,
    // `file:` omitted) carry zero guitar-wire notes — this plugin decodes
    // `midi = s*24 + f` wire notes and would render a blank board. Yield to
    // the notation viz plugins (Staff View, Keys Highway 3D), which claim
    // them via `has_notation`. Legacy keys sloppaks WITH wire notes stay
    // ours.
    if (songInfo.has_notation && Array.isArray(songInfo.arrangements)) {
        const active = songInfo.arrangements.find(a => a.index === songInfo.arrangement_index);
        if (active && active.notes === 0) return false;
    }
    if (songInfo.arrangement && KEYS_PATTERNS.test(songInfo.arrangement)) return true;
    if (Array.isArray(songInfo.arrangements)) {
        const idx = songInfo.arrangement_index;
        const arr = songInfo.arrangements.find(a => a.index === idx);
        if (arr && KEYS_PATTERNS.test(arr.name)) return true;
    }
    return false;
};

window.slopsmithViz_piano = createFactory;
// slopsmith→feedBack rename: host viz picker looks up `window.feedBackViz_<id>`.
window.feedBackViz_piano = window.slopsmithViz_piano;

})();
