import {
    prepareThrallPayload,
    getThrallPresets,
    repairActorArt,
    tokenPortrait,
    isVideoPath,
    defaultThrallLabel
} from "./thrall-manager.js";
import { executeSpawn, createSpawnBatch, executeHazard } from "./socket.js";
import { notify, notifyForce, placementHint } from "./notify.js";
import { effectColor, effectColorNum, zoneBorderColor } from "./effect-colors.js";
import {
    updateIfExists,
    getSpellDC,
    getTokenDistance,
    hasConjurerOfCorpses,
    buildOwnerMap
} from "../spells/spell-helpers.js";

globalThis.NecroThrallHelper = globalThis.NecroThrallHelper || {};
globalThis.NecroThrallHelper.declinedPools = globalThis.NecroThrallHelper.declinedPools || new Set();

Hooks.once("ready", async () => {
    game.socket.on("module.necromancer-thrall-helper", async (data) => {
        if (!game.user.isGM) return;
        if (data.action === "spawnOriginMarker") {
            await globalThis.NecroThrallHelper.spawnOriginMarker(data.sceneId, data.drawingData, data.durationMs);
        }
        if (data.action === "deleteBloodPool") {
            const scene = game.scenes.get(data.sceneId);
            if (!scene) return;
            const region = scene.regions.get(data.regionId);
            if (region) await region.delete();
            const drawing = scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "poolId") === data.poolId);
            if (drawing) await drawing.delete();
        }
        if (data.action === "lockDeathReaction") {
            const msg = game.messages.get(data.messageId);
            if (msg) await msg.setFlag("necromancer-thrall-helper", "reactionUsed", data.label);
        }
        if (data.action === "purgeMapGraphics") {
            const scene = game.scenes.get(data.sceneId);
            if (!scene) return;
            if (data.regionIds?.length) await scene.deleteEmbeddedDocuments("Region", data.regionIds.filter(id => scene.regions.has(id))).catch(() => {});
            if (data.drawingIds?.length) await scene.deleteEmbeddedDocuments("Drawing", data.drawingIds.filter(id => scene.drawings.has(id))).catch(() => {});
            if (data.templateIds?.length) await scene.deleteEmbeddedDocuments("MeasuredTemplate", data.templateIds.filter(id => scene.templates.has(id))).catch(() => {});
        }
        if (data.action === "addCondition") {
            const targetActor = await fromUuid(data.actorUuid);
            if (targetActor) await targetActor.createEmbeddedDocuments("Item", [data.itemData]).catch(() => {});
        }
    });

    if (game.user.isGM) {
        const requiredActors = ["Thrall", "Perfected Thrall", "Skeletal Lancer", "Recurring Nightmare", "Living Graveyard", "Bloody Tendril", "Conglomerate of Limbs"];
        const pack = game.packs.get("necromancer-thrall-helper.necro-thralls");
        if (pack) {
            const index = await pack.getIndex();
            let folder = game.folders.find(f => f.name === "Necromancer Thralls" && f.type === "Actor");
            for (const name of requiredActors) {
                if (!game.actors.find(a => a.name === name)) {
                    if (!folder) folder = await Folder.create({ name: "Necromancer Thralls", type: "Actor", color: "#4b5563" });
                    const entry = index.find(a => a.name === name);
                    if (entry) await repairActorArt(await game.actors.importFromCompendium(pack, entry._id, { folder: folder.id }));
                }
            }
        }
    }

    if (!CONFIG.Actor.documentClass.prototype._necroHelperApplyDamageWrapped) {
        const originalApplyDamage = CONFIG.Actor.documentClass.prototype.applyDamage;
        CONFIG.Actor.documentClass.prototype.applyDamage = async function (options) {
            const preHp = this.system?.attributes?.hp?.value || 0;
            const result = await originalApplyDamage.call(this, options);
            const postHp = this.system?.attributes?.hp?.value || 0;
            const hpLost = preHp - postHp;
            if (hpLost > 0) Hooks.callAll("necroHelperDamageApplied", this, options, hpLost);
            return result;
        };
        CONFIG.Actor.documentClass.prototype._necroHelperApplyDamageWrapped = true;
    }

    const aoeApi = game.modules.get("aoe-easy-resolve")?.api;
    if (!aoeApi) return;

    aoeApi.registerInterceptor("preRenderCard", async (payload) => {
        const name = payload.itemName || payload.originItem?.name || "";

        if (name.includes("Calcification")) {
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (canvas.tokens.get(tokenId)?.actor?.system?.traits?.value?.includes("skeleton")) targetData.isImmune = true;
            }
        }

        if (name === "Thick Skin" || name.startsWith("Thick Skin")) {
            payload.itemName = "Thick Skin";
            payload.hazardDamage = null;
            const casterAlliance = payload.caster?.system?.details?.alliance || payload.originItem?.actor?.system?.details?.alliance || "party";
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;
                const targetAlliance = token.actor.system?.details?.alliance || (token.actor.hasPlayerOwner ? "party" : "opposition");
                if (targetAlliance === casterAlliance || targetData.isImmune) delete payload.targets[tokenId];
            }
        }

        if (name.includes("Flesh Tsunami")) payload.itemName = "Flesh Tsunami (Greater Difficult Terrain)";
        if (name.includes("Blossoming Gore Hazard")) {
            payload.hazardDamage = null;
            payload.itemName = "Blossoming Gore Hazard <style>.blossoming-gore-hide .roll-damage-btn { display: none !important; }</style><span class='blossoming-gore-hide'></span>";
        }
        if (name.includes("Dread Mosquito")) {
            payload.hazardDamage = null;
            payload.itemName = "Dread Mosquito Storm <style>.dms-hide .roll-damage-btn { display: none !important; }</style><span class='dms-hide'></span>";
        }

        if (name.includes("Desperate Revival") || name.includes("Necrotic Bomb") || name.includes("Necrotic Blast") || name.includes("Dread Mosquito")) {
            const msg = payload.message || (payload.messageId ? game.messages.get(payload.messageId) : null) || game.messages.contents.slice().reverse().find(m => m.flags?.["aoe-easy-resolve"]?.itemName === payload.itemName) || game.messages.get(payload.originMessageId);
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;
                const currentType = msg?.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`) || "void";
                const negHeal = token.actor.system.attributes.hp?.negativeHealing || false;
                targetData.isImmune = (currentType === "vitality" && !negHeal) || (currentType === "void" && negHeal);
                targetData.isHealing = false;
            }
        }

        if (name.includes("Harm")) {
            const msg = payload.message || (payload.messageId ? game.messages.get(payload.messageId) : null) || game.messages.contents.slice().reverse().find(m => m.flags?.["aoe-easy-resolve"]?.itemName === payload.itemName) || game.messages.get(payload.originMessageId);
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;
                const currentState = msg?.getFlag("necromancer-thrall-helper", `harmState_${tokenId}`) || "void";
                const negHeal = token.actor.system.attributes.hp?.negativeHealing || false;
                targetData.isHealing = (currentState === "void" && negHeal) || currentState === "heal";
                targetData.isImmune = (currentState === "vit" && !negHeal);
            }
        }
        return payload;
    }, 999);

    aoeApi.registerInterceptor("preApplyDamage", async (payload) => {
        const msg = payload.messageId ? game.messages.get(payload.messageId) : null;
        const originName = msg?.flags?.["aoe-easy-resolve"]?.itemName || payload.originItem?.name || "";

        const pushReceipt = (tokenId, token, content, saveNote) => {
            window.aoeEasyResolveApplying?.receipt.push({
                tokenId,
                speaker: { alias: token.name },
                img: tokenPortrait(token.document),
                content,
                saveNote
            });
        };

        if (originName.includes("Living Graveyard")) {
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor || !dos) continue;
                if (dos === "failure" || dos === "criticalFailure") {
                    try { if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("prone"); } catch (e) {}
                    pushReceipt(tokenId, token, `<span style="color: #ef4444; font-weight: bold;">Knocked Prone!</span>`, "Violent Shake");
                } else {
                    pushReceipt(tokenId, token, `<span style="color: #4ade80; font-weight: bold;">Keeps their footing!</span>`, "Resisted");
                }
                targetData.hasApplied = true;
            }
        }

        if (originName === "Thick Skin" || originName.startsWith("Thick Skin")) {
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor || !dos) continue;
                let receiptText = `<span style="font-weight: bold; color: #888;">Resists the shockwave.</span>`;
                if (dos === "failure" || dos === "criticalFailure") {
                    const existingSickened = token.actor.getCondition?.("sickened") || token.actor.itemTypes?.condition?.find(c => c.slug === "sickened");
                    if (existingSickened) {
                        receiptText = `<span style="color: #ff8c00;">Failed save, but already Sickened ${existingSickened.value || 1}.</span>`;
                    } else {
                        try { if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("sickened", { value: 1, max: 1 }); } catch (e) {}
                        receiptText = `<span style="color: #ff0000; font-weight: bold;">Sickened by the violent muscle ripples! (Sickened 1)</span>`;
                    }
                }
                pushReceipt(tokenId, token, receiptText, "Thick Skin");
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Desperate Revival")) {
            let totalSiphonedDamage = 0;
            const caster = payload.originItem?.actor || game.user.character;
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor) continue;
                if (!dos || dos === "criticalSuccess" || targetData.isImmune) {
                    pushReceipt(tokenId, token, `<span style="color: #008000; font-weight: bold;">Unaffected by the siphon.</span>`, "Crit Success / Immune");
                    targetData.hasApplied = true;
                    continue;
                }
                const targetLevel = token.actor.level || 1;
                const damageAmount = dos === "success" ? Math.max(1, Math.floor(targetLevel / 2)) : dos === "failure" ? Math.max(1, targetLevel) : Math.max(2, targetLevel * 2);
                const chosenType = msg?.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`) || "void";
                const DamageRoll = CONFIG.Dice.rolls.find(r => r.name === "DamageRoll");
                if (DamageRoll && damageAmount > 0) {
                    const roll = await new DamageRoll(`${damageAmount}[${chosenType}]`).evaluate({ async: true });
                    targetData.hasApplied = true;
                    await token.actor.applyDamage({ damage: roll, token: token.document });
                    totalSiphonedDamage += damageAmount;
                }
            }
            if (caster && totalSiphonedDamage > 0) {
                const currentHP = caster.system.attributes.hp.value;
                const maxHP = caster.system.attributes.hp.max;
                const halfMaxHP = Math.floor(maxHP / 2);
                const actualHealed = Math.min(halfMaxHP, totalSiphonedDamage, maxHP - currentHP);
                if (actualHealed > 0) {
                    await caster.update({ "system.attributes.hp.value": currentHP + actualHealed });
                    const necroToken = caster.getActiveTokens()[0];
                    if (necroToken && canvas.ready) {
                        canvas.interface.createScrollingText(necroToken.center, `+${actualHealed} HP`, {
                            anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
                            fill: 0x4ade80,
                            direction: CONST.TEXT_ANCHOR_POINTS.UP
                        });
                    }
                    window.aoeEasyResolveApplying?.receipt.push({
                        tokenId: necroToken?.id || caster.id,
                        speaker: { alias: caster.name },
                        img: tokenPortrait(necroToken?.document) || caster.img,
                        content: `<span style="color: #4ade80; font-weight: bold;">Siphoned ${totalSiphonedDamage} life force, regaining ${actualHealed} HP (Cap: ${halfMaxHP} HP).</span>`,
                        saveNote: "Siphon Harvest"
                    });
                }
            }
        }

        if (originName.includes("Recurring Nightmare")) {
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor || !dos || dos === "criticalSuccess" || dos === "success" || targetData.isImmune) {
                    targetData.hasApplied = true;
                    continue;
                }
                const frightenedVal = dos === "criticalFailure" ? 2 : 1;
                let applied = false;
                try {
                    const currentVal = token.actor.getCondition?.("frightened")?.value || 0;
                    if (currentVal < frightenedVal && typeof token.actor.increaseCondition === "function") {
                        await token.actor.increaseCondition("frightened", { value: frightenedVal - currentVal });
                        applied = true;
                    }
                } catch (e) {}
                if (applied) {
                    pushReceipt(tokenId, token, `<span style="color: #a855f7; font-weight: bold;">Terrified by the phantasm! (Frightened ${frightenedVal})</span>`, "Recurring Nightmare");
                }
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Blossoming Gore Hazard")) {
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor || targetData.isImmune || !dos) {
                    targetData.hasApplied = true;
                    continue;
                }
                if (dos === "criticalSuccess") {
                    pushReceipt(tokenId, token, `<span style="color: #4ade80; font-weight: bold;">Evades the draining thorns!</span>`, "Crit Success");
                    targetData.hasApplied = true;
                    continue;
                }
                const drainedVal = (dos === "success" || dos === "failure") ? 1 : (dos === "criticalFailure") ? 2 : 0;
                if (drainedVal > 0) {
                    try { if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("drained", { value: drainedVal }); } catch (e) {}
                }
                const thrallsToSpawn = dos === "failure" ? 1 : dos === "criticalFailure" ? 2 : 0;
                let receiptContent = `<span style="color: #ff8c00; font-weight: bold;">Drained ${drainedVal}</span>`;
                if (thrallsToSpawn > 0) {
                    receiptContent += `<br><div style="margin-top: 4px;"><button type="button" class="gore-spawn-btn" data-count="${thrallsToSpawn}" data-target-id="${tokenId}" style="background: #220000; color: #ff6b6b; border: 1px solid #ff0000; padding: 2px; font-size: 0.85em; border-radius: 4px; cursor: pointer;"><i class="fas fa-ghost"></i> Sprout ${thrallsToSpawn} Thrall(s)</button></div>`;
                }
                pushReceipt(tokenId, token, receiptContent, `Blossoming Gore (${dos})`);
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Conglomerate Grab")) {
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor || targetData.isImmune) { targetData.hasApplied = true; continue; }
                if (dos === "failure" || dos === "criticalFailure") {
                    const cond = dos === "failure" ? "grabbed" : "restrained";
                    try { if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition(cond); } catch (e) {}
                    pushReceipt(tokenId, token, `<span style="color: #cc0000; font-weight: bold;">Snared by limbs! (${cond.charAt(0).toUpperCase() + cond.slice(1)})</span>`, "Conglomerate Grab");
                }
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Deathly Scream")) {
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor || targetData.isImmune) { targetData.hasApplied = true; continue; }
                if (dos === "failure" || dos === "criticalFailure") {
                    const val = dos === "failure" ? 1 : 2;
                    try { if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("frightened", { value: val }); } catch (e) {}
                    pushReceipt(tokenId, token, `<span style="color: #00ffff; font-weight: bold;">Terrified! (Frightened ${val})</span>`, "Deathly Scream");
                }
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Dead Weight")) {
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor || targetData.isImmune) { targetData.hasApplied = true; continue; }
                if (dos && dos !== "criticalSuccess") {
                    try {
                        if (typeof token.actor.increaseCondition === "function") {
                            await token.actor.increaseCondition("off-guard");
                            if (dos === "failure" || dos === "criticalFailure") {
                                await token.actor.increaseCondition("slowed", { value: dos === "failure" ? 1 : 2 });
                            }
                        }
                    } catch (e) {}
                    pushReceipt(tokenId, token, `<span style="color: #a855f7; font-weight: bold;">Off-Guard!</span>${(dos === "failure" || dos === "criticalFailure") ? ` <span style="color: #ff0000; font-weight: bold;">(Slowed ${dos === "failure" ? 1 : 2})</span>` : ""}`, "Dead Weight");
                }
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Blood Infusion")) {
            const spellRank = msg?.flags?.["aoe-easy-resolve"]?.spellRank || 1;
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor || targetData.isImmune) { targetData.hasApplied = true; continue; }
                if (dos && dos !== "criticalSuccess") {
                    try {
                        await token.actor.createEmbeddedDocuments("Item", [{
                            name: "Infused Blood",
                            type: "effect",
                            img: "icons/magic/water/blood-drop-skull.webp",
                            system: {
                                description: { value: "Loses immunity to bleed and is considered a creature with blood for 1 minute." },
                                duration: { value: 1, unit: "minutes", expiry: null },
                                rules: [{ key: "Immunity", type: "bleed", mode: "remove" }]
                            }
                        }]);
                        const damageFormula = dos === "success" ? `${spellRank}` : dos === "failure" ? `${spellRank}d6` : `${spellRank * 2}d6`;
                        if (typeof token.actor.increaseCondition === "function") {
                            await token.actor.increaseCondition("persistent-damage", { value: damageFormula, suboption: "bleed" });
                        }
                        pushReceipt(tokenId, token, `<span style="color: #ff0000; font-weight: bold;">Infused! Bleed Immunity Stripped & takes ${damageFormula} persistent bleed.</span>`, "Blood Infusion");
                    } catch (e) {}
                }
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Life Tap")) {
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor || targetData.isImmune) { targetData.hasApplied = true; continue; }
                if (dos && dos !== "criticalSuccess") {
                    const drainedVal = dos === "success" ? 1 : dos === "failure" ? 2 : 3;
                    try { if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("drained", { value: drainedVal }); } catch (e) {}
                    const hpLost = drainedVal * (token.actor.level || 1);
                    const healingAmount = hpLost * 2;
                    const caster = payload.originItem?.actor || game.user.character;
                    const eligibleAllies = canvas.tokens.placeables.filter(t => t.actor && (t.actor.system?.details?.alliance === "party" || t.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY));
                    let recipientActor = caster;

                    if (eligibleAllies.length > 1) {
                        await new Promise(resolve => {
                            new Dialog({
                                title: "Life Tap: Siphon Recipient",
                                content: `<p><b>${token.name}</b> lost ${hpLost} maximum HP. Choose who receives <b>${healingAmount} HP</b> of healing:</p><form><select id="heal-recipient">${eligibleAllies.map(t => `<option value="${t.actor.id}">${t.name}</option>`).join("")}</select></form>`,
                                buttons: {
                                    select: {
                                        label: "Apply Healing",
                                        callback: (html) => {
                                            const found = game.actors.get(html.find("#heal-recipient").val());
                                            if (found) recipientActor = found;
                                            resolve();
                                        }
                                    }
                                },
                                default: "select"
                            }).render(true);
                        });
                    }

                    if (recipientActor) {
                        const currentHP = recipientActor.system.attributes.hp.value;
                        const actualHealed = Math.min(recipientActor.system.attributes.hp.max - currentHP, healingAmount);
                        await recipientActor.update({ "system.attributes.hp.value": currentHP + actualHealed });
                        const recipientToken = recipientActor.getActiveTokens()[0];
                        if (recipientToken && canvas.ready && actualHealed > 0) {
                            canvas.interface.createScrollingText(recipientToken.center, `+${actualHealed} HP`, {
                                anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
                                fill: 0x4ade80,
                                direction: CONST.TEXT_ANCHOR_POINTS.UP
                            });
                        }
                        pushReceipt(tokenId, token, `<span style="color: #8a2be2; font-weight: bold;">Drained ${drainedVal} (${hpLost} HP).</span><br><span style="color: #4ade80;">Healed ${recipientActor.name} for ${actualHealed} HP!</span>`, "Life Tap");
                    }
                }
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Flesh Tsunami")) {
            const hasLimbs = msg?.getFlag("necromancer-thrall-helper", "limbsActivated");
            const saveDC = (msg?.flags?.["aoe-easy-resolve"] || payload.originItem?.flags?.["aoe-easy-resolve"] || {}).saveDC || 10;
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor) continue;
                if (!hasLimbs) {
                    pushReceipt(tokenId, token, `<span style="color: #888; font-weight: bold;">Area is Greater Difficult Terrain.</span>`, "Flesh Tsunami");
                    targetData.hasApplied = true;
                    continue;
                }
                if (targetData.isImmune) {
                    pushReceipt(tokenId, token, `<span style="color: #888; font-weight: bold;">Unaffected by limbs (Ally).</span>`, "Immune");
                    targetData.hasApplied = true;
                    continue;
                }
                if (!dos || dos === "criticalSuccess" || dos === "success") {
                    pushReceipt(tokenId, token, `<span style="color: #4ade80; font-weight: bold;">Evades the grasping flesh!</span>`, "Flesh Tsunami");
                    targetData.hasApplied = true;
                    continue;
                }
                try { if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("immobilized"); } catch (e) {}
                pushReceipt(tokenId, token, `<span style="color: #ef4444; font-weight: bold;">Snared by the gory wave! (Immobilized, Escape DC ${saveDC})</span>`, "Flesh Tsunami");
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Temporary Possession")) {
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor || !dos) continue;
                if (dos === "criticalSuccess") {
                    pushReceipt(tokenId, token, `<span style="color: #4ade80; font-weight: bold;">Shrugs off the possession completely! Unaffected.</span>`, `Temporary Possession (${dos})`);
                } else {
                    const actionsAllowed = dos === "success" ? 1 : dos === "failure" ? 2 : 3;
                    try { if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("stunned", { value: 1 }); } catch (e) {}
                    pushReceipt(tokenId, token, `<div style="text-align: left; font-size: 0.9em; margin-top: 2px;"><span style="color: #ef4444; font-weight: bold; text-transform: uppercase;">Controlled (${dos.replace(/([A-Z])/g, " $1")})</span><br>• Can spend up to <b>${actionsAllowed} action(s)</b>: <i>Drop Prone, Interact, Release, or Strike</i>.<br>• Strike MAP applies.<br>• Becomes <b>Stunned 1</b> at end of turn.<br><span style="color: #f87171; font-size: 0.85em; font-style: italic;">⚠️ Reflected Damage Warning: If this creature loses HP while possessed or stunned by this, you take half that amount!</span></div>`, `Temporary Possession (${dos})`);
                }
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Calcification")) {
            const saveDC = (msg?.flags?.["aoe-easy-resolve"] || payload.originItem?.flags?.["aoe-easy-resolve"] || {}).saveDC || 10;
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor || !dos) continue;
                const traits = token.actor.system?.traits?.value || [];
                const isSkeleton = traits.includes("skeleton") || targetData.isImmune;
                if (isSkeleton || dos === "criticalSuccess") {
                    pushReceipt(tokenId, token, `<span style="color: #4ade80; font-weight: bold;">Unaffected by the bone dust!</span>`, isSkeleton ? "Immune (Skeleton)" : "Crit Success");
                    targetData.hasApplied = true;
                    continue;
                }
                const slowVal = dos === "success" ? 1 : dos === "failure" ? 1 : 2;
                const weakVal = dos === "success" ? 5 : 10;
                const titleColor = dos === "success" ? "#eab308" : dos === "failure" ? "#f97316" : "#ef4444";
                const titleText = dos === "success" ? "Calcifying!" : dos === "failure" ? "Calcifying Heavily!" : "Rapidly Petrifying!";
                let details = `Slowed ${slowVal}, Weakness ${weakVal} Bludg.${dos !== "success" ? `<br><span style="font-size: 0.9em; font-style: italic; color: #ccc;">End of turn Fort save.</span>` : " (1 rd)"}`;
                if (traits.includes("incorporeal")) details += `<br><span style="color: #a855f7; font-weight: bold; font-size: 0.95em;">⚠️ Loses Incorporeal Trait!</span>`;
                try { if (typeof token.actor.increaseCondition === "function") { for (let i = 0; i < slowVal; i++) await token.actor.increaseCondition("slowed"); } } catch (e) {}
                try {
                    if (!token.actor.items.find(i => i.system?.slug === "effect-calcification" || i.name === "Effect: Calcification")) {
                        await token.actor.createEmbeddedDocuments("Item", [{
                            name: "Effect: Calcification",
                            type: "effect",
                            img: "icons/magic/death/skeleton-skull-soul-blue.webp",
                            system: {
                                slug: "effect-calcification",
                                level: { value: 9 },
                                duration: { value: dos === "success" ? 1 : -1, unit: dos === "success" ? "rounds" : "unlimited", expiry: "turn-start" },
                                description: { value: `You are calcifying. Weakness ${weakVal} to bludgeoning.` },
                                rules: [{ key: "Weakness", type: "bludgeoning", value: weakVal }]
                            },
                            flags: { "necromancer-thrall-helper": { calcificationDC: saveDC, isCalcifying: true } }
                        }]);
                    }
                } catch (e) {}
                pushReceipt(tokenId, token, `<div style="display: flex; flex-direction: column; align-items: flex-end; text-align: right; width: 100%; line-height: 1.2;"><span style="color: ${titleColor}; font-weight: bold; text-transform: uppercase;">${titleText}</span><div style="font-size: 0.9em; margin-top: 2px;">${details}</div></div>`, `Calcification (${dos})`);
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Dread Mosquito")) {
            const saveDC = (msg?.flags?.["aoe-easy-resolve"] || payload.originItem?.flags?.["aoe-easy-resolve"] || {}).saveDC || 10;
            const casterId = payload.originItem?.actor?.id || payload.caster?.id || "";
            const DamageRoll = CONFIG.Dice.rolls.find(r => r.name === "DamageRoll") || Roll;

            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                const dos = targetData.degreeOfSuccess;
                if (!token?.actor || !dos) continue;

                if (token.actor.items.some(i => i.getFlag("necromancer-thrall-helper", "isNecroticBlood"))) {
                    pushReceipt(tokenId, token, `<div style="text-align: right; padding-right: 5px; font-size: 0.9em;"><i class="fas fa-level-up-alt fa-rotate-90" style="color: #555; margin-right: 4px;"></i> <span style="color: #888; font-weight: bold;">Already Infected!</span></div>`, "Infected");
                    targetData.hasApplied = true;
                    continue;
                }

                const negHeal = token.actor.system.attributes.hp?.negativeHealing || false;
                const chosenType = msg?.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`) || "void";
                const isImmuneToSwarm = targetData.isImmune || (chosenType === "vitality" && !negHeal) || (chosenType === "void" && negHeal);

                if (isImmuneToSwarm) {
                    pushReceipt(tokenId, token, `<div style="text-align: right; padding-right: 5px; font-size: 0.9em;"><i class="fas fa-level-up-alt fa-rotate-90" style="color: #555; margin-right: 4px;"></i> <span style="color: #888; font-weight: bold;">Immune</span></div>`, "Immune");
                    targetData.hasApplied = true;
                    continue;
                }

                if (DamageRoll) {
                    const dmgRoll = await new DamageRoll(`1[${chosenType}]`).evaluate();
                    await token.actor.applyDamage({ damage: dmgRoll, token: token.document });
                }

                if (dos === "criticalSuccess") {
                    pushReceipt(tokenId, token, `<div style="text-align: right; padding-right: 5px; font-size: 0.9em;"><i class="fas fa-level-up-alt fa-rotate-90" style="color: #555; margin-right: 4px;"></i> <span style="color: #4ade80; font-weight: bold;">Evades the plague! (Takes 1 ${chosenType} damage)</span></div>`, "Crit Success");
                    targetData.hasApplied = true;
                    continue;
                }

                const stage = (dos === "criticalFailure") ? 2 : 1;
                pushReceipt(tokenId, token, `<div style="text-align: right; padding-right: 5px; font-size: 0.9em;"><i class="fas fa-level-up-alt fa-rotate-90" style="color: #555; margin-right: 4px;"></i> <span style="color: ${dos === "success" ? "#eab308" : "#ef4444"}; font-weight: bold;">Plagued! (Stage ${stage})</span></div>`, `Stage ${stage}`);

                try {
                    if ((token.actor.getCondition("sickened")?.value || 0) < stage) {
                        await token.actor.increaseCondition("sickened");
                    }
                    if (!token.actor.items.some(i => i.system?.slug === "effect-necrotic-blood")) {
                        await token.actor.createEmbeddedDocuments("Item", [{
                            name: "Effect: Necrotic Blood",
                            type: "effect",
                            img: "icons/magic/water/blood-drop-skull.webp",
                            system: {
                                slug: "effect-necrotic-blood",
                                level: { value: 18 },
                                duration: { value: (dos === "success") ? 1 : 6, unit: "rounds", expiry: "turn-end" },
                                description: { value: `<b>Necrotic Blood (Stage ${stage})</b><br>Stage 1: 3d10 ${chosenType}, Sickened 1, Weakness 5 Bleed.<br>Stage 2: 4d10 ${chosenType}, Sickened 2, Weakness 10 Bleed.<br>Stage 3: 5d10 ${chosenType}, Sickened 3, Weakness 20 Bleed.<br><br><i>If this creature dies, a thrall rises from its corpse.</i>` },
                                rules: [{ key: "Weakness", type: "bleed", value: stage === 3 ? 20 : stage * 5 }]
                            },
                            flags: { "necromancer-thrall-helper": { isNecroticBlood: true, masterId: casterId, dmgType: chosenType, necroticBloodDC: saveDC, stage: stage } }
                        }]);
                    }
                } catch (e) { console.error("Necromancer Helper | Disease DB lock:", e); }

                targetData.hasApplied = true;
            }
        }
        return payload;
    }, 999);
});

