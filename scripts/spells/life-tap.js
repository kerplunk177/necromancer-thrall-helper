import { executeDelete } from "../system/socket.js";
import { notify } from "../system/notify.js";
import { getSpellDC, ensureNecroSpell, postManualSaveCard } from "./spell-helpers.js";

export async function executeLifeTap({ actor, tokenDoc }) {
    const lifeTapDC = getSpellDC(actor);

    const lifeTapSpell = await ensureNecroSpell(actor, {
        name: "Life Tap",
        img: "icons/magic/life/heart-glowing-red.webp",
        systemData: {
            level: { value: 1 },
            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
            tradition: { value: "divine" },
            defense: { save: { statistic: "fortitude", basic: false, dc: { value: lifeTapDC } } }
        }
    });

    const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
    const gridDist = canvas.scene?.grid?.distance || 5;
    const gridSize = canvas.scene?.grid?.size || 100;
    const rangePixels = (30 / gridDist) * gridSize;

    const validTargets = Array.from(game.user.targets).filter(t => {
        const dist = Math.hypot(t.center.x - tokenCenter.x, t.center.y - tokenCenter.y);
        return dist <= rangePixels;
    });

    if (validTargets.length !== 1) {
        return notify("warn", "Life Tap requires exactly one target selected on the canvas within 30 feet of the thrall.");
    }

    const targetToken = validTargets[0];

    new Dialog({
        title: "Life Tap",
        content: `<p>Siphon life essence through <b>${tokenDoc.name}</b> targeting <b>${targetToken.name}</b>?</p>`,
        buttons: {
            tap: {
                icon: '<i class="fas fa-heart-broken"></i>',
                label: "Siphon",
                callback: async () => {
                    const currentFocus = actor.system?.resources?.focus?.value || 0;
                    if (currentFocus <= 0) return notify("warn", "You have no Focus Points remaining!");
                    await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                    await executeDelete(tokenDoc.id);
                    await postManualSaveCard({
                        actor,
                        spell: lifeTapSpell,
                        itemName: "Life Tap",
                        saveTypeLabel: "Fortitude",
                        saveTypeSlug: "fortitude",
                        saveDC: lifeTapDC,
                        targetTokens: [targetToken],
                        isBasicSave: false
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "tap"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}