import { DMG_COLORS, CARD_COLORS, DMG_ICONS } from "./dmg-palette.js";
import { findNecroEffect } from "./effect-catalog.js";

// Chat cards for thrall Strikes and necromancer spells: graphite card, border in the damage type's
// color, gradient and glow. A hidden marker is stamped into the flavor when the message is created, and
// the CSS (injected on every client at ready) keys on it, so the cards look the same for every player,
// after a reload, and in chat history. Cards are matched by what rolled them, not by who clicked, so
// rolls from a character sheet are styled too. A card with more than one damage type takes the color
// of its first damage instance.

const MODULE = "necromancer-thrall-helper";
const CARD_BASE = "#404047";
const TINT = { vitality: 22 };
const SPELLS = new Set([
    "Bone Spear", "Dead Weight", "Blood Infusion", "Flesh Tsunami", "Temporary Possession", "Calcification",
    "Deathly Scream", "Necrotic Bomb", "Life Tap", "Bony Barrage", "Dread Mosquito Storm", "Zombie Horde",
    "Bloody Tendrils", "Recurring Nightmare", "Blossoming Gore", "Blossoming Gore Hazard", "Conglomerate Grab",
    "Song of the Soul", "Amalgamate", "Reanimate Foe", "Living Graveyard"
]);

// David's Dramatis art for Strike cards, by damage type. Falls back to Foundry icons when the setting
// says so, the type has no art, or the art can't be loaded (checked once at ready, on the rolling client).
const STRIKE_ART = {
    physical: "https://0utrider.github.io/dramatis/icons/abilities/thrall-strike-physical.webp",
    spirit: "https://0utrider.github.io/dramatis/icons/abilities/thrall-strike-spirit.webp",
    vitality: "https://0utrider.github.io/dramatis/icons/abilities/thrall-strike-vitality.webp",
    void: "https://0utrider.github.io/dramatis/icons/abilities/thrall-strike-void.webp"
};
const CHARGE_FALLBACK_ICON = "icons/magic/death/undead-ghost-strike-white.webp";
let dramatisReachable = false;
const strikeArt = (type) => {
    if (!dramatisReachable || game.settings.get(MODULE, "strikeCardArt") !== "dramatis") return null;
    return STRIKE_ART[["bludgeoning", "piercing", "slashing"].includes(type) ? "physical" : type] ?? null;
};

const esc = (v) => foundry.utils.escapeHTML(String(v ?? ""));
const mix = (color, percent, base) => `color-mix(in srgb,${color} ${percent}%,${base})`;

// Card background. The tint fades to graphite within the header, so the dice boxes and icons sit on a dark card.
const cardBackground = (c, top) =>
    `radial-gradient(110% 80% at 100% 100%,${mix(c, 14, "transparent")},transparent 60%),` +
    `linear-gradient(180deg,${mix(c, top, CARD_BASE)} 0%,${mix(c, Math.round(top * 0.43), CARD_BASE)} 10%,${CARD_BASE} 22%)`;
// Per-type backgrounds that replace the default. Void: black at the top, sinking into the abyss purple.
const CARD_BACKGROUNDS = {
    void: (c) => `linear-gradient(180deg,#000 0%,#07050d 30%,${mix(c, 30, "#000")} 75%,${mix(c, 55, "#000")} 100%)`
};

