import { notify } from "./notify.js";
import { getFeatureChoices, getGrantedSlugs, resolveImagePath, listWildcardMatches, isWildcardPath, canBrowseFiles } from "./thrall-manager.js";

/**
 * Bloody Tendril zone: the PF2e Aura effect each tendril carries, and how it looks
 * (Outline / Outrider: Dramatis tiles / custom files).
 */
const MODULE = "necromancer-thrall-helper";
const ZONE_RED = "#c0392b";
const MANIFEST_PATH = `modules/${MODULE}/data/dramatis-tendrils.json`;
const GITHUB_LISTING = "https://api.github.com/repos/0utrider/dramatis/contents/tiles/bloody-tendrils";
export const TENDRIL_EFFECT_UUID = `Compendium.${MODULE}.necro-effects.Item.necroTendrilZone`;
export const ZONE_DEFAULTS = { mode: "outline", customPath: "", alpha: 0.3 };

// Grim Fascination slug -> Dramatis style. Anything else uses the neutral "template" set.
const STYLE_FOR_FASCINATION = { blood: "bloody", bone: "bone", flesh: "flesh", spirit: "spirit" };

const warned = new Set();
function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    notify("warn", message);
}

export function getZoneConfig(actor) {
    const saved = actor?.getFlag(MODULE, "tendrilZone") ?? {};
    const alpha = Number(saved.alpha);
    return {
        mode: ["outline", "dramatis", "custom"].includes(saved.mode) ? saved.mode : ZONE_DEFAULTS.mode,
        customPath: typeof saved.customPath === "string" ? saved.customPath : "",
        alpha: Number.isFinite(alpha) ? Math.min(1, Math.max(0.05, alpha)) : ZONE_DEFAULTS.alpha
    };
}

/** Dramatis style names for this necromancer: Grim Fascination, plus Widespread Fascination if taken. */
export function getDramatisStyles(actor) {
    const slugs = [...getGrantedSlugs(actor, "grim-fascination"), ...getGrantedSlugs(actor, "widespread-fascination")];
    const styles = [...new Set(slugs.map(s => STYLE_FOR_FASCINATION[s]).filter(Boolean))];
    return styles.length ? styles : ["template"];
}

/** For the settings dialog: "Art style: spirit — from Grim Fascination: Spirit". */
export function describeDramatisStyle(actor) {
    const styles = getDramatisStyles(actor).join(" + ");
    const names = [
        ...getFeatureChoices(actor, "grim-fascination"),
        ...getFeatureChoices(actor, "widespread-fascination")
    ].map(c => c.name);
    return names.length
        ? `Art style: ${styles} \u2014 from Grim Fascination: ${names.join(", ")}`
        : `Art style: ${styles} \u2014 no Grim Fascination found`;
}

export function outlineAppearance(alpha = ZONE_DEFAULTS.alpha) {
    return {
        border: { color: ZONE_RED, alpha },
        highlight: { color: ZONE_RED, alpha: alpha / 3 },
        texture: null
    };
}

export function tileAppearance(src, alpha = ZONE_DEFAULTS.alpha) {
    return {
        border: null,
        highlight: { color: ZONE_RED, alpha: 0.1 },
        texture: { src, alpha, scale: 1, loop: true }
    };
}

let manifestPromise = null;
/** Shipped manifest, refreshed once per session from the Dramatis repo when reachable. */
function loadManifest() {
    manifestPromise ??= (async () => {
        let manifest = null;
        try {
            const res = await fetch(MANIFEST_PATH);
            if (res.ok) manifest = await res.json();
        } catch (err) { console.warn("Necromancer Thrall Helper | Could not read the Dramatis manifest:", err); }
        manifest ??= { base: "https://0utrider.github.io/dramatis/tiles/bloody-tendrils/", styles: {} };
        try {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 3000);
            const res = await fetch(GITHUB_LISTING, { signal: ctl.signal });
            clearTimeout(timer);
            if (res.ok) {
                const files = (await res.json()).map(f => f.name).filter(n => /^bloody-tendrils-.+-\d+\.webp$/.test(n));
                const live = {};
                for (const name of files) {
                    const style = name.match(/^bloody-tendrils-(.+)-\d+\.webp$/)[1];
                    (live[style] ??= []).push(name);
                }
                if (Object.keys(live).length) manifest.styles = live;
            }
        } catch { /* offline or rate-limited: keep the shipped list */ }
        return manifest;
    })();
    return manifestPromise;
}

const lastTile = new Map();
async function pickDramatisTile(actor) {
    const manifest = await loadManifest();
    const pool = getDramatisStyles(actor).flatMap(s => (manifest.styles?.[s] ?? []).map(n => manifest.base + n));
    if (!pool.length) return null;
    const key = actor.id;
    const choices = pool.length > 1 ? pool.filter(u => u !== lastTile.get(key)) : pool;
    const pick = choices[Math.floor(Math.random() * choices.length)];
    lastTile.set(key, pick);
    return pick;
}

