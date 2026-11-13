import { executeDelete } from "../system/socket.js";
import { notify } from "../system/notify.js";
import { getTokenDistance } from "./spell-helpers.js";

export async function executeMuscleBarrier({ actor, tokenDoc }) {
    const currentFocus = actor.system?.resources?.focus?.value || 0;
    if (currentFocus === 0) return notify("warn", "You have no Focus Points to cast Muscle Barrier!");

    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length > 0 && getTokenDistance(tokenDoc, necroTokens[0]) > 30) {
        return notify("warn", "You must be within 30 feet of the thrall to cast Muscle Barrier.");
    }

    let potentialTargets = Array.from(game.user.targets);
    if (potentialTargets.length === 0 && canvas.tokens.controlled.length > 0) {
        potentialTargets = canvas.tokens.controlled.filter(t => t.id !== tokenDoc.id);
    }
    if (potentialTargets.length === 0 && necroTokens.length > 0) {
        potentialTargets = [necroTokens[0]];
    }

    if (potentialTargets.length === 0) {
        return notify("error", "Muscle Barrier Failed: Could not find a valid target or Necromancer token.");
    }

    const validTargets = potentialTargets.filter(t => getTokenDistance(tokenDoc, t) <= 15);
    if (validTargets.length !== 1) {
        return notify("error", `Muscle Barrier Failed: Found ${validTargets.length} valid targets within 15 feet. Ensure you or your ally are within 15 feet of the thrall.`);
    }

    const targetToken = validTargets[0];
    const targetDoc = targetToken.document || targetToken;
    const targetActor = targetToken.actor;
    if (!targetActor) return notify("error", "Muscle Barrier Failed: The targeted token has no character sheet.");

    const spellRank = Math.max(1, Math.ceil((actor.level || 1) / 2));
    const tempHP = spellRank * 10;

    new Dialog({
        title: "Muscle Barrier",
        content: `<p>Flay <b>${tokenDoc.name}</b> and wrap its muscle mass around <b>${targetDoc.name}</b>, granting <b>${tempHP} Temp HP</b> and a +1 status bonus to Athletics?</p>`,
        buttons: {
            cast: {
                icon: '<i class="fas fa-shield-alt"></i>',
                label: "Cast",
                callback: async () => {
                    const focusToSpend = actor.system?.resources?.focus?.value || 0;
                    if (focusToSpend > 0) await actor.update({ "system.resources.focus.value": focusToSpend - 1 });

                    const effectData = {
                        name: "Effect: Muscle Barrier",
                        type: "effect",
                        img: "icons/magic/defensive/shield-barrier-flaming-pentagon-purple-orange.webp",
                        system: {
                            duration: { value: 1, unit: "minutes", expiry: "turn-start" },
                            description: { value: `Grants ${tempHP} temporary Hit Points and a +1 status bonus to Athletics checks. The spell ends when all temporary Hit Points are gone.` },
                            rules: [
                                { key: "TempHP", value: tempHP },
                                { key: "FlatModifier", selector: "athletics", value: 1, type: "status" }
                            ]
                        }
                    };

                    await targetActor.createEmbeddedDocuments("Item", [effectData]);
                    await executeDelete(tokenDoc.id);

                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor }),
                        flavor: `<strong>Muscle Barrier</strong>`,
                        content: `<p><b>${actor.name}</b> splits <b>${tokenDoc.name}</b> apart, flinging the thick slabs of animated muscle onto <b>${targetDoc.name}</b>! They gain <b>${tempHP} Temp HP</b> and a +1 status bonus to Athletics.</p>`
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "cast"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}