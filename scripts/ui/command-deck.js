import { prepareThrallPayload, getThrallPresets } from "../system/thrall-manager.js";
import { PortfolioEditor } from "./portfolio-editor.js";
import { executeSpawn, executeDelete, executeHazard, executeDamage } from "../system/socket.js";


globalThis.NecroThrallHelper = globalThis.NecroThrallHelper || {};
globalThis.NecroThrallHelper.purgeGraphics = (sceneId, { regionIds = [], drawingIds = [], templateIds = [] }) => {
    if (game.user.isGM) {
        const scene = game.scenes.get(sceneId);
        if (!scene) return;
        if (regionIds.length) scene.deleteEmbeddedDocuments("Region", regionIds.filter(id => scene.regions.has(id))).catch(()=>{});
        if (drawingIds.length) scene.deleteEmbeddedDocuments("Drawing", drawingIds.filter(id => scene.drawings.has(id))).catch(()=>{});
        if (templateIds.length) scene.deleteEmbeddedDocuments("MeasuredTemplate", templateIds.filter(id => scene.templates.has(id))).catch(()=>{});
    } else {
        game.socket.emit("module.necromancer-thrall-helper", { action: "purgeMapGraphics", sceneId, regionIds, drawingIds, templateIds });
    }
};

Hooks.once("ready", () => {
    game.socket.on("module.necromancer-thrall-helper", async (data) => {
        if (!game.user.isGM) return; 

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
            if (msg) {
                await msg.setFlag("necromancer-thrall-helper", "reactionUsed", data.label);
            }
        }

        if (data.action === "purgeMapGraphics") {
            const scene = game.scenes.get(data.sceneId);
            if (!scene) return;
            if (data.regionIds?.length) await scene.deleteEmbeddedDocuments("Region", data.regionIds.filter(id => scene.regions.has(id))).catch(()=>{});
            if (data.drawingIds?.length) await scene.deleteEmbeddedDocuments("Drawing", data.drawingIds.filter(id => scene.drawings.has(id))).catch(()=>{});
            if (data.templateIds?.length) await scene.deleteEmbeddedDocuments("MeasuredTemplate", data.templateIds.filter(id => scene.templates.has(id))).catch(()=>{});
        }

        if (data.action === "addCondition") {
            const targetActor = await fromUuid(data.actorUuid);
            if (targetActor) await targetActor.createEmbeddedDocuments("Item", [data.itemData]).catch(()=>{});
        }
    });
});


Hooks.once("ready", async () => {
    if (!game.user.isGM) return;
    const requiredActors = ["Thrall", "Perfected Thrall", "Skeletal Lancer", "Recurring Nightmare", "Living Graveyard", "Bloody Tendril", "Conglomerate of Limbs"];
    const pack = game.packs.get("necromancer-thrall-helper.necro-thralls");
    if (!pack) return;

    const index = await pack.getIndex();
    let folder = game.folders.find(f => f.name === "Necromancer Thralls" && f.type === "Actor");

    for (const name of requiredActors) {
        if (!game.actors.find(a => a.name === name)) {
            if (!folder) folder = await Folder.create({ name: "Necromancer Thralls", type: "Actor", color: "#4b5563" });
            const entry = index.find(a => a.name === name);
            if (entry) await game.actors.importFromCompendium(pack, entry._id, { folder: folder.id });
        }
    }
});


export function getFascinations(actor) {
    if (!actor) return [];
    
    const selections = actor.flags?.pf2e?.rulesSelections || {};
    const fascinations = new Set();

    if (selections.grimFascination) {
        fascinations.add(selections.grimFascination.toLowerCase());
    }

    if (selections.widespreadFascination) {
        fascinations.add(selections.widespreadFascination.toLowerCase());
    } else if (selections["widespread-fascination"]) {
        fascinations.add(selections["widespread-fascination"].toLowerCase());
    }

    return Array.from(fascinations);
}
Hooks.on("hoverToken", (token, hovered) => {
    if (!token?.id) return;
    const rows = document.querySelectorAll(`.thrall-row[data-token-id="${token.id}"]`);

    rows.forEach(row => {
        if (hovered) {
            row.classList.add("canvas-hover");
        } else {
            row.classList.remove("canvas-hover");
        }
    });
});
Hooks.on("preDeleteToken", (tokenDoc, options, userId) => {
    if (game.user.id !== userId) return;
    const isPerfected = tokenDoc.getFlag("necromancer-thrall-helper", "isPerfectedThrall") || tokenDoc.name.includes("Perfected");
    
    if (isPerfected) {
        const hp = tokenDoc.actor?.system?.attributes?.hp?.value || 0;
        if (hp <= 0) return true; 

        setTimeout(async () => {
            const DamageRoll = CONFIG.Dice.rolls.find(r => r.name === "DamageRoll");
            if (DamageRoll) {
                const roll = await new DamageRoll("20[untyped]").evaluate({async: true});
                await tokenDoc.actor.applyDamage({ damage: roll, token: tokenDoc });
            }
        }, 50);
        
        ui.notifications.info("The Perfected Thrall endures the sacrifice, losing 20 HP instead!");
        return false;
    }
});



Hooks.on("pf2e.restForTheNight", async (actor) => {
    if (actor.getFlag("necromancer-thrall-helper", "consumeThrallUsed")) {
        await actor.unsetFlag("necromancer-thrall-helper", "consumeThrallUsed");
    }
    if (actor.getFlag("necromancer-thrall-helper", "desperateRevivalUsed")) {
        await actor.unsetFlag("necromancer-thrall-helper", "desperateRevivalUsed");
    }
    if (actor.getFlag("necromancer-thrall-helper", "instantArmyUsed")) {
        await actor.unsetFlag("necromancer-thrall-helper", "instantArmyUsed");
    }
});


Hooks.on("updateActor", async (actor, changes, options, userId) => {
    if (!game.user.isGM) return;

    if (actor.getFlag("necromancer-thrall-helper", "revivalPrompted")) return;

    const hpChange = foundry.utils.getProperty(changes, "system.attributes.hp.value");

    const isPuppet = actor.items.find(i => i.getFlag("necromancer-thrall-helper", "isPuppetedCorpse"));
    if (isPuppet) {
        const currentHp = hpChange !== undefined ? hpChange : actor.system.attributes.hp.value;
        const hasSlowed = actor.getCondition("slowed");
        
        if (currentHp <= 100 && currentHp > 0 && !hasSlowed) {
            try { await actor.increaseCondition("slowed"); } catch(e) {}
        } else if (currentHp > 100 && hasSlowed) {
            try { await actor.decreaseCondition("slowed"); } catch(e) {}
        }
    }
    const oldHp = actor.system?.attributes?.hp?.value ?? 1;
    const isDroppingToZero = hpChange !== undefined && hpChange <= 0 && oldHp > 0;
    if (!isDroppingToZero) return;

    const hasDesperateRevival = actor.items.some(i => 
        i.name === "Desperate Revival" || 
        i.slug === "desperate-revival"
    );
    if (!hasDesperateRevival) return;

    const usedToday = actor.getFlag("necromancer-thrall-helper", "desperateRevivalUsed");
    if (usedToday) return;

    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length === 0) return;

    await actor.setFlag("necromancer-thrall-helper", "revivalPrompted", true);
    setTimeout(() => { actor.unsetFlag("necromancer-thrall-helper", "revivalPrompted"); }, 10000);

    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: actor }),
        flavor: `<strong>Desperate Revival Triggered!</strong>`,
        content: `
            <div style="background: rgba(0,0,0,0.35); padding: 10px; border-radius: 4px; border-left: 4px solid #ef4444;">
                <p style="margin: 0 0 6px 0;"><b>${actor.name}</b> is on the verge of death!</p>
                <p style="margin: 0 0 8px 0; font-size: 0.95em;">Spend your reaction to avoid being knocked out, remain at 1 HP, and unleash a <b>60-foot life-draining emanation</b>?</p>
                <div style="text-align: center;">
                    <button type="button" class="desperate-revival-trigger-btn" data-necro-id="${actor.id}" style="background: #450a0a; color: #f87171; border: 1px solid #ef4444; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: bold;">
                        <i class="fas fa-heartbeat"></i> Trigger Desperate Revival (1/Day)
                    </button>
                </div>
            </div>
        `
    });
});

Hooks.on("createChatMessage", async (message) => {
    if (!game.user.isGM) return;

    const pf2eContext = message.flags?.pf2e?.context;
    if (pf2eContext?.type !== "attack-roll") return;

  
    const attackerToken = canvas.tokens.get(message.speaker?.token) 
        || canvas.tokens.placeables.find(t => t.actor?.id === message.speaker?.actor);
    if (!attackerToken?.actor) return;

    const alliance = attackerToken.actor.system?.details?.alliance || attackerToken.actor.alliance;
    const isEnemy = alliance === "opposition" || attackerToken.document.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE;
    if (!isEnemy) return;

    const gridDist = canvas.scene?.grid?.distance || 5;
    const lancers = canvas.tokens.placeables.filter(t => {
        if (!t.actor || t.actor.system?.attributes?.hp?.value <= 0) return false;
        return t.document.getFlag("necromancer-thrall-helper", "isSkeletalLancer");
    });

    if (lancers.length === 0) return;

    const isWithinLancerReach = lancers.some(lancer => {
        if (typeof lancer.distanceTo === "function") {
            return lancer.distanceTo(attackerToken) <= 10;
        }
        const dx = Math.abs(lancer.center.x - attackerToken.center.x);
        const dy = Math.abs(lancer.center.y - attackerToken.center.y);
        return ((Math.max(dx, dy) / canvas.grid.size) * gridDist) <= 10;
    });

    if (!isWithinLancerReach) return;


    const DamageRoll = CONFIG.Dice.rolls.find(r => r.name === "DamageRoll");
    if (!DamageRoll) return;

    const roll = await new DamageRoll("5[piercing]").evaluate();
    await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ token: attackerToken.document }),
        flavor: `<strong>Skeletal Lancer: Spear Threat!</strong><br><b>${attackerToken.name}</b> made a Strike within reach of a Skeletal Lancer!`
    });

    await attackerToken.actor.applyDamage({ damage: roll, token: attackerToken.document });

    if (canvas.ready) {
        canvas.interface.createScrollingText(attackerToken.center, "-5 HP", {
            anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
            fill: 0xff0000,
            direction: CONST.TEXT_ANCHOR_POINTS.DOWN
        });
    }
});











Hooks.on("renderChatMessageHTML", (message, html) => {
    const aoeData = message.flags?.["aoe-easy-resolve"];
    if (aoeData?.itemName === "Thick Skin" || aoeData?.itemName === "Recurring Nightmare") {
        const $html = html instanceof jQuery ? html : $(html);
        $html.find(".roll-damage-btn").remove();
    }
});
Hooks.on("deleteItem", async (itemDoc, options, userId) => {
    if (game.user.id !== userId) return;
    if (itemDoc.type !== "effect" || !itemDoc.getFlag("necromancer-thrall-helper", "isHazardTracker")) return;

    const hazardId = itemDoc.getFlag("necromancer-thrall-helper", "hazardId");
    const sceneId = itemDoc.getFlag("necromancer-thrall-helper", "sceneId");
    
    const targetScene = game.scenes.get(sceneId);
    if (!targetScene) return;

    const rIds = targetScene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "hazardId") === hazardId || r.getFlag("necromancer-thrall-helper", "goreRegionId") === hazardId).map(r => r.id);
    const dIds = targetScene.drawings.filter(d => d.getFlag("necromancer-thrall-helper", "hazardId") === hazardId || d.getFlag("necromancer-thrall-helper", "goreRegionId") === hazardId).map(d => d.id);
    
    if (rIds.length > 0 || dIds.length > 0) {
        globalThis.NecroThrallHelper.purgeGraphics(sceneId, { regionIds: rIds, drawingIds: dIds });
    }
});
Hooks.on("deleteToken", async (tokenDoc, options, userId) => {
    if (!game.user.isGM) return;

    if (tokenDoc.getFlag("necromancer-thrall-helper", "isRecurringNightmare")) {
        const masterId = tokenDoc.getFlag("necromancer-thrall-helper", "masterId");
        const master = game.actors.get(masterId);
        if (master) {
            await master.setFlag("necromancer-thrall-helper", "nightmareDestroyed", true);
        }
    }

    const masterId = tokenDoc.getFlag("necromancer-thrall-helper", "masterId") 
        || tokenDoc.actor?.getFlag("necromancer-thrall-helper", "masterId");

    const isReanimated = tokenDoc.getFlag("necromancer-thrall-helper", "isReanimatedFoe") 
        || tokenDoc.actor?.items.some(i => i.getFlag("necromancer-thrall-helper", "isReanimatedFoe"));
    
    if (!masterId || isReanimated) {
        return;
    }

    console.log(`Necromancer Helper | Thrall destroyed: ${tokenDoc.name}. Checking master: ${masterId}`);

    const masterActor = game.actors.get(masterId) 
        || canvas.tokens.placeables.find(t => t.actor?.id === masterId)?.actor;
    
    if (!masterActor) {
        console.warn("Necromancer Helper | Could not locate master actor for thrall deletion.");
        return;
    }
    // --- BLOOD FASCINATION: SANGUINE RETURN ---
    const hasBloodFascination = masterActor.items.some(i => i.slug === "blood" || i.name === "Blood");
    
    if (hasBloodFascination) {
        const currentHP = masterActor.system.attributes.hp.value;
        const maxHP = masterActor.system.attributes.hp.max;
        
        const healAmount = Math.floor(((masterActor.level || 1) + 3) / 4);
        const actualHealed = Math.min(maxHP - currentHP, healAmount);

        if (actualHealed > 0) {
            await masterActor.update({ "system.attributes.hp.value": currentHP + actualHealed });
            
            let necroToken = masterActor.getActiveTokens()[0] || canvas.tokens.placeables.find(t => t.actor?.id === masterActor.id);
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
                content: `
                    <div style="background: rgba(0,0,0,0.3); padding: 6px; border-radius: 4px; border-left: 4px solid #ef4444;">
                        <p style="margin: 0; font-size: 0.95em;">A thrall falls, and its infused blood rushes back to <b>${masterActor.name}</b>, restoring <b>${actualHealed} HP</b>.</p>
                    </div>
                `
            });

            console.log(`Necromancer Helper | Blood Fascination: Returned ${actualHealed} HP from destroyed thrall.`);
        }
    }
// --- FLESH FASCINATION: GORY TERRAIN ---
const hasFleshFascination = masterActor.items.some(i => i.slug === "flesh" || i.name === "Flesh");
    
if (hasFleshFascination) {
    const tX = tokenDoc.x;
    const tY = tokenDoc.y;
    const tW = tokenDoc.width || 1;
    const tH = tokenDoc.height || 1;

    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: masterActor }),
        flavor: `<strong>Flesh Fascination</strong>`,
        content: `
            <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #9ca3af;">
                <p style="margin: 0 0 6px 0;"><b>${tokenDoc.name}</b> collapses into a heap of grotesque meat.</p>
                <p style="margin: 0 0 8px 0; font-size: 0.9em; color: #ccc;">Do you want to leave behind difficult terrain (10 minutes)?</p>
                <div style="text-align: center;">
                    <button type="button" class="flesh-terrain-btn" data-x="${tX}" data-y="${tY}" data-w="${tW}" data-h="${tH}" data-master="${masterActor.id}" style="background: #1f2937; color: #d1d5db; border: 1px solid #4b5563; padding: 4px 8px; border-radius: 4px; cursor: pointer;">
                        <i class="fas fa-spider"></i> Leave Gory Remains
                    </button>
                </div>
            </div>
        `
    });
}








    const hasReinforced = masterActor.items.some(i => 
        /reinforced\s*skeleton/i.test(i.name) || i.slug === "reinforced-skeleton"
    );

    if (hasReinforced) {
        console.log("Necromancer Helper | Triggering Reinforced Skeleton speed surge.");
        const effectSlug = "effect-reinforced-skeleton-speed";
        const existingEffect = masterActor.items.find(i => 
            i.system?.slug === effectSlug || 
            /reinforced\s*skeleton.*speed/i.test(i.name)
        );

        if (!existingEffect) {
            const effectData = {
                name: "Reinforced Skeleton: Speed Surge",
                type: "effect",
                img: "icons/equipment/feet/boots-collared-simple-brown.webp",
                system: {
                    slug: effectSlug,
                    description: { 
                        value: "Whenever you destroy a thrall, your status bonus to Speeds increases to +10 feet for 1 round." 
                    },
                    duration: { 
                        value: 1, 
                        unit: "rounds", 
                        expiry: "turn-end" 
                    },
                    rules: [
                        { 
                            key: "FlatModifier", 
                            selector: "speed", 
                            value: 10, 
                            type: "status", 
                            slug: "reinforced-skeleton-status-speed" 
                        }
                    ]
                }
            };
            await masterActor.createEmbeddedDocuments("Item", [effectData]);
        }
    }

    const thickSkinItem = masterActor.items.find(i => 
        i.name === "Thick Skin" || i.slug === "thick-skin"
    );

    if (thickSkinItem && !window.SuppressThickSkin) {
        if (window.NecroThrallThickSkinLock) return;
        window.NecroThrallThickSkinLock = true;
        setTimeout(() => { window.NecroThrallThickSkinLock = false; }, 2000);

        console.log("Necromancer Helper | Thick Skin feat detected on master.");
        
        let necroToken = masterActor.getActiveTokens()[0];
        if (!necroToken) {
            necroToken = canvas.tokens.placeables.find(t => t.actor?.id === masterActor.id);
        }

        if (!necroToken) {
            console.warn("Necromancer Helper | Necromancer token not found on the canvas.");
            return;
        }

        let spellDC = 10 + Math.floor((masterActor.level || 1) * 1.5);
        if (masterActor.spellcasting) {
            const entries = typeof masterActor.spellcasting.contents === "function" 
                ? masterActor.spellcasting.contents() 
                : Array.from(masterActor.spellcasting);
            let maxDC = 0;
            for (const entry of entries) {
                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                if (dcVal && dcVal > maxDC) maxDC = dcVal;
            }
            if (maxDC > 0) spellDC = maxDC;
        }
        if (spellDC === 10 && masterActor.system?.attributes?.classDC?.dc) {
            spellDC = masterActor.system.attributes.classDC.dc.value;
        }

        if (game.combat) {
            await masterActor.setFlag("necromancer-thrall-helper", "thickSkinRound", combatRoundKey);
        }

        console.log(`Necromancer Helper | Thick Skin setting DC: ${spellDC}. Updating item flags.`);

        await thickSkinItem.update({
            "flags.aoe-easy-resolve": {
                useOverride: true,
                saveType: "fortitude",
                saveDC: spellDC,
                isAreaDamage: true,
                allyBaseEffect: "immune",
                enemyBaseEffect: "standard"
            }
        });

        window.aoeEasyResolveCache = {
            item: thickSkinItem,
            name: "Thick Skin",
            dc: spellDC,
            type: "fortitude",
            hazardDuration: null
        };

        const gridDist = canvas.scene?.grid?.distance || 5;
        const tokenRadiusFeet = ((necroToken.document.width || 1) * gridDist) / 2;
        const emanationDistance = tokenRadiusFeet + 5;

        console.log(`Necromancer Helper | Placing 5ft emanation template (${emanationDistance}ft total) at x:${necroToken.center.x}, y:${necroToken.center.y}`);

        const templateData = {
            t: "circle",
            user: game.user.id,
            distance: emanationDistance,
            direction: 0,
            x: necroToken.center.x,
            y: necroToken.center.y,
            fillColor: "#84cc16",
            flags: {
                "necromancer-thrall-helper": { source: "thick-skin" },
                "pf2e": { origin: { uuid: thickSkinItem.uuid } },
                "aoe-easy-resolve": { originItemUuid: thickSkinItem.uuid }
            }
        };

        await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [templateData]);

        setTimeout(() => {
            if (window.aoeEasyResolveCache?.name === "Thick Skin") {
                window.aoeEasyResolveCache = null;
            }
        }, 500);
    }
})

Hooks.on("createItem", async (item, options, userId) => {
    if (game.user.id !== userId) return;
    if (item.type !== "condition") return;

    const actor = item.parent;
    if (!actor || actor.type !== "character") return;

    const hasFinalUnion = actor.items.some(i => i.name === "Final Union" || i.slug === "final-union");
    if (!hasFinalUnion) return;

    const slug = item.system.slug;

    if (slug === "unconscious" || slug === "prone") {
        setTimeout(async () => {
            const badCond = actor.items.find(i => i.id === item.id);
            if (badCond) await badCond.delete();
        }, 50);
        return;
    }

    if (slug === "dying") {
        const isAlreadyPuppet = actor.items.some(i => i.getFlag("necromancer-thrall-helper", "isPuppetedCorpse"));
        if (isAlreadyPuppet) return; 

        setTimeout(async () => {

            const badConditions = actor.items.filter(i => i.type === "condition" && ["dying", "wounded", "doomed", "unconscious", "prone"].includes(i.system.slug));
            if (badConditions.length > 0) {
                await actor.deleteEmbeddedDocuments("Item", badConditions.map(i => i.id));
            }

            const currentMaxHP = actor.system.attributes.hp.max;
            const hpDelta = 200 - currentMaxHP;

            const puppetEffect = {
                name: "Effect: Puppeted Corpse",
                type: "effect",
                img: "icons/magic/death/icons/magic/death/skeleton-skull-soul-blue.webp",
                system: {
                    duration: { value: 1, unit: "minutes", expiry: "turn-start" },
                    description: { value: "Your heroic spirit puppets your corpse. You are an undead object. Immune to bleed, death effects, disease, healing, nonlethal, poison, void, doomed, drained, fatigued, sickened, and unconscious. Broken Threshold 100 (Slowed 1)." },
                    rules: [
                        { key: "FlatModifier", selector: "hp", value: hpDelta, type: "untyped" },
                        { key: "Immunity", type: "bleed" },
                        { key: "Immunity", type: "death-effects" },
                        { key: "Immunity", type: "disease" },
                        { key: "Immunity", type: "healing" },
                        { key: "Immunity", type: "nonlethal-attacks" },
                        { key: "Immunity", type: "poison" },
                        { key: "Immunity", type: "void" },
                        { key: "Immunity", type: "doomed" },
                        { key: "Immunity", type: "drained" },
                        { key: "Immunity", type: "fatigued" },
                        { key: "Immunity", type: "sickened" },
                        { key: "Immunity", type: "unconscious" },
                        { key: "Immunity", type: "prone" }
                    ]
                },
                flags: {
                    "necromancer-thrall-helper": { isPuppetedCorpse: true }
                }
            };

            await actor.createEmbeddedDocuments("Item", [puppetEffect]);

            for (let attempts = 0; attempts < 20; attempts++) {
                if (actor.system.attributes.hp.max >= 200) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            await actor.update({ "system.attributes.hp.value": 200 });
            
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: actor }),
                flavor: `<strong>Final Union: Puppeted Corpse</strong>`,
                content: `
                    <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #4ade80;">
                        <p style="margin: 0 0 4px 0;"><b>${actor.name}</b> has fallen, but the heroic spirit refuses to abandon the body!</p>
                        <p style="margin: 0; font-size: 0.95em;">The corpse rises as an undead object with <b>200 HP</b> (Broken Threshold 100).</p>
                    </div>
                `
            });

        }, 50);
    }
});

Hooks.on("updateActor", async (actor, changes, options, userId) => {
    if (!game.user.isGM) return;

    const hpChange = foundry.utils.getProperty(changes, "system.attributes.hp.value");
    if (hpChange === undefined) return;

    if (hpChange > 0) return;

    
    const isReanimated = actor.items.some(i => i.getFlag("necromancer-thrall-helper", "isReanimatedFoe"));
    if (isReanimated) {
        const tokenToKill = actor.getActiveTokens()[0] || canvas.tokens.placeables.find(t => t.actor?.id === actor.id);
        if (tokenToKill) {
            await tokenToKill.document.delete();
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: actor }),
                flavor: `<strong>Reanimated Foe Destroyed</strong>`,
                content: `<p>The unstable magic holding <b>${actor.name}</b> together violently collapses. It crumbles to dust!</p>`
            });
        }
        return; 
    }


    const hasNecroticBlood = actor.items.find(i => i.getFlag("necromancer-thrall-helper", "isNecroticBlood") || i.name === "Necrotic Blood");
    
    let inStorm = false;
    let stormMasterId = null;
    
    if (!hasNecroticBlood && canvas.scene) {
        const deadToken = canvas.tokens.placeables.find(t => t.actor?.id === actor.id);
        if (deadToken) {
            const storms = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "stormRegionId"));
            for (const storm of storms) {
                const shape = storm.shapes?.[0];
                if (!shape) continue;
                
                const cx = shape.x;
                const cy = shape.y;
                const rx = shape.radiusX;
                
                const dx = deadToken.center.x - cx;
                const dy = deadToken.center.y - cy;
                

                if (Math.sqrt(dx*dx + dy*dy) <= rx) {
                    inStorm = true;
                    stormMasterId = game.actors.find(a => a.items.some(i => i.name === "Dread Mosquito Storm"))?.id;
                    break;
                }
            }
        }
    }

    if (hasNecroticBlood || inStorm) {
        const masterId = hasNecroticBlood ? hasNecroticBlood.getFlag("necromancer-thrall-helper", "masterId") : stormMasterId;
        const masterActor = game.actors.get(masterId);
        
        if (masterActor) {
            if (hasNecroticBlood) await hasNecroticBlood.delete();
            const size = actor.system?.traits?.size?.value || "med";
            const deadTokenId = canvas.tokens.placeables.find(t => t.actor?.id === actor.id)?.id;
            
            let sizeLabel = "Medium";
            if (size === "sm") sizeLabel = "Small";
            if (size === "lg") sizeLabel = "Large";
            if (size === "huge") sizeLabel = "Huge";
            if (size === "grg") sizeLabel = "Gargantuan";

            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: masterActor }),
                flavor: `<strong>Necrotic Blood Trigger!</strong>`,
                content: `
                    <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #880000;">
                        <p style="margin: 0 0 4px 0;"><b>${actor.name}</b> has succumbed to the necrotic plague!</p>
                        <p style="margin: 0; font-size: 0.9em;">The infected blood congeals into a new thrall.</p>
                        <div style="text-align: center; margin-top: 8px;">
                            <button type="button" class="inevitable-return-btn" data-necro-id="${masterActor.id}" data-target-id="${deadTokenId}" data-size="${size}" style="background: #220033; color: #c084fc; border: 1px solid #7c3aed; padding: 5px 8px; border-radius: 4px; cursor: pointer;">
                                <i class="fas fa-ghost"></i> Sprout Thrall (${sizeLabel})
                            </button>
                        </div>
                    </div>
                `
            });
        }
    }


    const isDesperatePrompted = actor.getFlag("necromancer-thrall-helper", "revivalPrompted");
    const hasDesperateRevival = actor.items.some(i => i.name === "Desperate Revival" || i.slug === "desperate-revival");
    const usedToday = actor.getFlag("necromancer-thrall-helper", "desperateRevivalUsed");
    
    if (hasDesperateRevival && !usedToday && !isDesperatePrompted) {
        const necroTokens = actor.getActiveTokens();
        if (necroTokens.length > 0) {
            await actor.setFlag("necromancer-thrall-helper", "revivalPrompted", true);
            setTimeout(() => { actor.unsetFlag("necromancer-thrall-helper", "revivalPrompted"); }, 10000);

            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: actor }),
                flavor: `<strong>Desperate Revival Triggered!</strong>`,
                content: `
                    <div style="background: rgba(0,0,0,0.35); padding: 10px; border-radius: 4px; border-left: 4px solid #ef4444;">
                        <p style="margin: 0 0 6px 0;"><b>${actor.name}</b> is on the verge of death!</p>
                        <p style="margin: 0 0 8px 0; font-size: 0.95em;">Spend your reaction to avoid being knocked out, remain at 1 HP, and unleash a <b>60-foot life-draining emanation</b>?</p>
                        <div style="text-align: center;">
                            <button type="button" class="desperate-revival-trigger-btn" data-necro-id="${actor.id}" style="background: #450a0a; color: #f87171; border: 1px solid #ef4444; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: bold;">
                                <i class="fas fa-heartbeat"></i> Trigger Desperate Revival (1/Day)
                            </button>
                        </div>
                    </div>
                `
            });
            return; 
        }
    }

    const isPartyOrPC = actor.hasPlayerOwner || actor.type === "character" || actor.system?.details?.alliance === "party";
    if (isPartyOrPC) return; 

    const deadToken = canvas.tokens.placeables.find(t => t.actor?.id === actor.id);
    if (!deadToken) return;

    const traits = Array.from(actor.system?.traits?.value ?? []);
    const size = actor.system?.traits?.size?.value || actor.size || "med";
            const isCorpseValidSize = size === "sm" || size === "med";

            const isUndead = traits.includes("undead") || traits.some(t => typeof t === "string" && t.toLowerCase() === "undead");
            const isConstruct = traits.includes("construct");
            const isElemental = traits.includes("elemental");
            const hasInfusedBlood = actor.items.some(i => i.name === "Infused Blood" || i.slug === "infused-blood");
            const hasBlood = !isConstruct && !isElemental && (!isUndead || hasInfusedBlood);

            const necromancers = canvas.tokens.placeables.filter(t => {
                if (!t.actor) return false;
                return t.actor.items.some(i => 
                    i.name === "Inevitable Return" || i.slug === "inevitable-return" ||
                    i.name === "Blood Pool" || i.slug === "blood-pool"
                );
            });

    for (const necroToken of necromancers) {
        const necroActor = necroToken.actor;
        let dist = 999;
        if (typeof necroToken.distanceTo === "function") {
            dist = necroToken.distanceTo(deadToken);
        } else {
            const dx = Math.abs(necroToken.center.x - deadToken.center.x);
            const dy = Math.abs(necroToken.center.y - deadToken.center.y);
            dist = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
        }

        if (dist > 30) continue;

        const hasInevitableFeat = necroActor.items.some(i => i.name === "Inevitable Return" || i.slug === "inevitable-return");
        const hasBloodPoolFeat = necroActor.items.some(i => i.name === "Blood Pool" || i.slug === "blood-pool");

        const canInevitableReturn = hasInevitableFeat && isCorpseValidSize;
        const canBloodPool = hasBloodPoolFeat && hasBlood;

        if (!canInevitableReturn && !canBloodPool) continue;

        const necroLevel = necroActor.level || 1;
        let reactionOptionsHtml = `<div class="death-reaction-actions" style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-top: 8px;">`;

        if (canInevitableReturn) {
            reactionOptionsHtml += `
                <button type="button" class="inevitable-return-btn" data-necro-id="${necroActor.id}" data-target-id="${deadToken.id}" data-size="${size}" style="background: #220033; color: #c084fc; border: 1px solid #7c3aed; padding: 5px 8px; border-radius: 4px; cursor: pointer; flex: 1; min-width: 130px;">
                    <i class="fas fa-skull"></i> Claim Corpse (${size === 'sm' ? 'Small' : 'Medium'})
                </button>
            `;
        }

        if (canBloodPool) {
            reactionOptionsHtml += `
                <button type="button" class="blood-pool-spawn-btn" data-necro-id="${necroActor.id}" data-target-id="${deadToken.id}" style="background: #3a0000; color: #f87171; border: 1px solid #b91c1c; padding: 5px 8px; border-radius: 4px; cursor: pointer; flex: 1; min-width: 130px;">
                    <i class="fas fa-tint"></i> Blood Pool (${necroLevel} HP)
                </button>
            `;
        }

        reactionOptionsHtml += `</div>`;

        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: necroActor }),
            flavor: `<strong>Death Reaction Triggered!</strong>`,
            content: `
                <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #a855f7;">
                    <p style="margin: 0 0 4px 0;"><b>${deadToken.name}</b> has fallen within 30 feet of <b>${necroToken.name}</b>.</p>
                    <p style="margin: 0; font-size: 0.9em; color: #ccc;">Choose a reaction to harvest the death:</p>
                    ${reactionOptionsHtml}
                </div>
            `
        });
    }
});
// --- SAFELY WRAP PF2E'S DAMAGE ENGINE ---
Hooks.once("ready", () => {
    if (CONFIG.Actor.documentClass.prototype._necroHelperApplyDamageWrapped) return;
    
    const originalApplyDamage = CONFIG.Actor.documentClass.prototype.applyDamage;
    CONFIG.Actor.documentClass.prototype.applyDamage = async function(options) {

        const preHp = this.system?.attributes?.hp?.value || 0;
        
        const result = await originalApplyDamage.call(this, options);
        
        const postHp = this.system?.attributes?.hp?.value || 0;
        const hpLost = preHp - postHp;
        
        if (hpLost > 0) {
            Hooks.callAll("necroHelperDamageApplied", this, options, hpLost);
        }
        
        return result;
    };
    CONFIG.Actor.documentClass.prototype._necroHelperApplyDamageWrapped = true;
});

