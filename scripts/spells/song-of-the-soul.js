import { notify } from "../system/notify.js";
import { getTokenDistance } from "./spell-helpers.js";

export async function executeSongOfTheSoul({ actor, tokenDoc }) {
    const currentFocus = actor.system?.resources?.focus?.value || 0;
    if (currentFocus === 0) return notify("warn", "You have no Focus Points to cast Song of the Soul!");

    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length > 0 && getTokenDistance(tokenDoc, necroTokens[0]) > 30) {
        return notify("warn", "You must be within 30 feet of the thrall to cast Song of the Soul.");
    }

    let finalTarget = null;
    const explicitTargets = Array.from(game.user.targets).filter(t => getTokenDistance(tokenDoc, t) <= 15);

    if (explicitTargets.length === 1) {
        finalTarget = explicitTargets[0];
    } else {
        const eligibleAllies = canvas.tokens.placeables.filter(t => {
            if (!t.actor || t.id === tokenDoc.id) return false;
            const alliance = t.actor.system?.details?.alliance;
            const isFriendly = alliance === "party" || t.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY || t.actor.id === actor.id;
            if (!isFriendly) return false;
            return getTokenDistance(tokenDoc, t) <= 15;
        });

        if (eligibleAllies.length === 0) {
            return notify("warn", "Song of the Soul Failed: No valid allies (or yourself) within 15 feet of the thrall.");
        } else if (eligibleAllies.length === 1) {
            finalTarget = eligibleAllies[0];
        } else {
            const optionsHtml = eligibleAllies.map(t => `<option value="${t.id}">${t.name}</option>`).join("");
            const chosenId = await new Promise(resolve => {
                new Dialog({
                    title: "Song of the Soul Target",
                    content: `<p>Multiple allies are within 15 feet of the instrument thrall. Who hears the song?</p><form><select id="song-recipient">${optionsHtml}</select></form>`,
                    buttons: {
                        select: {
                            label: "Play Song",
                            callback: (html) => resolve(html.find("#song-recipient").val())
                        },
                        cancel: {
                            label: "Cancel",
                            callback: () => resolve(null)
                        }
                    },
                    default: "select"
                }).render(true);
            });

            if (!chosenId) return;
            finalTarget = canvas.tokens.get(chosenId);
        }
    }

    if (!finalTarget || !finalTarget.actor) return;

    const targetDoc = finalTarget.document || finalTarget;
    const targetActor = finalTarget.actor;

    const traits = targetActor.system?.traits?.value || [];
    const isUndead = traits.includes("undead") || traits.some(tr => typeof tr === "string" && tr.toLowerCase() === "undead");
    const isConstruct = traits.includes("construct");

    if (isConstruct && !isUndead) {
        return notify("error", "Song of the Soul Failed: Target must be a living or undead creature.");
    }

    const spellRank = Math.max(1, Math.ceil((actor.level || 1) / 2));
    const spellTrait = isUndead ? "Void" : "Vitality";

    new Dialog({
        title: "Song of the Soul",
        content: `<p>Shape <b>${tokenDoc.name}</b> into a macabre instrument, restoring <b>${spellRank}d8 Hit Points</b> to <b>${targetDoc.name}</b> and granting Fast Healing ${spellRank} while in range?</p>`,
        buttons: {
            cast: {
                icon: '<i class="fas fa-music"></i>',
                label: "Play Song",
                callback: async () => {
                    const focusToSpend = actor.system?.resources?.focus?.value || 0;
                    if (focusToSpend > 0) await actor.update({ "system.resources.focus.value": focusToSpend - 1 });

                    const DamageRoll = CONFIG.Dice.rolls.find(r => r.name === "DamageRoll");
                    if (DamageRoll) {
                        const roll = await new DamageRoll(`${spellRank}d8[healing]`).evaluate();
                        const actualHeal = roll.total;

                        await roll.toMessage({
                            speaker: ChatMessage.getSpeaker({ actor }),
                            flavor: `<strong>Song of the Soul</strong> <span class="tag" style="background: #222; color: #fff; padding: 2px 4px; font-size: 10px; border-radius: 2px;">${spellTrait}</span><br><b>${actor.name}</b> shapes ${tokenDoc.name} into an instrument, restoring <b>${actualHeal} HP</b> to ${targetDoc.name}!`
                        });

                        const currentHP = targetActor.system.attributes.hp.value;
                        const maxHP = targetActor.system.attributes.hp.max;
                        await targetActor.update({ "system.attributes.hp.value": Math.min(maxHP, currentHP + actualHeal) });
                    }

                    const thrallEffect = {
                        name: "Effect: Song Instrument",
                        type: "effect",
                        img: "icons/skills/music/instrument-harp-harpist-blue.webp",
                        system: {
                            duration: { value: 1, unit: "minutes", expiry: "turn-start" },
                            description: { value: `Playing the Song of the Soul for ${targetDoc.name}.` },
                            rules: [{ key: "Aura", radius: 15, colors: { border: "#00ffff", fill: "#00ffff" } }]
                        }
                    };
                    await tokenDoc.actor.createEmbeddedDocuments("Item", [thrallEffect]);

                    const recipientEffect = {
                        name: "Effect: Song of the Soul (Recipient)",
                        type: "effect",
                        img: "icons/magic/life/heart-cross-blue.webp",
                        system: {
                            duration: { value: 1, unit: "minutes", expiry: "turn-start" },
                            description: { value: `Gains Fast Healing ${spellRank} as long as you are within 15 feet of the instrument thrall.` },
                            rules: [{ key: "FastHealing", value: spellRank, type: "fast-healing" }]
                        },
                        flags: {
                            "necromancer-thrall-helper": {
                                instrumentId: tokenDoc.id,
                                spellRank: spellRank,
                                isUndead: isUndead
                            }
                        }
                    };
                    await targetActor.createEmbeddedDocuments("Item", [recipientEffect]);
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "cast"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}