Hooks.on("hoverToken", (token, hovered) => {
    if (!token?.id) return;
    document.querySelectorAll(`.thrall-row[data-token-id="${token.id}"]`).forEach(row => {
        row.classList.toggle("canvas-hover", !!hovered);
    });
});

Hooks.on("preDeleteToken", (tokenDoc, _options, userId) => {
    if (game.user.id !== userId) return;
    const isPerfected = tokenDoc.getFlag("necromancer-thrall-helper", "isPerfectedThrall") || tokenDoc.name.includes("Perfected");
    if (isPerfected) {
        const hp = tokenDoc.actor?.system?.attributes?.hp?.value || 0;
        if (hp <= 0) return true;

        setTimeout(async () => {
            const DamageRoll = CONFIG.Dice.rolls.find(r => r.name === "DamageRoll");
            if (DamageRoll) {
                const roll = await new DamageRoll("20[untyped]").evaluate({ async: true });
                await tokenDoc.actor.applyDamage({ damage: roll, token: tokenDoc });
            }
        }, 50);

        notify("info", "The Perfected Thrall endures the sacrifice, losing 20 HP instead!");
        return false;
    }
});

Hooks.on("deleteItem", async (itemDoc, _options, userId) => {
    if (game.user.id !== userId || itemDoc.type !== "effect" || !itemDoc.getFlag("necromancer-thrall-helper", "isHazardTracker")) return;

    const hazardId = itemDoc.getFlag("necromancer-thrall-helper", "hazardId");
    const targetScene = game.scenes.get(itemDoc.getFlag("necromancer-thrall-helper", "sceneId"));
    if (!targetScene) return;

    const rIds = targetScene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "hazardId") === hazardId || r.getFlag("necromancer-thrall-helper", "goreRegionId") === hazardId).map(r => r.id);
    const dIds = targetScene.drawings.filter(d => d.getFlag("necromancer-thrall-helper", "hazardId") === hazardId || d.getFlag("necromancer-thrall-helper", "goreRegionId") === hazardId).map(d => d.id);

    if (rIds.length > 0 || dIds.length > 0) {
        globalThis.NecroThrallHelper.purgeGraphics(targetScene.id, { regionIds: rIds, drawingIds: dIds });
    }
});

Hooks.on("preCreateChatMessage", (message) => {
    const originUuid = message.flags?.["aoe-easy-resolve"]?.itemUuid ?? message.flags?.pf2e?.origin?.uuid;
    if (!originUuid) return;
    const item = fromUuidSync(originUuid, { strict: false });
    const actor = item?.parent;
    if (!actor || actor.documentName !== "Actor" || !/^necrotic (bomb|blast)/i.test(item.name ?? "")) return;
    message.updateSource({ speaker: ChatMessage.getSpeaker({ actor, token: actor.getActiveTokens(false, true)[0] }) });
});

Hooks.on("deleteToken", async (tokenDoc) => {
    if (!game.users.activeGM?.isSelf) return;

    if (tokenDoc.getFlag("necromancer-thrall-helper", "isRecurringNightmare")) {
        const masterId = tokenDoc.getFlag("necromancer-thrall-helper", "masterId");
        const master = game.actors.get(masterId);
        if (master) await master.setFlag("necromancer-thrall-helper", "nightmareDestroyed", true);
    }

    const masterId = tokenDoc.getFlag("necromancer-thrall-helper", "masterId")
        || tokenDoc.actor?.getFlag("necromancer-thrall-helper", "masterId");
    const isReanimated = tokenDoc.getFlag("necromancer-thrall-helper", "isReanimatedFoe")
        || tokenDoc.actor?.items.some(i => i.getFlag("necromancer-thrall-helper", "isReanimatedFoe"));

    if (!masterId || isReanimated) return;

    const masterActor = game.actors.get(masterId)
        || canvas.tokens.placeables.find(t => t.actor?.id === masterId)?.actor;
    if (!masterActor) return;

    // Blood Fascination: Sanguine Return
    if (masterActor.items.some(i => i.slug === "blood" || i.name === "Blood")) {
        const currentHP = masterActor.system.attributes.hp.value;
        const maxHP = masterActor.system.attributes.hp.max;
        const healAmount = Math.floor(((masterActor.level || 1) + 3) / 4);
        const actualHealed = Math.min(maxHP - currentHP, healAmount);

        if (actualHealed > 0) {
            await masterActor.update({ "system.attributes.hp.value": currentHP + actualHealed });
            const necroToken = masterActor.getActiveTokens()[0] || canvas.tokens.placeables.find(t => t.actor?.id === masterActor.id);
            if (necroToken && canvas.ready) {
                canvas.interface.createScrollingText(necroToken.center, `+${actualHealed} HP (Blood)`, {
                    anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
                    fill: 0xef4444,
                    direction: CONST.TEXT_ANCHOR_POINTS.UP
                });
            }
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: masterActor }),
                flavor: `<strong>Sanguine Return</strong>`,
                content: `<div style="background: rgba(0,0,0,0.3); padding: 6px; border-radius: 4px; border-left: 4px solid #ef4444;"><p style="margin: 0; font-size: 0.95em;">A thrall falls, and its infused blood rushes back to <b>${masterActor.name}</b>, restoring <b>${actualHealed} HP</b>.</p></div>`
            });
        }
    }

    // Flesh Fascination: Gory Terrain
    if (masterActor.items.some(i => i.slug === "flesh" || i.name === "Flesh")) {
        const tX = tokenDoc.x, tY = tokenDoc.y, tW = tokenDoc.width || 1, tH = tokenDoc.height || 1;
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: masterActor }),
            flavor: `<strong>Flesh Fascination</strong>`,
            content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #9ca3af;"><p style="margin: 0 0 6px 0;"><b>${tokenDoc.name}</b> collapses into a heap of grotesque meat.</p><p style="margin: 0 0 8px 0; font-size: 0.9em; color: #ccc;">Do you want to leave behind difficult terrain (10 minutes)?</p><div style="text-align: center;"><button type="button" class="flesh-terrain-btn" data-x="${tX}" data-y="${tY}" data-w="${tW}" data-h="${tH}" data-master="${masterActor.id}" style="background: #1f2937; color: #d1d5db; border: 1px solid #4b5563; padding: 4px 8px; border-radius: 4px; cursor: pointer;"><i class="fas fa-spider"></i> Leave Gory Remains</button></div></div>`
        });
    }

    // Reinforced Skeleton: Speed Surge
    if (masterActor.items.some(i => /reinforced\s*skeleton/i.test(i.name) || i.slug === "reinforced-skeleton")) {
        const effectSlug = "effect-reinforced-skeleton-speed";
        const existingEffect = masterActor.items.find(i => i.system?.slug === effectSlug || /reinforced\s*skeleton.*speed/i.test(i.name));
        if (!existingEffect) {
            await masterActor.createEmbeddedDocuments("Item", [{
                name: "Reinforced Skeleton: Speed Surge",
                type: "effect",
                img: "icons/equipment/feet/boots-collared-simple-brown.webp",
                system: {
                    slug: effectSlug,
                    description: { value: "Whenever you destroy a thrall, your status bonus to Speeds increases to +10 feet for 1 round." },
                    duration: { value: 1, unit: "rounds", expiry: "turn-end" },
                    rules: [{ key: "FlatModifier", selector: "speed", value: 10, type: "status", slug: "reinforced-skeleton-status-speed" }]
                }
            }]);
        }
    }

    // Thick Skin
    const thickSkinItem = masterActor.items.find(i => i.name === "Thick Skin" || i.slug === "thick-skin");
    if (thickSkinItem && !window.SuppressThickSkin) {
        if (window.NecroThrallThickSkinLock) return;
        window.NecroThrallThickSkinLock = true;
        setTimeout(() => { window.NecroThrallThickSkinLock = false; }, 2000);

        const necroToken = masterActor.getActiveTokens()[0] || canvas.tokens.placeables.find(t => t.actor?.id === masterActor.id);
        if (!necroToken) return;

        const spellDC = getSpellDC(masterActor);
        if (game.combat) {
            await masterActor.setFlag("necromancer-thrall-helper", "thickSkinRound", `${game.combat.id}-${game.combat.round}`);
        }

        await updateIfExists(thickSkinItem, {
            "flags.aoe-easy-resolve": {
                useOverride: true,
                saveType: "fortitude",
                saveDC: spellDC,
                isAreaDamage: true,
                allyBaseEffect: "immune",
                enemyBaseEffect: "standard"
            }
        });

        window.aoeEasyResolveCache = { item: thickSkinItem, name: "Thick Skin", dc: spellDC, type: "fortitude", hazardDuration: null };

        const gridDist = canvas.scene?.grid?.distance || 5;
        const emanationDistance = (((necroToken.document.width || 1) * gridDist) / 2) + 5;

        await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{
            t: "circle",
            user: game.user.id,
            distance: emanationDistance,
            direction: 0,
            x: necroToken.center.x,
            y: necroToken.center.y,
            fillColor: effectColor(masterActor, "thickSkin", "#84cc16"),
            borderColor: zoneBorderColor(masterActor),
            flags: {
                "necromancer-thrall-helper": { source: "thick-skin" },
                "pf2e": { origin: { uuid: thickSkinItem.uuid } },
                "aoe-easy-resolve": { originItemUuid: thickSkinItem.uuid }
            }
        }]);

        setTimeout(() => {
            if (window.aoeEasyResolveCache?.name === "Thick Skin") window.aoeEasyResolveCache = null;
        }, 500);
    }
});