// --- BLOOD POOL: ONLY TRIGGER ON ACTUAL HP LOSS ---
Hooks.on("necroHelperDamageApplied", async (actor, options, hpLost) => {
    if (!game.user.isGM) return;

    let isBleed = false;
    
    if (options.damage?.instances && Array.isArray(options.damage.instances)) {
        if (options.damage.instances.some(i => i.type === "bleed")) isBleed = true;
    }
    if (options.rollOptions && typeof options.rollOptions.has === "function") {
        if (options.rollOptions.has("damage:type:bleed")) isBleed = true;
    }
    if (options.item && options.item.system?.traits?.value) {
        if (options.item.system.traits.value.includes("bleed")) isBleed = true;
    }

    if (!isBleed) return;

    let targetToken = options.token?.object || actor.getActiveTokens()[0];
    if (!targetToken?.actor) return;

    const traits = targetToken.actor.system?.traits?.value || [];
    const hasNoBlood = traits.includes("construct") || traits.includes("elemental") || (traits.includes("undead") && !targetToken.actor.items.some(i => i.name === "Infused Blood"));
    if (hasNoBlood) return;

    const necros = canvas.tokens.placeables.filter(t => {
        if (!t.actor) return false;
        return t.actor.items.some(i => i.name === "Blood Pool" || i.slug === "blood-pool");
    });

    for (const necroToken of necros) {
        let dist = 999;
        if (typeof necroToken.distanceTo === "function") {
            dist = necroToken.distanceTo(targetToken);
        } else {
            const dx = Math.abs(necroToken.center.x - targetToken.center.x);
            const dy = Math.abs(necroToken.center.y - targetToken.center.y);
            dist = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
        }

        if (dist <= 30) {
            const necroLevel = necroToken.actor.level || 1;
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: necroToken.actor }),
                flavor: `<strong>Blood Pool Reaction Trigger!</strong>`,
                content: `
                    <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #b91c1c;">
                        <p style="margin: 0 0 5px 0;"><b>${targetToken.name}</b> takes bleed damage within 30 feet of <b>${necroToken.name}</b>.</p>
                        <p style="margin: 0 0 8px 0; font-size: 0.95em;">Pool their spilled lifeblood to grant <b>${necroLevel} HP</b> to an ally?</p>
                        <div class="death-reaction-actions" style="text-align: center;">
                            <button type="button" class="blood-pool-spawn-btn" data-is-bleed="true" data-necro-id="${necroToken.actor.id}" data-target-id="${targetToken.id}" style="background: #3a0000; color: #f87171; border: 1px solid #b91c1c; padding: 4px 8px; border-radius: 4px; cursor: pointer;">
                                <i class="fas fa-tint"></i> Create Blood Pool
                            </button>
                        </div>
                    </div>
                `
            });
        }
    }
});
Hooks.on("renderChatMessage", (message, html) => {
    const $html = html instanceof jQuery ? html : $(html);
    const reactionUsed = message.getFlag("necromancer-thrall-helper", "reactionUsed");
    if (reactionUsed) {
        const labelColor = reactionUsed === "Inevitable Return" ? "#c084fc" : "#f87171";
        $html.find('.death-reaction-actions').html(`
            <div style="background: rgba(0,0,0,0.5); border: 1px solid #444; border-radius: 4px; padding: 6px; text-align: center; margin-top: 4px;">
                <span style="text-decoration: line-through; color: #666; font-weight: bold; font-size: 0.9em; display: block;">
                    <i class="fas fa-ban"></i> Death Reaction
                </span>
                <span style="display: block; color: ${labelColor}; font-size: 0.85em; font-style: italic; margin-top: 2px;">
                    Expended: ${reactionUsed}
                </span>
            </div>
        `);
    }

    $html.find('.death-reaction-actions').each(function() {
        const $container = $(this);
        const $btn = $container.find('.blood-pool-spawn-btn, .inevitable-return-btn').first();
        if ($btn.length > 0 && !reactionUsed) {
            const isBleed = $btn.attr("data-is-bleed") === "true";
            const necroId = $btn.attr("data-necro-id");
            const targetId = $btn.attr("data-target-id");
            const necroActor = game.actors.get(necroId);
            if (!isBleed && necroActor && necroActor.getFlag("necromancer-thrall-helper", `harvested_${targetId}`)) {
                $container.html(`
                    <div style="background: rgba(0,0,0,0.5); border: 1px solid #444; border-radius: 4px; padding: 6px; text-align: center; margin-top: 4px;">
                        <span style="text-decoration: line-through; color: #666; font-weight: bold; font-size: 0.9em; display: block;">
                            <i class="fas fa-ban"></i> Death Reaction
                        </span>
                        <span style="display: block; color: #999; font-size: 0.85em; font-style: italic; margin-top: 2px;">
                            Corpse Already Harvested
                        </span>
                    </div>
                `);
            }
        }
    });

    $html.find('.inevitable-return-btn').off('click').on('click', async (e) => {
        e.preventDefault();
        const $btn = $(e.currentTarget);
        const necroActorId = $btn.attr('data-necro-id');
        const targetId = $btn.attr('data-target-id');
        const size = $btn.attr('data-size');
        
        const attacker = game.actors.get(necroActorId);
        const targetToken = canvas.tokens.get(targetId);

        if (!attacker || !targetToken) return ui.notifications.warn("Could not locate the Necromancer or the corpse.");

        if (attacker.getFlag("necromancer-thrall-helper", `harvested_${targetId}`) || message.getFlag("necromancer-thrall-helper", "reactionUsed")) {
            return ui.notifications.warn("This corpse has already been harvested.");
        }

        const presets = typeof getThrallPresets === "function" ? getThrallPresets(attacker) : [];
        if (presets.length === 0) return ui.notifications.warn("No thrall presets found.");

        let optionsHtml = '<option value="default">(Default Thrall)</option><option value="random">(Random Family Member)</option>';
        presets.forEach(p => {
            const isAlreadyActive = canvas?.scene?.tokens?.some(t => t.getFlag("necromancer-thrall-helper", "masterId") === attacker.id && t.name === p.name);
            if (p.isUnique && isAlreadyActive) {
                optionsHtml += `<option value="${p.id}" disabled>${p.name} (Already Active)</option>`;
            } else {
                optionsHtml += `<option value="${p.id}">${p.name}</option>`;
            }
        });

        const formHtml = `
            <form>
                <p>Select the identity for the new <b>${size === 'sm' ? 'Small' : 'Medium'}</b> thrall rising from <b>${targetToken.name}</b>:</p>
                <div class="form-group">
                    <label>Thrall Identity:</label>
                    <div class="form-fields">
                        <select id="inevitable-preset">${optionsHtml}</select>
                    </div>
                </div>
            </form>
        `;

        new Dialog({
            title: "Inevitable Return",
            content: formHtml,
            buttons: {
                summon: {
                    icon: '<i class="fas fa-ghost"></i>',
                    label: "Rise",
                    callback: async (dialogHtml) => {
                        await attacker.setFlag("necromancer-thrall-helper", `harvested_${targetId}`, true);
                        if (game.user.isGM) {
                            await message.setFlag("necromancer-thrall-helper", "reactionUsed", "Inevitable Return");
                        } else {
                            game.socket.emit("module.necromancer-thrall-helper", { action: "lockDeathReaction", messageId: message.id, label: "Inevitable Return" });
                            $btn.closest('.death-reaction-actions').html(`
                                <div style="background: rgba(0,0,0,0.5); border: 1px solid #444; border-radius: 4px; padding: 6px; text-align: center; margin-top: 4px;">
                                    <span style="text-decoration: line-through; color: #666; font-weight: bold; font-size: 0.9em; display: block;">
                                        <i class="fas fa-ban"></i> Death Reaction
                                    </span>
                                    <span style="display: block; color: #c084fc; font-size: 0.85em; font-style: italic; margin-top: 2px;">
                                        Expended: Inevitable Return
                                    </span>
                                </div>
                            `);
                        }

                        const dialogForm = dialogHtml[0];
                        const presetId = dialogForm.querySelector("#inevitable-preset").value;

                        const basePayload = await prepareThrallPayload(attacker, presetId);
                        if (!basePayload) return;

                        const finalPayload = foundry.utils.mergeObject(basePayload, {
                            x: targetToken.x, y: targetToken.y,
                            delta: { ownership: { [game.user.id]: 3 }, system: { traits: { size: { value: size } } } }
                        });

                        executeSpawn(finalPayload).catch(err => {
                            console.error("Necromancer Helper | Inevitable Return spawn failed:", err);
                            ui.notifications.error("Failed to materialize the corpse thrall.");
                        });

                        ui.notifications.info("The corpse yields its thrall.");
                    }
                },
                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
            },
            default: "summon"
        }).render(true);
    });

    $html.find(".flesh-terrain-btn").off("click").on("click", async (e) => {
        e.preventDefault();
        const $btn = $(e.currentTarget);
        
        const tX = parseFloat($btn.attr("data-x"));
        const tY = parseFloat($btn.attr("data-y"));
        const tW = parseFloat($btn.attr("data-w"));
        const tH = parseFloat($btn.attr("data-h"));
        const masterId = $btn.attr("data-master");
        const masterActor = game.actors.get(masterId);
        
        if (!canvas.scene || !masterActor) return;
        const gridSize = canvas.scene.grid.size;
        const hazardId = foundry.utils.randomID();
        
        const regionData = {
            name: "Gory Remains",
            color: "#4b5563",
            shapes: [{
                type: "rectangle", hole: false,
                x: tX, y: tY, width: tW * gridSize, height: tH * gridSize, rotation: 0
            }],
            elevation: { bottom: -1000, top: 1000 },
            behaviors: [{
                name: "Gory Difficult Terrain",
                type: "modifyMovementCost",
                system: {} 
            }],
            flags: {
                "necromancer-thrall-helper": { isFleshTerrain: true, hazardId: hazardId }
            }
        };

        const dummyDrawing = {
            author: game.user.id,
            shape: { type: "r", width: tW * gridSize, height: tH * gridSize },
            x: tX, y: tY, hidden: true, 
            flags: { "necromancer-thrall-helper": { hazardId: hazardId } }
        };

        const hazardResult = await executeHazard(regionData, dummyDrawing);
        const createdRegion = Array.isArray(hazardResult) ? hazardResult[0] : hazardResult;

        if (!createdRegion) {
            return ui.notifications.error("Failed to place Gory Remains. Check GM socket.");
        }

        const trackerEffect = {
            name: "Hazard: Gory Remains",
            type: "effect",
            img: "icons/magic/symbols/runes-star-orange.webp",
            system: {
                description: { value: "Tracks the duration of a Gory Remains difficult terrain hazard. Deleting this will clear the hazard from the map." },
                duration: { value: 10, unit: "minutes", expiry: "turn-start" }
            },
            flags: {
                "necromancer-thrall-helper": { isHazardTracker: true, hazardId: hazardId, sceneId: canvas.scene.id }
            }
        };
        await masterActor.createEmbeddedDocuments("Item", [trackerEffect]);

        $btn.closest('div').html(`
            <p style="margin: 4px 0 0 0; text-align: center; color: #9ca3af; font-style: italic; font-size: 0.9em;">
                <i class="fas fa-check"></i> Gory Remains Placed
            </p>
        `);
    });

    $html.find(".blood-pool-spawn-btn").off("click").on("click", async (e) => {
        e.preventDefault();
        const $btn = $(e.currentTarget);
        const isBleed = $btn.attr("data-is-bleed") === "true";
        const necroId = $btn.attr("data-necro-id");
        const targetId = $btn.attr("data-target-id");

        const necroActor = game.actors.get(necroId);
        const targetToken = canvas.tokens.get(targetId);
        if (!necroActor || !targetToken || !canvas.scene) return;

        if (message.getFlag("necromancer-thrall-helper", "reactionUsed")) {
            return ui.notifications.warn("This reaction has already been used.");
        }
        if (!isBleed && necroActor.getFlag("necromancer-thrall-helper", `harvested_${targetId}`)) {
            return ui.notifications.warn("This corpse has already been harvested.");
        }

        if (!isBleed) {
            await necroActor.setFlag("necromancer-thrall-helper", `harvested_${targetId}`, true);
        }

        if (game.user.isGM) {
            await message.setFlag("necromancer-thrall-helper", "reactionUsed", "Blood Pool");
        } else {
            game.socket.emit("module.necromancer-thrall-helper", { action: "lockDeathReaction", messageId: message.id, label: "Blood Pool" });
            $btn.closest('.death-reaction-actions').html(`
                <div style="background: rgba(0,0,0,0.5); border: 1px solid #444; border-radius: 4px; padding: 6px; text-align: center; margin-top: 4px;">
                    <span style="text-decoration: line-through; color: #666; font-weight: bold; font-size: 0.9em; display: block;">
                        <i class="fas fa-ban"></i> Death Reaction
                    </span>
                    <span style="display: block; color: #f87171; font-size: 0.85em; font-style: italic; margin-top: 2px;">
                        Expended: Blood Pool
                    </span>
                </div>
            `);
        }

        const gridSize = canvas.scene.grid.size;
        const poolId = foundry.utils.randomID();
        const necroLevel = necroActor.level || 1;

        const behaviorSource = `
            if (event.data.token?.actor) {
                globalThis.NecroThrallHelper?.handleBloodPoolTrigger(event.region, event.data.token);
            }
        `;

        const regionData = {
            name: `Blood Pool (${necroActor.name})`,
            color: "#990000",
            shapes: [{
                type: "rectangle", hole: false,
                x: targetToken.x, y: targetToken.y, width: gridSize, height: gridSize, rotation: 0
            }],
            elevation: { bottom: -1000, top: 1000 },
            behaviors: [{
                name: "Blood Pool Absorption", type: "executeScript",
                system: { events: ["tokenEnter", "tokenTurnStart"], source: behaviorSource }
            }],
            flags: {
                "necromancer-thrall-helper": { isBloodPool: true, poolId: poolId, masterId: necroActor.id, healValue: necroLevel }
            }
        };

        const drawingData = {
            author: game.user.id, shape: { type: "e", width: gridSize, height: gridSize },
            x: targetToken.x, y: targetToken.y, fillType: 1, fillColor: "#880000", fillAlpha: 0.5,
            strokeWidth: 2, strokeColor: "#ff0000", strokeAlpha: 0.8, text: "🩸 Blood Pool", fontSize: 16, textColor: "#ffffff",
            flags: { "necromancer-thrall-helper": { poolId: poolId } }
        };

        const [createdRegion] = await executeHazard(regionData, drawingData);
        await canvas.scene.createEmbeddedDocuments("Drawing", [drawingData]);

        setTimeout(async () => {
            if (canvas.scene && canvas.scene.regions.has(createdRegion.id)) {
                if (game.user.isGM) {
                    await createdRegion.delete();
                    const drawing = canvas.scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "poolId") === poolId);
                    if (drawing) await drawing.delete();
                } else {
                    game.socket.emit("module.necromancer-thrall-helper", { 
                        action: "deleteBloodPool", 
                        sceneId: canvas.scene.id, 
                        regionId: createdRegion.id, 
                        poolId: poolId 
                    });
                }
            }
        }, 60000);

        ui.notifications.info("Blood Pool materialized on the battlefield.");
    });
});


