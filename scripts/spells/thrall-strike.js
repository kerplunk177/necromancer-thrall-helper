import { tokenPortrait } from "../system/thrall-manager.js";
import { executeDelete } from "../system/socket.js";
import { notify, notifyForce, guardAction } from "../system/notify.js";
import { canThrallDealVitality, getSpellDC, getTokenDistance } from "./spell-helpers.js";
import { getNecroEffect, findNecroEffects } from "../system/effect-catalog.js";
import { NecroDialog } from "../ui/necro-dialog.js";
import { transientFlags, oneStrikeDuration, watchStrikeCleanup, deleteIfExists } from "../system/transient-effects.js";
import { createNecroCard } from "../system/necro-card.js";

/** Attack bonus and dice count for a Thrall Strike, from the necromancer's current level. */
function thrallStrikeStats(actor) {
    const necroLevel = actor.level || 1;
    const baseDice = Math.max(1, Math.floor((necroLevel - 1) / 4) + 1);
    let attackMod = Math.floor(necroLevel * 1.5);
    const spellcasting = actor.spellcasting?.filter(s => s.statistic)?.sort((a, b) => b.statistic.check.mod - a.statistic.check.mod)[0];
    if (spellcasting) attackMod = spellcasting.statistic.check.mod;
    return { baseDice, attackMod };
}

/** One place that decides which damage type a thrall's Strike or Charge uses. */
export function resolveThrallDamageType(deck, actor, tokenDoc, tokenId = tokenDoc.id) {
    let damageType = deck?.spiritStates?.[tokenId] || "bludgeoning";
    if (damageType === "vitality" && !canThrallDealVitality(actor)) damageType = "bludgeoning";
    if (tokenDoc.getFlag("necromancer-thrall-helper", "isRecurringNightmare")) damageType = "void";
    if (tokenDoc.getFlag("necromancer-thrall-helper", "isSkeletalLancer")) damageType = "piercing";
    return damageType;
}

function strikeItems(thrallActor) {
    return thrallActor.items.filter(i => i.type === "melee" && (i.system?.slug === "thrall-strike" || i.name.includes("Thrall Strike")));
}

/** Exactly one Thrall Strike item, with the right type, dice and bonus. Returns it. */
export async function ensureThrallStrike(tokenDoc, { damageType, baseDice, attackMod }) {
    const thrall = tokenDoc.actor;
    const [keep, ...extras] = strikeItems(thrall);
    if (extras.length) await thrall.deleteEmbeddedDocuments("Item", extras.map(i => i.id));

    const data = {
        name: "Thrall Strike",
        type: "melee",
        img: "icons/skills/melee/unarmed-punch-fist.webp",
        system: {
            slug: "thrall-strike",
            weaponType: { value: "melee" },
            bonus: { value: attackMod },
            damageRolls: { base: { damage: `${baseDice}d6`, damageType } },
            traits: { value: ["magical", "unarmed"] }
        }
    };
    if (!keep) return (await thrall.createEmbeddedDocuments("Item", [data]))[0];

    const key = Object.keys(keep.system.damageRolls ?? {})[0] ?? "base";
    await keep.update({
        img: data.img,
        "system.slug": "thrall-strike",
        "system.bonus.value": attackMod,
        [`system.damageRolls.${key}.damage`]: `${baseDice}d6`,
        [`system.damageRolls.${key}.damageType`]: damageType
    });
    return keep;
}

/** One Thrall Charge effect on the thrall, official source first; any older one is cleared so they never stack. */
async function applyChargeEffect(actor, tokenDoc, { spellRank, isKamikaze, dice, chargeDice }) {
    await deleteIfExists(tokenDoc.actor, findNecroEffects(tokenDoc.actor, "thrallCharge").map(i => i.id));
    const effectData = await getNecroEffect("thrallCharge", { flags: transientFlags(actor, "strike", { chargeDice: dice }) }, {
        spellRank, isKamikaze, dice, chargeDice, duration: oneStrikeDuration(actor)
    });
    return (await tokenDoc.actor.createEmbeddedDocuments("Item", [effectData])).map(e => e.id);
}

