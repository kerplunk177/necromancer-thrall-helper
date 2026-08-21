import { prepareThrallPayload, getThrallPresets } from "../system/thrall-manager.js";
import { PortfolioEditor } from "./portfolio-editor.js";
import { executeSpawn } from "../system/socket.js";

// --- GLOBAL HOOKS ---
Hooks.on("renderChatMessage", (message, html) => {
    const itemName = message.flags?.["aoe-easy-resolve"]?.itemName || "";
    const isResolution = message.content?.includes("Resolution Summary") || message.flags?.["aoe-easy-resolve"]?.isResolution;
    
    const isErasCard = (itemName === "Necrotic Bomb" || message.content?.includes("Necrotic Bomb")) && !isResolution;
    const isBarrageCard = (itemName === "Bony Barrage" || message.content?.includes("Bony Barrage")) && !isResolution;
    
    if (!isErasCard && !isBarrageCard) return;

    const $html = html instanceof jQuery ? html : $(html);

    // --- NECROTIC BOMB LOGIC ---
    if (isErasCard) {
        if ($html.find('#necro-bomb-style').length === 0) {
            $html.prepend(`
                <style id="necro-bomb-style">
                    .necro-type-toggle { display: inline-flex; align-items: center; margin-left: 5px; }
                    .necro-type-toggle button { margin: 0; padding: 2px 6px; font-size: 0.7em; line-height: 1; border: 1px solid #444; cursor: pointer; }
                    .void-opt { border-radius: 3px 0 0 3px; }
                    .vit-opt { border-radius: 0 3px 3px 0; }
                    .no-save-badge { font-weight: bold; color: #4ade80; font-size: 0.75em; margin-left: 5px; white-space: nowrap; }
                </style>
            `);
        }

        const updates = {};

        $html.find('[data-token-id]').each((i, el) => {
            const $row = $(el);
            const tokenId = $row.attr('data-token-id');
            if (!tokenId || $row.find('.necro-type-toggle').length > 0) return;

            // Optional chaining protects against the initial world load
            const targetToken = canvas?.tokens?.get(tokenId);
            if (!targetToken?.actor) return;

            const currentType = message.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`) || "void";
            const negHeal = targetToken.actor.system.attributes.hp?.negativeHealing || false;
            
            const isUnaffected = (currentType === 'vitality' && !negHeal) || (currentType === 'void' && negHeal);

            if (game.user.isGM) {
                const aoeTarget = message.flags?.["aoe-easy-resolve"]?.targets?.[tokenId];
                if (aoeTarget && aoeTarget.isImmune !== isUnaffected) {
                    updates[`flags.aoe-easy-resolve.targets.${tokenId}.isImmune`] = isUnaffected;
                }
            }

            const toggleHtml = `
                <div class="necro-type-toggle" data-token-id="${tokenId}">
                    <button type="button" class="type-btn void-opt ${currentType === 'void' ? 'active' : ''}" data-type="void" style="background: ${currentType === 'void' ? '#660066' : '#222'}; color: #fff;">Void</button>
                    <button type="button" class="type-btn vit-opt ${currentType === 'vitality' ? 'active' : ''}" data-type="vitality" style="background: ${currentType === 'vitality' ? '#b58900' : '#222'}; color: #fff;">Vit</button>
                </div>
            `;
            
            $row.find('.save-btn-container, .roll-save-btn').first().before(toggleHtml);

            const $saveBtn = $row.find('.roll-save-btn');
            if (isUnaffected) {
                $saveBtn.hide();
                if ($row.find('.no-save-badge').length === 0) {
                    $saveBtn.after('<span class="no-save-badge">(Unaffected)</span>');
                }
            } else {
                $saveBtn.show();
                $row.find('.no-save-badge').remove();
            }
        });

        if (!foundry.utils.isEmpty(updates) && game.user.isGM) {
            setTimeout(() => message.update(updates), 50);
        }

        $html.find('.type-btn').off('click').on('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const $btn = $(e.currentTarget);
            const type = $btn.attr('data-type');
            const tokenId = $btn.parent().attr('data-token-id');
            
            await message.setFlag("necromancer-thrall-helper", `dmgType_${tokenId}`, type);
            Hooks.callAll("renderChatMessage", message, html);
        });
    }

   // --- BONY BARRAGE LOGIC ---
   if (isBarrageCard) {
    const hasArmor = message.getFlag("necromancer-thrall-helper", "boneArmorActivated");
    const sacrificedId = message.getFlag("necromancer-thrall-helper", "sacrificedThrallId");
    
    let masterId = message.speaker?.actor;
    if (!masterId && canvas?.tokens?.controlled?.length > 0) {
        masterId = canvas.tokens.controlled[0].actor?.id;
    }

    if (hasArmor) {
        $html.find('[data-token-id]').each((i, el) => {
            const $row = $(el);
            const tokenId = $row.attr('data-token-id');
            
            // Nuke the dead thrall's row completely
            if (tokenId === sacrificedId) {
                $row.remove();
                return;
            }
            
            // Optional chaining here as well
            const targetToken = canvas?.tokens?.get(tokenId);
            if (!targetToken || !targetToken.actor) return;
                
                const alliance = targetToken.actor.system?.details?.alliance;
                const isFriendly = alliance === "party" || targetToken.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY || targetToken.actor.id === masterId;
                const isThrall = targetToken.document.getFlag("necromancer-thrall-helper", "masterId") === masterId;
                
                if (isFriendly || isThrall) {
                    $row.find('.save-btn-container, .roll-save-btn').hide();
                    if ($row.find('.bone-armor-badge').length === 0) {
                        $row.find('.token-name').after(' <span class="bone-armor-badge" style="color: #4ade80; font-size: 0.8em; font-weight: bold; margin-left: 5px;">[Bone Armor]</span>');
                    }
                }
            });
            
            if ($html.find('.bone-armor-active-badge').length === 0) {
                const badgeHtml = `<div class="bone-armor-active-badge" style="text-align: center; color: #4ade80; font-weight: bold; margin-top: 5px; margin-bottom: 5px; padding: 4px; background: rgba(0,0,0,0.4); border-radius: 4px;"><i class="fas fa-shield-alt"></i> Bone Armor Active</div>`;
                const targetContainer = $html.find('.card-buttons').last();
                if (targetContainer.length > 0) targetContainer.after(badgeHtml);
                else $html.append(badgeHtml);
                $html.find('.bone-armor-btn').remove();
            }
        } 
        // 2. INTERACTIVE STATE: Show the button to the GM
        else if (game.user.isGM) {
            if ($html.find('.bone-armor-btn').length === 0) {
                const btnHtml = `<button type="button" class="bone-armor-btn" style="margin-top: 5px; margin-bottom: 5px; background: #2c1a3b; color: #fff; border: 1px solid #9900ff;"><i class="fas fa-shield-alt"></i> Consume Thrall for Bone Armor</button>`;
                const targetContainer = $html.find('.card-buttons').last();
                if (targetContainer.length > 0) targetContainer.after(btnHtml);
                else $html.append(btnHtml);

                $html.find('.bone-armor-btn').on('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const aoeFlags = message.flags?.["aoe-easy-resolve"] || {};
                    const targetsData = aoeFlags.targets || {};
                    const targetIds = Object.keys(targetsData);
                    
                    if (targetIds.length === 0) {
                        return ui.notifications.warn("Please wait for the cone template to register targets in the chat card!");
                    }

                    // --- THE BULLETPROOF CASTER LOOKUP ---
                    let actor = null;
                    const itemUuid = aoeFlags.itemUuid || aoeFlags.originItemUuid;
                    
                    if (itemUuid) {
                        const item = await fromUuid(itemUuid);
                        if (item?.actor) actor = item.actor;
                    }
                    if (!actor && message.speaker?.token) {
                        actor = canvas?.scene?.tokens?.get(message.speaker.token)?.actor;
                    }
                    if (!actor && message.speaker?.actor) {
                        actor = game.actors.get(message.speaker.actor);
                    }
                    if (!actor && canvas?.tokens?.controlled?.length > 0) {
                        actor = canvas.tokens.controlled[0].actor;
                    }

                    if (!actor) {
                        return ui.notifications.error("Bone Armor Failed: Caster actor could not be determined. Please select your Necromancer.");
                    }
                    const finalMasterId = actor.id;
                    
                    let sacrificedThrall = null;
                    for (const id of targetIds) {
                        const token = canvas.tokens.get(id);
                        if (token && token.document.getFlag("necromancer-thrall-helper", "masterId") === finalMasterId) {
                            sacrificedThrall = token;
                            break;
                        }
                    }

                    if (!sacrificedThrall) {
                        return ui.notifications.warn("No secondary thrall found strictly inside the cone to sacrifice.");
                    }

                    // Prepare surgical updates
                    const updates = {
                        "flags.necromancer-thrall-helper.boneArmorActivated": true,
                        "flags.necromancer-thrall-helper.sacrificedThrallId": sacrificedThrall.id
                    };
                    
                    // Safely erase the sacrificed thrall from the aoe-easy-resolve target dictionary entirely
                    updates[`flags.aoe-easy-resolve.targets.-=${sacrificedThrall.id}`] = null; 

                    const effectData = {
                        name: "Effect: Bone Armor",
                        type: "effect",
                        img: "icons/magic/defensive/shield-barrier-flaming-pentagon-purple-orange.webp",
                        system: {
                            duration: { value: 1, unit: "rounds", expiry: "turn-start" },
                            rules: [{ key: "FlatModifier", selector: "ac", value: 1, type: "status" }]
                        }
                    };

                    for (const id of targetIds) {
                        if (id === sacrificedThrall.id) continue;
                        
                        const token = canvas.tokens.get(id);
                        if (!token || !token.actor) continue;
                        
                        const alliance = token.actor.system?.details?.alliance;
                        const isFriendly = alliance === "party" || token.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY || token.actor.id === finalMasterId;
                        const isThrall = token.document.getFlag("necromancer-thrall-helper", "masterId") === finalMasterId;
                        
                        if (isFriendly || isThrall) {
                            updates[`flags.aoe-easy-resolve.targets.${id}.isImmune`] = true;
                            if (isFriendly) {
                                await token.actor.createEmbeddedDocuments("Item", [effectData]);
                            }
                        }
                    }

                    await message.update(updates);
                    await sacrificedThrall.document.delete();
                    
                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor: actor }),
                        flavor: `<strong>Bone Armor Activated!</strong>`,
                        content: `<p><b>${sacrificedThrall.name}</b> is consumed by the barrage! Allies in the blast zone take no damage and gain a +1 status bonus to AC until the start of ${actor.name}'s next turn.</p>`
                    });
                });
            }
        }
    }
});
Hooks.on("deleteToken", async (tokenDoc, options, userId) => {
    if (game.user.id !== userId) return;
    
    // 1. Song of the Soul Tracker
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

    // 2. Tendril & Horde Template Cleanup
    const tetherId = tokenDoc.getFlag("necromancer-thrall-helper", "tendrilTetherId");
    if (tetherId && canvas.scene) {
        const regions = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "tendrilTetherId") === tetherId);
        for (const r of regions) await r.delete();
        const drawings = canvas.scene.drawings.filter(d => d.getFlag("necromancer-thrall-helper", "tendrilTetherId") === tetherId);
        for (const d of drawings) await d.delete();
    }

    const isAnchor = tokenDoc.getFlag("necromancer-thrall-helper", "isHordeAnchor");
    if (isAnchor && canvas.scene) {
        const regions = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "anchorId") === tokenDoc.id);
        for (const r of regions) await r.delete();
        const drawings = canvas.scene.drawings.filter(d => d.getFlag("necromancer-thrall-helper", "anchorId") === tokenDoc.id);
        for (const d of drawings) await d.delete();
    }
});
Hooks.on("updateCombat", async (combat, change, options, userId) => {
    if (!game.user.isGM) return;
    if (!change.turn && change.round === undefined) return;
    
    const prevId = combat.previous?.combatantId;
    if (prevId) {
        const prevCombatant = combat.combatants.get(prevId);
        const tokenDoc = prevCombatant?.token;
        const targetToken = tokenDoc?.object || canvas.tokens.get(prevCombatant?.tokenId);
        const targetActor = prevCombatant?.actor;
        
        if (tokenDoc && targetActor && targetToken) {
            const necros = combat.combatants.filter(c => c.actor?.items.some(i => i.name === "Effect: Hallowed Earth" || i.name === "Effect: Corrupted Ground"));
            
            for (const necro of necros) {
                if (necro.id === prevId) continue; 
                
                const necroToken = necro.token?.object || canvas.tokens.get(necro.tokenId);
                if (!necroToken) continue;
                
                let dist = 999;
                if (typeof necroToken.distanceTo === "function") {
                    dist = necroToken.distanceTo(targetToken);
                } else {
                    const dx = Math.abs(necroToken.x - targetToken.x);
                    const dy = Math.abs(necroToken.y - targetToken.y);
                    dist = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                }
                
                if (dist <= 10) {
                    const necroLevel = necro.actor.level || 1;
                    const scale = 2 + Math.max(0, Math.floor((necroLevel - 6) / 4)) * 2;
                    
                    const traits = targetActor.system?.traits?.value || [];
                    const isHoly = traits.includes("holy");
                    const isUnholy = traits.includes("unholy");
                    const isUndead = traits.includes("undead") || traits.some(tr => typeof tr === "string" && tr.toLowerCase() === "undead");
                    const isConstruct = traits.includes("construct");
                    const isPsychopomp = traits.includes("psychopomp");
                    const isLiving = !isUndead && !isConstruct;

                    const hasHallowed = necro.actor.items.some(i => i.name === "Effect: Hallowed Earth");
                    const hasCorrupted = necro.actor.items.some(i => i.name === "Effect: Corrupted Ground");

                    const DamageRoll = CONFIG.Dice.rolls.find(r => r.name === "DamageRoll");

                    if (hasHallowed && isUnholy) {
                        let dmgString = `${scale}[spirit]`;
                        if (isUndead) dmgString += `,${scale}[vitality]`;
                        
                        const roll = await new DamageRoll(dmgString).evaluate();
                        await roll.toMessage({
                            speaker: ChatMessage.getSpeaker({ actor: necro.actor }),
                            flavor: `<strong>Hallowed Earth</strong><br><b>${necro.actor.name}'s</b> aura burns ${targetToken.name}!`
                        });
                        await targetActor.applyDamage({ damage: roll, token: tokenDoc });
                    }

                    if (hasCorrupted && (isHoly || isPsychopomp)) {
                        let dmgString = `${scale}[spirit]`;
                        if (isHoly && isLiving) dmgString += `,${scale}[void]`;
                        
                        const roll = await new DamageRoll(dmgString).evaluate();
                        await roll.toMessage({
                            speaker: ChatMessage.getSpeaker({ actor: necro.actor }),
                            flavor: `<strong>Corrupted Ground</strong><br><b>${necro.actor.name}'s</b> aura burns ${targetToken.name}!`
                        });
                        await targetActor.applyDamage({ damage: roll, token: tokenDoc });
                    }
                }
            }
        }
    }


const combatant = combat.combatant;
if (!combatant || !combatant.actor) return;
const actor = combatant.actor;


    const hasZombieHorde = actor.items.some(i => i.name === "Zombie Horde");
    if (!hasZombieHorde) return;

    const anchors = canvas.scene.tokens.filter(t => t.getFlag("necromancer-thrall-helper", "masterId") === actor.id && t.getFlag("necromancer-thrall-helper", "isHordeAnchor"));

    for (const anchor of anchors) {
        const gridSize = canvas.scene.grid.size;
        const gridDist = canvas.scene.grid.distance;
        let radiusFeet = anchor.getFlag("necromancer-thrall-helper", "hordeRadius") || 10;
        let pixels = (radiusFeet / gridDist) * gridSize;

        const centerX = anchor.x + (anchor.width * gridSize) / 2;
        const centerY = anchor.y + (anchor.height * gridSize) / 2;

        const thralls = canvas.scene.tokens.filter(t => {
            if (t.id === anchor.id) return false;
            if (t.getFlag("necromancer-thrall-helper", "isHordeAnchor")) return false;
            if (t.flags?.["necromancer-thrall-helper"]?.masterId !== actor.id) return false;

            const tCenterX = t.x + (t.width * gridSize) / 2;
            const tCenterY = t.y + (t.height * gridSize) / 2;
            const dx = tCenterX - centerX;
            const dy = tCenterY - centerY;
            return Math.sqrt(dx*dx + dy*dy) <= pixels;
        });

        if (thralls.length > 0) {
            let newRadius = radiusFeet + (5 * thralls.length);
            if (newRadius > 30) newRadius = 30;

            for (const t of thralls) await t.delete();

            if (newRadius > radiusFeet) {
                await anchor.setFlag("necromancer-thrall-helper", "hordeRadius", newRadius);
                pixels = (newRadius / gridDist) * gridSize;

                const region = canvas.scene.regions.find(r => r.getFlag("necromancer-thrall-helper", "anchorId") === anchor.id);
                if (region) {
                    await region.update({
                        shapes: [{
                            type: "ellipse", hole: false, x: centerX, y: centerY,
                            radiusX: pixels, radiusY: pixels, rotation: 0
                        }]
                    });
                }
                
                const drawing = canvas.scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "anchorId") === anchor.id);
                if (drawing) {
                    await drawing.update({
                        x: centerX - pixels,
                        y: centerY - pixels,
                        shape: { type: "e", width: pixels * 2, height: pixels * 2 }
                    });
                }

                ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor: actor }),
                    content: `<p><strong>Zombie Horde Expands!</strong> The horde consumes ${thralls.length} thrall(s), swelling its radius to ${newRadius} feet!</p>`
                });
            }
        }
    }
});

