import { executeDelete } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { getSpellDC, getTokenDistance, ensureNecroSpell } from "./spell-helpers.js";

export async function executeBonyBarrage({ actor, tokenDoc, event }) {
    const currentFocus = actor.system?.resources?.focus?.value || 0;
    if (currentFocus === 0) return notify("warn", "You have no Focus Points to cast Bony Barrage!");

    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length > 0 && getTokenDistance(tokenDoc, necroTokens[0]) > 30) {
        return notify("warn", "You must be within 30 feet of the thrall to cast Bony Barrage.");
    }

    const spellRank = Math.max(2, Math.ceil((actor.level || 1) / 2));
    const damageDice = spellRank;
    const exactDC = getSpellDC(actor);

    const barrageSpell = await ensureNecroSpell(actor, {
        name: "Bony Barrage",
        img: "icons/magic/death/projectile-skull-flaming-green.webp",
        systemData: {
            level: { value: spellRank },
            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
            tradition: { value: "divine" },
            area: { type: "cone", value: 30 },
            defense: { save: { statistic: "reflex", basic: true, dc: { value: exactDC } } },
            damage: { "0": { formula: `${damageDice}d10`, type: "piercing" } }
        },
        aoeFlags: {
            useCustomDamage: true,
            customDamage: `${damageDice}d10`,
            customDamageType: "piercing",
            useOverride: true,
            saveDC: exactDC,
            saveType: "reflex"
        }
    });

    new Dialog({
        title: "Bony Barrage",
        content: `<p>Shatter <b>${tokenDoc.name}</b> into a 30-foot cone of jagged bone for <b>${damageDice}d10 piercing</b> damage?</p>`,
        buttons: {
            fire: {
                icon: '<i class="fas fa-bullseye"></i>',
                label: "Shatter & Fire",
                callback: async () => {
                    const focusToSpend = actor.system?.resources?.focus?.value || 0;
                    if (focusToSpend <= 0) return notify("warn", "You have no Focus Points remaining!");
                    await actor.update({ "system.resources.focus.value": focusToSpend - 1 });

                    const gridSize = canvas.scene.grid.size;
                    const originX = tokenDoc.x;
                    const originY = tokenDoc.y;
                    const tWidth = tokenDoc.width * gridSize;
                    const tHeight = tokenDoc.height * gridSize;

                    await executeDelete(tokenDoc.id);
                    window.aoeEasyResolveCache = {
                        item: barrageSpell,
                        name: "Bony Barrage",
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
                        fillColor: "#9900ff",
                        fillAlpha: 0.5,
                        strokeWidth: 2,
                        strokeColor: "#ffffff",
                        text: "BLAST\nORIGIN",
                        fontSize: 20,
                        textColor: "#ffffff"
                    }, 20000);

                    await barrageSpell.toMessage(event);
                    placementHint("Draw your 30-foot cone starting from the marked origin point.");
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "fire"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}