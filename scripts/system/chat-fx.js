import { DMG_COLORS, CARD_COLORS, DMG_ICONS } from "./dmg-palette.js";
import { findNecroEffect } from "./effect-catalog.js";

// Chat cards for thrall Strikes and necromancer spells: graphite card, border in the damage type's
// color, gradient and glow. A hidden marker is stamped into the flavor when the message is created, and
// the CSS (added the first time a card needs it) keys on it, so the cards look the same for every player,
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

// Card background: the tint fades to graphite within the header, so the dice boxes and icons sit on a dark card (see chatCss).
// Per-type backgrounds that replace the default. Void: black at the top, sinking into the abyss purple.
const CARD_BACKGROUNDS = {
    void: (c) => `linear-gradient(180deg,#000 0%,#07050d 30%,${mix(c, 30, "#000")} 75%,${mix(c, 55, "#000")} 100%)`
};

// One shared rule set. Each card's colors arrive as custom properties set on its <li> by styleCard(),
// so the sheet stays small and never needs :has(). The percent signs live in --nth-t1/--nth-t2 (not after var()).
// The selector's three attribute/class parts match the specificity the old :has() version had.
const SEL = "li.chat-message.nth-card[data-nth][data-nth-kind]";
const tr = (p) => mix("var(--nth)", p, "transparent");

function chatCss() {
    const sel = SEL;
    const bg = `radial-gradient(110% 80% at 100% 100%,${tr(14)},transparent 60%),` +
        `linear-gradient(180deg,color-mix(in srgb,var(--nth) var(--nth-t1),${CARD_BASE}) 0%,` +
        `color-mix(in srgb,var(--nth) var(--nth-t2),${CARD_BASE}) 10%,${CARD_BASE} 22%)`;
    const rules = [
        `${sel}{border:2px solid var(--nth);border-radius:8px;color:#ececef;background:${bg} !important;` +
            `box-shadow:0 0 8px ${tr(55)},inset 0 0 6px ${tr(30)}}`,
        `${sel} .message-header{border-bottom:1px solid ${tr(70)}}`,
        `${sel} .message-header, ${sel} .flavor-text, ${sel} .message-content{color:#ececef}`,
        `${sel} .message-metadata, ${sel} .message-metadata a, ${sel} .whisper-to{color:#b3b3bc}`,
        `${sel} .card-header h3{color:var(--nth-ink);text-shadow:0 0 1px var(--nth), 0 0 6px ${tr(40)};font-weight:bold}`,
        `${sel} h4.action, ${sel} h4.action strong{color:#ececef}`,
        `${sel} h4.message-sender{color:#ececef}`,
        `${sel} .message-content :is(h1,h2,h3):not(.card-header h3){color:#ececef;border-color:${tr(50)}}`,
        `${sel} .message-content button{color:#ececef;background:rgba(255,255,255,.07);border:1px solid ${mix("var(--nth)", 45, "#555")};box-shadow:none}`,
        `${sel} .message-content button:hover{background:${tr(22)};border-color:var(--nth);box-shadow:0 0 4px ${tr(50)}}`,
        `${sel} .message-content button.critical-success{color:var(--nth-ink)}`,
        `${sel} .dice-formula{color:#ececef;background:rgba(0,0,0,.5);border:1px solid ${tr(35)}}`,
        `${sel} .dice-total{background:rgba(0,0,0,.5);border:1px solid ${tr(50)}}`,
        `${sel} .dice-total:not([class*="success"]):not([class*="failure"]){color:#fff}`,
        `${sel} .dice-tooltip .tooltip-part{background:rgba(0,0,0,.4);border-color:${tr(30)}}`,
        `${sel} :is(.degree-of-success, .dice-total) :is(.critical-success, .criticalSuccess), ${sel} .dice-total:is(.critical-success, .criticalSuccess){color:#5fd87a}`,
        `${sel} .degree-of-success .success, ${sel} .dice-total.success{color:#7fb4ff}`,
        `${sel} .degree-of-success .failure, ${sel} .dice-total.failure{color:#ffa64d}`,
        `${sel} :is(.degree-of-success, .dice-total) :is(.critical-failure, .criticalFailure), ${sel} .dice-total:is(.critical-failure, .criticalFailure){color:#ff9494}`,
        `${sel} .dice-tooltip :is(.part-formula, .part-total, .part-header){color:#ececef}`,
        `${sel} :is(.damage.instance, .tooltip-part.damage){color:#ececef}`,
        `${sel} :is(.damage.instance, .tooltip-part.damage) i{color:var(--nth-icon)}`,
        `${sel} [data-visibility="gm"]:not(.dice-formula){color:#ececef;background:${tr(22)};border-radius:3px}`,
        `${sel} .message-content hr{border-color:${tr(50)};background:${tr(50)}}`,
        `${sel} h4.action i.nth-ico{color:var(--nth-icon);text-shadow:0 0 1px #000;font-size:1.35em;vertical-align:-.12em;margin-left:.15em}`,
        `${sel} .nth-head img{border:none;object-fit:cover}`,
        `${sel}[data-nth-kind="attack-roll"] h4.action{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}`
    ];
    // Per-type backgrounds that replace the default.
    for (const [t, fn] of Object.entries(CARD_BACKGROUNDS)) {
        if (CARD_COLORS[t]) rules.push(`${sel}[data-nth="${t}"]{background:${fn("var(--nth)")} !important}`);
    }
    return rules.join("\n");
}

