(function () {
    'use strict';

    /* ======================================================================
       Constants & helpers
       ====================================================================== */
    const OPS = ['+', '−', '×', '÷'];
    const MAX_DIGITS = 15;          // per number; beyond this doubles lose precision
    const MAX_LENGTH = 120;         // whole expression
    const HISTORY_LIMIT = 50;
    const STORAGE = {
        history: 'calc:history',
        sound: 'calc:sound',
        theme: 'calc:theme',
    };

    const isDigit = (c) => c >= '0' && c <= '9';
    const isOp = (c) => OPS.includes(c);
    const last = (s) => s.slice(-1);

    const storage = {
        get(key, fallback) {
            try {
                const v = localStorage.getItem(key);
                return v === null ? fallback : JSON.parse(v);
            } catch (e) {
                return fallback;
            }
        },
        set(key, value) {
            try {
                localStorage.setItem(key, JSON.stringify(value));
            } catch (e) { /* storage full or unavailable */ }
        },
    };

    class CalcError extends Error { }

    /* ======================================================================
       Tokenizer & parser (replaces eval)
       Grammar:
         expression := term (('+' | '−') term)*
         term       := unary (('×' | '÷') unary | <implicit ×> unary)*
         unary      := ('−' | '+') unary | postfix
         postfix    := primary '%'*
         primary    := number | '(' expression ')'
       ====================================================================== */
    const TOKEN_RE = /(\d+\.?\d*|\.\d+)(?:e[+\-]?\d+)?|[+−×÷%()]/giy;

    function tokenize(expr) {
        const tokens = [];
        TOKEN_RE.lastIndex = 0;
        while (TOKEN_RE.lastIndex < expr.length) {
            const start = TOKEN_RE.lastIndex;
            const m = TOKEN_RE.exec(expr);
            if (!m) throw new CalcError('Invalid input at ' + start);
            const text = m[0];
            if (/^[\d.]/.test(text)) tokens.push({ type: 'num', value: parseFloat(text) });
            else tokens.push({ type: text });
        }
        return tokens;
    }

    function evaluate(expr) {
        const tokens = tokenize(expr);
        let pos = 0;
        const peek = () => tokens[pos];
        const next = () => tokens[pos++];

        function expression() {
            let left = term();
            while (peek() && (peek().type === '+' || peek().type === '−')) {
                const op = next().type;
                const right = term();
                // Calculator-style percent: 50 + 10% → 50 + 5
                const r = right.pct ? left.value * right.value : right.value;
                left = { value: op === '+' ? left.value + r : left.value - r, pct: false };
            }
            return left;
        }

        function term() {
            let left = unary();
            for (;;) {
                const t = peek();
                if (!t) break;
                if (t.type === '×' || t.type === '÷') {
                    next();
                    const right = unary();
                    if (t.type === '÷') {
                        if (right.value === 0) throw new CalcError("Can't divide by 0");
                        left = { value: left.value / right.value, pct: false };
                    } else {
                        left = { value: left.value * right.value, pct: false };
                    }
                } else if (t.type === '(' || t.type === 'num') {
                    // Implicit multiplication: 2(3), (2)(3), 5%(2)
                    const right = unary();
                    left = { value: left.value * right.value, pct: false };
                } else {
                    break;
                }
            }
            return left;
        }

        function unary() {
            const t = peek();
            if (t && (t.type === '−' || t.type === '+')) {
                next();
                const inner = unary();
                return { value: t.type === '−' ? -inner.value : inner.value, pct: inner.pct };
            }
            return postfix();
        }

        function postfix() {
            let node = primary();
            while (peek() && peek().type === '%') {
                next();
                node = { value: node.value / 100, pct: true };
            }
            return node;
        }

        function primary() {
            const t = next();
            if (!t) throw new CalcError('Incomplete expression');
            if (t.type === 'num') return { value: t.value, pct: false };
            if (t.type === '(') {
                const inner = expression();
                if (!peek() || peek().type !== ')') throw new CalcError('Missing )');
                next();
                return { value: inner.value, pct: false };
            }
            throw new CalcError('Incomplete expression');
        }

        if (tokens.length === 0) throw new CalcError('Empty');
        const result = expression();
        if (pos < tokens.length) throw new CalcError('Invalid expression');
        if (!Number.isFinite(result.value)) throw new CalcError('Result too large');
        return result.value;
    }

    /** Close any parentheses the user left open. */
    function balance(expr) {
        let depth = 0;
        for (const c of expr) {
            if (c === '(') depth++;
            else if (c === ')') depth--;
        }
        return expr + ')'.repeat(Math.max(0, depth));
    }

    function openParens(expr) {
        let depth = 0;
        for (const c of expr) {
            if (c === '(') depth++;
            else if (c === ')') depth--;
        }
        return depth;
    }

    /* ======================================================================
       Number formatting
       ====================================================================== */
    /** Result → string the parser can read back (no separators). */
    function toExprString(n) {
        if (Object.is(n, -0)) n = 0;
        const rounded = Number(n.toPrecision(12)); // hides float noise: 0.1 + 0.2 → 0.3
        const abs = Math.abs(rounded);
        let s;
        if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) {
            s = rounded.toExponential(9).replace(/\.?0+e/, 'e');
        } else {
            s = String(rounded);
        }
        return s.replace(/^-/, '−');
    }

    function groupNumber(text) {
        if (/e/i.test(text)) return text;
        const [int, frac] = text.split('.');
        const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return frac === undefined ? grouped : grouped + '.' + frac;
    }

    const SEGMENT_RE = /(\d+\.?\d*|\.\d+)(?:e[+\-]?\d+)?|[+−×÷]|./gi;

    /** Split an expression into display segments with digit grouping. */
    function segments(expr) {
        return Array.from(expr.matchAll(SEGMENT_RE), (m) => {
            const text = m[0];
            if (/^[\d.]/.test(text)) return { text: groupNumber(text), type: 'num' };
            if (isOp(text)) return { text, type: 'op' };
            return { text, type: 'other' };
        });
    }

    const formatPlain = (expr) =>
        segments(expr).map((s) => (s.type === 'op' ? ` ${s.text} ` : s.text)).join('');

    function renderInto(el, expr) {
        const frag = document.createDocumentFragment();
        for (const seg of segments(expr)) {
            if (seg.type === 'op') {
                const span = document.createElement('span');
                span.className = 'op';
                span.textContent = seg.text;
                frag.appendChild(span);
            } else {
                frag.appendChild(document.createTextNode(seg.text));
            }
        }
        el.replaceChildren(frag);
    }

    /* ======================================================================
       DOM
       ====================================================================== */
    const $ = (id) => document.getElementById(id);
    const app = $('app');
    const display = $('display');
    const previousEl = $('previous');
    const expressionEl = $('expression');
    const previewEl = $('preview');
    const keypad = $('keypad');
    const liveEl = $('live');
    const historyEl = $('history');
    const historyList = $('historyList');
    const historyEmpty = $('historyEmpty');
    const historyToggle = $('historyToggle');
    const historyClose = $('historyClose');
    const historyClear = $('historyClear');
    const scrim = $('scrim');
    const soundToggle = $('soundToggle');
    const themeToggle = $('themeToggle');

    /* ======================================================================
       Sound
       ====================================================================== */
    const SOUND_FILES = {
        click: 'click.mp3',
        clear: 'clear.mp3',
        discard: 'discard.mp3',
        correct: 'correct.mp3',
        error: 'error.mp3',
    };
    let soundOn = storage.get(STORAGE.sound, true);
    let sounds = null;

    function loadSounds() {
        sounds = {};
        for (const [name, file] of Object.entries(SOUND_FILES)) {
            const audio = new Audio('./assets/sounds/' + file);
            audio.preload = 'auto';
            sounds[name] = audio;
        }
    }

    function playSound(name) {
        if (!soundOn) return;
        if (!sounds) loadSounds();
        const audio = sounds[name] || sounds.click;
        try {
            audio.currentTime = 0;
            const p = audio.play();
            if (p && p.catch) p.catch(() => { });
        } catch (e) { /* ignore playback errors */ }
    }

    function renderSoundToggle() {
        soundToggle.setAttribute('aria-pressed', String(soundOn));
        soundToggle.title = soundOn ? 'Mute sounds' : 'Unmute sounds';
    }

    /* ======================================================================
       Theme
       ====================================================================== */
    const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const THEME_COLORS = { dark: '#0b0d11', light: '#e9ecf2' };

    function effectiveTheme() {
        const stored = storage.get(STORAGE.theme, null);
        if (stored === 'light' || stored === 'dark') return stored;
        return darkQuery.matches ? 'dark' : 'light';
    }

    function renderTheme() {
        const theme = effectiveTheme();
        const other = theme === 'dark' ? 'light' : 'dark';
        themeToggle.dataset.current = theme;
        themeToggle.setAttribute('aria-label', `Switch to ${other} theme`);
        themeToggle.title = `Switch to ${other} theme`;
        document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
            m.setAttribute('content', THEME_COLORS[theme]);
        });
    }

    function toggleTheme() {
        const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        storage.set(STORAGE.theme, next);
        renderTheme();
    }

    /* ======================================================================
       Calculator state
       ====================================================================== */
    const state = {
        expr: '',
        previous: '',
        justEvaluated: false,
        error: '',
    };

    /** Digits in the number currently being typed at the end of expr. */
    function currentNumber() {
        const m = state.expr.match(/(\d+\.?\d*|\.\d+)(?:e[+\-]?\d+)?$/i);
        return m ? m[0] : '';
    }

    function append(text) {
        if (state.expr.length + text.length > MAX_LENGTH) return false;
        state.expr += text;
        return true;
    }

    function input(char) {
        state.error = '';

        if (state.justEvaluated) {
            state.justEvaluated = false;
            // A digit, point or "(" starts a new calculation; operators continue from the result.
            if (isDigit(char) || char === '.' || char === '(') state.expr = '';
        }

        const end = last(state.expr);
        const closesValue = end === ')' || end === '%';

        if (isDigit(char)) {
            const num = currentNumber();
            if (/e/i.test(num)) return false;
            if (num.replace('.', '').length >= MAX_DIGITS) return false;
            if (num === '0') {
                state.expr = state.expr.slice(0, -1) + char; // no leading zeros
                return true;
            }
            return append(closesValue ? '×' + char : char);
        }

        if (char === '.') {
            const num = currentNumber();
            if (num.includes('.') || /e/i.test(num)) return false;
            if (closesValue) return append('×0.');
            return append(isDigit(end) ? '.' : '0.');
        }

        if (isOp(char)) {
            if (isOp(end)) {
                // Allow a negative right-hand side: 5 × −3
                if (char === '−' && (end === '×' || end === '÷')) return append(char);
                const base = state.expr.replace(/[+−×÷]+$/, '');
                if (base === '' || last(base) === '(') {
                    if (char !== '−') return false;
                    state.expr = base + char;
                    return true;
                }
                state.expr = base + char;
                return true;
            }
            if (end === '' || end === '(') {
                return char === '−' ? append(char) : false;
            }
            return append(char);
        }

        if (char === '%') {
            if (isDigit(end) || end === '.' || end === ')') return append('%');
            return false;
        }

        if (char === '(') {
            const implicit = isDigit(end) || end === '.' || closesValue;
            return append(implicit ? '×(' : '(');
        }

        if (char === ')') {
            if (openParens(state.expr) > 0 && (isDigit(end) || end === '.' || closesValue)) {
                return append(')');
            }
            return false;
        }

        return false;
    }

    function smartParen() {
        const end = last(state.expr);
        const canClose = openParens(state.expr) > 0 && (isDigit(end) || end === '.' || end === ')' || end === '%');
        return input(state.justEvaluated ? '(' : canClose ? ')' : '(');
    }

    function backspace() {
        state.error = '';
        if (state.justEvaluated) {
            state.justEvaluated = false;
            if (/e/i.test(state.expr)) {
                state.expr = '';
                return;
            }
        }
        state.expr = state.expr.slice(0, -1);
        if (state.expr === '−') state.expr = '';
    }

    function clearAll() {
        state.expr = '';
        state.previous = '';
        state.error = '';
        state.justEvaluated = false;
    }

    function equals() {
        if (!state.expr || state.justEvaluated) return false;
        const source = balance(state.expr);
        try {
            const result = evaluate(source);
            const resultStr = toExprString(result);
            addHistory(source, resultStr);
            state.previous = source;
            state.expr = resultStr;
            state.justEvaluated = true;
            state.error = '';
            announce(`${formatPlain(source)} equals ${formatPlain(resultStr)}`);
            return true;
        } catch (err) {
            state.error = err instanceof CalcError ? err.message : 'Error';
            announce(state.error);
            return false;
        }
    }

    /** Live result while typing — evaluates the complete part of the expression. */
    function computePreview() {
        if (state.error) return { text: state.error, error: true };
        if (state.justEvaluated || !state.expr) return { text: '' };

        let expr = state.expr;
        while (expr && (isOp(last(expr)) || last(expr) === '(')) expr = expr.slice(0, -1);
        if (!expr || /^−?[\d.]+(e[+\-]?\d+)?$/i.test(expr)) return { text: '' };

        try {
            return { text: '= ' + formatPlain(toExprString(evaluate(balance(expr)))) };
        } catch (err) {
            if (err instanceof CalcError && err.message === "Can't divide by 0") {
                return { text: err.message, error: true };
            }
            return { text: '' };
        }
    }

    /* ======================================================================
       Rendering
       ====================================================================== */
    function render() {
        // Main line
        if (state.expr) {
            renderInto(expressionEl, state.expr);
        } else {
            const ph = document.createElement('span');
            ph.className = 'placeholder';
            ph.textContent = '0';
            expressionEl.replaceChildren(ph);
        }
        expressionEl.setAttribute('aria-label', 'Expression: ' + (state.expr ? formatPlain(state.expr) : '0'));

        // Previous calculation
        if (state.previous) {
            renderInto(previousEl, state.previous);
            previousEl.append(' =');
        } else {
            previousEl.replaceChildren();
        }

        // Preview
        const preview = computePreview();
        previewEl.textContent = preview.text;
        previewEl.classList.toggle('is-error', !!preview.error);

        display.classList.toggle('is-result', state.justEvaluated);
        fitExpression();
    }

    /** Shrink the main line's font until it fits, then scroll to the end. */
    function fitExpression() {
        expressionEl.style.removeProperty('--expr-size');
        const base = parseFloat(getComputedStyle(expressionEl).fontSize);
        const min = Math.max(18, base * 0.42);
        let size = base;
        while (expressionEl.scrollWidth > expressionEl.clientWidth + 1 && size > min) {
            size = Math.max(min, size * 0.9);
            expressionEl.style.setProperty('--expr-size', size + 'px');
        }
        expressionEl.scrollLeft = expressionEl.scrollWidth;
        previousEl.scrollLeft = previousEl.scrollWidth;
    }

    function shake() {
        display.classList.remove('is-shake');
        void display.offsetWidth; // restart the animation
        display.classList.add('is-shake');
    }

    function announce(text) {
        liveEl.textContent = '';
        // Defer so repeated identical messages are still announced.
        requestAnimationFrame(() => { liveEl.textContent = text; });
    }

    /* ======================================================================
       History
       ====================================================================== */
    let history = storage.get(STORAGE.history, []);
    if (!Array.isArray(history)) history = [];

    function addHistory(expr, result) {
        history.unshift({ expr, result });
        if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
        storage.set(STORAGE.history, history);
        renderHistory();
    }

    function renderHistory() {
        const frag = document.createDocumentFragment();
        history.forEach((item, i) => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'history-item';
            btn.dataset.index = String(i);

            const e = document.createElement('span');
            e.className = 'h-expr';
            e.textContent = formatPlain(item.expr) + ' =';

            const r = document.createElement('span');
            r.className = 'h-result';
            r.textContent = formatPlain(item.result);

            btn.setAttribute('aria-label', `${e.textContent} ${r.textContent}. Use result`);
            btn.append(e, r);
            li.append(btn);
            frag.append(li);
        });
        historyList.replaceChildren(frag);
        historyEmpty.hidden = history.length > 0;
        historyClear.disabled = history.length === 0;
    }

    const wideQuery = window.matchMedia('(min-width: 900px) and (min-height: 600px)');
    let historyOpen = false;

    function setHistoryOpen(open, { restoreFocus = true } = {}) {
        historyOpen = open && !wideQuery.matches;
        app.classList.toggle('history-open', historyOpen);
        scrim.hidden = !historyOpen;
        historyToggle.setAttribute('aria-expanded', String(historyOpen));
        historyToggle.setAttribute('aria-label', historyOpen ? 'Hide history' : 'Show history');
        // Off-screen sheet must not be focusable; the side panel always is.
        historyEl.inert = !wideQuery.matches && !historyOpen;
        if (historyOpen) historyClose.focus();
        else if (restoreFocus && historyEl.contains(document.activeElement)) historyToggle.focus();
    }

    /* ======================================================================
       Actions & events
       ====================================================================== */
    function perform(action, value) {
        switch (action) {
            case 'clear':
                clearAll();
                playSound('clear');
                break;
            case 'backspace':
                backspace();
                playSound('discard');
                break;
            case 'paren':
                smartParen();
                playSound('click');
                break;
            case 'equals':
                if (equals()) playSound('correct');
                else if (state.error) {
                    playSound('error');
                    shake();
                }
                break;
            default:
                if (input(value)) playSound('click');
                else shake();
        }
        render();
    }

    keypad.addEventListener('click', (e) => {
        const key = e.target.closest('.key');
        if (!key) return;
        perform(key.dataset.action, key.dataset.value);
    });

    // Keyboard support
    const KEY_MAP = {
        '+': '+', '-': '−', '−': '−',
        '*': '×', 'x': '×', 'X': '×', '×': '×',
        '/': '÷', '÷': '÷',
        '%': '%', '(': '(', ')': ')',
        '.': '.', ',': '.',
    };

    function flashKey(selector) {
        const btn = keypad.querySelector(selector);
        if (!btn) return;
        btn.classList.add('is-pressed');
        setTimeout(() => btn.classList.remove('is-pressed'), 120);
    }

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        if (e.key === 'Escape' && historyOpen) {
            e.preventDefault();
            setHistoryOpen(false);
            return;
        }
        if (historyOpen) return; // don't type behind the sheet

        const k = e.key;
        if (isDigit(k)) {
            e.preventDefault();
            flashKey(`[data-value="${k}"]`);
            perform(undefined, k);
        } else if (KEY_MAP[k]) {
            e.preventDefault();
            const v = KEY_MAP[k];
            flashKey(v === '(' || v === ')' ? '[data-action="paren"]' : `[data-value="${v}"]`);
            perform(undefined, v);
        } else if (k === 'Enter' || k === '=') {
            e.preventDefault(); // stop Enter also "clicking" a focused key
            flashKey('[data-action="equals"]');
            perform('equals');
        } else if (k === 'Backspace') {
            e.preventDefault();
            flashKey('[data-action="backspace"]');
            perform('backspace');
        } else if (k === 'Escape' || k === 'Delete') {
            e.preventDefault();
            flashKey('[data-action="clear"]');
            perform('clear');
        }
    });

    // Paste an expression (e.g. "12*(3+4)")
    document.addEventListener('paste', (e) => {
        const text = e.clipboardData?.getData('text') || '';
        if (!text) return;
        e.preventDefault();
        if (state.justEvaluated) {
            state.expr = '';
            state.justEvaluated = false;
        }
        for (const ch of text.replace(/[\s,]/g, '')) {
            const mapped = isDigit(ch) ? ch : KEY_MAP[ch];
            if (mapped) input(mapped);
        }
        render();
    });

    // Copy the current value when nothing is selected
    document.addEventListener('copy', (e) => {
        const selection = window.getSelection()?.toString();
        if (selection || !state.expr) return;
        e.preventDefault();
        const plain = state.expr.replace(/−/g, '-').replace(/×/g, '*').replace(/÷/g, '/');
        e.clipboardData.setData('text/plain', plain);
    });

    historyToggle.addEventListener('click', () => setHistoryOpen(!historyOpen));
    historyClose.addEventListener('click', () => setHistoryOpen(false));
    scrim.addEventListener('click', () => setHistoryOpen(false));

    historyClear.addEventListener('click', () => {
        history = [];
        storage.set(STORAGE.history, history);
        renderHistory();
        playSound('clear');
    });

    historyList.addEventListener('click', (e) => {
        const btn = e.target.closest('.history-item');
        if (!btn) return;
        const item = history[Number(btn.dataset.index)];
        if (!item) return;
        state.expr = item.result;
        state.previous = item.expr;
        state.justEvaluated = true;
        state.error = '';
        playSound('click');
        render();
        setHistoryOpen(false, { restoreFocus: false });
    });

    soundToggle.addEventListener('click', () => {
        soundOn = !soundOn;
        storage.set(STORAGE.sound, soundOn);
        renderSoundToggle();
        if (soundOn) playSound('click');
    });

    themeToggle.addEventListener('click', toggleTheme);
    darkQuery.addEventListener('change', renderTheme);
    wideQuery.addEventListener('change', () => setHistoryOpen(false, { restoreFocus: false }));

    display.addEventListener('animationend', () => display.classList.remove('is-shake'));
    if ('ResizeObserver' in window) new ResizeObserver(fitExpression).observe(display);

    /* ======================================================================
       Init
       ====================================================================== */
    renderTheme();
    renderSoundToggle();
    renderHistory();
    setHistoryOpen(false, { restoreFocus: false });
    render();

    // Exposed for testing in the console / automated checks.
    window.Calculator = { evaluate, toExprString, input, equals, state };
})();