Hooks.on("createChatMessage", async (message) => {
    if (!game.user.isGM) return;
    const pf2eContext = message.flags?.pf2e?.context;
    if (!pf2eContext) return;

    // Skeletal Lancer Reaction
    if (pf2eContext.type === "attack-roll") {
        const speaker = message.speaker;
        let attackerToken = speaker?.token ? canvas.tokens.get(speaker.token) : null;
        if (!attackerToken && speaker?.actor) attackerToken = canvas.tokens.placeables.find(t => t.actor?.id === speaker.actor);

        if (attackerToken?.actor) {
            const alliance = attackerToken.actor.system?.details?.alliance;
            const disp = attackerToken.document.disposition;
            if (alliance !== "party" && disp !== CONST.TOKEN_DISPOSITIONS.FRIENDLY) {
                const lancers = canvas.tokens.placeables.filter(t => {
                    if (!t.actor || (t.actor.system?.attributes?.hp?.value <= 0)) return false;
                    const isLancer = t.document.getFlag("necromancer-thrall-helper", "isSkeletalLancer") || t.name.toLowerCase().includes("lancer");
                    const hasMaster = t.document.getFlag("necromancer-thrall-helper", "masterId");
                    return isLancer && hasMaster;
                });

                const closestLancer = lancers.find(l => l.distanceTo(attackerToken) <= 10.5);
                if (closestLancer) {
                    const DamageRoll = CONFIG.Dice.rolls.find(r => r.name === "DamageRoll") || Roll;
                    const roll = await new DamageRoll("5[piercing]").evaluate();
                    await roll.toMessage({
                        speaker: ChatMessage.getSpeaker({ token: closestLancer.document }),
                        flavor: `<strong>Skeletal Lancer Reaction</strong><br><b>${attackerToken.name}</b> dropped their guard near a Lancer and took a spear to the gut!`,
                        flags: { pf2e: { context: { type: "damage-roll", sourceType: "attack", options: ["damage:type:piercing"] } } }
                    });
                    if (typeof attackerToken.actor.applyDamage === "function") {
                        await attackerToken.actor.applyDamage({ damage: roll, token: attackerToken.document });
                    }
                }
            }
        }
    }

    // Draining Strike Reaction
    if (pf2eContext.type === "damage-roll") {
        const rollOptions = pf2eContext.options || [];
        if (!rollOptions.some(o => o === "draining-strike" || o.startsWith("draining-strike:"))) return;

        const actor = game.actors.get(message.speaker?.actor);
        if (!actor) return;

        const dsFeat = actor.items.find(i => i.slug === "draining-strike" || i.name === "Draining Strike");
        const requiredThralls = dsFeat ? parseInt(dsFeat.flags?.pf2e?.rulesSelections?.drainingStrike || dsFeat.flags?.pf2e?.rulesSelections?.["draining-strike"] || 1, 10) : 1;

        let rawSpiritDamage = 0;
        if (message.rolls?.length > 0 && message.rolls[0].instances) {
            message.rolls[0].instances.forEach(inst => { if (inst.type === "spirit") rawSpiritDamage += (inst.total ?? inst._total ?? 0); });
        }
        if (rawSpiritDamage === 0) return;

        const targetToken = canvas.tokens.get(pf2eContext.target?.token) || (game.user.targets.size > 0 ? Array.from(game.user.targets)[0] : null);
        let spiritHeal = rawSpiritDamage;

        if (targetToken?.actor) {
            const attrs = targetToken.actor.system.attributes;
            if ((attrs.immunities || []).some(i => i.type === "spirit" || i.type === "all-damage")) {
                spiritHeal = 0;
            } else {
                const weakness = (attrs.weaknesses || []).find(w => w.type === "spirit" || w.type === "all-damage")?.value || 0;
                const resistance = (attrs.resistances || []).find(r => r.type === "spirit" || r.type === "all-damage")?.value || 0;
                spiritHeal = Math.max(0, spiritHeal + weakness - resistance);
            }
        }

        if (spiritHeal === 0) return notify("info", "Draining Strike hit, but the target resisted all Spirit damage. No healing granted.");

        const necroToken = canvas.tokens.get(message.speaker?.token) || actor.getActiveTokens()[0];
        const gridDist = canvas.scene?.grid?.distance || 5;

        const availableThralls = canvas.tokens.placeables.filter(t => {
            if (t.document.getFlag("necromancer-thrall-helper", "masterId") !== actor.id) return false;
            const distToNecro = necroToken ? (Math.max(Math.abs(necroToken.x - t.x), Math.abs(necroToken.y - t.y)) / canvas.grid.size) * gridDist : 999;
            const distToTarget = targetToken ? (Math.max(Math.abs(targetToken.x - t.x), Math.abs(targetToken.y - t.y)) / canvas.grid.size) * gridDist : 999;
            return distToNecro <= 10 || distToTarget <= 10;
        });

        if (availableThralls.length < requiredThralls) {
            return notify("error", `Draining Strike requires ${requiredThralls} thrall(s) within 10ft of you or the target, but only found ${availableThralls.length}.`);
        }

        const checkboxes = availableThralls.map((t, index) => `
            <div style="display: flex; align-items: center; margin-bottom: 5px;">
                <input type="checkbox" id="drain-thrall-${index}" value="${t.id}" class="drain-checkbox" style="margin-right: 10px;">
                <label for="drain-thrall-${index}" style="display: flex; align-items: center; cursor: pointer;">
                    <img src="${t.document.texture?.src || "icons/svg/mystery-man.svg"}" width="30" height="30" style="border: none; margin-right: 10px; border-radius: 4px; object-fit: cover;">
                    ${t.name}
                </label>
            </div>
        `).join("");

        new Dialog({
            title: "Draining Strike",
            content: `<form id="drain-form" style="margin-bottom: 10px;"><p>Select <b>${requiredThralls}</b> thrall(s) to destroy to siphon their essence.</p><div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #4ade80; margin-bottom: 10px;"><p style="margin: 0; font-size: 0.9em;">Raw Spirit Damage: <b>${rawSpiritDamage}</b></p><p style="margin: 0; font-size: 0.9em;">Post-Mitigation Healing: <b>${spiritHeal} HP</b></p></div><div style="max-height: 200px; overflow-y: auto; border: 1px solid #333; padding: 5px; background: rgba(0,0,0,0.2); border-radius: 4px;">${checkboxes}</div></form>`,
            buttons: {
                drain: {
                    icon: '<i class="fas fa-heart-broken"></i>',
                    label: "Drain",
                    callback: async (dialogHtml) => {
                        const selectedIds = [];
                        dialogHtml.find(".drain-checkbox:checked").each((_i, cb) => selectedIds.push(cb.value));
                        if (selectedIds.length !== requiredThralls) return notify("warn", `You must select exactly ${requiredThralls} thrall(s). Action aborted.`);

                        const tokensToDelete = selectedIds.map(id => canvas.tokens.get(id));
                        const names = tokensToDelete.map(t => t.name).join(", ");
                        for (const t of tokensToDelete) await t.document.delete();

                        const currentHP = actor.system.attributes.hp.value;
                        const actualHealed = Math.min(actor.system.attributes.hp.max - currentHP, spiritHeal);
                        await actor.update({ "system.attributes.hp.value": currentHP + actualHealed });

                        if (actualHealed > 0 && canvas.ready && necroToken) {
                            canvas.interface.createScrollingText(necroToken.center, `+${actualHealed} HP`, {
                                anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
                                fill: 0x4ade80,
                                direction: CONST.TEXT_ANCHOR_POINTS.UP
                            });
                        }

                        await ChatMessage.create({
                            speaker: ChatMessage.getSpeaker({ actor }),
                            flavor: `<strong>Draining Strike</strong>`,
                            content: `<p><b>${actor.name}</b> destroys <b>${names}</b>, funneling their stolen vitality to recover <b>${actualHealed} HP</b>!</p>`
                        });
                    }
                },
                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
            },
            default: "drain",
            render: (dialogHtml) => {
                dialogHtml.find(".drain-checkbox").on("change", function () {
                    if (dialogHtml.find(".drain-checkbox:checked").length > requiredThralls) {
                        this.checked = false;
                        notify("warn", `You only need to sacrifice ${requiredThralls} thrall(s).`);
                    }
                });
            }
        }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
    }
});

Hooks.on("createItem", async (item, _options, userId) => {
    if (game.user.id !== userId || item.type !== "condition" || !item.parent || item.parent.type !== "character") return;
    const actor = item.parent;
    if (!actor.items.some(i => i.name === "Final Union" || i.slug === "final-union")) return;

    const slug = item.system.slug;
    if (slug === "unconscious" || slug === "prone") {
        setTimeout(async () => { await actor.items.find(i => i.id === item.id)?.delete(); }, 50);
        return;
    }

    if (slug === "dying" && !actor.items.some(i => i.getFlag("necromancer-thrall-helper", "isPuppetedCorpse"))) {
        setTimeout(async () => {
            const badConditions = actor.items.filter(i => i.type === "condition" && ["dying", "wounded", "doomed", "unconscious", "prone"].includes(i.system.slug));
            if (badConditions.length > 0) await actor.deleteEmbeddedDocuments("Item", badConditions.map(i => i.id));

            await actor.createEmbeddedDocuments("Item", [{
                name: "Effect: Puppeted Corpse",
                type: "effect",
                img: "icons/magic/death/skeleton-skull-soul-blue.webp",
                system: {
                    duration: { value: 1, unit: "minutes", expiry: "turn-start" },
                    description: { value: "Your heroic spirit puppets your corpse. You are an undead object. Immune to bleed, death effects, disease, healing, nonlethal, poison, void, doomed, drained, fatigued, sickened, and unconscious. Broken Threshold 100 (Slowed 1)." },
                    rules: [
                        { key: "FlatModifier", selector: "hp", value: 200 - actor.system.attributes.hp.max, type: "untyped" },
                        { key: "Immunity", type: "bleed" }, { key: "Immunity", type: "death-effects" }, { key: "Immunity", type: "disease" }, { key: "Immunity", type: "healing" }, { key: "Immunity", type: "nonlethal-attacks" }, { key: "Immunity", type: "poison" }, { key: "Immunity", type: "void" }, { key: "Immunity", type: "doomed" }, { key: "Immunity", type: "drained" }, { key: "Immunity", type: "fatigued" }, { key: "Immunity", type: "sickened" }, { key: "Immunity", type: "unconscious" }, { key: "Immunity", type: "prone" }
                    ]
                },
                flags: { "necromancer-thrall-helper": { isPuppetedCorpse: true } }
            }]);

            let attempts = 0;
            const resolvePuppetHP = async () => {
                if (actor.system.attributes.hp.max >= 200) {
                    await actor.update({ "system.attributes.hp.value": 200 });
                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor }),
                        flavor: `<strong>Final Union: Puppeted Corpse</strong>`,
                        content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #4ade80;"><p style="margin: 0 0 4px 0;"><b>${actor.name}</b> has fallen, but the heroic spirit refuses to abandon the body!</p><p style="margin: 0; font-size: 0.95em;">The corpse rises as an undead object with <b>200 HP</b> (Broken Threshold 100).</p></div>`
                    });
                } else if (attempts < 20) {
                    attempts++;
                    setTimeout(resolvePuppetHP, 100);
                }
            };
            resolvePuppetHP();
        }, 50);
    }
});

Hooks.on("updateActor", async (actor, changes) => {
    if (!game.user.isGM) return;

    const hpChange = foundry.utils.getProperty(changes, "system.attributes.hp.value");
    if (hpChange === undefined) return;
    const currentHp = hpChange;

    if (actor.items.some(i => i.getFlag("necromancer-thrall-helper", "isPuppetedCorpse"))) {
        const hasSlowed = actor.getCondition("slowed");
        if (currentHp <= 100 && currentHp > 0 && !hasSlowed) actor.increaseCondition("slowed").catch(() => {});
        else if (currentHp > 100 && hasSlowed) actor.decreaseCondition("slowed").catch(() => {});
    }

    if (currentHp > 0) return;

    const deadToken = actor.getActiveTokens()[0] || canvas.tokens.placeables.find(t => t.actor?.id === actor.id);
    if (!deadToken) return;

    if (actor.items.some(i => i.getFlag("necromancer-thrall-helper", "isReanimatedFoe"))) {
        await deadToken.document.delete();
        return ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            flavor: `<strong>Reanimated Foe Destroyed</strong>`,
            content: `<p>The unstable magic holding <b>${actor.name}</b> together violently collapses. It crumbles to dust!</p>`
        });
    }

    // Desperate Revival
    const hasDesperateRevival = actor.items.some(i => i.name === "Desperate Revival" || i.slug === "desperate-revival");
    if (hasDesperateRevival && !actor.getFlag("necromancer-thrall-helper", "desperateRevivalUsed") && !actor.getFlag("necromancer-thrall-helper", "revivalPrompted")) {
        await actor.setFlag("necromancer-thrall-helper", "revivalPrompted", true);
        setTimeout(() => actor.unsetFlag("necromancer-thrall-helper", "revivalPrompted"), 10000);
        return ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            flavor: `<strong>Desperate Revival Triggered!</strong>`,
            content: `<div style="background: rgba(0,0,0,0.35); padding: 10px; border-radius: 4px; border-left: 4px solid #ef4444;"><p style="margin: 0 0 6px 0;"><b>${actor.name}</b> is on the verge of death!</p><p style="margin: 0 0 8px 0; font-size: 0.95em;">Spend your reaction to avoid being knocked out, remain at 1 HP, and unleash a <b>60-foot life-draining emanation</b>?</p><div style="text-align: center;"><button type="button" class="desperate-revival-trigger-btn" data-necro-id="${actor.id}" style="background: #450a0a; color: #f87171; border: 1px solid #ef4444; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: bold;"><i class="fas fa-heartbeat"></i> Trigger Desperate Revival (1/Day)</button></div></div>`
        });
    }

    // Necrotic Blood / Mosquito Storm generation
    const hasNecroticBlood = actor.items.find(i => i.getFlag("necromancer-thrall-helper", "isNecroticBlood") || i.name === "Necrotic Blood");
    let stormMasterId = null;

    if (!hasNecroticBlood && canvas.scene) {
        for (const storm of canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "stormRegionId"))) {
            const s = storm.shapes?.[0];
            if (s && Math.hypot(deadToken.center.x - s.x, deadToken.center.y - s.y) <= s.radiusX) {
                stormMasterId = game.actors.find(a => a.items.some(i => i.name === "Dread Mosquito Storm"))?.id;
                break;
            }
        }
    }

    const plagueMasterId = hasNecroticBlood ? hasNecroticBlood.getFlag("necromancer-thrall-helper", "masterId") : stormMasterId;
    const plagueMaster = game.actors.get(plagueMasterId);

    if (plagueMaster) {
        if (hasNecroticBlood) await hasNecroticBlood.delete();
        const size = actor.system?.traits?.size?.value || "med";
        const sizeLabel = { sm: "Small", lg: "Large", huge: "Huge", grg: "Gargantuan" }[size] || "Medium";
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: plagueMaster }),
            flavor: `<strong>Necrotic Blood Trigger!</strong>`,
            content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #880000;"><p style="margin: 0 0 4px 0;"><b>${actor.name}</b> has succumbed to the necrotic plague!</p><p style="margin: 0; font-size: 0.9em;">The infected blood congeals into a new thrall.</p><div style="text-align: center; margin-top: 8px;"><button type="button" class="inevitable-return-btn" data-necro-id="${plagueMaster.id}" data-target-id="${deadToken.id}" data-size="${size}" style="background: #220033; color: #c084fc; border: 1px solid #7c3aed; padding: 5px 8px; border-radius: 4px; cursor: pointer;"><i class="fas fa-ghost"></i> Sprout Thrall (${sizeLabel})</button></div></div>`
        });
    }

    // Standard Death Reactions
    if (actor.system?.details?.alliance === "party") return;
    globalThis.NecroThrallHelper.lastDeathReaction = globalThis.NecroThrallHelper.lastDeathReaction || 0;
    if (Date.now() - globalThis.NecroThrallHelper.lastDeathReaction < 5000) return;

    const traits = Array.from(actor.system?.traits?.value || []);
    const size = actor.system?.traits?.size?.value || actor.size || "med";
    const isValidSize = size === "sm" || size === "med";
    const isUndead = traits.some(t => typeof t === "string" && t.toLowerCase() === "undead");
    const hasBlood = !traits.includes("construct") && !traits.includes("elemental") && (!isUndead || actor.items.some(i => i.name === "Infused Blood" || i.slug === "infused-blood"));

    const necromancers = canvas.tokens.placeables.filter(t => t.actor && t.actor.items.some(i => i.slug === "inevitable-return" || i.name === "Inevitable Return" || i.slug === "blood-pool" || i.name === "Blood Pool"));

    for (const necro of necromancers) {
        if (getTokenDistance(necro, deadToken) > 30) continue;

        const nActor = necro.actor;
        const canReturn = isValidSize && nActor.items.some(i => i.slug === "inevitable-return" || i.name === "Inevitable Return");
        const canBlood = hasBlood && nActor.items.some(i => i.slug === "blood-pool" || i.name === "Blood Pool");
        if (!canReturn && !canBlood) continue;

        let btns = `<div class="death-reaction-actions" style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-top: 8px;">`;
        if (canReturn) btns += `<button type="button" class="inevitable-return-btn" data-necro-id="${nActor.id}" data-target-id="${deadToken.id}" data-size="${size}" style="background: #220033; color: #c084fc; border: 1px solid #7c3aed; padding: 5px 8px; border-radius: 4px; cursor: pointer; flex: 1; min-width: 130px;"><i class="fas fa-skull"></i> Claim Corpse (${size === "sm" ? "Small" : "Medium"})</button>`;
        if (canBlood) btns += `<button type="button" class="blood-pool-spawn-btn" data-necro-id="${nActor.id}" data-target-id="${deadToken.id}" style="background: #3a0000; color: #f87171; border: 1px solid #b91c1c; padding: 5px 8px; border-radius: 4px; cursor: pointer; flex: 1; min-width: 130px;"><i class="fas fa-tint"></i> Blood Pool (${nActor.level || 1} HP)</button>`;
        btns += `</div>`;

        globalThis.NecroThrallHelper.lastDeathReaction = Date.now();
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: nActor }),
            flavor: `<strong>Death Reaction Triggered!</strong>`,
            content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #a855f7;"><p style="margin: 0 0 4px 0;"><b>${deadToken.name}</b> has fallen within 30 feet of <b>${necro.name}</b>.</p><p style="margin: 0; font-size: 0.9em; color: #ccc;">Choose a reaction to harvest the death:</p>${btns}</div>`
        });
    }
});

