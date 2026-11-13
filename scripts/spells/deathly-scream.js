import { notify } from "../system/notify.js";
import { getSpellDC, getTokenDistance, ensureNecroSpell, postManualSaveCard } from "./spell-helpers.js";

export async function executeDeathlyScream({ actor, tokenDoc }) {
    const currentFocus = actor.system?.resources?.focus?.value || 0;
    if (currentFocus === 0) return notify("warn", "You have no Focus Points to cast Deathly Scream!");

    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length > 0 && getTokenDistance(tokenDoc, necroTokens[0]) > 30) {
        return notify("warn", "You must be within 30 feet of the thrall to cast Deathly Scream.");
    }

    const spellRank = Math.max(1, Math.ceil((actor.level || 1) / 2));
    const damageDice = spellRank;
    const exactDC = getSpellDC(actor);

    const dsSpell = await ensureNecroSpell(actor, {
        name: "Deathly Scream",
        img: "icons/magic/death/undead-ghost-scream-teal.webp",
        systemData: {
            level: { value: spellRank },
            traits: { value: ["necromancer", "uncommon", "auditory", "concentrate", "emotion", "fear", "focus", "mental"] },
            tradition: { value: "divine" },
            area: { type: "emanation", value: 5 },
            defense: { save: { statistic: "will", basic: true, dc: { value: exactDC } } },
            damage: { "0": { formula: `${damageDice}d4`, type: "mental" } }
        },
        aoeFlags: {
            useCustomDamage: true,
            customDamage: `${damageDice}d4`,
            customDamageType: "mental",
            useOverride: true,
            saveDC: exactDC,
            saveType: "will",
            allyBaseEffect: "standard",
            enemyBaseEffect: "standard"
        }
    });

    new Dialog({
        title: "Deathly Scream",
        content: `<p>Force <b>${tokenDoc.name}</b> to emit a Deathly Scream? (5-foot emanation, <b>${damageDice}d4 mental</b> damage)</p>`,
        buttons: {
            scream: {
                icon: '<i class="fas fa-volume-up"></i>',
                label: "Scream!",
                callback: async () => {
                    const focusToSpend = actor.system?.resources?.focus?.value || 0;
                    if (focusToSpend <= 0) return notify("warn", "You have no Focus Points remaining!");
                    await actor.update({ "system.resources.focus.value": focusToSpend - 1 });

                    const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
                    const gridDist = canvas.scene?.grid?.distance || 5;
                    const tokenRadiusFeet = ((tokenDoc.width || 1) * gridDist) / 2;
                    const totalEmanationFeet = 5 + tokenRadiusFeet;

                    const validTargets = canvas.tokens.placeables.filter(t => {
                        if (t.id === tokenDoc.id || !t.actor) return false;
                        if ((t.actor.system?.attributes?.hp?.value || 0) <= 0) return false;
                        return getTokenDistance(tokenDoc, t) <= 5;
                    });

                    if (canvas.ready && tokenDoc.object) {
                        canvas.interface.createScrollingText(tokenDoc.object.center, "DEATHLY SCREAM!", {
                            anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
                            fill: 0x00ffff,
                            direction: CONST.TEXT_ANCHOR_POINTS.UP,
                            fontSize: 32
                        });
                    }

                    const [template] = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{
                        t: "circle",
                        user: game.user.id,
                        x: tokenCenter.x,
                        y: tokenCenter.y,
                        distance: totalEmanationFeet,
                        fillColor: "#00ffff"
                    }]);

                    setTimeout(() => {
                        if (canvas.scene && canvas.scene.templates.has(template.id)) {
                            globalThis.NecroThrallHelper.purgeGraphics(canvas.scene.id, { templateIds: [template.id] });
                        }
                    }, 20000);

                    if (validTargets.length === 0) {
                        return notify("info", "The thrall screams, but no targets were caught in the blast!");
                    }

                    await postManualSaveCard({
                        actor,
                        spell: dsSpell,
                        itemName: "Deathly Scream",
                        saveTypeLabel: "Will",
                        saveTypeSlug: "will",
                        saveDC: exactDC,
                        targetTokens: validTargets,
                        flavor: `<strong>Deathly Scream</strong>`,
                        isBasicSave: true
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "scream"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}