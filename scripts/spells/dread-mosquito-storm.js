import { tokenPortrait } from "../system/thrall-manager.js";
import { executeHazard } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { getSpellDC } from "./spell-helpers.js";

export function bindDreadMosquitoButtons(deck, html) {
    const dmsBtn = html.querySelector(".dms-btn");
    if (dmsBtn) {
        dmsBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!actor) return;

            const currentFocus = actor.system?.resources?.focus?.value || 0;
            if (currentFocus === 0) return notify("warn", "You have no Focus Points to cast Dread Mosquito Storm!");

            const exactDC = getSpellDC(actor);
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
                const created = await actor.createEmbeddedDocuments("Item", [{ name: "Dread Mosquito Storm", type: "spell", img: "icons/creatures/invertebrates/wasp-swarm-movement-purple.webp", system: spellSystemData }]);
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

            placementHint("Click the canvas within 120 feet to release the swarm. Right-click to cancel.");
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
                    await actor.update({ "system.resources.focus.value": currentFocus });
                    notify("info", "Swarm placement cancelled.");
                    cleanUp();
                    return;
                }

                const pos = evt.data.getLocalPosition(canvas.app.stage);
                const snapped = canvas.grid.getCenterPoint ? canvas.grid.getCenterPoint(pos) : pos;
                cleanUp();

                const validTargets = canvas.tokens.placeables.filter(t => {
                    if (!t.actor || (t.actor.system?.attributes?.hp?.value || 0) <= 0) return false;
                    const targetCenter = t.center || { x: t.x, y: t.y };
                    const dist = (Math.max(Math.abs(snapped.x - targetCenter.x), Math.abs(snapped.y - targetCenter.y)) / canvas.grid.size) * gridDist;
                    return dist <= 60;
                });

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

                const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
                const htmlContent = await renderTemplate(templatePath, {
                    targets: Object.values(targetsData),
                    itemName: "Dread Mosquito Storm",
                    saveType: "Fortitude",
                    saveDC: exactDC
                });

                const regionId = foundry.utils.randomID();
                const behaviorSource = `
                    if (!event.region.getFlag("necromancer-thrall-helper", "isArmed")) return;
                    if (game.modules.get('aoe-easy-resolve')?.api?.handleRegionEvent) {
                        game.modules.get('aoe-easy-resolve').api.handleRegionEvent(event, '${dmsSpell.uuid}');
                    }
                `;

                const regionData = {
                    name: "Dread Mosquito Storm",
                    color: "#111111",
                    shapes: [{ type: "ellipse", hole: false, x: snapped.x, y: snapped.y, radiusX: radiusPixels, radiusY: radiusPixels, rotation: 0 }],
                    elevation: { bottom: -1000, top: 1000 },
                    behaviors: [{
                        name: "AoE Easy Resolve Controller",
                        type: "executeScript",
                        system: { events: ["tokenTurnStart", "tokenEnter"], source: behaviorSource }
                    }],
                    flags: {
                        "necromancer-thrall-helper": { stormRegionId: regionId, isArmed: false },
                        "aoe-easy-resolve": {
                            isAoERegion: true,
                            originItemUuid: dmsSpell.uuid,
                            saveDC: exactDC,
                            persistentRules: [
                                { context: "tokenEnter", outcome: "always", promptSave: true, alliance: "all" },
                                { context: "tokenTurnStart", outcome: "always", promptSave: true, alliance: "all" }
                            ]
                        }
                    }
                };

                const drawingData = {
                    author: game.user.id,
                    shape: { type: "e", width: radiusPixels * 2, height: radiusPixels * 2 },
                    x: snapped.x - radiusPixels,
                    y: snapped.y - radiusPixels,
                    fillType: 1,
                    fillColor: "#111111",
                    fillAlpha: 0.3,
                    strokeWidth: 3,
                    strokeColor: "#990000",
                    strokeAlpha: 0.8,
                    flags: { "necromancer-thrall-helper": { stormRegionId: regionId } }
                };

                const hazardResult = await executeHazard(regionData, drawingData);

                setTimeout(async () => {
                    if (canvas.scene && hazardResult?.regionId) {
                        const regionDoc = canvas.scene.regions.get(hazardResult.regionId);
                        if (regionDoc) await regionDoc.setFlag("necromancer-thrall-helper", "isArmed", true);
                    }
                }, 2000);

                deck.render({ force: false });

                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor }),
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
                            templateId: null,
                            documentName: "ManualTarget",
                            itemUuid: dmsSpell.uuid,
                            itemName: "Dread Mosquito Storm",
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

            canvas.stage.once("pointerdown", interactionHandler);
        });
    }

    const dismissStormBtn = html.querySelector(".dismiss-storm-btn");
    if (dismissStormBtn) {
        dismissStormBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            if (!canvas.scene) return;
            const rIds = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "stormRegionId")).map(r => r.id);
            const dIds = canvas.scene.drawings.filter(d => d.getFlag("necromancer-thrall-helper", "stormRegionId")).map(d => d.id);
            if (rIds.length || dIds.length) {
                globalThis.NecroThrallHelper.purgeGraphics(canvas.scene.id, { regionIds: rIds, drawingIds: dIds });
            }
            notify("info", "Dread Mosquito Storm dismissed.");
            setTimeout(() => deck.render({ force: false }), 150);
        });
    }
}