Hooks.on("necroHelperDamageApplied", async (actor, options) => {
    if (!game.user.isGM) return;

    globalThis.NecroThrallHelper.lastBleedReaction = globalThis.NecroThrallHelper.lastBleedReaction || 0;
    if (Date.now() - globalThis.NecroThrallHelper.lastBleedReaction < 5000) return;

    let isBleed = false;
    if (options.damage?.instances && Array.isArray(options.damage.instances)) {
        if (options.damage.instances.some(i => i.type === "bleed")) isBleed = true;
    }
    if (options.rollOptions && typeof options.rollOptions.has === "function") {
        if (options.rollOptions.has("damage:type:bleed")) isBleed = true;
    }
    if (options.item?.system?.traits?.value?.includes("bleed")) isBleed = true;
    if (!isBleed) return;

    const targetToken = options.token?.object || actor.getActiveTokens()[0];
    if (!targetToken?.actor) return;

    const traits = targetToken.actor.system?.traits?.value || [];
    const hasNoBlood = traits.includes("construct") || traits.includes("elemental") || (traits.includes("undead") && !targetToken.actor.items.some(i => i.name === "Infused Blood"));
    if (hasNoBlood) return;

    const necros = canvas.tokens.placeables.filter(t => t.actor?.items.some(i => i.name === "Blood Pool" || i.slug === "blood-pool"));
    for (const necroToken of necros) {
        if (getTokenDistance(necroToken, targetToken) <= 30) {
            const necroLevel = necroToken.actor.level || 1;
            globalThis.NecroThrallHelper.lastBleedReaction = Date.now();
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: necroToken.actor }),
                flavor: `<strong>Blood Pool Reaction Trigger!</strong>`,
                content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #b91c1c;"><p style="margin: 0 0 5px 0;"><b>${targetToken.name}</b> takes bleed damage within 30 feet of <b>${necroToken.name}</b>.</p><p style="margin: 0 0 8px 0; font-size: 0.95em;">Pool their spilled lifeblood to grant <b>${necroLevel} HP</b> to an ally?</p><div class="death-reaction-actions" style="text-align: center;"><button type="button" class="blood-pool-spawn-btn" data-is-bleed="true" data-necro-id="${necroToken.actor.id}" data-target-id="${targetToken.id}" style="background: #3a0000; color: #f87171; border: 1px solid #b91c1c; padding: 4px 8px; border-radius: 4px; cursor: pointer;"><i class="fas fa-tint"></i> Create Blood Pool</button></div></div>`
            });
        }
    }
});

function fixVideoImages($html) {
    $html.find("img").each((_i, img) => {
        const src = img.getAttribute("src");
        if (!isVideoPath(src)) return;
        const tokenId = img.closest("[data-token-id]")?.getAttribute("data-token-id");
        const name = img.getAttribute("alt") || img.getAttribute("title");
        const tokenDoc = (tokenId && canvas.scene?.tokens?.get(tokenId))
            || (name && canvas.scene?.tokens?.find(t => t.name === name))
            || null;
        const still = tokenDoc ? tokenPortrait(tokenDoc) : null;
        if (still && !isVideoPath(still)) {
            img.setAttribute("src", still);
            return;
        }
        const video = document.createElement("video");
        video.src = src;
        video.autoplay = video.muted = video.loop = video.playsInline = true;
        video.className = img.className;
        video.style.cssText = img.style.cssText;
        for (const attr of ["width", "height", "title"]) if (img.hasAttribute(attr)) video.setAttribute(attr, img.getAttribute(attr));
        img.replaceWith(video);
    });
}