function chatCss() {
    return Object.entries(CARD_COLORS).map(([t, c]) => {
        const icon = DMG_COLORS[t] ?? c;
        const sel = `li.chat-message:has(.nth-fx[data-type="${t}"])`;
        const top = TINT[t] ?? 28;
        const ink = t === "vitality" ? "#ffffff" : mix(c, t === "void" ? 40 : 65, "#fff"); // dark void needs a lighter title
        return `${sel}{border:2px solid ${c};border-radius:8px;color:#ececef;` +
            `background:${(CARD_BACKGROUNDS[t] ?? ((x) => cardBackground(x, top)))(c)} !important;` +
            `box-shadow:0 0 8px ${mix(c, 55, "transparent")},inset 0 0 6px ${mix(c, 30, "transparent")}}` +
            `${sel} .message-header{border-bottom:1px solid ${mix(c, 70, "transparent")}}` +
            `${sel} .message-header, ${sel} .flavor-text, ${sel} .message-content{color:#ececef}` +
            `${sel} .message-metadata, ${sel} .message-metadata a, ${sel} .whisper-to{color:#b3b3bc}` +
            `${sel} .card-header h3{color:${ink};text-shadow:0 0 1px ${c}, 0 0 6px ${c}66;font-weight:bold}` +
            `${sel} h4.action, ${sel} h4.action strong{color:#ececef}` +
            `${sel} h4.message-sender{color:#ececef}` +
            `${sel} .message-content :is(h1,h2,h3):not(.card-header h3){color:#ececef;border-color:${mix(c, 50, "transparent")}}` +
            `${sel} .message-content button{color:#ececef;background:rgba(255,255,255,.07);border:1px solid ${mix(c, 45, "#555")};box-shadow:none}` +
            `${sel} .message-content button:hover{background:${mix(c, 22, "transparent")};border-color:${c};box-shadow:0 0 4px ${mix(c, 50, "transparent")}}` +
            `${sel} .message-content button.critical-success{color:${ink}}` +
            `${sel} .dice-formula{color:#ececef;background:rgba(0,0,0,.5);border:1px solid ${mix(c, 35, "transparent")}}` +
            `${sel} .dice-total{background:rgba(0,0,0,.5);border:1px solid ${mix(c, 50, "transparent")}}` +
            `${sel} .dice-total:not([class*="success"]):not([class*="failure"]){color:#fff}` +
            `${sel} .dice-tooltip .tooltip-part{background:rgba(0,0,0,.4);border-color:${mix(c, 30, "transparent")}}` +
            `${sel} :is(.degree-of-success, .dice-total) :is(.critical-success, .criticalSuccess), ${sel} .dice-total:is(.critical-success, .criticalSuccess){color:#5fd87a}` +
            `${sel} .degree-of-success .success, ${sel} .dice-total.success{color:#7fb4ff}` +
            `${sel} .degree-of-success .failure, ${sel} .dice-total.failure{color:#ffa64d}` +
            `${sel} :is(.degree-of-success, .dice-total) :is(.critical-failure, .criticalFailure), ${sel} .dice-total:is(.critical-failure, .criticalFailure){color:#ff9494}` +
            `${sel} .dice-tooltip :is(.part-formula, .part-total, .part-header){color:#ececef}` +
            `${sel} :is(.damage.instance, .tooltip-part.damage){color:#ececef}` +
            `${sel} :is(.damage.instance, .tooltip-part.damage) i{color:${icon}}` +
            `${sel} [data-visibility="gm"]:not(.dice-formula){color:#ececef;background:${mix(c, 22, "transparent")};border-radius:3px}` +
            `${sel} .message-content hr{border-color:${mix(c, 50, "transparent")};background:${mix(c, 50, "transparent")}}` +
            `${sel} h4.action i.nth-ico{color:${icon};text-shadow:0 0 1px #000;font-size:1.35em;vertical-align:-.12em;margin-left:.15em}` +
            `${sel} .nth-head img{border:none;object-fit:cover}` +
            `li.chat-message:has(.nth-fx[data-type="${t}"][data-kind="attack-roll"]) h4.action{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}`;
    }).join("\n");
}

const isStrikeItem = (item) => item?.system?.slug === "thrall-strike" || /^Thrall Strike/.test(item?.name ?? "");

/** Header art and title for a Thrall Strike attack card (the speaker line already names the thrall). */
function strikeHeader(tokenDoc, item, type) {
    const charge = findNecroEffect(tokenDoc.actor, "thrallCharge");
    const kamikaze = !!charge && (/kamikaze/i.test(charge.name)
        || charge.system?.rules?.some(r => r.key === "ChoiceSet" && r.selection === "yes"));
    const title = kamikaze ? "💀 Kamikaze Charge" : charge ? "Thrall Charge" : "Thrall Strike";
    const fallback = charge ? CHARGE_FALLBACK_ICON : item.img;
    const art = strikeArt(type) ?? fallback;
    let tags = "";
    if (charge) {
        const dice = charge.flags?.[MODULE]?.chargeDice;
        tags += `<span class="tag tag_transparent" data-tooltip="Thrall Charge bonus damage">Thrall Charge${dice ? ` +${dice}d6` : ""}</span>`;
        if (kamikaze) tags += `<span class="tag tag_transparent" data-tooltip="Destroyed after this damage. +${charge.system?.level?.value ?? 1} status bonus to damage.">💀 Destroy</span>`;
        tags = `<div class="tags" style="margin:2px 0 4px">${tags}</div>`;
    }
    return {
        html: `<header class="card-header flexrow nth-head"><img src="${esc(art)}" width="48" height="48" onerror="this.onerror=null;this.src='${esc(fallback)}'"><h3>${esc(title)}</h3></header>`,
        tags
    };
}

// A card the module posted without a roll (Conglomerate Grab, "Bone Armor Activated!", spawn notes...).
function decorateNecroCard(doc) {
    if (!doc.flags?.[MODULE]?.card || (doc.flavor ?? "").includes("nth-fx") || (doc.content ?? "").includes("nth-fx")) return;
    doc.updateSource({ flavor: `<span class="nth-fx" data-type="necro" data-kind="card" hidden></span>${doc.flavor ?? ""}` });
}

