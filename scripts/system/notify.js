/**
 * Toast notifications filtered by the per-user "notificationLevel" client setting:
 *   all        every message
 *   important  warnings and errors (default)
 *   errors     errors only
 *   none       nothing (suppressed messages are still logged to the console)
 * Pass { force: true } (or use notifyForce) for messages the user must see to act, such as
 * placement instructions and permission denials.
 */
const RANK = { info: 0, warn: 1, error: 2 };
const MIN = { all: 0, important: 1, errors: 2, none: 3 };
const DEDUPE_MS = 1500;
const recent = new Map();

function currentLevel() {
    try {
        return game.settings.get("necromancer-thrall-helper", "notificationLevel") || "important";
    } catch (err) {
        return "important"; // setting not registered yet
    }
}

export function notify(level, msg, opts = {}) {
    // The same toast fired repeatedly (e.g. from a loop) shows once.
    const key = `${level}|${msg}`;
    const now = Date.now();
    if (now - (recent.get(key) ?? 0) < DEDUPE_MS) return;
    recent.set(key, now);
    if (recent.size > 50) for (const [k, t] of recent) if (now - t > DEDUPE_MS) recent.delete(k);

    if (opts.force || RANK[level] >= (MIN[currentLevel()] ?? 1)) return ui.notifications[level](msg, opts);
    console.debug(`necromancer-thrall-helper | ${level}: ${msg}`);
}

export const notifyForce = (level, msg, opts = {}) => notify(level, msg, { ...opts, force: true });

/**
 * Run a Command Deck action and turn a failure into a toast. A player who can't update a thrall's
 * items (they don't own it) gets a plain explanation instead of a silent console error.
 */
export async function guardAction(fn) {
    try {
        return await fn();
    } catch (err) {
        console.error("Necromancer Thrall Helper | action failed:", err);
        const denied = /lacks permission|permission/i.test(err?.message ?? "");
        notifyForce("error", denied
            ? "You don't own this thrall. Ask the GM to give you ownership."
            : `That action failed: ${err?.message ?? err}`);
    }
}


// --- Placement hints: a small label that follows the cursor instead of a toast ---
const HINT_TIMEOUT_MS = 20000;
let hintEl = null;
let hintTimer = null;
let hintObserver = null;
let pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

function positionHint() {
    if (!hintEl) return;
    const w = hintEl.offsetWidth, h = hintEl.offsetHeight;
    const x = Math.min(pointer.x + 16, window.innerWidth - w - 4);
    const y = Math.min(pointer.y + 18, window.innerHeight - h - 4);
    hintEl.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, y)}px)`;
}

document.addEventListener("pointermove", (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    positionHint();
}, { passive: true, capture: true });

const onHintKey = (e) => { if (e.key === "Escape") clearPlacementHint(); };
const onHintPointer = (e) => { if (e.button === 2) clearPlacementHint(); };

/**
 * Show placement instructions next to the cursor. It is cleared when the placement code resets the
 * body cursor (every placement flow does when it finishes or is cancelled), on Escape, on
 * right-click, or after 20 seconds. Calling it again updates the text for the next step.
 * At the "all" notification level the message is also shown as a toast.
 */
export function placementHint(msg) {
    if (currentLevel() === "all") notify("info", msg);
    else console.debug(`necromancer-thrall-helper | hint: ${msg}`);
    if (!hintEl) {
        hintEl = document.createElement("div");
        hintEl.className = "necro-placement-hint";
        hintEl.style.cssText = "position: fixed; left: 0; top: 0; z-index: 10000; pointer-events: none; max-width: 260px; "
            + "padding: 5px 9px; border-radius: 4px; border: 1px solid #7c3aed; background: rgba(18,18,24,.92); "
            + "color: #e4e4e7; font: 12px var(--font-primary, Signika, sans-serif); line-height: 1.3;";
        document.body.appendChild(hintEl);
        document.addEventListener("keydown", onHintKey, true);
        document.addEventListener("pointerdown", onHintPointer, true);
        hintObserver = new MutationObserver(() => { if (document.body.style.cursor !== "crosshair") clearPlacementHint(); });
        hintObserver.observe(document.body, { attributes: true, attributeFilter: ["style"] });
    }
    hintEl.replaceChildren();
    const icon = document.createElement("i");
    icon.className = "fas fa-crosshairs";
    icon.style.cssText = "color: #a78bfa; margin-right: 6px;";
    hintEl.append(icon, document.createTextNode(msg));
    positionHint();
    clearTimeout(hintTimer);
    hintTimer = setTimeout(clearPlacementHint, HINT_TIMEOUT_MS);
}

export function clearPlacementHint() {
    clearTimeout(hintTimer);
    hintTimer = null;
    hintObserver?.disconnect();
    hintObserver = null;
    hintEl?.remove();
    hintEl = null;
    document.removeEventListener("keydown", onHintKey, true);
    document.removeEventListener("pointerdown", onHintPointer, true);
}