Hooks.on("renderChatMessageHTML", (message, html) => {
    const $html = html instanceof jQuery ? html : $(html);
    const aoeFlags = message.flags?.["aoe-easy-resolve"] || {};
    const itemName = aoeFlags.itemName || message.flavor || "";
    const msgContent = message.content || "";
    if (Object.keys(aoeFlags).length || msgContent.includes("aer-") || msgContent.includes("Resolution Summary")) fixVideoImages($html);
    const reactionUsed = message.getFlag("necromancer-thrall-helper", "reactionUsed");
    const isResolution = msgContent.includes("Resolution Summary") || aoeFlags.isResolution;

    if (itemName === "Thick Skin" || itemName === "Recurring Nightmare") {
        $html.find(".roll-damage-btn").remove();
    }

    if (reactionUsed) {
        const labelColor = reactionUsed === "Inevitable Return" ? "#c084fc" : "#f87171";
        $html.find(".death-reaction-actions").html(`
            <div style="background: rgba(0,0,0,0.5); border: 1px solid #444; border-radius: 4px; padding: 6px; text-align: center; margin-top: 4px;">
                <span style="text-decoration: line-through; color: #666; font-weight: bold; font-size: 0.9em; display: block;"><i class="fas fa-ban"></i> Death Reaction</span>
                <span style="display: block; color: ${labelColor}; font-size: 0.85em; font-style: italic; margin-top: 2px;">Expended: ${reactionUsed}</span>
            </div>
        `);
    } else {
        $html.find(".death-reaction-actions").each(function () {
            const $container = $(this);
            const $btn = $container.find(".blood-pool-spawn-btn, .inevitable-return-btn").first();
            if ($btn.length > 0) {
                const isBleed = $btn.attr("data-is-bleed") === "true";
                const necroActor = game.actors.get($btn.attr("data-necro-id"));
                if (!isBleed && necroActor?.getFlag("necromancer-thrall-helper", `harvested_${$btn.attr("data-target-id")}`)) {
                    $container.html(`
                        <div style="background: rgba(0,0,0,0.5); border: 1px solid #444; border-radius: 4px; padding: 6px; text-align: center; margin-top: 4px;">
                            <span style="text-decoration: line-through; color: #666; font-weight: bold; font-size: 0.9em; display: block;"><i class="fas fa-ban"></i> Death Reaction</span>
                            <span style="display: block; color: #999; font-size: 0.85em; font-style: italic; margin-top: 2px;">Corpse Already Harvested</span>
                        </div>
                    `);
                }
            }
        });
    }

    const pf2eContext = message.flags?.pf2e?.context;
    const attackerToken = canvas?.tokens?.get(message.speaker?.token);
    const attackerActor = attackerToken?.actor || game.actors.get(message.speaker?.actor);

    if (pf2eContext?.type === "attack-roll" && pf2eContext?.outcome === "criticalSuccess" && attackerActor?.items.some(i => i.name === "Effect: Bind Heroic Spirit") && $html.find(".heroic-spawn-btn").length === 0) {
        $html.find(".message-content").append(`<button type="button" class="heroic-spawn-btn" data-target-id="${pf2eContext.target?.token || ""}" style="background: #4a3600; color: #ffcc00; font-weight: bold; border: 1px solid #ffcc00; margin-top: 5px;"><i class="fas fa-ghost"></i> Inspire Heroic Thrall</button>`);
    }

    const isPerfectedAttacker = attackerToken?.document?.getFlag("necromancer-thrall-helper", "isPerfectedThrall") || (message.speaker?.alias || "").includes("Perfected");
    if (isPerfectedAttacker && $html.find(".perfected-spawn-btn").length === 0) {
        const masterId = attackerToken?.document?.getFlag("necromancer-thrall-helper", "masterId") || attackerActor?.getFlag("necromancer-thrall-helper", "masterId") || game.user.character?.id || "";
        $html.find(".message-content").append(`<button type="button" class="perfected-spawn-btn" data-master-id="${masterId}" style="background: #3b0764; color: #d8b4fe; font-weight: bold; border: 1px solid #7e22ce; margin-top: 5px;"><i class="fas fa-ghost"></i> Sprout 4 Thralls</button>`);
    }

    let casterId = message.speaker?.actor;
    const aoeItemUuid = aoeFlags.itemUuid || aoeFlags.originItemUuid;
    if (!casterId && aoeItemUuid?.includes("Actor.")) {
        const parts = aoeItemUuid.split(".");
        const actorIdx = parts.indexOf("Actor");
        if (actorIdx !== -1) casterId = parts[actorIdx + 1];
    }
    if (!casterId && canvas?.tokens?.controlled?.length > 0) casterId = canvas.tokens.controlled[0].actor?.id;
    const hasPermission = game.user.isGM || message.isAuthor || (casterId ? game.actors.get(casterId)?.isOwner : false);

    const isErasCard = (itemName.includes("Necrotic Bomb") || itemName.includes("Necrotic Blast") || msgContent.includes("Necrotic Bomb") || msgContent.includes("Necrotic Blast")) && !isResolution;
    if (isErasCard || itemName.includes("Desperate Revival") || itemName.includes("Dread Mosquito") || msgContent.includes("Desperate Revival") || msgContent.includes("Dread Mosquito")) {
        if ($html.find("#necro-bomb-style").length === 0) {
            $html.prepend(`<style id="necro-bomb-style">.necro-type-toggle { display: inline-flex; align-items: center; margin-left: 5px; vertical-align: middle; } .necro-type-toggle button { margin: 0; padding: 2px 6px; font-size: 0.7em; line-height: 1; border: 1px solid #444; background: #222; color: #999; } .necro-type-toggle button.active.void-opt { background: #660066; color: #fff; border-color: #990099; } .necro-type-toggle button.active.vit-opt { background: #b58900; color: #fff; border-color: #e5a900; } .void-opt { border-radius: 3px 0 0 3px; } .vit-opt { border-radius: 0 3px 3px 0; } .no-save-badge { font-weight: bold; color: #4ade80; font-size: 0.75em; margin-left: 5px; white-space: nowrap; }</style>`);
        }
    }

    const isHarmCard = (itemName.includes("Harm") || msgContent.includes("Harm")) && !isResolution;
    if (isHarmCard && casterId) {
        const actor = game.actors.get(casterId);
        if (actor) {
            const hasMastery = actor.items.some(i => i.name === "Mastery of Life and Death" || i.slug === "mastery-of-life-and-death");
            const hasInvert = actor.items.some(i => i.name === "Invert Harm" || i.slug === "invert-harm");
            if ((hasMastery || hasInvert) && $html.find("#harm-toggle-style").length === 0) {
                $html.prepend(`<style id="harm-toggle-style">.harm-type-toggle { display: inline-flex; align-items: center; margin-left: 5px; vertical-align: middle; } .harm-type-toggle button { margin: 0; padding: 2px 6px; font-size: 0.7em; line-height: 1; border: 1px solid #444; background: #222; color: #999; } .harm-type-toggle button.active.harm-void-opt { background: #660066; color: #fff; border-color: #990099; } .harm-type-toggle button.active.harm-vit-opt { background: #b58900; color: #fff; border-color: #e5a900; } .harm-type-toggle button.active.harm-heal-opt { background: #4ade80; color: #000; border-color: #22c55e; } .harm-void-opt { border-radius: 3px 0 0 3px; } .harm-vit-opt { border-radius: ${hasInvert ? "0" : "0 3px 3px 0"}; } .harm-heal-opt { border-radius: 0 3px 3px 0; } .aoe-heal-badge { font-weight: bold; color: #4ade80; font-size: 0.75em; margin-left: 5px; white-space: nowrap; }</style>`);
            }
        }
    }

    const isBarrageCard = (itemName.includes("Bony Barrage") || msgContent.includes("Bony Barrage")) && !isResolution;
    if (isBarrageCard) {
        const hasArmor = message.getFlag("necromancer-thrall-helper", "boneArmorActivated");
        const sacrificedId = message.getFlag("necromancer-thrall-helper", "sacrificedThrallId");
        if (hasArmor) {
            $html.find("[data-token-id]").each((_i, el) => {
                const $row = $(el);
                const tokenId = $row.attr("data-token-id");
                if (tokenId === sacrificedId) return $row.remove();
                const targetToken = canvas?.tokens?.get(tokenId);
                if (!targetToken?.actor) return;
                if (targetToken.actor.system?.details?.alliance === "party" || targetToken.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY || targetToken.actor.id === casterId || targetToken.document.getFlag("necromancer-thrall-helper", "masterId") === casterId) {
                    $row.find(".save-btn-container, .roll-save-btn").hide();
                    if ($row.find(".bone-armor-badge").length === 0) $row.find(".token-name").after(' <span class="bone-armor-badge" style="color: #4ade80; font-size: 0.8em; font-weight: bold; margin-left: 5px;">[Bone Armor]</span>');
                }
            });
            if ($html.find(".bone-armor-active-badge").length === 0) {
                const badgeHtml = `<div class="bone-armor-active-badge" style="text-align: center; color: #4ade80; font-weight: bold; margin-top: 5px; margin-bottom: 5px; padding: 4px; background: rgba(0,0,0,0.4); border-radius: 4px;"><i class="fas fa-shield-alt"></i> Bone Armor Active</div>`;
                const targetContainer = $html.find(".card-buttons").last();
                if (targetContainer.length > 0) targetContainer.after(badgeHtml); else $html.append(badgeHtml);
                $html.find(".bone-armor-btn").remove();
            }
        } else if (hasPermission && $html.find(".bone-armor-btn").length === 0) {
            const btnHtml = `<button type="button" class="bone-armor-btn" style="margin-top: 5px; margin-bottom: 5px; background: #2c1a3b; color: #fff; border: 1px solid #9900ff;"><i class="fas fa-shield-alt"></i> Consume Thrall for Bone Armor</button>`;
            const targetContainer = $html.find(".card-buttons").last();
            if (targetContainer.length > 0) targetContainer.after(btnHtml); else $html.append(btnHtml);
        }
    }

    const isTsunamiCard = (itemName.includes("Flesh Tsunami") || msgContent.includes("Flesh Tsunami")) && !isResolution;
    if (isTsunamiCard) {
        const hasLimbs = message.getFlag("necromancer-thrall-helper", "limbsActivated");
        const sacrificedId = message.getFlag("necromancer-thrall-helper", "sacrificedThrallId");
        $html.find(".roll-all-npcs-btn, .apply-damage-btn").css("cssText", hasLimbs ? "display: flex !important;" : "display: none !important;");
        if (hasLimbs) {
            $html.find("[data-token-id]").each((_i, el) => { if ($(el).attr("data-token-id") === sacrificedId) $(el).remove(); });
            if ($html.find(".tsunami-active-badge").length === 0) {
                const badgeHtml = `<div class="tsunami-active-badge" style="text-align: center; color: #ef4444; font-weight: bold; margin-top: 5px; margin-bottom: 5px; padding: 4px; background: rgba(0,0,0,0.4); border-radius: 4px;"><i class="fas fa-hands-helping"></i> Grasping Limbs Active (Escape DC ${aoeFlags.saveDC || 10})</div>`;
                const targetContainer = $html.find(".card-buttons").last();
                if (targetContainer.length > 0) targetContainer.after(badgeHtml); else $html.append(badgeHtml);
                $html.find(".tsunami-limb-btn").remove();
            }
        } else if (hasPermission && $html.find(".tsunami-limb-btn").length === 0) {
            const btnHtml = `<button type="button" class="tsunami-limb-btn" style="margin-top: 5px; margin-bottom: 5px; width: 100%; background: #3a0000; color: #fff; border: 1px solid #ef4444; padding: 5px; font-weight: bold;"><i class="fas fa-hand-holding-water"></i> Sacrifice Thrall for Grasping Limbs</button>`;
            const targetContainer = $html.find(".card-buttons").last();
            if (targetContainer.length > 0) targetContainer.before(btnHtml); else $html.append(btnHtml);
        }
    }

    const customBtns = ".inevitable-return-btn, .flesh-terrain-btn, .blood-pool-spawn-btn, .gore-spawn-btn, .desperate-revival-trigger-btn, .heroic-spawn-btn, .perfected-spawn-btn, .tsunami-limb-btn, .bone-armor-btn, .type-btn, .necro-type-btn, .harm-type-btn";
    $html.off("click", customBtns).on("click", customBtns, async (e) => {
        const $btn = $(e.currentTarget);

        if ($btn.is(".type-btn, .necro-type-btn")) {
            e.preventDefault(); e.stopPropagation();
            if (!hasPermission) return;
            const type = $btn.attr("data-type");
            const tokenId = $btn.closest(".necro-custom-controls").attr("data-token-id") || $btn.closest(".necro-type-toggle").attr("data-token-id");
            if (!tokenId) return;
            await message.setFlag("necromancer-thrall-helper", `dmgType_${tokenId}`, type);
            return;
        }

        if ($btn.hasClass("harm-type-btn")) {
            e.preventDefault(); e.stopPropagation();
            if (!hasPermission) return;
            const type = $btn.attr("data-type");
            const tokenId = $btn.closest(".necro-custom-controls").attr("data-token-id") || $btn.closest(".harm-type-toggle").attr("data-token-id");
            if (!tokenId) return;

            const token = canvas.tokens.get(tokenId);
            const negHeal = token?.actor?.system?.attributes?.hp?.negativeHealing || false;
            const isHealingTarget = (type === "void" && negHeal) || (type === "vit" && !negHeal) || type === "heal";

            await message.update({
                [`flags.necromancer-thrall-helper.harmState_${tokenId}`]: type,
                [`flags.aoe-easy-resolve.targets.${tokenId}.isHealing`]: isHealingTarget,
                [`flags.aoe-easy-resolve.targets.${tokenId}.isImmune`]: false
            });

            const aoeApi = game.modules.get("aoe-easy-resolve")?.api;
            if (aoeApi?.refreshCard) setTimeout(() => aoeApi.refreshCard(message.id), 50);
            return;
        }

        if ($btn.hasClass("inevitable-return-btn")) {
            e.preventDefault();
            const necroActorId = $btn.attr("data-necro-id");
            const targetId = $btn.attr("data-target-id");
            const size = $btn.attr("data-size");
            const attacker = game.actors.get(necroActorId);
            const targetToken = canvas.tokens.get(targetId);
            if (!attacker || !targetToken) return notify("warn", "Could not locate the Necromancer or the corpse.");
            if (attacker.getFlag("necromancer-thrall-helper", `harvested_${targetId}`) || message.getFlag("necromancer-thrall-helper", "reactionUsed")) return notify("warn", "This corpse has already been harvested.");
            const presets = typeof getThrallPresets === "function" ? getThrallPresets(attacker) : [];
            if (presets.length === 0) return notify("warn", "No thrall presets found.");
            let optionsHtml = `<option value="default">${defaultThrallLabel(attacker)}</option><option value="random">(Random Family Member)</option>`;
            presets.forEach(p => {
                optionsHtml += (p.isUnique && canvas?.scene?.tokens?.some(t => t.getFlag("necromancer-thrall-helper", "masterId") === attacker.id && t.name === p.name))
                    ? `<option value="${p.id}" disabled>${p.name} (Already Active)</option>`
                    : `<option value="${p.id}">${p.name}</option>`;
            });
            const presetChoice = await foundry.applications.api.DialogV2.wait({
                window: { title: "Inevitable Return", icon: "fas fa-skull" },
                content: `<p>Select the identity for the new <b>${size === "sm" ? "Small" : "Medium"}</b> thrall rising from <b>${targetToken.name}</b>:</p><div class="form-group"><label>Thrall Identity:</label><div class="form-fields"><select id="inevitable-preset">${optionsHtml}</select></div></div>`,
                rejectClose: false,
                buttons: [
                    { action: "rise", label: "Rise", icon: "fas fa-ghost", default: true, callback: (_event, _button, dialog) => dialog.element.querySelector("#inevitable-preset").value },
                    { action: "cancel", label: "Cancel", icon: "fas fa-times" }
                ]
            });
            if (!presetChoice || presetChoice === "cancel") return;
            await attacker.setFlag("necromancer-thrall-helper", `harvested_${targetId}`, true);
            if (game.user.isGM) await message.setFlag("necromancer-thrall-helper", "reactionUsed", "Inevitable Return");
            else {
                game.socket.emit("module.necromancer-thrall-helper", { action: "lockDeathReaction", messageId: message.id, label: "Inevitable Return" });
                $btn.closest(".death-reaction-actions").html(`<div style="background: rgba(0,0,0,0.5); border: 1px solid #444; border-radius: 4px; padding: 6px; text-align: center; margin-top: 4px;"><span style="text-decoration: line-through; color: #666; font-weight: bold; font-size: 0.9em; display: block;"><i class="fas fa-ban"></i> Death Reaction</span><span style="display: block; color: #c084fc; font-size: 0.85em; font-style: italic; margin-top: 2px;">Expended: Inevitable Return</span></div>`);
            }
            const basePayload = await prepareThrallPayload(attacker, presetChoice);
            if (!basePayload) return;
            executeSpawn(foundry.utils.mergeObject(basePayload, { x: targetToken.x, y: targetToken.y, elevation: targetToken.document?.elevation || 0, delta: { ownership: { [game.user.id]: 3 }, system: { traits: { size: { value: size } } } } }), canvas.scene.id, { corpse: { tokenId: targetToken.id, sceneId: canvas.scene.id, name: targetToken.name } }).catch(() => notify("error", "Failed to materialize the corpse thrall."));
            notify("info", "The corpse yields its thrall.");
        }

        else if ($btn.hasClass("flesh-terrain-btn")) {
            e.preventDefault();
            const tX = parseFloat($btn.attr("data-x")), tY = parseFloat($btn.attr("data-y")), tW = parseFloat($btn.attr("data-w")), tH = parseFloat($btn.attr("data-h")), masterActor = game.actors.get($btn.attr("data-master"));
            if (!canvas.scene || !masterActor) return;
            const gridSize = canvas.scene.grid.size, hazardId = foundry.utils.randomID();
            const hazardResult = await executeHazard({ name: "Gory Remains", color: "#4b5563", shapes: [{ type: "rectangle", hole: false, x: tX, y: tY, width: tW * gridSize, height: tH * gridSize, rotation: 0 }], elevation: { bottom: -1000, top: 1000 }, behaviors: [{ name: "Gory Difficult Terrain", type: "modifyMovementCost", system: {} }], flags: { "necromancer-thrall-helper": { isFleshTerrain: true, hazardId } } }, { author: game.user.id, shape: { type: "r", width: tW * gridSize, height: tH * gridSize }, x: tX, y: tY, hidden: true, flags: { "necromancer-thrall-helper": { hazardId } } });
            if (!hazardResult?.regionId) return notify("error", "Failed to place Gory Remains. Check GM socket.");
            await masterActor.createEmbeddedDocuments("Item", [{ name: "Hazard: Gory Remains", type: "effect", img: "icons/magic/symbols/runes-star-orange.webp", system: { description: { value: "Tracks the duration of a Gory Remains difficult terrain hazard. Deleting this will clear the hazard from the map." }, duration: { value: 10, unit: "minutes", expiry: "turn-start" } }, flags: { "necromancer-thrall-helper": { isHazardTracker: true, hazardId, sceneId: canvas.scene.id } } }]);
            $btn.closest("div").html(`<p style="margin: 4px 0 0 0; text-align: center; color: #9ca3af; font-style: italic; font-size: 0.9em;"><i class="fas fa-check"></i> Gory Remains Placed</p>`);
        }

        else if ($btn.hasClass("blood-pool-spawn-btn")) {
            e.preventDefault();
            const isBleed = $btn.attr("data-is-bleed") === "true", targetId = $btn.attr("data-target-id"), necroActor = game.actors.get($btn.attr("data-necro-id")), targetToken = canvas.tokens.get(targetId);
            if (!necroActor || !targetToken || !canvas.scene) return;
            if (message.getFlag("necromancer-thrall-helper", "reactionUsed")) return notify("warn", "This reaction has already been used.");
            if (!isBleed && necroActor.getFlag("necromancer-thrall-helper", `harvested_${targetId}`)) return notify("warn", "This corpse has already been harvested.");

            placementHint(`Click the canvas adjacent to ${targetToken.name} to place the Blood Pool. Right-click to cancel.`);
            document.body.style.cursor = "crosshair"; canvas.app.view.style.cursor = "crosshair";

            const gridSize = canvas.scene.grid.size;
            const ghost = new PIXI.Graphics();
            ghost.beginFill(effectColorNum(necroActor, "bloodPool", "#990000"), 0.4);
            ghost.lineStyle(2, effectColorNum(necroActor, "bloodPool", "#ff0000"), 0.8);
            ghost.drawRect(0, 0, gridSize, gridSize);
            ghost.endFill();
            ghost.zIndex = 1000; ghost.position.set(-1000, -1000); canvas.tokens.addChild(ghost);

            const updateGhost = (ev) => { const pos = ev.data.getLocalPosition(canvas.app.stage); const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos; ghost.position.set(snapped.x, snapped.y); };
            canvas.stage.on("pointermove", updateGhost);

            const cleanUp = () => { document.body.style.cursor = ""; canvas.app.view.style.cursor = ""; canvas.stage.off("pointermove", updateGhost); ghost.destroy(); };

            const interactionHandler = async (ev) => {
                if (ev.data.button !== 0 && ev.data.button !== 2) return canvas.stage.once("pointerdown", interactionHandler);
                if (ev.data.button === 2) { notify("info", "Blood Pool placement cancelled."); return cleanUp(); }

                const pos = ev.data.getLocalPosition(canvas.app.stage), snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                const dist = (Math.max(Math.abs((targetToken.x + (targetToken.document.width * gridSize) / 2) - (snapped.x + (gridSize / 2))), Math.abs((targetToken.y + (targetToken.document.height * gridSize) / 2) - (snapped.y + (gridSize / 2)))) / gridSize) * (canvas.scene?.grid?.distance || 5);
                if (dist > 15) { notify("warn", "The Blood Pool must be placed adjacent to the corpse!"); return canvas.stage.once("pointerdown", interactionHandler); }

                cleanUp();
                if (!isBleed) await necroActor.setFlag("necromancer-thrall-helper", `harvested_${targetId}`, true);
                if (game.user.isGM) await message.setFlag("necromancer-thrall-helper", "reactionUsed", "Blood Pool");
                else {
                    game.socket.emit("module.necromancer-thrall-helper", { action: "lockDeathReaction", messageId: message.id, label: "Blood Pool" });
                    $btn.closest(".death-reaction-actions").html(`<div style="background: rgba(0,0,0,0.5); border: 1px solid #444; border-radius: 4px; padding: 6px; text-align: center; margin-top: 4px;"><span style="text-decoration: line-through; color: #666; font-weight: bold; font-size: 0.9em; display: block;"><i class="fas fa-ban"></i> Death Reaction</span><span style="display: block; color: #f87171; font-size: 0.85em; font-style: italic; margin-top: 2px;">Expended: Blood Pool</span></div>`);
                }

                const poolId = foundry.utils.randomID();
                const regionData = { name: `Blood Pool (${necroActor.name})`, color: effectColor(necroActor, "bloodPool", "#990000"), shapes: [{ type: "rectangle", hole: false, x: snapped.x, y: snapped.y, width: gridSize, height: gridSize, rotation: 0 }], elevation: { bottom: -1000, top: 1000 }, behaviors: [{ name: "Blood Pool Absorption", type: "executeScript", system: { events: ["tokenEnter", "tokenTurnStart"], source: `if (event.data.token?.actor) globalThis.NecroThrallHelper?.handleBloodPoolTrigger(event.region, event.data.token);` } }], flags: { "necromancer-thrall-helper": { isBloodPool: true, poolId, masterId: necroActor.id, healValue: necroActor.level || 1 } } };
                const drawingData = { author: game.user.id, shape: { type: "e", width: gridSize, height: gridSize }, x: snapped.x, y: snapped.y, fillType: 1, fillColor: "#880000", fillAlpha: 0.5, strokeWidth: 2, strokeColor: "#ff0000", strokeAlpha: 0.8, text: "🩸 Blood Pool", fontSize: 16, textColor: "#ffffff", flags: { "necromancer-thrall-helper": { poolId } } };
                const hazardResult = await executeHazard(regionData, drawingData);

                setTimeout(async () => {
                    if (game.user.isGM) {
                        if (hazardResult?.regionId) await canvas.scene?.regions.get(hazardResult.regionId)?.delete();
                        const dIds = canvas.scene?.drawings.filter(d => d.getFlag("necromancer-thrall-helper", "poolId") === poolId).map(d => d.id) || [];
                        if (dIds.length) await canvas.scene?.deleteEmbeddedDocuments("Drawing", dIds);
                    } else {
                        game.socket.emit("module.necromancer-thrall-helper", { action: "deleteBloodPool", sceneId: canvas.scene?.id, regionId: hazardResult?.regionId, poolId });
                    }
                }, 60000);

                notify("info", "Blood Pool materialized on the battlefield.");
            };
            canvas.stage.once("pointerdown", interactionHandler);
        }

        else if ($btn.hasClass("gore-spawn-btn")) {
            e.preventDefault();
            const count = parseInt($btn.attr("data-count"), 10), targetToken = canvas.tokens.get($btn.attr("data-target-id")), attacker = game.user.character || canvas.tokens.controlled[0]?.actor;
            if (!attacker) return notify("warn", "No Necromancer found to command the thralls!");
            const presets = typeof getThrallPresets === "function" ? getThrallPresets(attacker) : [];
            if (presets.length === 0) return notify("warn", "No thrall presets found.");
            let optionsHtml = `<option value="default">${defaultThrallLabel(attacker)}</option><option value="random">(Random Family Member)</option>`;
            presets.forEach(p => { optionsHtml += (p.isUnique && canvas?.scene?.tokens?.some(t => t.getFlag("necromancer-thrall-helper", "masterId") === attacker.id && t.name === p.name)) ? `<option value="${p.id}" disabled>${p.name} (Already Active)</option>` : `<option value="${p.id}">${p.name}</option>`; });
            let formHtml = `<form><p>Select the identities for the <b>${count}</b> new thrall(s) spawned near <b>${targetToken ? targetToken.name : "the field"}</b>:</p>`;
            for (let i = 0; i < count; i++) formHtml += `<div class="form-group"><label>Thrall ${i + 1}:</label><div class="form-fields"><select id="gore-preset-${i}">${optionsHtml}</select></div></div>`;
            new Dialog({
                title: "Blood-Born Thralls", content: formHtml + `</form>`,
                buttons: {
                    summon: {
                        icon: '<i class="fas fa-ghost"></i>', label: "Sprout",
                        callback: async (dialogHtml) => {
                            const selections = [], selectedUnique = new Set();
                            for (let i = 0; i < count; i++) {
                                const val = dialogHtml[0].querySelector(`#gore-preset-${i}`).value, preset = presets.find(p => p.id === val);
                                if (preset?.isUnique) { if (selectedUnique.has(val)) return notify("error", `${preset.name} is unique and cannot be summoned multiple times.`); selectedUnique.add(val); }
                                selections.push(val);
                            }
                            const batch = createSpawnBatch();
                            let currentSpawnIndex = 0;
                            placementHint(`Click the canvas to sprout Thrall 1 adjacent to the field. Right-click or Esc undoes the last one; Enter sends early.`);
                            document.body.style.cursor = "crosshair"; canvas.app.view.style.cursor = "crosshair";
                            const ghost = new PIXI.Graphics(); ghost.beginFill(0xcc0000, 0.4); ghost.lineStyle(2, 0xff0000, 0.8); ghost.drawRect(0, 0, canvas.grid.size, canvas.grid.size); ghost.endFill(); ghost.zIndex = 1000; ghost.position.set(-1000, -1000); canvas.tokens.addChild(ghost);
                            const updateGhost = (ev) => { const pos = ev.data.getLocalPosition(canvas.app.stage); const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos; ghost.position.set(snapped.x, snapped.y); };
                            canvas.stage.on("pointermove", updateGhost);
                            const cleanUp = () => { document.body.style.cursor = ""; canvas.app.view.style.cursor = ""; canvas.stage.off("pointermove", updateGhost); ghost.destroy(); };
                            const interactionHandler = async (ev) => {
                                if (ev.data.button !== 0 && ev.data.button !== 2) return canvas.stage.once("pointerdown", interactionHandler);
                                if (ev.data.button === 2) {
                                    if (batch.undo()) { currentSpawnIndex--; placementHint(`Place Thrall ${currentSpawnIndex + 1}.`); return canvas.stage.once("pointerdown", interactionHandler); }
                                    batch.cancel(); notify("info", "Sprouting cancelled."); return cleanUp();
                                }
                                const pos = ev.data.getLocalPosition(canvas.app.stage), snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                                const basePayload = await prepareThrallPayload(attacker, selections[currentSpawnIndex]);
                                if (!basePayload) { batch.finish(); return cleanUp(); }
                                batch.add(foundry.utils.mergeObject(basePayload, { x: snapped.x, y: snapped.y, elevation: targetToken?.document?.elevation || attacker?.getActiveTokens()[0]?.document?.elevation || 0, delta: { ownership: { [game.user.id]: 3 } } }));
                                currentSpawnIndex++;
                                if (currentSpawnIndex < count) { placementHint(`Place Thrall ${currentSpawnIndex + 1}.`); canvas.stage.once("pointerdown", interactionHandler); }
                                else { cleanUp(); batch.finish(); $btn.remove(); notify("info", "All blood thralls sprouted."); }
                            };
                            batch.bindKeys({
                                onUndo: () => { currentSpawnIndex--; placementHint(`Place Thrall ${currentSpawnIndex + 1}.`); },
                                onCancel: () => { canvas.stage.off("pointerdown", interactionHandler); cleanUp(); },
                                onFinish: () => { canvas.stage.off("pointerdown", interactionHandler); cleanUp(); }
                            });
                            canvas.stage.once("pointerdown", interactionHandler);
                        }
                    },
                    cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                },
                default: "summon"
            }).render(true);
        }

        else if ($btn.hasClass("desperate-revival-trigger-btn")) {
            e.preventDefault();
            const necroActor = game.actors.get($btn.attr("data-necro-id")), necroToken = necroActor?.getActiveTokens()[0];
            if (!necroActor || !necroToken) return notify("warn", "Necromancer token not found on the canvas.");
            const preWounded = necroActor.getCondition?.("wounded")?.value || 0;
            await necroActor.update({ "system.attributes.hp.value": 1 });
            await necroActor.setFlag("necromancer-thrall-helper", "desperateRevivalUsed", true);
            await necroActor.getCondition?.("dying")?.delete(); await necroActor.getCondition?.("unconscious")?.delete();
            for (let i = 0; i < 20; i++) {
                const w = necroActor.getCondition?.("wounded");
                if ((w?.value || 0) > preWounded) { if (preWounded === 0) await w.delete(); else if (typeof necroActor.decreaseCondition === "function") await necroActor.decreaseCondition("wounded"); break; }
                await new Promise(r => setTimeout(r, 100));
            }
            const spellDC = getSpellDC(necroActor);
            const spellSys = { level: { value: 8 }, traits: { value: ["necromancer", "occult", "void", "healing", "uncommon"] }, tradition: { value: "occult" }, area: { type: "emanation", value: 60 }, defense: { save: { statistic: "fortitude", basic: false, dc: { value: spellDC } } } };
            let drSpell = necroActor.items.find(i => i.type === "spell" && i.name === "Desperate Revival");
            if (!drSpell) drSpell = (await necroActor.createEmbeddedDocuments("Item", [{ name: "Desperate Revival", type: "spell", img: "icons/magic/life/heart-shadow-red.webp", system: spellSys }]))[0];
            else await drSpell.update({ system: spellSys });
            window.aoeEasyResolveCache = { item: drSpell, name: "Desperate Revival", dc: spellDC, type: "fortitude", hazardDuration: null };
            await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{ t: "circle", user: game.user.id, distance: 60 + (((necroToken.document.width || 1) * (canvas.scene?.grid?.distance || 5)) / 2), direction: 0, x: necroToken.center.x, y: necroToken.center.y, fillColor: "#7f1d1d", borderColor: zoneBorderColor(necroActor), flags: { "necromancer-thrall-helper": { source: "desperate-revival" }, "aoe-easy-resolve": { useOverride: true, saveType: "fortitude", saveDC: spellDC, isAreaDamage: true, allyBaseEffect: "standard", enemyBaseEffect: "standard" } } }]);
            $btn.replaceWith(`<p style="margin: 0; color: #4ade80; font-weight: bold; text-align: center;"><i class="fas fa-check"></i> Desperate Revival Unleashed! (1 HP)</p>`);
        }

        else if ($btn.hasClass("heroic-spawn-btn")) {
            e.preventDefault();
            if (!game.user.isGM && !attackerToken?.isOwner) return;
            const targetToken = canvas.tokens.get($btn.attr("data-target-id")), presets = typeof getThrallPresets === "function" ? getThrallPresets(attackerActor) : [];
            let optionsHtml = `<option value="default">${defaultThrallLabel(attackerActor)}</option><option value="random">(Random Family Member)</option>`;
            presets.forEach(p => { optionsHtml += (p.isUnique && canvas?.scene?.tokens?.some(t => t.getFlag("necromancer-thrall-helper", "masterId") === attackerActor.id && t.name === p.name)) ? `<option value="${p.id}" disabled>${p.name} (Already Active)</option>` : `<option value="${p.id}">${p.name}</option>`; });
            new Dialog({
                title: "Inspire Heroic Thrall", content: `<p>Your critical strike calls a spirit to the battlefield!</p><p>Select an identity to spawn adjacent to <b>${targetToken ? targetToken.name : "the target"}</b>:</p><form><div class="form-group"><select id="heroic-preset">${optionsHtml}</select></div></form>`,
                buttons: {
                    summon: {
                        icon: '<i class="fas fa-magic"></i>', label: "Inspire",
                        callback: async (dialogHtml) => {
                            placementHint(`Click the canvas adjacent to ${targetToken ? targetToken.name : "the target"} to place the thrall. Right-click to cancel.`);
                            document.body.style.cursor = "crosshair"; canvas.app.view.style.cursor = "crosshair";
                            const ghost = new PIXI.Graphics(); ghost.beginFill(0xffcc00, 0.3); ghost.lineStyle(2, 0xffcc00, 0.8); ghost.drawRect(0, 0, canvas.grid.size, canvas.grid.size); ghost.endFill(); ghost.zIndex = 1000; ghost.position.set(-1000, -1000); canvas.tokens.addChild(ghost);
                            const updateGhost = (ev) => { const pos = ev.data.getLocalPosition(canvas.app.stage); const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos; ghost.position.set(snapped.x, snapped.y); };
                            canvas.stage.on("pointermove", updateGhost);
                            const cleanUp = () => { document.body.style.cursor = ""; canvas.app.view.style.cursor = ""; canvas.stage.off("pointermove", updateGhost); ghost.destroy(); };
                            const interactionHandler = async (ev) => {
                                if (ev.data.button !== 0 && ev.data.button !== 2) return canvas.stage.once("pointerdown", interactionHandler);
                                if (ev.data.button === 2) { notify("info", "Inspiration cancelled."); return cleanUp(); }
                                const pos = ev.data.getLocalPosition(canvas.app.stage), snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                                if (targetToken) {
                                    const dist = (Math.max(Math.abs((targetToken.x + (targetToken.document.width * canvas.grid.size) / 2) - (snapped.x + (canvas.grid.size / 2))), Math.abs((targetToken.y + (targetToken.document.height * canvas.grid.size) / 2) - (snapped.y + (canvas.grid.size / 2)))) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                                    if (dist > 15) { notify("warn", "The inspired thrall must be placed adjacent to the target of the critical strike!"); return canvas.stage.once("pointerdown", interactionHandler); }
                                }
                                cleanUp();
                                const basePayload = await prepareThrallPayload(attackerActor, dialogHtml.find("#heroic-preset").val());
                                if (!basePayload) return;
                                executeSpawn(foundry.utils.mergeObject(basePayload, { actorLink: false, x: snapped.x, y: snapped.y, elevation: targetToken?.document?.elevation || attackerActor?.getActiveTokens()[0]?.document?.elevation || 0, delta: { ownership: buildOwnerMap(attackerActor) } })).catch(() => notify("error", "Failed to materialize the thrall."));
                            };
                            canvas.stage.once("pointerdown", interactionHandler);
                        }
                    },
                    cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                },
                default: "summon"
            }).render(true);
        }

        else if ($btn.hasClass("perfected-spawn-btn")) {
            e.preventDefault(); e.stopPropagation();
            const masterActor = game.actors.get($btn.attr("data-master-id")) || game.user.character || canvas.tokens.controlled[0]?.actor;
            if (!masterActor) return notify("warn", "Necromancer not found. Please select your character.");
            if (!game.user.isGM && !masterActor.isOwner) return notifyForce("warn", "You lack permission to command this Necromancer.");
            if (globalThis.NecroThrallHelper?.executeSheddingMatrix) globalThis.NecroThrallHelper.executeSheddingMatrix(masterActor, 4);
            else notify("warn", "Command Deck must be open to process rapid shedding.");
        }

        else if ($btn.hasClass("tsunami-limb-btn")) {
            e.preventDefault(); e.stopPropagation();
            const targetsData = message.flags?.["aoe-easy-resolve"]?.targets || {}, targetIds = Object.keys(targetsData);
            if (targetIds.length === 0) return notify("warn", "Please wait for the cone template to register targets in the chat card!");
            const availableThralls = targetIds.map(id => canvas.tokens.get(id)).filter(t => t?.document.getFlag("necromancer-thrall-helper", "masterId") === casterId);
            if (availableThralls.length === 0) return notify("warn", "No secondary thrall found inside the cone to sacrifice.");
            const consume = async (sacrificedThrall) => {
                if (!sacrificedThrall) return;
                await message.update({ "flags.necromancer-thrall-helper.limbsActivated": true, "flags.necromancer-thrall-helper.sacrificedThrallId": sacrificedThrall.id, [`flags.aoe-easy-resolve.targets.-=${sacrificedThrall.id}`]: null });
                await sacrificedThrall.document.delete();
                await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: game.actors.get(casterId) }), flavor: `<strong>Grasping Limbs Activated!</strong>`, content: `<p><b>${sacrificedThrall.name}</b> dissolves into the fleshy wave! Enemies in the cone must now succeed at a Fortitude save or become Immobilized.</p>` });
            };
            if (availableThralls.length === 1) consume(availableThralls[0]);
            else {
                new Dialog({
                    title: "Select Sacrifice", content: `<p>Multiple thralls detected in the wave. Which one is melted into grasping limbs?</p><form><div class="form-group"><label>Target:</label><select id="thrall-choice">${availableThralls.map(t => `<option value="${t.id}">${t.name}</option>`).join("")}</select></div></form>`,
                    buttons: { consume: { icon: '<i class="fas fa-hand-paper"></i>', label: "Melt", callback: d => consume(availableThralls.find(t => t.id === d[0].querySelector("#thrall-choice").value)) }, cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" } }, default: "consume"
                }).render(true);
            }
        }

        else if ($btn.hasClass("bone-armor-btn")) {
            e.preventDefault(); e.stopPropagation();
            const targetIds = Object.keys(message.flags?.["aoe-easy-resolve"]?.targets || {});
            if (targetIds.length === 0) return notify("warn", "Please wait for the cone template to register targets in the chat card!");
            const availableThralls = targetIds.map(id => canvas.tokens.get(id)).filter(t => t?.document.getFlag("necromancer-thrall-helper", "masterId") === casterId);
            if (availableThralls.length === 0) return notify("warn", "No secondary thrall found strictly inside the cone to sacrifice.");
            const consume = async (sacrificedThrall) => {
                if (!sacrificedThrall) return;
                const updates = { "flags.necromancer-thrall-helper.boneArmorActivated": true, "flags.necromancer-thrall-helper.sacrificedThrallId": sacrificedThrall.id, "flags.necromancer-thrall-helper.applyArmorEffects": true, [`flags.aoe-easy-resolve.targets.-=${sacrificedThrall.id}`]: null };
                targetIds.filter(id => id !== sacrificedThrall.id).forEach(id => {
                    const token = canvas.tokens.get(id);
                    if (token?.actor && (token.actor.system?.details?.alliance === "party" || token.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY || token.actor.id === casterId || token.document.getFlag("necromancer-thrall-helper", "masterId") === casterId)) updates[`flags.aoe-easy-resolve.targets.${id}.isImmune`] = true;
                });
                await message.update(updates);
                await sacrificedThrall.document.delete();
                await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: game.actors.get(casterId) }), flavor: `<strong>Bone Armor Activated!</strong>`, content: `<p><b>${sacrificedThrall.name}</b> is consumed by the barrage! Allies in the blast zone take no damage and gain a +1 status bonus to AC until the start of the caster's next turn.</p>` });
            };
            if (availableThralls.length === 1) consume(availableThralls[0]);
            else {
                new Dialog({
                    title: "Select Sacrifice", content: `<p>Multiple thralls detected in the blast zone. Which one is becoming armor?</p><form><div class="form-group"><label>Target:</label><select id="thrall-choice">${availableThralls.map(t => `<option value="${t.id}">${t.name}</option>`).join("")}</select></div></form>`,
                    buttons: { consume: { icon: '<i class="fas fa-shield-alt"></i>', label: "Consume", callback: d => consume(availableThralls.find(t => t.id === d[0].querySelector("#thrall-choice").value)) }, cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" } }, default: "consume"
                }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
            }
        }
    });
});