const FX = /class="nth-fx" data-type="([^"]*)" data-kind="([^"]*)"/;

/** Give a themed card's <li> its class and color variables. Cheap string tests first: most messages aren't ours. */
function styleCard(message, html) {
    const text = message.flavor?.includes("nth-fx") ? message.flavor
        : message.content?.includes("nth-fx") ? message.content : null;
    const m = text && FX.exec(text);
    if (!m || !(html instanceof HTMLElement)) return;
    const [, type, kind] = m;
    const c = CARD_COLORS[type];
    if (!c) return;
    addCardCss();
    const top = TINT[type] ?? 28;
    html.classList.add("nth-card");
    html.dataset.nth = type;
    html.dataset.nthKind = kind;
    html.style.setProperty("--nth", c);
    html.style.setProperty("--nth-icon", DMG_COLORS[type] ?? c);
    html.style.setProperty("--nth-ink", type === "vitality" ? "#ffffff" : mix(c, type === "void" ? 40 : 65, "#fff")); // dark void needs a lighter title
    html.style.setProperty("--nth-t1", `${top}%`);
    html.style.setProperty("--nth-t2", `${Math.round(top * 0.43)}%`);
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

// A spell description card (the cast card PF2e posts before the rolls).
function decorateSpellCard(doc) {
    const ctx = doc.flags?.pf2e?.context;
    if (ctx?.type === "attack-roll" || ctx?.type === "damage-roll") return;
    const flavor = doc.flavor ?? "";
    if (flavor.includes("nth-fx") || flavor.includes("borrowed-fx")) return;
    const originUuid = doc.flags?.pf2e?.origin?.uuid;
    const item = originUuid ? fromUuidSync(originUuid, { strict: false }) : null;
    if (!item || item.type !== "spell" || !SPELLS.has(item.name)) return;
    const rawType = Object.values(item.system?.damageRolls ?? {})[0]?.damageType
        ?? Object.values(item.system?.damage ?? {})[0]?.type ?? null;
    const type = rawType && CARD_COLORS[rawType] ? rawType : "necro";
    doc.updateSource({ flavor: `<span class="nth-fx" data-type="${type}" data-kind="card" hidden></span>${flavor}` });
}

// A card the module posted without a roll (Conglomerate Grab, "Bone Armor Activated!", spawn notes...).
function decorateNecroCard(doc) {
    if (!doc.flags?.[MODULE]?.card || (doc.flavor ?? "").includes("nth-fx") || (doc.content ?? "").includes("nth-fx")) return;
    doc.updateSource({ flavor: `<span class="nth-fx" data-type="necro" data-kind="card" hidden></span>${doc.flavor ?? ""}` });
}

function decorateNecroMessage(doc) {
    decorateRollCard(doc);
    try { decorateSpellCard(doc); } catch (err) { console.warn("Necromancer Thrall Helper | Chat card styling skipped:", err); }
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
        if (!CARD_COLORS[type]) type = isSpell ? "necro" : "untyped";

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

/** The card sheet, added once and only when a card needs it. HEAD_CSS (header layout) is always present. */
function addCardCss() {
    if (document.getElementById("nth-card-css") || !game.settings.get(MODULE, "chatCardColors")) return;
    const style = document.createElement("style");
    style.id = "nth-card-css";
    style.textContent = chatCss();
    document.head.append(style);
}

function applyChatCss(colors) {
    document.getElementById("nth-card-css")?.remove();
    if (colors) sweepLog(); // re-adds the sheet if the log holds themed cards
}

/** Style the cards already drawn (the log renders its first batch before ready, so the hook misses them). */
function sweepLog() {
    for (const li of document.querySelectorAll("li.chat-message[data-message-id]")) {
        const message = game.messages.get(li.dataset.messageId);
        if (message) styleCard(message, li);
    }
}

/** Registers the card decorator and its CSS. Called at ready on every client. */
export function registerNecroChatFx() {
    checkDramatisArt();
    const style = document.createElement("style");
    style.id = "nth-chat-css";
    style.textContent = HEAD_CSS;
    document.head.append(style);
    Hooks.on("preCreateChatMessage", decorateNecroMessage);
    Hooks.on("renderChatMessageHTML", styleCard);
    sweepLog();
}
