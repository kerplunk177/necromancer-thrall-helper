import { executeDelete } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { getSpellDC, getTokenDistance, ensureNecroSpell } from "./spell-helpers.js";

export async function executeFleshTsunami({ actor, tokenDoc, event }) {
    const currentFocus = actor.system?.resources?.focus?.value || 0;
    if (currentFocus === 0) return notify("warn", "You have no Focus Points to cast Flesh Tsunami!");

    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length > 0 && getTokenDistance(tokenDoc, necroTokens[0]) > 30) {
        return notify("warn", "You must be within 30 feet of the thrall to cast Flesh Tsunami.");
    }

    const exactDC = getSpellDC(actor);
    const tsunamiSpell = await ensureNecroSpell(actor, {
        name: "Flesh Tsunami",
        img: "icons/magic/water/wave-water-red.webp",
        systemData: {
            level: { value: 8 },
            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
            tradition: { value: "divine" },
            area: { type: "cone", value: 60 },
            defense: { save: { statistic: "fortitude", basic: false, dc: { value: exactDC } } }
        },
        extraUpdates: { "system.damage": {} },
        aoeFlags: {
            useOverride: true,
            saveDC: exactDC,
            saveType: "fortitude",
            allyBaseEffect: "immune",
            enemyBaseEffect: "standard",
            hazardDuration: 10,
            rules: [{ context: "tokenEnter", outcome: "always", promptSave: false, alliance: "all" }]
        },
        necroFlags: {
            limbsActivated: false
        }
    });

    new Dialog({
        title: "Flesh Tsunami",
        content: `<p>Melt <b>${tokenDoc.name}</b> into a 60-foot cone of Greater Difficult Terrain?</p>`,
        buttons: {
            fire: {
                icon: '<i class="fas fa-water"></i>',
                label: "Melt & Flow",
                callback: async () => {
                    const focusToSpend = actor.system?.resources?.focus?.value || 0;
                    if (focusToSpend > 0) await actor.update({ "system.resources.focus.value": focusToSpend - 1 });

                    const gridSize = canvas.scene.grid.size;
                    const originX = tokenDoc.x;
                    const originY = tokenDoc.y;
                    const tWidth = tokenDoc.width * gridSize;
                    const tHeight = tokenDoc.height * gridSize;

                    await executeDelete(tokenDoc.id);

                    await globalThis.NecroThrallHelper.spawnOriginMarker(canvas.scene.id, {
                        shape: { type: "e", width: tWidth, height: tHeight },
                        x: originX,
                        y: originY,
                        fillType: 1,
                        fillColor: "#990000",
                        fillAlpha: 0.5,
                        strokeWidth: 2,
                        strokeColor: "#ffffff",
                        text: "GREATER DIFFICULT TERRAIN\n(Flesh Tsunami)",
                        fontSize: 16,
                        textColor: "#ffffff"
                    }, 20000);

                    await tsunamiSpell.toMessage(event);
                    placementHint("Draw your 60-foot cone starting from the marked origin point.");
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "fire"
    }).render(true);
}