Hooks.on("aoeEasyResolve.renderRow", async (message, $row, tokenId) => {
    if ($row.prop("tagName") === "BUTTON") return;
    const aoeFlags = message.flags?.["aoe-easy-resolve"] || {};
    const itemName = aoeFlags.itemName || message.flavor || message.content || "";
    const isResolution = message.content?.includes("Resolution Summary") || aoeFlags.isResolution;
    if (isResolution) return;

    const isDesperateCard = itemName.includes("Desperate Revival");
    const isErasCard = itemName.includes("Necrotic Bomb") || itemName.includes("Necrotic Blast");
    const isHarmCard = itemName === "Harm" || itemName.includes("Harm");
    const isGrabCard = itemName === "Conglomerate Grab" || itemName.includes("Conglomerate Grab");
    const isTsunamiCard = itemName.includes("Flesh Tsunami");
    const isMosquitoCard = itemName.includes("Dread Mosquito");

    if (!isDesperateCard && !isErasCard && !isHarmCard && !isGrabCard && !isTsunamiCard && !isMosquitoCard) return;

    let casterId = message.speaker?.actor;
    const aoeItemUuid = aoeFlags.itemUuid || aoeFlags.originItemUuid;
    if (!casterId && aoeItemUuid?.includes("Actor.")) {
        const parts = aoeItemUuid.split(".");
        const actorIdx = parts.indexOf("Actor");
        if (actorIdx !== -1) casterId = parts[actorIdx + 1];
    }
    if (!casterId && canvas?.tokens?.controlled?.length > 0) {
        casterId = canvas.tokens.controlled[0].actor?.id;
    }

    if (isTsunamiCard) {
        const hasLimbs = message.getFlag("necromancer-thrall-helper", "limbsActivated");
        const targetData = aoeFlags.targets?.[tokenId];
        if (targetData?.isImmune) {
            $row.find(".save-btn-container, .roll-save-btn").css("cssText", "display: none !important;");
            if ($row.find(".miss-badge").length === 0) $row.find(".token-name").after(' <span class="miss-badge" style="color: #999; font-size: 0.8em; font-weight: bold; margin-left: 5px;">[Immune]</span>');
            return;
        }
        if (!hasLimbs) {
            $row.find(".save-btn-container, .roll-save-btn").css("cssText", "display: none !important;");
            if ($row.find(".terrain-badge").length === 0) $row.find(".token-name").after(' <span class="terrain-badge" style="color: #999; font-size: 0.8em; font-weight: bold; margin-left: 5px;">[Greater Difficult Terrain]</span>');
        } else {
            $row.find(".save-btn-container, .roll-save-btn").css("cssText", "display: flex !important;");
            $row.find(".terrain-badge").remove();
        }
        return;
    }

    if (isGrabCard) {
        const targetData = aoeFlags.targets?.[tokenId];
        if (targetData?.isImmune) {
            $row.find(".save-btn-container, .roll-save-btn").hide();
            if ($row.find(".miss-badge").length === 0) $row.find(".token-name").after(' <span class="miss-badge" style="color: #999; font-size: 0.8em; font-weight: bold; margin-left: 5px;">[Missed]</span>');
        }
        return;
    }

    const actor = game.actors.get(casterId);
    const isCaster = casterId ? actor?.isOwner : false;
    const hasPermission = game.user.isGM || message.isAuthor || isCaster;
    const targetToken = canvas?.tokens?.get(tokenId);
    if (!targetToken?.actor) return;

    $row.find(".necro-type-toggle, .harm-type-toggle, .no-save-badge, .aoe-heal-badge").remove();
    $row.find("*").addBack().contents().filter(function () {
        return this.nodeType === 3 && (this.nodeValue.trim() === "Immune" || this.nodeValue.trim() === "Healing");
    }).each(function () { this.nodeValue = ""; });

    const injectToggle = ($r, htmlString) => {
        const $controls = $(htmlString);
        const $saveContainer = $r.find(".save-btn-container, .roll-save-btn, .er-save-btn-container").first();
        if ($saveContainer.length > 0) $saveContainer.before($controls);
        else {
            const $name = $r.find(".token-name").first();
            if ($name.length > 0) $name.after($controls);
            else $r.append($controls);
        }
    };

    if (isDesperateCard || isErasCard || isMosquitoCard) {
        if (isDesperateCard && !actor?.items.some(i => i.name === "Mastery of Life and Death" || i.slug === "mastery-of-life-and-death")) return;

        const currentType = message.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`) || "void";
        const cursorStyle = hasPermission ? "pointer" : "default";
        const getBg = (type) => currentType === type ? (type === "void" ? "#660066" : "#b58900") : "#222";
        const getColor = (type) => currentType === type ? "#fff" : "#999";

        const negHeal = targetToken.actor.system.attributes.hp?.negativeHealing || false;
        const isUnaffected = (currentType === "vitality" && !negHeal) || (currentType === "void" && negHeal);
        const hasDisease = isMosquitoCard && targetToken.actor.items.some(i => i.getFlag("necromancer-thrall-helper", "isNecroticBlood"));

        let badgeHtml = "";
        if (isUnaffected) badgeHtml = '<span class="no-save-badge" style="font-weight: bold; color: #4ade80; font-size: 0.85em; margin-left: 8px;">(Unaffected)</span>';
        else if (hasDisease) badgeHtml = '<span class="no-save-badge" style="font-weight: bold; color: #888; font-size: 0.85em; margin-left: 8px;">(Already Infected)</span>';

        const toggleHtml = `
            <div class="necro-type-toggle" data-token-id="${tokenId}" style="display: inline-flex; align-items: center; margin-left: auto; justify-content: flex-end;">
                <div style="display: inline-flex; border-radius: 3px;">
                    <button type="button" class="necro-type-btn void-opt" data-type="void" style="cursor: ${cursorStyle}; padding: 2px 6px; font-size: 0.7em; background: ${getBg("void")}; color: ${getColor("void")}; border: 1px solid #444; border-radius: 3px 0 0 3px;">Void</button>
                    <button type="button" class="necro-type-btn vit-opt" data-type="vitality" style="cursor: ${cursorStyle}; padding: 2px 6px; font-size: 0.7em; background: ${getBg("vitality")}; color: ${getColor("vitality")}; border: 1px solid #444; border-radius: 0 3px 3px 0;">Vit</button>
                </div>
                ${badgeHtml}
            </div>
        `;

        injectToggle($row, toggleHtml);
        const $saveBtn = $row.find(".roll-save-btn, .save-btn-container, .er-save-btn-container");
        if (isUnaffected || hasDisease) $saveBtn.hide(); else $saveBtn.show();
    }

    if (isHarmCard) {
        if (!actor) return;
        const hasMastery = actor.items.some(i => i.name === "Mastery of Life and Death" || i.slug === "mastery-of-life-and-death");
        const hasInvert = actor.items.some(i => i.name === "Invert Harm" || i.slug === "invert-harm");
        if (!hasMastery && !hasInvert) return;

        const currentState = message.getFlag("necromancer-thrall-helper", `harmState_${tokenId}`) || "void";
        const cursorStyle = hasPermission ? "pointer" : "default";
        const getBg = (type) => currentState === type ? (type === "void" ? "#660066" : type === "vit" ? "#b58900" : "#4ade80") : "#222";
        const getColor = (type) => currentState === type && type === "heal" ? "#000" : (currentState === type ? "#fff" : "#999");

        const vitButton = hasMastery ? `<button type="button" class="harm-type-btn harm-vit-opt" data-type="vit" style="cursor: ${cursorStyle}; padding: 2px 6px; font-size: 0.7em; background: ${getBg("vit")}; color: ${getColor("vit")}; border: 1px solid #444; border-radius: ${hasInvert ? "0" : "0 3px 3px 0"};">Vit</button>` : "";
        const healButton = hasInvert ? `<button type="button" class="harm-type-btn harm-heal-opt" data-type="heal" style="cursor: ${cursorStyle}; padding: 2px 6px; font-size: 0.7em; background: ${getBg("heal")}; color: ${getColor("heal")}; border: 1px solid #444; border-radius: 0 3px 3px 0;">Heal</button>` : "";

        const negHeal = targetToken.actor.system.attributes.hp?.negativeHealing || false;
        const isHealing = (currentState === "void" && negHeal) || currentState === "heal";
        const isUnaffected = (currentState === "vit" && !negHeal);

        let badgeHtml = "";
        if (isHealing) badgeHtml = '<span class="aoe-heal-badge" style="font-weight: bold; color: #4ade80; font-size: 0.85em; margin-left: 8px;">(AoE Heal)</span>';
        else if (isUnaffected) badgeHtml = '<span class="no-save-badge" style="font-weight: bold; color: #4ade80; font-size: 0.85em; margin-left: 8px;">(Unaffected)</span>';

        const toggleHtml = `
            <div class="harm-type-toggle" data-token-id="${tokenId}" style="display: inline-flex; align-items: center; margin-left: auto; justify-content: flex-end;">
                <div style="display: inline-flex; border-radius: 3px;">
                    <button type="button" class="harm-type-btn harm-void-opt" data-type="void" style="cursor: ${cursorStyle}; padding: 2px 6px; font-size: 0.7em; background: ${getBg("void")}; color: ${getColor("void")}; border: 1px solid #444; border-radius: 3px 0 0 3px;">Void</button>
                    ${vitButton}
                    ${healButton}
                </div>
                ${badgeHtml}
            </div>
        `;

        injectToggle($row, toggleHtml);
        const $saveBtn = $row.find(".roll-save-btn, .save-btn-container, .er-save-btn-container");
        if (isHealing || isUnaffected) $saveBtn.hide(); else $saveBtn.show();
    }
});

// Carousel Combat Tracker safe deletion interceptor
Hooks.on("preDeleteToken", (tokenDoc, options) => {
    if (!game.combat || !tokenDoc.inCombat || !game.user.isGM || options.necroSafeDeleteFinished) return true;

    const combatants = game.combat.combatants.filter(c => c.tokenId === tokenDoc.id);
    if (combatants.length > 0) {
        const ids = combatants.map(c => c.id);
        game.combat.deleteEmbeddedDocuments("Combatant", ids).then(() => {
            setTimeout(async () => {
                await tokenDoc.delete({ necroSafeDeleteFinished: true });
            }, 100);
        }).catch(err => {
            console.error("Necromancer Helper | Safe-Delete Interceptor failed:", err);
        });
        return false;
    }
    return true;
});

globalThis.NecroThrallHelper.handleBloodPoolTrigger = async (regionDoc, tokenObj) => {
    const actor = tokenObj.actor;
    if (!actor || !actor.isOwner) return;

    const alliance = actor.system?.details?.alliance || actor.alliance;
    const isAlly = alliance === "party" || tokenObj.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY;
    if (!isAlly) return;

    const poolId = regionDoc.getFlag("necromancer-thrall-helper", "poolId");
    const absorbedFlag = `absorbed_${poolId}`;
    if (actor.getFlag("necromancer-thrall-helper", absorbedFlag)) return;

    const healValue = regionDoc.getFlag("necromancer-thrall-helper", "healValue") || 1;
    const lockoutKey = `${tokenObj.id}_${poolId}`;
    if (globalThis.NecroThrallHelper.declinedPools.has(lockoutKey)) return;

    new Dialog({
        title: "Absorb Blood Pool",
        content: `<p><b>${tokenObj.name}</b> stepped into an infused Blood Pool!</p><p>Spend a <b>Free Action</b> to absorb the lifeblood and recover <b>${healValue} Hit Points</b>?</p>`,
        buttons: {
            absorb: {
                icon: '<i class="fas fa-heart"></i>',
                label: "Absorb (+HP)",
                callback: async () => {
                    if (actor.getFlag("necromancer-thrall-helper", absorbedFlag)) return;
                    await actor.setFlag("necromancer-thrall-helper", absorbedFlag, true);

                    const currentHP = actor.system.attributes.hp.value;
                    const maxHP = actor.system.attributes.hp.max;
                    const actualHealed = Math.min(maxHP - currentHP, healValue);
                    await actor.update({ "system.attributes.hp.value": currentHP + actualHealed });

                    if (canvas.ready && actualHealed > 0) {
                        canvas.interface.createScrollingText(tokenObj.center, `+${actualHealed} HP`, {
                            anchor: CONST.TEXT_ANCHOR_POINTS.TOP, fill: 0xef4444, direction: CONST.TEXT_ANCHOR_POINTS.UP
                        });
                    }

                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor }),
                        flavor: `<strong>Blood Pool Absorbed!</strong>`,
                        content: `<p><b>${tokenObj.name}</b> drinks the infused essence, recovering <b>${actualHealed} Hit Points</b>!</p>`
                    });

                    if (game.user.isGM) {
                        if (canvas.scene.regions.has(regionDoc.id)) await regionDoc.delete();
                        const drawing = canvas.scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "poolId") === poolId);
                        if (drawing) await drawing.delete();
                    } else {
                        game.socket.emit("module.necromancer-thrall-helper", {
                            action: "deleteBloodPool",
                            sceneId: canvas.scene.id,
                            regionId: regionDoc.id,
                            poolId
                        });
                    }
                    globalThis.NecroThrallHelper.declinedPools.delete(lockoutKey);
                }
            },
            pass: {
                icon: '<i class="fas fa-times"></i>',
                label: "Leave It",
                callback: () => {
                    globalThis.NecroThrallHelper.declinedPools.add(lockoutKey);
                    setTimeout(() => globalThis.NecroThrallHelper.declinedPools.delete(lockoutKey), 5000);
                }
            }
        },
        default: "absorb"
    }).render(true);
};

Hooks.on("deleteToken", async (tokenDoc, _options, userId) => {
    if (game.user.id !== userId) return;

    if (game.combat) {
        const orphanedCombatants = game.combat.combatants.filter(c => c.tokenId === tokenDoc.id);
        if (orphanedCombatants.length > 0) {
            const ids = orphanedCombatants.map(c => c.id).filter(id => game.combat?.combatants.has(id));
            game.combat.deleteEmbeddedDocuments("Combatant", ids).catch(() => {});
        }
    }

    const isInstrument = tokenDoc.actor?.items.some(i => i.name === "Effect: Song Instrument");
    if (isInstrument && canvas.scene) {
        for (const t of canvas.scene.tokens) {
            if (t.actor) {
                const recipientEffects = t.actor.items.filter(i => i.name === "Effect: Song of the Soul (Recipient)" && i.getFlag("necromancer-thrall-helper", "instrumentId") === tokenDoc.id);
                for (const effect of recipientEffects) {
                    await effect.delete();
                    await t.actor.toggleRollOption("all", "song-of-the-soul-in-range", false);
                    ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ token: t }),
                        flavor: `<strong>Song of the Soul</strong>`,
                        content: `<p>The ethereal melody abruptly ends as the instrument is destroyed. <b>${t.name}'s</b> Fast Healing fades.</p>`
                    });
                }
            }
        }
    }

    const sceneId = tokenDoc.parent?.id;
    if (!sceneId || !canvas.scene) return;

    const tetherId = tokenDoc.getFlag("necromancer-thrall-helper", "tendrilTetherId");
    if (tetherId) {
        const regions = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "tendrilTetherId") === tetherId).map(r => r.id);
        const drawings = canvas.scene.drawings.filter(d => d.getFlag("necromancer-thrall-helper", "tendrilTetherId") === tetherId).map(d => d.id);
        globalThis.NecroThrallHelper.purgeGraphics(sceneId, { regionIds: regions, drawingIds: drawings });
    }

    if (tokenDoc.getFlag("necromancer-thrall-helper", "isHordeAnchor")) {
        const regions = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "anchorId") === tokenDoc.id).map(r => r.id);
        const drawings = canvas.scene.drawings.filter(d => d.getFlag("necromancer-thrall-helper", "anchorId") === tokenDoc.id).map(d => d.id);
        globalThis.NecroThrallHelper.purgeGraphics(sceneId, { regionIds: regions, drawingIds: drawings });
    }

    const gyTemplateId = tokenDoc.getFlag("necromancer-thrall-helper", "graveyardTemplateId");
    if (gyTemplateId) {
        globalThis.NecroThrallHelper.purgeGraphics(sceneId, { templateIds: [gyTemplateId] });
    }
});