Hooks.once("ready", () => {
    const aoeApi = game.modules.get("aoe-easy-resolve")?.api;
    if (!aoeApi) return;


    aoeApi.registerInterceptor("preRenderCard", async (payload) => {
        const name = payload.itemName || payload.originItem?.name || "";
        
        if (name.includes("Calcification")) {
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;
                const traits = token.actor.system?.traits?.value || [];
                if (traits.includes("skeleton")) targetData.isImmune = true;
            }
        }
        
        if (name === "Thick Skin" || name.startsWith("Thick Skin")) {
            payload.itemName = "Thick Skin";
            payload.hazardDamage = null;
            
            const casterAlliance = payload.caster?.system?.details?.alliance 
                                || payload.originItem?.actor?.system?.details?.alliance 
                                || "party";
                                
            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;
                
                const targetAlliance = token.actor.system?.details?.alliance || (token.actor.hasPlayerOwner ? "party" : "opposition");
                const isEnemy = targetAlliance !== casterAlliance;
                
                if (!isEnemy || targetData.isImmune) {
                    delete payload.targets[tokenId];
                }
            }
        }
        
        if (name.includes("Flesh Tsunami")) {
            payload.itemName = "Flesh Tsunami (Greater Difficult Terrain)";
        }
        
        if (name.includes("Blossoming Gore Hazard")) {
            payload.hazardDamage = null; 
            payload.itemName = "Blossoming Gore Hazard <style>.blossoming-gore-hide .roll-damage-btn { display: none !important; }</style><span class='blossoming-gore-hide'></span>";
        }
        
        if (name.includes("Dread Mosquito")) {
            payload.hazardDamage = null; 
            payload.itemName = "Dread Mosquito Storm <style>.dms-hide .roll-damage-btn { display: none !important; }</style><span class='dms-hide'></span>";
        }
        
        if (name.includes("Desperate Revival") || name.includes("Necrotic Bomb") || name.includes("Necrotic Blast") || name.includes("Dread Mosquito")) {
            let msg = payload.message || (payload.messageId ? game.messages.get(payload.messageId) : null);
            if (!msg) msg = game.messages.contents.slice().reverse().find(m => m.flags?.["aoe-easy-resolve"]?.itemName === payload.itemName);
            if (!msg) msg = game.messages.get(payload.originMessageId);

            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;
                
                const currentType = msg?.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`) || "void";
                const negHeal = token.actor.system.attributes.hp?.negativeHealing || false;
                const isUnaffected = (currentType === 'vitality' && !negHeal) || (currentType === 'void' && negHeal);
                
                targetData.isImmune = isUnaffected;
                targetData.isHealing = false; 
            }
        }
        
        if (name.includes("Harm")) {
            let msg = payload.message || (payload.messageId ? game.messages.get(payload.messageId) : null);
            if (!msg) msg = game.messages.contents.slice().reverse().find(m => m.flags?.["aoe-easy-resolve"]?.itemName === payload.itemName);
            if (!msg) msg = game.messages.get(payload.originMessageId);

            for (const [tokenId, targetData] of Object.entries(payload.targets)) {
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;
                
                const currentState = msg?.getFlag("necromancer-thrall-helper", `harmState_${tokenId}`) || "void";
                const negHeal = token.actor.system.attributes.hp?.negativeHealing || false;
                
                let isHealing = false;
                if (currentState === "void") isHealing = negHeal;
                if (currentState === "vit") isHealing = !negHeal;
                if (currentState === "heal") isHealing = true;
                
                targetData.isHealing = isHealing;
                targetData.isImmune = false;
            }
        }
        
        return payload;
    }, 999);


    aoeApi.registerInterceptor("preApplyDamage", async (payload) => {
        const msg = payload.messageId ? game.messages.get(payload.messageId) : null;
        const originName = msg?.flags?.["aoe-easy-resolve"]?.itemName || payload.originItem?.name || "";
        
        if (originName.includes("Living Graveyard")) {
            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;
                
                const dos = targetData.degreeOfSuccess;
                if (!dos) continue;

                if (dos === "failure" || dos === "criticalFailure") {
                    try { 
                        if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("prone"); 
                    } catch (e) {}
                    
                    window.aoeEasyResolveApplying?.receipt.push({ 
                        tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, 
                        content: `<span style="color: #ef4444; font-weight: bold;">Knocked Prone!</span>`, 
                        saveNote: "Violent Shake" 
                    });
                } else {
                    window.aoeEasyResolveApplying?.receipt.push({ 
                        tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, 
                        content: `<span style="color: #4ade80; font-weight: bold;">Keeps their footing!</span>`, 
                        saveNote: "Resisted" 
                    });
                }
                targetData.hasApplied = true;
            }
        }
        if (originName === "Thick Skin" || originName.startsWith("Thick Skin")) {
            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;
                const dos = targetData.degreeOfSuccess;
                if (!dos) continue;

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
                window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: receiptText, saveNote: "Thick Skin" });
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Desperate Revival")) {
            let totalSiphonedDamage = 0;
            const caster = payload.originItem?.actor || game.user.character;

            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;

                const dos = targetData.degreeOfSuccess;
                if (!dos || dos === "criticalSuccess" || targetData.isImmune) {
                    window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: `<span style="color: #008000; font-weight: bold;">Unaffected by the siphon.</span>`, saveNote: "Crit Success / Immune" });
                    targetData.hasApplied = true;
                    continue;
                }

                const targetLevel = token.actor.level || 1;
                let damageAmount = 0;
                if (dos === "success") damageAmount = Math.max(1, Math.floor(targetLevel / 2));
                else if (dos === "failure") damageAmount = Math.max(1, targetLevel);
                else if (dos === "criticalFailure") damageAmount = Math.max(2, targetLevel * 2);

                const chosenType = msg?.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`) || "void";
                
                const DamageRoll = CONFIG.Dice.rolls.find(r => r.name === "DamageRoll");
                if (DamageRoll && damageAmount > 0) {
                    const roll = await new DamageRoll(`${damageAmount}[${chosenType}]`).evaluate({async: true});
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
                    if (necroToken && canvas.ready) canvas.interface.createScrollingText(necroToken.center, `+${actualHealed} HP`, { anchor: CONST.TEXT_ANCHOR_POINTS.TOP, fill: 0x4ade80, direction: CONST.TEXT_ANCHOR_POINTS.UP });

                    window.aoeEasyResolveApplying?.receipt.push({ tokenId: necroToken?.id || caster.id, speaker: { alias: caster.name }, img: necroToken?.document?.texture?.src || caster.img, content: `<span style="color: #4ade80; font-weight: bold;">Siphoned ${totalSiphonedDamage} life force, regaining ${actualHealed} HP (Cap: ${halfMaxHP} HP).</span>`, saveNote: "Siphon Harvest" });
                }
            }
        }

        if (originName.includes("Recurring Nightmare")) {
            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;

                const dos = targetData.degreeOfSuccess;
                if (!dos || dos === "criticalSuccess" || dos === "success" || targetData.isImmune) {
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
                    window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: `<span style="color: #a855f7; font-weight: bold;">Terrified by the phantasm! (Frightened ${frightenedVal})</span>`, saveNote: "Recurring Nightmare" });
                }
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Blossoming Gore Hazard")) {
            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor || targetData.isImmune) {
                    targetData.hasApplied = true;
                    continue;
                }

                const dos = targetData.degreeOfSuccess;
                if (!dos || dos === "criticalSuccess") {
                    window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: `<span style="color: #4ade80; font-weight: bold;">Unaffected!</span>`, saveNote: "Crit Success" });
                    targetData.hasApplied = true;
                    continue;
                }

                let drainedVal = (dos === "success" || dos === "failure") ? 1 : (dos === "criticalFailure") ? 2 : 0;
                
                if (drainedVal > 0) {
                    try {
                        if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("drained", { value: drainedVal });
                    } catch (e) {}
                }

                let thrallsToSpawn = dos === "failure" ? 1 : dos === "criticalFailure" ? 2 : 0;
                let receiptContent = `<span style="color: #ff8c00; font-weight: bold;">Drained ${drainedVal}</span>`;
                if (thrallsToSpawn > 0) receiptContent += `<br><div style="margin-top: 4px;"><button type="button" class="gore-spawn-btn" data-count="${thrallsToSpawn}" data-target-id="${tokenId}" style="background: #220000; color: #ff6b6b; border: 1px solid #ff0000; padding: 2px; font-size: 0.85em; border-radius: 4px; cursor: pointer;"><i class="fas fa-ghost"></i> Sprout ${thrallsToSpawn} Thrall(s)</button></div>`;

                window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: receiptContent, saveNote: `Blossoming Gore (${dos})` });
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Conglomerate Grab")) {
            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor || targetData.isImmune) {
                    targetData.hasApplied = true;
                    continue;
                }

                const dos = targetData.degreeOfSuccess;
                if (dos === "failure" || dos === "criticalFailure") {
                    const cond = dos === "failure" ? "grabbed" : "restrained";
                    try { if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition(cond); } catch (e) {}
                    
                    window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: `<span style="color: #cc0000; font-weight: bold;">Snared by limbs! (${cond.charAt(0).toUpperCase() + cond.slice(1)})</span>`, saveNote: "Conglomerate Grab" });
                }
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Deathly Scream")) {
            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor || targetData.isImmune) {
                    targetData.hasApplied = true;
                    continue;
                }

                const dos = targetData.degreeOfSuccess;
                if (dos === "failure" || dos === "criticalFailure") {
                    const val = dos === "failure" ? 1 : 2;
                    try { if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("frightened", {value: val}); } catch (e) {}
                    
                    window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: `<span style="color: #00ffff; font-weight: bold;">Terrified! (Frightened ${val})</span>`, saveNote: "Deathly Scream" });
                }
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Dead Weight")) {
            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor || targetData.isImmune) {
                    targetData.hasApplied = true;
                    continue;
                }

                const dos = targetData.degreeOfSuccess;
                if (dos && dos !== "criticalSuccess") {
                    try {
                        if (typeof token.actor.increaseCondition === "function") {
                            await token.actor.increaseCondition("off-guard");
                            if (dos === "failure" || dos === "criticalFailure") {
                                await token.actor.increaseCondition("slowed", { value: dos === "failure" ? 1 : 2 });
                            }
                        }
                    } catch (e) {}

                    let receiptText = `<span style="color: #a855f7; font-weight: bold;">Off-Guard!</span>`;
                    if (dos === "failure" || dos === "criticalFailure") receiptText += ` <span style="color: #ff0000; font-weight: bold;">(Slowed ${dos === "failure" ? 1 : 2})</span>`;
                    
                    window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: receiptText, saveNote: "Dead Weight" });
                }
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Blood Infusion")) {
            const spellRank = msg?.flags?.["aoe-easy-resolve"]?.spellRank || 1;
            
            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor || targetData.isImmune) {
                    targetData.hasApplied = true;
                    continue;
                }

                const dos = targetData.degreeOfSuccess;
                if (dos && dos !== "criticalSuccess") {
                    try {
                        const bleedEffect = { name: "Infused Blood", type: "effect", img: "icons/magic/water/blood-drop-skull.webp", system: { description: { value: "Loses immunity to bleed and is considered a creature with blood for 1 minute." }, duration: { value: 1, unit: "minutes", expiry: null }, rules: [{ key: "Immunity", type: "bleed", mode: "remove" }] } };
                        await token.actor.createEmbeddedDocuments("Item", [bleedEffect]);
                        
                        const damageFormula = dos === "success" ? `${spellRank}` : dos === "failure" ? `${spellRank}d6` : `${spellRank * 2}d6`;
                        if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("persistent-damage", { value: damageFormula, suboption: "bleed" });
                        
                        window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: `<span style="color: #ff0000; font-weight: bold;">Infused! Bleed Immunity Stripped & takes ${damageFormula} persistent bleed.</span>`, saveNote: "Blood Infusion" });
                    } catch (e) {}
                }
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Life Tap")) {
            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor || targetData.isImmune) {
                    targetData.hasApplied = true;
                    continue;
                }

                const dos = targetData.degreeOfSuccess;
                if (dos && dos !== "criticalSuccess") {
                    const drainedVal = dos === "success" ? 1 : dos === "failure" ? 2 : 3;
                    try {
                        if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("drained", { value: drainedVal });
                    } catch (e) {}

                    const targetLevel = token.actor.level || 1;
                    const hpLost = drainedVal * targetLevel;
                    const healingAmount = hpLost * 2;

                    const caster = payload.originItem?.actor || game.user.character;
                    const eligibleAllies = canvas.tokens.placeables.filter(t => t.actor && (t.actor.system?.details?.alliance === "party" || t.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY));
                    let recipientActor = caster;
                    
                    if (eligibleAllies.length > 1) {
                        let optionsHtml = eligibleAllies.map(t => `<option value="${t.actor.id}">${t.name}</option>`).join("");
                        await new Promise(resolve => {
                            new Dialog({
                                title: "Life Tap: Siphon Recipient",
                                content: `<p><b>${token.name}</b> lost ${hpLost} maximum HP. Choose who receives <b>${healingAmount} HP</b> of healing:</p><form><select id="heal-recipient">${optionsHtml}</select></form>`,
                                buttons: { select: { label: "Apply Healing", callback: (html) => { const found = game.actors.get(html.find("#heal-recipient").val()); if (found) recipientActor = found; resolve(); } } },
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
                        if (recipientToken && canvas.ready && actualHealed > 0) canvas.interface.createScrollingText(recipientToken.center, `+${actualHealed} HP`, { anchor: CONST.TEXT_ANCHOR_POINTS.TOP, fill: 0x4ade80, direction: CONST.TEXT_ANCHOR_POINTS.UP });

                        window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: `<span style="color: #8a2be2; font-weight: bold;">Drained ${drainedVal} (${hpLost} HP).</span><br><span style="color: #4ade80;">Healed ${recipientActor.name} for ${actualHealed} HP!</span>`, saveNote: "Life Tap" });
                    }
                }
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Flesh Tsunami")) {
            const hasLimbs = msg?.getFlag("necromancer-thrall-helper", "limbsActivated");
            const aoeFlags = msg?.flags?.["aoe-easy-resolve"] || payload.originItem?.flags?.["aoe-easy-resolve"] || {};
            const saveDC = aoeFlags.saveDC || 10;

            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;

                if (!hasLimbs) {
                    window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: `<span style="color: #888; font-weight: bold;">Area is Greater Difficult Terrain.</span>`, saveNote: "Flesh Tsunami" });
                    targetData.hasApplied = true;
                    continue;
                }

                if (targetData.isImmune) {
                    window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: `<span style="color: #888; font-weight: bold;">Unaffected by limbs (Ally).</span>`, saveNote: "Immune" });
                    targetData.hasApplied = true;
                    continue;
                }

                const dos = targetData.degreeOfSuccess;
                if (!dos || dos === "criticalSuccess" || dos === "success") {
                    window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: `<span style="color: #4ade80; font-weight: bold;">Evades the grasping flesh!</span>`, saveNote: "Flesh Tsunami" });
                    targetData.hasApplied = true;
                    continue;
                }

                try {
                    if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("immobilized");
                } catch (e) { }

                window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: `<span style="color: #ef4444; font-weight: bold;">Snared by the gory wave! (Immobilized, Escape DC ${saveDC})</span>`, saveNote: "Flesh Tsunami" });
                targetData.hasApplied = true;
            }
        }
        if (originName.includes("Temporary Possession")) {
            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;

                const dos = targetData.degreeOfSuccess;
                if (!dos) continue;

                let receiptText = "";
                let actionsAllowed = 0;

                if (dos === "criticalSuccess") {
                    receiptText = `<span style="color: #4ade80; font-weight: bold;">Shrugs off the possession completely! Unaffected.</span>`;
                } else {
                    if (dos === "success") actionsAllowed = 1;
                    else if (dos === "failure") actionsAllowed = 2;
                    else if (dos === "criticalFailure") actionsAllowed = 3;

                    try {
                        if (typeof token.actor.increaseCondition === "function") await token.actor.increaseCondition("stunned", { value: 1 });
                    } catch (e) {}

                    receiptText = `
                        <div style="text-align: left; font-size: 0.9em; margin-top: 2px;">
                            <span style="color: #ef4444; font-weight: bold; text-transform: uppercase;">Controlled (${dos.replace(/([A-Z])/g, ' $1')})</span><br>
                            • Can spend up to <b>${actionsAllowed} action(s)</b>: <i>Drop Prone, Interact, Release, or Strike</i>.<br>
                            • Strike MAP applies.<br>
                            • Becomes <b>Stunned 1</b> at end of turn.<br>
                            <span style="color: #f87171; font-size: 0.85em; font-style: italic;">⚠️ Reflected Damage Warning: If this creature loses HP while possessed or stunned by this, you take half that amount!</span>
                        </div>
                    `;
                }

                window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: receiptText, saveNote: `Temporary Possession (${dos})` });
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Calcification")) {
            const aoeFlags = msg?.flags?.["aoe-easy-resolve"] || payload.originItem?.flags?.["aoe-easy-resolve"] || {};
            const saveDC = aoeFlags.saveDC || 10;

            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;

                const dos = targetData.degreeOfSuccess;
                if (!dos) continue;

                const traits = token.actor.system?.traits?.value || [];
                const isSkeleton = traits.includes("skeleton") || targetData.isImmune;

                if (isSkeleton || dos === "criticalSuccess") {
                    window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: `<span style="color: #4ade80; font-weight: bold;">Unaffected by the bone dust!</span>`, saveNote: isSkeleton ? "Immune (Skeleton)" : "Crit Success" });
                    targetData.hasApplied = true;
                    continue;
                }

                const isIncorporeal = traits.includes("incorporeal");
                let title = "";
                let details = "";
                let slowVal = 0;
                let weakVal = 0;

                if (dos === "success") {
                    slowVal = 1; weakVal = 5;
                    title = `<span style="color: #eab308; font-weight: bold; text-transform: uppercase;">Calcifying!</span>`;
                    details = `Slowed 1, Weakness 5 Bludg. (1 rd)`;
                } else if (dos === "failure") {
                    slowVal = 1; weakVal = 10;
                    title = `<span style="color: #f97316; font-weight: bold; text-transform: uppercase;">Calcifying Heavily!</span>`;
                    details = `Slowed 1, Weakness 10 Bludg.<br><span style="font-size: 0.9em; font-style: italic; color: #ccc;">End of turn Fort save.</span>`;
                } else if (dos === "criticalFailure") {
                    slowVal = 2; weakVal = 10;
                    title = `<span style="color: #ef4444; font-weight: bold; text-transform: uppercase;">Rapidly Petrifying!</span>`;
                    details = `Slowed 2, Weakness 10 Bludg.<br><span style="font-size: 0.9em; font-style: italic; color: #ccc;">End of turn Fort save.</span>`;
                }

                if (isIncorporeal) details += `<br><span style="color: #a855f7; font-weight: bold; font-size: 0.95em;">⚠️ Loses Incorporeal Trait!</span>`;

                const receiptText = `
                    <div style="display: flex; flex-direction: column; align-items: flex-end; text-align: right; width: 100%; line-height: 1.2;">
                        ${title}
                        <div style="font-size: 0.9em; margin-top: 2px;">${details}</div>
                    </div>
                `;

                try {
                    if (typeof token.actor.increaseCondition === "function") {
                        for (let i = 0; i < slowVal; i++) await token.actor.increaseCondition("slowed");
                    }
                } catch (e) { }

                try {
                    const existingEffect = token.actor.items.find(i => i.system?.slug === "effect-calcification" || i.name === "Effect: Calcification");
                    if (!existingEffect) {
                        const effectData = {
                            name: "Effect: Calcification", type: "effect", img: "icons/magic/death/skeleton-skull-soul-blue.webp",
                            system: {
                                slug: "effect-calcification", level: { value: 9 },
                                duration: { value: dos === "success" ? 1 : -1, unit: dos === "success" ? "rounds" : "unlimited", expiry: "turn-start" },
                                description: { value: `You are calcifying. Weakness ${weakVal} to bludgeoning.` },
                                rules: [{ key: "Weakness", type: "bludgeoning", value: weakVal }]
                            },
                            flags: { "necromancer-thrall-helper": { calcificationDC: saveDC, isCalcifying: true } }
                        };
                        await token.actor.createEmbeddedDocuments("Item", [effectData]);
                    }
                } catch (e) { }

                window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: receiptText, saveNote: `Calcification (${dos})` });
                targetData.hasApplied = true;
            }
        }

        if (originName.includes("Dread Mosquito")) {
            const aoeFlags = msg?.flags?.["aoe-easy-resolve"] || payload.originItem?.flags?.["aoe-easy-resolve"] || {};
            const saveDC = aoeFlags.saveDC || 10;
            const casterId = payload.originItem?.actor?.id || payload.caster?.id || "";

            for (let [tokenId, targetData] of Object.entries(payload.targets)) {
                if (targetData.hasApplied) continue;
                const token = canvas.tokens.get(tokenId);
                if (!token?.actor) continue;

                const dos = targetData.degreeOfSuccess;
                if (!dos) continue;

                const chosenType = msg?.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`) || "void";
                const negHeal = token.actor.system.attributes.hp?.negativeHealing || false;
                const isImmuneToSwarm = (chosenType === 'vitality' && !negHeal) || (chosenType === 'void' && negHeal) || targetData.isImmune;

         
                const hasDisease = token.actor.items.some(i => i.getFlag("necromancer-thrall-helper", "isNecroticBlood"));
                if (hasDisease) {
                    window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: "" }, img: "icons/magic/water/blood-drop-skull.webp", content: `<div style="text-align: right; padding-right: 5px; font-size: 0.9em;"><i class="fas fa-level-up-alt fa-rotate-90" style="color: #555; margin-right: 4px;"></i> <span style="color: #888; font-weight: bold;">Already Infected!</span></div>`, saveNote: "Infected" });
                    targetData.hasApplied = true;
                    continue; 
                }

                if (dos === "criticalSuccess" || isImmuneToSwarm) {
                    window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: token.name }, img: token.document?.texture?.src, content: `<span style="color: #4ade80; font-weight: bold;">Evades the plague!</span>`, saveNote: isImmuneToSwarm ? "Immune" : "Crit Success" });
                    targetData.hasApplied = true;
                    continue;
                }

                const stage = (dos === "criticalFailure") ? 2 : 1;
                const durationRounds = (dos === "success") ? 1 : 6;
                const weaknessVal = stage === 3 ? 20 : stage * 5;

                const receiptText = `<div style="text-align: right; padding-right: 5px; font-size: 0.9em;"><i class="fas fa-level-up-alt fa-rotate-90" style="color: #555; margin-right: 4px;"></i> <span style="color: ${dos === 'success' ? '#eab308' : '#ef4444'}; font-weight: bold;">Plagued! (Stage ${stage})</span></div>`;

                window.aoeEasyResolveApplying?.receipt.push({ tokenId: tokenId, speaker: { alias: "" }, img: "icons/magic/water/blood-drop-skull.webp", content: receiptText, saveNote: `Stage ${stage}` });

                let diseaseAttempts = 0;
                const applyDisease = async () => {
                    try {
                        let currentSickened = token.actor.getCondition("sickened")?.value || 0;
                        if (currentSickened < stage) {
                            await token.actor.increaseCondition("sickened");
                        }
                        
                        const hasEffect = token.actor.items.some(i => i.system?.slug === "effect-necrotic-blood");
                        if (!hasEffect) {
                            const effectData = {
                                name: "Effect: Necrotic Blood", type: "effect", img: "icons/magic/water/blood-drop-skull.webp",
                                system: {
                                    slug: "effect-necrotic-blood", level: { value: 18 }, 
                                    duration: { value: durationRounds, unit: "rounds", expiry: "turn-end" },
                                    description: { value: `<b>Necrotic Blood (Stage ${stage})</b><br>Stage 1: 3d10 ${chosenType}, Sickened 1, Weakness 5 Bleed.<br>Stage 2: 4d10 ${chosenType}, Sickened 2, Weakness 10 Bleed.<br>Stage 3: 5d10 ${chosenType}, Sickened 3, Weakness 20 Bleed.<br><br><i>If this creature dies, a thrall rises from its corpse.</i>` },
                                    rules: [{ key: "Weakness", type: "bleed", value: weaknessVal }]
                                },
                                flags: { "necromancer-thrall-helper": { isNecroticBlood: true, masterId: casterId, dmgType: chosenType, necroticBloodDC: saveDC, stage: stage } }
                            };
                            await token.actor.createEmbeddedDocuments("Item", [effectData]);
                        }
                    } catch(e) {
                        if (diseaseAttempts < 20) {
                            diseaseAttempts++;
                            setTimeout(applyDisease, 100);
                        } else {
                            console.error("Necromancer Helper | Disease DB lock timeout:", e);
                        }
                    }
                };
                applyDisease();

                targetData.hasApplied = true;
            }
        }

        return payload;
    }, 999);
});


Hooks.on("aoeEasyResolve.renderRow", async (message, $row, tokenId) => {
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
    if (!casterId && aoeItemUuid && aoeItemUuid.includes("Actor.")) {
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
            $row.find('.save-btn-container, .roll-save-btn').css("cssText", "display: none !important;");
            if ($row.find('.miss-badge').length === 0) {
                $row.find('.token-name').after(' <span class="miss-badge" style="color: #999; font-size: 0.8em; font-weight: bold; margin-left: 5px;">[Immune]</span>');
            }
            return;
        }

        if (!hasLimbs) {
            $row.find('.save-btn-container, .roll-save-btn').css("cssText", "display: none !important;");
            if ($row.find('.terrain-badge').length === 0) {
                $row.find('.token-name').after(' <span class="terrain-badge" style="color: #999; font-size: 0.8em; font-weight: bold; margin-left: 5px;">[Greater Difficult Terrain]</span>');
            }
        } else {
            $row.find('.save-btn-container, .roll-save-btn').css("cssText", "display: flex !important;");
            $row.find('.terrain-badge').remove();
        }
        return;
    }
    const actor = game.actors.get(casterId);
    const isCaster = casterId ? actor?.isOwner : false;
    const hasPermission = game.user.isGM || message.isAuthor || isCaster;
    const targetToken = canvas?.tokens?.get(tokenId);
    if (!targetToken?.actor) return;

    const injectToggle = ($r, htmlString) => {
        const $saveContainer = $r.find('.save-btn-container, .roll-save-btn').first();
        if ($saveContainer.length > 0) $saveContainer.before(htmlString);
        else {
            const $img = $r.find('img').first();
            if ($img.length > 0) $img.parent().append(htmlString);
            else $r.find('.token-name, span[title]').first().after(htmlString);
        }
    };

    if (isGrabCard) {
        const targetData = aoeFlags.targets?.[tokenId];
        if (targetData?.isImmune) {
            $row.find('.save-btn-container, .roll-save-btn').hide();
            if ($row.find('.miss-badge').length === 0) $row.find('.token-name').after(' <span class="miss-badge" style="color: #999; font-size: 0.8em; font-weight: bold; margin-left: 5px;">[Missed]</span>');
        }
        return;
    }

    if (isDesperateCard || isErasCard || isMosquitoCard) {
        if (isDesperateCard) {
            const hasMastery = actor?.items.some(i => i.name === "Mastery of Life and Death" || i.slug === "mastery-of-life-and-death");
            if (!hasMastery) return;
        }

        if ($row.find('.necro-type-toggle').length > 0) return;

        const currentType = message.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`) || "void";
        const negHeal = targetToken.actor.system.attributes.hp?.negativeHealing || false;
        const isUnaffected = (currentType === 'vitality' && !negHeal) || (currentType === 'void' && negHeal);

        const cursorStyle = hasPermission ? 'pointer' : 'default';
        const getBg = (type) => currentType === type ? (type === 'void' ? '#660066' : '#b58900') : '#222';
        const getColor = (type) => currentType === type ? '#fff' : '#999';

        const toggleHtml = `
            <div class="necro-type-toggle" data-token-id="${tokenId}" style="display: inline-flex; align-items: center; margin-left: 5px; vertical-align: middle;">
                <button type="button" class="necro-type-btn void-opt" data-type="void" style="cursor: ${cursorStyle}; padding: 2px 6px; font-size: 0.7em; background: ${getBg('void')}; color: ${getColor('void')}; border: 1px solid #444; border-radius: 3px 0 0 3px;">Void</button>
                <button type="button" class="necro-type-btn vit-opt" data-type="vitality" style="cursor: ${cursorStyle}; padding: 2px 6px; font-size: 0.7em; background: ${getBg('vitality')}; color: ${getColor('vitality')}; border: 1px solid #444; border-radius: 0 3px 3px 0;">Vit</button>
            </div>
        `;
        
        injectToggle($row, toggleHtml);

        const $saveBtn = $row.find('.roll-save-btn');
        const $healBadge = $row.find('span:contains("Healing")');
        
        const hasDisease = isMosquitoCard && targetToken.actor.items.some(i => i.getFlag("necromancer-thrall-helper", "isNecroticBlood"));

        if (isUnaffected) {
            $saveBtn.hide();
            $healBadge.hide();
            if ($row.find('.no-save-badge').length === 0) $saveBtn.after('<span class="no-save-badge" style="font-weight: bold; color: #4ade80; font-size: 0.75em; margin-left: 5px;">(Unaffected)</span>');
        } else if (hasDisease) {
            $saveBtn.hide();
            $healBadge.hide();
            if ($row.find('.no-save-badge').length === 0) $saveBtn.after('<span class="no-save-badge" style="font-weight: bold; color: #888; font-size: 0.75em; margin-left: 5px;">(Already Infected)</span>');
        } else {
            $saveBtn.show();
            $healBadge.hide(); 
            $row.find('.no-save-badge').remove();
        }

        if (hasPermission) {
            $row.find('.necro-type-btn').off('click').on('click', async (e) => {
                e.preventDefault(); e.stopPropagation();
                const $btn = $(e.currentTarget);
                await message.setFlag("necromancer-thrall-helper", `dmgType_${tokenId}`, $btn.attr('data-type'));
            });
        }
    }

    // --- INVERT HARM ---
    if (isHarmCard) {
        if (!actor) return;
        const hasMastery = actor.items.some(i => i.name === "Mastery of Life and Death" || i.slug === "mastery-of-life-and-death");
        const hasInvert = actor.items.some(i => i.name === "Invert Harm" || i.slug === "invert-harm");
        if (!hasMastery && !hasInvert) return;
        if ($row.find('.harm-type-toggle').length > 0) return;

        const currentState = message.getFlag("necromancer-thrall-helper", `harmState_${tokenId}`) || "void";
        const cursorStyle = hasPermission ? 'pointer' : 'default';

        const getBg = (type) => currentState === type ? (type === 'void' ? '#660066' : type === 'vit' ? '#b58900' : '#4ade80') : '#222';
        const getColor = (type) => currentState === type && type === 'heal' ? '#000' : (currentState === type ? '#fff' : '#999');

        const vitButton = hasMastery ? `<button type="button" class="harm-type-btn harm-vit-opt" data-type="vit" style="cursor: ${cursorStyle}; padding: 2px 6px; font-size: 0.7em; background: ${getBg('vit')}; color: ${getColor('vit')}; border: 1px solid #444; border-radius: ${hasInvert ? '0' : '0 3px 3px 0'};">Vit</button>` : '';
        const healButton = hasInvert ? `<button type="button" class="harm-type-btn harm-heal-opt" data-type="heal" style="cursor: ${cursorStyle}; padding: 2px 6px; font-size: 0.7em; background: ${getBg('heal')}; color: ${getColor('heal')}; border: 1px solid #444; border-radius: 0 3px 3px 0;">Heal</button>` : '';

        const toggleHtml = `
            <div class="harm-type-toggle" data-token-id="${tokenId}" style="display: inline-flex; align-items: center; margin-left: 5px; vertical-align: middle;">
                <button type="button" class="harm-type-btn harm-void-opt" data-type="void" style="cursor: ${cursorStyle}; padding: 2px 6px; font-size: 0.7em; background: ${getBg('void')}; color: ${getColor('void')}; border: 1px solid #444; border-radius: 3px 0 0 3px;">Void</button>
                ${vitButton}
                ${healButton}
            </div>
        `;

        injectToggle($row, toggleHtml);

        const negHeal = targetToken.actor.system.attributes.hp?.negativeHealing || false;
        let isHealing = false;
        if (currentState === "void") isHealing = negHeal;
        if (currentState === "vit") isHealing = !negHeal;
        if (currentState === "heal") isHealing = true;

        const $saveBtn = $row.find('.roll-save-btn');
        const $nativeHealBadge = $row.find('span:contains("Healing")');

        if (isHealing) {
            $saveBtn.hide();
            $nativeHealBadge.hide();
            if ($row.find('.aoe-heal-badge').length === 0) $saveBtn.after('<span class="aoe-heal-badge" style="font-weight: bold; color: #4ade80; font-size: 0.75em; margin-left: 5px;">(AoE Heal)</span>');
        } else {
            $saveBtn.show();
            $nativeHealBadge.hide();
            $row.find('.aoe-heal-badge').remove();
        }

        if (hasPermission) {
            $row.find('.harm-type-btn').off('click').on('click', async (e) => {
                e.preventDefault(); e.stopPropagation();
                const $btn = $(e.currentTarget);
                await message.setFlag("necromancer-thrall-helper", `harmState_${tokenId}`, $btn.attr('data-type'));
            });
        }
    }
});
// --- CAROUSEL COMBAT TRACKER SAFE DELETION INTERCEPTOR ---
Hooks.on("preDeleteToken", (tokenDoc, options, userId) => {
    if (!game.combat || !tokenDoc.inCombat) return true;
    
    if (!game.user.isGM) return true;

    if (options.necroSafeDeleteFinished) return true;

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


globalThis.NecroThrallHelper = globalThis.NecroThrallHelper || {};

globalThis.NecroThrallHelper.declinedPools = globalThis.NecroThrallHelper.declinedPools || new Set();

globalThis.NecroThrallHelper.handleBloodPoolTrigger = async (regionDoc, tokenObj) => {
    const actor = tokenObj.actor;
    if (!actor) return;
    
    if (!actor.isOwner) return;

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
        content: `
            <p><b>${tokenObj.name}</b> stepped into an infused Blood Pool!</p>
            <p>Spend a <b>Free Action</b> to absorb the lifeblood and recover <b>${healValue} Hit Points</b>?</p>
        `,
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
                        speaker: ChatMessage.getSpeaker({ actor: actor }),
                        flavor: `<strong>Blood Pool Absorbed!</strong>`,
                        content: `<p><b>${tokenObj.name}</b> drinks the infused essence, recovering <b>${actualHealed} Hit Points</b>!</p>`
                    });

                    // --- PROPER SOCKET EMISSION ---
                    if (game.user.isGM) {
                        if (canvas.scene.regions.has(regionDoc.id)) await regionDoc.delete();
                        const drawing = canvas.scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "poolId") === poolId);
                        if (drawing) await drawing.delete();
                    } else {
                        game.socket.emit("module.necromancer-thrall-helper", {
                            action: "deleteBloodPool",
                            sceneId: canvas.scene.id,
                            regionId: regionDoc.id,
                            poolId: poolId
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




Hooks.on("createChatMessage", async (message) => {
    if (message.author?.id !== game.user.id) return;
    
    const pf2eFlags = message.flags?.pf2e || {};
    const context = pf2eFlags.context || {};
    if (context.type !== "damage-roll") return;

    const rollOptions = context.options || [];
    const hasDrainingStrike = rollOptions.some(o => o === "draining-strike" || o.startsWith("draining-strike:"));
    if (!hasDrainingStrike) return;

    const actorId = message.speaker?.actor;
    const actor = game.actors.get(actorId);
    if (!actor) return;

    let requiredThralls = 1;
    const dsFeat = actor.items.find(i => i.slug === "draining-strike" || i.name === "Draining Strike");
    
    if (dsFeat) {
        const selection = dsFeat.flags?.pf2e?.rulesSelections?.drainingStrike || dsFeat.flags?.pf2e?.rulesSelections?.["draining-strike"];
        if (selection) {
            requiredThralls = parseInt(selection, 10) || 1;
        }
    }

    let rawSpiritDamage = 0;
    if (message.rolls && message.rolls.length > 0) {
        const roll = message.rolls[0];
        if (roll.instances) {
            roll.instances.forEach(inst => {
                if (inst.type === "spirit") {
                    rawSpiritDamage += (inst.total ?? inst._total ?? 0);
                }
            });
        }
    }

    if (rawSpiritDamage === 0) return;

    let targetTokenId = context.target?.token; 
    let targetToken = canvas.tokens.get(targetTokenId);
    if (!targetToken && game.user.targets.size > 0) {
        targetToken = Array.from(game.user.targets)[0];
    }

    let spiritHeal = rawSpiritDamage;

    if (targetToken && targetToken.actor) {
        const attrs = targetToken.actor.system.attributes;
        const immunities = attrs.immunities || [];
        const resistances = attrs.resistances || [];
        const weaknesses = attrs.weaknesses || [];

        const isImmune = immunities.some(i => i.type === "spirit" || i.type === "all-damage");
        
        if (isImmune) {
            spiritHeal = 0;
        } else {
            const weakness = weaknesses.find(w => w.type === "spirit" || w.type === "all-damage")?.value || 0;
            const resistance = resistances.find(r => r.type === "spirit" || r.type === "all-damage")?.value || 0;
            
            spiritHeal = Math.max(0, spiritHeal + weakness - resistance);
        }
    }

    if (spiritHeal === 0) {
        return ui.notifications.info("Draining Strike hit, but the target resisted all Spirit damage. No healing granted.");
    }

    let necroToken = canvas.tokens.get(message.speaker?.token) || actor.getActiveTokens()[0];
    const gridDist = canvas.scene?.grid?.distance || 5;

    const availableThralls = canvas.tokens.placeables.filter(t => {
        if (t.document.getFlag("necromancer-thrall-helper", "masterId") !== actor.id) return false;

        let distToNecro = 999;
        let distToTarget = 999;

        if (necroToken) {
            const dx = Math.abs(necroToken.x - t.x);
            const dy = Math.abs(necroToken.y - t.y);
            distToNecro = (Math.max(dx, dy) / canvas.grid.size) * gridDist;
        }

        if (targetToken) {
            const dx = Math.abs(targetToken.x - t.x);
            const dy = Math.abs(targetToken.y - t.y);
            distToTarget = (Math.max(dx, dy) / canvas.grid.size) * gridDist;
        }

        return distToNecro <= 10 || distToTarget <= 10;
    });

    if (availableThralls.length < requiredThralls) {
        return ui.notifications.error(`Draining Strike requires ${requiredThralls} thrall(s) within 10ft of you or the target, but only found ${availableThralls.length}.`);
    }

    let checkboxes = "";
    availableThralls.forEach((t, index) => {
        checkboxes += `<div style="display: flex; align-items: center; margin-bottom: 5px;">
            <input type="checkbox" id="drain-thrall-${index}" value="${t.id}" class="drain-checkbox" style="margin-right: 10px;">
            <label for="drain-thrall-${index}" style="display: flex; align-items: center; cursor: pointer;">
                <img src="${t.document.texture?.src || "icons/svg/mystery-man.svg"}" width="30" height="30" style="border: none; margin-right: 10px; border-radius: 4px; object-fit: cover;">
                ${t.name}
            </label>
        </div>`;
    });

    const formHtml = `
        <form id="drain-form" style="margin-bottom: 10px;">
            <p>Select <b>${requiredThralls}</b> thrall(s) to destroy to siphon their essence.</p>
            <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #4ade80; margin-bottom: 10px;">
                <p style="margin: 0; font-size: 0.9em;">Raw Spirit Damage: <b>${rawSpiritDamage}</b></p>
                <p style="margin: 0; font-size: 0.9em;">Post-Mitigation Healing: <b>${spiritHeal} HP</b></p>
            </div>
            <div style="max-height: 200px; overflow-y: auto; border: 1px solid #333; padding: 5px; background: rgba(0,0,0,0.2); border-radius: 4px;">
                ${checkboxes}
            </div>
        </form>
    `;

    new Dialog({
        title: "Draining Strike",
        content: formHtml,
        buttons: {
            drain: {
                icon: '<i class="fas fa-heart-broken"></i>',
                label: "Drain",
                callback: async (dialogHtml) => {
                    const selectedIds = [];
                    dialogHtml.find('.drain-checkbox:checked').each((i, cb) => selectedIds.push(cb.value));

                    if (selectedIds.length !== requiredThralls) {
                        return ui.notifications.warn(`You must select exactly ${requiredThralls} thrall(s). Action aborted.`);
                    }

                    const tokensToDelete = selectedIds.map(id => canvas.tokens.get(id));
                    const names = tokensToDelete.map(t => t.name).join(", ");
                    for (const t of tokensToDelete) await t.document.delete();

                    const currentHP = actor.system.attributes.hp.value;
                    const maxHP = actor.system.attributes.hp.max;
                    const actualHealed = Math.min(maxHP - currentHP, spiritHeal);
                    
                    await actor.update({ "system.attributes.hp.value": currentHP + actualHealed });

                    if (actualHealed > 0 && canvas.ready && necroToken) {
                        canvas.interface.createScrollingText(necroToken.center, `+${actualHealed} HP`, { anchor: CONST.TEXT_ANCHOR_POINTS.TOP, fill: 0x4ade80, direction: CONST.TEXT_ANCHOR_POINTS.UP });
                    }

                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor: actor }),
                        flavor: `<strong>Draining Strike</strong>`,
                        content: `<p><b>${actor.name}</b> destroys <b>${names}</b>, funneling their stolen vitality to recover <b>${actualHealed} HP</b>!</p>`
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "drain",
        render: (dialogHtml) => {
            dialogHtml.find('.drain-checkbox').on('change', function() {
                const checkedCount = dialogHtml.find('.drain-checkbox:checked').length;
                if (checkedCount > requiredThralls) {
                    this.checked = false;
                    ui.notifications.warn(`You only need to sacrifice ${requiredThralls} thrall(s).`);
                }
            });
        }
    }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
});
Hooks.on("renderChatMessage", (message, html) => {
    const $html = html instanceof jQuery ? html : $(html);
    
    $html.find('.gore-spawn-btn').off('click').on('click', async (e) => {
        e.preventDefault();
        const $btn = $(e.currentTarget);
        const count = parseInt($btn.attr('data-count'), 10);
        const targetId = $btn.attr('data-target-id');
        const targetToken = canvas.tokens.get(targetId);
        const targetName = targetToken ? targetToken.name : "the field";
        
        const attacker = game.user.character || canvas.tokens.controlled[0]?.actor;
        if (!attacker) return ui.notifications.warn("No Necromancer found to command the thralls!");

        const presets = typeof getThrallPresets === "function" ? getThrallPresets(attacker) : [];
        if (presets.length === 0) return ui.notifications.warn("No thrall presets found.");

        let optionsHtml = '<option value="default">(Default Thrall)</option><option value="random">(Random Family Member)</option>';
        presets.forEach(p => {
            const isAlreadyActive = canvas?.scene?.tokens?.some(t => t.getFlag("necromancer-thrall-helper", "masterId") === attacker.id && t.name === p.name);
            if (p.isUnique && isAlreadyActive) {
                optionsHtml += `<option value="${p.id}" disabled>${p.name} (Already Active)</option>`;
            } else {
                optionsHtml += `<option value="${p.id}">${p.name}</option>`;
            }
        });

        let formHtml = `<form><p>Select the identities for the <b>${count}</b> new thrall(s) spawned near <b>${targetName}</b>:</p>`;
        for (let i = 0; i < count; i++) {
            formHtml += `
                <div class="form-group">
                    <label>Thrall ${i + 1}:</label>
                    <div class="form-fields">
                        <select id="gore-preset-${i}">${optionsHtml}</select>
                    </div>
                </div>`;
        }
        formHtml += `</form>`;

        new Dialog({
            title: "Blood-Born Thralls",
            content: formHtml,
            buttons: {
                summon: {
                    icon: '<i class="fas fa-ghost"></i>',
                    label: "Sprout",
                    callback: async (dialogHtml) => {
                        const dialogForm = dialogHtml[0];
                        let selections = [];
                        let selectedUnique = new Set();

                        for (let i = 0; i < count; i++) {
                            const val = dialogForm.querySelector(`#gore-preset-${i}`).value;
                            const preset = presets.find(p => p.id === val);
                            
                            if (preset && preset.isUnique) {
                                if (selectedUnique.has(val)) {
                                    ui.notifications.error(`${preset.name} is unique and cannot be summoned multiple times.`);
                                    return; 
                                }
                                selectedUnique.add(val);
                            }
                            selections.push(val);
                        }

                        let currentSpawnIndex = 0;

                        ui.notifications.info(`Click the canvas to sprout Thrall ${currentSpawnIndex + 1} adjacent to the field. Right-click to cancel.`);
                        document.body.style.cursor = "crosshair";
                        canvas.app.view.style.cursor = "crosshair";

                        const ghost = new PIXI.Graphics();
                        ghost.beginFill(0xcc0000, 0.4);
                        ghost.lineStyle(2, 0xff0000, 0.8);
                        ghost.drawRect(0, 0, canvas.grid.size, canvas.grid.size);
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
                                ui.notifications.info("Sprouting cancelled.");
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
                            
                            const basePayload = await prepareThrallPayload(attacker, presetId);
                            if (!basePayload) { cleanUp(); return; }

                            const finalPayload = foundry.utils.mergeObject(basePayload, {
                                x: spawnX,
                                y: spawnY,
                                delta: { ownership: { [game.user.id]: 3 } }
                            });

                            currentSpawnIndex++;
                            executeSpawn(finalPayload).catch(err => {
                                console.error("Necromancer Helper | Spawn execution failed:", err);
                                ui.notifications.error("Failed to materialize the thrall.");
                            });

                            if (currentSpawnIndex < count) {
                                ui.notifications.info(`Place Thrall ${currentSpawnIndex + 1}.`);
                                canvas.stage.once("pointerdown", interactionHandler);
                            } else {
                                cleanUp();
                                $btn.remove(); 
                                ui.notifications.info("All blood thralls sprouted.");
                            }
                        };

                        canvas.stage.once("pointerdown", interactionHandler);
                    }
                },
                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
            },
            default: "summon"
        }).render(true);
    });
});
Hooks.on("renderChatMessage", (message, html) => {
    const $html = html instanceof jQuery ? html : $(html);

    $html.find(".desperate-revival-trigger-btn").off("click").on("click", async (e) => {
        e.preventDefault();
        const $btn = $(e.currentTarget);
        const necroId = $btn.attr("data-necro-id");
        const necroActor = game.actors.get(necroId);
        if (!necroActor) return;

        const necroTokens = necroActor.getActiveTokens();
        if (necroTokens.length === 0) return ui.notifications.warn("Necromancer token not found on the canvas.");
        const necroToken = necroTokens[0];

        const preWounded = necroActor.getCondition?.("wounded")?.value || 0;

        await necroActor.update({ "system.attributes.hp.value": 1 });
        await necroActor.setFlag("necromancer-thrall-helper", "desperateRevivalUsed", true);

        const dying = necroActor.getCondition?.("dying");
        if (dying) await dying.delete();
        const unconscious = necroActor.getCondition?.("unconscious");
        if (unconscious) await unconscious.delete();

        for (let attempts = 0; attempts < 20; attempts++) {
            const currentWoundedCond = necroActor.getCondition?.("wounded");
            if ((currentWoundedCond?.value || 0) > preWounded) {
                if (preWounded === 0) await currentWoundedCond.delete();
                else if (typeof necroActor.decreaseCondition === "function") await necroActor.decreaseCondition("wounded");
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        let spellDC = 10 + Math.floor((necroActor.level || 1) * 1.5);
        if (necroActor.spellcasting) {
            const entries = typeof necroActor.spellcasting.contents === "function" 
                ? necroActor.spellcasting.contents() 
                : Array.from(necroActor.spellcasting);
            let maxDC = 0;
            for (const entry of entries) {
                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                if (dcVal && dcVal > maxDC) maxDC = dcVal;
            }
            if (maxDC > 0) spellDC = maxDC;
        }
        if (spellDC === 10 && necroActor.system?.attributes?.classDC?.dc) {
            spellDC = necroActor.system.attributes.classDC.dc.value;
        }

        let drSpell = necroActor.items.find(i => i.type === "spell" && i.name === "Desperate Revival");
        const spellSystemData = {
            level: { value: 8 },
            traits: { value: ["necromancer", "occult", "void", "healing", "uncommon"] },
            tradition: { value: "occult" },
            area: { type: "emanation", value: 60 },
            defense: { save: { statistic: "fortitude", basic: false, dc: { value: spellDC } } }
        };

        if (!drSpell) {
            const spellData = {
                name: "Desperate Revival",
                type: "spell",
                img: "icons/magic/life/heart-shadow-red.webp",
                system: spellSystemData
            };
            const created = await necroActor.createEmbeddedDocuments("Item", [spellData]);
            drSpell = created[0];
        } else {
            await drSpell.update({ system: spellSystemData });
        }

        window.aoeEasyResolveCache = {
            item: drSpell,
            name: "Desperate Revival",
            dc: spellDC,
            type: "fortitude",
            hazardDuration: null
        };

        const gridDist = canvas.scene?.grid?.distance || 5;
        const tokenRadiusFeet = ((necroToken.document.width || 1) * gridDist) / 2;
        const totalEmanationFeet = 60 + tokenRadiusFeet;

        const templateData = {
            t: "circle",
            user: game.user.id,
            distance: totalEmanationFeet,
            direction: 0,
            x: necroToken.center.x,
            y: necroToken.center.y,
            fillColor: "#7f1d1d",
            flags: {
                "necromancer-thrall-helper": { source: "desperate-revival" },
                "aoe-easy-resolve": {
                    useOverride: true,
                    saveType: "fortitude",
                    saveDC: spellDC,
                    isAreaDamage: true,
                    allyBaseEffect: "standard",
                    enemyBaseEffect: "standard"
                }
            }
        };

        await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [templateData]);

        $btn.replaceWith(`
            <p style="margin: 0; color: #4ade80; font-weight: bold; text-align: center;">
                <i class="fas fa-check"></i> Desperate Revival Unleashed! (1 HP)
            </p>
        `);
    });

    const pf2eContext = message.flags?.pf2e?.context;
    if (pf2eContext?.type === "attack-roll" && pf2eContext?.outcome === "criticalSuccess") {
        const attackerTokenId = message.speaker?.token;
        const attackerToken = canvas?.tokens?.get(attackerTokenId);
        const attacker = attackerToken?.actor || game.actors.get(message.speaker?.actor);
        const targetId = pf2eContext.target?.token || "";

        if (attacker && attacker.items.some(i => i.name === "Effect: Bind Heroic Spirit")) {
            if ($html.find('.heroic-spawn-btn').length === 0) {
                const btnHtml = `
                    <button type="button" class="heroic-spawn-btn" data-target-id="${targetId}" style="background: #4a3600; color: #ffcc00; font-weight: bold; border: 1px solid #ffcc00; margin-top: 5px;">
                        <i class="fas fa-ghost"></i> Inspire Heroic Thrall
                    </button>
                `;
                $html.find('.message-content').append(btnHtml);

                $html.find('.heroic-spawn-btn').off('click').on('click', async (e) => {
                    e.preventDefault();
                    if (!game.user.isGM && !attackerToken?.isOwner) return;

                    const targetToken = canvas.tokens.get(targetId);
                    const targetName = targetToken ? targetToken.name : "the target";
                    
                    const presets = typeof getThrallPresets === "function" ? getThrallPresets(attacker) : [];
                    let optionsHtml = '<option value="default">(Default Thrall)</option><option value="random">(Random Family Member)</option>';
                    presets.forEach(p => {
                        const isAlreadyActive = canvas?.scene?.tokens?.some(t => t.getFlag("necromancer-thrall-helper", "masterId") === attacker.id && t.name === p.name);
                        if (p.isUnique && isAlreadyActive) {
                            optionsHtml += `<option value="${p.id}" disabled>${p.name} (Already Active)</option>`;
                        } else {
                            optionsHtml += `<option value="${p.id}">${p.name}</option>`;
                        }
                    });

                    new Dialog({
                        title: "Inspire Heroic Thrall",
                        content: `
                            <p>Your critical strike calls a spirit to the battlefield!</p>
                            <p>Select an identity to spawn adjacent to <b>${targetName}</b>:</p>
                            <form><div class="form-group"><select id="heroic-preset">${optionsHtml}</select></div></form>
                        `,
                        buttons: {
                            summon: {
                                icon: '<i class="fas fa-magic"></i>',
                                label: "Inspire",
                                callback: async (dialogHtml) => {
                                    const presetId = dialogHtml.find('#heroic-preset').val();
                                    
                                    ui.notifications.info(`Click the canvas adjacent to ${targetName} to place the thrall. Right-click to cancel.`);
                                    document.body.style.cursor = "crosshair";
                                    canvas.app.view.style.cursor = "crosshair";

                                    const gridSize = canvas.grid.size;
                                    const ghost = new PIXI.Graphics();
                                    ghost.beginFill(0xffcc00, 0.3);
                                    ghost.lineStyle(2, 0xffcc00, 0.8);
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
                                            ui.notifications.info("Inspiration cancelled.");
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

                                        if (targetToken) {
                                            const tCX = targetToken.x + (targetToken.document.width * gridSize) / 2;
                                            const tCY = targetToken.y + (targetToken.document.height * gridSize) / 2;
                                            const sCX = spawnX + (gridSize / 2);
                                            const sCY = spawnY + (gridSize / 2);
                                            const dist = (Math.max(Math.abs(tCX - sCX), Math.abs(tCY - sCY)) / gridSize) * (canvas.scene?.grid?.distance || 5);
                                            
                                            if (dist > 15) {
                                                ui.notifications.warn("The inspired thrall must be placed adjacent to the target of the critical strike!");
                                                canvas.stage.once("pointerdown", interactionHandler);
                                                return;
                                            }
                                        }

                                        cleanUp();

                                        const basePayload = await prepareThrallPayload(attacker, presetId);
                                        if (!basePayload) return;

                                        const ownerIds = Object.keys(attacker.ownership || {}).filter(k => attacker.ownership[k] === 3 && k !== "default");
                                        const newOwnership = { default: 0 };
                                        ownerIds.forEach(id => newOwnership[id] = 3);
                                        newOwnership[game.user.id] = 3;

                                        const finalPayload = foundry.utils.mergeObject(basePayload, {
                                            actorLink: false,
                                            x: spawnX,
                                            y: spawnY,
                                            delta: { ownership: newOwnership }
                                        });

                                        executeSpawn(finalPayload).catch(err => {
                                            console.error("Necromancer Helper | Spawn execution failed:", err);
                                            ui.notifications.error("Failed to materialize the thrall.");
                                        });
                                    };

                                    canvas.stage.once("pointerdown", interactionHandler);
                                }
                            },
                            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                        },
                        default: "summon"
                    }).render(true);
                });
            }
        }

        const speakerName = message.speaker?.alias || "";
        const isPerfectedAttacker = attackerToken?.document?.getFlag("necromancer-thrall-helper", "isPerfectedThrall") || speakerName.includes("Perfected");

        if (isPerfectedAttacker) {
            if ($html.find('.perfected-spawn-btn').length === 0) {
                const masterId = attackerToken?.document?.getFlag("necromancer-thrall-helper", "masterId") || attacker?.getFlag("necromancer-thrall-helper", "masterId") || game.user.character?.id || "";
                const btnHtml = `
                    <button type="button" class="perfected-spawn-btn" data-master-id="${masterId}" style="background: #3b0764; color: #d8b4fe; font-weight: bold; border: 1px solid #7e22ce; margin-top: 5px;">
                        <i class="fas fa-ghost"></i> Sprout 4 Thralls
                    </button>
                `;
                $html.find('.message-content').append(btnHtml);
            }

            $html.off('click', '.perfected-spawn-btn').on('click', '.perfected-spawn-btn', async (e) => {
                e.preventDefault();
                e.stopPropagation();

                const mId = e.currentTarget.dataset.masterId;
                const masterActor = game.actors.get(mId) || game.user.character || canvas.tokens.controlled[0]?.actor;

                if (!masterActor) return ui.notifications.warn("Necromancer not found. Please select your character.");
                if (!game.user.isGM && !masterActor.isOwner) return ui.notifications.warn("You lack permission to command this Necromancer.");

                if (globalThis.NecroThrallHelper?.executeSheddingMatrix) {
                    globalThis.NecroThrallHelper.executeSheddingMatrix(masterActor, 4);
                } else {
                    ui.notifications.warn("Command Deck must be open to process rapid shedding.");
                }
            });
        }
    }
    

    const itemName = message.flags?.["aoe-easy-resolve"]?.itemName || message.flavor || "";
    const msgContent = message.content || "";
    const isResolution = msgContent.includes("Resolution Summary") || message.flags?.["aoe-easy-resolve"]?.isResolution;
    
    const isErasCard = (itemName.includes("Necrotic Bomb") || itemName.includes("Necrotic Blast") || msgContent.includes("Necrotic Bomb") || msgContent.includes("Necrotic Blast")) && !isResolution;
    const isBarrageCard = (itemName.includes("Bony Barrage") || msgContent.includes("Bony Barrage")) && !isResolution;
    const isHarmCard = (itemName.includes("Harm") || msgContent.includes("Harm")) && !isResolution;
    const isTsunamiCard = (itemName.includes("Flesh Tsunami") || msgContent.includes("Flesh Tsunami")) && !isResolution;
    
    if (!isErasCard && !isBarrageCard && !isHarmCard && !isTsunamiCard) return;

    let casterId = message.speaker?.actor;
    const aoeItemUuid = message.flags?.["aoe-easy-resolve"]?.itemUuid || message.flags?.["aoe-easy-resolve"]?.originItemUuid;
    if (!casterId && aoeItemUuid && aoeItemUuid.includes("Actor.")) {
        const parts = aoeItemUuid.split(".");
        const actorIdx = parts.indexOf("Actor");
        if (actorIdx !== -1) casterId = parts[actorIdx + 1];
    }
    if (!casterId && canvas?.tokens?.controlled?.length > 0) {
        casterId = canvas.tokens.controlled[0].actor?.id;
    }
    const isCaster = casterId ? game.actors.get(casterId)?.isOwner : false;
    const hasPermission = game.user.isGM || message.isAuthor || isCaster;

    const injectToggle = ($row, htmlString) => {
        const $saveContainer = $row.find('.save-btn-container, .roll-save-btn').first();
        if ($saveContainer.length > 0) {
            $saveContainer.before(htmlString);
        } else {
            const $img = $row.find('img').first();
            if ($img.length > 0) {
                $img.parent().append(htmlString);
            } else {
                $row.find('.token-name, span[title]').first().after(htmlString);
            }
        }
    };

    if (isTsunamiCard) {
        const hasLimbs = message.getFlag("necromancer-thrall-helper", "limbsActivated");
        const sacrificedId = message.getFlag("necromancer-thrall-helper", "sacrificedThrallId");
        
        if (!hasLimbs) {
            $html.find('.roll-all-npcs-btn, .apply-damage-btn').css("cssText", "display: none !important;");
        } else {
            $html.find('.roll-all-npcs-btn, .apply-damage-btn').css("cssText", "display: flex !important;");
        }

        if (hasLimbs) {
            $html.find('[data-token-id]').each((i, el) => {
                const $row = $(el);
                if ($row.attr('data-token-id') === sacrificedId) $row.remove();
            });
            
            if ($html.find('.tsunami-active-badge').length === 0) {
                const aoeData = message.flags?.["aoe-easy-resolve"] || {};
                const badgeHtml = `<div class="tsunami-active-badge" style="text-align: center; color: #ef4444; font-weight: bold; margin-top: 5px; margin-bottom: 5px; padding: 4px; background: rgba(0,0,0,0.4); border-radius: 4px;"><i class="fas fa-hands-helping"></i> Grasping Limbs Active (Escape DC ${aoeData.saveDC || 10})</div>`;
                const targetContainer = $html.find('.card-buttons').last();
                if (targetContainer.length > 0) targetContainer.after(badgeHtml);
                else $html.append(badgeHtml);
                $html.find('.tsunami-limb-btn').remove();
            }
        } 
        else if (hasPermission) {
            if ($html.find('.tsunami-limb-btn').length === 0) {
                const btnHtml = `<button type="button" class="tsunami-limb-btn" style="margin-top: 5px; margin-bottom: 5px; width: 100%; background: #3a0000; color: #fff; border: 1px solid #ef4444; padding: 5px; font-weight: bold;"><i class="fas fa-hand-holding-water"></i> Sacrifice Thrall for Grasping Limbs</button>`;
                const targetContainer = $html.find('.card-buttons').last();
                
                if (targetContainer.length > 0) targetContainer.before(btnHtml);
                else $html.append(btnHtml);

                $html.find('.tsunami-limb-btn').off('click').on('click', async (e) => {
                    e.preventDefault(); e.stopPropagation();

                    const aoeFlags = message.flags?.["aoe-easy-resolve"] || {};
                    const targetsData = aoeFlags.targets || {};
                    const targetIds = Object.keys(targetsData);
                    
                    if (targetIds.length === 0) return ui.notifications.warn("Please wait for the cone template to register targets in the chat card!");

                    let availableThralls = [];
                    for (const id of targetIds) {
                        const token = canvas.tokens.get(id);
                        if (token && token.document.getFlag("necromancer-thrall-helper", "masterId") === casterId) {
                            availableThralls.push(token);
                        }
                    }

                    if (availableThralls.length === 0) return ui.notifications.warn("No secondary thrall found inside the cone to sacrifice.");

                    let sacrificedThrall = null;
                    if (availableThralls.length === 1) {
                        sacrificedThrall = availableThralls[0];
                    } else {
                        sacrificedThrall = await new Promise((resolve) => {
                            let options = availableThralls.map(t => `<option value="${t.id}">${t.name}</option>`).join("");
                            new Dialog({
                                title: "Select Sacrifice",
                                content: `<p>Multiple thralls detected in the wave. Which one is melted into grasping limbs?</p><form><div class="form-group"><label>Target:</label><select id="thrall-choice">${options}</select></div></form>`,
                                buttons: {
                                    consume: { icon: '<i class="fas fa-hand-paper"></i>', label: "Melt", callback: (dialogHtml) => {
                                        const chosenId = dialogHtml[0].querySelector('#thrall-choice').value;
                                        resolve(availableThralls.find(t => t.id === chosenId));
                                    }},
                                    cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel", callback: () => resolve(null) }
                                }, default: "consume"
                            }).render(true);
                        });
                    }

                    if (!sacrificedThrall) return;

                    const updates = {
                        "flags.necromancer-thrall-helper.limbsActivated": true,
                        "flags.necromancer-thrall-helper.sacrificedThrallId": sacrificedThrall.id
                    };
                    updates[`flags.aoe-easy-resolve.targets.-=${sacrificedThrall.id}`] = null; 

                    await message.update(updates);
                    await sacrificedThrall.document.delete();
                    
                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor: game.actors.get(casterId) }),
                        flavor: `<strong>Grasping Limbs Activated!</strong>`,
                        content: `<p><b>${sacrificedThrall.name}</b> dissolves into the fleshy wave! Enemies in the cone must now succeed at a Fortitude save or become Immobilized.</p>`
                    });
                });
            }
        }
    }

    // --- NECROTIC BOMB INJECTION ---
    if (isErasCard) {
        if ($html.find('#necro-bomb-style').length === 0) {
            $html.prepend(`
                <style id="necro-bomb-style">
                    .necro-type-toggle { display: inline-flex; align-items: center; margin-left: 5px; vertical-align: middle; }
                    .necro-type-toggle button { margin: 0; padding: 2px 6px; font-size: 0.7em; line-height: 1; border: 1px solid #444; background: #222; color: #999; }
                    .necro-type-toggle button.active.void-opt { background: #660066; color: #fff; border-color: #990099; }
                    .necro-type-toggle button.active.vit-opt { background: #b58900; color: #fff; border-color: #e5a900; }
                    .void-opt { border-radius: 3px 0 0 3px; }
                    .vit-opt { border-radius: 0 3px 3px 0; }
                    .no-save-badge { font-weight: bold; color: #4ade80; font-size: 0.75em; margin-left: 5px; white-space: nowrap; }
                </style>
            `);
        }

        $html.find('[data-token-id]').each((i, el) => {
            const $row = $(el);
            const tokenId = $row.attr('data-token-id');
            if (!tokenId) return;

            const targetToken = canvas?.tokens?.get(tokenId);
            if (!targetToken?.actor) return;

            $row.find('.necro-type-toggle').remove();
            $row.find('.no-save-badge').remove();

            const currentType = message.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`) || "void";
            const negHeal = targetToken.actor.system.attributes.hp?.negativeHealing || false;
            const isUnaffected = (currentType === 'vitality' && !negHeal) || (currentType === 'void' && negHeal);

            const cursorStyle = hasPermission ? 'pointer' : 'default';
            const voidActive = currentType === 'void' ? 'active' : '';
            const vitActive = currentType === 'vitality' ? 'active' : '';

            const toggleHtml = `
                <div class="necro-type-toggle" data-token-id="${tokenId}">
                    <button type="button" class="type-btn void-opt ${voidActive}" data-type="void" style="cursor: ${cursorStyle};">Void</button>
                    <button type="button" class="type-btn vit-opt ${vitActive}" data-type="vitality" style="cursor: ${cursorStyle};">Vit</button>
                </div>
            `;
            
            injectToggle($row, toggleHtml);

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

        if (hasPermission) {
            $html.find('.necro-type-toggle .type-btn').off('click').on('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const $btn = $(e.currentTarget);
                const type = $btn.attr('data-type');
                const tokenId = $btn.closest('.necro-type-toggle').attr('data-token-id');
                await message.setFlag("necromancer-thrall-helper", `dmgType_${tokenId}`, type);
            });
        }
    }

    // --- INVERT HARM INJECTION ---
    if (isHarmCard) {
        const actor = game.actors.get(casterId);
        if (!actor) return;

        const hasMastery = actor.items.some(i => i.name === "Mastery of Life and Death" || i.slug === "mastery-of-life-and-death");
        const hasInvert = actor.items.some(i => i.name === "Invert Harm" || i.slug === "invert-harm");

        if (!hasMastery && !hasInvert) return;

        if ($html.find('#harm-toggle-style').length === 0) {
            $html.prepend(`
                <style id="harm-toggle-style">
                    .harm-type-toggle { display: inline-flex; align-items: center; margin-left: 5px; vertical-align: middle; }
                    .harm-type-toggle button { margin: 0; padding: 2px 6px; font-size: 0.7em; line-height: 1; border: 1px solid #444; background: #222; color: #999; }
                    .harm-type-toggle button.active.harm-void-opt { background: #660066; color: #fff; border-color: #990099; }
                    .harm-type-toggle button.active.harm-vit-opt { background: #b58900; color: #fff; border-color: #e5a900; }
                    .harm-type-toggle button.active.harm-heal-opt { background: #4ade80; color: #000; border-color: #22c55e; }
                    .harm-void-opt { border-radius: 3px 0 0 3px; }
                    .harm-vit-opt { border-radius: ${hasInvert ? '0' : '0 3px 3px 0'}; }
                    .harm-heal-opt { border-radius: 0 3px 3px 0; }
                    .aoe-heal-badge { font-weight: bold; color: #4ade80; font-size: 0.75em; margin-left: 5px; white-space: nowrap; }
                </style>
            `);
        }

        $html.find('[data-token-id]').each((i, el) => {
            const $row = $(el);
            const tokenId = $row.attr('data-token-id');
            if (!tokenId) return;

            const targetToken = canvas?.tokens?.get(tokenId);
            if (!targetToken?.actor) return;

            $row.find('.harm-type-toggle').remove();
            $row.find('.aoe-heal-badge').remove();

            const currentState = message.getFlag("necromancer-thrall-helper", `harmState_${tokenId}`) || "void";
            const negHeal = targetToken.actor.system.attributes.hp?.negativeHealing || false;
            
            let isHealing = false;
            if (currentState === "void") isHealing = negHeal;
            if (currentState === "vit") isHealing = !negHeal;
            if (currentState === "heal") isHealing = true;

            const cursorStyle = hasPermission ? 'pointer' : 'default';
            const voidActive = currentState === 'void' ? 'active' : '';
            const vitActive = currentState === 'vit' ? 'active' : '';
            const healActive = currentState === 'heal' ? 'active' : '';

            const vitButton = hasMastery ? `<button type="button" class="harm-type-btn harm-vit-opt ${vitActive}" data-type="vit" style="cursor: ${cursorStyle};">Vit</button>` : '';
            const healButton = hasInvert ? `<button type="button" class="harm-type-btn harm-heal-opt ${healActive}" data-type="heal" style="cursor: ${cursorStyle};">Heal</button>` : '';

            const toggleHtml = `
                <div class="harm-type-toggle" data-token-id="${tokenId}">
                    <button type="button" class="harm-type-btn harm-void-opt ${voidActive}" data-type="void" style="cursor: ${cursorStyle};">Void</button>
                    ${vitButton}
                    ${healButton}
                </div>
            `;
            
            injectToggle($row, toggleHtml);

            const $saveBtn = $row.find('.roll-save-btn');
            if (isHealing) {
                $saveBtn.hide();
                if ($row.find('.aoe-heal-badge').length === 0) {
                    $saveBtn.after('<span class="aoe-heal-badge">(AoE Heal)</span>');
                }
            } else {
                $saveBtn.show();
                $row.find('.aoe-heal-badge').remove();
            }
        });

        if (hasPermission) {
            $html.find('.harm-type-btn').off('click').on('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const $btn = $(e.currentTarget);
                const type = $btn.attr('data-type');
                const tokenId = $btn.closest('.harm-type-toggle').attr('data-token-id');
                
                await message.setFlag("necromancer-thrall-helper", `harmState_${tokenId}`, type);
            });
        }
    }

    // --- BONY BARRAGE LOGIC ---
    if (isBarrageCard) {
        const hasArmor = message.getFlag("necromancer-thrall-helper", "boneArmorActivated");
        const sacrificedId = message.getFlag("necromancer-thrall-helper", "sacrificedThrallId");
        
        if (hasArmor) {
            $html.find('[data-token-id]').each((i, el) => {
                const $row = $(el);
                const tokenId = $row.attr('data-token-id');
                
                if (tokenId === sacrificedId) {
                    $row.remove();
                    return;
                }
                
                const targetToken = canvas?.tokens?.get(tokenId);
                if (!targetToken || !targetToken.actor) return;
                
                const alliance = targetToken.actor.system?.details?.alliance;
                const isFriendly = alliance === "party" || targetToken.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY || targetToken.actor.id === casterId;
                const isThrall = targetToken.document.getFlag("necromancer-thrall-helper", "masterId") === casterId;
                
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
        else if (hasPermission) {
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

                    let availableThralls = [];
                    for (const id of targetIds) {
                        const token = canvas.tokens.get(id);
                        if (token && token.document.getFlag("necromancer-thrall-helper", "masterId") === casterId) {
                            availableThralls.push(token);
                        }
                    }

                    if (availableThralls.length === 0) {
                        return ui.notifications.warn("No secondary thrall found strictly inside the cone to sacrifice.");
                    }

                    let sacrificedThrall = null;
                    
                    if (availableThralls.length === 1) {
                        sacrificedThrall = availableThralls[0];
                    } else {
                        sacrificedThrall = await new Promise((resolve) => {
                            let options = availableThralls.map(t => `<option value="${t.id}">${t.name}</option>`).join("");
                            new Dialog({
                                title: "Select Sacrifice",
                                content: `
                                    <p>Multiple thralls detected in the blast zone. Which one is becoming armor?</p>
                                    <form><div class="form-group"><label>Target:</label><select id="thrall-choice">${options}</select></div></form>
                                `,
                                buttons: {
                                    consume: { icon: '<i class="fas fa-shield-alt"></i>', label: "Consume", callback: (dialogHtml) => {
                                            const chosenId = dialogHtml[0].querySelector('#thrall-choice').value;
                                            resolve(availableThralls.find(t => t.id === chosenId));
                                        }
                                    },
                                    cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel", callback: () => resolve(null) }
                                },
                                default: "consume"
                            }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        });
                    }

                    if (!sacrificedThrall) return;

                    const updates = {
                        "flags.necromancer-thrall-helper.boneArmorActivated": true,
                        "flags.necromancer-thrall-helper.sacrificedThrallId": sacrificedThrall.id,
                        "flags.necromancer-thrall-helper.applyArmorEffects": true 
                    };
                    
                    updates[`flags.aoe-easy-resolve.targets.-=${sacrificedThrall.id}`] = null; 

                    for (const id of targetIds) {
                        if (id === sacrificedThrall.id) continue;
                        
                        const token = canvas.tokens.get(id);
                        if (!token || !token.actor) continue;
                        
                        const alliance = token.actor.system?.details?.alliance;
                        const isFriendly = alliance === "party" || token.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY || token.actor.id === casterId;
                        const isThrall = token.document.getFlag("necromancer-thrall-helper", "masterId") === casterId;
                        
                        if (isFriendly || isThrall) {
                            updates[`flags.aoe-easy-resolve.targets.${id}.isImmune`] = true;
                        }
                    }

                    await message.update(updates);
                    await sacrificedThrall.document.delete();
                    
                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor: game.actors.get(casterId) }),
                        flavor: `<strong>Bone Armor Activated!</strong>`,
                        content: `<p><b>${sacrificedThrall.name}</b> is consumed by the barrage! Allies in the blast zone take no damage and gain a +1 status bonus to AC until the start of the caster's next turn.</p>`
                    });
                });
            }
        }
    }
});
Hooks.on("deleteToken", async (tokenDoc, options, userId) => {
    if (game.user.id !== userId) return;
    
    if (game.combat) {
        const orphanedCombatants = game.combat.combatants.filter(c => c.tokenId === tokenDoc.id);
        if (orphanedCombatants.length > 0) {
            const ids = orphanedCombatants.map(c => c.id);
            game.combat.deleteEmbeddedDocuments("Combatant", ids).catch(err => {
                console.warn("Necromancer Helper | Ignored safe-delete warning:", err);
            });
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

    const isAnchor = tokenDoc.getFlag("necromancer-thrall-helper", "isHordeAnchor");
    if (isAnchor) {
        const regions = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "anchorId") === tokenDoc.id).map(r => r.id);
        const drawings = canvas.scene.drawings.filter(d => d.getFlag("necromancer-thrall-helper", "anchorId") === tokenDoc.id).map(d => d.id);
        globalThis.NecroThrallHelper.purgeGraphics(sceneId, { regionIds: regions, drawingIds: drawings });
    }

    const gyTemplateId = tokenDoc.getFlag("necromancer-thrall-helper", "graveyardTemplateId");
    if (gyTemplateId) {
        globalThis.NecroThrallHelper.purgeGraphics(sceneId, { templateIds: [gyTemplateId] });
    }
});
Hooks.on("pf2e.endTurn", async (combatant, combat, userId) => {
    if (!game.user.isGM) return;
    
    const targetActor = combatant.actor;
    const tokenDoc = combatant.token;
    const targetToken = tokenDoc?.object || canvas.tokens.get(combatant.tokenId);
    
    if (!tokenDoc || !targetActor || !targetToken) return;

    // --- HALLOWED / CORRUPTED AURA CHECKS ---
    const necros = combat.combatants.filter(c => c.actor?.items.some(i => i.name === "Effect: Hallowed Earth" || i.name === "Effect: Corrupted Ground"));
    
    for (const necro of necros) {
        if (necro.id === combatant.id) continue; 
        
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

            if (hasHallowed && isUnholy && DamageRoll) {
                let dmgString = `${scale}[spirit]`;
                if (isUndead) dmgString += `,${scale}[vitality]`;
                
                const roll = await new DamageRoll(dmgString).evaluate();
                await roll.toMessage({
                    speaker: ChatMessage.getSpeaker({ actor: necro.actor }),
                    flavor: `<strong>Hallowed Earth</strong><br><b>${necro.actor.name}'s</b> aura burns ${targetToken.name}!`
                });
                await targetActor.applyDamage({ damage: roll, token: tokenDoc });
            }

            if (hasCorrupted && (isHoly || isPsychopomp) && DamageRoll) {
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
    // --- REANIMATED FOE DECAY (Triggers when the Master ends their turn) ---
    const reanimatedFoes = canvas.scene.tokens.filter(t => 
        t.actor && 
        t.actor.items.some(i => i.getFlag("necromancer-thrall-helper", "isReanimatedFoe") && i.getFlag("necromancer-thrall-helper", "masterId") === targetActor.id)
    );

    if (reanimatedFoes.length > 0) {
        const DamageRoll = CONFIG.Dice.rolls.find(r => r.name === "DamageRoll");
        if (DamageRoll) {
            for (const foe of reanimatedFoes) {
                const effect = foe.actor.items.find(i => i.getFlag("necromancer-thrall-helper", "isReanimatedFoe"));
                const decayAmount = effect?.getFlag("necromancer-thrall-helper", "decayAmount") || 15;
                
                const roll = await new DamageRoll(`${decayAmount}[untyped]`).evaluate({async: true});
                await roll.toMessage({
                    speaker: ChatMessage.getSpeaker({ actor: foe.actor, token: foe }),
                    flavor: `<strong>Reanimated Decay</strong><br>The unstable corpse rots rapidly.`
                });
                await foe.actor.applyDamage({ damage: roll, token: foe, _necroBombProcessed: true });
            }
        }
    }
    // --- NECROTIC BLOOD END OF TURN AUTOMATION ---
    const bloodEffect = targetActor.items.find(i => i.getFlag("necromancer-thrall-helper", "isNecroticBlood"));
    if (bloodEffect) {
        const dc = bloodEffect.getFlag("necromancer-thrall-helper", "necroticBloodDC");
        let currentStage = bloodEffect.getFlag("necromancer-thrall-helper", "stage") || 1;
        const dmgType = bloodEffect.getFlag("necromancer-thrall-helper", "dmgType") || "void";

        if (dc) {
            setTimeout(async () => {
                const saveResult = await targetActor.saves.fortitude.roll({
                    dc: { value: dc },
                    item: bloodEffect,
                    event: new Event('click')
                });

                if (!saveResult) return;

                let dosNum = 2; 
                if (saveResult.degreeOfSuccess !== undefined) dosNum = saveResult.degreeOfSuccess;
                else if (saveResult.options?.degreeOfSuccess !== undefined) dosNum = saveResult.options.degreeOfSuccess;

                let dosText = dosNum >= 2 ? "Success" : (dosNum === 1 ? "Failure" : "Critical Failure");
                let dosColor = dosNum >= 2 ? "#eab308" : "#ef4444";

                if (dosNum === 3) currentStage -= 2;
                else if (dosNum === 2) currentStage -= 1;
                else if (dosNum === 1) currentStage += 1;
                else if (dosNum === 0) currentStage += 2;

                if (currentStage <= 0) {
                    await bloodEffect.delete();
                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor: targetActor, token: tokenDoc }),
                        flavor: `<strong>Necrotic Blood Purged</strong>`,
                        content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #4ade80;"><p><b><span style="color: #4ade80;">Success!</span></b> The disease has been completely purged from ${targetActor.name}'s system.</p></div>`
                    });
                    return;
                }

                if (currentStage > 3) currentStage = 3;

                const weaknessVal = currentStage === 3 ? 20 : currentStage * 5;
                const newRules = [{ key: "Weakness", type: "bleed", value: weaknessVal }];
                const newDesc = `<b>Necrotic Blood (Stage ${currentStage})</b><br>Stage 1: 3d10 ${dmgType}, Sickened 1, Weakness 5 Bleed.<br>Stage 2: 4d10 ${dmgType}, Sickened 2, Weakness 10 Bleed.<br>Stage 3: 5d10 ${dmgType}, Sickened 3, Weakness 20 Bleed.<br><br><i>If this creature dies, a thrall rises from its corpse.</i>`;

                await bloodEffect.update({
                    "system.rules": newRules,
                    "system.description.value": newDesc,
                    "flags.necromancer-thrall-helper.stage": currentStage
                });

                try {
                    const currentSickenedObj = targetActor.getCondition("sickened");
                    const currentSickened = currentSickenedObj ? currentSickenedObj.value : 0;
                    if (currentSickened < currentStage && typeof targetActor.increaseCondition === "function") {
                        for (let i = currentSickened; i < currentStage; i++) await targetActor.increaseCondition("sickened");
                    }
                } catch(e) {}

                const diceCount = currentStage + 2;
                const DamageRoll = CONFIG.Dice.rolls.find(r => r.name === "DamageRoll");
                if (DamageRoll) {
                    const roll = await new DamageRoll(`${diceCount}d10[${dmgType}]`).evaluate({async: true});
                    
                    const flavorHtml = `
                        <div style="background: rgba(0,0,0,0.3); padding: 6px; border-radius: 4px; border-left: 4px solid ${dosColor}; margin-bottom: 5px;">
                            <strong>Necrotic Blood (Stage ${currentStage})</strong><br>
                            <span style="color: ${dosColor}; font-weight: bold;">${dosText}!</span> The disease ravages ${targetActor.name}.
                        </div>
                    `;
                    
                    await roll.toMessage({
                        speaker: ChatMessage.getSpeaker({ actor: targetActor, token: tokenDoc }),
                        flavor: flavorHtml
                    });
                    
                    await targetActor.applyDamage({ damage: roll, token: tokenDoc, _necroBombProcessed: true }); 
                }
            }, 800); 
        }
    }

    // --- CALCIFICATION END OF TURN AUTOMATION ---
    const calcEffect = targetActor.items.find(i => i.getFlag("necromancer-thrall-helper", "isCalcifying"));
    if (calcEffect) {
        const dc = calcEffect.getFlag("necromancer-thrall-helper", "calcificationDC");
        if (dc) {
            setTimeout(async () => {
                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor: targetActor, token: tokenDoc }),
                    flavor: `<strong>Calcification Progression</strong>`,
                    content: `
                        <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #e2e8f0;">
                            <p style="margin: 0 0 4px 0;"><b>${targetActor.name}'s</b> flesh continues to solidify into pure bone!</p>
                            <p style="margin: 0; font-size: 0.9em; font-style: italic;">Rolling Fortitude Save vs DC ${dc} (Incapacitation)...</p>
                        </div>
                    `
                });

                const saveResult = await targetActor.saves.fortitude.roll({ 
                    dc: { value: dc }, 
                    item: calcEffect,
                    extraRollOptions: ["incapacitation"], 
                    event: new Event('click')
                });

                if (!saveResult) return;

                let dosNum = 2; 
                if (saveResult.degreeOfSuccess !== undefined) dosNum = saveResult.degreeOfSuccess;
                else if (saveResult.options?.degreeOfSuccess !== undefined) dosNum = saveResult.options.degreeOfSuccess;

                let curSlowObj = targetActor.getCondition("slowed");
                let curSlow = curSlowObj ? curSlowObj.value : 0;
                let outcomeHtml = "";

                if (dosNum === 2 || dosNum === 3) { 
                    curSlow -= 1;
                    if (curSlow <= 0) {
                        await calcEffect.delete();
                        if (curSlowObj) await targetActor.decreaseCondition("slowed");
                        outcomeHtml = `<p><b><span style="color: #4ade80;">Success!</span></b> The brittle bone harmlessly shatters off. The effect ends!</p>`;
                    } else {
                        await targetActor.decreaseCondition("slowed");
                        outcomeHtml = `<p><b><span style="color: #eab308;">Success.</span></b> Slowed decreases by 1. Now <b>Slowed ${curSlow}</b>.</p>`;
                    }
                } 
                else { 
                    const increaseBy = dosNum === 0 ? 2 : 1;
                    curSlow += increaseBy;
                    for (let i = 0; i < increaseBy; i++) {
                        await targetActor.increaseCondition("slowed");
                    }

                    if (curSlow >= 3) {
                        await calcEffect.delete();
                        await targetActor.toggleCondition("petrified");
                        outcomeHtml = `<p><b><span style="color: #ef4444;">Fully Calcified!</span></b> ${targetActor.name} has been permanently turned into a bone statue (Petrified).</p>`;
                    } else {
                        outcomeHtml = `<p><b><span style="color: #ef4444;">${dosNum === 0 ? "Critical Failure!" : "Failure!"}</span></b> Slowed increases by ${increaseBy}. Now <b>Slowed ${curSlow}</b>.</p>`;
                    }
                }

                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor: targetActor, token: tokenDoc }),
                    flavor: `<strong>Calcification Result</strong>`,
                    content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #ef4444;">${outcomeHtml}</div>`
                });

            }, 1000); 
        }
    }
});

