import { executeDelete, executeHazard } from "../system/socket.js";
import { notify } from "../system/notify.js";
import { getSpellDC, getTokenDistance } from "./spell-helpers.js";

export function bindBlossomingGoreButtons(deck, html) {
    const dismissGoreBtn = html.querySelector(".dismiss-gore-btn");
    if (!dismissGoreBtn) return;

    dismissGoreBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        if (!canvas.scene) return;
        const rIds = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "goreRegionId")).map(r => r.id);
        const dIds = canvas.scene.drawings.filter(d => d.getFlag("necromancer-thrall-helper", "goreRegionId")).map(d => d.id);
        if (rIds.length || dIds.length) {
            globalThis.NecroThrallHelper.purgeGraphics(canvas.scene.id, { regionIds: rIds, drawingIds: dIds });
        }
        notify("info", "Blossoming Gore dismissed.");
        setTimeout(() => deck.render({ force: false }), 150);
    });
}

export async function executeBlossomingGore({ deck, actor, tokenDoc }) {
    const currentFocus = actor.system?.resources?.focus?.value || 0;
    if (currentFocus === 0) return notify("warn", "You have no Focus Points to cast Blossoming Gore!");

    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length === 0) return notify("warn", "No Necromancer token found on the canvas.");

    if (getTokenDistance(tokenDoc, necroTokens[0]) > 60) {
        return notify("warn", `${tokenDoc.name} is too far away. They must be within 60 feet.`);
    }

    const spellRank = Math.max(5, Math.ceil((actor.level || 1) / 2));
    const bleedDmg = 10 + (Math.max(0, spellRank - 5) * 2);
    const exactDC = getSpellDC(actor);

    new Dialog({
        title: "Blossoming Gore",
        content: `<p>Sacrifice <b>${tokenDoc.name}</b> to create a 20-foot burst field of bloody roses?</p>`,
        buttons: {
            cast: {
                icon: '<i class="fas fa-seedling"></i>',
                label: "Bloom",
                callback: async () => {
                    const focusToSpend = actor.system?.resources?.focus?.value || 0;
                    if (focusToSpend <= 0) return notify("warn", "You have no Focus Points remaining!");
                    await actor.update({ "system.resources.focus.value": focusToSpend - 1 });

                    const gridSize = canvas.scene.grid.size;
                    const gridDist = canvas.scene.grid.distance;
                    const radiusPixels = (20 / gridDist) * gridSize;
                    const centerX = tokenDoc.x + (tokenDoc.width * gridSize) / 2;
                    const centerY = tokenDoc.y + (tokenDoc.height * gridSize) / 2;

                    let bgSpell = actor.items.find(i => i.type === "spell" && i.name === "Blossoming Gore Hazard");
                    const persistentRules = [
                        { context: "tokenTurnEnd", outcome: "always", promptSave: true, alliance: "enemy" },
                        { context: "turnEnd", outcome: "always", promptSave: true, alliance: "enemy" }
                    ];
                    const spellSystemData = {
                        level: { value: spellRank },
                        traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                        tradition: { value: "divine" },
                        defense: { save: { statistic: "fortitude", basic: false, dc: { value: exactDC } } }
                    };

                    if (!bgSpell) {
                        const created = await actor.createEmbeddedDocuments("Item", [{
                            name: "Blossoming Gore Hazard",
                            type: "spell",
                            img: "icons/magic/life/heart-cross-plant-green.webp",
                            system: spellSystemData
                        }]);
                        bgSpell = created[0];
                    } else {
                        await bgSpell.update({ system: spellSystemData, "system.damage.-=0": null });
                    }

                    await bgSpell.setFlag("necromancer-thrall-helper", "bleedDmg", bleedDmg);
                    await bgSpell.setFlag("aoe-easy-resolve", "useOverride", true);
                    await bgSpell.setFlag("aoe-easy-resolve", "saveDC", exactDC);
                    await bgSpell.setFlag("aoe-easy-resolve", "saveType", "fortitude");
                    await bgSpell.setFlag("aoe-easy-resolve", "rules", persistentRules);

                    const behaviorSource = `
                        if (!event.region.getFlag("necromancer-thrall-helper", "isArmed")) return;
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
                            if (game.modules.get('aoe-easy-resolve')?.api?.handleRegionEvent) {
                                const proxyEvent = { name: "tokenTurnStart", data: event.data, region: event.region, user: event.user };
                                game.modules.get('aoe-easy-resolve').api.handleRegionEvent(proxyEvent, '${bgSpell.uuid}');
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
                            system: { events: ["tokenTurnStart", "tokenEnter", "tokenTurnEnd"], source: behaviorSource }
                        }],
                        flags: {
                            "necromancer-thrall-helper": { goreRegionId: regionId, isArmed: false },
                            "aoe-easy-resolve": { isAoERegion: true, originItemUuid: bgSpell.uuid, saveDC: exactDC, persistentRules }
                        }
                    };

                    const drawingData = {
                        author: game.user.id,
                        shape: { type: "e", width: radiusPixels * 2, height: radiusPixels * 2 },
                        x: centerX - radiusPixels,
                        y: centerY - radiusPixels,
                        fillType: 1,
                        fillColor: "#ff0000",
                        fillAlpha: 0.3,
                        strokeWidth: 3,
                        strokeColor: "#880000",
                        strokeAlpha: 0.8,
                        flags: { "necromancer-thrall-helper": { goreRegionId: regionId } }
                    };

                    const hazardResult = await executeHazard(regionData, drawingData);

                    setTimeout(async () => {
                        if (canvas.scene && hazardResult?.regionId) {
                            const regionDoc = canvas.scene.regions.get(hazardResult.regionId);
                            if (regionDoc) await regionDoc.setFlag("necromancer-thrall-helper", "isArmed", true);
                        }
                    }, 2000);

                    await actor.createEmbeddedDocuments("Item", [{
                        name: "Hazard: Blossoming Gore",
                        type: "effect",
                        img: "icons/magic/life/heart-cross-plant-green.webp",
                        system: {
                            description: { value: "Tracks the duration of the Blossoming Gore hazard. Deleting this clears the hazard from the map." },
                            duration: { value: 1, unit: "minutes", expiry: "turn-start" }
                        },
                        flags: { "necromancer-thrall-helper": { isHazardTracker: true, hazardId: regionId, sceneId: canvas.scene.id } }
                    }]);

                    await executeDelete(tokenDoc.id);
                    deck.render({ force: false });

                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor }),
                        flavor: `<strong>Blossoming Gore</strong>`,
                        content: `
                            <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #cc0000;">
                                <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> spills the blood of <b>${tokenDoc.name}</b>, growing a massive 20-foot burst field of bloody roses!</p>
                                <p style="margin: 0 0 5px 0;">A creature that enters or starts its turn in the area takes <b>${bleedDmg} persistent bleed damage</b> from the thorns.</p>
                                <p style="margin: 0 0 5px 0;">At the end of their turn, they must attempt a <b>DC ${exactDC} Fortitude save</b>.</p>
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
}