Hooks.on("pf2e.endTurn", async (combatant, combat) => {
    if (!game.user.isGM) return;
    const targetActor = combatant.actor;
    const tokenDoc = combatant.token;
    const targetToken = tokenDoc?.object || canvas.tokens.get(combatant.tokenId);
    if (!tokenDoc || !targetActor || !targetToken) return;

    if (canvas.scene) {
        const activeRegions = targetToken.regions
            ? Array.from(targetToken.regions).map(r => r.document)
            : canvas.scene.regions.filter(rDoc => rDoc.object && rDoc.object.testPoint(targetToken.center));

        for (const region of activeRegions) {
            if (region.getFlag("necromancer-thrall-helper", "goreRegionId") && region.getFlag("necromancer-thrall-helper", "isArmed")) {
                const bgSpellUuid = region.getFlag("aoe-easy-resolve", "originItemUuid");
                if (bgSpellUuid && game.modules.get("aoe-easy-resolve")?.api?.handleRegionEvent) {
                    game.modules.get("aoe-easy-resolve").api.handleRegionEvent({ name: "tokenTurnEnd", data: { token: tokenDoc }, region }, bgSpellUuid);
                }
            }
            if (region.getFlag("necromancer-thrall-helper", "tendrilTetherId")) {
                const tendrilSpellUuid = region.getFlag("aoe-easy-resolve", "originItemUuid");
                if (tendrilSpellUuid && game.modules.get("aoe-easy-resolve")?.api?.handleRegionEvent) {
                    game.modules.get("aoe-easy-resolve").api.handleRegionEvent({ name: "tokenTurnEnd", data: { token: tokenDoc }, region }, tendrilSpellUuid);
                }
            }
        }
    }

    const DamageRoll = CONFIG.Dice.rolls.find(r => r.name === "DamageRoll") || Roll;

    const necros = combat.combatants.filter(c => c.id !== combatant.id && c.actor?.items.some(i => i.name === "Effect: Hallowed Earth" || i.name === "Effect: Corrupted Ground"));
    for (const necro of necros) {
        const nToken = necro.token?.object || canvas.tokens.get(necro.tokenId);
        if (!nToken) continue;

        if (getTokenDistance(nToken, targetToken) <= 10 && DamageRoll) {
            const scale = 2 + Math.max(0, Math.floor(((necro.actor.level || 1) - 6) / 4)) * 2;
            const tVal = targetActor.system?.traits?.value || [];
            const isUndead = tVal.some(tr => typeof tr === "string" && tr.toLowerCase() === "undead");
            const isHoly = tVal.includes("holy");
            const isUnholy = tVal.includes("unholy");

            if (isUnholy && necro.actor.items.some(i => i.name === "Effect: Hallowed Earth")) {
                const roll = await new DamageRoll(`${scale}[spirit]${isUndead ? `,${scale}[vitality]` : ""}`).evaluate();
                await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: necro.actor }), flavor: `<strong>Hallowed Earth</strong><br><b>${necro.actor.name}'s</b> aura burns ${targetToken.name}!` });
                await targetActor.applyDamage({ damage: roll, token: tokenDoc });
            }

            if ((isHoly || tVal.includes("psychopomp")) && necro.actor.items.some(i => i.name === "Effect: Corrupted Ground")) {
                const roll = await new DamageRoll(`${scale}[spirit]${(isHoly && !isUndead && !tVal.includes("construct")) ? `,${scale}[void]` : ""}`).evaluate();
                await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: necro.actor }), flavor: `<strong>Corrupted Ground</strong><br><b>${necro.actor.name}'s</b> aura burns ${targetToken.name}!` });
                await targetActor.applyDamage({ damage: roll, token: tokenDoc });
            }
        }
    }

    const reanimatedFoes = canvas.scene.tokens.filter(t => t.actor?.items.some(i => i.getFlag("necromancer-thrall-helper", "isReanimatedFoe") && i.getFlag("necromancer-thrall-helper", "masterId") === targetActor.id));
    if (reanimatedFoes.length > 0 && DamageRoll) {
        for (const foe of reanimatedFoes) {
            const decay = foe.actor.items.find(i => i.getFlag("necromancer-thrall-helper", "isReanimatedFoe"))?.getFlag("necromancer-thrall-helper", "decayAmount") || 15;
            const roll = await new DamageRoll(`${decay}[untyped]`).evaluate();
            await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: foe.actor, token: foe }), flavor: `<strong>Reanimated Decay</strong><br>The unstable corpse rots rapidly.` });
            await foe.actor.applyDamage({ damage: roll, token: foe, _necroBombProcessed: true });
        }
    }

    // Dread Mosquito end of turn
    const bloodEffect = targetActor.items.find(i => i.getFlag("necromancer-thrall-helper", "isNecroticBlood"));
    if (bloodEffect && bloodEffect.getFlag("necromancer-thrall-helper", "necroticBloodDC")) {
        setTimeout(async () => {
            const saveResult = await targetActor.saves.fortitude.roll({ dc: { value: bloodEffect.getFlag("necromancer-thrall-helper", "necroticBloodDC") }, item: bloodEffect });
            if (!saveResult) return;

            const dosNum = saveResult.degreeOfSuccess ?? saveResult.options?.degreeOfSuccess ?? 2;
            let stage = (bloodEffect.getFlag("necromancer-thrall-helper", "stage") || 1) + (dosNum === 3 ? -2 : dosNum === 2 ? -1 : dosNum === 1 ? 1 : 2);

            if (stage <= 0) {
                await bloodEffect.delete();
                return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: targetActor, token: tokenDoc }), flavor: `<strong>Necrotic Blood Purged</strong>`, content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #4ade80;"><p><b><span style="color: #4ade80;">Success!</span></b> The disease has been completely purged from ${targetActor.name}'s system.</p></div>` });
            }

            stage = Math.min(3, stage);
            const dmgType = bloodEffect.getFlag("necromancer-thrall-helper", "dmgType") || "void";
            await bloodEffect.update({ "system.rules": [{ key: "Weakness", type: "bleed", value: stage === 3 ? 20 : stage * 5 }], "system.description.value": `<b>Necrotic Blood (Stage ${stage})</b><br>Stage 1: 3d10 ${dmgType}, Sickened 1, Weakness 5 Bleed.<br>Stage 2: 4d10 ${dmgType}, Sickened 2, Weakness 10 Bleed.<br>Stage 3: 5d10 ${dmgType}, Sickened 3, Weakness 20 Bleed.<br><br><i>If this creature dies, a thrall rises from its corpse.</i>`, "flags.necromancer-thrall-helper.stage": stage });

            try {
                const sObj = targetActor.getCondition("sickened");
                if ((sObj ? sObj.value : 0) < stage && typeof targetActor.increaseCondition === "function") {
                    for (let i = (sObj ? sObj.value : 0); i < stage; i++) await targetActor.increaseCondition("sickened");
                }
            } catch (e) {}

            if (DamageRoll) {
                const roll = await new DamageRoll(`${stage + 2}d10[${dmgType}]`).evaluate();
                await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: targetActor, token: tokenDoc }), flavor: `<div style="background: rgba(0,0,0,0.3); padding: 6px; border-radius: 4px; border-left: 4px solid ${dosNum >= 2 ? "#eab308" : "#ef4444"}; margin-bottom: 5px;"><strong>Necrotic Blood (Stage ${stage})</strong><br><span style="color: ${dosNum >= 2 ? "#eab308" : "#ef4444"}; font-weight: bold;">${dosNum >= 2 ? "Success" : (dosNum === 1 ? "Failure" : "Critical Failure")}!</span> The disease ravages ${targetActor.name}.</div>` });
                await targetActor.applyDamage({ damage: roll, token: tokenDoc, _necroBombProcessed: true });
            }
        }, 800);
    }

    // Calcification end of turn
    const calcEffect = targetActor.items.find(i => i.getFlag("necromancer-thrall-helper", "isCalcifying"));
    if (calcEffect && calcEffect.getFlag("necromancer-thrall-helper", "calcificationDC")) {
        setTimeout(async () => {
            await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: targetActor, token: tokenDoc }), flavor: `<strong>Calcification Progression</strong>`, content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #e2e8f0;"><p style="margin: 0 0 4px 0;"><b>${targetActor.name}'s</b> flesh continues to solidify into pure bone!</p><p style="margin: 0; font-size: 0.9em; font-style: italic;">Rolling Fortitude Save vs DC ${calcEffect.getFlag("necromancer-thrall-helper", "calcificationDC")} (Incapacitation)...</p></div>` });

            const saveResult = await targetActor.saves.fortitude.roll({ dc: { value: calcEffect.getFlag("necromancer-thrall-helper", "calcificationDC") }, item: calcEffect, extraRollOptions: ["incapacitation"] });
            if (!saveResult) return;

            const dosNum = saveResult.degreeOfSuccess ?? saveResult.options?.degreeOfSuccess ?? 2;
            let curSlow = targetActor.getCondition("slowed")?.value || 0;
            let outcomeHtml = "";

            if (dosNum >= 2) {
                curSlow -= 1;
                if (curSlow <= 0) {
                    await calcEffect.delete();
                    if (targetActor.getCondition("slowed")) await targetActor.decreaseCondition("slowed");
                    outcomeHtml = `<p><b><span style="color: #4ade80;">Success!</span></b> The brittle bone harmlessly shatters off. The effect ends!</p>`;
                } else {
                    await targetActor.decreaseCondition("slowed");
                    outcomeHtml = `<p><b><span style="color: #eab308;">Success.</span></b> Slowed decreases by 1. Now <b>Slowed ${curSlow}</b>.</p>`;
                }
            } else {
                const inc = dosNum === 0 ? 2 : 1;
                curSlow += inc;
                for (let i = 0; i < inc; i++) await targetActor.increaseCondition("slowed");
                if (curSlow >= 3) {
                    await calcEffect.delete();
                    await targetActor.toggleCondition("petrified");
                    outcomeHtml = `<p><b><span style="color: #ef4444;">Fully Calcified!</span></b> ${targetActor.name} has been permanently turned into a bone statue (Petrified).</p>`;
                } else {
                    outcomeHtml = `<p><b><span style="color: #ef4444;">${dosNum === 0 ? "Critical Failure!" : "Failure!"}</span></b> Slowed increases by ${inc}. Now <b>Slowed ${curSlow}</b>.</p>`;
                }
            }
            await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: targetActor, token: tokenDoc }), flavor: `<strong>Calcification Result</strong>`, content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #ef4444;">${outcomeHtml}</div>` });
        }, 1000);
    }
});

Hooks.on("pf2e.startTurn", async (combatant) => {
    if (!game.user.isGM || !combatant.actor?.items.some(i => i.name === "Zombie Horde")) return;

    const anchors = canvas.scene.tokens.filter(t => t.getFlag("necromancer-thrall-helper", "masterId") === combatant.actor.id && t.getFlag("necromancer-thrall-helper", "isHordeAnchor"));
    for (const anchor of anchors) {
        const gridSize = canvas.scene.grid.size;
        const gridDist = canvas.scene.grid.distance;
        const radiusFeet = anchor.getFlag("necromancer-thrall-helper", "hordeRadius") || 10;
        let pixels = (radiusFeet / gridDist) * gridSize;
        const cX = anchor.x + (anchor.width * gridSize) / 2;
        const cY = anchor.y + (anchor.height * gridSize) / 2;

        const thralls = canvas.scene.tokens.filter(t => t.id !== anchor.id && !t.getFlag("necromancer-thrall-helper", "isHordeAnchor") && t.flags?.["necromancer-thrall-helper"]?.masterId === combatant.actor.id && Math.hypot((t.x + (t.width * gridSize) / 2) - cX, (t.y + (t.height * gridSize) / 2) - cY) <= pixels);

        if (thralls.length > 0) {
            const newRadius = Math.min(30, radiusFeet + (5 * thralls.length));
            for (const t of thralls) await t.delete();

            if (newRadius > radiusFeet) {
                await anchor.setFlag("necromancer-thrall-helper", "hordeRadius", newRadius);
                pixels = (newRadius / gridDist) * gridSize;
                await updateIfExists(canvas.scene.regions.find(r => r.getFlag("necromancer-thrall-helper", "anchorId") === anchor.id), { shapes: [{ type: "ellipse", hole: false, x: cX, y: cY, radiusX: pixels, radiusY: pixels, rotation: 0 }] });
                await updateIfExists(canvas.scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "anchorId") === anchor.id), { x: cX - pixels, y: cY - pixels, shape: { type: "e", width: pixels * 2, height: pixels * 2 } });
                ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: combatant.actor }), content: `<p><strong>Zombie Horde Expands!</strong> The horde consumes ${thralls.length} thrall(s), swelling its radius to ${newRadius} feet!</p>` });
            }
        }
    }
});

