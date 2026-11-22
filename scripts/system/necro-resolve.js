import { notifyForce } from "./notify.js";
import { NecroDialog } from "../ui/necro-dialog.js";

const MODULE_ID = "necromancer-thrall-helper";
const NECRO_SLUGS = ["necromancer", "reanimator", "undead-master", "conjurer-of-corpses"];
const NECRO_NAME_BITS = ["necro", "reanimator", "undead master", "conjurer of corpses"];

/**
 * True if the actor is a Necromancer: matched by class/archetype/feat slug first (plus the module's
 * own flags), then by a looser name check on non-spell items so "Necrotic Bomb" doesn't count.
 */
export function isNecromancer(actor) {
    if (!actor?.items) return false;
    if (actor.flags?.[MODULE_ID]?.familyTree) return true;
    if (actor.items.some(i => i.flags?.[MODULE_ID])) return true;
    if (actor.items.some(i => NECRO_SLUGS.includes(i.system?.slug ?? i.slug))) return true;
    return actor.items.some(i => {
        if (["spell", "effect", "condition", "equipment", "weapon", "consumable"].includes(i.type)) return false;
        const name = i.name.toLowerCase();
        const slug = i.system?.slug || "";
        return NECRO_NAME_BITS.some(bit => name.includes(bit) || slug.includes(bit));
    });
}

/** The "Require Necromancer Features" setting relaxes the check to any player character. */
function canCommand(actor) {
    if (!actor) return false;
    if (!game.settings.get(MODULE_ID, "requireNecromancer")) return actor.type === "character" || isNecromancer(actor);
    return isNecromancer(actor);
}

/** Owner check. A GM implicitly owns everything, so only an explicit ownership level counts for them when `explicit` is set. */
export function userOwns(actor, { explicit = false } = {}) {
    if (!actor) return false;
    if (game.user.isGM) return !explicit || actor.ownership?.[game.user.id] === CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    return actor.isOwner;
}

function pickNecromancer(actors) {
    const options = actors.map(a => `<option value="${a.id}">${foundry.utils.escapeHTML(a.name)}</option>`).join("");
    return new Promise(resolve => {
        new NecroDialog({
            title: "Command Deck: Choose Necromancer",
            content: `<form><div class="form-group"><label>Necromancer</label><select name="necro">${options}</select></div></form>`,
            buttons: {
                ok: {
                    icon: '<i class="fas fa-skull"></i>',
                    label: "Open",
                    callback: (html) => resolve(game.actors.get(html.find('[name="necro"]').val()) ?? null)
                }
            },
            default: "ok",
            close: () => resolve(null)
        }).render(true);
    });
}

/**
 * Work out which Necromancer's deck the current user means. Order:
 *   1. controlled tokens: a thrall resolves to its master (masterId flag), a necromancer to itself
 *   2. the user's assigned character
 *   3. necromancers the user owns (several: ask which)
 *   4. GM only: the family-tree necromancer, or ask among all necromancers
 * Returns { actor, reason } on success, or { actor: null, reason, error } with a message that says
 * what is wrong. The caller reports the error.
 */
