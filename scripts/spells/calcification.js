import { executeDelete } from "../system/socket.js";
import { notify } from "../system/notify.js";
import { getSpellDC, getTokenDistance, ensureNecroSpell, postManualSaveCard } from "./spell-helpers.js";

export async function executeCalcification({ actor, tokenDoc }) {
    const currentFocus = actor.system?.resources?.focus?.value || 0;
    if (currentFocus === 0) return notify("warn", "You lack the Focus Points to cast Calcification.");

    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length > 0 && getTokenDistance(tokenDoc, necroTokens[0]) > 30) {
        return notify("warn", "You must be within 30 feet of the thrall to catalyze Calcification.");
    }

    const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
    const gridDist = canvas.scene?.grid?.distance || 5;
    const gridSize = canvas.scene?.grid?.size || 100;
    const rangePixels = (60 / gridDist) * gridSize;

    const validTargets = Array.from(game.user.targets).filter(t => {
        const dist = Math.hypot(t.center.x - tokenCenter.x, t.center.y - tokenCenter.y);
        return dist <= rangePixels;
    });

    if (validTargets.length !== 1) {
        return notify("warn", "Calcification requires exactly one target selected on the canvas within 60 feet of the thrall.");
    }

    const targetToken = validTargets[0];
    const exactDC = getSpellDC(actor);
    const spellRank = Math.max(9, Math.ceil((actor.level || 1) / 2));

    const calcSpell = await ensureNecroSpell(actor, {
        name: "Calcification",
        img: "icons/magic/death/skeleton-skull-soul-blue.webp",
        systemData: {
            level: { value: spellRank },
            traits: { value: ["necromancer", "uncommon", "concentrate", "focus", "manipulate"] },
            tradition: { value: "divine" },
            defense: { save: { statistic: "fortitude", basic: false, dc: { value: exactDC } } }
        }
    });

    new Dialog({
        title: "Calcification",
        content: `<p>Destroy <b>${tokenDoc.name}</b> to turn it into a cloud of bone dust that calcifies <b>${targetToken.name}</b>?</p>`,
        buttons: {
            cast: {
                icon: '<i class="fas fa-bone"></i>',
                label: "Calcify",
                callback: async () => {
                    await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                    await executeDelete(tokenDoc.id);

                    await postManualSaveCard({
                        actor,
                        spell: calcSpell,
                        itemName: "Calcification",
                        saveTypeLabel: "Fortitude",
                        saveTypeSlug: "fortitude",
                        saveDC: exactDC,
                        targetTokens: [targetToken],
                        flavor: `<strong>Calcification</strong>`,
                        wrapContent: (htmlContent) => `
                            <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #e2e8f0;">
                                <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> destroys <b>${tokenDoc.name}</b>, transforming them into a cloud of invasive bone dust that swarms <b>${targetToken.name}</b>!</p>
                                <p style="margin: 0; font-size: 0.95em;">They must attempt a <b>DC ${exactDC} Fortitude save</b> or begin turning into a statue.</p>
                                <hr>${htmlContent}
                            </div>
                        `
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "cast"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}