Hooks.on("createToken", async (tokenDoc, _options, userId) => {
    if (game.user.id !== userId) return;

    let actor = null;
    for (let attempts = 0; attempts < 20; attempts++) {
        actor = tokenDoc.actor;
        if (actor && actor.system?.traits) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!actor) return;

    const masterId = tokenDoc.getFlag("necromancer-thrall-helper", "masterId") || actor.getFlag("pf2e", "master")?.id;
    if (!masterId) return;

    const masterActor = game.actors.get(masterId) || canvas.scene.tokens.get(masterId)?.actor;
    if (!masterActor) return;

    const activeNecroToken = masterActor.getActiveTokens().find(t => t.scene?.id === tokenDoc.parent?.id);
    if (activeNecroToken && activeNecroToken.document.elevation !== tokenDoc.elevation) {
        await updateIfExists(tokenDoc, { elevation: activeNecroToken.document.elevation });
    }

    const isCustomThrall = tokenDoc.getFlag("necromancer-thrall-helper", "masterId") === masterId;
    const hasConjurer = hasConjurerOfCorpses(masterActor);
    const traits = actor.system?.traits?.value || [];
    const isUndead = traits.includes("undead") || traits.some(tr => typeof tr === "string" && tr.toLowerCase() === "undead");
    const isNativeSummon = hasConjurer && isUndead && (actor.getFlag("pf2e", "master")?.id === masterId || tokenDoc.name.includes(masterActor.name));

    if (!isCustomThrall && !isNativeSummon) return;

    if (masterActor.items.some(i => i.name === "Thrall Teamwork")) {
        const currentCombat = game.combat;
        const currentRound = currentCombat ? `${currentCombat.id}-${currentCombat.round}` : "out-of-combat";
        const lastUsed = masterActor.getFlag("necromancer-thrall-helper", "teamworkRound");

        if (lastUsed !== currentRound) {
            await masterActor.setFlag("necromancer-thrall-helper", "teamworkRound", currentRound);
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: masterActor }),
                flavor: `<strong>Thrall Teamwork</strong>`,
                content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #8a2be2;"><p style="margin: 0;"><b>${masterActor.name}</b> coordinates with the newly risen dead!</p><p style="margin: 4px 0 0 0; font-size: 0.9em;">Take a melee Strike as a <b>Free Action</b> against an enemy within your reach that is adjacent to at least one of your thralls.</p></div>`
            });
        }
    }

    const hasHoly = masterActor.items.some(i => i.name === "The Hallowed Dead");
    const hasUnholy = masterActor.items.some(i => i.name === "The Unholy Dead");
    if (!hasHoly && !hasUnholy) return;

    const alignment = hasHoly ? "holy" : "unholy";
    const featName = hasHoly ? "The Hallowed Dead" : "The Unholy Dead";
    const damageBonus = masterActor.level >= 10 ? 2 : 1;
    if (actor.items.some(i => i.name === featName)) return;

    await actor.createEmbeddedDocuments("Item", [{
        name: featName,
        type: "effect",
        img: hasHoly ? "icons/magic/light/explosion-star-glow-yellow.webp" : "icons/magic/death/skull-horned-horns-purple.webp",
        system: {
            duration: { value: -1, unit: "unlimited" },
            description: { value: `Thrall gains the ${alignment} trait. Strikes deal +${damageBonus} spirit damage and gain the ${alignment} trait.` },
            rules: [
                { key: "RollOption", domain: "all", option: `trait:${alignment}` },
                { key: "FlatModifier", selector: "strike-damage", value: damageBonus, damageType: "spirit", type: "untyped" },
                { key: "AdjustStrike", mode: "add", property: "weapon-traits", value: alignment }
            ]
        }
    }]);

    const newTraits = new Set(traits);
    newTraits.add(alignment);
    await actor.update({ "system.traits.value": Array.from(newTraits) });
});

// Recurring Nightmare: Destination-aware spatial haunt
globalThis.NecroThrallHelper.checkNightmareHaunt = async (nightmareTokenDoc, specificTargetDoc = null, overridePos = null) => {
    const isNightmare = nightmareTokenDoc.getFlag("necromancer-thrall-helper", "isRecurringNightmare");
    if (!isNightmare || !canvas.scene) return;

    const masterId = nightmareTokenDoc.getFlag("necromancer-thrall-helper", "masterId");
    const masterActor = game.actors.get(masterId);
    if (!masterActor) return;

    const gridSize = canvas.scene.grid.size;
    const nmX = overridePos?.x ?? nightmareTokenDoc.x;
    const nmY = overridePos?.y ?? nightmareTokenDoc.y;
    const nmW = (nightmareTokenDoc.width || 1) * gridSize;
    const nmH = (nightmareTokenDoc.height || 1) * gridSize;

    const boxesOverlap = (x1, y1, w1, h1, x2, y2, w2, h2) => {
        return !(x1 + w1 <= x2 || x2 + w2 <= x1 || y1 + h1 <= y2 || y2 + h2 <= y1);
    };

    let cohabitants = [];
    if (specificTargetDoc) {
        if (specificTargetDoc.id !== nightmareTokenDoc.id && specificTargetDoc.actor) {
            const hp = specificTargetDoc.actor.system?.attributes?.hp?.value || 0;
            const tX = overridePos?.targetX ?? specificTargetDoc.x;
            const tY = overridePos?.targetY ?? specificTargetDoc.y;
            const tW = (specificTargetDoc.width || 1) * gridSize;
            const tH = (specificTargetDoc.height || 1) * gridSize;
            if (hp > 0 && boxesOverlap(nmX, nmY, nmW, nmH, tX, tY, tW, tH)) {
                cohabitants.push(canvas.tokens.get(specificTargetDoc.id) || specificTargetDoc.object);
            }
        }
    } else {
        cohabitants = canvas.tokens.placeables.filter(t => {
            if (t.id === nightmareTokenDoc.id || !t.actor) return false;
            if ((t.actor.system?.attributes?.hp?.value || 0) <= 0) return false;
            const tW = (t.document.width || 1) * gridSize;
            const tH = (t.document.height || 1) * gridSize;
            return boxesOverlap(nmX, nmY, nmW, nmH, t.document.x, t.document.y, tW, tH);
        });
    }

    cohabitants = cohabitants.filter(Boolean);
    if (cohabitants.length === 0) return;

    const spellDC = getSpellDC(masterActor);
    const targetsData = {};
    cohabitants.forEach(t => {
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

    let rnSpell = masterActor.items.find(i => i.type === "spell" && i.name === "Recurring Nightmare");
    const spellRank = Math.max(7, Math.ceil((masterActor.level || 1) / 2));
    const spellSystemData = {
        level: { value: spellRank },
        traits: { value: ["necromancer", "uncommon", "concentrate", "focus", "manipulate", "emotion", "fear", "mental"] },
        tradition: { value: "divine" },
        defense: { save: { statistic: "will", basic: false, dc: { value: spellDC } } }
    };

    if (!rnSpell) {
        const created = await masterActor.createEmbeddedDocuments("Item", [{ name: "Recurring Nightmare", type: "spell", img: "icons/magic/death/undead-ghost-scream-teal.webp", system: spellSystemData }]);
        rnSpell = created[0];
    } else {
        await rnSpell.update({ system: spellSystemData });
    }

    const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
    const htmlContent = await renderTemplate(templatePath, {
        targets: Object.values(targetsData),
        itemName: "Recurring Nightmare",
        saveType: "Will",
        saveDC: spellDC
    });

    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: masterActor }),
        flavor: `<strong>Recurring Nightmare: Invasive Terror!</strong>`,
        content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #38bdf8;"><p style="margin: 0 0 5px 0;"><b>${nightmareTokenDoc.name}</b> occupies the space of occupying creatures!</p><p style="margin: 0; font-size: 0.95em;">Creatures sharing its space must attempt a <b>DC ${spellDC} Will save</b> or become <b>Frightened 1</b> (<b>Frightened 2</b> on a Critical Failure).</p><hr>${htmlContent}</div>`,
        flags: {
            "aoe-easy-resolve": {
                templateId: null,
                documentName: "ManualTarget",
                itemUuid: rnSpell.uuid,
                itemName: "Recurring Nightmare",
                saveType: "will",
                saveDC: spellDC,
                isBasicSave: false,
                targets: targetsData,
                hazardDamage: null,
                isReactive: false,
                originMessageId: null
            }
        }
    });
};

Hooks.on("updateToken", async (tokenDoc, changes) => {
    if (!game.users.activeGM?.isSelf) return;
    if (!("x" in changes || "y" in changes || "width" in changes || "height" in changes)) return;
    const tetherId = tokenDoc.getFlag("necromancer-thrall-helper", "tendrilTetherId");
    const scene = tokenDoc.parent;
    if (!tetherId || !scene) return;
    const size = scene.grid.size;
    const cx = tokenDoc.x + (tokenDoc.width * size) / 2;
    const cy = tokenDoc.y + (tokenDoc.height * size) / 2;
    for (const region of scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "tendrilTetherId") === tetherId)) {
        const shapes = region.shapes.map(sh => ({ ...sh.toObject(), x: cx, y: cy }));
        await updateIfExists(region, { shapes });
    }
});

Hooks.on("updateToken", async (tokenDoc, changes, _options, userId) => {
    if (!("x" in changes || "y" in changes)) return;

    const scene = tokenDoc.parent || canvas.scene;
    if (!scene) return;

    const destX = changes.x ?? tokenDoc.x;
    const destY = changes.y ?? tokenDoc.y;
    const gridSize = scene.grid.size;
    const gridDist = scene.grid.distance;
    const tCenterX = destX + (tokenDoc.width * gridSize) / 2;
    const tCenterY = destY + (tokenDoc.height * gridSize) / 2;

    if (game.user.isGM && tokenDoc.getFlag("necromancer-thrall-helper", "isHordeAnchor")) {
        const pixels = ((tokenDoc.getFlag("necromancer-thrall-helper", "hordeRadius") || 10) / gridDist) * gridSize;
        const region = scene.regions.find(r => r.getFlag("necromancer-thrall-helper", "anchorId") === tokenDoc.id);
        const drawing = scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "anchorId") === tokenDoc.id);
        if (region) await updateIfExists(region, { shapes: [{ type: "ellipse", hole: false, x: tCenterX, y: tCenterY, radiusX: pixels, radiusY: pixels, rotation: 0 }] });
        if (drawing) await updateIfExists(drawing, { x: tCenterX - pixels, y: tCenterY - pixels, shape: { type: "e", width: pixels * 2, height: pixels * 2 } });
    }

    if (game.user.id !== userId) return;
    if (tokenDoc.getFlag("necromancer-thrall-helper", "isRecurringNightmare")) {
        globalThis.NecroThrallHelper?.checkNightmareHaunt(tokenDoc, null, { x: destX, y: destY });
    }

    const toggleFastHealing = async (effect, tX, tY, iX, iY, enterMsg, leaveMsg) => {
        const dist = (Math.max(Math.abs(tX - iX), Math.abs(tY - iY)) / gridSize) * gridDist;
        const rules = effect.system.rules;
        const hasFastHealing = rules.some(r => r.key === "FastHealing");

        if (dist <= 15 && !hasFastHealing) {
            const rank = effect.getFlag("necromancer-thrall-helper", "spellRank") || 1;
            await effect.update({ "system.rules": [...rules, { key: "FastHealing", value: rank, type: "fast-healing" }] });
            notify("info", enterMsg);
        } else if (dist > 15 && hasFastHealing) {
            await effect.update({ "system.rules": rules.filter(r => r.key !== "FastHealing") });
            notify("warn", leaveMsg);
        }
    };

    if (tokenDoc.actor) {
        const recipientEffects = tokenDoc.actor.items.filter(i => i.name === "Effect: Song of the Soul (Recipient)");
        for (const effect of recipientEffects) {
            const inst = scene.tokens.get(effect.getFlag("necromancer-thrall-helper", "instrumentId"));
            if (!inst) { await effect.delete(); continue; }
            await toggleFastHealing(effect, tCenterX, tCenterY, inst.x + (inst.width * gridSize) / 2, inst.y + (inst.height * gridSize) / 2, `${tokenDoc.name} re-entered the Song's range. Fast Healing restored.`, `${tokenDoc.name} left the Song's range. Fast Healing suppressed.`);
        }

        if (tokenDoc.actor.items.some(i => i.name === "Effect: Song Instrument")) {
            for (const t of scene.tokens) {
                if (!t.actor || t.id === tokenDoc.id) continue;
                const effect = t.actor.items.find(i => i.name === "Effect: Song of the Soul (Recipient)" && i.getFlag("necromancer-thrall-helper", "instrumentId") === tokenDoc.id);
                if (effect) {
                    await toggleFastHealing(effect, t.x + (t.width * gridSize) / 2, t.y + (t.height * gridSize) / 2, tCenterX, tCenterY, `The instrument moved in range of ${t.name}. Fast Healing restored.`, `The instrument moved out of ${t.name}'s range. Fast Healing suppressed.`);
                }
            }
        }
    }
});

Hooks.on("preCreateToken", (tokenDoc, _data, _options, userId) => {
    if (game.user.id !== userId) return;
    if (game.user.isGM && tokenDoc.disposition !== CONST.TOKEN_DISPOSITIONS.FRIENDLY) return;

    let masterActor = game.user.character;
    if (canvas.tokens?.controlled?.length === 1) {
        masterActor = canvas.tokens.controlled[0].actor || masterActor;
    }
    if (!masterActor || !hasConjurerOfCorpses(masterActor)) return;

    const actor = tokenDoc.actor || game.actors.get(tokenDoc.actorId);
    if (!actor) return;

    const traits = actor.system?.traits?.value || [];
    if (traits.includes("undead")) {
        tokenDoc.updateSource({ "flags.necromancer-thrall-helper.masterId": masterActor.id });
        notify("info", `Conjurer of Corpses: Bound ${tokenDoc.name} as a thrall.`);
    }
});

Hooks.on("pf2e.restForTheNight", async (actor) => {
    const flagsToClear = ["consumeThrallUsed", "desperateRevivalUsed", "instantArmyUsed", "nightmareDestroyed", "nightmareSustainRound"];
    for (const flag of flagsToClear) {
        if (actor.getFlag("necromancer-thrall-helper", flag)) {
            await actor.unsetFlag("necromancer-thrall-helper", flag);
        }
    }
});

Hooks.on("updateChatMessage", async (message, changes, options) => {
    if (!game.user.isGM || options.necroHelperProcessed) return;
    const aoeFlags = message.flags?.["aoe-easy-resolve"];
    if (!aoeFlags) return;

    const targets = aoeFlags.targets || {};
    const msgUpdates = {};

    if (changes.flags?.["necromancer-thrall-helper"]?.applyArmorEffects) {
        msgUpdates["flags.necromancer-thrall-helper.-=applyArmorEffects"] = null;
        let masterId = message.speaker?.actor;
        if (!masterId && canvas?.tokens?.controlled?.length > 0) masterId = canvas.tokens.controlled[0].actor?.id;

        const effectData = {
            name: "Effect: Bone Armor",
            type: "effect",
            img: "icons/magic/defensive/shield-barrier-flaming-pentagon-purple-orange.webp",
            system: { duration: { value: 1, unit: "rounds", expiry: "turn-start" }, rules: [{ key: "FlatModifier", selector: "ac", value: 1, type: "status" }] }
        };

        for (const id of Object.keys(targets)) {
            const token = canvas?.tokens?.get(id);
            if (!token?.actor) continue;
            const isFriendly = token.actor.system?.details?.alliance === "party" || token.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY || token.actor.id === masterId;
            if (isFriendly) {
                try { token.actor.createEmbeddedDocuments("Item", [effectData]); } catch (e) {}
            }
        }
    }

    const flatChanges = foundry.utils.flattenObject(changes);
    const hasToggleChange = Object.keys(flatChanges).some(k => k.includes("dmgType_") || k.includes("harmState_"));

    if (hasToggleChange) {
        for (const tokenId of Object.keys(targets)) {
            const targetToken = canvas?.tokens?.get(tokenId);
            if (!targetToken?.actor) continue;
            const negHeal = targetToken.actor.system.attributes.hp?.negativeHealing || false;

            const dmgType = message.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`);
            if (dmgType) {
                const isUnaffected = (dmgType === "vitality" && !negHeal) || (dmgType === "void" && negHeal);
                msgUpdates[`flags.aoe-easy-resolve.targets.${tokenId}.isImmune`] = isUnaffected;
                msgUpdates[`flags.aoe-easy-resolve.targets.${tokenId}.isHealing`] = false;
            }

            const harmState = message.getFlag("necromancer-thrall-helper", `harmState_${tokenId}`);
            if (harmState) {
                let isHealing = false;
                let isImmune = false;
                if (harmState === "void") isHealing = negHeal;
                if (harmState === "vit") isImmune = !negHeal;
                if (harmState === "heal") isHealing = true;

                msgUpdates[`flags.aoe-easy-resolve.targets.${tokenId}.isHealing`] = isHealing;
                msgUpdates[`flags.aoe-easy-resolve.targets.${tokenId}.isImmune`] = isImmune;
            }
        }
    }

    if (!foundry.utils.isEmpty(msgUpdates)) {
        await message.update(msgUpdates, { necroHelperProcessed: true });
        const aoeApi = game.modules.get("aoe-easy-resolve")?.api;
        if (aoeApi?.updateTargetState && Object.keys(targets).length > 0) {
            const firstTokenId = Object.keys(targets)[0];
            await aoeApi.updateTargetState(message.id, firstTokenId, {});
        }
    }
});