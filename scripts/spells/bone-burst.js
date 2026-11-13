import { executeDelete } from "../system/socket.js";
import { notify } from "../system/notify.js";
import { getSpellDC, getTokenDistance, ensureNecroSpell, postManualSaveCard } from "./spell-helpers.js";

export async function executeBoneBurst({ actor, tokenDoc }) {
    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length > 0 && getTokenDistance(tokenDoc, necroTokens[0]) > 30) {
        return notify("warn", "You must be within 30 feet of the thrall to use Bone Burst.");
    }

    const validTargets = Array.from(game.user.targets).filter(t => getTokenDistance(tokenDoc, t) <= 5);
    if (validTargets.length !== 1) {
        return notify("warn", "Bone Burst requires exactly one target selected adjacent (within 5 feet) to the thrall.");
    }

    const targetToken = validTargets[0];
    const necroLevel = actor.level || 1;

    let diceCount = 2;
    if (necroLevel >= 18) diceCount = 4;
    else if (necroLevel >= 12) diceCount = 3;

    const exactDC = getSpellDC(actor);
    const bbSpell = await ensureNecroSpell(actor, {
        name: "Bone Burst",
        img: "icons/skills/wounds/bone-broken-splinter-white.webp",
        systemData: {
            level: { value: Math.ceil(necroLevel / 2) },
            traits: { value: ["necromancer", "occult", "concentrate", "focus", "uncommon"] },
            tradition: { value: "occult" },
            defense: { save: { statistic: "reflex", basic: true, dc: { value: exactDC } } },
            damage: { "0": { formula: `${diceCount}d10`, type: "piercing" } }
        },
        aoeFlags: {
            useCustomDamage: true,
            customDamage: `${diceCount}d10`,
            customDamageType: "piercing",
            useOverride: true,
            saveDC: exactDC,
            saveType: "reflex",
            allyBaseEffect: "standard",
            enemyBaseEffect: "standard"
        }
    });

    new Dialog({
        title: "Bone Burst",
        content: `<p>Destroy <b>${tokenDoc.name}</b> in a burst of bone shards at <b>${targetToken.name}</b> for <b>${diceCount}d10 piercing</b> damage?</p>`,
        buttons: {
            burst: {
                icon: '<i class="fas fa-bone"></i>',
                label: "Burst",
                callback: async () => {
                    await executeDelete(tokenDoc.id);
                    await postManualSaveCard({
                        actor,
                        spell: bbSpell,
                        itemName: "Bone Burst",
                        saveTypeLabel: "Reflex",
                        saveTypeSlug: "reflex",
                        saveDC: exactDC,
                        targetTokens: [targetToken],
                        isBasicSave: true
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "burst"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}