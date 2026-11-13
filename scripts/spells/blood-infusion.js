import { executeDelete } from "../system/socket.js";
import { notify } from "../system/notify.js";
import { getSpellDC, ensureNecroSpell, postManualSaveCard } from "./spell-helpers.js";

export async function executeBloodInfusion({ actor, tokenDoc }) {
    const spellRank = Math.ceil((actor.level || 1) / 2);
    const infusionDC = getSpellDC(actor);

    const infusionSpell = await ensureNecroSpell(actor, {
        name: "Blood Infusion",
        img: "icons/magic/water/blood-drop-skull.webp",
        systemData: {
            level: { value: spellRank },
            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
            tradition: { value: "divine" },
            defense: { save: { statistic: "fortitude", basic: false, dc: { value: infusionDC } } }
        }
    });

    const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
    const gridDist = canvas.scene?.grid?.distance || 5;
    const gridSize = canvas.scene?.grid?.size || 100;
    const rangePixels = (15 / gridDist) * gridSize;

    const validTargets = Array.from(game.user.targets).filter(t => {
        const dist = Math.hypot(t.center.x - tokenCenter.x, t.center.y - tokenCenter.y);
        return dist <= rangePixels;
    });

    if (validTargets.length !== 1) {
        return notify("warn", "Blood Infusion requires exactly one target selected on the canvas within 15 feet of the thrall.");
    }

    const targetToken = validTargets[0];

    new Dialog({
        title: "Blood Infusion",
        content: `<p>Infuse blood through <b>${tokenDoc.name}</b> into <b>${targetToken.name}</b>?</p>`,
        buttons: {
            infuse: {
                icon: '<i class="fas fa-tint"></i>',
                label: "Infuse",
                callback: async () => {
                    const currentFocus = actor.system?.resources?.focus?.value || 0;
                    if (currentFocus <= 0) return notify("warn", "You have no Focus Points remaining!");
                    await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                    await executeDelete(tokenDoc.id);
                    await postManualSaveCard({
                        actor,
                        spell: infusionSpell,
                        itemName: "Blood Infusion",
                        saveTypeLabel: "Fortitude",
                        saveTypeSlug: "fortitude",
                        saveDC: infusionDC,
                        targetTokens: [targetToken],
                        isBasicSave: false,
                        extraAoeFlags: { spellRank }
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "infuse"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}