/** Load a texture to prove it works (online, exists, CORS). */
export async function textureLoads(src) {
    try {
        const tex = await (foundry.canvas?.loadTexture ?? globalThis.loadTexture)(src);
        return !!tex;
    } catch (err) {
        console.warn(`Necromancer Thrall Helper | Zone texture failed to load: ${src}`, err);
        return false;
    }
}

/**
 * Appearance for one new tendril. `pending` is set when a player without file-browser access picked
 * a local wildcard: the GM resolves it (see finalizePendingZone).
 */
export async function buildZoneAppearance(actor) {
    const cfg = getZoneConfig(actor);
    const outline = { appearance: outlineAppearance(cfg.alpha), pending: null };
    if (cfg.mode === "outline") return outline;

    if (cfg.mode === "dramatis") {
        const src = await pickDramatisTile(actor);
        if (src && await textureLoads(src)) return { appearance: tileAppearance(src, cfg.alpha), pending: null };
        warnOnce("dramatis", "Couldn't load the Outrider: Dramatis tendril art (offline?). Using the outline instead.");
        return outline;
    }

    const path = cfg.customPath.trim();
    if (!path) {
        warnOnce("custom-empty", "Tendril zone is set to Custom file(s) but no path is set. Using the outline instead.");
        return outline;
    }
    const remote = /^https?:\/\//i.test(path);
    if (isWildcardPath(path)) {
        if (remote) {
            warnOnce("custom-remote-wild", "Wildcards only work for files on this server, not remote URLs. Using the outline instead.");
            return outline;
        }
        if (!canBrowseFiles()) return { appearance: outline.appearance, pending: { path, alpha: cfg.alpha } };
        if (!(await listWildcardMatches(path)).length) {
            warnOnce("custom-nomatch", `No files match "${path}". Using the outline instead.`);
            return outline;
        }
    }
    const src = await resolveImagePath(path);
    if (await textureLoads(src)) return { appearance: tileAppearance(src, cfg.alpha), pending: null };
    warnOnce("custom-load", `Couldn't load the tendril zone art "${path}". Using the outline instead.`);
    return outline;
}

function inlineEffect(auraFeet) {
    return {
        name: "Effect: Bloody Tendril Zone",
        type: "effect",
        img: "icons/skills/wounds/blood-spurt-spray-red.webp",
        system: {
            slug: "bloody-tendril-zone",
            tokenIcon: { show: false },
            description: { value: "<p>Creatures that end their turn in this aura must attempt the Bloody Tendrils save.</p>" },
            duration: { value: -1, unit: "unlimited" },
            rules: [{ key: "Aura", slug: "bloody-tendril-zone", radius: auraFeet, traits: [], effects: [] }]
        }
    };
}

/**
 * The tendril's zone effect: the module compendium copy when available, else built inline.
 * Returns { effect, pending }.
 */
export async function buildTendrilEffect(actor, auraFeet) {
    let effect = null;
    try {
        const doc = await fromUuid(TENDRIL_EFFECT_UUID);
        if (doc) effect = doc.toObject();
    } catch { /* pack missing: inline copy below */ }
    if (effect) {
        delete effect._id;
        delete effect.folder;
        delete effect.ownership;
        delete effect._stats;
        delete effect._key;
    } else {
        effect = inlineEffect(auraFeet);
    }
    const rule = effect.system.rules.find(r => r.key === "Aura") ?? effect.system.rules[0];
    rule.radius = auraFeet;
    effect.system.tokenIcon = { show: false };
    const { appearance, pending } = await buildZoneAppearance(actor);
    rule.appearance = appearance;
    return { effect, pending };
}

/** GM side: resolve a player's pending custom wildcard into the zone texture. */
export async function finalizePendingZone(payload) {
    const flags = payload.flags?.[MODULE];
    const pending = flags?.pendingZone;
    if (!pending) return payload;
    delete flags.pendingZone;
    const effect = payload.delta?.items?.find(i => i.system?.slug === "bloody-tendril-zone");
    const rule = effect?.system?.rules?.find(r => r.key === "Aura");
    if (!rule) return payload;
    const matches = await listWildcardMatches(pending.path);
    if (!matches.length) return payload; // keeps the outline
    const src = await resolveImagePath(pending.path);
    if (await textureLoads(src)) rule.appearance = tileAppearance(src, pending.alpha);
    return payload;
}

/** Zone auras only draw on scenes with token vision (and in encounters, or when selected/hovered). */
let visibilityNoticeShown = false;
export function noteZoneVisibility() {
    if (visibilityNoticeShown || !game.user.isGM || canvas.scene?.tokenVision) return;
    visibilityNoticeShown = true;
    notify("info", "This scene has Token Vision off, so tendril zones won't be drawn. Saves and damage still work.");
}
