import { executeDelete } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { getSpellDC, ensureNecroSpell } from "./spell-helpers.js";

export async function executeNecroticBomb({ actor, tokenDoc }) {
    const necroLevel = actor.level || 1;
    const bombRank = Math.ceil(necroLevel / 2);
    const exactDC = getSpellDC(actor);

    const bombSpell = await ensureNecroSpell(actor, {
        name: "Necrotic Bomb",
        img: "icons/magic/death/projectile-skull-flaming-green.webp",
        systemData: {
            level: { value: bombRank },
            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "void"] },
            tradition: { value: "divine" },
            area: { type: "emanation", value: 10 },
            target: { value: "creatures" },
            defense: { save: { statistic: "fortitude", basic: true, dc: { value: exactDC } } },
            damage: { "0": { formula: `${bombRank}d12`, type: "void" } }
        },
        aoeFlags: {
            customDamage: `${bombRank}d12`,
            customDamageType: "void",
            useOverride: true,
            saveDC: exactDC,
            saveType: "fortitude",
            allyBaseEffect: "standard",
            enemyBaseEffect: "standard",
            useCustomDamage: true,
            provideTemplate: false
        }
    });

    new Dialog({
        title: "Necrotic Bomb",
        content: `<p>Detonate <b>${tokenDoc.name}</b> for <b>${bombRank}d12</b> damage in a 10-foot emanation?</p>`,
        buttons: {
            explode: {
                icon: '<i class="fas fa-radiation"></i>',
                label: "Detonate",
                callback: async (_html, e) => {
                    const currentFocus = actor.system?.resources?.focus?.value || 0;
                    if (currentFocus <= 0) return notify("warn", "You have no Focus Points remaining!");
                    await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                    const gridSize = canvas.scene.grid.size;
                    const originX = tokenDoc.x;
                    const originY = tokenDoc.y;
                    const tWidth = (tokenDoc.width || 1) * gridSize;
                    const tHeight = (tokenDoc.height || 1) * gridSize;

                    await executeDelete(tokenDoc.id);

                    window.aoeEasyResolveCache = {
                        item: bombSpell,
                        name: "Necrotic Bomb",
                        dc: exactDC,
                        type: "fortitude",
                        hazardDuration: null,
                        originMessageId: null
                    };

                    await globalThis.NecroThrallHelper.spawnOriginMarker(canvas.scene.id, {
                        shape: { type: "e", width: tWidth, height: tHeight },
                        x: originX,
                        y: originY,
                        fillType: 1,
                        fillColor: "#ff3333",
                        fillAlpha: 0.5,
                        strokeWidth: 2,
                        strokeColor: "#ffffff",
                        text: "Bomb",
                        fontSize: 24,
                        textColor: "#ffffff"
                    }, 20000);

                    await bombSpell.toMessage(e);
                    placementHint("Click the Emanation button in chat and center it on the Bomb marker.");
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "explode"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}