Hooks.on("createToken", (tokenDoc, options, userId) => {
    if (game.user.id !== userId) return;

    setTimeout(async () => {
        const actor = tokenDoc.actor;
        if (!actor) return;

        let masterId = tokenDoc.getFlag("necromancer-thrall-helper", "masterId") || actor.getFlag("pf2e", "master")?.id;
        if (!masterId) return;

        const masterActor = game.actors.get(masterId) || canvas.scene.tokens.get(masterId)?.actor;
        if (!masterActor) return;

        const isCustomThrall = tokenDoc.getFlag("necromancer-thrall-helper", "masterId") === masterId;
        const hasConjurer = masterActor.items.some(i => ["spell", "feat", "action"].includes(i.type) && i.name.toLowerCase().includes("conjurer of corpses"));
        const traits = actor.system?.traits?.value || [];
        const isUndead = traits.includes("undead") || traits.some(tr => typeof tr === "string" && tr.toLowerCase() === "undead");
        const isNativeSummon = hasConjurer && isUndead && (actor.getFlag("pf2e", "master")?.id === masterId || tokenDoc.name.includes(masterActor.name));

        if (!isCustomThrall && !isNativeSummon) return;

        const hasHoly = masterActor.items.some(i => i.name === "The Hallowed Dead");
        const hasUnholy = masterActor.items.some(i => i.name === "The Unholy Dead");

        if (!hasHoly && !hasUnholy) return;

        const alignment = hasHoly ? "holy" : "unholy";
        const featName = hasHoly ? "The Hallowed Dead" : "The Unholy Dead";
        const damageBonus = masterActor.level >= 10 ? 2 : 1;

        if (actor.items.some(i => i.name === featName)) return;

        const effectData = {
            name: featName,
            type: "effect",
            img: hasHoly ? "icons/magic/light/explosion-star-glow-yellow.webp" : "icons/magic/death/skull-horned-horns-purple.webp",
            system: {
                duration: { value: -1, unit: "unlimited" },
                description: { value: `Thrall gains the ${alignment} trait. Strikes deal +${damageBonus} spirit damage and gain the ${alignment} trait.` },
                rules: [
                    { key: "RollOption", domain: "all", option: `trait:${alignment}` },
                    { key: "FlatModifier", selector: "strike-damage", value: damageBonus, damageType: "spirit", type: "untyped" },
                    { key: "AdjustStrike", property: "property-traits", value: alignment }
                ]
            }
        };

        await actor.createEmbeddedDocuments("Item", [effectData]);

        const newTraits = new Set(traits);
        newTraits.add(alignment);
        await actor.update({ "system.traits.value": Array.from(newTraits) });

    }, 250);
});

Hooks.on("updateToken", async (tokenDoc, changes, options, userId) => {
    if (game.user.id !== userId) return; 
    if (!("x" in changes || "y" in changes)) return;

    const gridSize = canvas.scene.grid.size;
    const gridDist = canvas.scene.grid.distance;

    // --- 1. Song of the Soul Distance Tether ---
    if (canvas.scene) {
        // A. Did the recipient move?
        if (tokenDoc.actor) {
            const recipientEffects = tokenDoc.actor.items.filter(i => i.name === "Effect: Song of the Soul (Recipient)");
            for (const effect of recipientEffects) {
                const instrumentId = effect.getFlag("necromancer-thrall-helper", "instrumentId");
                const instrument = canvas.scene.tokens.get(instrumentId);
                if (!instrument) {
                    await effect.delete();
                    continue;
                }
                const tCenterX = (changes.x !== undefined ? changes.x : tokenDoc.x) + (tokenDoc.width * gridSize) / 2;
                const tCenterY = (changes.y !== undefined ? changes.y : tokenDoc.y) + (tokenDoc.height * gridSize) / 2;
                const iCenterX = instrument.x + (instrument.width * gridSize) / 2;
                const iCenterY = instrument.y + (instrument.height * gridSize) / 2;
                
                const dx = Math.abs(tCenterX - iCenterX);
                const dy = Math.abs(tCenterY - iCenterY);
                const dist = (Math.max(dx, dy) / gridSize) * gridDist;

                const hasFastHealing = effect.system.rules.some(r => r.key === "FastHealing");
                const spellRank = effect.getFlag("necromancer-thrall-helper", "spellRank") || 1;

                if (dist <= 15 && !hasFastHealing) {
                    const newRules = foundry.utils.duplicate(effect.system.rules);
                    newRules.push({ key: "FastHealing", value: spellRank, type: "fast-healing" });
                    await effect.update({ "system.rules": newRules });
                    ui.notifications.info(`${tokenDoc.name} re-entered the Song's range. Fast Healing restored.`);
                } else if (dist > 15 && hasFastHealing) {
                    const newRules = effect.system.rules.filter(r => r.key !== "FastHealing");
                    await effect.update({ "system.rules": newRules });
                    ui.notifications.warn(`${tokenDoc.name} left the Song's range. Fast Healing suppressed.`);
                }
            }
        }

        // B. Did the instrument move?
        const isInstrument = tokenDoc.actor?.items.some(i => i.name === "Effect: Song Instrument");
        if (isInstrument) {
            const iCenterX = (changes.x !== undefined ? changes.x : tokenDoc.x) + (tokenDoc.width * gridSize) / 2;
            const iCenterY = (changes.y !== undefined ? changes.y : tokenDoc.y) + (tokenDoc.height * gridSize) / 2;

            for (const t of canvas.scene.tokens) {
                if (t.actor && t.id !== tokenDoc.id) {
                    const effect = t.actor.items.find(i => i.name === "Effect: Song of the Soul (Recipient)" && i.getFlag("necromancer-thrall-helper", "instrumentId") === tokenDoc.id);
                    if (effect) {
                        const tCenterX = t.x + (t.width * gridSize) / 2;
                        const tCenterY = t.y + (t.height * gridSize) / 2;
                        const dx = Math.abs(tCenterX - iCenterX);
                        const dy = Math.abs(tCenterY - iCenterY);
                        const dist = (Math.max(dx, dy) / gridSize) * gridDist;

                        const hasFastHealing = effect.system.rules.some(r => r.key === "FastHealing");
                        const spellRank = effect.getFlag("necromancer-thrall-helper", "spellRank") || 1;

                        if (dist <= 15 && !hasFastHealing) {
                            const newRules = foundry.utils.duplicate(effect.system.rules);
                            newRules.push({ key: "FastHealing", value: spellRank, type: "fast-healing" });
                            await effect.update({ "system.rules": newRules });
                            ui.notifications.info(`The instrument moved in range of ${t.name}. Fast Healing restored.`);
                        } else if (dist > 15 && hasFastHealing) {
                            const newRules = effect.system.rules.filter(r => r.key !== "FastHealing");
                            await effect.update({ "system.rules": newRules });
                            ui.notifications.warn(`The instrument moved out of ${t.name}'s range. Fast Healing suppressed.`);
                        }
                    }
                }
            }
        }
    }

    // --- 2. Zombie Horde Drag Logic (Visual Sync Only) ---
    const isAnchor = tokenDoc.getFlag("necromancer-thrall-helper", "isHordeAnchor");
    if (isAnchor) {
        const region = canvas.scene.regions.find(r => r.getFlag("necromancer-thrall-helper", "anchorId") === tokenDoc.id);
        const drawing = canvas.scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "anchorId") === tokenDoc.id);

        if (region || drawing) {
            let radiusFeet = tokenDoc.getFlag("necromancer-thrall-helper", "hordeRadius") || 10;
            const centerX = (changes.x !== undefined ? changes.x : tokenDoc.x) + (tokenDoc.width * gridSize) / 2;
            const centerY = (changes.y !== undefined ? changes.y : tokenDoc.y) + (tokenDoc.height * gridSize) / 2;
            const pixels = (radiusFeet / gridDist) * gridSize;

            if (region) {
                await region.update({
                    shapes: [{
                        type: "ellipse", hole: false, x: centerX, y: centerY,
                        radiusX: pixels, radiusY: pixels, rotation: 0
                    }]
                });
            }

            if (drawing) {
                await drawing.update({
                    x: centerX - pixels,
                    y: centerY - pixels,
                    shape: { type: "e", width: pixels * 2, height: pixels * 2 }
                });
            }
        }
    }
});

Hooks.on("preCreateToken", (tokenDoc, data, options, userId) => {
    if (game.user.id !== userId) return;

    // Failsafe: Prevent the GM from accidentally branding enemy tokens while building encounters
    if (game.user.isGM && tokenDoc.disposition !== CONST.TOKEN_DISPOSITIONS.FRIENDLY) return;

    let masterActor = game.user.character;
    if (canvas.tokens?.controlled?.length === 1) {
        masterActor = canvas.tokens.controlled[0].actor || masterActor;
    }

    if (!masterActor) return;

    const hasConjurer = masterActor.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("conjurer of corpses") || (i.system?.slug && i.system.slug.includes("conjurer-of-corpses"))));
    if (!hasConjurer) return;

    const actor = tokenDoc.actor || game.actors.get(tokenDoc.actorId);
    if (!actor) return;
    
    const traits = actor.system?.traits?.value || [];
    if (traits.includes("undead")) {
        tokenDoc.updateSource({
            "flags.necromancer-thrall-helper.masterId": masterActor.id
        });
        ui.notifications.info(`Conjurer of Corpses: Bound ${tokenDoc.name} as a thrall.`);
    }
});

Hooks.on("pf2e.restForTheNight", async (actor) => {
    if (actor.getFlag("necromancer-thrall-helper", "consumeThrallUsed")) {
        await actor.unsetFlag("necromancer-thrall-helper", "consumeThrallUsed");
    }
});

