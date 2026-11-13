import { executeDelete } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { getSpellDC, ensureNecroSpell } from "./spell-helpers.js";

export async function executeBoneSpear({ actor, tokenDoc, event }) {
    const necroLevel = actor.level || 1;
    const spellRank = Math.ceil(necroLevel / 2);
    const damageDice = spellRank * 2;
    const exactDC = getSpellDC(actor);

    const spearSpell = await ensureNecroSpell(actor, {
        name: "Bone Spear",
        img: "icons/magic/weapons/projectile-spear-bone.webp",
        systemData: {
            level: { value: spellRank },
            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
            tradition: { value: "divine" },
            area: { type: "line", value: 15 },
            defense: { save: { statistic: "reflex", basic: true, dc: { value: exactDC } } },
            damage: { "0": { formula: `${damageDice}d6`, type: "piercing" } }
        },
        aoeFlags: {
            useCustomDamage: true,
            customDamage: `${damageDice}d6`,
            customDamageType: "piercing",
            useOverride: true,
            saveDC: exactDC,
            saveType: "reflex",
            allyBaseEffect: "standard",
            enemyBaseEffect: "standard"
        }
    });

    new Dialog({
        title: "Bone Spear",
        content: `<p>Shatter <b>${tokenDoc.name}</b> into a 15-foot line of jagged bone for <b>${damageDice}d6 piercing</b> damage?</p>`,
        buttons: {
            fire: {
                icon: '<i class="fas fa-location-arrow"></i>',
                label: "Shatter & Fire",
                callback: async () => {
                    const currentFocus = actor.system?.resources?.focus?.value || 0;
                    if (currentFocus <= 0) return notify("warn", "You have no Focus Points remaining!");
                    await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                    const gridSize = canvas.scene.grid.size;
                    const originX = tokenDoc.x;
                    const originY = tokenDoc.y;
                    const tWidth = tokenDoc.width * gridSize;
                    const tHeight = tokenDoc.height * gridSize;

                    await executeDelete(tokenDoc.id);
                    window.aoeEasyResolveCache = {
                        item: spearSpell,
                        name: "Bone Spear",
                        dc: exactDC,
                        type: "reflex",
                        hazardDuration: null,
                        originMessageId: null
                    };

                    await globalThis.NecroThrallHelper.spawnOriginMarker(canvas.scene.id, {
                        shape: { type: "e", width: tWidth, height: tHeight },
                        x: originX,
                        y: originY,
                        fillType: 1,
                        fillColor: "#990000",
                        fillAlpha: 0.5,
                        strokeWidth: 2,
                        strokeColor: "#ffffff",
                        text: "SPEAR\nORIGIN",
                        fontSize: 20,
                        textColor: "#ffffff"
                    }, 20000);

                    await spearSpell.toMessage(event);
                    placementHint("Draw your 15-foot line starting from the marked origin point.");
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "fire"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}