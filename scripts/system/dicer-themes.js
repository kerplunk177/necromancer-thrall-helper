// Optional Dicer (1.4.0+) integration. Registers the module's dice themes and a default provider, so
// necromancers and their thralls use them only when nobody has picked dice for that actor. Nothing is
// written to actors or settings, and nothing runs without Dicer.
//
// Themes live in data/dicer-themes.json. Besides "necromancer" and "thralls", a Grim Fascination set can be
// added as "necromancer-<fascination>" and "thralls-<fascination>" (blood, bone, flesh, spirit); an actor
// whose Grim/Widespread Fascination matches gets that one, otherwise the plain theme.

import { getFascinations } from "../spells/spell-helpers.js";
import { isNecromancer } from "./necro-resolve.js";

const MODULE = "necromancer-thrall-helper";
const THEMES_URL = `modules/${MODULE}/data/dicer-themes.json`;

export function registerDicerSettings() {
    game.settings.register(MODULE, "dicerDefaults", {
        name: "Offer Necromancer/Thralls dice to Dicer",
        hint: "With Dicer 1.4 or later, necromancers and their thralls use the Necromancer and Thralls dice themes when no dice have been chosen for them. Existing choices are never changed, and nothing is saved on the actors.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });
}

/** The thrall's necromancer, if this actor is one of the module's thralls (token actor or base actor). */
function thrallMaster(actor) {
    const token = actor.token;
    if (token?.getFlag(MODULE, "isReanimatedFoe")) return undefined; // a reanimated monster keeps its own dice
    const masterId = token?.getFlag(MODULE, "masterId");
    if (masterId) return game.actors.get(masterId) ?? null;
    const source = actor._stats?.compendiumSource ?? actor.flags?.core?.sourceId;
    return typeof source === "string" && source.startsWith(`Compendium.${MODULE}.`) ? null : undefined;
}

export function setupDicerThemes() {
    Hooks.once("dicer.ready", async (api) => {
        try {
            const themes = await (await fetch(THEMES_URL)).json();
            for (const theme of themes) api.registerTheme(theme, { moduleId: MODULE });
            const ids = new Set(themes.map(t => t.id));

            const pick = (base, master) => {
                for (const f of getFascinations(master)) {
                    const id = `${MODULE}.${base}-${f}`;
                    if (ids.has(id)) return id;
                }
                const id = `${MODULE}.${base}`;
                return ids.has(id) ? id : null;
            };

            api.registerDefaultProvider(MODULE, (actor) => {
                if (!actor || !game.settings.get(MODULE, "dicerDefaults")) return null;
                const master = thrallMaster(actor);
                if (master !== undefined) return pick("thralls", master);
                if (actor.type === "character" && isNecromancer(actor)) return pick("necromancer", actor);
                return null;
            });
        } catch (err) {
            console.warn("Necromancer Thrall Helper | Could not set up the Dicer themes:", err);
        }
    });
}
