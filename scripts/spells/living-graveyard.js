import { prepareThrallPayload, tokenPortrait } from "../system/thrall-manager.js";
import { executeSpawn, createSpawnBatch, executeDelete } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { effectColor, zoneBorderColor } from "../system/effect-colors.js";
import {
    getSpellDC,
    getOrImportActor,
    applyCustomVisuals,
    createRangeIndicator,
    attachGhostHUD,
    buildOwnerMap,
    snapTopLeft
} from "./spell-helpers.js";

export async function executeSheddingMatrix(actor, maxSpawns) {
    globalThis.NecroThrallHelper = globalThis.NecroThrallHelper || {};
    if (globalThis.NecroThrallHelper._isSheddingCorpses) {
        return notify("warn", "You are already shedding corpses! Right-click the canvas to cancel first.");
    }
    globalThis.NecroThrallHelper._isSheddingCorpses = true;

    const basePayload = await prepareThrallPayload(actor, "default");
    if (!basePayload) {
        globalThis.NecroThrallHelper._isSheddingCorpses = false;
        return;
    }

    const batch = createSpawnBatch();
    let currentSpawn = 0;
    placementHint(`Click to place Thrall 1 of ${maxSpawns}. Right-click or Esc undoes the last one; Enter sends early.`);
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

    const updateHUD = attachGhostHUD(ghost, { getCountText: () => `Shed ${currentSpawn + 1} / ${maxSpawns}` });
    const updateGhost = (evt) => {
        const pos = evt.data.getLocalPosition(canvas.app.stage);
        const snapped = snapTopLeft(pos);
        ghost.position.set(snapped.x, snapped.y);
        updateHUD(snapped.x, snapped.y);
    };
    canvas.stage.on("pointermove", updateGhost);

    const cleanUpSpawns = () => {
        globalThis.NecroThrallHelper._isSheddingCorpses = false;
        document.body.style.cursor = "";
        canvas.app.view.style.cursor = "";
        canvas.stage.off("pointermove", updateGhost);
        if (ghost && !ghost.destroyed) ghost.destroy();
    };

    const spawnHandler = async (evt) => {
        if (evt.data.button !== 0 && evt.data.button !== 2) {
            canvas.stage.once("pointerdown", spawnHandler);
            return;
        }
        if (evt.data.button === 2) {
            if (batch.undo()) {
                currentSpawn--;
                placementHint(`Place Thrall ${currentSpawn + 1} of ${maxSpawns}.`);
                canvas.stage.once("pointerdown", spawnHandler);
                return;
            }
            batch.cancel();
            cleanUpSpawns();
            return;
        }

        const pos = evt.data.getLocalPosition(canvas.app.stage);
        const snapped = snapTopLeft(pos);

        const clonedPayload = foundry.utils.deepClone(basePayload);
        const finalPayload = foundry.utils.mergeObject(clonedPayload, {
            actorLink: false,
            name: "Shed Corpse",
            x: snapped.x,
            y: snapped.y,
            elevation: actor?.getActiveTokens()[0]?.document?.elevation || 0,
            width: 1,
            height: 1,
            texture: { src: "systems/pf2e/icons/spells/animate-dead.webp", scaleX: 1, scaleY: 1 },
            delta: { ownership: buildOwnerMap(actor) },
            flags: { "necromancer-thrall-helper": { masterId: actor.id } }
        });

        await applyCustomVisuals(finalPayload, actor, "shed");

        currentSpawn++;
        notify("info", `Spawn request ${currentSpawn} queued...`);
        batch.add(finalPayload);

        if (currentSpawn < maxSpawns) {
            canvas.stage.once("pointerdown", spawnHandler);
        } else {
            cleanUpSpawns();
            batch.finish();
            notify("info", "All summons requested.");
        }
    };

    batch.bindKeys({
        onUndo: () => { currentSpawn--; placementHint(`Place Thrall ${currentSpawn + 1} of ${maxSpawns}.`); },
        onCancel: () => { canvas.stage.off("pointerdown", spawnHandler); cleanUpSpawns(); },
        onFinish: () => { canvas.stage.off("pointerdown", spawnHandler); cleanUpSpawns(); }
    });
    canvas.stage.once("pointerdown", spawnHandler);
}

globalThis.NecroThrallHelper = globalThis.NecroThrallHelper || {};
globalThis.NecroThrallHelper.executeSheddingMatrix = executeSheddingMatrix;