function decorateNecroMessage(doc) {
    decorateRollCard(doc);
    try { decorateNecroCard(doc); } catch (err) { console.warn("Necromancer Thrall Helper | Chat card styling skipped:", err); }
}

function decorateRollCard(doc) {
    try {
        const ctx = doc.flags?.pf2e?.context;
        if (!["attack-roll", "damage-roll"].includes(ctx?.type)) return;
        let flavor = doc.flavor ?? "";
        if (flavor.includes("nth-fx") || flavor.includes("borrowed-fx")) return; // rerolls copy the decorated flavor

        const originUuid = doc.flags.pf2e.origin?.uuid;
        const item = originUuid ? fromUuidSync(originUuid, { strict: false }) : null;
        if (!item) return;

        const tokenDoc = doc.speaker?.token ? game.scenes.get(doc.speaker.scene)?.tokens.get(doc.speaker.token) : null;
        const isStrike = !!tokenDoc?.getFlag(MODULE, "masterId") && isStrikeItem(item);
        const isSpell = item.type === "spell" && SPELLS.has(item.name);
        if (!isStrike && !isSpell) return;

        let type = (ctx.type === "damage-roll" ? doc.rolls[0]?.instances?.[0]?.type : null)
            ?? Object.values(item.system?.damageRolls ?? {})[0]?.damageType
            ?? Object.values(item.system?.damage ?? {})[0]?.type ?? "untyped";
        if (!CARD_COLORS[type]) type = "untyped";

        let head = "", tags = "";
        if (ctx.type === "attack-roll") {
            const tip = esc(CONFIG.PF2E?.damageTypes?.[type] ? game.i18n.localize(CONFIG.PF2E.damageTypes[type]) : type);
            const icon = DMG_ICONS[type] ?? "burst";
            flavor = flavor.replace(/(<h4 class="action">[\s\S]*?)(<\/strong>)/,
                `$1 <i class="fa-solid fa-${icon} nth-ico" data-tooltip="${tip}"></i>$2`);
            if (isStrike) ({ html: head, tags } = strikeHeader(tokenDoc, item, type));
            else head = `<header class="card-header flexrow nth-head"><img src="${esc(item.img)}" width="48" height="48"><h3>${esc(item.name)}</h3></header>`;
        }
        doc.updateSource({ flavor: `<span class="nth-fx" data-type="${type}" data-kind="${ctx.type}" hidden></span>${head}${flavor}${tags}` });
    } catch (err) {
        console.warn("Necromancer Thrall Helper | Chat card styling skipped:", err);
    }
}

// Foundry's .flexrow > * gives every child flex:1, which stretches the art; pin it to 48px.
const HEAD_CSS = `
li.chat-message .card-header.nth-head { align-items:center; gap:8px; flex-wrap:nowrap; }
li.chat-message .card-header.nth-head > img {
  flex:0 0 48px !important; width:48px; height:48px; max-width:48px;
  object-fit:cover; object-position:center; border-radius:4px; border:none; }
li.chat-message .card-header.nth-head > h3 {
  flex:1 1 auto !important; min-width:0; margin:0;
  font-size:var(--font-size-16,16px); line-height:1.15; overflow-wrap:anywhere; }`;

export function registerStrikeArtSetting() {
    game.settings.register(MODULE, "chatCardColors", {
        name: "Color chat cards",
        hint: "Color Thrall Strike, spell and module chat cards by damage type. Turn off to see them in your normal chat style (the header art stays). Applies to this browser only.",
        scope: "client", config: true, type: Boolean, default: true,
        onChange: (on) => applyChatCss(on)
    });
    game.settings.register(MODULE, "strikeCardArt", {
        name: "Thrall Strike card art",
        hint: "Art in the header of Thrall Strike attack cards: Outrider's Dramatis art by damage type, or Foundry icons.",
        scope: "world", config: true, type: String, default: "dramatis",
        choices: { dramatis: "Dramatis", foundry: "Foundry icons" }
    });
}

function checkDramatisArt() {
    const img = new Image();
    img.onload = () => { dramatisReachable = true; };
    img.onerror = () => { dramatisReachable = false; };
    img.src = STRIKE_ART.physical;
}

/** Inject (or remove) the per-type card colors. The header layout CSS stays either way. */
function applyChatCss(colors) {
    document.getElementById("nth-chat-css")?.remove();
    const style = document.createElement("style");
    style.id = "nth-chat-css";
    style.textContent = (colors ? chatCss() : "") + HEAD_CSS;
    document.head.append(style);
}

/** Registers the card decorator and its per-type CSS. Called at ready on every client. */
export function registerNecroChatFx() {
    checkDramatisArt();
    applyChatCss(game.settings.get(MODULE, "chatCardColors"));
    Hooks.on("preCreateChatMessage", decorateNecroMessage);
}
