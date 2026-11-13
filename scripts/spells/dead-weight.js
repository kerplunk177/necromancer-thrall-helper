import { executeDelete } from "../system/socket.js";
import { notify } from "../system/notify.js";
import { getSpellDC, ensureNecroSpell, postManualSaveCard } from "./spell-helpers.js";

export async function executeDeadWeight({ actor, tokenDoc }) {
    const necroLevel = actor.level || 1;
    const spellRank = Math.ceil(necroLevel / 2);
    const exactDC = getSpellDC(actor);

    const dwSpell = await ensureNecroSpell(actor, {
        name: "Dead Weight",
        img: "icons/magic/death/undead-zombie-glowing-green.webp",
        systemData: {
            level: { value: spellRank },
            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
            tradition: { value: "divine" },
            defense: { save: { statistic: "fortitude", basic: false, dc: { value: exactDC } } }
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
        return notify("warn", "Dead Weight requires exactly one target selected on the canvas within 15 feet of the thrall.");
    }

    const targetToken = validTargets[0];

    new Dialog({
        title: "Dead Weight",
        content: `<p>Hurl <b>${tokenDoc.name}</b> at <b>${targetToken.name}</b> to fuse their flesh together?</p>`,
        buttons: {
            hurl: {
                icon: '<i class="fas fa-meteor"></i>',
                label: "Hurl",
                callback: async () => {
                    const currentFocus = actor.system?.resources?.focus?.value || 0;
                    if (currentFocus <= 0) return notify("warn", "You have no Focus Points remaining!");
                    await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                    await executeDelete(tokenDoc.id);
                    await postManualSaveCard({
                        actor,
                        spell: dwSpell,
                        itemName: "Dead Weight",
                        saveTypeLabel: "Fortitude",
                        saveTypeSlug: "fortitude",
                        saveDC: exactDC,
                        targetTokens: [targetToken],
                        isBasicSave: false
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "hurl"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}