export function bindLivingGraveyardButtons(deck, html) {
    const activeGraveyard = canvas.scene
        ? canvas.scene.tokens.find(t => t.flags?.["necromancer-thrall-helper"]?.masterId === deck.necroId && t.flags?.["necromancer-thrall-helper"]?.isLivingGraveyard)
        : null;
    const $graveyardBtn =$(html).find(".living-graveyard-btn, .titan-drop-btn");

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
                notify("info", "Living Graveyard dismissed.");
                deck.render(false);
            });
        } else {
            $graveyardBtn.off("click").on("click", async (e) => {
                e.preventDefault();
                e.stopPropagation();

                if (deck._isPlacingGraveyard) {
                    return notify("warn", "You are already placing a Graveyard! Right-click the canvas to cancel first.");
                }
                deck._isPlacingGraveyard = true;

                const actor = game.actors.get(deck.necroId) || game.user.character;
                if (!actor) { deck._isPlacingGraveyard = false; return; }

                const spell = actor.items.find(i => i.name === "Living Graveyard");
                if (!spell) { deck._isPlacingGraveyard = false; return notify("warn", "Living Graveyard spell not found on your sheet."); }

                const currentFocus = actor.system?.resources?.focus?.value || 0;
                if (currentFocus === 0) { deck._isPlacingGraveyard = false; return notify("warn", "You have no Focus Points to cast Living Graveyard!"); }

                await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                const graveyardActor = await getOrImportActor("Living Graveyard");
                if (!graveyardActor) { deck._isPlacingGraveyard = false; return; }

                placementHint("Click to place the Living Graveyard within 120 feet. Right-click to cancel.");
                document.body.style.cursor = "crosshair";
                canvas.app.view.style.cursor = "crosshair";

                const { necroCenter, rangeIndicator } = createRangeIndicator(actor, 120);
                const gridSize = canvas.grid.size;
                const ghost = new PIXI.Graphics();
                ghost.beginFill(0x1f2937, 0.4);
                ghost.lineStyle(2, 0x4b5563, 0.9);
                ghost.drawRect(0, 0, gridSize * 4, gridSize * 4);
                ghost.endFill();
                ghost.zIndex = 1000;
                canvas.tokens.addChild(ghost);

                const updateHUD = attachGhostHUD(ghost, { width: gridSize * 4, height: gridSize * 4, necroCenter, maxRange: 120, getCountText: () => "Living Graveyard" });
                const updateGhost = (evt) => {
                    const pos = evt.data.getLocalPosition(canvas.app.stage);
                    const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                    ghost.position.set(snapped.x, snapped.y);
                    updateHUD(snapped.x, snapped.y);
                };

                canvas.stage.on("pointermove", updateGhost);

                const cleanUp = () => {
                    deck._isPlacingGraveyard = false;
                    document.body.style.cursor = "";
                    canvas.app.view.style.cursor = "";
                    canvas.stage.off("pointermove", updateGhost);
                    if (ghost && !ghost.destroyed) ghost.destroy();
                    if (rangeIndicator) rangeIndicator.destroy();
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
                        const dist = (Math.max(Math.abs(necroCenter.x - targetCenter.x), Math.abs(necroCenter.y - targetCenter.y)) / canvas.grid.size) * canvas.scene.grid.distance;
                        if (dist > 120) {
                            notify("warn", "The Living Graveyard must be placed within 120 feet.");
                            canvas.stage.once("pointerdown", interactionHandler);
                            return;
                        }
                    }

                    cleanUp();

                    let payload = (await graveyardActor.getTokenDocument()).toObject();
                    payload.x = snapped.x;
                    payload.y = snapped.y;
                    payload.name = "Living Graveyard";
                    payload.delta = { ownership: { [game.user.id]: 3 } };
                    payload.flags = { "necromancer-thrall-helper": { masterId: actor.id, isLivingGraveyard: true } };
                    payload = await applyCustomVisuals(payload, actor, "graveyard");

                    const spawned = await executeSpawn(payload);
                    const spawnedId = spawned?.[0]?.id || spawned?.[0]?._id;
                    let newTokenDoc = null;
                    for (let i = 0; i < 20; i++) {
                        newTokenDoc = canvas.scene?.tokens?.get(spawnedId);
                        if (newTokenDoc?.actor) break;
                        await new Promise(r => setTimeout(r, 100));
                    }

                    if (newTokenDoc && newTokenDoc.actor) {
                        await newTokenDoc.actor.createEmbeddedDocuments("Item", [{
                            name: "Living Graveyard Logic",
                            type: "effect",
                            img: "icons/environment/wilderness/monolith-stone-grey.webp",
                            system: { duration: { value: 1, unit: "minutes", expiry: "turn-start" }, rules: [] },
                            flags: { "necromancer-thrall-helper": { isLivingGraveyard: true } }
                        }]);

                        const [templateDoc] = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{
                            t: "circle",
                            user: game.user.id,
                            x: snapped.x + (gridSize * 2),
                            y: snapped.y + (gridSize * 2),
                            distance: 20,
                            fillColor: effectColor(actor, "graveyard", game.user.color?.css ?? game.user.color ?? "#4b5563"),
                            borderColor: zoneBorderColor(actor),
                            fillAlpha: 0.15,
                            flags: {}
                        }]);

                        const templateId = templateDoc ? templateDoc.id : null;
                        if (templateId) {
                            await newTokenDoc.update({ "flags.necromancer-thrall-helper.graveyardTemplateId": templateId });
                        }

                        const exactDC = getSpellDC(actor);
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
                            targetsData[t.id] = { id: t.id, name: t.name, img: tokenPortrait(t.document), hasRolled: false, isHealing: false, isImmune: false, hasApplied: false };
                        });

                        const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
                        const aoeHtmlContent = await renderTemplate(templatePath, {
                            targets: Object.values(targetsData),
                            itemName: "Living Graveyard",
                            saveType: "Fortitude",
                            saveDC: exactDC
                        });

                        await ChatMessage.create({
                            speaker: ChatMessage.getSpeaker({ actor }),
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
                                    templateId,
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
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!actor) return;
            await executeSheddingMatrix(actor, 5);
        });
    }
}