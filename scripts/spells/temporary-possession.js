import { executeDelete } from "../system/socket.js";
import { notify } from "../system/notify.js";
import { getSpellDC, getTokenDistance, ensureNecroSpell, postManualSaveCard } from "./spell-helpers.js";

export async function executeTemporaryPossession({ actor, tokenDoc }) {
    const currentFocus = actor.system?.resources?.focus?.value || 0;
    if (currentFocus === 0) return notify("warn", "You lack the Focus Points to attempt a Temporary Possession.");

    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length > 0 && getTokenDistance(tokenDoc, necroTokens[0]) > 30) {
        return notify("warn", "You must be within 30 feet of the thrall to catalyze the possession.");
    }

    const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
    const gridDist = canvas.scene?.grid?.distance || 5;
    const gridSize = canvas.scene?.grid?.size || 100;
    const rangePixels = (15 / gridDist) * gridSize;

    const validTargets = Array.from(game.user.targets).filter(t => {
        const dist = Math.hypot(t.center.x - tokenCenter.x, t.center.y - tokenCenter.y);
        return dist <= rangePixels;
    });

    if (validTargets.length !== 1) {
        return notify("warn", "Temporary Possession requires exactly one target selected on the canvas within 15 feet of the thrall.");
    }

    const targetToken = validTargets[0];
    const exactDC = getSpellDC(actor);
    const spellRank = Math.max(8, Math.ceil((actor.level || 1) / 2));

    const tpSpell = await ensureNecroSpell(actor, {
        name: "Temporary Possession",
        img: "icons/magic/control/control-influence-puppet-purple.webp",
        systemData: {
            level: { value: spellRank },
            traits: { value: ["necromancer", "uncommon", "concentrate", "focus", "incapacitation", "manipulate", "possession"] },
            tradition: { value: "divine" },
            defense: { save: { statistic: "will", basic: false, dc: { value: exactDC } } }
        }
    });

    new Dialog({
        title: "Temporary Possession",
        content: `<p>Destroy <b>${tokenDoc.name}</b> to force its animus into <b>${targetToken.name}</b>?</p>`,
        buttons: {
            possess: {
                icon: '<i class="fas fa-ghost"></i>',
                label: "Possess",
                callback: async () => {
                    await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                    await executeDelete(tokenDoc.id);

                    await postManualSaveCard({
                        actor,
                        spell: tpSpell,
                        itemName: "Temporary Possession",
                        saveTypeLabel: "Will",
                        saveTypeSlug: "will",
                        saveDC: exactDC,
                        targetTokens: [targetToken],
                        flavor: `<strong>Temporary Possession</strong>`,
                        wrapContent: (htmlContent) => `
                            <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #8a2be2;">
                                <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> destroys <b>${tokenDoc.name}</b>, forcing its volatile animus into the mind of <b>${targetToken.name}</b>!</p>
                                <p style="margin: 0; font-size: 0.95em;">They must attempt a <b>DC ${exactDC} Will save</b>. (Incapacitation trait applies).</p>
                                <hr>${htmlContent}
                            </div>
                        `
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "possess"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}