export async function resolveNecromancer({ prompt = true } = {}) {
    const controlled = canvas.tokens?.controlled ?? [];
    let blocked = null; // the most specific reason step 1 failed, for the final message

    // 1. Controlled tokens
    const found = new Map();
    for (const token of controlled) {
        const masterId = token.document?.getFlag(MODULE_ID, "masterId");
        const master = masterId ? game.actors.get(masterId) : null;
        const candidate = master ?? token.actor;
        if (!candidate || !canCommand(candidate)) {
            blocked ??= `The selected token (${token.name}) isn't a necromancer or one of their thralls.`;
            continue;
        }
        if (!userOwns(candidate)) {
            blocked = `You don't own ${candidate.name}.`;
            continue;
        }
        if (!found.has(candidate.id)) found.set(candidate.id, { actor: candidate, reason: master ? "controlled-thrall" : "controlled-token" });
    }
    if (found.size) {
        const [first, ...rest] = found.values();
        if (rest.length) console.log(`${MODULE_ID} | Several necromancers selected, using ${first.actor.name}.`);
        return first;
    }

    // 2. Assigned character
    const character = game.user.character;
    if (character && canCommand(character) && userOwns(character)) return { actor: character, reason: "user-character" };

    // 3. Necromancers the user owns
    const owned = game.actors.filter(a => canCommand(a) && userOwns(a, { explicit: true }));
    if (owned.length === 1) return { actor: owned[0], reason: "owned" };
    if (owned.length > 1) {
        if (!prompt) return { actor: null, reason: "ambiguous", error: "You own several necromancers: select one's token to choose." };
        const picked = await pickNecromancer(owned);
        return picked ? { actor: picked, reason: "picked" } : { actor: null, reason: "cancelled" };
    }

    // 4. GM fallback
    if (game.user.isGM) {
        const tree = game.actors.filter(a => a.flags?.[MODULE_ID]?.familyTree);
        if (tree.length === 1) return { actor: tree[0], reason: "gm-familytree" };
        const all = tree.length ? tree : game.actors.filter(a => isNecromancer(a));
        if (all.length && prompt) {
            const picked = await pickNecromancer(all);
            return picked ? { actor: picked, reason: "picked" } : { actor: null, reason: "cancelled" };
        }
    }

    const error = blocked
        ?? (character && !canCommand(character) ? `${character.name} lacks the dark blood and discipline required to command the dead.` : null)
        ?? "No necromancer found: assign your character in User Configuration, or select your necromancer's token.";
    return { actor: null, reason: "none", error };
}

/** Resolve and report: shows the specific notification on failure. Returns the actor or null. */
export async function resolveNecromancerOrNotify(opts) {
    const result = await resolveNecromancer(opts);
    if (!result.actor && result.reason !== "cancelled") notifyForce("warn", result.error);
    return result.actor ?? null;
}

/**
 * GM-side: tag undead whose PF2e master is a necromancer with our masterId flag, so every
 * thrall-finding path sees them (Conjurer of Corpses undead are not spawned by this module).
 * Only the active GM writes, so several GM clients don't duplicate the update.
 */
export async function stampMasterTags(scene = canvas.scene, tokens = null) {
    if (!game.users.activeGM?.isSelf || !scene) return;
    const updates = [];
    for (const t of tokens ?? scene.tokens) {
        if (t.flags?.[MODULE_ID]?.masterId || !t.actor) continue;
        const traits = t.actor.system?.traits?.value ?? [];
        if (!traits.some(tr => typeof tr === "string" && tr.toLowerCase() === "undead")) continue;
        const masterId = t.actor.getFlag("pf2e", "master")?.id;
        const master = masterId ? game.actors.get(masterId) : null;
        if (master && isNecromancer(master)) updates.push({ _id: t.id, [`flags.${MODULE_ID}.masterId`]: master.id });
    }
    if (updates.length) await scene.updateEmbeddedDocuments("Token", updates);
}

/** Re-target an open deck when the user selects another necromancer (or one of their thralls). */
async function followSelection() {
    const deck = foundry.applications.instances.get("thrall-command-deck");
    if (!deck?.rendered || !game.settings.get(MODULE_ID, "followSelection")) return;
    const { actor, reason } = await resolveNecromancer({ prompt: false });
    if (actor && reason?.startsWith("controlled") && actor.id !== deck.necroId) deck.setNecromancer(actor.id);
}

export function setupResolveHooks() {
    Hooks.on("createToken", (doc) => {
        if (doc.parent) stampMasterTags(doc.parent, [doc]).catch(err => console.warn(`${MODULE_ID} | Master tagging failed:`, err));
    });
    Hooks.on("canvasReady", () => {
        stampMasterTags().catch(err => console.warn(`${MODULE_ID} | Master tagging failed:`, err));
    });
    Hooks.on("controlToken", () => setTimeout(() => followSelection().catch(err => console.warn(err)), 0));
}
