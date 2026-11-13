import { tokenPortrait } from "../system/thrall-manager.js";
import { executeDelete } from "../system/socket.js";
import { notify } from "../system/notify.js";
import { canThrallDealVitality, getSpellDC, getTokenDistance } from "./spell-helpers.js";

export async function rollNativeStrike(deck, actor, tokenDoc, tokenId, eventObj, isKamikaze = false, chargeDice = 0, passedSpellRank = 0) {
    const necroLevel = actor.level || 1;
    const baseDice = Math.max(1, Math.floor((necroLevel - 1) / 4) + 1);

    const mapPenalty = deck.currentMap !== undefined ? deck.currentMap : 0;
    let variantIndex = 0;
    if (mapPenalty === -5) variantIndex = 1;
    if (mapPenalty === -10) variantIndex = 2;

    const isNightmare = tokenDoc.getFlag("necromancer-thrall-helper", "isRecurringNightmare");
    const isLancer = tokenDoc.getFlag("necromancer-thrall-helper", "isSkeletalLancer");
    const isGraveyard = tokenDoc.getFlag("necromancer-thrall-helper", "isLivingGraveyard") || tokenDoc.name.includes("Living Graveyard");
    const isPerfected = tokenDoc.getFlag("necromancer-thrall-helper", "isPerfectedThrall") || tokenDoc.name.includes("Perfected");
    const spellRank = passedSpellRank || Math.max(1, Math.ceil(necroLevel / 2));

    let damageType = "bludgeoning";
    if (deck.spiritStates && deck.spiritStates[tokenId]) {
        damageType = deck.spiritStates[tokenId];
    }

    if (damageType === "vitality" && !canThrallDealVitality(actor)) damageType = "bludgeoning";
    if (isNightmare) damageType = "void";
    if (isLancer) damageType = "piercing";

    let totalChargeDice = chargeDice;
    if (isNightmare || isLancer) {
        const bonusDice = spellRank >= 8 ? 3 : 2;
        totalChargeDice += bonusDice;
    }
    if (isGraveyard && chargeDice > 0) totalChargeDice += 3;
    if (isPerfected && chargeDice > 0) totalChargeDice += 6;

    let existingWeapon = tokenDoc.actor.items.find(i => i.type === "melee" && i.name.includes("Thrall Strike"));

    if (existingWeapon) {
        const rollKeys = Object.keys(existingWeapon.system.damageRolls || {});
        const currentType = rollKeys.length > 0 ? existingWeapon.system.damageRolls[rollKeys[0]].damageType : null;
        if (currentType !== damageType) {
            await existingWeapon.delete();
            existingWeapon = null;
        }
    }

    if (!existingWeapon) {
        let attackMod = Math.floor(necroLevel * 1.5);
        const spellcasting = actor.spellcasting?.filter(s => s.statistic)?.sort((a, b) => b.statistic.check.mod - a.statistic.check.mod)[0];
        if (spellcasting) attackMod = spellcasting.statistic.check.mod;

        const weaponData = {
            name: "Thrall Strike",
            type: "melee",
            img: "icons/skills/melee/unarmed-punch-fist.webp",
            system: {
                weaponType: { value: "melee" },
                bonus: { value: attackMod },
                damageRolls: { base: { damage: `${baseDice}d6`, damageType: damageType } },
                traits: { value: ["magical", "unarmed"] }
            }
        };
        await tokenDoc.actor.createEmbeddedDocuments("Item", [weaponData]);
    } else {
        const rollKeys = Object.keys(existingWeapon.system.damageRolls || {});
        if (rollKeys.length > 0) {
            const firstKey = rollKeys[0];
            if (existingWeapon.system.damageRolls[firstKey].damageType !== damageType) {
                await existingWeapon.update({
                    [`system.damageRolls.${firstKey}.damageType`]: damageType
                });
            }
        }
    }

    let addedEffectIds = [];
    if (totalChargeDice > 0) {
        const rules = [{
            key: "DamageDice", selector: "strike-damage", diceNumber: totalChargeDice, dieSize: "d6", slug: "thrall-charge-dice"
        }];
        if (isKamikaze) {
            rules.push({ key: "FlatModifier", selector: "strike-damage", value: spellRank, type: "status", slug: "thrall-charge-status" });
        }

        const effectData = {
            type: "effect",
            name: isKamikaze ? "Thrall Charge (Kamikaze)" : "Thrall Charge",
            img: "icons/magic/death/undead-ghost-scream-teal.webp",
            system: { level: { value: spellRank }, duration: { value: 1, unit: "rounds", expiry: "turn-end" }, rules: rules }
        };
        const createdEffects = await tokenDoc.actor.createEmbeddedDocuments("Item", [effectData]);
        addedEffectIds = createdEffects.map(effect => effect.id);
    }

    let strike = null;
    for (let attempts = 0; attempts < 20; attempts++) {
        const actionsList = tokenDoc.actor?.system?.actions;
        strike = actionsList?.find(a => a.item?.name?.includes("Thrall Strike") || a.slug?.includes("thrall-strike"));
        if (strike && strike.variants && strike.variants[variantIndex]) {
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!strike || !strike.variants || !strike.variants[variantIndex]) {
        notify("warn", `Execution failed. ${tokenDoc.name} could not draw its weapon (Network Timeout).`);
        return;
    }

    await strike.variants[variantIndex].roll({ event: eventObj });

    if (deck.currentMap === undefined || deck.currentMap === 0) {
        deck.currentMap = -5;
    } else if (deck.currentMap === -5) {
        deck.currentMap = -10;
    }
    deck.render(false);

    if (isKamikaze) {
        await tokenDoc.actor.update({ "system.attributes.hp.value": 0 });
    }

    if (addedEffectIds.length > 0 || isKamikaze) {
        const hookId = Hooks.on("createChatMessage", async (msg) => {
            if (msg.speaker?.token === tokenDoc.id && msg.flags?.pf2e?.context?.type === "damage-roll") {
                Hooks.off("createChatMessage", hookId);

                if (addedEffectIds.length > 0 && tokenDoc.actor) {
                    await tokenDoc.actor.deleteEmbeddedDocuments("Item", addedEffectIds);
                }

                if (isKamikaze && tokenDoc) {
                    await executeDelete(tokenDoc.id);
                }
            }
        });

        setTimeout(async () => {
            Hooks.off("createChatMessage", hookId);
            if (addedEffectIds.length > 0 && tokenDoc?.actor) {
                const activeBuffs = tokenDoc.actor.items.filter(i => addedEffectIds.includes(i.id)).map(i => i.id);
                if (activeBuffs.length > 0) {
                    await tokenDoc.actor.deleteEmbeddedDocuments("Item", activeBuffs);
                }
            }
        }, 120000);
    }
}

export async function executeStrike({ deck, actor, tokenDoc, tokenId, event }) {
    await rollNativeStrike(deck, actor, tokenDoc, tokenId, event);
}

export async function executeCharge({ deck, actor, tokenDoc, tokenId, event }) {
    const necroLevel = actor.level || 1;
    const spellRank = Math.ceil(necroLevel / 2);
    let chargeDice = 1;
    if (spellRank >= 10) chargeDice = 4;
    else if (spellRank >= 6) chargeDice = 3;
    else if (spellRank >= 2) chargeDice = 2;

    new Dialog({
        title: "Thrall Charge",
        content: `<p>Detonate <b>${tokenDoc.name}</b> upon impact for an additional +${spellRank} status bonus to damage?</p>`,
        buttons: {
            charge: {
                icon: '<i class="fas fa-running"></i>',
                label: "Just Charge",
                callback: async () => {
                    await rollNativeStrike(deck, actor, tokenDoc, tokenId, event, false, chargeDice, spellRank);
                }
            },
            destroy: {
                icon: '<i class="fas fa-bomb"></i>',
                label: "Charge & Destroy",
                callback: async () => {
                    await rollNativeStrike(deck, actor, tokenDoc, tokenId, event, true, chargeDice, spellRank);
                }
            }
        },
        default: "charge"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}

export async function executeConglomerateCharge({ deck, actor, tokenDoc, event }) {
    const originalTargets = Array.from(game.user.targets);
    if (originalTargets.length === 0 || originalTargets.length > 2) {
        return notify("warn", "Conglomerate Charge requires exactly 1 or 2 targets selected.");
    }

    const validTargets = originalTargets.filter(t => getTokenDistance(tokenDoc, t) <= 10);
    if (validTargets.length !== originalTargets.length) {
        return notify("warn", "All targets for Conglomerate Charge must be within 10 feet of the thrall.");
    }

    const necroLevel = actor.level || 1;
    const baseDice = Math.max(1, Math.floor((necroLevel - 1) / 4) + 1);
    const spellRank = Math.max(1, Math.ceil(necroLevel / 2));
    let chargeDice = 1;
    if (spellRank >= 10) chargeDice = 4;
    else if (spellRank >= 6) chargeDice = 3;
    else if (spellRank >= 2) chargeDice = 2;

    const executeConglomerate = async (isKamikaze) => {
        const staleEffects = tokenDoc.actor.items.filter(i => i.name.includes("Thrall Charge"));
        if (staleEffects.length > 0) {
            await tokenDoc.actor.deleteEmbeddedDocuments("Item", staleEffects.map(i => i.id));
        }

        const existingWeapon = tokenDoc.actor.items.find(i => i.type === "melee" && i.name.includes("Thrall Strike"));
        if (!existingWeapon) {
            let attackMod = Math.floor(necroLevel * 1.5);
            const spellcasting = actor.spellcasting?.filter(s => s.statistic)?.sort((a, b) => b.statistic.check.mod - a.statistic.check.mod)[0];
            if (spellcasting) attackMod = spellcasting.statistic.check.mod;

            const weaponData = {
                name: "Thrall Strike",
                type: "melee",
                img: "icons/skills/melee/unarmed-punch-fist.webp",
                system: {
                    weaponType: { value: "melee" },
                    bonus: { value: attackMod },
                    damageRolls: { base: { damage: `${baseDice}d6`, damageType: "bludgeoning" } },
                    traits: { value: ["magical", "unarmed"] }
                }
            };
            await tokenDoc.actor.createEmbeddedDocuments("Item", [weaponData]);
        }

        let addedEffectIds = [];
        if (chargeDice > 0) {
            const rules = [{
                key: "DamageDice", selector: "strike-damage", diceNumber: chargeDice, dieSize: "d6", slug: "thrall-charge-dice"
            }];
            if (isKamikaze) {
                rules.push({ key: "FlatModifier", selector: "strike-damage", value: spellRank, type: "status", slug: "thrall-charge-status" });
            }

            const effectData = {
                type: "effect",
                name: isKamikaze ? "Thrall Charge (Kamikaze)" : "Thrall Charge",
                img: "icons/magic/death/undead-ghost-scream-teal.webp",
                system: { level: { value: spellRank }, duration: { value: 1, unit: "rounds", expiry: "turn-end" }, rules: rules }
            };
            const createdEffects = await tokenDoc.actor.createEmbeddedDocuments("Item", [effectData]);
            addedEffectIds = createdEffects.map(effect => effect.id);
        }

        const mapPenalty = deck.currentMap !== undefined ? deck.currentMap : 0;
        let variantIndex = 0;
        if (mapPenalty === -5) variantIndex = 1;
        if (mapPenalty === -10) variantIndex = 2;

        let strike = null;
        for (let attempts = 0; attempts < 20; attempts++) {
            const actionsList = tokenDoc.actor?.system?.actions;
            strike = actionsList?.find(a => a.item?.name?.includes("Thrall Strike") || a.slug?.includes("thrall-strike"));
            if (strike && strike.variants && strike.variants[variantIndex]) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!strike || !strike.variants || !strike.variants[variantIndex]) {
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

        if (isKamikaze) await tokenDoc.actor.update({ "system.attributes.hp.value": 0 });

        if (addedEffectIds.length > 0 || isKamikaze) {
            setTimeout(async () => {
                if (addedEffectIds.length > 0 && tokenDoc?.actor) {
                    const activeBuffs = tokenDoc.actor.items.filter(i => addedEffectIds.includes(i.id)).map(i => i.id);
                    if (activeBuffs.length > 0) await tokenDoc.actor.deleteEmbeddedDocuments("Item", activeBuffs);
                }
                if (isKamikaze && tokenDoc) await executeDelete(tokenDoc.id);
            }, 60000);
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

        const kamikazeNotice = isKamikaze ? `<p style="color: #ff6b6b; font-weight: bold; text-align: center; margin-bottom: 5px; border: 1px dashed #ff6b6b; padding: 2px;">[Kamikaze Active: Use the 'Dismiss' button on the Command Deck to destroy this thrall when damage is resolved]</p>` : ``;

        await ChatMessage.create({
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

    new Dialog({
        title: "Conglomerate Charge",
        content: `<p>Command <b>${tokenDoc.name}</b> to charge? (Hits ${originalTargets.length} target(s) for an additional <b>+${chargeDice}d6</b> damage each).</p>`,
        buttons: {
            charge: { icon: '<i class="fas fa-running"></i>', label: "Just Charge", callback: async () => { await executeConglomerate(false); } },
            destroy: { icon: '<i class="fas fa-bomb"></i>', label: "Charge & Destroy", callback: async () => { await executeConglomerate(true); } },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "charge"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}