Hooks.on("pf2e.startTurn", async (combatant, combat, userId) => {
    if (!game.user.isGM) return;
    const actor = combatant.actor;
    if (!actor) return;

    // --- ZOMBIE HORDE (Current Combatant Tracker) ---
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

Hooks.on("createToken", async (tokenDoc, options, userId) => {
    if (game.user.id !== userId) return;

    let actor = null;
    for (let attempts = 0; attempts < 20; attempts++) {
        actor = tokenDoc.actor;
        if (actor && actor.system?.traits) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
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

    const hasTeamwork = masterActor.items.some(i => i.name === "Thrall Teamwork");
    if (hasTeamwork) {
        const currentCombat = game.combat;
        const currentRound = currentCombat ? currentCombat.round : "out-of-combat";
        const lastUsed = masterActor.getFlag("necromancer-thrall-helper", "teamworkRound");

        if (lastUsed !== currentRound) {
            await masterActor.setFlag("necromancer-thrall-helper", "teamworkRound", currentRound);
            
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: masterActor }),
                flavor: `<strong>Thrall Teamwork</strong>`,
                content: `
                    <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #8a2be2;">
                        <p style="margin: 0;"><b>${masterActor.name}</b> coordinates with the newly risen dead!</p>
                        <p style="margin: 4px 0 0 0; font-size: 0.9em;">Take a melee Strike as a <b>Free Action</b> against an enemy within your reach that is adjacent to at least one of your thralls.</p>
                    </div>
                `
            });
        }
    }

    // --- THE HALLOWED / UNHOLY DEAD BUFFS ---
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
                { key: "AdjustStrike", mode: "add", property: "weapon-traits", value: alignment }
            ]
        }
    };

    await actor.createEmbeddedDocuments("Item", [effectData]);

    const newTraits = new Set(traits);
    newTraits.add(alignment);
    await actor.update({ "system.traits.value": Array.from(newTraits) });
});
// --- RECURRING NIGHTMARE: DESTINATION-AWARE SPATIAL HAUNT ---
globalThis.NecroThrallHelper = globalThis.NecroThrallHelper || {};

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

    // Calculate Master Spell DC
    let spellDC = 10 + Math.floor((masterActor.level || 1) * 1.5);
    if (masterActor.spellcasting) {
        const entries = typeof masterActor.spellcasting.contents === "function" 
            ? masterActor.spellcasting.contents() 
            : Array.from(masterActor.spellcasting);
        let maxDC = 0;
        for (const entry of entries) {
            const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
            if (dcVal && dcVal > maxDC) maxDC = dcVal;
        }
        if (maxDC > 0) spellDC = maxDC;
    }
    if (spellDC === 10 && masterActor.system?.attributes?.classDC?.dc) {
        spellDC = masterActor.system.attributes.classDC.dc.value;
    }

    const targetsData = {};
    cohabitants.forEach(t => {
        targetsData[t.document.id] = {
            id: t.document.id,
            name: t.document.name,
            img: t.document.texture?.src || t.actor?.img,
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
        const spellData = { name: "Recurring Nightmare", type: "spell", img: "icons/magic/death/undead-ghost-scream-teal.webp", system: spellSystemData };
        const created = await masterActor.createEmbeddedDocuments("Item", [spellData]);
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
        content: `
            <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #38bdf8;">
                <p style="margin: 0 0 5px 0;"><b>${nightmareTokenDoc.name}</b> occupies the space of occupying creatures!</p>
                <p style="margin: 0; font-size: 0.95em;">Creatures sharing its space must attempt a <b>DC ${spellDC} Will save</b> or become <b>Frightened 1</b> (<b>Frightened 2</b> on a Critical Failure).</p>
                <hr>${htmlContent}
            </div>
        `,
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

Hooks.on("updateToken", async (tokenDoc, changes, options, userId) => {
    if (game.user.id !== userId) return; 
    if (!("x" in changes || "y" in changes)) return;

    // --- RECURRING NIGHTMARE: ONLY TRIGGERS ON THRALL MOVEMENT ---
    if (tokenDoc.getFlag("necromancer-thrall-helper", "isRecurringNightmare")) {
        const destX = changes.x !== undefined ? changes.x : tokenDoc.x;
        const destY = changes.y !== undefined ? changes.y : tokenDoc.y;
        globalThis.NecroThrallHelper?.checkNightmareHaunt(tokenDoc, null, { x: destX, y: destY });
    }

    const gridSize = canvas.scene.grid.size;
    const gridDist = canvas.scene.grid.distance;

    // --- 1. Song of the Soul Distance Tether ---
    if (canvas.scene) {
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
    const flagsToClear = [
        "consumeThrallUsed",
        "desperateRevivalUsed",
        "instantArmyUsed",
        "nightmareDestroyed",
        "nightmareSustainRound"
    ];
    for (const flag of flagsToClear) {
        if (actor.getFlag("necromancer-thrall-helper", flag)) {
            await actor.unsetFlag("necromancer-thrall-helper", flag);
        }
    }
});

// --- GM HANDSHAKE & CARD REDRAW ---
Hooks.on("updateChatMessage", async (message, changes, options, userId) => {
    if (!game.user.isGM) return;
    if (options.necroHelperProcessed) return;

    const aoeFlags = message.flags?.["aoe-easy-resolve"];
    if (!aoeFlags) return;

    const targets = aoeFlags.targets || {};
    let msgUpdates = {};

    if (changes.flags?.["necromancer-thrall-helper"]?.applyArmorEffects) {
        msgUpdates[`flags.necromancer-thrall-helper.-=applyArmorEffects`] = null;
        let masterId = message.speaker?.actor;
        if (!masterId && canvas?.tokens?.controlled?.length > 0) masterId = canvas.tokens.controlled[0].actor?.id;

        const effectData = {
            name: "Effect: Bone Armor", type: "effect", img: "icons/magic/defensive/shield-barrier-flaming-pentagon-purple-orange.webp",
            system: { duration: { value: 1, unit: "rounds", expiry: "turn-start" }, rules: [{ key: "FlatModifier", selector: "ac", value: 1, type: "status" }] }
        };

        for (const id of Object.keys(targets)) {
            const token = canvas?.tokens?.get(id);
            if (!token || !token.actor) continue;
            const isFriendly = token.actor.system?.details?.alliance === "party" || token.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY || token.actor.id === masterId;
            if (isFriendly) {
                try { token.actor.createEmbeddedDocuments("Item", [effectData]); } catch (e) { }
            }
        }
    }

    // Safely check for toggle changes regardless of how Foundry structures the update object
    const flatChanges = foundry.utils.flattenObject(changes);
    const hasToggleChange = Object.keys(flatChanges).some(k => k.includes("dmgType_") || k.includes("harmState_"));

    if (hasToggleChange) {
        for (const tokenId of Object.keys(targets)) {
            const targetToken = canvas?.tokens?.get(tokenId);
            if (!targetToken || !targetToken.actor) continue;

            const negHeal = targetToken.actor.system.attributes.hp?.negativeHealing || false;

            const dmgType = message.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`);
            if (dmgType) {
                const isUnaffected = (dmgType === 'vitality' && !negHeal) || (dmgType === 'void' && negHeal);
                msgUpdates[`flags.aoe-easy-resolve.targets.${tokenId}.isImmune`] = isUnaffected;
                msgUpdates[`flags.aoe-easy-resolve.targets.${tokenId}.isHealing`] = false; 
            }

            const harmState = message.getFlag("necromancer-thrall-helper", `harmState_${tokenId}`);
            if (harmState) {
                let isHealing = false;
                if (harmState === "void") isHealing = negHeal;
                if (harmState === "vit") isHealing = !negHeal;
                if (harmState === "heal") isHealing = true;

                msgUpdates[`flags.aoe-easy-resolve.targets.${tokenId}.isHealing`] = isHealing;
                if (isHealing) {
                    msgUpdates[`flags.aoe-easy-resolve.targets.${tokenId}.isImmune`] = false;
                }
            }
        }
    }
    
    if (!foundry.utils.isEmpty(msgUpdates)) {
        await message.update(msgUpdates, { necroHelperProcessed: true });
        
        if (game.modules.get("aoe-easy-resolve")?.api?.refreshCard) {
            await game.modules.get("aoe-easy-resolve").api.refreshCard(message.id);
        }
    }
});


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
        const context = await super._prepareContext(options);
        context.canBrowse = game.user.hasPermission("FILES_BROWSE");
       
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
                if (t.flags?.["necromancer-thrall-helper"]?.isReanimatedFoe) return false;

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
                
                const isGraveyard = t.name.includes("Living Graveyard");

                return {
                    id: t.id,
                    name: t.name,
                    img: imgPath,
                    nearbyEnemies: nearbyEnemies,
                    nearbyFriendlies: nearbyFriendlies,
                    isConglomerate: t.name.toLowerCase().includes("conglomerate"),
                    isLivingGraveyard: isGraveyard
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
        const hasSpiritFascination = actor?.items.some(i => i.slug === "spirit" || i.name === "Spirit" || i.name.includes("Spirit Fascination")) || (actor?.flags?.pf2e?.rulesSelections?.grimFascination === "spirit") || (actor?.flags?.pf2e?.rulesSelections?.widespreadFascination === "spirit") || false;
        const hasBoneBurst = actor?.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("bone burst") || (i.system?.slug && i.system.slug.includes("bone-burst")))) || false;
        const hasCollateral = actor?.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("collateral reinforcement") || (i.system?.slug && i.system.slug.includes("collateral-reinforcement")))) || false;
        const hasReclaimPower = actor?.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("reclaim power") || (i.system?.slug && i.system.slug.includes("reclaim-power")))) || false;
        const hasZombieHorde = actor?.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("zombie horde") || (i.system?.slug && i.system.slug.includes("zombie-horde")))) || false;
        const hasMuscleBarrier = hasSpell("Muscle Barrier"); 
        const hasBindHeroicSpirit = hasSpell("Bind Heroic Spirit");
        const hasBonyBarrage = hasSpell("Bony Barrage");
        const hasBodyShield = hasSpell("Body Shield");
        const hasSongOfTheSoul = hasSpell("Song of the Soul");
        const hasSkeletalLancers = hasSpell("Skeletal Lancers");
        const hasRecurringNightmare = hasSpell("Recurring Nightmare");
        const nightmareDestroyed = actor?.getFlag("necromancer-thrall-helper", "nightmareDestroyed") || false;
        const activeNightmare = activeThralls.some(t => t.name.includes("Recurring Nightmare"));
        const hasConglomerateOfLimbs = hasSpell("Conglomerate of Limbs");
        const hasCalcification = hasSpell("Calcification");
        const hasDreadMosquitoStorm = hasSpell("Dread Mosquito Storm") || hasSpell("Dread Mosquito Swarm");
        
        const activeStorms = canvas.scene?.regions?.filter(r => r.getFlag("necromancer-thrall-helper", "stormRegionId")) || [];
        const hasAmalgamate = hasSpell("Amalgamate");
        const hasBlossomingGore = hasSpell("Blossoming Gore");
        const hasFleshTsunami = hasSpell("Flesh Tsunami");
        const hasPerfectedThrall = hasSpell("Perfected Thrall");
        const hasReanimateFoe = hasSpell("Reanimate Foe");
        const hasInstantArmy = hasSpell("Instant Army");
        const hasLivingGraveyard = hasSpell("Living Graveyard");
        const hasTemporaryPossession = hasSpell("Temporary Possession");
        const hasHallowedEarth = actor?.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("hallowed earth") || (i.system?.slug && i.system.slug.includes("hallowed-earth")))) || false;
        const hasCorruptedGround = actor?.items.some(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("corrupted ground") || (i.system?.slug && i.system.slug.includes("corrupted-ground")))) || false;

        const isHallowedActive = actor?.items.some(i => i.type === "effect" && i.name === "Effect: Hallowed Earth") || false;
        const isCorruptedActive = actor?.items.some(i => i.type === "effect" && i.name === "Effect: Corrupted Ground") || false;
        const hasDeathlyScream = hasSpell("Deathly Scream");

        const activeHordes = canvas.scene?.regions?.filter(r => r.getFlag("necromancer-thrall-helper", "masterId") === this.necroId && r.getFlag("necromancer-thrall-helper", "hordeId")) || [];
        const activeGores = canvas.scene?.regions?.filter(r => r.getFlag("necromancer-thrall-helper", "goreRegionId")) || [];

        return {
            hasDeathlyScream: hasDeathlyScream,
            canBrowse: game.user.hasPermission("FILES_BROWSE"),
            hasBindHeroicSpirit: hasBindHeroicSpirit,
            hasRecurringNightmare: hasRecurringNightmare,
            hasSpiritFascination: hasSpiritFascination,
            canSustainNightmare: hasRecurringNightmare && nightmareDestroyed && !activeNightmare,
            canConjureNightmare: hasRecurringNightmare && !activeNightmare && !nightmareDestroyed,
            hasSkeletalLancers: hasSkeletalLancers,
            hasReanimateFoe: hasReanimateFoe,
            hasAmalgamate: hasAmalgamate,
            hasFleshTsunami: hasFleshTsunami,
            hasPerfectedThrall: hasPerfectedThrall,
            hasTemporaryPossession: hasTemporaryPossession,
            hasSongOfTheSoul: hasSongOfTheSoul,
            actorName: actor?.name || "Necromancer",
            actorLevel: actor?.level || 1,
            hasBonyBarrage: hasBonyBarrage,
            hasCalcification: hasCalcification,
            activeStormCount: activeStorms.length,
            hasLivingGraveyard: hasLivingGraveyard,
            isGraveyardActive: activeThralls.some(t => t.isLivingGraveyard),
            thrallDamage: damageScale,
            hasBodyShield: hasBodyShield,
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
            hasDreadMosquitoStorm: hasDreadMosquitoStorm,
            consumeDisabled: consumeDisabled,
            hasBloodyTendrils: !!tendrilsSpell,
            tendrilCount: tendrilCount,
            hasBoneBurst: hasBoneBurst,
            hasCollateralReinforcement: hasCollateral,
            hasReclaimPower: hasReclaimPower,
            hasZombieHorde: hasZombieHorde,
            hasMuscleBarrier: hasMuscleBarrier, 
            hasConglomerateOfLimbs: hasConglomerateOfLimbs,
            hasHallowedEarth: hasHallowedEarth,
            hasCorruptedGround: hasCorruptedGround,
            isHallowedActive: isHallowedActive,
            isCorruptedActive: isCorruptedActive,
            activeHordeCount: activeHordes.length,
            hasBlossomingGore: hasBlossomingGore,
            hasInstantArmy: hasInstantArmy,
            instantArmyUsed: actor?.getFlag("necromancer-thrall-helper", "instantArmyUsed") || false,
            activeGoreCount: activeGores.length
        };
    }

    /** @override */
    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;
        $(html).off("click", "button:contains('Perfected'), .conjure-perfected-btn").on("click", "button:contains('Perfected'), .conjure-perfected-btn", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const actor = game.actors.get(this.necroId) || game.user.character;
            if (!actor) return ui.notifications.warn("No Necromancer found!");

            const currentFocus = actor.system?.resources?.focus?.value || 0;
            if (currentFocus === 0) return ui.notifications.warn("You have no Focus Points to conjure a Perfected Thrall!");

            let perfActor = game.actors.find(a => a.name === "Perfected Thrall");
            if (!perfActor) {
                const pack = game.packs.get("necromancer-thrall-helper.necro-thralls");
                if (!pack) return ui.notifications.error("Could not find the Necromancer Thralls compendium pack.");
                const index = await pack.getIndex();
                const entry = index.find(a => a.name === "Perfected Thrall");
                if (!entry) return ui.notifications.error("Could not find 'Perfected Thrall' in the compendium.");
                perfActor = await pack.getDocument(entry._id);
            }
            if (!perfActor) return;

            await actor.update({ "system.resources.focus.value": currentFocus - 1 });

            ui.notifications.info("Click the canvas to place the Perfected Thrall within 60 feet. Right-click to cancel.");
            document.body.style.cursor = "crosshair";
            canvas.app.view.style.cursor = "crosshair";

            let rangeIndicator = null;
            let necroCenter = null;
            const necroTokens = actor.getActiveTokens();
            if (necroTokens.length > 0) {
                necroCenter = necroTokens[0].center;
                const rangeInPixels = (60 / canvas.scene.grid.distance) * canvas.grid.size;
                rangeIndicator = new PIXI.Graphics();
                rangeIndicator.beginFill(0x22c55e, 0.05);
                rangeIndicator.lineStyle(3, 0x22c55e, 0.5);
                rangeIndicator.drawCircle(necroCenter.x, necroCenter.y, rangeInPixels);
                rangeIndicator.endFill();
                rangeIndicator.zIndex = 998;
                canvas.tokens.addChild(rangeIndicator);
            }

            const gridSize = canvas.grid.size;
            const ghost = new PIXI.Graphics();
            ghost.beginFill(0x9333ea, 0.35);
            ghost.lineStyle(2, 0x7e22ce, 0.9);
            ghost.drawRect(0, 0, gridSize, gridSize);
            ghost.endFill();
            ghost.zIndex = 1000;
            ghost.position.set(-1000, -1000);
            canvas.tokens.addChild(ghost);

            const updateGhost = (evt) => {
                const pos = evt.data.getLocalPosition(canvas.app.stage);
                const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                ghost.position.set(snapped.x, snapped.y);
            };

            canvas.stage.on("pointermove", updateGhost);

            const cleanUp = () => {
                document.body.style.cursor = "";
                canvas.app.view.style.cursor = "";
                canvas.stage.off("pointermove", updateGhost);
                ghost.destroy();
                if (rangeIndicator) {
                    rangeIndicator.destroy();
                    rangeIndicator = null;
                }
            };

            const interactionHandler = async (evt) => {
                if (evt.data.button !== 0 && evt.data.button !== 2) {
                    canvas.stage.once("pointerdown", interactionHandler);
                    return;
                }
                if (evt.data.button === 2) {
                    cleanUp();
                    return;
                }

                const pos = evt.data.getLocalPosition(canvas.app.stage);
                const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;

                if (necroCenter) {
                    const targetCenter = { x: snapped.x + (gridSize * 0.5), y: snapped.y + (gridSize * 0.5) };
                    const dx = Math.abs(necroCenter.x - targetCenter.x);
                    const dy = Math.abs(necroCenter.y - targetCenter.y);
                    const dist = (Math.max(dx, dy) / canvas.grid.size) * canvas.scene.grid.distance;
                    if (dist > 60) {
                        ui.notifications.warn("The Perfected Thrall must be placed within 60 feet.");
                        canvas.stage.once("pointerdown", interactionHandler);
                        return;
                    }
                }

                cleanUp();

                const tokenDoc = await perfActor.getTokenDocument({ x: snapped.x, y: snapped.y });
                const finalPayload = foundry.utils.mergeObject(tokenDoc.toObject(), {
                    actorLink: false, 
                    ownership: { [game.user.id]: 3 }, 
                    flags: { "necromancer-thrall-helper": { masterId: actor.id, isPerfectedThrall: true } },
                    delta: { ownership: { [game.user.id]: 3 } }
                });

                await executeSpawn(finalPayload).catch(err => console.error(err));
            };

            canvas.stage.once("pointerdown", interactionHandler);
        });



            // --- CUSTOM VISUALS HELPER ---
        const applyCustomVisuals = (payload, actor, typePrefix) => {
            const img = actor.getFlag("necromancer-thrall-helper", `${typePrefix}Img`);
            const useRing = actor.getFlag("necromancer-thrall-helper", `${typePrefix}Ring`);
            const scale = actor.getFlag("necromancer-thrall-helper", `${typePrefix}Scale`);

            if (img) {
                payload.texture = payload.texture || {};
                payload.texture.src = img;
                if (payload.ring) {
                    payload.ring.subject = payload.ring.subject || {};
                    payload.ring.subject.texture = img;
                }
            }
            if (useRing !== undefined) {
                payload.ring = payload.ring || {};
                payload.ring.enabled = useRing;
            }
            if (scale !== undefined) {
                payload.texture = payload.texture || {};
                payload.texture.scaleX = scale;
                payload.texture.scaleY = scale;
                if (payload.ring && payload.ring.subject) {
                    payload.ring.subject.scale = scale;
                }
            }
            return payload;
        };

       
        const getOrImportActor = async (actorName) => {
            let actor = game.actors.find(a => a.name === actorName);
            if (actor) return actor;

            const pack = game.packs.get("necromancer-thrall-helper.necro-thralls");
            if (!pack) {
                ui.notifications.error("Could not find the Necromancer Thralls compendium pack.");
                return null;
            }

            const index = await pack.getIndex();
            const entry = index.find(a => a.name === actorName);
            if (!entry) {
                ui.notifications.error(`Could not find '${actorName}' in the compendium.`);
                return null;
            }

            return await pack.getDocument(entry._id);
        };



        {
            // Initialize state tracker if it doesn't exist so it survives re-renders
            this.spiritStates = this.spiritStates || {};

            const spiritDropdowns = html.querySelectorAll('.action-dropdown');
            spiritDropdowns.forEach(dropdown => {
                const thrallRow = dropdown.closest('.thrall-row');
                const thrallId = thrallRow.getAttribute('data-token-id');
                const toggleGroup = thrallRow.querySelector('.spirit-toggle-group');
                
                const updateToggle = () => {
                    if (!toggleGroup) return; 
                    const val = dropdown.value;
                    if (val === 'strike' || val === 'charge' || val === 'conglomerate-charge') {
                        toggleGroup.style.display = 'flex';
                    } else {
                        toggleGroup.style.display = 'none';
                    }
                };
                
                dropdown.addEventListener('change', updateToggle);
                updateToggle(); 

                if (toggleGroup) {
                    const savedType = this.spiritStates[thrallId] || 'bludgeoning';
                    const targetBtn = toggleGroup.querySelector(`[data-type="${savedType}"]`);
                    if (targetBtn) {
                        toggleGroup.querySelectorAll('.spirit-dmg-btn').forEach(b => {
                            b.classList.remove('active');
                            b.style.background = '#222';
                            b.style.color = '#999';
                        });
                        targetBtn.classList.add('active');
                        
                        let activeBg = '#555'; 
                        if (savedType === 'spirit') activeBg = '#0ea5e9'; 
                        if (savedType === 'void') activeBg = '#7e22ce'; 
                        
                        targetBtn.style.background = activeBg;
                        targetBtn.style.color = '#fff';
                    }
                }
            });
            
            const spiritBtns = html.querySelectorAll('.spirit-dmg-btn');
            spiritBtns.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const group = btn.closest('.spirit-toggle-group');
                    const thrallId = btn.closest('.thrall-row').getAttribute('data-token-id');
                    const type = btn.getAttribute('data-type');
                    
                    
                    this.spiritStates[thrallId] = type;
                    
                    
                    group.querySelectorAll('.spirit-dmg-btn').forEach(b => {
                        b.classList.remove('active');
                        b.style.background = '#222';
                        b.style.color = '#999';
                    });
                    
                    
                    let activeBg = '#555'; 
                    if (type === 'spirit') activeBg = '#0ea5e9'; 
                    if (type === 'void') activeBg = '#7e22ce'; 
                    
                    btn.classList.add('active');
                    btn.style.background = activeBg;
                    btn.style.color = '#fff';
                });
            });
        }



        const reanimateBtn = html.querySelector(".reanimate-foe-btn");
        if (reanimateBtn) {
            reanimateBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor || !canvas.scene) return;

                const currentFocus = actor.system?.resources?.focus?.value || 0;
                if (currentFocus === 0) return ui.notifications.warn("You have no Focus Points to cast Reanimate Foe!");

                const loreSkill = Object.values(actor.skills).find(s => s.slug?.includes("undead-lore") || s.label.toLowerCase().includes("undead lore"));
                if (!loreSkill) return ui.notifications.warn("You lack the Undead Lore skill required to weave this magic.");

                const targets = Array.from(game.user.targets);
                if (targets.length !== 1) return ui.notifications.warn("You must target exactly one dead enemy corpse on the canvas.");
                
                const corpseDoc = targets[0].document;
                const corpseActor = targets[0].actor;

                if ((corpseActor.system.attributes.hp?.value || 0) > 0) return ui.notifications.warn("The target is still breathing. It must be dead (0 HP).");

                const necroTokens = actor.getActiveTokens();
                if (necroTokens.length === 0) return ui.notifications.warn("Necromancer token not found on the canvas.");
                const necroToken = necroTokens[0];

                const allThralls = canvas.scene.tokens.filter(t => t.flags?.["necromancer-thrall-helper"]?.masterId === actor.id);
                const validThralls = allThralls.filter(t => {
                    let distToNecro = 999;
                    const dx = Math.abs(t.x - necroToken.x);
                    const dy = Math.abs(t.y - necroToken.y);
                    distToNecro = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene.grid.distance || 5);
                    
                    let distToCorpse = 999;
                    const dx2 = Math.abs(t.x - corpseDoc.x);
                    const dy2 = Math.abs(t.y - corpseDoc.y);
                    distToCorpse = (Math.max(dx2, dy2) / canvas.grid.size) * (canvas.scene.grid.distance || 5);
                    
                    return distToNecro <= 30 && distToCorpse <= 30; 
                });

                if (validThralls.length === 0) return ui.notifications.warn("No thrall available within 30 feet of you AND 30 feet of the corpse.");

                const corpseLevel = corpseActor.level || 1;
                const standardDCs = [14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50];
                const exactDC = corpseLevel < 0 ? 14 : (corpseLevel > 25 ? 50 : standardDCs[corpseLevel]);

                let optionsHtml = validThralls.map(t => `<option value="${t.id}">${t.name}</option>`).join("");

                new Dialog({
                    title: "Reanimate Foe",
                    content: `
                        <p>Sacrifice a thrall and launch its animus into <b>${corpseDoc.name}</b>?</p>
                        <p>Rolling <b>Undead Lore</b> against DC ${exactDC} (Level ${corpseLevel}).</p>
                        <form><div class="form-group"><label>Thrall to Launch:</label><select id="rf-thrall">${optionsHtml}</select></div></form>
                    `,
                    buttons: {
                        cast: {
                            icon: '<i class="fas fa-bolt"></i>',
                            label: "Launch",
                            callback: async (dHtml) => {
                                const thrallId = dHtml.find("#rf-thrall").val();
                                const thrallToken = canvas.tokens.get(thrallId);
                                if (!thrallToken) return;

                                await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                                const roll = await new Roll(`1d20 + ${loreSkill.mod}`).evaluate({async: true});
                                const total = roll.total;
                                let dosNum = total >= exactDC + 10 ? 3 : total >= exactDC ? 2 : total <= exactDC - 10 ? 0 : 1;
                                if (roll.dice[0].results[0].result === 20) dosNum = Math.min(3, dosNum + 1);
                                if (roll.dice[0].results[0].result === 1) dosNum = Math.max(0, dosNum - 1);

                                const dosMap = ["Critical Failure", "Failure", "Success", "Critical Success"];
                                const dosColors = ["#ef4444", "#eab308", "#3b82f6", "#22c55e"];
                                
                                let chatContent = `
                                    <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid ${dosColors[dosNum]};">
                                        <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> violently launches <b>${thrallToken.name}</b> into the corpse of <b>${corpseDoc.name}</b>!</p>
                                        <p style="margin: 0; font-size: 1.1em;">Undead Lore: <b>${total}</b> vs DC ${exactDC}</p>
                                        <p style="margin: 0; font-weight: bold; color: ${dosColors[dosNum]};">${dosMap[dosNum]}!</p>
                                `;

                                await thrallToken.document.delete();

                                if (dosNum === 0) {
                                    await actor.update({ "system.resources.focus.value": currentFocus });
                                    chatContent += `<p style="margin: 5px 0 0 0;">The ritual violently rejects the corpse. A basic thrall spawns in its place, and the Focus Point is refunded.</p></div>`;
                                    
                                    const presets = typeof getThrallPresets === "function" ? getThrallPresets(actor) : [];
                                    const presetId = presets.length > 0 ? presets[0].id : "default";
                                    const basePayload = await prepareThrallPayload(actor, presetId);
                                    if (basePayload) {
                                        const finalPayload = foundry.utils.mergeObject(basePayload, {
                                            x: corpseDoc.x, y: corpseDoc.y, delta: { ownership: { [game.user.id]: 3 } }
                                        });
                                        executeSpawn(finalPayload);
                                    }
                                } else {
                                    const decayAmount = dosNum === 1 ? 50 : 15;
                                    const isFailure = dosNum === 1;

                                    chatContent += `
                                        <p style="margin: 5px 0 0 0;">The corpse violently jerks back to un-life! It has 100 HP and decays <b>${decayAmount} HP</b> each turn.</p>
                                        <p style="margin: 5px 0 0 0; font-size: 0.85em; font-style: italic; color: #aaa;">Special abilities and Strike side-effects are disabled by the ritual.</p>
                                    </div>`;

                                    ui.notifications.info("Click an adjacent space to spawn the Reanimated Foe.");
                                    document.body.style.cursor = "crosshair";
                                    canvas.app.view.style.cursor = "crosshair";

                                    const gridSize = canvas.grid.size;
                                    const ghost = new PIXI.Graphics();
                                    ghost.beginFill(0x9900ff, 0.4);
                                    ghost.lineStyle(2, 0x6600cc, 0.8);
                                    ghost.drawRect(0, 0, (corpseDoc.width || 1) * gridSize, (corpseDoc.height || 1) * gridSize);
                                    ghost.endFill();
                                    ghost.zIndex = 1000;
                                    canvas.tokens.addChild(ghost);

                                    const updateGhost = (evt) => {
                                        const pos = evt.data.getLocalPosition(canvas.app.stage);
                                        const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                                        ghost.position.set(snapped.x, snapped.y);
                                    };

                                    canvas.stage.on("pointermove", updateGhost);

                                    const cleanUp = () => {
                                        document.body.style.cursor = "";
                                        canvas.app.view.style.cursor = "";
                                        canvas.stage.off("pointermove", updateGhost);
                                        ghost.destroy();
                                    };

                                    canvas.stage.once("pointerdown", async (evt) => {
                                        if (evt.data.button !== 0) { cleanUp(); return; }
                                        const pos = evt.data.getLocalPosition(canvas.app.stage);
                                        const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                                        cleanUp();

                                        let payload = corpseDoc.toObject();
                                        payload.actorLink = false; 
                                        payload.x = snapped.x;
                                        payload.y = snapped.y;
                                        payload.name = `Reanimated ${corpseDoc.name}`;
                                        payload.flags = payload.flags || {};
                                        payload.flags["necromancer-thrall-helper"] = { masterId: actor.id };

                                        const [newTokenDoc] = await canvas.scene.createEmbeddedDocuments("Token", [payload]);
                                        if (newTokenDoc && newTokenDoc.actor) {
                                            const newActor = newTokenDoc.actor;
                                            
                                            await newActor.update({
                                                "system.attributes.hp.value": 100,
                                                "system.attributes.hp.max": 100,
                                                "system.attributes.hp.temp": 0,
                                                "system.attributes.immunities": [],
                                                "system.attributes.weaknesses": [],
                                                "system.attributes.resistances": [],
                                                "system.details.alliance": "party"
                                            });

                                            const effectData = {
                                                name: "Reanimated Foe",
                                                type: "effect",
                                                img: "icons/magic/death/icons/magic/death/skeleton-skull-soul-blue.webp",
                                                system: {
                                                    duration: { value: 1, unit: "minutes", expiry: "turn-start" },
                                                    description: { value: `<b>Decay:</b> Loses ${decayAmount} HP at the end of its turn. Cannot be healed.<br>${isFailure ? "<b>Failure:</b> Strikes deal half damage." : ""}` },
                                                    rules: [{ key: "Immunity", type: "healing" }]
                                                },
                                                flags: {
                                                    "necromancer-thrall-helper": {
                                                        isReanimatedFoe: true,
                                                        decayAmount: decayAmount,
                                                        masterId: actor.id
                                                    }
                                                }
                                            };
                                            await newActor.createEmbeddedDocuments("Item", [effectData]);
                                        }
                                    });
                                }

                                await ChatMessage.create({
                                    speaker: ChatMessage.getSpeaker({ actor: actor }),
                                    flavor: `<strong>Reanimate Foe</strong>`,
                                    content: chatContent
                                });
                            }
                        },
                        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                    },
                    default: "cast"
                }).render(true);
            });
        }
        const imgBtn = html.querySelector(".set-default-img-btn");
        if (imgBtn) {
            imgBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor) return;

                
                const configKeys = {
                    "thrall": { label: "Base Thrall", img: "defaultThrallImg", ring: "defaultRingEnabled", scale: "defaultThrallScale" },
                    "shed": { label: "Shed Corpse", img: "shedImg", ring: "shedRing", scale: "shedScale" },
                    "lancer": { label: "Skeletal Lancer", img: "lancerImg", ring: "lancerRing", scale: "lancerScale" },
                    "nightmare": { label: "Recurring Nightmare", img: "nightmareImg", ring: "nightmareRing", scale: "nightmareScale" },
                    "graveyard": { label: "Living Graveyard", img: "graveyardImg", ring: "graveyardRing", scale: "graveyardScale" },
                    "tendril": { label: "Bloody Tendril", img: "tendrilImg", ring: "tendrilRing", scale: "tendrilScale" },
                    "conglom": { label: "Conglomerate of Limbs", img: "conglomImg", ring: "conglomRing", scale: "conglomScale" }
                };

                const getCfg = (type) => ({
                    img: actor.getFlag("necromancer-thrall-helper", configKeys[type].img) || "",
                    ring: actor.getFlag("necromancer-thrall-helper", configKeys[type].ring) ?? true,
                    scale: actor.getFlag("necromancer-thrall-helper", configKeys[type].scale) ?? 1.0
                });

                let optionsHtml = "";
                let groupsHtml = "";

                for (const [key, map] of Object.entries(configKeys)) {
                    optionsHtml += `<option value="${key}">${map.label}</option>`;
                    const c = getCfg(key);
                    
                    groupsHtml += `
                        <div class="summon-cfg-group" data-target="${key}" style="display: ${key === 'thrall' ? 'block' : 'none'}; margin-top: 10px;">
                            <div class="form-group" style="display: flex; gap: 5px; margin-bottom: 15px; align-items: center;">
                                <label style="flex: 1;">Image:</label>
                                <input type="text" id="${key}-img-path" value="${c.img}" style="flex: 3; background: rgba(0,0,0,0.5); color: #fff; border: 1px solid #555;">
                                <button type="button" class="img-picker-btn" data-target="${key}-img-path" style="flex: 0 0 30px; height: 26px; line-height: 1; padding: 0;"><i class="fas fa-file-import"></i></button>
                            </div>
                            <div class="form-group" style="display: flex; justify-content: space-between; margin-bottom: 5px; align-items: center;">
                                <label>Enable Token Ring:</label>
                                <input type="checkbox" id="${key}-ring-enabled" ${c.ring ? "checked" : ""}>
                            </div>
                            <div class="form-group" style="display: flex; justify-content: space-between; align-items: center;">
                                <label>Image Scale:</label>
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <input type="range" class="scale-slider" id="${key}-img-scale" data-val-target="${key}-scale-val" min="0.5" max="5" step="0.1" value="${c.scale}" style="width: 100px;">
                                    <span id="${key}-scale-val" style="min-width: 25px; text-align: right;">${c.scale}</span>
                                </div>
                            </div>
                        </div>
                    `;
                }

                const formHtml = `
                    <form autocomplete="off" style="margin-bottom: 10px;">
                        <p>Configure default appearances for your summoned entities.</p>
                        <div class="form-group">
                            <label>Entity Setup:</label>
                            <select id="summon-type-selector">${optionsHtml}</select>
                        </div>
                        ${groupsHtml}
                    </form>
                `;

                new Dialog({
                    title: "Default Summon Config",
                    content: formHtml,
                    render: (dialogHtml) => {
                        dialogHtml.find("#summon-type-selector").on("change", (evt) => {
                            const selected = evt.target.value;
                            dialogHtml.find(".summon-cfg-group").hide();
                            dialogHtml.find(`.summon-cfg-group[data-target="${selected}"]`).show();
                        });

                        dialogHtml.find(".img-picker-btn").on("click", (evt) => {
                            evt.preventDefault();
                            const targetId = $(evt.currentTarget).data("target");
                            const inputElt = dialogHtml.find(`#${targetId}`);
                            new FilePicker({
                                type: "image",
                                current: inputElt.val(),
                                callback: (path) => inputElt.val(path)
                            }).render(true);
                        });

                        dialogHtml.find(".scale-slider").on("input", (evt) => {
                            const targetId = $(evt.currentTarget).data("val-target");
                            dialogHtml.find(`#${targetId}`).text(evt.target.value);
                        });
                    },
                    buttons: {
                        save: {
                            icon: '<i class="fas fa-save"></i>',
                            label: "Save All Configs",
                            callback: async (dialogHtml) => {
                                let updates = {};
                                for (const [key, map] of Object.entries(configKeys)) {
                                    updates[`flags.necromancer-thrall-helper.${map.img}`] = dialogHtml.find(`#${key}-img-path`).val();
                                    updates[`flags.necromancer-thrall-helper.${map.ring}`] = dialogHtml.find(`#${key}-ring-enabled`).is(":checked");
                                    updates[`flags.necromancer-thrall-helper.${map.scale}`] = parseFloat(dialogHtml.find(`#${key}-img-scale`).val());
                                }
                                await actor.update(updates);
                                ui.notifications.info("Summon configurations updated successfully.");
                            }
                        },
                        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                    },
                    default: "save"
                }).render(true);
            });
        }



        // --- CONJURE SKELETAL LANCERS (UP TO 5) ---
        const lancersBtn = html.querySelector(".conjure-lancers-btn");
        if (lancersBtn) {
            lancersBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor) return;

                const currentFocus = actor.system?.resources?.focus?.value || 0;
                if (currentFocus === 0) return ui.notifications.warn("You have no Focus Points to cast Skeletal Lancers!");

                const lancerActor = await getOrImportActor("Skeletal Lancer");
                if (!lancerActor) return;

                await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                let currentSpawnIndex = 0;
                const maxSpawns = 5;

                ui.notifications.info(`Click the canvas to place Skeletal Lancer 1 of ${maxSpawns} within 60 feet. Right-click to finish early.`);
                document.body.style.cursor = "crosshair";
                canvas.app.view.style.cursor = "crosshair";

                let rangeIndicator = null;
                let necroCenter = null;
                const necroTokens = actor.getActiveTokens();
                if (necroTokens.length > 0) {
                    necroCenter = necroTokens[0].center;
                    const rangeInPixels = (60 / canvas.scene.grid.distance) * canvas.grid.size;
                    rangeIndicator = new PIXI.Graphics();
                    rangeIndicator.beginFill(0x22c55e, 0.05);
                    rangeIndicator.lineStyle(3, 0x22c55e, 0.5);
                    rangeIndicator.drawCircle(necroCenter.x, necroCenter.y, rangeInPixels);
                    rangeIndicator.endFill();
                    rangeIndicator.zIndex = 998;
                    canvas.tokens.addChild(rangeIndicator);
                }

                const gridSize = canvas.grid.size;
                const ghost = new PIXI.Graphics();
                ghost.beginFill(0xd97706, 0.35);
                ghost.lineStyle(2, 0xb45309, 0.9);
                ghost.drawRect(0, 0, gridSize, gridSize);
                ghost.endFill();
                ghost.zIndex = 1000;
                ghost.position.set(-1000, -1000);
                canvas.tokens.addChild(ghost);

                const updateGhost = (evt) => {
                    const pos = evt.data.getLocalPosition(canvas.app.stage);
                    const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                    ghost.position.set(snapped.x, snapped.y);
                };

                canvas.stage.on("pointermove", updateGhost);

                const cleanUp = () => {
                    document.body.style.cursor = "";
                    canvas.app.view.style.cursor = "";
                    canvas.stage.off("pointermove", updateGhost);
                    ghost.destroy();
                    if (rangeIndicator) {
                        rangeIndicator.destroy();
                        rangeIndicator = null;
                    }
                };

                const interactionHandler = async (evt) => {
                    if (evt.data.button !== 0 && evt.data.button !== 2) {
                        canvas.stage.once("pointerdown", interactionHandler);
                        return;
                    }

                    if (evt.data.button === 2) {
                        cleanUp();
                        ui.notifications.info(`Finished summoning ${currentSpawnIndex} Skeletal Lancer(s).`);
                        return;
                    }

                    const pos = evt.data.getLocalPosition(canvas.app.stage);
                    const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;

                    if (necroCenter) {
                        const targetCenter = { x: snapped.x + (gridSize * 0.5), y: snapped.y + (gridSize * 0.5) };
                        const dx = Math.abs(necroCenter.x - targetCenter.x);
                        const dy = Math.abs(necroCenter.y - targetCenter.y);
                        const dist = (Math.max(dx, dy) / canvas.grid.size) * canvas.scene.grid.distance;
                        if (dist > 60) {
                            ui.notifications.warn("Skeletal Lancers must be placed within 60 feet.");
                            canvas.stage.once("pointerdown", interactionHandler);
                            return;
                        }
                    }

                    const tokenDoc = await lancerActor.getTokenDocument({ x: snapped.x, y: snapped.y });
                    const finalPayload = foundry.utils.mergeObject(tokenDoc.toObject(), {
                        actorLink: false, 
                        ownership: { [game.user.id]: 3 }, 
                        flags: { "necromancer-thrall-helper": { masterId: actor.id } },
                        delta: { ownership: { [game.user.id]: 3 } }
                    });
                    applyCustomVisuals(finalPayload, actor, "lancer");

                    currentSpawnIndex++;
                    await executeSpawn(finalPayload).catch(err => console.error(err));

                    if (currentSpawnIndex < maxSpawns) {
                        ui.notifications.info(`Place Skeletal Lancer ${currentSpawnIndex + 1} of ${maxSpawns}. Right-click to stop.`);
                        canvas.stage.once("pointerdown", interactionHandler);
                    } else {
                        cleanUp();
                        ui.notifications.info("All 5 Skeletal Lancers deployed.");
                    }
                };

                canvas.stage.once("pointerdown", interactionHandler);
            });
        }

        // --- CONJURE / SUSTAIN RECURRING NIGHTMARE ---
        const nightmareBtn = html.querySelector(".conjure-nightmare-btn, .sustain-nightmare-btn");
        if (nightmareBtn) {
            nightmareBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const isSustain = e.currentTarget.classList.contains("sustain-nightmare-btn");
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor) return;

                const currentCombat = game.combat;
                const currentRound = currentCombat ? currentCombat.round : `ooc_${Date.now()}`;

                if (isSustain) {
                    const lastSustained = actor.getFlag("necromancer-thrall-helper", "nightmareSustainRound");
                    if (currentCombat && lastSustained === currentRound) {
                        return ui.notifications.warn("You can only resummon the Recurring Nightmare once per round.");
                    }
                } else {
                    const currentFocus = actor.system?.resources?.focus?.value || 0;
                    if (currentFocus === 0) return ui.notifications.warn("You have no Focus Points to cast Recurring Nightmare!");
                    await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                }

                ui.notifications.info("Click the canvas within 60 feet (even on occupied spaces) to manifest the Nightmare. Right-click to cancel.");
                document.body.style.cursor = "crosshair";
                canvas.app.view.style.cursor = "crosshair";

                let rangeIndicator = null;
                let necroCenter = null;
                const necroTokens = actor.getActiveTokens();
                if (necroTokens.length > 0) {
                    necroCenter = necroTokens[0].center;
                    const rangeInPixels = (60 / canvas.scene.grid.distance) * canvas.grid.size;
                    rangeIndicator = new PIXI.Graphics();
                    rangeIndicator.beginFill(0x22c55e, 0.05);
                    rangeIndicator.lineStyle(3, 0x22c55e, 0.5);
                    rangeIndicator.drawCircle(necroCenter.x, necroCenter.y, rangeInPixels);
                    rangeIndicator.endFill();
                    rangeIndicator.zIndex = 998;
                    canvas.tokens.addChild(rangeIndicator);
                }

                const gridSize = canvas.scene.grid.size;
                const ghost = new PIXI.Graphics();
                ghost.beginFill(0x38bdf8, 0.35);
                ghost.lineStyle(2, 0x0284c7, 0.9);
                ghost.drawRect(0, 0, gridSize, gridSize);
                ghost.endFill();
                ghost.zIndex = 1000;
                ghost.position.set(-1000, -1000);
                canvas.tokens.addChild(ghost);

                const updateGhost = (evt) => {
                    const pos = evt.data.getLocalPosition(canvas.app.stage);
                    const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                    ghost.position.set(snapped.x, snapped.y);
                };

                canvas.stage.on("pointermove", updateGhost);

                const cleanUp = () => {
                    document.body.style.cursor = "";
                    canvas.app.view.style.cursor = "";
                    canvas.stage.off("pointermove", updateGhost);
                    ghost.destroy();
                    if (rangeIndicator) {
                        rangeIndicator.destroy();
                        rangeIndicator = null;
                    }
                };

                const interactionHandler = async (evt) => {
                    if (evt.data.button !== 0 && evt.data.button !== 2) {
                        canvas.stage.once("pointerdown", interactionHandler);
                        return;
                    }
                    if (evt.data.button === 2) {
                        cleanUp();
                        return;
                    }

                    const pos = evt.data.getLocalPosition(canvas.app.stage);
                    const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;

                    if (necroCenter) {
                        const targetCenter = { x: snapped.x + (gridSize * 0.5), y: snapped.y + (gridSize * 0.5) };
                        const dx = Math.abs(necroCenter.x - targetCenter.x);
                        const dy = Math.abs(necroCenter.y - targetCenter.y);
                        const dist = (Math.max(dx, dy) / canvas.grid.size) * canvas.scene.grid.distance;
                        if (dist > 60) {
                            ui.notifications.warn("The Recurring Nightmare must be placed within 60 feet.");
                            canvas.stage.once("pointerdown", interactionHandler);
                            return;
                        }
                    }

                    cleanUp();

                    const nightmareActor = await getOrImportActor("Recurring Nightmare");
                    if (!nightmareActor) return;

                    const tokenDoc = await nightmareActor.getTokenDocument({ x: snapped.x, y: snapped.y });

                    const finalPayload = foundry.utils.mergeObject(tokenDoc.toObject(), {
                        actorLink: false, 
                        ownership: { [game.user.id]: 3 }, 
                        flags: { "necromancer-thrall-helper": { masterId: actor.id } },
                        delta: { ownership: { [game.user.id]: 3 } }
                    });
                    applyCustomVisuals(finalPayload, actor, "nightmare");

                    const [createdToken] = await executeSpawn(finalPayload);

                    if (isSustain && currentCombat) {
                        await actor.setFlag("necromancer-thrall-helper", "nightmareSustainRound", currentRound);
                    }
                    await actor.unsetFlag("necromancer-thrall-helper", "nightmareDestroyed");

                    let attempts = 0;
                    const triggerHaunt = async () => {
                        const liveTokenDoc = canvas.scene.tokens.get(createdToken.id);
                        if (liveTokenDoc) {
                            globalThis.NecroThrallHelper?.checkNightmareHaunt(liveTokenDoc);
                        } else if (attempts < 20) {
                            attempts++;
                            setTimeout(triggerHaunt, 100);
                        }
                    };
                    triggerHaunt();

                    this.render({ force: false });

                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor: actor }),
                        flavor: `<strong>Recurring Nightmare</strong>`,
                        content: `<p><b>${actor.name}</b> ${isSustain ? "Sustains the nightmare, resummoning" : "conjures"} the <b>Recurring Nightmare</b> into reality!</p>`
                    });
                };
                
                canvas.stage.once("pointerdown", interactionHandler);
            });
        }

        if (!html.querySelector(".dismiss-all-btn")) {
            const tempDiv = document.createElement("div");
            tempDiv.innerHTML = `<button type="button" class="dismiss-all-btn" style="margin-top: 15px; width: 100%; padding: 6px;">Dismiss All Thralls</button>`;
            html.appendChild(tempDiv.firstElementChild);
        }

        const dismissBtn = html.querySelector(".dismiss-all-btn");
        if (dismissBtn) {
            dismissBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                dismissBtn.disabled = true;

                const actor = game.actors.get(this.necroId) || game.user.character;

                try {
                    for (const combat of game.combats) {
                        const badIds = combat.combatants.filter(c => {
                            if (!c.actor || !c.token || !canvas.scene.tokens.get(c.tokenId)) return true;
                            if (actor && c.token.getFlag("necromancer-thrall-helper", "masterId") === actor.id) return true;
                            return false;
                        }).map(c => c.id);

                        if (badIds.length > 0) {
                            await combat.deleteEmbeddedDocuments("Combatant", badIds);
                        }
                    }

                    if (canvas.scene && actor) {
                        const thrallIds = canvas.scene.tokens.filter(t => 
                            t.getFlag("necromancer-thrall-helper", "masterId") === actor.id
                        ).map(t => t.id);

                        if (thrallIds.length > 0) {
                            await canvas.scene.deleteEmbeddedDocuments("Token", thrallIds);
                        }
                    }
                } finally {
                    dismissBtn.disabled = false;
                    this.render(false);
                }
            });
        }

        const endNightmareBtn = html.querySelector(".end-nightmare-btn");
        if (endNightmareBtn) {
            endNightmareBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor) return;
                await actor.unsetFlag("necromancer-thrall-helper", "nightmareDestroyed");
                ui.notifications.info("The Recurring Nightmare fades completely into the ether.");
            });
        }

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
        globalThis.NecroThrallHelper = globalThis.NecroThrallHelper || {};
        const executeSheddingMatrix = async (actor, maxSpawns) => {
            if (globalThis.NecroThrallHelper._isSheddingCorpses) {
                return ui.notifications.warn("You are already shedding corpses! Right-click the canvas to cancel first.");
            }
            globalThis.NecroThrallHelper._isSheddingCorpses = true;

            const basePayload = await prepareThrallPayload(actor, "default");
            if (!basePayload) {
                globalThis.NecroThrallHelper._isSheddingCorpses = false;
                return;
            }

            let currentSpawn = 0;
            ui.notifications.info(`Click to place Thrall 1 of ${maxSpawns}. Right-click to stop early.`);
            document.body.style.cursor = "crosshair";
            canvas.app.view.style.cursor = "crosshair";

            const gridSize = canvas.grid.size;
            const ghost = new PIXI.Graphics();
            ghost.beginFill(0x4b5563, 0.35);
            ghost.lineStyle(2, 0x1f2937, 0.9);
            ghost.drawRect(0, 0, gridSize, gridSize);
            ghost.endFill();
            ghost.zIndex = 1000;
            canvas.tokens.addChild(ghost);

            const updateGhost = (evt) => {
                const pos = evt.data.getLocalPosition(canvas.app.stage);
                let gx = pos.x; let gy = pos.y;
                if (canvas.grid.getSnappedPoint) {
                    const snapped = canvas.grid.getSnappedPoint(pos, { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_VERTEX });
                    gx = snapped.x; gy = snapped.y;
                } else if (canvas.grid.getTopLeftPoint) {
                    const snapped = canvas.grid.getTopLeftPoint(pos);
                    gx = snapped.x ?? pos.x; gy = snapped.y ?? pos.y;
                } else if (canvas.grid.getTopLeft) {
                    const [sx, sy] = canvas.grid.getTopLeft(pos.x, pos.y);
                    gx = sx; gy = sy;
                }
                ghost.position.set(gx, gy);
            };
            canvas.stage.on("pointermove", updateGhost);

            const cleanUpSpawns = () => {
                globalThis.NecroThrallHelper._isSheddingCorpses = false;
                document.body.style.cursor = "";
                canvas.app.view.style.cursor = "";
                canvas.stage.off("pointermove", updateGhost);
                if (ghost && !ghost.destroyed) ghost.destroy();
            };

            const spawnHandler = (evt) => {
                if (evt.data.button !== 0 && evt.data.button !== 2) {
                    canvas.stage.once("pointerdown", spawnHandler);
                    return;
                }
                if (evt.data.button === 2) { cleanUpSpawns(); return; }

                const pos = evt.data.getLocalPosition(canvas.app.stage);
                let spawnX = pos.x; let spawnY = pos.y;
                if (canvas.grid.getSnappedPoint) {
                    const snapped = canvas.grid.getSnappedPoint(pos, { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_VERTEX });
                    spawnX = snapped.x; spawnY = snapped.y;
                } else if (canvas.grid.getTopLeftPoint) {
                    const snapped = canvas.grid.getTopLeftPoint(pos);
                    spawnX = snapped.x ?? pos.x; spawnY = snapped.y ?? pos.y;
                } else if (canvas.grid.getTopLeft) {
                    const [sx, sy] = canvas.grid.getTopLeft(pos.x, pos.y);
                    spawnX = sx; spawnY = sy;
                }

                const ownerIds = Object.keys(actor.ownership || {}).filter(k => actor.ownership[k] === 3 && k !== "default");
                const newOwnership = { default: 0 };
                ownerIds.forEach(id => newOwnership[id] = 3);
                newOwnership[game.user.id] = 3;

                const clonedPayload = foundry.utils.deepClone(basePayload);
                const finalPayload = foundry.utils.mergeObject(clonedPayload, {
                    actorLink: false,
                    name: "Shed Corpse",
                    x: spawnX, 
                    y: spawnY,
                    width: 1,
                    height: 1,
                    texture: { src: "systems/pf2e/icons/spells/animate-dead.webp", scaleX: 1, scaleY: 1 },
                    delta: { ownership: newOwnership },
                    flags: { "necromancer-thrall-helper": { masterId: actor.id } }
                });

                // --- OVERRIDE WITH CUSTOM SHED CORPSE VISUALS ---
                applyCustomVisuals(finalPayload, actor, "shed");

                currentSpawn++;
                ui.notifications.info(`Spawn request ${currentSpawn} queued...`);
                
                executeSpawn(finalPayload).catch(err => console.error(err));

                if (currentSpawn < maxSpawns) {
                    canvas.stage.once("pointerdown", spawnHandler);
                } else {
                    cleanUpSpawns();
                    ui.notifications.info("All summons requested.");
                }
            };
            canvas.stage.once("pointerdown", spawnHandler);
        };
        globalThis.NecroThrallHelper.executeSheddingMatrix = executeSheddingMatrix;
        
    
        const activeGraveyard = canvas.scene ? canvas.scene.tokens.find(t => t.flags?.["necromancer-thrall-helper"]?.masterId === this.necroId && t.flags?.["necromancer-thrall-helper"]?.isLivingGraveyard) : null;
        const $graveyardBtn = $(html).find(".living-graveyard-btn, .titan-drop-btn");
        
        if ($graveyardBtn.length > 0) {
            if (activeGraveyard) {
                
                $graveyardBtn.replaceWith(`
                    <button type="button" class="dismiss-graveyard-btn" data-token-id="${activeGraveyard.id}" style="width: 100%; margin-top: 5px; background: #4b5563; color: #f87171; border: 1px solid #dc2626; padding: 6px; font-weight: bold;">
                        <i class="fas fa-times-circle"></i> Dismiss Living Graveyard
                    </button>
                `);
                
                $(html).find(".dismiss-graveyard-btn").on("click", async (e) => {
                    e.preventDefault();
                    await executeDelete(activeGraveyard.id);
                    ui.notifications.info("Living Graveyard dismissed.");
                    this.render(false);
                });
            } else {
                $graveyardBtn.off("click").on("click", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    if (this._isPlacingGraveyard) {
                        return ui.notifications.warn("You are already placing a Graveyard! Right-click the canvas to cancel first.");
                    }
                    this._isPlacingGraveyard = true;
    
                    const actor = game.actors.get(this.necroId) || game.user.character;
                    if (!actor) { this._isPlacingGraveyard = false; return; }
                    
                    const spell = actor.items.find(i => i.name === "Living Graveyard");
                    if (!spell) { this._isPlacingGraveyard = false; return ui.notifications.warn("Living Graveyard spell not found on your sheet."); }
    
                    const currentFocus = actor.system?.resources?.focus?.value || 0;
                    if (currentFocus === 0) { this._isPlacingGraveyard = false; return ui.notifications.warn("You have no Focus Points to cast Living Graveyard!"); }
    
                    await actor.update({ "system.resources.focus.value": currentFocus - 1 });
    
                    const graveyardActor = await getOrImportActor("Living Graveyard");
                    if (!graveyardActor) { this._isPlacingGraveyard = false; return; }
    
                    ui.notifications.info("Click to place the Living Graveyard within 120 feet. Right-click to cancel.");
                    document.body.style.cursor = "crosshair";
                    canvas.app.view.style.cursor = "crosshair";
    
                    let rangeIndicator = null;
                    let necroCenter = null;
                    const necroTokens = actor.getActiveTokens();
                    if (necroTokens.length > 0) {
                        necroCenter = necroTokens[0].center;
                        const rangeInPixels = (120 / canvas.scene.grid.distance) * canvas.grid.size;
                        rangeIndicator = new PIXI.Graphics();
                        rangeIndicator.beginFill(0x22c55e, 0.05);
                        rangeIndicator.lineStyle(3, 0x22c55e, 0.5);
                        rangeIndicator.drawCircle(necroCenter.x, necroCenter.y, rangeInPixels);
                        rangeIndicator.endFill();
                        rangeIndicator.zIndex = 998;
                        canvas.tokens.addChild(rangeIndicator);
                    }
    
                    const gridSize = canvas.grid.size;
                    const ghost = new PIXI.Graphics();
                    ghost.beginFill(0x1f2937, 0.4);
                    ghost.lineStyle(2, 0x4b5563, 0.9);
                    ghost.drawRect(0, 0, gridSize * 4, gridSize * 4);
                    ghost.endFill();
                    ghost.zIndex = 1000;
                    canvas.tokens.addChild(ghost);
    
                    const updateGhost = (evt) => {
                        const pos = evt.data.getLocalPosition(canvas.app.stage);
                        const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                        ghost.position.set(snapped.x, snapped.y);
                    };
    
                    canvas.stage.on("pointermove", updateGhost);
    
                    const cleanUp = () => {
                        this._isPlacingGraveyard = false;
                        document.body.style.cursor = "";
                        canvas.app.view.style.cursor = "";
                        canvas.stage.off("pointermove", updateGhost);
                        if (ghost && !ghost.destroyed) ghost.destroy();
                        if (rangeIndicator) {
                            rangeIndicator.destroy();
                            rangeIndicator = null;
                        }
                    };
    
                    const interactionHandler = async (evt) => {
                        if (evt.data.button !== 0 && evt.data.button !== 2) {
                            canvas.stage.once("pointerdown", interactionHandler);
                            return;
                        }
                        if (evt.data.button === 2) { 
                            await actor.update({ "system.resources.focus.value": currentFocus });
                            cleanUp(); 
                            return; 
                        }
    
                        const pos = evt.data.getLocalPosition(canvas.app.stage);
                        const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
    
                        if (necroCenter) {
                            const targetCenter = { x: snapped.x + (gridSize * 2), y: snapped.y + (gridSize * 2) };
                            const dx = Math.abs(necroCenter.x - targetCenter.x);
                            const dy = Math.abs(necroCenter.y - targetCenter.y);
                            const dist = (Math.max(dx, dy) / canvas.grid.size) * canvas.scene.grid.distance;
                            if (dist > 120) {
                                ui.notifications.warn("The Living Graveyard must be placed within 120 feet.");
                                canvas.stage.once("pointerdown", interactionHandler);
                                return;
                            }
                        }
    
                        cleanUp();
    
                        let payload = (await graveyardActor.getTokenDocument()).toObject();
                        payload.x = snapped.x; payload.y = snapped.y;
                        payload.name = "Living Graveyard"; 
                        payload.delta = { ownership: { [game.user.id]: 3 } };
                        payload.flags = { "necromancer-thrall-helper": { masterId: actor.id, isLivingGraveyard: true } };
                        payload = applyCustomVisuals(payload, actor, "graveyard");
                        
                        const [newTokenDoc] = await canvas.scene.createEmbeddedDocuments("Token", [payload]);
                        
                        if (newTokenDoc && newTokenDoc.actor) {
                            const effectData = {
                                name: "Living Graveyard Logic", type: "effect", img: "icons/environment/wilderness/monolith-stone-grey.webp",
                                system: {
                                    duration: { value: 1, unit: "minutes", expiry: "turn-start" },
                                    rules: [] 
                                },
                                flags: { "necromancer-thrall-helper": { isLivingGraveyard: true } }
                            };
                            await newTokenDoc.actor.createEmbeddedDocuments("Item", [effectData]);
    
                            const [templateDoc] = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{
                                t: "circle", user: game.user.id,
                                x: snapped.x + (gridSize * 2), y: snapped.y + (gridSize * 2),
                                distance: 20, fillColor: game.user.color || "#4b5563", fillAlpha: 0.15,
                                flags: {} 
                            }]);
    
                            const templateId = templateDoc ? templateDoc.id : null;
                            if (templateId && newTokenDoc) {
                                await newTokenDoc.update({ "flags.necromancer-thrall-helper.graveyardTemplateId": templateId });
                            }
    
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
                            if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) exactDC = actor.system.attributes.classDC.dc.value;
    
                            await spell.update({
                                "system.defense.save.statistic": "fortitude",
                                "system.defense.save.basic": false,
                                "system.defense.save.dc.value": exactDC
                            });
    
                            const targetsData = {};
                            const validTargets = canvas.tokens.placeables.filter(t => {
                                if (!t.actor || t.id === newTokenDoc.id) return false;
                                const dist = Math.hypot(t.center.x - (snapped.x + (gridSize * 2)), t.center.y - (snapped.y + (gridSize * 2)));
                                return dist <= ((20 / canvas.scene.grid.distance) * gridSize);
                            });
                            validTargets.forEach(t => {
                                targetsData[t.id] = { id: t.id, name: t.name, img: t.document.texture.src, hasRolled: false, isHealing: false, isImmune: false, hasApplied: false };
                            });
    
                            const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
                            const aoeHtmlContent = await renderTemplate(templatePath, {
                                targets: Object.values(targetsData),
                                itemName: "Living Graveyard",
                                saveType: "Fortitude",
                                saveDC: exactDC
                            });
    
                            await ChatMessage.create({
                                speaker: ChatMessage.getSpeaker({ actor: actor }),
                                flavor: `<strong>Living Graveyard Spawned!</strong>`,
                                content: `
                                    <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #4b5563;">
                                        <p style="margin: 0 0 5px 0;">The ground violently erupts as a Gargantuan mass of earth and tombstones rises!</p>
                                        <p style="margin: 0 0 5px 0;"><b>Violent Shake:</b> All creatures in a 10-foot emanation must succeed at a Fortitude save or fall prone.</p>
                                        <hr>${aoeHtmlContent}
                                    </div>
                                `,
                                flags: { 
                                    "aoe-easy-resolve": {
                                        templateId: templateId, 
                                        documentName: "ManualTarget", 
                                        itemUuid: spell.uuid,
                                        itemName: "Living Graveyard", 
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
                    };
                    canvas.stage.once("pointerdown", interactionHandler);
                });
        }
    }
        const shedBtn = html.querySelector(".graveyard-shed-btn");
        if (shedBtn) {
            shedBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor) return;
                
                if (globalThis.NecroThrallHelper?.executeSheddingMatrix) {
                    globalThis.NecroThrallHelper.executeSheddingMatrix(actor, 5);
                }
            });
        }
        const instantArmyBtn = html.querySelector(".instant-army-btn");
        if (instantArmyBtn) {
            instantArmyBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor) return;
                
                if (actor.getFlag("necromancer-thrall-helper", "instantArmyUsed")) {
                    return ui.notifications.warn("You have already exhausted your emergency cache today.");
                }

                const presets = typeof getThrallPresets === "function" ? getThrallPresets(actor) : [];
                
               
                let optionsHtml = '<option value="default">(Default Thrall)</option><option value="random">(Random Non-Unique Family Member)</option>';
                presets.forEach(p => {
                    if (!p.isUnique) optionsHtml += `<option value="${p.id}">${p.name}</option>`;
                });

                new Dialog({
                    title: "Instant Army",
                    content: `
                        <p>Call upon your reserve cache to spawn up to <b>20 thralls</b>!</p>
                        <form>
                            <div class="form-group" style="margin-bottom: 8px;">
                                <label>Thrall Type:</label>
                                <select id="army-preset" style="width: 100%;">${optionsHtml}</select>
                            </div>
                        </form>
                    `,
                    buttons: {
                        summon: {
                            icon: '<i class="fas fa-skull"></i>',
                            label: "Arise",
                            callback: async (dHtml) => {
                                const presetId = dHtml.find("#army-preset").val();
                                await actor.setFlag("necromancer-thrall-helper", "instantArmyUsed", true);

                                await ChatMessage.create({
                                    speaker: ChatMessage.getSpeaker({ actor: actor }),
                                    flavor: `<strong>Instant Army</strong>`,
                                    content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #9333ea;">
                                                <p style="margin: 0;"><b>${actor.name}</b> tears the veil, calling upon an emergency reserve of the dead!</p>
                                                <p style="margin: 4px 0 0 0; font-size: 0.9em; color: #d8b4fe;">Up to 20 thralls emerge from the grave.</p>
                                              </div>`
                                });

                                let currentSpawnIndex = 0;
                                const maxSpawns = 20;

                                ui.notifications.info(`Click to place Thrall ${currentSpawnIndex + 1} of ${maxSpawns}. Right-click to stop early.`);
                                document.body.style.cursor = "crosshair";
                                canvas.app.view.style.cursor = "crosshair";

                                const gridSize = canvas.grid.size;
                                const ghost = new PIXI.Graphics();
                                ghost.beginFill(0x9333ea, 0.35);
                                ghost.lineStyle(2, 0x7e22ce, 0.9);
                                ghost.drawRect(0, 0, gridSize, gridSize);
                                ghost.endFill();
                                ghost.zIndex = 1000;
                                ghost.position.set(-1000, -1000);
                                canvas.tokens.addChild(ghost);

                                const updateGhost = (evt) => {
                                    const pos = evt.data.getLocalPosition(canvas.app.stage);
                                    const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                                    ghost.position.set(snapped.x, snapped.y);
                                };

                                canvas.stage.on("pointermove", updateGhost);

                                const cleanUp = () => {
                                    document.body.style.cursor = "";
                                    canvas.app.view.style.cursor = "";
                                    canvas.stage.off("pointermove", updateGhost);
                                    ghost.destroy();
                                    if (currentSpawnIndex > 0) {
                                        ui.notifications.info(`Instant Army deployed ${currentSpawnIndex} thrall(s).`);
                                    }
                                   
                                    this.render({ force: false });
                                };

                                const interactionHandler = async (evt) => {
                                    if (evt.data.button !== 0 && evt.data.button !== 2) {
                                        canvas.stage.once("pointerdown", interactionHandler);
                                        return;
                                    }

                                    if (evt.data.button === 2) {
                                        cleanUp();
                                        return;
                                    }

                                    const pos = evt.data.getLocalPosition(canvas.app.stage);
                                    const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;

                                    const basePayload = await prepareThrallPayload(actor, presetId);
                                    if (!basePayload) { cleanUp(); return; }

                                    const finalPayload = foundry.utils.mergeObject(basePayload, {
                                        x: snapped.x,
                                        y: snapped.y,
                                        delta: { ownership: { [game.user.id]: 3 } }
                                    });

                                    currentSpawnIndex++;
                                    executeSpawn(finalPayload).catch(err => console.error(err));

                                    if (currentSpawnIndex < maxSpawns) {
                                        ui.notifications.info(`Place Thrall ${currentSpawnIndex + 1} of ${maxSpawns}. Right-click to stop.`);
                                        canvas.stage.once("pointerdown", interactionHandler);
                                    } else {
                                        cleanUp();
                                    }
                                };

                                canvas.stage.once("pointerdown", interactionHandler);
                            }
                        },
                        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                    },
                    default: "summon"
                }).render(true);
            });
        }
        const dmsBtn = html.querySelector(".dms-btn");
        if (dmsBtn) {
            dmsBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor) return;

                const currentFocus = actor.system?.resources?.focus?.value || 0;
                if (currentFocus === 0) return ui.notifications.warn("You have no Focus Points to cast Dread Mosquito Storm!");

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
                if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) exactDC = actor.system.attributes.classDC.dc.value;

                let dmsSpell = actor.items.find(i => i.type === "spell" && i.name === "Dread Mosquito Storm");
                const spellSystemData = {
                    level: { value: 9 },
                    traits: { value: ["necromancer", "uncommon", "concentrate", "disease", "focus", "manipulate", "void"] },
                    tradition: { value: "divine" },
                    area: { type: "burst", value: 60 },
                    defense: { save: { statistic: "fortitude", basic: false, dc: { value: exactDC } } },
                    damage: { "0": { formula: "1", type: "void" } }
                };

                if (!dmsSpell) {
                    const spellData = { name: "Dread Mosquito Storm", type: "spell", img: "icons/creatures/invertebrates/wasp-swarm-movement-purple.webp", system: spellSystemData };
                    const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                    dmsSpell = created[0];
                } else {
                    await dmsSpell.update({ system: spellSystemData });
                }
               
                await dmsSpell.update({ "system.damage": { "0": { formula: "1", type: "void" } } });
                await dmsSpell.setFlag("aoe-easy-resolve", "rules", [
                    { context: "tokenEnter", outcome: "always", promptSave: true, alliance: "all" },
                    { context: "tokenTurnStart", outcome: "always", promptSave: true, alliance: "all" }
                ]);
                await dmsSpell.setFlag("aoe-easy-resolve", "useCustomDamage", false); 
                await dmsSpell.setFlag("aoe-easy-resolve", "useOverride", true);
                await dmsSpell.setFlag("aoe-easy-resolve", "saveDC", exactDC);
                await dmsSpell.setFlag("aoe-easy-resolve", "saveType", "fortitude");

                await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                ui.notifications.info("Click the canvas within 120 feet to release the swarm. Right-click to cancel.");
                document.body.style.cursor = "crosshair";
                canvas.app.view.style.cursor = "crosshair";

                const gridSize = canvas.scene.grid.size;
                const gridDist = canvas.scene.grid.distance;
                const radiusPixels = (60 / gridDist) * gridSize;

                const ghost = new PIXI.Graphics();
                ghost.beginFill(0x111111, 0.4);
                ghost.lineStyle(2, 0x990000, 0.8);
                ghost.drawCircle(0, 0, radiusPixels);
                ghost.endFill();
                ghost.zIndex = 1000;
                ghost.position.set(-1000, -1000);
                canvas.tokens.addChild(ghost);

                const updateGhost = (evt) => {
                    const pos = evt.data.getLocalPosition(canvas.app.stage);
                    const snapped = canvas.grid.getCenterPoint ? canvas.grid.getCenterPoint(pos) : pos;
                    ghost.position.set(snapped.x, snapped.y);
                };

                canvas.stage.on("pointermove", updateGhost);

                const cleanUp = () => {
                    document.body.style.cursor = "";
                    canvas.app.view.style.cursor = "";
                    canvas.stage.off("pointermove", updateGhost);
                    ghost.destroy();
                };

                const interactionHandler = async (evt) => {
                    if (evt.data.button !== 0 && evt.data.button !== 2) {
                        canvas.stage.once("pointerdown", interactionHandler);
                        return;
                    }
                    if (evt.data.button === 2) {
                        ui.notifications.info("Swarm placement cancelled.");
                        cleanUp();
                        return;
                    }

                    const pos = evt.data.getLocalPosition(canvas.app.stage);
                    const snapped = canvas.grid.getCenterPoint ? canvas.grid.getCenterPoint(pos) : pos;
                    cleanUp();

                   
                    const validTargets = canvas.tokens.placeables.filter(t => {
                        if (!t.actor || (t.actor.system?.attributes?.hp?.value || 0) <= 0) return false;
                        const targetCenter = t.center || { x: t.x, y: t.y };
                        const dx = Math.abs(snapped.x - targetCenter.x);
                        const dy = Math.abs(snapped.y - targetCenter.y);
                        const dist = (Math.max(dx, dy) / canvas.grid.size) * gridDist;
                        return dist <= 60; 
                    });

                    const targetsData = {};
                    validTargets.forEach(t => {
                        targetsData[t.document.id] = {
                            id: t.document.id, name: t.document.name, img: t.document.texture?.src || t.actor?.img,
                            hasRolled: false, rollTotal: null, degreeOfSuccess: null,
                            isHealing: false, isImmune: false, hasApplied: false
                        };
                    });

                    const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
                    const htmlContent = await renderTemplate(templatePath, {
                        targets: Object.values(targetsData), itemName: "Dread Mosquito Storm", saveType: "Fortitude", saveDC: exactDC
                    });

                    
                    const regionId = foundry.utils.randomID();
                    const behaviorSource = `
                        if (!event.region.getFlag("necromancer-thrall-helper", "isArmed")) return;
                        if (game.modules.get('aoe-easy-resolve')?.api?.handleRegionEvent) { 
                            game.modules.get('aoe-easy-resolve').api.handleRegionEvent(event, '${dmsSpell.uuid}'); 
                        }
                    `;

                    const regionData = {
                        name: `Dread Mosquito Storm`,
                        color: "#111111",
                        shapes: [{ type: "ellipse", hole: false, x: snapped.x, y: snapped.y, radiusX: radiusPixels, radiusY: radiusPixels, rotation: 0 }],
                        elevation: { bottom: -1000, top: 1000 },
                        behaviors: [{
                            name: "AoE Easy Resolve Controller",
                            type: "executeScript",
                            system: {
                                events: ["tokenTurnStart", "tokenEnter"],
                                source: behaviorSource
                            }
                        }],
                        flags: { 
                            "necromancer-thrall-helper": { stormRegionId: regionId, isArmed: false },
                            "aoe-easy-resolve": { 
                                isAoERegion: true, originItemUuid: dmsSpell.uuid, saveDC: exactDC,
                                persistentRules: [
                                    { context: "tokenEnter", outcome: "always", promptSave: true, alliance: "all" },
                                    { context: "tokenTurnStart", outcome: "always", promptSave: true, alliance: "all" }
                                ]
                            }
                        }
                    };

                    const drawingData = {
                        author: game.user.id, shape: { type: "e", width: radiusPixels * 2, height: radiusPixels * 2 },
                        x: snapped.x - radiusPixels, y: snapped.y - radiusPixels,
                        fillType: 1, fillColor: "#111111", fillAlpha: 0.3,
                        strokeWidth: 3, strokeColor: "#990000", strokeAlpha: 0.8,
                        flags: { "necromancer-thrall-helper": { stormRegionId: regionId } }
                    };

                    const [createdRegion] = await executeHazard(regionData, drawingData);
                    await canvas.scene.createEmbeddedDocuments("Drawing", [drawingData]);
                    
                   
                    setTimeout(async () => {
                        if (canvas.scene && canvas.scene.regions.has(createdRegion.id)) {
                            await createdRegion.setFlag("necromancer-thrall-helper", "isArmed", true);
                        }
                    }, 2000);

                    this.render({ force: false });

                    
                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor: actor }),
                        flavor: `<strong>Dread Mosquito Storm</strong>`,
                        content: `
                            <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #990000;">
                                <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> releases a plague of terrible undead mosquitoes in a massive 60-foot burst!</p>
                                <p style="margin: 0; font-size: 0.95em;">Creatures that enter or start their turn in the storm take <b>1 void damage</b> and must attempt a <b>DC ${exactDC} Fortitude save</b> against <b>Necrotic Blood</b>.</p>
                                <hr>${htmlContent}
                            </div>
                        `,
                        flags: {
                            "aoe-easy-resolve": {
                                templateId: null, documentName: "ManualTarget", itemUuid: dmsSpell.uuid,
                                itemName: "Dread Mosquito Storm", saveType: "fortitude", saveDC: exactDC,
                                isBasicSave: false, targets: targetsData, hazardDamage: null, isReactive: false, originMessageId: null
                            }
                        }
                    });
                };

                canvas.stage.once("pointerdown", interactionHandler);
            });
        }

        const dismissStormBtn = html.querySelector(".dismiss-storm-btn");
        if (dismissStormBtn) {
            dismissStormBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                if (!canvas.scene) return;
                const storms = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "stormRegionId"));
                for (const s of storms) {
                    const sId = s.getFlag("necromancer-thrall-helper", "stormRegionId");
                    const drawing = canvas.scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "stormRegionId") === sId);
                    if (drawing) await drawing.delete();
                    await s.delete();
                }
                ui.notifications.info("Dread Mosquito Storm dismissed.");
                this.render({ force: false });
            });
        }
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
                            rules: [{ key: "Aura", radius: 10, colors: { border: "#ffd700", fill: "#ffd700" } }]
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
                            rules: [{ key: "Aura", radius: 10, colors: { border: "#8a2be2", fill: "#8a2be2" } }]
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
        const dismissGoreBtn = html.querySelector(".dismiss-gore-btn");
        if (dismissGoreBtn) {
            dismissGoreBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                if (!canvas.scene) return;
                const gores = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "goreRegionId"));
                for (const g of gores) {
                    const gId = g.getFlag("necromancer-thrall-helper", "goreRegionId");
                    const drawing = canvas.scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "goreRegionId") === gId);
                    if (drawing) await drawing.delete();
                    await g.delete();
                }
                ui.notifications.info("Blossoming Gore dismissed.");
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
        const bodyShieldBtn = html.querySelector(".body-shield-btn");
        if (bodyShieldBtn) {
            bodyShieldBtn.addEventListener("click", async (e) => {
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
                    return dist <= 5; 
                });

                if (eligibleThralls.length === 0) return ui.notifications.warn("No eligible thralls within 5 feet to use as a meat shield.");

                let optionsHtml = "";
                eligibleThralls.forEach(t => {
                    optionsHtml += `<option value="${t.id}">${t.name}</option>`;
                });

                new Dialog({
                    title: "Body Shield Reaction",
                    content: `<p>Select an adjacent thrall to throw into the attack's path:</p><form><div class="form-group"><select id="shield-thrall">${optionsHtml}</select></div></form>`,
                    buttons: {
                        shield: {
                            icon: '<i class="fas fa-shield-virus"></i>',
                            label: "Sacrifice",
                            callback: async (dialogHtml) => {
                                const selectedId = dialogHtml.find("#shield-thrall").val();
                                const tokenDoc = canvas.scene.tokens.get(selectedId);
                                if (!tokenDoc) return;

                                const necroLevel = actor.level || 1;
                                const currentAC = actor.system?.attributes?.ac?.value || 10;
                                const boostedAC = currentAC + 2;

                                const effectData = {
                                    name: "Effect: Body Shield",
                                    type: "effect",
                                    img: "icons/magic/defensive/shield-barrier-glowing-triangle-magenta.webp",
                                    system: {
                                        level: { value: necroLevel },
                                        duration: { value: 1, unit: "rounds", expiry: "turn-start" },
                                        description: { value: "You threw a thrall in the way! +2 circumstance bonus to AC, and resistance to all damage equal to your level against the triggering attack." },
                                        rules: [
                                            { key: "FlatModifier", selector: "ac", value: 2, type: "circumstance" },
                                            { key: "Resistance", type: "all-damage", value: necroLevel }
                                        ]
                                    }
                                };

                                await actor.createEmbeddedDocuments("Item", [effectData]);
                                await executeDelete(tokenDoc.id);

                                await ChatMessage.create({
                                    speaker: ChatMessage.getSpeaker({ actor: actor }),
                                    flavor: `<strong>Body Shield Reaction!</strong>`,
                                    content: `
                                        <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #b58900;">
                                            <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> coldly yanks <b>${tokenDoc.name}</b> into the path of an incoming attack, obliterating them instantly!</p>
                                            <p style="margin: 0; font-size: 1.1em;">Current AC: <b><span style="color: #4ade80;">${boostedAC}</span></b> <i>(+2 circ)</i></p>
                                            <p style="margin: 5px 0 0 0;">If the attack still hits, ${actor.name} gains <b>Resistance ${necroLevel} to all damage</b>. <i>(Expires at the start of your next turn)</i></p>
                                        </div>
                                    `
                                });
                            }
                        },
                        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                    },
                    default: "shield"
                }).render(true);
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
                                
                                
                                const dbUpdates = { "system.attributes.hp.value": currentHP + actualHealed };
                                
                                const hasPowerHungry = actor.items.some(i => i.name === "Power Hungry" || (i.system?.slug && i.system.slug.includes("power-hungry")));
                                let powerHungryTriggered = false;

                                if (selectedIds.length === 3 && hasPowerHungry) {
                                    const maxFocus = actor.system.resources?.focus?.max || 0;
                                    if (maxFocus > 0) {
                                        dbUpdates["system.resources.focus.value"] = maxFocus;
                                        powerHungryTriggered = true;
                                    }
                                }

                                await actor.update(dbUpdates);

                                const tokensToDelete = selectedIds.map(id => canvas.scene.tokens.get(id));
                                const names = tokensToDelete.map(t => t.name).join(", ");
                                for (const tDoc of tokensToDelete) await tDoc.delete();

                                if (actualHealed > 0 && canvas.ready && necroToken) {
                                    canvas.interface.createScrollingText(necroToken.center, `+${actualHealed} HP`, { anchor: CONST.TEXT_ANCHOR_POINTS.TOP, fill: 0x4ade80, direction: CONST.TEXT_ANCHOR_POINTS.UP });
                                }

                                let chatContent = `<p><b>${actor.name}</b> draws the life force from their creations, destroying <b>${names}</b> to recover <b>${actualHealed} HP</b>.</p>`;

                                if (powerHungryTriggered) {
                                    chatContent += `<p style="color: #c084fc; font-weight: bold; margin-top: 4px;">Power Hungry: Focus Pool fully restored!</p>`;
                                }

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

                const rollNativeStrike = async (eventObj, isKamikaze = false, chargeDice = 0, passedSpellRank = 0) => {
                    const mapPenalty = this.currentMap !== undefined ? this.currentMap : 0;
                    let variantIndex = 0;
                    if (mapPenalty === -5) variantIndex = 1;
                    if (mapPenalty === -10) variantIndex = 2;

                    const isNightmare = tokenDoc.getFlag("necromancer-thrall-helper", "isRecurringNightmare");
                    const isLancer = tokenDoc.getFlag("necromancer-thrall-helper", "isSkeletalLancer");
                    const isGraveyard = tokenDoc.getFlag("necromancer-thrall-helper", "isLivingGraveyard") || tokenDoc.name.includes("Living Graveyard");
                    const isPerfected = tokenDoc.getFlag("necromancer-thrall-helper", "isPerfectedThrall") || tokenDoc.name.includes("Perfected");
                    const spellRank = passedSpellRank || Math.max(1, Math.ceil(necroLevel / 2));

                    let damageType = "bludgeoning";
                    
                    // --- UNIVERSAL DAMAGE TOGGLE OVERRIDE ---
                    if (this.spiritStates && this.spiritStates[tokenId]) {
                        damageType = this.spiritStates[tokenId];
                    }
                    
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
                        const spellcasting = actor.spellcasting?.filter(s => s.statistic)?.sort((a,b) => b.statistic.check.mod - a.statistic.check.mod)[0];
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
                        ui.notifications.warn(`Execution failed. ${tokenDoc.name} could not draw its weapon (Network Timeout).`);
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
                };
                switch (action) {
                    case "reanimate-foe": {
                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                        if (currentFocus === 0) {
                            ui.notifications.warn("You have no Focus Points to cast Reanimate Foe!");
                            break;
                        }

                        const loreSkill = Object.values(actor.skills).find(s => s.slug?.includes("undead-lore") || s.label.toLowerCase().includes("undead lore"));
                        if (!loreSkill) {
                            ui.notifications.warn("You lack the Undead Lore skill required to weave this magic.");
                            break;
                        }

                        const targets = Array.from(game.user.targets);
                        if (targets.length !== 1) {
                            ui.notifications.warn("You must target exactly one dead enemy corpse on the canvas.");
                            break;
                        }
                        
                        const corpseDoc = targets[0].document;
                        const corpseActor = targets[0].actor;

                        if ((corpseActor.system.attributes.hp?.value || 0) > 0) {
                            ui.notifications.warn("The target is still breathing. It must be dead (0 HP).");
                            break;
                        }

                        const necroTokens = actor.getActiveTokens();
                        if (necroTokens.length === 0) {
                            ui.notifications.warn("Necromancer token not found on the canvas.");
                            break;
                        }
                        const necroToken = necroTokens[0];

                    
                        let distToNecro = 999;
                        if (typeof tokenDoc.object?.distanceTo === "function") {
                            distToNecro = tokenDoc.object.distanceTo(necroToken);
                        } else {
                            const dx = Math.abs(tokenDoc.x - necroToken.x);
                            const dy = Math.abs(tokenDoc.y - necroToken.y);
                            distToNecro = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                        }

                        if (distToNecro > 30) {
                            ui.notifications.warn(`${tokenDoc.name} is too far from you (must be within 30 feet).`);
                            break;
                        }

                      
                        let distToCorpse = 999;
                        if (typeof tokenDoc.object?.distanceTo === "function") {
                            distToCorpse = tokenDoc.object.distanceTo(targets[0]);
                        } else {
                            const dx = Math.abs(tokenDoc.x - corpseDoc.x);
                            const dy = Math.abs(tokenDoc.y - corpseDoc.y);
                            distToCorpse = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                        }

                        if (distToCorpse > 30) {
                            ui.notifications.warn(`${tokenDoc.name} is too far from the corpse (must be within 30 feet of it).`);
                            break;
                        }

                        const corpseLevel = corpseActor.level || 1;
                        const standardDCs = [14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50];
                        const exactDC = corpseLevel < 0 ? 14 : (corpseLevel > 25 ? 50 : standardDCs[corpseLevel]);

                        new Dialog({
                            title: "Reanimate Foe",
                            content: `<p>Launch <b>${tokenDoc.name}</b> into the corpse of <b>${corpseDoc.name}</b>?</p>
                                      <p>Rolling <b>Undead Lore</b> against DC ${exactDC} (Level ${corpseLevel}).</p>`,
                            buttons: {
                                cast: {
                                    icon: '<i class="fas fa-bolt"></i>',
                                    label: "Launch",
                                    callback: async () => {
                                        await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                                        const roll = await new Roll(`1d20 + ${loreSkill.mod}`).evaluate({async: true});
                                        const total = roll.total;
                                        let dosNum = total >= exactDC + 10 ? 3 : total >= exactDC ? 2 : total <= exactDC - 10 ? 0 : 1;
                                        if (roll.dice[0].results[0].result === 20) dosNum = Math.min(3, dosNum + 1);
                                        if (roll.dice[0].results[0].result === 1) dosNum = Math.max(0, dosNum - 1);

                                        const dosMap = ["Critical Failure", "Failure", "Success", "Critical Success"];
                                        const dosColors = ["#ef4444", "#eab308", "#3b82f6", "#22c55e"];
                                        
                                        let chatContent = `
                                            <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid ${dosColors[dosNum]};">
                                                <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> violently launches <b>${tokenDoc.name}</b> into the corpse of <b>${corpseDoc.name}</b>!</p>
                                                <p style="margin: 0; font-size: 1.1em;">Undead Lore: <b>${total}</b> vs DC ${exactDC}</p>
                                                <p style="margin: 0; font-weight: bold; color: ${dosColors[dosNum]};">${dosMap[dosNum]}!</p>
                                        `;

                                        await executeDelete(tokenDoc.id);

                                        if (dosNum === 0) {
                                            await actor.update({ "system.resources.focus.value": currentFocus });
                                            chatContent += `<p style="margin: 5px 0 0 0;">The ritual violently rejects the corpse. A basic thrall spawns in its place, and the Focus Point is refunded.</p></div>`;
                                            
                                            const presets = typeof getThrallPresets === "function" ? getThrallPresets(actor) : [];
                                            const presetId = presets.length > 0 ? presets[0].id : "default";
                                            const basePayload = await prepareThrallPayload(actor, presetId);
                                            if (basePayload) {
                                                const finalPayload = foundry.utils.mergeObject(basePayload, {
                                                    x: corpseDoc.x, y: corpseDoc.y, delta: { ownership: { [game.user.id]: 3 } }
                                                });
                                                executeSpawn(finalPayload);
                                            }
                                        } else {
                                            const decayAmount = dosNum === 1 ? 50 : 15;
                                            const isFailure = dosNum === 1;

                                            chatContent += `
                                                <p style="margin: 5px 0 0 0;">The corpse violently jerks back to un-life! It has 100 HP and decays <b>${decayAmount} HP</b> each turn.</p>
                                                <p style="margin: 5px 0 0 0; font-size: 0.85em; font-style: italic; color: #aaa;">Special abilities and Strike side-effects are disabled by the ritual.</p>
                                            </div>`;

                                            ui.notifications.info("Click an adjacent space to spawn the Reanimated Foe.");
                                            document.body.style.cursor = "crosshair";
                                            canvas.app.view.style.cursor = "crosshair";

                                            const ghost = new PIXI.Graphics();
                                            ghost.beginFill(0x9900ff, 0.4);
                                            ghost.lineStyle(2, 0x6600cc, 0.8);
                                            ghost.drawRect(0, 0, (corpseDoc.width || 1) * canvas.grid.size, (corpseDoc.height || 1) * canvas.grid.size);
                                            ghost.endFill();
                                            ghost.zIndex = 1000;
                                            canvas.tokens.addChild(ghost);

                                            const updateGhost = (evt) => {
                                                const pos = evt.data.getLocalPosition(canvas.app.stage);
                                                const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                                                ghost.position.set(snapped.x, snapped.y);
                                            };

                                            canvas.stage.on("pointermove", updateGhost);

                                            const cleanUp = () => {
                                                document.body.style.cursor = "";
                                                canvas.app.view.style.cursor = "";
                                                canvas.stage.off("pointermove", updateGhost);
                                                ghost.destroy();
                                            };

                                            canvas.stage.once("pointerdown", async (evt) => {
                                                if (evt.data.button !== 0) { cleanUp(); return; }
                                                const pos = evt.data.getLocalPosition(canvas.app.stage);
                                                const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                                                cleanUp();

                                                let payload = corpseDoc.toObject();
                                                payload.actorLink = false; 
                                                payload.x = snapped.x;
                                                payload.y = snapped.y;
                                                payload.name = `Reanimated ${corpseDoc.name}`;

                                         
                                                const ownerIds = Object.keys(actor.ownership).filter(k => actor.ownership[k] === 3 && k !== "default");
                                                const newOwnership = { default: 0 };
                                                ownerIds.forEach(id => newOwnership[id] = 3);
                                                
                                                payload.delta = payload.delta || {};
                                                payload.delta.ownership = newOwnership;

                                             
                                                payload.flags = payload.flags || {};
                                                payload.flags["necromancer-thrall-helper"] = { 
                                                    masterId: actor.id,
                                                    isReanimatedFoe: true 
                                                };

                                                const [newTokenDoc] = await canvas.scene.createEmbeddedDocuments("Token", [payload]);
                                                if (newTokenDoc && newTokenDoc.actor) {
                                                    const newActor = newTokenDoc.actor;
                                       
                                                    await newActor.update({
                                                        "system.attributes.immunities": [],
                                                        "system.attributes.weaknesses": [],
                                                        "system.attributes.resistances": [],
                                                        "system.details.alliance": "party"
                                                    });

                                                    const effectData = {
                                                        name: "Reanimated Foe",
                                                        type: "effect",
                                                        img: "icons/magic/death/undead-zombie-glowing-green.webp",
                                                        system: {
                                                            duration: { value: 1, unit: "minutes", expiry: "turn-start" },
                                                            description: { value: `<b>Decay:</b> Loses ${decayAmount} HP at the end of its turn. Cannot be healed.<br>${isFailure ? "<b>Failure:</b> Strikes deal half damage." : ""}` },
                                                            rules: [
                                                                { key: "Immunity", type: "healing" },
                                                                { key: "ActiveEffectLike", mode: "override", path: "system.attributes.hp.max", value: 100 }
                                                            ]
                                                        },
                                                        flags: {
                                                            "necromancer-thrall-helper": {
                                                                isReanimatedFoe: true,
                                                                decayAmount: decayAmount,
                                                                masterId: actor.id
                                                            }
                                                        }
                                                    };
                                                    
                                                    await newActor.createEmbeddedDocuments("Item", [effectData]);

                                                   for (let i = 0; i < 20; i++) {
                                                    if (newActor.system.attributes.hp.max === 100) {
                                                        await newActor.update({
                                                            "system.attributes.hp.value": 100,
                                                            "system.attributes.hp.temp": 0
                                                        });
                                                        break;
                                                    }
                                                    await new Promise(resolve => setTimeout(resolve, 100));
                                                }
                                                }
                                            });
                                        }

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            flavor: `<strong>Reanimate Foe</strong>`,
                                            content: chatContent
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "cast"
                        }).render(true);
                        break;
                    }
                    case "calcification": {
                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                        if (currentFocus === 0) {
                            ui.notifications.warn("You lack the Focus Points to cast Calcification.");
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
                                ui.notifications.warn("You must be within 30 feet of the thrall to catalyze Calcification.");
                                break;
                            }
                        }

                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
                        const gridDist = canvas.scene?.grid?.distance || 5;
                        const gridSize = canvas.scene?.grid?.size || 100;
                        const rangePixels = (60 / gridDist) * gridSize;

                        const validTargets = Array.from(game.user.targets).filter(t => {
                            const dist = Math.hypot(t.center.x - tokenCenter.x, t.center.y - tokenCenter.y);
                            return dist <= rangePixels;
                        });

                        if (validTargets.length !== 1) {
                            ui.notifications.warn("Calcification requires exactly one target selected on the canvas within 60 feet of the thrall.");
                            break;
                        }

                        const targetToken = validTargets[0];

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
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) exactDC = actor.system.attributes.classDC.dc.value;

                        const spellRank = Math.max(9, Math.ceil((actor.level || 1) / 2));

                        let calcSpell = actor.items.find(i => i.type === "spell" && i.name === "Calcification");
                        const spellSystemData = {
                            level: { value: spellRank },
                            traits: { value: ["necromancer", "uncommon", "concentrate", "focus", "manipulate"] },
                            tradition: { value: "divine" },
                            defense: { save: { statistic: "fortitude", basic: false, dc: { value: exactDC } } }
                        };

                        if (!calcSpell) {
                            const spellData = { name: "Calcification", type: "spell", img: "icons/magic/death/skeleton-skull-soul-blue.webp", system: spellSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            calcSpell = created[0];
                        } else {
                            await calcSpell.update({ system: spellSystemData });
                        }

                        new Dialog({
                            title: "Calcification",
                            content: `<p>Destroy <b>${tokenDoc.name}</b> to turn it into a cloud of bone dust that calcifies <b>${targetToken.name}</b>?</p>`,
                            buttons: {
                                cast: {
                                    icon: '<i class="fas fa-bone"></i>',
                                    label: "Calcify",
                                    callback: async () => {
                                        await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        
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
                                            itemName: "Calcification",
                                            saveType: "Fortitude",
                                            saveDC: exactDC
                                        });

                                        await executeDelete(tokenDoc.id);

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            flavor: `<strong>Calcification</strong>`,
                                            content: `
                                                <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #e2e8f0;">
                                                    <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> destroys <b>${tokenDoc.name}</b>, transforming them into a cloud of invasive bone dust that swarms <b>${targetToken.name}</b>!</p>
                                                    <p style="margin: 0; font-size: 0.95em;">They must attempt a <b>DC ${exactDC} Fortitude save</b> or begin turning into a statue.</p>
                                                    <hr>${htmlContent}
                                                </div>
                                            `,
                                            flags: {
                                                "aoe-easy-resolve": {
                                                    templateId: null, documentName: "ManualTarget", itemUuid: calcSpell.uuid,
                                                    itemName: "Calcification", saveType: "fortitude", saveDC: exactDC,
                                                    isBasicSave: false, targets: targetsData, hazardDamage: null, isReactive: false, originMessageId: null
                                                }
                                            }
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "cast"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "temporary-possession": {
                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                        if (currentFocus === 0) {
                            ui.notifications.warn("You lack the Focus Points to attempt a Temporary Possession.");
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
                                ui.notifications.warn("You must be within 30 feet of the thrall to catalyze the possession.");
                                break;
                            }
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
                            ui.notifications.warn("Temporary Possession requires exactly one target selected on the canvas within 15 feet of the thrall.");
                            break;
                        }

                        const targetToken = validTargets[0];

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
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) exactDC = actor.system.attributes.classDC.dc.value;

                        const spellRank = Math.max(8, Math.ceil((actor.level || 1) / 2));

                        let tpSpell = actor.items.find(i => i.type === "spell" && i.name === "Temporary Possession");
                        const spellSystemData = {
                            level: { value: spellRank },
                            traits: { value: ["necromancer", "uncommon", "concentrate", "focus", "incapacitation", "manipulate", "possession"] },
                            tradition: { value: "divine" },
                            defense: { save: { statistic: "will", basic: false, dc: { value: exactDC } } }
                        };

                        if (!tpSpell) {
                            const spellData = { name: "Temporary Possession", type: "spell", img: "icons/magic/control/control-influence-puppet-purple.webp", system: spellSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            tpSpell = created[0];
                        } else {
                            await tpSpell.update({ system: spellSystemData });
                        }

                        new Dialog({
                            title: "Temporary Possession",
                            content: `<p>Destroy <b>${tokenDoc.name}</b> to force its animus into <b>${targetToken.name}</b>?</p>`,
                            buttons: {
                                possess: {
                                    icon: '<i class="fas fa-ghost"></i>',
                                    label: "Possess",
                                    callback: async () => {
                                        await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        
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
                                            itemName: "Temporary Possession",
                                            saveType: "Will",
                                            saveDC: exactDC
                                        });

                                        await executeDelete(tokenDoc.id);

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            flavor: `<strong>Temporary Possession</strong>`,
                                            content: `
                                                <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #8a2be2;">
                                                    <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> destroys <b>${tokenDoc.name}</b>, forcing its volatile animus into the mind of <b>${targetToken.name}</b>!</p>
                                                    <p style="margin: 0; font-size: 0.95em;">They must attempt a <b>DC ${exactDC} Will save</b>. (Incapacitation trait applies).</p>
                                                    <hr>${htmlContent}
                                                </div>
                                            `,
                                            flags: {
                                                "aoe-easy-resolve": {
                                                    templateId: null,
                                                    documentName: "ManualTarget",
                                                    itemUuid: tpSpell.uuid,
                                                    itemName: "Temporary Possession",
                                                    saveType: "will",
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
                            default: "possess"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "flesh-tsunami": {
                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                        if (currentFocus === 0) {
                            ui.notifications.warn("You have no Focus Points to cast Flesh Tsunami!");
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
                                ui.notifications.warn("You must be within 30 feet of the thrall to cast Flesh Tsunami.");
                                break;
                            }
                        }

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
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) exactDC = actor.system.attributes.classDC.dc.value;

                        let tsunamiSpell = actor.items.find(i => i.type === "spell" && i.name === "Flesh Tsunami");
                        const spellSystemData = {
                            level: { value: 8 },
                            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                            tradition: { value: "divine" },
                            area: { type: "cone", value: 60 },
                            defense: { save: { statistic: "fortitude", basic: false, dc: { value: exactDC } } }
                        };

                        if (!tsunamiSpell) {
                            const spellData = { name: "Flesh Tsunami", type: "spell", img: "icons/magic/water/wave-water-red.webp", system: spellSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            tsunamiSpell = created[0];
                        } else {
                            await tsunamiSpell.update({ system: spellSystemData });
                        }

                        
                        await tsunamiSpell.update({ "system.damage": {} });
                        
                        await tsunamiSpell.setFlag("aoe-easy-resolve", "useOverride", true);
                        await tsunamiSpell.setFlag("aoe-easy-resolve", "saveDC", exactDC);
                        await tsunamiSpell.setFlag("aoe-easy-resolve", "saveType", "fortitude");
                       
                        await tsunamiSpell.setFlag("aoe-easy-resolve", "allyBaseEffect", "immune"); 
                        await tsunamiSpell.setFlag("aoe-easy-resolve", "enemyBaseEffect", "standard");
                        await tsunamiSpell.setFlag("necromancer-thrall-helper", "limbsActivated", false);
                        
                      
                        await tsunamiSpell.setFlag("aoe-easy-resolve", "hazardDuration", 10);
                        await tsunamiSpell.setFlag("aoe-easy-resolve", "rules", [
                            { context: "tokenEnter", outcome: "always", promptSave: false, alliance: "all" }
                        ]);

                        new Dialog({
                            title: "Flesh Tsunami",
                            content: `<p>Melt <b>${tokenDoc.name}</b> into a 60-foot cone of Greater Difficult Terrain?</p>`,
                            buttons: {
                                fire: {
                                    icon: '<i class="fas fa-water"></i>',
                                    label: "Melt & Flow",
                                    callback: async () => {
                                        const focusToSpend = actor.system?.resources?.focus?.value || 0;
                                        if (focusToSpend > 0) await actor.update({ "system.resources.focus.value": focusToSpend - 1 });
                                        
                                        const gridSize = canvas.scene.grid.size;
                                        const originX = tokenDoc.x;
                                        const originY = tokenDoc.y;
                                        const tWidth = tokenDoc.width * gridSize;
                                        const tHeight = tokenDoc.height * gridSize;

                                        await executeDelete(tokenDoc.id);
                                        
                                        const [marker] = await canvas.scene.createEmbeddedDocuments("Drawing", [{
                                            author: game.user.id,
                                            shape: { type: "e", width: tWidth, height: tHeight },
                                            x: originX, y: originY,
                                            fillType: 1, fillColor: "#990000", fillAlpha: 0.5,
                                            strokeWidth: 2, strokeColor: "#ffffff",
                                            text: "GREATER DIFFICULT TERRAIN\n(Flesh Tsunami)", fontSize: 16, textColor: "#ffffff"
                                        }]);

                                        setTimeout(() => { if (canvas.scene && canvas.scene.drawings.has(marker.id)) globalThis.NecroThrallHelper.purgeGraphics(canvas.scene.id, { drawingIds: [marker.id] }); }, 20000);
                                        
                                        await tsunamiSpell.toMessage(e);
                                        ui.notifications.info("Draw your 60-foot cone starting from the marked origin point.");
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "fire"
                        }).render(true);
                        break;
                    }
                    case "Desperate Revival": {
                        let totalSiphonedDamage = 0;
                        const casterId = message.speaker?.actor;
                        const casterActor = game.actors.get(casterId) || canvas.tokens.controlled[0]?.actor;
                        const dbUpdates = {};
            
                        for (const [tokenId, targetData] of Object.entries(targets)) {
                            if (targetData.hasApplied && !targetData._desperateRevivalProcessed) {
                                dbUpdates[`flags.aoe-easy-resolve.targets.${tokenId}._desperateRevivalProcessed`] = true;
            
                                const targetToken = canvas.tokens.get(tokenId);
                                if (!targetToken?.actor || targetData.isImmune) continue;
            
                                const dos = targetData.degreeOfSuccess;
                                if (!dos || dos === "criticalSuccess") continue;
            
                                const targetLevel = targetToken.actor.level || 1;
                                let damageAmount = 0;
            
                                if (dos === "success") damageAmount = Math.max(1, Math.floor(targetLevel / 2));
                                else if (dos === "failure") damageAmount = Math.max(1, targetLevel);
                                else if (dos === "criticalFailure") damageAmount = Math.max(2, targetLevel * 2);
            
                                const chosenType = message.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`) || "void";
                                const DamageRoll = CONFIG.Dice.rolls.find(r => r.name === "DamageRoll");
            
                                if (DamageRoll && damageAmount > 0) {
                                    const roll = await new DamageRoll(`${damageAmount}[${chosenType}]`).evaluate({async: true});
                                    
                                    await targetToken.actor.applyDamage({ damage: roll, token: targetToken.document });
                                    totalSiphonedDamage += damageAmount;
                                }
                            }
                        }
                        
                        if (Object.keys(dbUpdates).length > 0) {
                            await message.update(dbUpdates);
                        }
            
                        if (casterActor && totalSiphonedDamage > 0) {
                            const currentHP = casterActor.system.attributes.hp.value;
                            const maxHP = casterActor.system.attributes.hp.max;
                            const halfMaxHP = Math.floor(maxHP / 2);
                            const actualHealed = Math.min(halfMaxHP, totalSiphonedDamage, maxHP - currentHP);
            
                            if (actualHealed > 0) {
                                await casterActor.update({ "system.attributes.hp.value": currentHP + actualHealed });
            
                                const necroToken = casterActor.getActiveTokens()[0];
                                if (necroToken && canvas.ready) {
                                    canvas.interface.createScrollingText(necroToken.center, `+${actualHealed} HP`, {
                                        anchor: CONST.TEXT_ANCHOR_POINTS.TOP, fill: 0x4ade80, direction: CONST.TEXT_ANCHOR_POINTS.UP
                                    });
                                }
            
                                await ChatMessage.create({
                                    speaker: ChatMessage.getSpeaker({ actor: casterActor }),
                                    flavor: `<strong>Desperate Revival: Siphon Harvest</strong>`,
                                    content: `
                                        <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #4ade80;">
                                            <p style="margin: 0 0 4px 0;"><b>${casterActor.name}</b> siphons <b>${totalSiphonedDamage} total damage</b> from the surrounding life force!</p>
                                            <p style="margin: 0; font-weight: bold; color: #4ade80;">Regained ${actualHealed} Hit Points (Cap: ${halfMaxHP} HP).</p>
                                        </div>
                                    `
                                });
                            }
                        }
                        break;
                    }
                    case "amalgamate": {
                        const necroTokens = actor.getActiveTokens();
                        if (necroTokens.length === 0) {
                            ui.notifications.warn("No Necromancer token found on the canvas.");
                            break;
                        }
                        const necroToken = necroTokens[0];

                       
                        let distToNecro = 999;
                        if (typeof tokenDoc.object?.distanceTo === "function") {
                            distToNecro = tokenDoc.object.distanceTo(necroToken);
                        } else {
                            const dx = Math.abs(tokenDoc.x - necroToken.x);
                            const dy = Math.abs(tokenDoc.y - necroToken.y);
                            distToNecro = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                        }

                        if (distToNecro > 30) {
                            ui.notifications.warn(`${tokenDoc.name} is too far from you (must be within 30 feet).`);
                            break;
                        }

                        
                        const thrallCenter = tokenDoc.object?.center || { 
                            x: tokenDoc.x + ((canvas.grid.size * (tokenDoc.width || 1)) / 2), 
                            y: tokenDoc.y + ((canvas.grid.size * (tokenDoc.height || 1)) / 2) 
                        };

                        const eligibleThralls = canvas.tokens.placeables.filter(t => {
                            if (t.id === tokenDoc.id || !t.actor) return false;
                            
                            
                            const masterId = t.document.getFlag("necromancer-thrall-helper", "masterId") 
                                || t.actor.getFlag("necromancer-thrall-helper", "masterId");
                            if (masterId !== actor.id) return false;

                           
                            let adjDist = 999;
                            if (typeof tokenDoc.object?.distanceTo === "function") {
                                adjDist = tokenDoc.object.distanceTo(t);
                            } else {
                                const dx = Math.abs(thrallCenter.x - t.center.x);
                                const dy = Math.abs(thrallCenter.y - t.center.y);
                                adjDist = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                            }
                            if (adjDist > 5) return false;

                          
                            let necroDist = 999;
                            if (typeof necroToken.distanceTo === "function") {
                                necroDist = necroToken.distanceTo(t);
                            } else {
                                const dx = Math.abs(necroToken.center.x - t.center.x);
                                const dy = Math.abs(necroToken.center.y - t.center.y);
                                necroDist = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                            }
                            return necroDist <= 30;
                        });

                        if (eligibleThralls.length === 0) {
                            ui.notifications.warn(`There are no other adjacent thralls within 30 feet of you to fuse with ${tokenDoc.name}.`);
                            break;
                        }

                      
                        let optionsHtml = eligibleThralls.map(t => `<option value="${t.id}">${t.name}</option>`).join("");
                        const dialogContent = `
                            <form>
                                <p>Select an adjacent thrall to sacrifice and fuse into <b>${tokenDoc.name}</b>:</p>
                                <div class="form-group" style="margin-bottom: 8px;">
                                    <label style="font-weight: bold;">Secondary Thrall:</label>
                                    <div class="form-fields" style="margin-top: 4px;">
                                        <select id="amalgamate-target-select" style="width: 100%; padding: 4px;">${optionsHtml}</select>
                                    </div>
                                </div>
                            </form>
                        `;

                        new Dialog({
                            title: "Amalgamate Thralls",
                            content: dialogContent,
                            buttons: {
                                fuse: {
                                    icon: '<i class="fas fa-biohazard"></i>',
                                    label: "Amalgamate",
                                    callback: async ($html) => {
                                        const secondaryId = $html.find("#amalgamate-target-select").val();
                                        const secondaryToken = canvas.tokens.get(secondaryId);
                                        if (!secondaryToken) return;

                                        const secondaryName = secondaryToken.name;
                                        const masterLevel = actor.level || 1;

                                       
                                        await tokenDoc.update({
                                            name: `Amalgamation (${tokenDoc.name})`,
                                            width: 2,
                                            height: 2,
                                            "texture.scaleX": 1.25,
                                            "texture.scaleY": 1.25
                                        });

                                       
                                        const effectData = {
                                            name: "Effect: Amalgamation",
                                            type: "effect",
                                            img: "icons/magic/death/undead-zombie-glowing-green.webp",
                                            system: {
                                                slug: "effect-amalgamation",
                                                description: {
                                                    value: `Fused from two thralls. Large size with 10-foot reach, 25-foot Speed, and a +${masterLevel} status bonus to Strike damage.`
                                                },
                                                duration: { value: -1, unit: "unlimited" },
                                                rules: [
                                                    { key: "CreatureSize", value: "lg" },
                                                    { key: "BaseSpeed", selector: "land", value: 25 },
                                                    { key: "FlatModifier", selector: "strike-damage", value: masterLevel, type: "status", label: "Amalgamation Status Damage" },
                                                    { key: "AdjustStrike", mode: "upgrade", property: "weapon-traits", value: "reach" }
                                                ]
                                            }
                                        };

                                        if (tokenDoc.actor) {
                                            await tokenDoc.actor.createEmbeddedDocuments("Item", [effectData]);
                                        }

                                       
                                        await secondaryToken.document.delete();

                                        this.render({ force: false });

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            flavor: `<strong>Amalgamate!</strong>`,
                                            content: `
                                                <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #a855f7;">
                                                    <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> tears apart <b>${secondaryName}</b> and grafts its remains onto <b>${tokenDoc.name}</b>!</p>
                                                    <p style="margin: 0; font-size: 0.95em;">The thrall swells into a <b>Large Amalgamation</b> (Speed 25 ft, Reach 10 ft) with <b>+${masterLevel} status bonus to Strike damage</b>.</p>
                                                </div>
                                            `
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "fuse"
                        }).render(true);
                        break;
                    }
                    case "bind-heroic-spirit": {
                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                        if (currentFocus === 0) {
                            ui.notifications.warn("You have no Focus Points to cast Bind Heroic Spirit!");
                            break;
                        }

                        const necroTokens = actor.getActiveTokens();
                        if (necroTokens.length === 0) {
                            ui.notifications.warn("No Necromancer token found on the canvas.");
                            break;
                        }
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
                            ui.notifications.warn(`${tokenDoc.name} is too far away. They must be within 30 feet.`);
                            break;
                        }

                        const spellRank = Math.max(3, Math.ceil((actor.level || 1) / 2));
                        const buffValue = spellRank >= 6 ? 2 : 1;

                        new Dialog({
                            title: "Bind Heroic Spirit",
                            content: `<p>Sacrifice <b>${tokenDoc.name}</b> to channel an ancient warlord into your body?</p>`,
                            buttons: {
                                cast: {
                                    icon: '<i class="fas fa-ghost"></i>',
                                    label: "Bind Spirit",
                                    callback: async () => {
                                        await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                                        const effectData = {
                                            name: "Effect: Bind Heroic Spirit",
                                            type: "effect",
                                            img: "icons/magic/light/explosion-star-glow-blue-purple.webp",
                                            system: {
                                                level: { value: spellRank },
                                                duration: { value: 1, unit: "minutes", expiry: "turn-start" },
                                                description: { value: `You gain a +${buffValue} status bonus to attack rolls and saving throws. Whenever you critically hit a creature with a Strike, you can create a thrall adjacent to the target.` },
                                                rules: [
                                                    { key: "FlatModifier", selector: "attack", value: buffValue, type: "status" },
                                                    { key: "FlatModifier", selector: "saving-throw", value: buffValue, type: "status" },
                                                    { key: "RollOption", domain: "strike-damage", option: "heroic-spirit-active" }
                                                ]
                                            }
                                        };

                                        await actor.createEmbeddedDocuments("Item", [effectData]);
                                        await executeDelete(tokenDoc.id);

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            flavor: `<strong>Bind Heroic Spirit</strong>`,
                                            content: `
                                                <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #e6b800;">
                                                    <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> destroys <b>${tokenDoc.name}</b>, transforming their fading animus into a conduit for a heroic spirit!</p>
                                                    <p style="margin: 0; font-size: 1.1em; color: #4ade80;"><b>+${buffValue} Status Bonus to Attacks and Saves</b></p>
                                                    <p style="margin: 5px 0 0 0; font-size: 0.9em; font-style: italic;">If you critically hit a creature with a Strike, the heroic energy will inspire a new thrall to rise adjacent to them!</p>
                                                </div>
                                            `
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "cast"
                        }).render(true);
                        break;
                    }
                    case "conglomerate-charge": {
                        const originalTargets = Array.from(game.user.targets);
                        if (originalTargets.length === 0 || originalTargets.length > 2) {
                            ui.notifications.warn("Conglomerate Charge requires exactly 1 or 2 targets selected.");
                            break;
                        }

                        const gridDist = canvas.scene?.grid?.distance || 5;
                        const validTargets = originalTargets.filter(t => {
                            let dist = 999;
                            if (typeof tokenDoc.object?.distanceTo === "function") {
                                dist = tokenDoc.object.distanceTo(t);
                            } else {
                                const dx = Math.abs(tokenDoc.object?.center?.x - t.center.x);
                                const dy = Math.abs(tokenDoc.object?.center?.y - t.center.y);
                                dist = (Math.max(dx, dy) / canvas.grid.size) * gridDist;
                            }
                            return dist <= 10;
                        });

                        if (validTargets.length !== originalTargets.length) {
                            ui.notifications.warn("All targets for Conglomerate Charge must be within 10 feet of the thrall.");
                            break;
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

                            let existingWeapon = tokenDoc.actor.items.find(i => i.type === "melee" && i.name.includes("Thrall Strike"));
                            if (!existingWeapon) {
                                let attackMod = Math.floor(necroLevel * 1.5); 
                                const spellcasting = actor.spellcasting?.filter(s => s.statistic)?.sort((a,b) => b.statistic.check.mod - a.statistic.check.mod)[0];
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

                            const mapPenalty = this.currentMap !== undefined ? this.currentMap : 0;
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
                                ui.notifications.error(`${tokenDoc.name} could not draw its weapon (Network Timeout).`);
                                return;
                            }

 
                            const targetsData = {};
                            validTargets.forEach(t => {
                                targetsData[t.document.id] = {
                                    id: t.document.id, name: t.document.name, img: t.document.texture?.src || t.actor?.img,
                                    hasRolled: false, rollTotal: null, degreeOfSuccess: null,
                                    isHealing: false, isImmune: false, hasApplied: false
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
                                
                                await strike.variants[variantIndex].roll({ event: e });
                                
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

                            this.currentMap = -10;
                            this.render(false);

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
                                ui.notifications.info("Conglomerate Charge: All strikes missed. No Grab saves needed.");
                                return;
                            }

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
                            if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) exactDC = actor.system.attributes.classDC.dc.value;

                            const targetNames = validTargets.filter(t => !targetsData[t.document.id].isImmune).map(t => t.name).join(" and ");

                            let cgSpell = actor.items.find(i => i.type === "spell" && i.name === "Conglomerate Grab");
                            const spellSystemData = {
                                level: { value: spellRank },
                                traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                                tradition: { value: "divine" },
                                defense: { save: { statistic: "fortitude", basic: false, dc: { value: exactDC } } }
                            };

                            if (!cgSpell) {
                                const spellData = { name: "Conglomerate Grab", type: "spell", img: "icons/magic/control/silhouette-grow-shrink-tan.webp", system: spellSystemData };
                                const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                                cgSpell = created[0];
                            } else {
                                await cgSpell.update({ system: spellSystemData });
                            }

                            const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
                            const htmlContent = await renderTemplate(templatePath, {
                                targets: Object.values(targetsData), itemName: "Conglomerate Grab", saveType: "Fortitude", saveDC: exactDC
                            });

                            const kamikazeNotice = isKamikaze ? `<p style="color: #ff6b6b; font-weight: bold; text-align: center; margin-bottom: 5px; border: 1px dashed #ff6b6b; padding: 2px;">[Kamikaze Active: Use the 'Dismiss' button on the Command Deck to destroy this thrall when damage is resolved]</p>` : ``;

                            await ChatMessage.create({
                                speaker: ChatMessage.getSpeaker({ actor: actor }),
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
                                        templateId: null, documentName: "ManualTarget", itemUuid: cgSpell.uuid,
                                        itemName: "Conglomerate Grab", saveType: "fortitude", saveDC: exactDC,
                                        isBasicSave: false, targets: targetsData, hazardDamage: null, isReactive: false, originMessageId: null
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
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);

                        break;
                    }
                    case "body-shield": {
                        const necroTokens = actor.getActiveTokens();
                        if (necroTokens.length === 0) {
                            ui.notifications.warn("No Necromancer token found on the canvas.");
                            break;
                        }
                        const necroToken = necroTokens[0];
                        
                        let distance = 999;
                        if (typeof tokenDoc.object?.distanceTo === "function") {
                            distance = tokenDoc.object.distanceTo(necroToken);
                        } else {
                            const dx = Math.abs(tokenDoc.x - necroToken.x);
                            const dy = Math.abs(tokenDoc.y - necroToken.y);
                            distance = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                        }

                        if (distance > 5) {
                            ui.notifications.warn(`${tokenDoc.name} is too far away to use as a meat shield. They must be adjacent (5 feet).`);
                            break;
                        }

                        const necroLevel = actor.level || 1;

                        const effectData = {
                            name: "Effect: Body Shield",
                            type: "effect",
                            img: "icons/magic/defensive/shield-barrier-glowing-triangle-magenta.webp",
                            system: {
                                level: { value: necroLevel },
                                duration: { value: 1, unit: "rounds", expiry: "turn-start" },
                                description: { value: "You threw a thrall in the way! +2 circumstance bonus to AC, and resistance to all damage equal to your level against the triggering attack." },
                                rules: [
                                    { key: "FlatModifier", selector: "ac", value: 2, type: "circumstance" },
                                    { key: "Resistance", type: "all-damage", value: necroLevel }
                                ]
                            }
                        };

                        const currentAC = actor.system?.attributes?.ac?.value || 10;
                        const boostedAC = currentAC + 2;


                        await actor.createEmbeddedDocuments("Item", [effectData]);
                        await executeDelete(tokenDoc.id);

                        await ChatMessage.create({
                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                            flavor: `<strong>Body Shield Reaction!</strong>`,
                            content: `
                                <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #b58900;">
                                    <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> coldly yanks <b>${tokenDoc.name}</b> into the path of an incoming attack, obliterating them instantly!</p>
                                    <p style="margin: 0; font-size: 1.1em;">Current AC: <b><span style="color: #4ade80;">${boostedAC}</span></b> <i>(+2 circ)</i></p>
                                    <p style="margin: 5px 0 0 0;">If the attack still hits, ${actor.name} gains <b>Resistance ${necroLevel} to all damage</b>. <i>(Expires at the start of your next turn)</i></p>
                                </div>
                            `
                        });

                        break;
                    }
                    case "blossoming-gore": {
                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                        if (currentFocus === 0) {
                            ui.notifications.warn("You have no Focus Points to cast Blossoming Gore!");
                            break;
                        }

                        const necroTokens = actor.getActiveTokens();
                        if (necroTokens.length === 0) {
                            ui.notifications.warn("No Necromancer token found on the canvas.");
                            break;
                        }
                        const necroToken = necroTokens[0];

                        let distanceToNecro = 999;
                        if (typeof tokenDoc.object?.distanceTo === "function") {
                            distanceToNecro = tokenDoc.object.distanceTo(necroToken);
                        } else {
                            const dx = Math.abs(tokenDoc.x - necroToken.x);
                            const dy = Math.abs(tokenDoc.y - necroToken.y);
                            distanceToNecro = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                        }

                        if (distanceToNecro > 60) {
                            ui.notifications.warn(`${tokenDoc.name} is too far away. They must be within 60 feet.`);
                            break;
                        }

                        const spellRank = Math.max(5, Math.ceil((actor.level || 1) / 2));
                        const bleedDmg = 10 + (Math.max(0, spellRank - 5) * 2);

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
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) exactDC = actor.system.attributes.classDC.dc.value;

                        new Dialog({
                            title: "Blossoming Gore",
                            content: `<p>Sacrifice <b>${tokenDoc.name}</b> to create a 20-foot burst field of bloody roses?</p>`,
                            buttons: {
                                cast: {
                                    icon: '<i class="fas fa-seedling"></i>',
                                    label: "Bloom",
                                    callback: async () => {
                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                                        if (currentFocus <= 0) {
                                            return ui.notifications.warn("You have no Focus Points remaining!");
                                        }
                                        if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        
                                        const gridSize = canvas.scene.grid.size;
                                        const gridDist = canvas.scene.grid.distance;
                                        const radiusPixels = (20 / gridDist) * gridSize;
                                        
                                        const centerX = tokenDoc.x + (tokenDoc.width * gridSize) / 2;
                                        const centerY = tokenDoc.y + (tokenDoc.height * gridSize) / 2;

                                        let bgSpell = actor.items.find(i => i.type === "spell" && i.name === "Blossoming Gore Hazard");
                                        const persistentRules = [
                                            { context: "tokenTurnEnd", outcome: "always", promptSave: true, alliance: "enemy" }
                                        ];

                                        const spellSystemData = {
                                            level: { value: spellRank },
                                            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                                            tradition: { value: "divine" },
                                            defense: { save: { statistic: "fortitude", basic: false, dc: { value: exactDC } } }
                                        };

                                        if (!bgSpell) {
                                            const spellData = { 
                                                name: "Blossoming Gore Hazard", 
                                                type: "spell", 
                                                img: "icons/magic/life/heart-cross-plant-green.webp", 
                                                system: spellSystemData,
                                                flags: { "aoe-easy-resolve": { rules: persistentRules } }
                                            };
                                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                                            bgSpell = created[0];
                                            await bgSpell.update({ "system.damage.-=0": null });
                                        } else {
                                            await bgSpell.update({
                                                "system.level.value": spellRank,
                                                "system.traits.value": ["necromancer", "manipulate", "concentrate", "focus", "uncommon"],
                                                "system.tradition.value": "divine",
                                                "system.defense.save.statistic": "fortitude",
                                                "system.defense.save.basic": false,
                                                "system.defense.save.dc.value": exactDC,
                                                "system.damage.-=0": null,
                                                "flags.aoe-easy-resolve.rules": persistentRules
                                            });
                                        }
                                        
                                        await bgSpell.setFlag("necromancer-thrall-helper", "bleedDmg", bleedDmg);

                                        const behaviorSource = `
                                        const targetActor = event.data.token?.actor;
                                        if (!targetActor) return;
                                        
                                        const alliance = targetActor.system?.details?.alliance || targetActor.alliance;
                                        const isEnemy = alliance === "opposition" || event.data.token.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE;
                                        if (!isEnemy) return;

                                        if (event.name === "tokenEnter" || event.name === "tokenTurnStart") {
                                            const bleedCondition = {
                                                type: 'condition',
                                                name: 'Persistent Damage',
                                                system: {
                                                    slug: 'persistent-damage',
                                                    persistent: { formula: '${bleedDmg}', damageType: 'bleed', dc: 15 }
                                                }
                                            };
                                            if (game.user.isGM) {
                                                targetActor.createEmbeddedDocuments('Item', [bleedCondition]).catch(()=>{});
                                            } else {
                                                game.socket.emit("module.necromancer-thrall-helper", {
                                                    action: "addCondition",
                                                    actorUuid: targetActor.uuid,
                                                    itemData: bleedCondition
                                                });
                                            }
                                        }
                                        
                                        if (event.name === "tokenTurnEnd") {
                                            const hasBleed = targetActor.items.some(i => i.type === "condition" && i.system.slug === "persistent-damage" && i.system.persistent?.damageType === "bleed");
                                            if (hasBleed && game.modules.get('aoe-easy-resolve')?.api?.handleRegionEvent) {
                                                game.modules.get('aoe-easy-resolve').api.handleRegionEvent(event, '${bgSpell.uuid}');
                                            }
                                        }
                                    `;

                                    const regionId = foundry.utils.randomID();
                                    const regionData = {
                                        name: "Blossoming Gore",
                                        color: "#aa0000",
                                        shapes: [{ type: "ellipse", hole: false, x: centerX, y: centerY, radiusX: radiusPixels, radiusY: radiusPixels, rotation: 0 }],
                                        elevation: { bottom: -1000, top: 1000 },
                                        behaviors: [{
                                            name: "Blossoming Gore Controller",
                                            type: "executeScript",
                                            system: {
                                                events: ["tokenTurnStart", "tokenEnter", "tokenTurnEnd"],
                                                source: behaviorSource
                                            }
                                        }],
                                        flags: { 
                                            "necromancer-thrall-helper": { goreRegionId: regionId },
                                            "aoe-easy-resolve": { 
                                                isAoERegion: true, originItemUuid: bgSpell.uuid, saveDC: exactDC,
                                                persistentRules: persistentRules
                                            }
                                        }
                                    };

                                    const drawingData = {
                                        author: game.user.id, shape: { type: "e", width: radiusPixels * 2, height: radiusPixels * 2 },
                                        x: centerX - radiusPixels, y: centerY - radiusPixels,
                                        fillType: 1, fillColor: "#ff0000", fillAlpha: 0.3,
                                        strokeWidth: 3, strokeColor: "#880000", strokeAlpha: 0.8,
                                        flags: { "necromancer-thrall-helper": { goreRegionId: regionId } }
                                    };

                                    await executeHazard(regionData, drawingData);
                                    try { await canvas.scene.createEmbeddedDocuments("Drawing", [drawingData]); } catch (e) {}

                                    const trackerEffect = {
                                        name: "Hazard: Blossoming Gore",
                                        type: "effect",
                                        img: "icons/magic/life/heart-cross-plant-green.webp",
                                        system: {
                                            description: { value: "Tracks the duration of the Blossoming Gore hazard. Deleting this clears the hazard from the map." },
                                            duration: { value: 1, unit: "minutes", expiry: "turn-start" }
                                        },
                                        flags: {
                                            "necromancer-thrall-helper": { isHazardTracker: true, hazardId: regionId, sceneId: canvas.scene.id }
                                        }
                                    };
                                    await actor.createEmbeddedDocuments("Item", [trackerEffect]);

                                    if (game.user.isGM) {
                                        await tokenDoc.delete();
                                    } else {
                                        await executeDelete(tokenDoc.id);
                                    }
                                    
                                    this.render({ force: false });

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            flavor: `<strong>Blossoming Gore</strong>`,
                                            content: `
                                                <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #cc0000;">
                                                    <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> spills the blood of <b>${tokenDoc.name}</b>, growing a massive 20-foot burst field of bloody roses!</p>
                                                    <p style="margin: 0 0 5px 0;">A creature that enters or starts its turn in the area takes <b>${bleedDmg} persistent bleed damage</b> from the thorns and must attempt a <b>DC ${exactDC} Fortitude save</b>.</p>
                                                    <p style="margin: 0; font-size: 0.95em;">Failure drains the creature and spawns new thralls!</p>
                                                </div>
                                            `
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "cast"
                        }).render(true);
                        break;
                    }
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

                                        await executeHazard(regionData, drawingData);
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
                                        if (currentFocus <= 0) {
                                            return ui.notifications.warn("You have no Focus Points remaining!");
                                        }
                                        if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        
                                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
                                        const gridDist = canvas.scene?.grid?.distance || 5;
                                        const tokenRadiusFeet = ((tokenDoc.width || 1) * gridDist) / 2;
                                        const totalEmanationFeet = 5 + tokenRadiusFeet;
                                        
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
                                            return dist <= 5; 
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

                                        const [template] = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{
                                            t: "circle",
                                            user: game.user.id,
                                            x: tokenCenter.x,
                                            y: tokenCenter.y,
                                            distance: totalEmanationFeet,
                                            fillColor: "#00ffff"
                                        }]);

                                        setTimeout(() => {
                                            if (canvas.scene && canvas.scene.templates.has(template.id)) globalThis.NecroThrallHelper.purgeGraphics(canvas.scene.id, { templateIds: [template.id] });
                                        }, 20000);

                                        if (Object.keys(targetsData).length === 0) {
                                            ui.notifications.info("The thrall screams, but no targets were caught in the blast!");
                                            return; 
                                        }

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
                            traits: { value: ["necromancer", "occult", "concentrate", "focus", "uncommon"] },
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

                                        await executeDelete(tokenDoc.id);

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
                                        await executeDelete(tokenDoc.id);
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
                                        if (currentFocus <= 0) {
                                            return ui.notifications.warn("You have no Focus Points remaining!");
                                        }
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

                                        await executeDelete(tokenDoc.id);

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
                                        if (currentFocus <= 0) {
                                            return ui.notifications.warn("You have no Focus Points remaining!");
                                        }
                                        if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        
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
                                            if (canvas.scene && canvas.scene.drawings.has(marker.id)) globalThis.NecroThrallHelper.purgeGraphics(canvas.scene.id, { drawingIds: [marker.id] });
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
                                        if (currentFocus <= 0) {
                                            return ui.notifications.warn("You have no Focus Points remaining!");
                                        }
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

                                        await executeDelete(tokenDoc.id);

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
                            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "void"] },
                            tradition: { value: "divine" },
                        area: { type: "emanation", value: 10 },
                        target: { value: "creatures" }, 
                        defense: { save: { statistic: "fortitude", basic: true, dc: { value: exactDC } } },
                        damage: { "0": { formula: `${bombRank}d12`, type: "void" } }
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
                    await bombSpell.setFlag("aoe-easy-resolve", "customDamageType", "void");
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
                                        if (currentFocus <= 0) {
                                            return ui.notifications.warn("You have no Focus Points remaining!");
                                        }
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
    
                                        await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{
                                            t: "circle", 
                                            user: game.user.id, 
                                            x: tokenCenter.x, 
                                            y: tokenCenter.y, 
                                            distance: totalEmanationFeet, 
                                            fillColor: "#660066"
                                        }]);
    
                                        await new Promise(r => setTimeout(r, 150));
    
                                        await executeDelete(tokenDoc.id);
    
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
                                        if (currentFocus <= 0) {
                                            return ui.notifications.warn("You have no Focus Points remaining!");
                                        }
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

                                        await executeDelete(tokenDoc.id);

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
                                        await executeDelete(tokenDoc.id);

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
                                        if (currentFocus <= 0) {
                                            return ui.notifications.warn("You have no Focus Points remaining!");
                                        }
                                        if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        
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
                                            if (canvas.scene && canvas.scene.drawings.has(marker.id)) globalThis.NecroThrallHelper.purgeGraphics(canvas.scene.id, { drawingIds: [marker.id] });
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
                                            const roll = await new DamageRoll(`${spellRank}d8[healing]`).evaluate();
                                            const actualHeal = roll.total;
                                            
                                            await roll.toMessage({
                                                speaker: ChatMessage.getSpeaker({ actor: actor }),
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


                                const necroTokens = actor.getActiveTokens();
                                let rangeIndicator = null;
                                
                                if (necroTokens.length > 0) {
                                    const masterToken = necroTokens[0];
                                    const rangeInPixels = (30 / canvas.scene.grid.distance) * canvas.grid.size;
                                    
                                    rangeIndicator = new PIXI.Graphics();
                                    rangeIndicator.beginFill(0x22c55e, 0.08); 
                                    rangeIndicator.lineStyle(3, 0x22c55e, 0.5); 
                                    rangeIndicator.drawCircle(masterToken.center.x, masterToken.center.y, rangeInPixels);
                                    rangeIndicator.endFill();
                                    rangeIndicator.zIndex = 998; 
                                    
                                    canvas.tokens.addChild(rangeIndicator);
                                }
      
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
                    
                                    if (rangeIndicator) rangeIndicator.destroy();
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

                                    const ownerIds = Object.keys(actor.ownership).filter(k => actor.ownership[k] === 3 && k !== "default");
                                    const newOwnership = { default: 0 };
                                    ownerIds.forEach(id => newOwnership[id] = 3);
                                    
                                    newOwnership[game.user.id] = 3;

                                    const finalPayload = foundry.utils.mergeObject(basePayload, {
                                        x: spawnX,
                                        y: spawnY,
                                        delta: {
                                            ownership: newOwnership
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
        const conjureConglomBtn = html.querySelector(".conjure-conglom-btn");
        if (conjureConglomBtn) {
            conjureConglomBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor) return ui.notifications.warn("No Necromancer found!");
                const conglomActor = await getOrImportActor("Conglomerate of Limbs");
                if (!conglomActor) return;

                const currentFocus = actor.system?.resources?.focus?.value || 0;
                if (currentFocus === 0) return ui.notifications.warn("You have no Focus Points to conjure the Conglomerate!");

                await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                const spellRank = Math.max(4, Math.ceil(actor.level / 2));
                const bonusHP = Math.max(0, spellRank - 4) * 10;
                const totalHP = 40 + bonusHP;

                ui.notifications.info(`Click the canvas to place the Huge Conglomerate within 30 feet. Right-click to cancel.`);
                document.body.style.cursor = "crosshair";
                canvas.app.view.style.cursor = "crosshair";

                let rangeIndicator = null;
                let necroCenter = null;
                const necroTokens = actor.getActiveTokens();
                if (necroTokens.length > 0) {
                    necroCenter = necroTokens[0].center;
                    const rangeInPixels = (30 / canvas.scene.grid.distance) * canvas.grid.size;
                    rangeIndicator = new PIXI.Graphics();
                    rangeIndicator.beginFill(0x22c55e, 0.05);
                    rangeIndicator.lineStyle(3, 0x22c55e, 0.5);
                    rangeIndicator.drawCircle(necroCenter.x, necroCenter.y, rangeInPixels);
                    rangeIndicator.endFill();
                    rangeIndicator.zIndex = 998;
                    canvas.tokens.addChild(rangeIndicator);
                }

                const gridSize = canvas.grid.size;
                const ghost = new PIXI.Graphics();
                ghost.beginFill(0x550000, 0.4);
                ghost.lineStyle(2, 0xff0000, 0.8);
                ghost.drawRect(0, 0, gridSize * 3, gridSize * 3); 
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
                    if (rangeIndicator) {
                        rangeIndicator.destroy();
                        rangeIndicator = null;
                    }
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

                    if (necroCenter) {
                        const targetCenter = { x: spawnX + (gridSize * 1.5), y: spawnY + (gridSize * 1.5) };
                        const dx = Math.abs(necroCenter.x - targetCenter.x);
                        const dy = Math.abs(necroCenter.y - targetCenter.y);
                        const dist = (Math.max(dx, dy) / gridSize) * canvas.scene.grid.distance;
                        if (dist > 30) {
                            ui.notifications.warn("The Conglomerate must be placed within 30 feet.");
                            canvas.stage.once("pointerdown", interactionHandler);
                            return;
                        }
                    }

                    cleanUp();

                    const tokenDoc = await conglomActor.getTokenDocument({ x: spawnX, y: spawnY });
                    
                    const finalPayload = foundry.utils.mergeObject(tokenDoc.toObject(), {
                        actorLink: false, 
                        ownership: { [game.user.id]: 3 }, 
                        flags: { "necromancer-thrall-helper": { masterId: actor.id } },
                        delta: { 
                            ownership: { [game.user.id]: 3 }, 
                            system: { attributes: { hp: { value: totalHP, max: totalHP } } }
                        }
                    });
                    applyCustomVisuals(finalPayload, actor, "tendril");

                    executeSpawn(finalPayload).then(() => {
                        ChatMessage.create({
                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                            flavor: `<strong>Conglomerate of Limbs</strong>`,
                            content: `<p><b>${actor.name}</b> conjures a hulking mass of severed limbs to the battlefield!</p>`
                        });
                    }).catch(err => console.error("Necromancer Helper | Spawn failed:", err));
                };

                canvas.stage.once("pointerdown", interactionHandler);
            });
        }
        const conjureBtn = html.querySelector(".conjure-tendrils-btn");
        if (conjureBtn) {
            conjureBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                
                if (!actor) return ui.notifications.warn("No Necromancer found!");

                const sRank = Math.max(1, Math.ceil(actor.level / 2));
                const count = 3 + Math.floor(Math.max(0, sRank - 3) / 3);

                const tendrilActor = await getOrImportActor("Bloody Tendril");
                if (!tendrilActor) return;
                
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
                ui.notifications.info(`Click the canvas to place Tendril ${currentSpawnIndex + 1} within 30 feet. Right-click to cancel.`);
                document.body.style.cursor = "crosshair";
                canvas.app.view.style.cursor = "crosshair";

                let rangeIndicator = null;
                let necroCenter = null;
                const necroTokens = actor.getActiveTokens();
                if (necroTokens.length > 0) {
                    necroCenter = necroTokens[0].center;
                    const rangeInPixels = (30 / canvas.scene.grid.distance) * canvas.grid.size;
                    rangeIndicator = new PIXI.Graphics();
                    rangeIndicator.beginFill(0x22c55e, 0.05);
                    rangeIndicator.lineStyle(3, 0x22c55e, 0.5);
                    rangeIndicator.drawCircle(necroCenter.x, necroCenter.y, rangeInPixels);
                    rangeIndicator.endFill();
                    rangeIndicator.zIndex = 998;
                    canvas.tokens.addChild(rangeIndicator);
                }

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
                    if (rangeIndicator) {
                        rangeIndicator.destroy();
                        rangeIndicator = null;
                    }
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

                    if (necroCenter) {
                        const targetCenter = { x: spawnX + (gridSize * 0.5), y: spawnY + (gridSize * 0.5) };
                        const dx = Math.abs(necroCenter.x - targetCenter.x);
                        const dy = Math.abs(necroCenter.y - targetCenter.y);
                        const dist = (Math.max(dx, dy) / canvas.grid.size) * canvas.scene.grid.distance;
                        if (dist > 30) {
                            ui.notifications.warn("Bloody Tendrils must be placed within 30 feet.");
                            canvas.stage.once("pointerdown", interactionHandler);
                            return;
                        }
                    }

                    const tetherId = foundry.utils.randomID();
                    const tokenDoc = await tendrilActor.getTokenDocument({ x: spawnX, y: spawnY });

                    const finalPayload = foundry.utils.mergeObject(tokenDoc.toObject(), {
                        actorLink: false, 
                        ownership: { [game.user.id]: 3 }, 
                        flags: { "necromancer-thrall-helper": { masterId: actor.id, tendrilTetherId: tetherId } },
                        delta: { ownership: { [game.user.id]: 3 } }
                    });
                    applyCustomVisuals(finalPayload, actor, "conglom");

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
                    
                    await executeHazard(regionData, drawingData);
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
                    await executeDelete(tokenDoc.id);
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