/** Active GM, on scene load: remove duplicate Thrall Strike items left on thrall tokens by older versions. */
export async function dedupeSceneThrallStrikes(scene = canvas.scene) {
    if (!game.user.isGM || game.users.activeGM?.isSelf === false || !scene) return;
    for (const token of scene.tokens) {
        if (!token.getFlag("necromancer-thrall-helper", "masterId") || !token.actor) continue;
        const [, ...extras] = strikeItems(token.actor);
        if (extras.length) await token.actor.deleteEmbeddedDocuments("Item", extras.map(i => i.id)).catch(err => console.warn("Necromancer Thrall Helper | Strike dedupe failed:", err));
    }
}

/** Wait for PF2e to publish the Strike action for this item with the wanted damage type. */
async function waitForStrikeAction(thrall, item, damageType, variantIndex) {
    for (let attempts = 0; attempts < 30; attempts++) {
        const strike = thrall?.system?.actions?.find(a => a.item?.id === item.id);
        const rolls = strike?.item?.system?.damageRolls ?? {};
        const type = Object.values(rolls)[0]?.damageType;
        if (strike?.variants?.[variantIndex] && type === damageType) return strike;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
}

export async function rollNativeStrike(deck, actor, tokenDoc, tokenId, eventObj, isKamikaze = false, chargeDice = 0, passedSpellRank = 0) {
    const necroLevel = actor.level || 1;

    const mapPenalty = deck.currentMap !== undefined ? deck.currentMap : 0;
    let variantIndex = 0;
    if (mapPenalty === -5) variantIndex = 1;
    if (mapPenalty === -10) variantIndex = 2;

    const isNightmare = tokenDoc.getFlag("necromancer-thrall-helper", "isRecurringNightmare");
    const isLancer = tokenDoc.getFlag("necromancer-thrall-helper", "isSkeletalLancer");
    const isGraveyard = tokenDoc.getFlag("necromancer-thrall-helper", "isLivingGraveyard") || tokenDoc.name.includes("Living Graveyard");
    const isPerfected = tokenDoc.getFlag("necromancer-thrall-helper", "isPerfectedThrall") || tokenDoc.name.includes("Perfected");
    const spellRank = passedSpellRank || Math.max(1, Math.ceil(necroLevel / 2));

    const damageType = resolveThrallDamageType(deck, actor, tokenDoc, tokenId);

    let totalChargeDice = chargeDice;
    if (isNightmare || isLancer) {
        const bonusDice = spellRank >= 8 ? 3 : 2;
        totalChargeDice += bonusDice;
    }
    if (isGraveyard && chargeDice > 0) totalChargeDice += 3;
    if (isPerfected && chargeDice > 0) totalChargeDice += 6;

    const { baseDice: strikeDice, attackMod } = thrallStrikeStats(actor);
    const weapon = await ensureThrallStrike(tokenDoc, { damageType, baseDice: strikeDice, attackMod });

    let addedEffectIds = [];
    if (totalChargeDice > 0) {
        addedEffectIds = await applyChargeEffect(actor, tokenDoc, { spellRank, isKamikaze, dice: totalChargeDice, chargeDice });
    }

    const strike = await waitForStrikeAction(tokenDoc.actor, weapon, damageType, variantIndex);

    if (!strike) {
        notify("warn", `Execution failed. ${tokenDoc.name} could not draw its weapon (Network Timeout).`);
        return;
    }

    // Watch before rolling: a miss posts its message during the roll. A kamikaze thrall is removed
    // once the Strike resolves (miss or damage); the flag lets the turn-end/combat-end/scene-load cleanup finish it.
    if (addedEffectIds.length > 0 || isKamikaze) {
        if (isKamikaze) await tokenDoc.update({ "flags.necromancer-thrall-helper.pendingDestroy": true }).catch(() => {});
        watchStrikeCleanup({
            tokenDoc, effectIds: addedEffectIds,
            onResolve: isKamikaze ? () => executeDelete(tokenDoc.id) : null
        });
    }

    await strike.variants[variantIndex].roll({ event: eventObj });

    if (deck.currentMap === undefined || deck.currentMap === 0) {
        deck.currentMap = -5;
    } else if (deck.currentMap === -5) {
        deck.currentMap = -10;
    }
    deck.render(false);
}

export async function executeStrike({ deck, actor, tokenDoc, tokenId, event }) {
    await rollNativeStrike(deck, actor, tokenDoc, tokenId, event);
}

export async function executeCharge({ deck, actor, tokenDoc, tokenId, event }) {
    if (!tokenDoc.actor?.isOwner) return notifyForce("warn", "You don't own this thrall. Ask the GM to give you ownership.");
    const necroLevel = actor.level || 1;
    const spellRank = Math.ceil(necroLevel / 2);
    let chargeDice = 1;
    if (spellRank >= 10) chargeDice = 4;
    else if (spellRank >= 6) chargeDice = 3;
    else if (spellRank >= 2) chargeDice = 2;

    new NecroDialog({
        title: "Thrall Charge",
        content: `<p>Detonate <b>${tokenDoc.name}</b> upon impact for an additional +${spellRank} status bonus to damage?</p>`,
        buttons: {
            charge: {
                icon: '<i class="fas fa-running"></i>',
                label: "Just Charge",
                callback: async () => {
                    await guardAction(() => rollNativeStrike(deck, actor, tokenDoc, tokenId, event, false, chargeDice, spellRank));
                }
            },
            destroy: {
                icon: '<i class="fas fa-bomb"></i>',
                label: "Charge & Destroy",
                callback: async () => {
                    await guardAction(() => rollNativeStrike(deck, actor, tokenDoc, tokenId, event, true, chargeDice, spellRank));
                }
            }
        },
        default: "charge"
    }).render(true);
}

export async function executeConglomerateCharge({ deck, actor, tokenDoc, tokenId = tokenDoc.id, event }) {
    if (!tokenDoc.actor?.isOwner) return notifyForce("warn", "You don't own this thrall. Ask the GM to give you ownership.");
    const originalTargets = Array.from(game.user.targets);
    if (originalTargets.length === 0 || originalTargets.length > 2) {
        return notify("warn", "Conglomerate Charge requires exactly 1 or 2 targets selected.");
    }

    const validTargets = originalTargets.filter(t => getTokenDistance(tokenDoc, t) <= 10);
    if (validTargets.length !== originalTargets.length) {
        return notify("warn", "All targets for Conglomerate Charge must be within 10 feet of the thrall.");
    }

    const necroLevel = actor.level || 1;
    const spellRank = Math.max(1, Math.ceil(necroLevel / 2));
    let chargeDice = 1;
    if (spellRank >= 10) chargeDice = 4;
    else if (spellRank >= 6) chargeDice = 3;
    else if (spellRank >= 2) chargeDice = 2;

    const executeConglomerate = async (isKamikaze) => {
        const damageType = resolveThrallDamageType(deck, actor, tokenDoc, tokenId);
        const { baseDice, attackMod } = thrallStrikeStats(actor);
        const weapon = await ensureThrallStrike(tokenDoc, { damageType, baseDice, attackMod });

        if (isKamikaze) await tokenDoc.update({ "flags.necromancer-thrall-helper.pendingDestroy": true }).catch(() => {});
        const addedEffectIds = chargeDice > 0
            ? await applyChargeEffect(actor, tokenDoc, { spellRank, isKamikaze, dice: chargeDice, chargeDice })
            : [];

        const mapPenalty = deck.currentMap !== undefined ? deck.currentMap : 0;
        let variantIndex = 0;
        if (mapPenalty === -5) variantIndex = 1;
        if (mapPenalty === -10) variantIndex = 2;

        const strike = await waitForStrikeAction(tokenDoc.actor, weapon, damageType, variantIndex);

        if (!strike) {
            notify("error", `${tokenDoc.name} could not draw its weapon (Network Timeout).`);
            return;
        }

        const targetsData = {};
        validTargets.forEach(t => {
            targetsData[t.document.id] = {
                id: t.document.id,
                name: t.document.name,
                img: tokenPortrait(t.document),
                hasRolled: false,
                rollTotal: null,
                degreeOfSuccess: null,
                isHealing: false,
                isImmune: false,
                hasApplied: false
            };
        });

        let hitCount = 0;
        for (const target of validTargets) {
            target.setTarget(true, { releaseOthers: true });
            let capturedMsg = null;

            const hookId = Hooks.on("createChatMessage", (msg) => {
                if (msg.speaker?.token === tokenDoc.id && msg.flags?.pf2e?.context?.type === "attack-roll") {
                    capturedMsg = msg;
                }
            });

            await strike.variants[variantIndex].roll({ event });

            let outcome = null;
            for (let i = 0; i < 25; i++) {
                if (capturedMsg) {
                    outcome = capturedMsg.getFlag("pf2e", "context")?.outcome;
                    if (outcome) break;
                }
                await new Promise(r => setTimeout(r, 100));
            }

            Hooks.off("createChatMessage", hookId);

            if (outcome === "success" || outcome === "criticalSuccess") {
                hitCount++;
            } else {
                targetsData[target.document.id].isImmune = true;
            }
        }

        if (originalTargets.length > 0) {
            originalTargets[0].setTarget(true, { releaseOthers: true });
            for (let i = 1; i < originalTargets.length; i++) {
                originalTargets[i].setTarget(true, { releaseOthers: false });
            }
        } else {
            game.user.clearTargets();
        }

        deck.currentMap = -10;
        deck.render(false);

        // All misses: no damage is coming, so the charge dice and a kamikaze thrall go now.
        // Otherwise they go when the damage is rolled.
        if (hitCount === 0) {
            await deleteIfExists(tokenDoc.actor, addedEffectIds);
            if (isKamikaze) await executeDelete(tokenDoc.id);
        } else if (addedEffectIds.length > 0 || isKamikaze) {
            watchStrikeCleanup({
                tokenDoc, effectIds: addedEffectIds, watchMiss: false, timeoutMs: 60000,
                onResolve: isKamikaze ? () => executeDelete(tokenDoc.id) : null
            });
        }

        if (hitCount === 0) {
            notify("info", "Conglomerate Charge: All strikes missed. No Grab saves needed.");
            return;
        }

        const exactDC = getSpellDC(actor);
        const targetNames = validTargets.filter(t => !targetsData[t.document.id].isImmune).map(t => t.name).join(" and ");

        let cgSpell = actor.items.find(i => i.type === "spell" && i.name === "Conglomerate Grab");
        const spellSystemData = {
            level: { value: spellRank },
            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
            tradition: { value: "divine" },
            defense: { save: { statistic: "fortitude", basic: false, dc: { value: exactDC } } }
        };

        if (!cgSpell) {
            const created = await actor.createEmbeddedDocuments("Item", [{ name: "Conglomerate Grab", type: "spell", img: "icons/magic/control/silhouette-grow-shrink-tan.webp", system: spellSystemData }]);
            cgSpell = created[0];
        } else {
            await cgSpell.update({ system: spellSystemData });
        }

        const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
        const htmlContent = await renderTemplate(templatePath, {
            targets: Object.values(targetsData),
            itemName: "Conglomerate Grab",
            saveType: "Fortitude",
            saveDC: exactDC
        });

        const kamikazeNotice = isKamikaze ? `<p style="color: #ff6b6b; font-weight: bold; text-align: center; margin-bottom: 5px; border: 1px dashed #ff6b6b; padding: 2px;">[Kamikaze Active: This thrall is removed automatically when its Strike resolves]</p>` : ``;

        await createNecroCard({
            speaker: ChatMessage.getSpeaker({ actor }),
            flavor: `<strong>Conglomerate Grab!</strong>`,
            content: `
                <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #cc0000;">
                    ${kamikazeNotice}
                    <p style="margin: 0 0 5px 0;">The colossal mass of severed limbs violently lashes out, successfully striking <b>${targetNames}</b>!</p>
                    <p style="margin: 0; font-size: 0.95em;">They must succeed at a Fortitude save or be <b>Grabbed</b> for 1 round (<b>Restrained</b> on a Critical Failure). Escape DC is ${exactDC}.</p>
                    <hr>${htmlContent}
                </div>
            `,
            flags: {
                "aoe-easy-resolve": {
                    templateId: null,
                    documentName: "ManualTarget",
                    itemUuid: cgSpell.uuid,
                    itemName: "Conglomerate Grab",
                    saveType: "fortitude",
                    saveDC: exactDC,
                    isBasicSave: false,
                    targets: targetsData,
                    hazardDamage: null,
                    isReactive: false,
                    originMessageId: null
                }
            }
        });
    };

    new NecroDialog({
        title: "Conglomerate Charge",
        content: `<p>Command <b>${tokenDoc.name}</b> to charge? (Hits ${originalTargets.length} target(s) for an additional <b>+${chargeDice}d6</b> damage each).</p>`,
        buttons: {
            charge: { icon: '<i class="fas fa-running"></i>', label: "Just Charge", callback: async () => { await guardAction(() => executeConglomerate(false)); } },
            destroy: { icon: '<i class="fas fa-bomb"></i>', label: "Charge & Destroy", callback: async () => { await guardAction(() => executeConglomerate(true)); } },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "charge"
    }).render(true);
}