Hooks.on("updateChatMessage", async (message, changes, options, userId) => {
    if (!game.user.isGM) return;
    const aoeFlags = message.flags?.["aoe-easy-resolve"];
    if (!aoeFlags) return;

    const itemName = aoeFlags.itemName;
    const targets = aoeFlags.targets || {};

    switch(itemName) {
        case "Deathly Scream": {
            for (const [tokenId, targetData] of Object.entries(targets)) {
                if (targetData.hasApplied && !targetData._deathlyScreamProcessed) {
                    await message.update({ [`flags.aoe-easy-resolve.targets.${tokenId}._deathlyScreamProcessed`]: true });

                    const targetToken = canvas.tokens.get(tokenId);
                    if (!targetToken?.actor) continue;

                    const dos = targetData.degreeOfSuccess;
                    // Frightened only applies on a standard Failure or Critical Failure
                    if (!dos || dos === "criticalSuccess" || dos === "success") continue; 

                    const frightenedVal = dos === "failure" ? 1 : 2;

                    try {
                        if (typeof targetToken.actor.increaseCondition === "function") {
                            await targetToken.actor.increaseCondition("frightened", { value: frightenedVal });
                        }
                    } catch (e) {
                        console.error("Necromancer Helper | Failed to apply Frightened condition", e);
                    }

                    let flavorText = dos === "failure" ? "is shaken by the spectral wail! They are <b>Frightened 1</b>." : "is terrified to their core! They are <b>Frightened 2</b>.";

                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor: targetToken.actor }),
                        flavor: `<strong>Deathly Scream Result!</strong>`,
                        content: `<p><b>${targetToken.name}</b> ${flavorText}</p>`
                    });
                }
            }
            break;
        }
        case "Dead Weight": {
            for (const [tokenId, targetData] of Object.entries(targets)) {
                if (targetData.hasApplied && !targetData._deadWeightProcessed) {
                    await message.update({ [`flags.aoe-easy-resolve.targets.${tokenId}._deadWeightProcessed`]: true });

                    const targetToken = canvas.tokens.get(tokenId);
                    if (!targetToken?.actor) continue;

                    const dos = targetData.degreeOfSuccess;
                    if (!dos || dos === "criticalSuccess") continue;

                    try {
                        if (typeof targetToken.actor.increaseCondition === "function") {
                            await targetToken.actor.increaseCondition("off-guard");

                            if (dos === "failure") {
                                await targetToken.actor.increaseCondition("slowed", { value: 1 });
                            } else if (dos === "criticalFailure") {
                                await targetToken.actor.increaseCondition("slowed", { value: 2 });
                            }
                        }
                    } catch (e) {
                        console.error("Necromancer Helper", e);
                    }

                    let flavorText = dos === "success" ? "is dragged down, leaving them <b>Off-Guard</b>!" :
                                     dos === "failure" ? "is burdened by the fusing flesh! They are <b>Slowed 1</b> and <b>Off-Guard</b>!" :
                                     "is completely overwhelmed by the crushing corpse! They are <b>Slowed 2</b> and <b>Off-Guard</b>!";

                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor: targetToken.actor }),
                        flavor: `<strong>Dead Weight Result!</strong>`,
                        content: `<p><b>${targetToken.name}</b> ${flavorText}</p>`
                    });
                }
            }
            break;
        }

        case "Blood Infusion": {
            const spellRank = aoeFlags.spellRank || 1;
            for (const [tokenId, targetData] of Object.entries(targets)) {
                if (targetData.hasApplied && !targetData._bloodInfusedProcessed) {
                    await message.update({ [`flags.aoe-easy-resolve.targets.${tokenId}._bloodInfusedProcessed`]: true });

                    const targetToken = canvas.tokens.get(tokenId);
                    if (!targetToken?.actor) continue;

                    const dos = targetData.degreeOfSuccess;
                    if (!dos || dos === "criticalSuccess") continue;

                    try {
                        const bleedEffect = {
                            name: "Infused Blood",
                            type: "effect",
                            img: "icons/magic/water/blood-drop-skull.webp",
                            system: {
                                description: { value: "Loses immunity to bleed and is considered a creature with blood for 1 minute." },
                                duration: { value: 1, unit: "minutes", expiry: null },
                                rules: [
                                    { key: "Immunity", type: "bleed", mode: "remove" }
                                ]
                            }
                        };
                        await targetToken.actor.createEmbeddedDocuments("Item", [bleedEffect]);
                    } catch (e) {
                        console.error("Necromancer Helper | Failed to apply Infused Blood effect", e);
                    }

                    let damageFormula = "";
                    let damageDesc = "";
                    if (dos === "success") {
                        damageFormula = `${spellRank}`;
                        damageDesc = `${spellRank} flat`;
                    } else if (dos === "failure") {
                        damageFormula = `${spellRank}d6`;
                        damageDesc = `${spellRank}d6`;
                    } else if (dos === "criticalFailure") {
                        damageFormula = `${spellRank * 2}d6`;
                        damageDesc = `${spellRank * 2}d6`;
                    }

                    try {
                        if (typeof targetToken.actor.increaseCondition === "function") {
                            await targetToken.actor.increaseCondition("persistent-damage", { 
                                value: damageFormula, 
                                suboption: "bleed" 
                            });
                        }
                    } catch (e) {
                        console.error("Necromancer Helper | Failed to apply persistent bleed condition", e);
                    }

                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor: targetToken.actor }),
                        flavor: `<strong>Blood Infusion Result!</strong>`,
                        content: `
                            <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #990000;">
                                <p style="margin: 0 0 4px 0;"><b>${targetToken.name}</b> is filled with foreign fluid! Their bleed immunity is stripped for 1 minute.</p>
                                <p style="margin: 0; font-size: 1.1em; color: #ff6b6b; font-weight: bold;">
                                    Required Persistent Bleed: <span style="color: #fff;">${damageDesc} bleed damage</span> (${damageFormula})
                                </p>
                            </div>
                        `
                    });
                }
            }
            break;
        }

        case "Life Tap": {
            for (const [tokenId, targetData] of Object.entries(targets)) {
                if (targetData.hasApplied && !targetData._lifeTapProcessed) {
                    await message.update({ [`flags.aoe-easy-resolve.targets.${tokenId}._lifeTapProcessed`]: true });

                    const targetToken = canvas.tokens.get(tokenId);
                    if (!targetToken?.actor) continue;

                    const dos = targetData.degreeOfSuccess;
                    if (!dos || dos === "criticalSuccess") continue;

                    const drainedVal = dos === "success" ? 1 : dos === "failure" ? 2 : 3;

                    try {
                        if (typeof targetToken.actor.increaseCondition === "function") {
                            await targetToken.actor.increaseCondition("drained", { value: drainedVal });
                        } else {
                            const conditionSource = game.pf2e?.ConditionManager?.getCondition("drained")?.toObject();
                            if (conditionSource) {
                                conditionSource.system.value = drainedVal;
                                await targetToken.actor.createEmbeddedDocuments("Item", [conditionSource]);
                            }
                        }
                    } catch (e) {
                        console.error("Necromancer Helper | Failed to apply Drained condition", e);
                    }

                    const targetActor = targetToken.actor;
                    const targetLevel = targetActor.level || targetActor.system?.details?.level?.value || 1;
                    const hpLost = drainedVal * targetLevel;
                    const healingAmount = hpLost * 2;

                    const casterActor = game.actors.get(message.speaker?.actor) || canvas.tokens.controlled[0]?.actor;
                    const eligibleAllies = canvas.tokens.placeables.filter(t => {
                        if (!t.actor) return false;
                        const alliance = t.actor.system?.details?.alliance;
                        return alliance === "party" || t.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY;
                    });

                    let recipientActor = casterActor;
                    if (eligibleAllies.length > 1) {
                        let optionsHtml = "";
                        eligibleAllies.forEach(t => {
                            optionsHtml += `<option value="${t.actor.id}">${t.name} (${t.actor.name})</option>`;
                        });

                        await new Promise(resolve => {
                            new Dialog({
                                title: "Life Tap: Siphon Recipient",
                                content: `<p><b>${targetToken.name}</b> lost ${hpLost} maximum Hit Points from Drained ${drainedVal}. Choose who receives <b>${healingAmount} HP</b> of healing:</p><form><select id="heal-recipient">${optionsHtml}</select></form>`,
                                buttons: {
                                    select: {
                                        label: "Apply Healing",
                                        callback: (html) => {
                                            const selectedId = html.find("#heal-recipient").val();
                                            const found = game.actors.get(selectedId);
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
                        const maxHP = recipientActor.system.attributes.hp.max;
                        const actualHealed = Math.min(maxHP - currentHP, healingAmount);
                        await recipientActor.update({ "system.attributes.hp.value": currentHP + actualHealed });

                        const recipientToken = recipientActor.getActiveTokens()[0];
                        if (recipientToken && canvas.ready && actualHealed > 0) {
                            canvas.interface.createScrollingText(recipientToken.center, `+${actualHealed} HP`, { anchor: CONST.TEXT_ANCHOR_POINTS.TOP, fill: 0x4ade80, direction: CONST.TEXT_ANCHOR_POINTS.UP });
                        }

                        await ChatMessage.create({
                            speaker: ChatMessage.getSpeaker({ actor: recipientActor }),
                            flavor: `<strong>Life Tap Siphon!</strong>`,
                            content: `<p><b>${targetToken.name}</b> succumbs to the siphon, suffering <b>Drained ${drainedVal}</b> (losing ${hpLost} Max HP). <b>${recipientActor.name}</b> drinks the essence, recovering <b>${actualHealed} Hit Points</b>!</p>`
                        });
                    }
                }
            }
            break;
        }
    }
});

Hooks.on("renderChatMessage", (message, html) => {
    const isErasCard = message.flags?.["aoe-easy-resolve"]?.itemName === "Necrotic Bomb" || message.content?.includes("Necrotic Bomb");
    if (!isErasCard) return;

    const $html = html instanceof jQuery ? html : $(html);
    
    if ($html.find('#necro-bomb-style').length === 0) {
        $html.prepend(`
            <style id="necro-bomb-style">
                .necro-type-toggle { display: inline-flex; align-items: center; margin-left: 5px; }
                .necro-type-toggle button { margin: 0; padding: 2px 6px; font-size: 0.7em; line-height: 1; border: 1px solid #444; cursor: pointer; }
                .void-opt { border-radius: 3px 0 0 3px; }
                .vit-opt { border-radius: 0 3px 3px 0; }
                .no-save-badge { font-weight: bold; color: #4ade80; font-size: 0.75em; margin-left: 5px; white-space: nowrap; }
            </style>
        `);
    }

    const updates = {};

    $html.find('[data-token-id]').each((i, el) => {
        const $row = $(el);
        const tokenId = $row.attr('data-token-id');
        if (!tokenId || $row.find('.necro-type-toggle').length > 0) return;

        const targetToken = canvas.tokens.get(tokenId);
        if (!targetToken?.actor) return;

        const currentType = message.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`) || "void";
        const negHeal = targetToken.actor.system.attributes.hp?.negativeHealing || false;
        
        const isUnaffected = (currentType === 'vitality' && !negHeal) || (currentType === 'void' && negHeal);

        if (game.user.isGM) {
            const aoeTarget = message.flags?.["aoe-easy-resolve"]?.targets?.[tokenId];
            if (aoeTarget && aoeTarget.isImmune !== isUnaffected) {
                updates[`flags.aoe-easy-resolve.targets.${tokenId}.isImmune`] = isUnaffected;
            }
        }

        const toggleHtml = `
            <div class="necro-type-toggle" data-token-id="${tokenId}">
                <button type="button" class="type-btn void-opt ${currentType === 'void' ? 'active' : ''}" data-type="void" style="background: ${currentType === 'void' ? '#660066' : '#222'}; color: #fff;">Void</button>
                <button type="button" class="type-btn vit-opt ${currentType === 'vitality' ? 'active' : ''}" data-type="vitality" style="background: ${currentType === 'vitality' ? '#b58900' : '#222'}; color: #fff;">Vit</button>
            </div>
        `;
        
        $row.find('.save-btn-container, .roll-save-btn').first().before(toggleHtml);

        const $saveBtn = $row.find('.roll-save-btn');
        if (isUnaffected) {
            $saveBtn.hide();
            if ($row.find('.no-save-badge').length === 0) {
                $saveBtn.after('<span class="no-save-badge">(Unaffected)</span>');
            }
        } else {
            $saveBtn.show();
            $row.find('.no-save-badge').remove();
        }
    });

    if (!foundry.utils.isEmpty(updates) && game.user.isGM) {
        setTimeout(() => message.update(updates), 50);
    }

    $html.find('.type-btn').off('click').on('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const $btn = $(e.currentTarget);
        const type = $btn.attr('data-type');
        const tokenId = $btn.parent().attr('data-token-id');
        
        await message.setFlag("necromancer-thrall-helper", `dmgType_${tokenId}`, type);
        Hooks.callAll("renderChatMessage", message, html);
    });
});

if (!CONFIG.Actor.documentClass.prototype._necroBombApplyDamage) {
    CONFIG.Actor.documentClass.prototype._necroBombApplyDamage = CONFIG.Actor.documentClass.prototype.applyDamage;
    
    CONFIG.Actor.documentClass.prototype.applyDamage = async function(options) {
        const isBomb = options.item?.name === "Necrotic Bomb" || options.source?.name === "Necrotic Bomb" || options.message?.flags?.["aoe-easy-resolve"];
        
        if (isBomb) {
            let msg = game.messages.contents.slice(-10).reverse().find(m => m.flags?.["aoe-easy-resolve"]?.itemName === "Necrotic Bomb" || m.content?.includes("Necrotic Bomb"));
            let dmgType = "void"; 
            
            if (msg) {
                const token = this.getActiveTokens()[0];
                if (token) {
                    dmgType = msg.getFlag("necromancer-thrall-helper", `dmgType_${token.id}`) || "void";
                }
            }

            const negHeal = this.system.attributes.hp?.negativeHealing || false;

            if ((dmgType === 'vitality' && !negHeal) || (dmgType === 'void' && negHeal)) {
                if (options.damage) options.damage = 0;
                if (options.roll) options.roll = 0;
                if (options.damage?.instances) options.damage.instances.forEach(i => { i.total = 0; i.type = dmgType; });
                return this._necroBombApplyDamage(options);
            }

            if (options.damage?.instances) {
                options.damage.instances.forEach(i => i.type = dmgType);
            } else if (options.roll?.instances) {
                options.roll.instances.forEach(i => i.type = dmgType);
            }
        }
        return this._necroBombApplyDamage(options);
    };
}


// --- MAIN CLASS ---

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ThrallCommandDeck extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "thrall-command-deck",
        title: "Command Deck",
        tag: "form",
        position: {
            width: 350,
            height: "auto"
        },
        window: {
            icon: "fas fa-skull",
            resizable: true 
        }
    };

    static PARTS = {
        main: {
            template: "modules/necromancer-thrall-helper/templates/command-deck.hbs"
        }
    };
    constructor(necroId, options = {}) {
        if (typeof necroId === "object") {
            options = necroId;
            necroId = null;
        }

        if (!necroId) {
            const controlled = canvas.tokens?.controlled[0]?.actor;
            if (controlled) {
                necroId = controlled.id;
            } 
            else if (game.user.character) {
                necroId = game.user.character.id;
            } 
            else if (canvas.scene) {
                const existingThrall = canvas.scene.tokens.find(t => t.flags?.["necromancer-thrall-helper"]?.masterId);
                if (existingThrall) {
                    necroId = existingThrall.flags["necromancer-thrall-helper"].masterId;
                }
            }
            else if (game.user.isGM) {
                const necro = game.actors.find(a => a.flags?.["necromancer-thrall-helper"]?.familyTree);
                if (necro) {
                    necroId = necro.id;
                    ui.notifications.info(`Auto-assigned Command Deck to ${necro.name}.`);
                }
            }
        }

        if (!necroId) {
            ui.notifications.warn("No Necromancer found. Please select your token before opening the Command Deck.");
            throw new Error("Command Deck aborted: No valid Necromancer target.");
        }

        const actor = game.actors.get(necroId);
        if (actor) {
            const hasNecroClass = actor.items.some(i => i.type === "class" && (i.name.toLowerCase().includes("necromancer") || i.system?.slug?.includes("necromancer")));
            const hasNecroDedication = actor.items.some(i => i.type === "feat" && (i.name.toLowerCase().includes("necromancer") || i.system?.slug?.includes("necromancer")));
            
            if (!hasNecroClass && !hasNecroDedication && !game.user.isGM) {
                ui.notifications.warn("This mortal lacks the dark blood and discipline required to command the dead.");
                throw new Error("Unauthorized Command Deck access.");
            }
        }

        const savedPos = localStorage.getItem(`necro-deck-bounds-${game.user?.id}`);
        if (savedPos) {
            try {
                options.position = foundry.utils.mergeObject(options.position || {}, JSON.parse(savedPos));
            } catch (e) {
                console.error("Necromancer Helper | Failed to parse saved window position.");
            }
        }
        super(options);

        this.necroId = necroId;
        this.actionStates = {}; 
        this.imageCache = {}; 

        this._onCreateToken = Hooks.on("createToken", (doc) => {
            if (this.rendered) {
                setTimeout(() => this.render({ force: false }), 200);
            }
        });

        this._onTokenUpdate = Hooks.on("updateToken", (doc, changes) => {
            if (this.rendered && ("x" in changes || "y" in changes || "elevation" in changes)) {
                setTimeout(() => this.render({ force: false }), 150);
            }
        });
        
        this._onTokenDelete = Hooks.on("deleteToken", async (doc) => {
            if (this.rendered) this.render({ force: false });
            
            // --- Song of the Soul Death Tracker ---
            if (canvas.scene) {
                for (const t of canvas.scene.tokens) {
                    if (t.actor) {
                        const recipientEffects = t.actor.items.filter(i => 
                            i.name === "Effect: Song of the Soul (Recipient)" && 
                            i.getFlag("necromancer-thrall-helper", "instrumentId") === doc.id
                        );
                        for (const effect of recipientEffects) {
                            await effect.delete();
                            ChatMessage.create({
                                speaker: ChatMessage.getSpeaker({ actor: t.actor }),
                                flavor: `<strong>Song of the Soul</strong>`,
                                content: `<p>The ethereal melody abruptly ends as the instrument is destroyed. <b>${t.name}'s</b> Fast Healing fades.</p>`
                            });
                        }
                    }
                }
            }

            const tetherId = doc.getFlag("necromancer-thrall-helper", "tendrilTetherId");
            if (tetherId && canvas.scene) {
                const regions = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "tendrilTetherId") === tetherId);
                for (const r of regions) {
                    if (r.canUserModify(game.user, "delete")) await r.delete();
                }
                const drawings = canvas.scene.drawings.filter(d => d.getFlag("necromancer-thrall-helper", "tendrilTetherId") === tetherId);
                for (const d of drawings) {
                    if (d.canUserModify(game.user, "delete")) await d.delete();
                }
            }

            const isHordeAnchor = doc.getFlag("necromancer-thrall-helper", "isHordeAnchor");
            if (isHordeAnchor && canvas.scene) {
                const regions = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "anchorId") === doc.id);
                for (const r of regions) {
                    if (r.canUserModify(game.user, "delete")) await r.delete();
                }
                const drawings = canvas.scene.drawings.filter(d => d.getFlag("necromancer-thrall-helper", "anchorId") === doc.id);
                for (const d of drawings) {
                    if (d.canUserModify(game.user, "delete")) await d.delete();
                }
            }
        });

        this._onActorUpdate = Hooks.on("updateActor", (doc, changes) => {
            if (this.rendered && doc.id === this.necroId) {
                this.render({ force: false });
            }
        });
    }

    /** @override */
    async close(options) {
        Hooks.off("createToken", this._onCreateToken);
        Hooks.off("updateToken", this._onTokenUpdate);
        Hooks.off("deleteToken", this._onTokenDelete);
        Hooks.off("updateActor", this._onActorUpdate);
        return super.close(options);
    }

    async _prepareContext(options) {
        const actor = game.actors.get(this.necroId);
        let damageScale = "1d6";
        if (actor) {
            const necroLevel = actor.level || 1;
            const dice = Math.max(1, Math.floor((necroLevel - 1) / 4) + 1);
            damageScale = `${dice}d6`;
        }

        const mapPenalty = this.currentMap !== undefined ? this.currentMap : 0;
        
        let activeThralls = [];
        if (canvas.scene && this.necroId) {
            const hasConjurer = actor?.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("conjurer of corpses") || (i.system?.slug && i.system.slug.includes("conjurer-of-corpses")))) || false;

            const tokens = canvas.scene.tokens.filter(t => {
                const customMasterId = t.flags["necromancer-thrall-helper"]?.masterId;
                if (customMasterId && customMasterId === this.necroId) return true;

                if (hasConjurer && t.actor) {
                    const traits = t.actor.system?.traits?.value || [];
                    const isUndead = traits.includes("undead") || traits.some(tr => tr.toLowerCase() === "undead");
                    
                    if (isUndead) {
                        const pf2eMasterId = t.actor.getFlag("pf2e", "master")?.id;
                        if (pf2eMasterId === this.necroId) return true;
                        
                        if (t.name.startsWith(`${actor.name}'s`)) return true;
                    }
                }
                return false;
            });
            
            activeThralls = tokens.map(t => {
                const tokenObj = t.object;
                let nearbyEnemies = 0;
                let nearbyFriendlies = 0;

                if (tokenObj && canvas.tokens?.placeables) {
                    for (const other of canvas.tokens.placeables) {
                        if (other.id === tokenObj.id) continue;
                        if (!other.actor) continue;
                        
                        const hp = other.actor.system?.attributes?.hp?.value || 0;
                        if (hp <= 0) continue;

                        let distance = 999;
                        if (typeof tokenObj.distanceTo === "function") {
                            distance = tokenObj.distanceTo(other);
                        } else {
                            const dx = Math.abs(tokenObj.x - other.x);
                            const dy = Math.abs(tokenObj.y - other.y);
                            distance = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                        }
                        
                        if (distance <= 10) {
                            const alliance = other.actor.system?.details?.alliance;
                            const disp = other.document.disposition;

                            if (alliance === "opposition" || disp === CONST.TOKEN_DISPOSITIONS.HOSTILE) {
                                nearbyEnemies++;
                            } else if (alliance === "party" || disp === CONST.TOKEN_DISPOSITIONS.FRIENDLY) {
                                nearbyFriendlies++;
                            }
                        }
                    }
                }

                let imgPath = t.texture?.src || t.actor?.img || "icons/svg/mystery-man.svg";
                
                if (imgPath && !imgPath.includes("mystery-man") && !imgPath.startsWith("data:") && !imgPath.startsWith("blob:")) {
                    this.imageCache[t.id] = imgPath;
                } else if (this.imageCache[t.id]) {
                    imgPath = this.imageCache[t.id];
                }

                return {
                    id: t.id,
                    name: t.name,
                    img: imgPath,
                    nearbyEnemies: nearbyEnemies,
                    nearbyFriendlies: nearbyFriendlies
                };
            });
        }

        const hasFocus = (actor?.system?.resources?.focus?.max || 0) > 0;
        const hasSpell = (spellName) => {
            const searchStr = spellName.toLowerCase().trim();
            const searchSlug = searchStr.replace(/\s+/g, '-');
            return actor?.items.some(i => 
                ["spell", "feat", "action"].includes(i.type) && 
                (i.name.toLowerCase().trim() === searchStr || i.system?.slug === searchSlug)
            ) || false;
        };
        const hasPuppeteer = actor?.items.some(i => i.name.toLowerCase().includes("puppeteer") || (i.system?.slug && i.system.slug.includes("puppeteer"))) || false;
        const consumeUsed = actor?.getFlag("necromancer-thrall-helper", "consumeThrallUsed") || false;
        const currentFP = actor?.system?.resources?.focus?.value || 0;
        
        let consumeText = "Consume Thrall";
        let consumeDisabled = false;

        if (consumeUsed) {
            consumeText = "Consume Thrall (Used Today)";
            consumeDisabled = true;
        } else if (currentFP > 0) {
            consumeText = "Consume Thrall (Requires 0 FP)";
            consumeDisabled = true;
        }

        const tendrilsSpell = actor?.items.find(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("bloody tendrils") || (i.system?.slug && i.system.slug.includes("bloody-tendrils"))));
        let tendrilCount = 0;
        if (tendrilsSpell) {
            const spellRank = Math.ceil((actor?.level || 1) / 2);
            tendrilCount = 3 + Math.floor(Math.max(0, spellRank - 3) / 3);
        }

        const hasBoneBurst = actor?.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("bone burst") || (i.system?.slug && i.system.slug.includes("bone-burst")))) || false;
        const hasCollateral = actor?.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("collateral reinforcement") || (i.system?.slug && i.system.slug.includes("collateral-reinforcement")))) || false;
        const hasReclaimPower = actor?.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("reclaim power") || (i.system?.slug && i.system.slug.includes("reclaim-power")))) || false;
        const hasZombieHorde = actor?.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("zombie horde") || (i.system?.slug && i.system.slug.includes("zombie-horde")))) || false;

        const hasMuscleBarrier = hasSpell("Muscle Barrier"); 
        const hasBonyBarrage = hasSpell("Bony Barrage");
        const hasSongOfTheSoul = hasSpell("Song of the Soul");
        const hasHallowedEarth = actor?.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("hallowed earth") || (i.system?.slug && i.system.slug.includes("hallowed-earth")))) || false;
        const hasCorruptedGround = actor?.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("corrupted ground") || (i.system?.slug && i.system.slug.includes("corrupted-ground")))) || false;

        const isHallowedActive = actor?.items.some(i => i.type === "effect" && i.name === "Effect: Hallowed Earth") || false;
        const isCorruptedActive = actor?.items.some(i => i.type === "effect" && i.name === "Effect: Corrupted Ground") || false;
        const hasDeathlyScream = hasSpell("Deathly Scream");

        const activeHordes = canvas.scene?.regions?.filter(r => r.getFlag("necromancer-thrall-helper", "masterId") === this.necroId && r.getFlag("necromancer-thrall-helper", "hordeId")) || [];

        return {
            hasDeathlyScream: hasDeathlyScream,
            hasSongOfTheSoul: hasSongOfTheSoul,
            actorName: actor?.name || "Necromancer",
            actorLevel: actor?.level || 1,
            hasBonyBarrage: hasBonyBarrage,
            thrallDamage: damageScale,
            activeThralls: activeThralls,
            map0Active: mapPenalty === 0 ? "active" : "",
            map5Active: mapPenalty === -5 ? "active" : "",
            map10Active: mapPenalty === -10 ? "active" : "",
            hasNecroticBomb: hasSpell("Necrotic Bomb"),
            hasLifeTap: hasSpell("Life Tap"),
            hasBloodInfusion: hasSpell("Blood Infusion"),
            hasBoneSpear: hasSpell("Bone Spear"),
            hasDeadWeight: hasSpell("Dead Weight"),
            hasPuppeteer: hasPuppeteer,
            consumeText: consumeText,
            consumeDisabled: consumeDisabled,
            hasBloodyTendrils: !!tendrilsSpell,
            tendrilCount: tendrilCount,
            hasBoneBurst: hasBoneBurst,
            hasCollateralReinforcement: hasCollateral,
            hasReclaimPower: hasReclaimPower,
            hasZombieHorde: hasZombieHorde,
            hasMuscleBarrier: hasMuscleBarrier, 
            hasHallowedEarth: hasHallowedEarth,
            hasCorruptedGround: hasCorruptedGround,
            isHallowedActive: isHallowedActive,
            isCorruptedActive: isCorruptedActive,
            activeHordeCount: activeHordes.length
        };
    }

    /** @override */
    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;

        const dropdowns = html.querySelectorAll(".action-dropdown");
        dropdowns.forEach(dropdown => {
            const row = dropdown.closest(".thrall-row");
            if (row) {
                const tokenId = row.dataset.tokenId;
                if (this.actionStates[tokenId]) {
                    dropdown.value = this.actionStates[tokenId];
                }
                dropdown.addEventListener("change", (e) => {
                    this.actionStates[tokenId] = e.target.value;
                });
            }
        });
        
        const hallowedBtn = html.querySelector(".hallowed-btn");
        if (hallowedBtn) {
            hallowedBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor) return;

                const existing = actor.items.find(i => i.type === "effect" && i.name === "Effect: Hallowed Earth");
                if (existing) {
                    await existing.delete();
                    ui.notifications.info("Hallowed Earth dismissed.");
                } else {
                    const effectData = {
                        name: "Effect: Hallowed Earth",
                        type: "effect",
                        img: "icons/magic/light/explosion-star-glow-yellow.webp",
                        system: {
                            duration: { value: 1, unit: "minutes", expiry: "turn-start" },
                            description: { value: "Aura of holy vitality." },
                            rules: [{ key: "Aura", radius: 10, colors: { border: "#ffd700", fill: "#ffd70033" } }]
                        }
                    };
                    await actor.createEmbeddedDocuments("Item", [effectData]);
                    ui.notifications.info("Hallowed Earth activated.");
                }
                this.render({ force: false });
            });
        }

        const corruptedBtn = html.querySelector(".corrupted-btn");
        if (corruptedBtn) {
            corruptedBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor) return;

                const existing = actor.items.find(i => i.type === "effect" && i.name === "Effect: Corrupted Ground");
                if (existing) {
                    await existing.delete();
                    ui.notifications.info("Corrupted Ground dismissed.");
                } else {
                    const effectData = {
                        name: "Effect: Corrupted Ground",
                        type: "effect",
                        img: "icons/magic/death/skull-horned-horns-purple.webp",
                        system: {
                            duration: { value: 1, unit: "minutes", expiry: "turn-start" },
                            description: { value: "Aura of unholy void." },
                            rules: [{ key: "Aura", radius: 10, colors: { border: "#8a2be2", fill: "#8a2be233" } }]
                        }
                    };
                    await actor.createEmbeddedDocuments("Item", [effectData]);
                    ui.notifications.info("Corrupted Ground activated.");
                }
                this.render({ force: false });
            });
        }

        const sustainBtn = html.querySelector(".sustain-horde-btn");
        if (sustainBtn) {
            sustainBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!canvas.scene || !actor) return;
                
                const hordes = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "masterId") === this.necroId && r.getFlag("necromancer-thrall-helper", "hordeId"));
                if (hordes.length === 0) return;
                
                const horde = hordes[0];
                const shape = horde.shapes[0];
                if (!shape) return;

                const gridDist = canvas.scene.grid.distance;
                const gridSize = canvas.scene.grid.size;

                ui.notifications.info("Click the canvas to Sustain and move the Zombie Horde. Right-click to cancel.");
                document.body.style.cursor = "crosshair";
                canvas.app.view.style.cursor = "crosshair";

                const ghost = new PIXI.Graphics();
                ghost.beginFill(0x228b22, 0.4);
                ghost.lineStyle(2, 0x006400, 0.8);
                ghost.drawCircle(0, 0, shape.radiusX);
                ghost.endFill();
                ghost.zIndex = 1000;
                ghost.position.set(-1000, -1000);
                canvas.tokens.addChild(ghost);

                const updateGhost = (event) => {
                    const position = event.data.getLocalPosition(canvas.app.stage);
                    let targetX = position.x;
                    let targetY = position.y;
                    if (canvas.grid.getCenterPoint) {
                        const snapped = canvas.grid.getCenterPoint(position);
                        targetX = snapped.x;
                        targetY = snapped.y;
                    }
                    ghost.position.set(targetX, targetY);
                };

                canvas.stage.on("pointermove", updateGhost);

                const cleanUp = () => {
                    document.body.style.cursor = "";
                    canvas.app.view.style.cursor = "";
                    canvas.stage.off("pointermove", updateGhost);
                    ghost.destroy();
                };

                const interactionHandler = async (event) => {
                    if (event.data.button !== 0 && event.data.button !== 2) {
                        canvas.stage.once("pointerdown", interactionHandler);
                        return;
                    }

                    if (event.data.button === 2) {
                        ui.notifications.info("Movement cancelled.");
                        cleanUp();
                        return;
                    }

                    const position = event.data.getLocalPosition(canvas.app.stage);
                    let targetX = position.x;
                    let targetY = position.y;
                    if (canvas.grid.getCenterPoint) {
                        const snapped = canvas.grid.getCenterPoint(position);
                        targetX = snapped.x;
                        targetY = snapped.y;
                    }

                    let newRadius = shape.radiusX;

                    const thralls = canvas.scene.tokens.filter(t => {
                        if (t.flags?.["necromancer-thrall-helper"]?.masterId !== actor.id) return false;
                        
                        const tCenterX = t.x + (t.width * gridSize) / 2;
                        const tCenterY = t.y + (t.height * gridSize) / 2;
                        
                        const dx = tCenterX - targetX;
                        const dy = tCenterY - targetY;
                        return Math.sqrt(dx*dx + dy*dy) <= shape.radiusX;
                    });

                    if (thralls.length > 0) {
                        const incrementPixels = (5 / gridDist) * gridSize;
                        const maxPixels = horde.getFlag("necromancer-thrall-helper", "maxPixels") || ((30 / gridDist) * gridSize);
                        
                        newRadius += (incrementPixels * thralls.length);
                        if (newRadius > maxPixels) newRadius = maxPixels;
                        
                        for (const t of thralls) await t.delete();

                        if (newRadius > shape.radiusX) {
                            ChatMessage.create({
                                speaker: ChatMessage.getSpeaker({ actor: actor }),
                                content: `<p><strong>Zombie Horde Feasts!</strong> By moving over its own thralls, the horde consumes ${thralls.length} of them instantly, swelling its radius to ${Math.round((newRadius / gridSize) * gridDist)} feet!</p>`
                            });
                        }
                    }

                    await horde.update({
                        shapes: [{
                            type: "ellipse", hole: false, x: targetX, y: targetY,
                            radiusX: newRadius, radiusY: newRadius, rotation: 0
                        }]
                    });

                    const hordeId = horde.getFlag("necromancer-thrall-helper", "hordeId");
                    const drawing = canvas.scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "hordeId") === hordeId);
                    if (drawing) {
                        await drawing.update({
                            shape: { type: "e", width: newRadius * 2, height: newRadius * 2 },
                            x: targetX - newRadius,
                            y: targetY - newRadius
                        });
                    }

                    cleanUp();
                };

                canvas.stage.once("pointerdown", interactionHandler);
            });
        }

        const dismissHordeBtn = html.querySelector(".dismiss-horde-btn");
        if (dismissHordeBtn) {
            dismissHordeBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                if (!canvas.scene) return;
                const hordes = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "masterId") === this.necroId && r.getFlag("necromancer-thrall-helper", "hordeId"));
                for (const h of hordes) {
                    const hId = h.getFlag("necromancer-thrall-helper", "hordeId");
                    const drawing = canvas.scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "hordeId") === hId);
                    if (drawing) await drawing.delete();
                    await h.delete();
                }
                ui.notifications.info("Zombie Horde dismissed.");
                this.render({ force: false });
            });
        }

        html.addEventListener("pointerup", () => {
            if (!this.position) return;
            localStorage.setItem(`necro-deck-bounds-${game.user.id}`, JSON.stringify({
                left: this.position.left,
                top: this.position.top,
                width: this.position.width,
                height: this.position.height
            }));
        });
        
        const editPortfolioBtn = html.querySelector(".edit-portfolio-btn");
        if (editPortfolioBtn) {
            editPortfolioBtn.addEventListener("click", (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId);
                if (!actor) {
                    ui.notifications.warn("No Necromancer found!");
                    return;
                }
                new PortfolioEditor(actor).render(true);
            });
        }

        const reclaimBtn = html.querySelector(".reclaim-btn");
        if (reclaimBtn) {
            reclaimBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor || !canvas.scene) return;

                const necroTokens = actor.getActiveTokens();
                if (necroTokens.length === 0) return ui.notifications.warn("Necromancer token not found on the canvas.");
                const necroToken = necroTokens[0];

                const hasConjurer = actor.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("conjurer of corpses") || (i.system?.slug && i.system.slug.includes("conjurer-of-corpses"))));

                const allThralls = canvas.scene.tokens.filter(t => {
                    const customMasterId = t.flags?.["necromancer-thrall-helper"]?.masterId;
                    if (customMasterId && customMasterId === this.necroId) return true;
                    if (hasConjurer && t.actor) {
                        const traits = t.actor.system?.traits?.value || [];
                        const isUndead = traits.includes("undead") || traits.some(tr => typeof tr === "string" && tr.toLowerCase() === "undead");
                        if (isUndead) {
                            const pf2eMasterId = t.actor.getFlag("pf2e", "master")?.id;
                            if (pf2eMasterId === this.necroId) return true;
                            if (t.name.includes(actor.name)) return true;
                        }
                    }
                    return false;
                });

                const eligibleThralls = allThralls.filter(t => {
                    let dist = 999;
                    if (typeof necroToken.distanceTo === "function") {
                        dist = necroToken.distanceTo(t.object);
                    } else {
                        const dx = Math.abs(necroToken.x - t.x);
                        const dy = Math.abs(necroToken.y - t.y);
                        dist = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                    }
                    return dist <= 60;
                });

                if (eligibleThralls.length === 0) return ui.notifications.warn("No eligible thralls within 60 feet.");

                let checkboxes = "";
                eligibleThralls.forEach((t, index) => {
                    checkboxes += `<div style="display: flex; align-items: center; margin-bottom: 5px;">
                        <input type="checkbox" id="reclaim-thrall-${index}" value="${t.id}" class="reclaim-checkbox" style="margin-right: 10px;">
                        <label for="reclaim-thrall-${index}" style="display: flex; align-items: center; cursor: pointer;">
                            <img src="${t.texture?.src}" width="30" height="30" style="border: none; margin-right: 10px; border-radius: 4px; object-fit: cover;">
                            ${t.name}
                        </label>
                    </div>`;
                });

                const formHtml = `
                    <form id="reclaim-form" style="margin-bottom: 10px;">
                        <p>Select up to 3 thralls to destroy and siphon their essence (within 60 feet).</p>
                        <div style="max-height: 200px; overflow-y: auto; border: 1px solid #333; padding: 5px; background: rgba(0,0,0,0.2); border-radius: 4px;">
                            ${checkboxes}
                        </div>
                    </form>
                `;

                new Dialog({
                    title: "Reclaim Power",
                    content: formHtml,
                    buttons: {
                        reclaim: {
                            icon: '<i class="fas fa-heart-crack"></i>',
                            label: "Reclaim",
                            callback: async (dialogHtml) => {
                                const selectedIds = [];
                                dialogHtml.find('.reclaim-checkbox:checked').each((i, cb) => selectedIds.push(cb.value));

                                if (selectedIds.length === 0) return ui.notifications.warn("You must select at least one thrall.");

                                const necroLevel = actor.level || 1;
                                const hpGained = selectedIds.length * necroLevel;

                                const currentHP = actor.system.attributes.hp.value;
                                const maxHP = actor.system.attributes.hp.max;
                                const actualHealed = Math.min(maxHP - currentHP, hpGained);
                                await actor.update({ "system.attributes.hp.value": currentHP + actualHealed });

                                const tokensToDelete = selectedIds.map(id => canvas.scene.tokens.get(id));
                                const names = tokensToDelete.map(t => t.name).join(", ");
                                for (const tDoc of tokensToDelete) await tDoc.delete();

                                if (actualHealed > 0 && canvas.ready && necroToken) {
                                    canvas.interface.createScrollingText(necroToken.center, `+${actualHealed} HP`, { anchor: CONST.TEXT_ANCHOR_POINTS.TOP, fill: 0x4ade80, direction: CONST.TEXT_ANCHOR_POINTS.UP });
                                }

                                let chatContent = `<p><b>${actor.name}</b> draws the life force from their creations, destroying <b>${names}</b> to recover <b>${actualHealed} HP</b>.</p>`;

                                if (selectedIds.length === 3) {
                                    const eligibleConditions = ["clumsy", "enfeebled", "frightened", "sickened", "stupefied"];
                                    const activeConditions = actor.items.filter(i => i.type === "condition" && eligibleConditions.includes(i.system.slug));

                                    if (activeConditions.length > 0) {
                                        let condOptions = "";
                                        activeConditions.forEach(c => condOptions += `<option value="${c.system.slug}">${c.name}</option>`);
                                        
                                        await new Promise(resolve => {
                                            new Dialog({
                                                title: "Reduce Condition",
                                                content: `<p>You destroyed 3 thralls! Select a condition to decrease by 1:</p><form><select id="cond-select">${condOptions}</select></form>`,
                                                buttons: {
                                                    reduce: {
                                                        label: "Reduce",
                                                        callback: async (cHtml) => {
                                                            const selectedSlug = cHtml.find("#cond-select").val();
                                                            await actor.decreaseCondition(selectedSlug);
                                                            chatContent += `<p style="color: #4ade80; font-weight: bold;">Condition Reduced: ${selectedSlug.charAt(0).toUpperCase() + selectedSlug.slice(1)}</p>`;
                                                            resolve();
                                                        }
                                                    },
                                                    skip: {
                                                        label: "Skip",
                                                        callback: () => resolve()
                                                    }
                                                },
                                                default: "reduce"
                                            }).render(true);
                                        });
                                    }
                                }

                                await ChatMessage.create({
                                    speaker: ChatMessage.getSpeaker({ actor: actor }),
                                    flavor: `<strong>Reclaim Power</strong>`,
                                    content: chatContent
                                });
                            }
                        },
                        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                    },
                    default: "reclaim",
                    render: (dialogHtml) => {
                        dialogHtml.find('.reclaim-checkbox').on('change', function() {
                            const checkedCount = dialogHtml.find('.reclaim-checkbox:checked').length;
                            if (checkedCount > 3) {
                                this.checked = false;
                                ui.notifications.warn("You can only reclaim up to 3 thralls at a time.");
                            }
                        });
                    }
                }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
            });
        }


        const collateralBtn = html.querySelector(".collateral-btn");
        if (collateralBtn) {
            collateralBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor || !canvas.scene) return;

                const hasConjurer = actor.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("conjurer of corpses") || (i.system?.slug && i.system.slug.includes("conjurer-of-corpses"))));

                const thrallTokens = canvas.scene.tokens.filter(t => {
                    const customMasterId = t.flags?.["necromancer-thrall-helper"]?.masterId;
                    if (customMasterId && customMasterId === this.necroId) return true;

                    if (hasConjurer && t.actor) {
                        const traits = t.actor.system?.traits?.value || [];
                        const isUndead = traits.includes("undead") || traits.some(tr => typeof tr === "string" && tr.toLowerCase() === "undead");
                        
                        if (isUndead) {
                            const pf2eMasterId = t.actor.getFlag("pf2e", "master")?.id;
                            if (pf2eMasterId === this.necroId) return true;
                            if (t.name.includes(actor.name)) return true;
                        }
                    }
                    return false;
                });
                
                if (thrallTokens.length === 0) {
                    return ui.notifications.warn("No thralls on the battlefield to reinforce.");
                }

                const effectData = {
                    name: "Collateral Reinforcement",
                    type: "effect",
                    img: "icons/magic/defensive/shield-barrier-flaming-pentagon-purple-orange.webp",
                    system: {
                        duration: { value: 1, unit: "rounds", expiry: "turn-start" },
                        description: { value: "Immune to area and splash damage." },
                        rules: [
                            { key: "Immunity", type: "area-damage" },
                            { key: "Immunity", type: "area" },
                            { key: "Immunity", type: "splash" }
                        ]
                    }
                };

                for (const tDoc of thrallTokens) {
                    if (tDoc.actor) {
                        await tDoc.actor.createEmbeddedDocuments("Item", [effectData]);
                    }
                }

                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor: actor }),
                    flavor: `<strong>Collateral Reinforcement</strong>`,
                    content: `<p><b>${actor.name}</b> thickens the bone and flesh of their minions! All active thralls are immune to area and splash damage for 1 round.</p>`
                });
            });
        }

        const mapPips = html.querySelectorAll(".map-pip");
        mapPips.forEach(pip => {
            pip.addEventListener("click", (e) => {
                this.currentMap = parseInt(e.currentTarget.dataset.value, 10);
                this.render(); 
            });
        });

        const executeBtns = html.querySelectorAll(".execute-btn");
        executeBtns.forEach(btn => {
            btn.addEventListener("click", async (e) => {
                e.preventDefault();
                const row = e.currentTarget.closest(".thrall-row");
                const tokenId = row.dataset.tokenId;
                const action = row.querySelector(".action-dropdown").value;
                const actor = game.actors.get(this.necroId) || game.user.character;
                
                console.log(`Necromancer Helper | Execute clicked! Action: [${action}] | Token: [${tokenId}]`);

                if (!actor || !canvas.scene) {
                    return ui.notifications.error("Execution Failed: Necromancer or Canvas not found.");
                }
                const tokenDoc = canvas.scene.tokens.get(tokenId);
                if (!tokenDoc) {
                    return ui.notifications.error("Execution Failed: Thrall token not found on the canvas.");
                }

                const necroLevel = actor.level || 1;
                const baseDice = Math.max(1, Math.floor((necroLevel - 1) / 4) + 1);

                const rollNativeStrike = async (eventObj, isKamikaze = false, chargeDice = 0, spellRank = 0) => {
                    const mapPenalty = this.currentMap !== undefined ? this.currentMap : 0;
                    let variantIndex = 0;
                    if (mapPenalty === -5) variantIndex = 1;
                    if (mapPenalty === -10) variantIndex = 2;

                    let existingWeapon = tokenDoc.actor.items.find(i => i.type === "melee" && i.name.includes("Thrall Strike"));
                    if (!existingWeapon) {
                        let attackMod = Math.floor(necroLevel * 1.5); 
                        const spellcasting = actor.spellcasting?.filter(s => s.statistic)?.sort((a,b) => b.statistic.check.mod - a.statistic.check.mod)[0];
                        if (spellcasting) attackMod = spellcasting.statistic.check.mod;

                        const weaponData = {
                            name: "Thrall Strike",
                            type: "melee", 
                            img: "systems/pf2e/icons/spells/ghoul-touch.webp",
                            system: {
                                weaponType: { value: "melee" },
                                bonus: { value: attackMod },
                                damageRolls: {
                                    base: {
                                        damage: `${baseDice}d6`,
                                        damageType: "bludgeoning" 
                                    }
                                },
                                traits: { value: ["magical"] }
                            }
                        };
                        await tokenDoc.actor.createEmbeddedDocuments("Item", [weaponData]);
                        await new Promise(resolve => setTimeout(resolve, 150));
                    }

                    let addedEffectIds = [];
                    if (chargeDice > 0) {
                        const rules = [{
                            key: "DamageDice",
                            selector: "strike-damage",
                            diceNumber: chargeDice,
                            dieSize: "d6",
                            slug: "thrall-charge-dice"
                        }];

                        if (isKamikaze) {
                            rules.push({
                                key: "FlatModifier",
                                selector: "strike-damage",
                                value: spellRank,
                                type: "status",
                                slug: "thrall-charge-status"
                            });
                        }

                        const effectData = {
                            type: "effect",
                            name: isKamikaze ? "Thrall Charge (Kamikaze)" : "Thrall Charge",
                            img: "icons/magic/death/undead-ghost-scream-teal.webp",
                            system: {
                                level: { value: spellRank },
                                duration: { value: 1, unit: "rounds", expiry: "turn-end" },
                                rules: rules
                            }
                        };
                        
                        const createdEffects = await tokenDoc.actor.createEmbeddedDocuments("Item", [effectData]);
                        addedEffectIds = createdEffects.map(effect => effect.id);
                        await new Promise(resolve => setTimeout(resolve, 150));
                    }

                    const actions = tokenDoc.actor?.system?.actions;
                    const strike = actions?.find(a => a.item?.name?.includes("Thrall Strike") || a.slug?.includes("thrall-strike"));

                    if (!strike || !strike.variants || !strike.variants[variantIndex]) {
                        ui.notifications.warn(`Execution failed. ${tokenDoc.name} could not draw its weapon.`);
                        return;
                    }

                    await strike.variants[variantIndex].roll({ event: eventObj });

                    if (this.currentMap === undefined || this.currentMap === 0) {
                        this.currentMap = -5;
                    } else if (this.currentMap === -5) {
                        this.currentMap = -10;
                    }
                    this.render(false); 
                    
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
                                    await tokenDoc.delete();
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
                };

                switch (action) {
                    case "zombie-horde": {
                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                        if (currentFocus === 0) {
                            ui.notifications.warn("You have no Focus Points to cast Zombie Horde!");
                            break;
                        }

                        const necroTokens = actor.getActiveTokens();
                        if (necroTokens.length > 0) {
                            const necroToken = necroTokens[0];
                            let distanceToNecro = 999;
                            if (typeof tokenDoc.object.distanceTo === "function") {
                                distanceToNecro = tokenDoc.object.distanceTo(necroToken);
                            } else {
                                const dx = Math.abs(tokenDoc.x - necroToken.x);
                                const dy = Math.abs(tokenDoc.y - necroToken.y);
                                distanceToNecro = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                            }
                            if (distanceToNecro > 30) {
                                ui.notifications.warn("You must be within 30 feet of the thrall to cast Zombie Horde.");
                                break;
                            }
                        }

                        await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                        const spellRank = Math.max(3, Math.ceil(actor.level / 2));
                        const diceCount = spellRank; 

                        let exactDC = 10 + Math.floor(actor.level * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) exactDC = maxDC;
                        }
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) exactDC = actor.system.attributes.classDC.dc.value;

                        let zhSpell = actor.items.find(i => ["spell", "feat", "action"].includes(i.type) && i.name === "Zombie Horde");
                        const spellSystemData = {
                            level: { value: spellRank },
                            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                            tradition: { value: "divine" },
                            defense: { save: { statistic: "fortitude", basic: true, dc: { value: exactDC } } },
                            damage: { "0": { formula: `${diceCount}d4`, type: "bludgeoning" } }
                        };

                        if (!zhSpell) {
                            const spellData = { name: "Zombie Horde", type: "spell", img: "icons/magic/death/undead-zombies-horde-green.webp", system: spellSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            zhSpell = created[0];
                        } else {
                            await zhSpell.update({ system: spellSystemData });
                        }

                        await zhSpell.setFlag("aoe-easy-resolve", "ignoreAoE", true);
                        await zhSpell.setFlag("aoe-easy-resolve", "useCustomDamage", true);
                        await zhSpell.setFlag("aoe-easy-resolve", "customDamage", `${diceCount}d4`);
                        await zhSpell.setFlag("aoe-easy-resolve", "customDamageType", "bludgeoning");
                        await zhSpell.setFlag("aoe-easy-resolve", "useOverride", true);
                        await zhSpell.setFlag("aoe-easy-resolve", "saveDC", exactDC);
                        await zhSpell.setFlag("aoe-easy-resolve", "saveType", "fortitude");

                        new Dialog({
                            title: "Zombie Horde",
                            content: `<p>Transform <b>${tokenDoc.name}</b> into a Zombie Horde dealing <b>${diceCount}d4 bludgeoning</b> damage?</p>`,
                            buttons: {
                                spawn: {
                                    icon: '<i class="fas fa-hands-helping"></i>',
                                    label: "Spawn Horde",
                                    callback: async () => {
                                        const gridDist = canvas.scene?.grid?.distance || 5;
                                        const gridSize = canvas.scene?.grid?.size || 100;
                                        const pixels = (10 / gridDist) * gridSize;
                                        
                                        const centerX = tokenDoc.x + (tokenDoc.width * gridSize) / 2;
                                        const centerY = tokenDoc.y + (tokenDoc.height * gridSize) / 2;

                                        await tokenDoc.update({
                                            name: "Zombie Horde",
                                            "texture.src": "icons/magic/death/undead-zombies-horde-green.webp",
                                            "flags.necromancer-thrall-helper.isHordeAnchor": true,
                                            "flags.necromancer-thrall-helper.hordeRadius": 10
                                        });

                                        const regionData = {
                                            name: `Zombie Horde`,
                                            color: "#228b22",
                                            shapes: [{
                                                type: "ellipse",
                                                hole: false,
                                                x: centerX,
                                                y: centerY,
                                                radiusX: pixels,
                                                radiusY: pixels,
                                                rotation: 0
                                            }],
                                            elevation: { bottom: -1000, top: 1000 },
                                            behaviors: [{
                                                name: "AoE Easy Resolve Controller",
                                                type: "executeScript",
                                                system: {
                                                    events: ["tokenTurnStart"],
                                                    source: `if (game.modules.get('aoe-easy-resolve')?.api?.handleRegionEvent) {\n  game.modules.get('aoe-easy-resolve').api.handleRegionEvent(event, '${zhSpell.uuid}');\n}`
                                                }
                                            }],
                                            flags: {
                                                "necromancer-thrall-helper": { anchorId: tokenDoc.id },
                                                "aoe-easy-resolve": { 
                                                    isAoERegion: true, 
                                                    originItemUuid: zhSpell.uuid,
                                                    saveDC: exactDC
                                                }
                                            }
                                        };

                                        const drawingData = {
                                            author: game.user.id,
                                            shape: { type: "e", width: pixels * 2, height: pixels * 2 },
                                            x: centerX - pixels,
                                            y: centerY - pixels,
                                            fillType: 1,
                                            fillColor: "#228b22",
                                            fillAlpha: 0.35,
                                            strokeWidth: 3,
                                            strokeColor: "#006400",
                                            strokeAlpha: 0.8,
                                            flags: {
                                                "necromancer-thrall-helper": { anchorId: tokenDoc.id }
                                            }
                                        };

                                        await canvas.scene.createEmbeddedDocuments("Region", [regionData]);
                                        await canvas.scene.createEmbeddedDocuments("Drawing", [drawingData]);

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            flavor: `<strong>Zombie Horde</strong>`,
                                            content: `<p><b>${actor.name}</b> rips open the earth, unleashing a horde of ravenous zombies! The area is difficult terrain and deals damage to enemies beginning their turn inside it.</p>`
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "spawn"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "deathly-scream": {
                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                        if (currentFocus === 0) {
                            ui.notifications.warn("You have no Focus Points to cast Deathly Scream!");
                            break;
                        }

                        const necroTokens = actor.getActiveTokens();
                        if (necroTokens.length > 0) {
                            const necroToken = necroTokens[0];
                            let distanceToNecro = 999;
                            if (typeof tokenDoc.object?.distanceTo === "function") {
                                distanceToNecro = tokenDoc.object.distanceTo(necroToken);
                            } else {
                                const dx = Math.abs(tokenDoc.x - necroToken.x);
                                const dy = Math.abs(tokenDoc.y - necroToken.y);
                                distanceToNecro = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                            }
                            if (distanceToNecro > 30) {
                                ui.notifications.warn("You must be within 30 feet of the thrall to cast Deathly Scream.");
                                break;
                            }
                        }

                        const spellRank = Math.max(1, Math.ceil((actor.level || 1) / 2));
                        const damageDice = spellRank; 
                        
                        let exactDC = 10 + Math.floor((actor.level || 1) * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) exactDC = maxDC;
                        }
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) {
                            exactDC = actor.system.attributes.classDC.dc.value;
                        }

                        let dsSpell = actor.items.find(i => i.type === "spell" && i.name === "Deathly Scream");
                        const spellSystemData = {
                            level: { value: spellRank },
                            traits: { value: ["necromancer", "uncommon", "auditory", "concentrate", "emotion", "fear", "focus", "mental"] },
                            tradition: { value: "divine" },
                            area: { type: "emanation", value: 5 },
                            defense: { save: { statistic: "will", basic: true, dc: { value: exactDC } } },
                            damage: { "0": { formula: `${damageDice}d4`, type: "mental" } }
                        };

                        if (!dsSpell) {
                            const spellData = { name: "Deathly Scream", type: "spell", img: "icons/magic/death/undead-ghost-scream-teal.webp", system: spellSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            dsSpell = created[0];
                        } else {
                            await dsSpell.update({ system: spellSystemData });
                        }

                        await dsSpell.setFlag("aoe-easy-resolve", "useCustomDamage", true);
                        await dsSpell.setFlag("aoe-easy-resolve", "customDamage", `${damageDice}d4`);
                        await dsSpell.setFlag("aoe-easy-resolve", "customDamageType", "mental");
                        await dsSpell.setFlag("aoe-easy-resolve", "useOverride", true);
                        await dsSpell.setFlag("aoe-easy-resolve", "saveDC", exactDC);
                        await dsSpell.setFlag("aoe-easy-resolve", "saveType", "will");
                        await dsSpell.setFlag("aoe-easy-resolve", "allyBaseEffect", "standard");
                        await dsSpell.setFlag("aoe-easy-resolve", "enemyBaseEffect", "standard");

                        new Dialog({
                            title: "Deathly Scream",
                            content: `<p>Force <b>${tokenDoc.name}</b> to emit a Deathly Scream? (5-foot emanation, <b>${damageDice}d4 mental</b> damage)</p>`,
                            buttons: {
                                scream: {
                                    icon: '<i class="fas fa-volume-up"></i>',
                                    label: "Scream!",
                                    callback: async () => {
                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                                        if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        
                                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
                                        const gridDist = canvas.scene?.grid?.distance || 5;
                                        const tokenRadiusFeet = ((tokenDoc.width || 1) * gridDist) / 2;
                                        const totalEmanationFeet = 5 + tokenRadiusFeet;
                                        
                                        // 1. Manually scoop up the targets, strictly excluding the screamer
                                        const targetsData = {};
                                        const validTargets = canvas.tokens.placeables.filter(t => {
                                            if (t.id === tokenDoc.id) return false; 
                                            if (!t.actor) return false;
                                            if (t.actor.system?.attributes?.hp?.value <= 0) return false; 

                                            let dist = 999;
                                            if (typeof tokenDoc.object?.distanceTo === "function") {
                                                dist = tokenDoc.object.distanceTo(t);
                                            } else {
                                                const targetCenter = t.center || { x: t.x, y: t.y };
                                                const dx = Math.abs(tokenCenter.x - targetCenter.x);
                                                const dy = Math.abs(tokenCenter.y - targetCenter.y);
                                                dist = (Math.max(dx, dy) / canvas.grid.size) * gridDist;
                                            }
                                            return dist <= 5; // 5-foot emanation threshold
                                        });

                                        validTargets.forEach(t => {
                                            targetsData[t.document.id] = {
                                                id: t.document.id,
                                                name: t.document.name,
                                                img: t.document.texture.src,
                                                hasRolled: false,
                                                rollTotal: null,
                                                degreeOfSuccess: null,
                                                isHealing: false,
                                                isImmune: false,
                                                hasApplied: false
                                            };
                                        });

                                        if (canvas.ready && tokenDoc.object) {
                                            canvas.interface.createScrollingText(tokenDoc.object.center, `DEATHLY SCREAM!`, { anchor: CONST.TEXT_ANCHOR_POINTS.TOP, fill: 0x00ffff, direction: CONST.TEXT_ANCHOR_POINTS.UP, fontSize: 32 });
                                        }

                                        // 2. Drop the visual template and set a 20-second self-destruct
                                        const [template] = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{
                                            t: "circle",
                                            user: game.user.id,
                                            x: tokenCenter.x,
                                            y: tokenCenter.y,
                                            distance: totalEmanationFeet,
                                            fillColor: "#00ffff"
                                        }]);

                                        setTimeout(() => {
                                            if (canvas.scene && canvas.scene.templates.has(template.id)) template.delete();
                                        }, 20000);

                                        if (Object.keys(targetsData).length === 0) {
                                            ui.notifications.info("The thrall screams, but no targets were caught in the blast!");
                                            return; 
                                        }

                                        // 3. Force aoe-easy-resolve to generate its premium chat card
                                        const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
                                        const htmlContent = await renderTemplate(templatePath, {
                                            targets: Object.values(targetsData),
                                            itemName: "Deathly Scream",
                                            saveType: "Will",
                                            saveDC: exactDC
                                        });

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            flavor: `<strong>Deathly Scream</strong>`,
                                            content: htmlContent,
                                            flags: {
                                                "aoe-easy-resolve": {
                                                    templateId: null,
                                                    documentName: "ManualTarget",
                                                    itemUuid: dsSpell.uuid,
                                                    itemName: "Deathly Scream",
                                                    saveType: "will",
                                                    saveDC: exactDC,
                                                    isBasicSave: true,
                                                    targets: targetsData,
                                                    hazardDamage: null,
                                                    isReactive: false,
                                                    originMessageId: null
                                                }
                                            }
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "scream"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "bone-burst": {
                        const necroTokens = actor.getActiveTokens();
                        if (necroTokens.length > 0) {
                            const necroToken = necroTokens[0];
                            let distanceToNecro = 999;
                            if (typeof tokenDoc.object.distanceTo === "function") {
                                distanceToNecro = tokenDoc.object.distanceTo(necroToken);
                            } else {
                                const dx = Math.abs(tokenDoc.x - necroToken.x);
                                const dy = Math.abs(tokenDoc.y - necroToken.y);
                                distanceToNecro = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                            }
                            if (distanceToNecro > 30) {
                                ui.notifications.warn("You must be within 30 feet of the thrall to use Bone Burst.");
                                break;
                            }
                        }

                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
                        const gridDist = canvas.scene?.grid?.distance || 5;
                        const validTargets = Array.from(game.user.targets).filter(t => {
                            let dist = 999;
                            if (typeof tokenDoc.object.distanceTo === "function") {
                                dist = tokenDoc.object.distanceTo(t);
                            } else {
                                const dx = Math.abs(tokenCenter.x - t.center.x);
                                const dy = Math.abs(tokenCenter.y - t.center.y);
                                dist = (Math.max(dx, dy) / canvas.grid.size) * gridDist;
                            }
                            return dist <= 5;
                        });

                        if (validTargets.length !== 1) {
                            ui.notifications.warn("Bone Burst requires exactly one target selected adjacent (within 5 feet) to the thrall.");
                            break;
                        }

                        const targetToken = validTargets[0];
                        const necroLevel = actor.level || 1;
                        
                        let diceCount = 2;
                        if (necroLevel >= 18) diceCount = 4;
                        else if (necroLevel >= 12) diceCount = 3;

                        let exactDC = 10 + Math.floor(necroLevel * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) exactDC = maxDC;
                        }
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) {
                            exactDC = actor.system.attributes.classDC.dc.value;
                        }

                        let bbSpell = actor.items.find(i => ["spell", "feat", "action"].includes(i.type) && i.name === "Bone Burst");
                        const spellSystemData = {
                            level: { value: Math.ceil(necroLevel / 2) },
                            traits: { value: ["necromancer", "occult", "concentrate"] },
                            tradition: { value: "occult" },
                            defense: { save: { statistic: "reflex", basic: true, dc: { value: exactDC } } },
                            damage: { "0": { formula: `${diceCount}d10`, type: "piercing" } }
                        };

                        if (!bbSpell) {
                            const spellData = { name: "Bone Burst", type: "spell", img: "icons/skills/wounds/bone-broken-splinter-white.webp", system: spellSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            bbSpell = created[0];
                        } else {
                            await bbSpell.update({ system: spellSystemData });
                        }

                        await bbSpell.setFlag("aoe-easy-resolve", "useCustomDamage", true);
                        await bbSpell.setFlag("aoe-easy-resolve", "customDamage", `${diceCount}d10`);
                        await bbSpell.setFlag("aoe-easy-resolve", "customDamageType", "piercing");
                        await bbSpell.setFlag("aoe-easy-resolve", "useOverride", true);
                        await bbSpell.setFlag("aoe-easy-resolve", "saveDC", exactDC);
                        await bbSpell.setFlag("aoe-easy-resolve", "saveType", "reflex");
                        await bbSpell.setFlag("aoe-easy-resolve", "allyBaseEffect", "standard");
                        await bbSpell.setFlag("aoe-easy-resolve", "enemyBaseEffect", "standard");

                        new Dialog({
                            title: "Bone Burst",
                            content: `<p>Destroy <b>${tokenDoc.name}</b> in a burst of bone shards at <b>${targetToken.name}</b> for <b>${diceCount}d10 piercing</b> damage?</p>`,
                            buttons: {
                                burst: {
                                    icon: '<i class="fas fa-bone"></i>',
                                    label: "Burst",
                                    callback: async () => {
                                        const targetsData = {};
                                        targetsData[targetToken.document.id] = {
                                            id: targetToken.document.id,
                                            name: targetToken.document.name,
                                            img: targetToken.document.texture.src,
                                            hasRolled: false,
                                            rollTotal: null,
                                            degreeOfSuccess: null,
                                            isHealing: false,
                                            isImmune: false,
                                            hasApplied: false
                                        };

                                        const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
                                        const htmlContent = await renderTemplate(templatePath, {
                                            targets: Object.values(targetsData),
                                            itemName: "Bone Burst",
                                            saveType: "Reflex",
                                            saveDC: exactDC
                                        });

                                        await tokenDoc.delete();

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            content: htmlContent,
                                            flags: {
                                                "aoe-easy-resolve": {
                                                    templateId: null,
                                                    documentName: "ManualTarget",
                                                    itemUuid: bbSpell.uuid,
                                                    itemName: "Bone Burst",
                                                    saveType: "reflex",
                                                    saveDC: exactDC,
                                                    isBasicSave: true,
                                                    targets: targetsData,
                                                    hazardDamage: null,
                                                    isReactive: false,
                                                    originMessageId: null
                                                }
                                            }
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "burst"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "consume-thrall": {
                        const necroTokens = actor.getActiveTokens();
                        if (necroTokens.length > 0) {
                            const necroToken = necroTokens[0];
                            let distance = 999;
                            if (typeof tokenDoc.object.distanceTo === "function") {
                                distance = tokenDoc.object.distanceTo(necroToken);
                            } else {
                                const dx = Math.abs(tokenDoc.x - necroToken.x);
                                const dy = Math.abs(tokenDoc.y - necroToken.y);
                                distance = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                            }
                            if (distance > 30) {
                                ui.notifications.warn("That thrall is beyond 30 feet.");
                                break;
                            }
                        }

                        new Dialog({
                            title: "Consume Thrall",
                            content: `<p>Destroy <b>${tokenDoc.name}</b> to regain 1 Focus Point?</p>`,
                            buttons: {
                                consume: {
                                    icon: '<i class="fas fa-skull"></i>',
                                    label: "Consume",
                                    callback: async () => {
                                        await tokenDoc.delete();
                                        await actor.setFlag("necromancer-thrall-helper", "consumeThrallUsed", true);
                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                                        await actor.update({ "system.resources.focus.value": currentFocus + 1 });
                                        
                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            flavor: `<strong>Consume Thrall</strong>`,
                                            content: `<p><b>${actor.name}</b> consumes the animus of <b>${tokenDoc.name}</b>, regaining 1 Focus Point (restricted to grave spells).</p>`
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "consume"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "dead-weight": {
                        const spellRank = Math.ceil(necroLevel / 2);
                        
                        let exactDC = 10 + Math.floor(necroLevel * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) exactDC = maxDC;
                        }
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) {
                            exactDC = actor.system.attributes.classDC.dc.value;
                        }

                        let dwSpell = actor.items.find(i => ["spell", "feat", "action"].includes(i.type) && i.name === "Dead Weight");
                        const spellSystemData = {
                            level: { value: spellRank },
                            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                            tradition: { value: "divine" },
                            defense: { save: { statistic: "fortitude", basic: false, dc: { value: exactDC } } }
                        };

                        if (!dwSpell) {
                            const spellData = { name: "Dead Weight", type: "spell", img: "icons/magic/death/undead-zombie-glowing-green.webp", system: spellSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            dwSpell = created[0];
                        } else {
                            await dwSpell.update({ system: spellSystemData });
                        }

                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
                        const gridDist = canvas.scene?.grid?.distance || 5;
                        const gridSize = canvas.scene?.grid?.size || 100;
                        const rangePixels = (15 / gridDist) * gridSize;

                        const validTargets = Array.from(game.user.targets).filter(t => {
                            const dist = Math.hypot(t.center.x - tokenCenter.x, t.center.y - tokenCenter.y);
                            return dist <= rangePixels;
                        });

                        if (validTargets.length !== 1) {
                            ui.notifications.warn("Dead Weight requires exactly one target selected on the canvas within 15 feet of the thrall.");
                            break;
                        }

                        const targetToken = validTargets[0];

                        new Dialog({
                            title: "Dead Weight",
                            content: `<p>Hurl <b>${tokenDoc.name}</b> at <b>${targetToken.name}</b> to fuse their flesh together?</p>`,
                            buttons: {
                                hurl: {
                                    icon: '<i class="fas fa-meteor"></i>',
                                    label: "Hurl",
                                    callback: async () => {
                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                                        if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        const targetsData = {};
                                        targetsData[targetToken.document.id] = {
                                            id: targetToken.document.id,
                                            name: targetToken.document.name,
                                            img: targetToken.document.texture.src,
                                            hasRolled: false,
                                            rollTotal: null,
                                            degreeOfSuccess: null,
                                            isHealing: false,
                                            isImmune: false,
                                            hasApplied: false
                                        };

                                        const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
                                        const htmlContent = await renderTemplate(templatePath, {
                                            targets: Object.values(targetsData),
                                            itemName: "Dead Weight",
                                            saveType: "Fortitude",
                                            saveDC: exactDC
                                        });

                                        await tokenDoc.delete();

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            content: htmlContent,
                                            flags: {
                                                "aoe-easy-resolve": {
                                                    templateId: null,
                                                    documentName: "ManualTarget",
                                                    itemUuid: dwSpell.uuid,
                                                    itemName: "Dead Weight",
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
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "hurl"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "bone-spear": {
                        const spellRank = Math.ceil(necroLevel / 2);
                        const damageDice = spellRank * 2;
                        
                        let exactDC = 10 + Math.floor(necroLevel * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) exactDC = maxDC;
                        }
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) {
                            exactDC = actor.system.attributes.classDC.dc.value;
                        }

                        let spearSpell = actor.items.find(i => i.type === "spell" && i.name === "Bone Spear");
                        const spellSystemData = {
                            level: { value: spellRank },
                            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                            tradition: { value: "divine" },
                            area: { type: "line", value: 15 },
                            defense: { save: { statistic: "reflex", basic: true, dc: { value: exactDC } } },
                            damage: { "0": { formula: `${damageDice}d6`, type: "piercing" } }
                        };

                        if (!spearSpell) {
                            const spellData = { name: "Bone Spear", type: "spell", img: "icons/magic/weapons/projectile-spear-bone.webp", system: spellSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            spearSpell = created[0];
                        } else {
                            await spearSpell.update({ system: spellSystemData });
                        }

                        await spearSpell.setFlag("aoe-easy-resolve", "useCustomDamage", true);
                        await spearSpell.setFlag("aoe-easy-resolve", "customDamage", `${damageDice}d6`);
                        await spearSpell.setFlag("aoe-easy-resolve", "customDamageType", "piercing");
                        await spearSpell.setFlag("aoe-easy-resolve", "useOverride", true);
                        await spearSpell.setFlag("aoe-easy-resolve", "saveDC", exactDC);
                        await spearSpell.setFlag("aoe-easy-resolve", "saveType", "reflex");
                        await spearSpell.setFlag("aoe-easy-resolve", "allyBaseEffect", "standard");
                        await spearSpell.setFlag("aoe-easy-resolve", "enemyBaseEffect", "standard");

                        new Dialog({
                            title: "Bone Spear",
                            content: `<p>Shatter <b>${tokenDoc.name}</b> into a 15-foot line of jagged bone for <b>${damageDice}d6 piercing</b> damage?</p>`,
                            buttons: {
                                fire: {
                                    icon: '<i class="fas fa-location-arrow"></i>',
                                    label: "Shatter & Fire",
                                    callback: async () => {
                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                                        if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        
                                        const gridSize = canvas.scene.grid.size;
                                        const originX = tokenDoc.x;
                                        const originY = tokenDoc.y;
                                        const tWidth = tokenDoc.width * gridSize;
                                        const tHeight = tokenDoc.height * gridSize;

                                        await tokenDoc.delete();
                                        
                                        const [marker] = await canvas.scene.createEmbeddedDocuments("Drawing", [{
                                            author: game.user.id,
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
                                        }]);

                                        setTimeout(() => {
                                            if (canvas.scene && canvas.scene.drawings.has(marker.id)) marker.delete();
                                        }, 20000);

                                        await spearSpell.toMessage(e);
                                        ui.notifications.info("Draw your 15-foot line starting from the marked origin point.");
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "fire"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "charge": {
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
                                        await rollNativeStrike(e, false, chargeDice, spellRank);
                                    }
                                },
                                destroy: {
                                    icon: '<i class="fas fa-bomb"></i>',
                                    label: "Charge & Destroy",
                                    callback: async () => {

                                        await rollNativeStrike(e, true, chargeDice, spellRank);
                                    }
                                }
                            },
                            default: "charge"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "blood-infusion": {
                        const spellRank = Math.ceil((actor.level || 1) / 2);
                        
                        let infusionDC = 10 + Math.floor((actor.level || 1) * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) infusionDC = maxDC;
                        }
                        if (infusionDC === 10 && actor.system?.attributes?.classDC?.dc) {
                            infusionDC = actor.system.attributes.classDC.dc.value;
                        }

                        let infusionSpell = actor.items.find(i => i.type === "spell" && i.name === "Blood Infusion");
                        const infusionSystemData = {
                            level: { value: spellRank },
                            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                            tradition: { value: "divine" },
                            defense: { save: { statistic: "fortitude", basic: false, dc: { value: infusionDC } } }
                        };

                        if (!infusionSpell) {
                            const spellData = { name: "Blood Infusion", type: "spell", img: "icons/magic/water/blood-drop-skull.webp", system: infusionSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            infusionSpell = created[0];
                        } else {
                            await infusionSpell.update({ system: infusionSystemData });
                        }

                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
                        const gridDist = canvas.scene?.grid?.distance || 5;
                        const gridSize = canvas.scene?.grid?.size || 100;
                        const rangePixels = (15 / gridDist) * gridSize;

                        const validTargets = Array.from(game.user.targets).filter(t => {
                            const dist = Math.hypot(t.center.x - tokenCenter.x, t.center.y - tokenCenter.y);
                            return dist <= rangePixels;
                        });

                        if (validTargets.length !== 1) {
                            ui.notifications.warn("Blood Infusion requires exactly one target selected on the canvas within 15 feet of the thrall.");
                            break;
                        }

                        const targetToken = validTargets[0];

                        new Dialog({
                            title: "Blood Infusion",
                            content: `<p>Infuse blood through <b>${tokenDoc.name}</b> into <b>${targetToken.name}</b>?</p>`,
                            buttons: {
                                infuse: {
                                    icon: '<i class="fas fa-tint"></i>',
                                    label: "Infuse",
                                    callback: async () => {
                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                                        if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        const targetsData = {};
                                        targetsData[targetToken.document.id] = {
                                            id: targetToken.document.id,
                                            name: targetToken.document.name,
                                            img: targetToken.document.texture.src,
                                            hasRolled: false,
                                            rollTotal: null,
                                            degreeOfSuccess: null,
                                            isHealing: false,
                                            isImmune: false,
                                            hasApplied: false
                                        };

                                        const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
                                        const htmlContent = await renderTemplate(templatePath, {
                                            targets: Object.values(targetsData),
                                            itemName: "Blood Infusion",
                                            saveType: "Fortitude",
                                            saveDC: infusionDC
                                        });

                                        await tokenDoc.delete();

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            content: htmlContent,
                                            flags: {
                                                "aoe-easy-resolve": {
                                                    templateId: null,
                                                    documentName: "ManualTarget",
                                                    itemUuid: infusionSpell.uuid,
                                                    itemName: "Blood Infusion",
                                                    saveType: "fortitude",
                                                    saveDC: infusionDC,
                                                    isBasicSave: false,
                                                    targets: targetsData,
                                                    hazardDamage: null,
                                                    isReactive: false,
                                                    originMessageId: null,
                                                    spellRank: spellRank
                                                }
                                            }
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "infuse"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                        
                    case "strike": {
                        await rollNativeStrike(e);
                        break;
                    }
                        
                    case "explode": {
                        const bombRank = Math.ceil(necroLevel / 2);
                        
                        let exactDC = 10 + Math.floor(necroLevel * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) exactDC = maxDC;
                        }
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) {
                            exactDC = actor.system.attributes.classDC.dc.value;
                        }

                        let bombSpell = actor.items.find(i => i.type === "spell" && i.name === "Necrotic Bomb");
                        const spellSystemData = {
                            level: { value: bombRank },
                            traits: { value: ["necromancer", "manipulate", "concentrate"] },
                            tradition: { value: "divine" },
                            area: { type: "emanation", value: 10 },
                            defense: { save: { statistic: "fortitude", basic: true, dc: { value: exactDC } } },
                            damage: { "0": { formula: `${bombRank}d12`, type: "untyped" } }
                        };

                        if (!bombSpell) {
                            const spellData = { name: "Necrotic Bomb", type: "spell", img: "icons/magic/death/projectile-skull-flaming-green.webp", system: spellSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            bombSpell = created[0];
                        } else {
                            await bombSpell.update({ system: spellSystemData });
                        }

                        await bombSpell.setFlag("aoe-easy-resolve", "useCustomDamage", true);
                        await bombSpell.setFlag("aoe-easy-resolve", "customDamage", `${bombRank}d12`);
                        await bombSpell.setFlag("aoe-easy-resolve", "customDamageType", "untyped");
                        await bombSpell.setFlag("aoe-easy-resolve", "useOverride", true);
                        await bombSpell.setFlag("aoe-easy-resolve", "saveDC", exactDC);
                        await bombSpell.setFlag("aoe-easy-resolve", "saveType", "fortitude");
                        await bombSpell.setFlag("aoe-easy-resolve", "allyBaseEffect", "standard");
                        await bombSpell.setFlag("aoe-easy-resolve", "enemyBaseEffect", "standard");

                        new Dialog({
                            title: "Necrotic Bomb",
                            content: `<p>Detonate <b>${tokenDoc.name}</b> for <b>${bombRank}d12</b> damage in a 10-foot emanation?</p>`,
                            buttons: {
                                explode: {
                                    icon: '<i class="fas fa-radiation"></i>',
                                    label: "Detonate",
                                    callback: async () => {
                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                                        if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
                                        
                                        window.aoeEasyResolveCache = {
                                            item: bombSpell,
                                            name: "Necrotic Bomb",
                                            dc: exactDC,
                                            type: "fortitude",
                                            hazardDuration: null,
                                            originMessageId: null
                                        };

                                        const gridDist = canvas.scene?.grid?.distance || 5;
                                        const tokenWidth = tokenDoc.width || 1;
                                        const tokenRadiusFeet = (tokenWidth * gridDist) / 2;
                                        const totalEmanationFeet = 10 + tokenRadiusFeet;

                                        await tokenDoc.delete();

                                        await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{
                                            t: "circle", 
                                            user: game.user.id, 
                                            x: tokenCenter.x, 
                                            y: tokenCenter.y, 
                                            distance: totalEmanationFeet, 
                                            fillColor: "#660066"
                                        }]);
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "explode"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }

                    case "life-tap": {
                        let lifeTapDC = 10 + Math.floor((actor.level || 1) * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) lifeTapDC = maxDC;
                        }
                        if (lifeTapDC === 10 && actor.system?.attributes?.classDC?.dc) {
                            lifeTapDC = actor.system.attributes.classDC.dc.value;
                        }

                        let lifeTapSpell = actor.items.find(i => i.type === "spell" && i.name === "Life Tap");
                        const lifeTapSystemData = {
                            level: { value: 1 },
                            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                            tradition: { value: "divine" },
                            defense: { save: { statistic: "fortitude", basic: false, dc: { value: lifeTapDC } } }
                        };

                        if (!lifeTapSpell) {
                            const spellData = { name: "Life Tap", type: "spell", img: "icons/magic/life/heart-glowing-red.webp", system: lifeTapSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            lifeTapSpell = created[0];
                        } else {
                            await lifeTapSpell.update({ system: lifeTapSystemData });
                        }

                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
                        const gridDist = canvas.scene?.grid?.distance || 5;
                        const gridSize = canvas.scene?.grid?.size || 100;
                        const rangePixels = (30 / gridDist) * gridSize;

                        const validTargets = Array.from(game.user.targets).filter(t => {
                            const dist = Math.hypot(t.center.x - tokenCenter.x, t.center.y - tokenCenter.y);
                            return dist <= rangePixels;
                        });

                        if (validTargets.length !== 1) {
                            ui.notifications.warn("Life Tap requires exactly one target selected on the canvas within 30 feet of the thrall.");
                            break;
                        }

                        const targetToken = validTargets[0];

                        new Dialog({
                            title: "Life Tap",
                            content: `<p>Siphon life essence through <b>${tokenDoc.name}</b> targeting <b>${targetToken.name}</b>?</p>`,
                            buttons: {
                                tap: {
                                    icon: '<i class="fas fa-heart-broken"></i>',
                                    label: "Siphon",
                                    callback: async () => {

                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                                        if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        const targetsData = {};
                                        targetsData[targetToken.document.id] = {
                                            id: targetToken.document.id,
                                            name: targetToken.document.name,
                                            img: targetToken.document.texture.src,
                                            hasRolled: false,
                                            rollTotal: null,
                                            degreeOfSuccess: null,
                                            isHealing: false,
                                            isImmune: false,
                                            hasApplied: false
                                        };

                                        const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
                                        const htmlContent = await renderTemplate(templatePath, {
                                            targets: Object.values(targetsData),
                                            itemName: "Life Tap",
                                            saveType: "Fortitude",
                                            saveDC: lifeTapDC
                                        });

                                        await tokenDoc.delete();

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            content: htmlContent,
                                            flags: {
                                                "aoe-easy-resolve": {
                                                    templateId: null,
                                                    documentName: "ManualTarget",
                                                    itemUuid: lifeTapSpell.uuid,
                                                    itemName: "Life Tap",
                                                    saveType: "fortitude",
                                                    saveDC: lifeTapDC,
                                                    isBasicSave: false,
                                                    targets: targetsData,
                                                    hazardDamage: null,
                                                    isReactive: false,
                                                    originMessageId: null
                                                }
                                            }
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "tap"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    
                    case "muscle-barrier": {
                        console.log("Necromancer Helper | Muscle Barrier execution started.");
                        
                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                        if (currentFocus === 0) {
                            ui.notifications.warn("You have no Focus Points to cast Muscle Barrier!");
                            break;
                        }

                        const necroTokens = actor.getActiveTokens();
                        if (necroTokens.length > 0) {
                            const necroToken = necroTokens[0];
                            let distanceToNecro = 999;
                            if (typeof tokenDoc.object?.distanceTo === "function") {
                                distanceToNecro = tokenDoc.object.distanceTo(necroToken);
                            } else {
                                const dx = Math.abs(tokenDoc.x - necroToken.x);
                                const dy = Math.abs(tokenDoc.y - necroToken.y);
                                distanceToNecro = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                            }
                            if (distanceToNecro > 30) {
                                ui.notifications.warn("You must be within 30 feet of the thrall to cast Muscle Barrier.");
                                break;
                            }
                        }

                        let potentialTargets = Array.from(game.user.targets);
                        if (potentialTargets.length === 0 && canvas.tokens.controlled.length > 0) {
                            potentialTargets = canvas.tokens.controlled.filter(t => t.id !== tokenDoc.id);
                        }
                        if (potentialTargets.length === 0 && necroTokens.length > 0) {
                            potentialTargets = [necroTokens[0]];
                        }

                        if (potentialTargets.length === 0) {
                            ui.notifications.error("Muscle Barrier Failed: Could not find a valid target or Necromancer token.");
                            break;
                        }

                        const gridDist = canvas.scene?.grid?.distance || 5;
                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };

                        const validTargets = potentialTargets.filter(t => {
                            let dist = 999;
                            if (typeof tokenDoc.object?.distanceTo === "function") {
                                dist = tokenDoc.object.distanceTo(t);
                            } else {
                                const targetCenter = t.center || { x: t.x, y: t.y };
                                const dx = Math.abs(tokenCenter.x - targetCenter.x);
                                const dy = Math.abs(tokenCenter.y - targetCenter.y);
                                dist = (Math.max(dx, dy) / canvas.grid.size) * gridDist;
                            }
                            return dist <= 15;
                        });

                        if (validTargets.length !== 1) {
                            ui.notifications.error(`Muscle Barrier Failed: Found ${validTargets.length} valid targets within 15 feet. Ensure you or your ally are within 15 feet of the thrall.`);
                            break;
                        }

                        const targetToken = validTargets[0];
                        const targetDoc = targetToken.document || targetToken;
                        const targetActor = targetToken.actor;

                        if (!targetActor) {
                            ui.notifications.error("Muscle Barrier Failed: The targeted token has no character sheet.");
                            break;
                        }

                        const spellRank = Math.max(1, Math.ceil((actor.level || 1) / 2));
                        const tempHP = spellRank * 10;

                        console.log(`Necromancer Helper | Firing Muscle Barrier dialog for ${targetDoc.name} for ${tempHP} Temp HP.`);

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
                                        await tokenDoc.delete();

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            flavor: `<strong>Muscle Barrier</strong>`,
                                            content: `<p><b>${actor.name}</b> splits <b>${tokenDoc.name}</b> apart, flinging the thick slabs of animated muscle onto <b>${targetDoc.name}</b>! They gain <b>${tempHP} Temp HP</b> and a +1 status bonus to Athletics.</p>`
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "cast"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "bony-barrage": {
                        console.log("Necromancer Helper | Bony Barrage execution started.");
                        
                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                        if (currentFocus === 0) {
                            ui.notifications.warn("You have no Focus Points to cast Bony Barrage!");
                            break;
                        }

                        const necroTokens = actor.getActiveTokens();
                        if (necroTokens.length > 0) {
                            const necroToken = necroTokens[0];
                            let distanceToNecro = 999;
                            if (typeof tokenDoc.object?.distanceTo === "function") {
                                distanceToNecro = tokenDoc.object.distanceTo(necroToken);
                            } else {
                                const dx = Math.abs(tokenDoc.x - necroToken.x);
                                const dy = Math.abs(tokenDoc.y - necroToken.y);
                                distanceToNecro = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                            }
                            if (distanceToNecro > 30) {
                                ui.notifications.warn("You must be within 30 feet of the thrall to cast Bony Barrage.");
                                break;
                            }
                        }

                        const spellRank = Math.max(2, Math.ceil((actor.level || 1) / 2));
                        const damageDice = spellRank; 
                        
                        let exactDC = 10 + Math.floor((actor.level || 1) * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) exactDC = maxDC;
                        }
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) {
                            exactDC = actor.system.attributes.classDC.dc.value;
                        }

                        let barrageSpell = actor.items.find(i => i.type === "spell" && i.name === "Bony Barrage");
                        const spellSystemData = {
                            level: { value: spellRank },
                            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                            tradition: { value: "divine" },
                            area: { type: "cone", value: 30 },
                            defense: { save: { statistic: "reflex", basic: true, dc: { value: exactDC } } },
                            damage: { "0": { formula: `${damageDice}d10`, type: "piercing" } }
                        };

                        if (!barrageSpell) {
                            const spellData = { name: "Bony Barrage", type: "spell", img: "icons/magic/death/projectile-skull-flaming-green.webp", system: spellSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            barrageSpell = created[0];
                        } else {
                            await barrageSpell.update({ system: spellSystemData });
                        }

                        await barrageSpell.setFlag("aoe-easy-resolve", "useCustomDamage", true);
                        await barrageSpell.setFlag("aoe-easy-resolve", "customDamage", `${damageDice}d10`);
                        await barrageSpell.setFlag("aoe-easy-resolve", "customDamageType", "piercing");
                        await barrageSpell.setFlag("aoe-easy-resolve", "useOverride", true);
                        await barrageSpell.setFlag("aoe-easy-resolve", "saveDC", exactDC);
                        await barrageSpell.setFlag("aoe-easy-resolve", "saveType", "reflex");

                        new Dialog({
                            title: "Bony Barrage",
                            content: `<p>Shatter <b>${tokenDoc.name}</b> into a 30-foot cone of jagged bone for <b>${damageDice}d10 piercing</b> damage?</p>`,
                            buttons: {
                                fire: {
                                    icon: '<i class="fas fa-bullseye"></i>',
                                    label: "Shatter & Fire",
                                    callback: async () => {
                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                                        if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        
                                        const gridSize = canvas.scene.grid.size;
                                        const originX = tokenDoc.x;
                                        const originY = tokenDoc.y;
                                        const tWidth = tokenDoc.width * gridSize;
                                        const tHeight = tokenDoc.height * gridSize;

                                        await tokenDoc.delete();
                                        
                                        const [marker] = await canvas.scene.createEmbeddedDocuments("Drawing", [{
                                            author: game.user.id,
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
                                        }]);

                                        setTimeout(() => {
                                            if (canvas.scene && canvas.scene.drawings.has(marker.id)) marker.delete();
                                        }, 20000);
                                        
                                        await barrageSpell.toMessage(e);
                                        ui.notifications.info("Draw your 30-foot cone starting from the marked origin point.");
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "fire"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "song-of-the-soul": {
                        console.log("Necromancer Helper | Song of the Soul execution started.");
                        
                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                        if (currentFocus === 0) {
                            ui.notifications.warn("You have no Focus Points to cast Song of the Soul!");
                            break;
                        }

                        const necroTokens = actor.getActiveTokens();
                        if (necroTokens.length > 0) {
                            const necroToken = necroTokens[0];
                            let distanceToNecro = 999;
                            if (typeof tokenDoc.object?.distanceTo === "function") {
                                distanceToNecro = tokenDoc.object.distanceTo(necroToken);
                            } else {
                                const dx = Math.abs(tokenDoc.x - necroToken.x);
                                const dy = Math.abs(tokenDoc.y - necroToken.y);
                                distanceToNecro = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                            }
                            if (distanceToNecro > 30) {
                                ui.notifications.warn("You must be within 30 feet of the thrall to cast Song of the Soul.");
                                break;
                            }
                        }

                        const gridDist = canvas.scene?.grid?.distance || 5;
                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };

                        let finalTarget = null;
                        
                        const explicitTargets = Array.from(game.user.targets).filter(t => {
                            let dist = 999;
                            if (typeof tokenDoc.object?.distanceTo === "function") {
                                dist = tokenDoc.object.distanceTo(t);
                            } else {
                                const targetCenter = t.center || { x: t.x, y: t.y };
                                const dx = Math.abs(tokenCenter.x - targetCenter.x);
                                const dy = Math.abs(tokenCenter.y - targetCenter.y);
                                dist = (Math.max(dx, dy) / canvas.grid.size) * gridDist;
                            }
                            return dist <= 15;
                        });

                        if (explicitTargets.length === 1) {
                            finalTarget = explicitTargets[0];
                        } else {
                            const eligibleAllies = canvas.tokens.placeables.filter(t => {
                                if (!t.actor || t.id === tokenDoc.id) return false;
                                
                                const alliance = t.actor.system?.details?.alliance;
                                const isFriendly = alliance === "party" || t.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY || t.actor.id === actor.id;
                                if (!isFriendly) return false;

                                let dist = 999;
                                if (typeof tokenDoc.object?.distanceTo === "function") {
                                    dist = tokenDoc.object.distanceTo(t);
                                } else {
                                    const targetCenter = t.center || { x: t.x, y: t.y };
                                    const dx = Math.abs(tokenCenter.x - targetCenter.x);
                                    const dy = Math.abs(tokenCenter.y - targetCenter.y);
                                    dist = (Math.max(dx, dy) / canvas.grid.size) * gridDist;
                                }
                                return dist <= 15;
                            });

                            if (eligibleAllies.length === 0) {
                                ui.notifications.warn("Song of the Soul Failed: No valid allies (or yourself) within 15 feet of the thrall.");
                                break;
                            } else if (eligibleAllies.length === 1) {
                                finalTarget = eligibleAllies[0];
                            } else {
                                let optionsHtml = "";
                                eligibleAllies.forEach(t => {
                                    optionsHtml += `<option value="${t.id}">${t.name}</option>`;
                                });

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

                                if (!chosenId) break; 
                                finalTarget = canvas.tokens.get(chosenId);
                            }
                        }

                        if (!finalTarget || !finalTarget.actor) break;

                        const targetDoc = finalTarget.document || finalTarget;
                        const targetActor = finalTarget.actor;

                        const traits = targetActor.system?.traits?.value || [];
                        const isUndead = traits.includes("undead") || traits.some(tr => typeof tr === "string" && tr.toLowerCase() === "undead");
                        const isConstruct = traits.includes("construct");
                        
                        if (isConstruct && !isUndead) {
                            ui.notifications.error("Song of the Soul Failed: Target must be a living or undead creature.");
                            break;
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
                                            // Explicitly tag it so the chat card generates the HEAL button UI
                                            const roll = await new DamageRoll(`${spellRank}d8[healing]`).evaluate();
                                            const actualHeal = roll.total;
                                            
                                            await roll.toMessage({
                                                speaker: ChatMessage.getSpeaker({ actor: actor }),
                                                flavor: `<strong>Song of the Soul</strong> <span class="tag" style="background: #222; color: #fff; padding: 2px 4px; font-size: 10px; border-radius: 2px;">${spellTrait}</span><br><b>${actor.name}</b> shapes ${tokenDoc.name} into an instrument, restoring <b>${actualHeal} HP</b> to ${targetDoc.name}!`
                                            });

                                            // Directly inject the HP to completely bypass the stubborn damage API
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
                                                rules: [{ key: "Aura", radius: 15, colors: { border: "#00ffff", fill: "#00ffff33" } }]
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
                                                rules: [
                                                    { key: "FastHealing", value: spellRank, type: "fast-healing" }
                                                ]
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
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                }
            });
        });

        const spawnBtns = html.querySelectorAll(".spawn-btn");
        spawnBtns.forEach(btn => {
            btn.addEventListener("click", async (e) => {
                let count = parseInt(e.currentTarget.dataset.count, 10);
                const actor = game.actors.get(this.necroId) || game.user.character;

                if (!actor) {
                    ui.notifications.warn("No Necromancer found! Please assign a character to your user.");
                    return;
                }

                const hasPuppeteer = actor.items.some(i => i.system?.slug === "puppeteer");
                if (hasPuppeteer) {
                    const currentCombat = game.combat;
                    const currentRound = currentCombat ? currentCombat.round : 0;
                    const lastUsedRound = actor.getFlag("necromancer-thrall-helper", "proliferationRound");
                    
                    if (!currentCombat || lastUsedRound !== currentRound) {
                        count += 1;
                        if (currentCombat) {
                            await actor.setFlag("necromancer-thrall-helper", "proliferationRound", currentRound);
                        }
                        await ChatMessage.create({
                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                            content: `<p><strong>Thrall Proliferation!</strong> <b>${actor.name}</b> twists the magic to spawn an additional thrall this round.</p>`
                        });
                    }
                }

                const presets = getThrallPresets(actor);

                let optionsHtml = `
                    <option value="default">(Default Thrall)</option>
                    <option value="random">(Random Family Member)</option>
                `;
                
                // Pass 1: Grey out unique thralls that are already on the battlefield
                presets.forEach(p => {
                    const isAlreadyActive = canvas?.scene?.tokens?.some(t => 
                        t.getFlag("necromancer-thrall-helper", "masterId") === actor.id && 
                        t.name === p.name
                    );
                    
                    if (p.isUnique && isAlreadyActive) {
                        optionsHtml += `<option value="${p.id}" disabled>${p.name} (Already Active)</option>`;
                    } else {
                        optionsHtml += `<option value="${p.id}">${p.name}</option>`;
                    }
                });

                let formHtml = `<form><p>Select the identities for your summons:</p>`;
                for (let i = 0; i < count; i++) {
                    formHtml += `
                        <div class="form-group">
                            <label>Summon ${i + 1}:</label>
                            <div class="form-fields">
                                <select id="preset-selector-${i}">${optionsHtml}</select>
                            </div>
                        </div>`;
                }
                formHtml += `</form>`;

                new Dialog({
                    title: "Summoning Ritual",
                    content: formHtml,
                    buttons: {
                        summon: {
                            icon: '<i class="fas fa-magic"></i>',
                            label: "Summon",
                            callback: async (dialogHtml) => {
                                const dialogForm = dialogHtml[0];
                                let selections = [];
                                let selectedUnique = new Set();

                                // Pass 2: Prevent spawning two of the same unique thrall simultaneously
                                for (let i = 0; i < count; i++) {
                                    const val = dialogForm.querySelector(`#preset-selector-${i}`).value;
                                    const preset = presets.find(p => p.id === val);
                                    
                                    if (preset && preset.isUnique) {
                                        if (selectedUnique.has(val)) {
                                            ui.notifications.error(`Summoning Ritual Failed: ${preset.name} is unique and cannot be summoned multiple times.`);
                                            return; 
                                        }
                                        selectedUnique.add(val);
                                    }
                                    selections.push(val);
                                }

                                let currentSpawnIndex = 0;

                                ui.notifications.info(`Click the canvas to place Summon ${currentSpawnIndex + 1}. Right-click to cancel.`);
                                document.body.style.cursor = "crosshair";
                                canvas.app.view.style.cursor = "crosshair";

                                const gridSize = canvas.grid.size;
                                const ghost = new PIXI.Graphics();
                                ghost.beginFill(0x33ff33, 0.3);
                                ghost.lineStyle(2, 0x33ff33, 0.8);
                                ghost.drawRect(0, 0, gridSize, gridSize);
                                ghost.endFill();
                                ghost.zIndex = 1000;
                                ghost.position.set(-1000, -1000);
                                canvas.tokens.addChild(ghost);

                                const updateGhost = (event) => {
                                    const position = event.data.getLocalPosition(canvas.app.stage);
                                    let spawnX = position.x;
                                    let spawnY = position.y;
                                    
                                    if (canvas.grid.getTopLeftPoint) {
                                        const snapped = canvas.grid.getTopLeftPoint(position);
                                        spawnX = snapped.x; 
                                        spawnY = snapped.y;
                                    }
                                    ghost.position.set(spawnX, spawnY);
                                };

                                canvas.stage.on("pointermove", updateGhost);

                                const cleanUp = () => {
                                    document.body.style.cursor = "";
                                    canvas.app.view.style.cursor = "";
                                    canvas.stage.off("pointermove", updateGhost);
                                    ghost.destroy();
                                };

                                const interactionHandler = async (event) => {
                                    if (event.data.button !== 0 && event.data.button !== 2) {
                                        canvas.stage.once("pointerdown", interactionHandler);
                                        return;
                                    }

                                    if (event.data.button === 2) {
                                        ui.notifications.info("Summoning cancelled.");
                                        cleanUp();
                                        return;
                                    }

                                    const position = event.data.getLocalPosition(canvas.app.stage);
                                    let spawnX = position.x;
                                    let spawnY = position.y;
                                    
                                    if (canvas.grid.getTopLeftPoint) {
                                        const snapped = canvas.grid.getTopLeftPoint(position);
                                        spawnX = snapped.x; 
                                        spawnY = snapped.y;
                                    }

                                    const presetId = selections[currentSpawnIndex];
                                    const basePayload = await prepareThrallPayload(actor, presetId);
                                    
                                    if (!basePayload) { cleanUp(); return; }

                                    const finalPayload = foundry.utils.mergeObject(basePayload, {
                                        x: spawnX,
                                        y: spawnY,
                                        delta: {
                                            ownership: {
                                                [game.user.id]: 3
                                            }
                                        }
                                    });

                                    currentSpawnIndex++;
                                    ui.notifications.info(`Spawn request for Summon ${currentSpawnIndex} sent to GM...`);

                                    executeSpawn(finalPayload).catch(err => {
                                        console.error("Necromancer Helper | Spawn execution failed:", err);
                                        ui.notifications.error("Failed to materialize the thrall.");
                                    });

                                    if (currentSpawnIndex < count) {
                                        ui.notifications.info(`Place Summon ${currentSpawnIndex + 1}.`);
                                        canvas.stage.once("pointerdown", interactionHandler);
                                    } else {
                                        cleanUp();
                                        ui.notifications.info("All summons placed.");
                                    }
                                };

                                canvas.stage.once("pointerdown", interactionHandler);
                            }
                        },
                        cancel: {
                            icon: '<i class="fas fa-times"></i>',
                            label: "Cancel"
                        }
                    },
                    default: "summon"
                }, {
                    classes: ["dialog", "thrall-summon-dialog"]
                }).render(true);
            });
        });

        const conjureBtn = html.querySelector(".conjure-tendrils-btn");
        if (conjureBtn) {
            conjureBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const count = parseInt(e.currentTarget.dataset.count, 10);
                const actor = game.actors.get(this.necroId) || game.user.character;
                
                if (!actor) return ui.notifications.warn("No Necromancer found!");

                const tendrilActor = game.actors.find(a => a.name === "Bloody Tendril");
                if (!tendrilActor) return ui.notifications.error("You must have an actor named 'Bloody Tendril' in your actors directory.");
                
                const currentFocus = actor.system?.resources?.focus?.value || 0;
                if (currentFocus === 0) return ui.notifications.warn("You have no Focus Points to conjure tendrils!");
                
                await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                
                const spellRank = Math.ceil(actor.level / 2);
                const diceCount = 1 + Math.floor(Math.max(0, spellRank - 3) / 3);
                
                let exactDC = 10 + Math.floor(actor.level * 1.5);
                if (actor.spellcasting) {
                    const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                    let maxDC = 0;
                    for (const entry of entries) {
                        const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                        if (dcVal && dcVal > maxDC) maxDC = dcVal;
                    }
                    if (maxDC > 0) exactDC = maxDC;
                }
                if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) exactDC = actor.system.attributes.classDC.dc.value;

                let tendrilsSpell = actor.items.find(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("bloody tendrils") || (i.system?.slug && i.system.slug.includes("bloody-tendrils"))));
                const spellSystemData = {
                    level: { value: spellRank },
                    traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                    tradition: { value: "divine" },
                    defense: { save: { statistic: "reflex", basic: true, dc: { value: exactDC } } },
                    damage: { "0": { formula: `${diceCount}d12`, type: "bludgeoning" } }
                };

                if (!tendrilsSpell) {
                    const spellData = { name: "Bloody Tendrils", type: "spell", img: "icons/magic/blood/blood-spatter-splatter-red.webp", system: spellSystemData };
                    const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                    tendrilsSpell = created[0];
                } else {
                    await tendrilsSpell.update({ system: spellSystemData });
                }

                await tendrilsSpell.setFlag("aoe-easy-resolve", "ignoreAoE", true);
                await tendrilsSpell.setFlag("aoe-easy-resolve", "rules", [
                    { context: "tokenTurnEnd", outcome: "always", promptSave: true, alliance: "enemy" },
                    { context: "turnEnd", outcome: "always", promptSave: true, alliance: "enemy" }
                ]);
                await tendrilsSpell.setFlag("aoe-easy-resolve", "useCustomDamage", true);
                await tendrilsSpell.setFlag("aoe-easy-resolve", "customDamage", `${diceCount}d12`);
                await tendrilsSpell.setFlag("aoe-easy-resolve", "customDamageType", "bludgeoning");
                await tendrilsSpell.setFlag("aoe-easy-resolve", "useOverride", true);
                await tendrilsSpell.setFlag("aoe-easy-resolve", "saveDC", exactDC);
                await tendrilsSpell.setFlag("aoe-easy-resolve", "saveType", "reflex");

                let currentSpawnIndex = 0;
                ui.notifications.info(`Click the canvas to place Tendril ${currentSpawnIndex + 1}. Right-click to cancel.`);
                document.body.style.cursor = "crosshair";
                canvas.app.view.style.cursor = "crosshair";

                const gridSize = canvas.grid.size;
                const ghost = new PIXI.Graphics();
                ghost.beginFill(0x990000, 0.4);
                ghost.lineStyle(2, 0x990000, 0.8);
                ghost.drawCircle(gridSize/2, gridSize/2, gridSize/2); 
                ghost.drawCircle(gridSize/2, gridSize/2, gridSize * 2.5);
                ghost.endFill();
                ghost.zIndex = 1000;
                ghost.position.set(-1000, -1000);
                canvas.tokens.addChild(ghost);

                const updateGhost = (event) => {
                    const position = event.data.getLocalPosition(canvas.app.stage);
                    let spawnX = position.x;
                    let spawnY = position.y;
                    if (canvas.grid.getTopLeftPoint) {
                        const snapped = canvas.grid.getTopLeftPoint(position);
                        spawnX = snapped.x; 
                        spawnY = snapped.y;
                    }
                    ghost.position.set(spawnX, spawnY);
                };

                canvas.stage.on("pointermove", updateGhost);

                const cleanUp = () => {
                    document.body.style.cursor = "";
                    canvas.app.view.style.cursor = "";
                    canvas.stage.off("pointermove", updateGhost);
                    ghost.destroy();
                };

                const interactionHandler = async (event) => {
                    if (event.data.button !== 0 && event.data.button !== 2) {
                        canvas.stage.once("pointerdown", interactionHandler);
                        return;
                    }

                    if (event.data.button === 2) {
                        ui.notifications.info("Conjuration cancelled.");
                        cleanUp();
                        return;
                    }

                    const position = event.data.getLocalPosition(canvas.app.stage);
                    let spawnX = position.x;
                    let spawnY = position.y;
                    if (canvas.grid.getTopLeftPoint) {
                        const snapped = canvas.grid.getTopLeftPoint(position);
                        spawnX = snapped.x; 
                        spawnY = snapped.y;
                    }

                    const tetherId = foundry.utils.randomID();
                    const tokenDoc = await tendrilActor.getTokenDocument({ x: spawnX, y: spawnY });

                    const finalPayload = foundry.utils.mergeObject(tokenDoc.toObject(), {
                        flags: { 
                            "necromancer-thrall-helper": { 
                                masterId: actor.id,
                                tendrilTetherId: tetherId 
                            } 
                        },
                        delta: {
                            ownership: {
                                [game.user.id]: 3
                            }
                        }
                    });

                    currentSpawnIndex++;
                    executeSpawn(finalPayload).catch(err => console.error(err));

                    const regionData = {
                        name: `Bloody Tendril Hazard`,
                        color: "#880000",
                        shapes: [{
                            type: "ellipse",
                            hole: false,
                            x: spawnX + (gridSize/2),
                            y: spawnY + (gridSize/2),
                            radiusX: gridSize * 2.5,
                            radiusY: gridSize * 2.5,
                            rotation: 0
                        }],
                        elevation: { bottom: -1000, top: 1000 },
                        behaviors: [{
                            name: "AoE Easy Resolve Controller",
                            type: "executeScript",
                            system: {
                                events: ["tokenTurnEnd"],
                                source: `console.log('AoE Easy Resolve | Tendril Region Triggered!', event);\nif (game.modules.get('aoe-easy-resolve')?.api?.handleRegionEvent) {\n  game.modules.get('aoe-easy-resolve').api.handleRegionEvent(event, '${tendrilsSpell.uuid}');\n}`
                            }
                        }],
                        flags: {
                            "necromancer-thrall-helper": { tendrilTetherId: tetherId },
                            "aoe-easy-resolve": { 
                                isAoERegion: true, 
                                originItemUuid: tendrilsSpell.uuid,
                                persistentRules: [
                                    { context: "tokenTurnEnd", outcome: "always", promptSave: true, alliance: "enemy" },
                                    { context: "turnEnd", outcome: "always", promptSave: true, alliance: "enemy" }
                                ],
                                saveDC: exactDC
                            }
                        }
                    };

                    const drawingData = {
                        author: game.user.id,
                        shape: { type: "e", width: gridSize * 5, height: gridSize * 5 },
                        x: spawnX + (gridSize/2) - (gridSize * 2.5),
                        y: spawnY + (gridSize/2) - (gridSize * 2.5),
                        fillType: 1,
                        fillColor: "#880000",
                        fillAlpha: 0.25,
                        strokeWidth: 2,
                        strokeColor: "#880000",
                        strokeAlpha: 0.8,
                        flags: {
                            "necromancer-thrall-helper": { tendrilTetherId: tetherId }
                        }
                    };
                    
                    await canvas.scene.createEmbeddedDocuments("Region", [regionData]);
                    await canvas.scene.createEmbeddedDocuments("Drawing", [drawingData]);

                    if (currentSpawnIndex < count) {
                        ui.notifications.info(`Place Tendril ${currentSpawnIndex + 1}.`);
                        canvas.stage.once("pointerdown", interactionHandler);
                    } else {
                        cleanUp();
                        ui.notifications.info("All tendrils placed.");
                    }
                };

                canvas.stage.once("pointerdown", interactionHandler);
            });
        }
        
        const killBtns = html.querySelectorAll(".kill-btn");
        killBtns.forEach(killBtn => {
            killBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const row = e.currentTarget.closest('.thrall-row');
                const tokenId = row.dataset.tokenId;
                
                if (!canvas.scene) return;
                
                const tokenDoc = canvas.scene.tokens.get(tokenId);
                if (tokenDoc) {
                    await tokenDoc.delete();
                    ui.notifications.info(`Dismissed ${tokenDoc.name}.`);
                }
            });
        });

        const thrallRows = html.querySelectorAll(".thrall-row");
        thrallRows.forEach(row => {
            row.addEventListener("mouseenter", (e) => {
                const tokenId = row.dataset.tokenId;
                if (!canvas.scene) return;
                
                const token = canvas.tokens.get(tokenId);
                if (token && token.isVisible && !token.controlled) {
                    token._onHoverIn(e);
                }
            });

            row.addEventListener("mouseleave", (e) => {
                const tokenId = row.dataset.tokenId;
                if (!canvas.scene) return;
                
                const token = canvas.tokens.get(tokenId);
                if (token && token.isVisible && !token.controlled) {
                    token._onHoverOut(e);
                }
            });
        });
    }
}