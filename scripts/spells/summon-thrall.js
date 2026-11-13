import { getFatalMethodName, prepareThrallPayload, getThrallPresets, defaultThrallLabel } from "../system/thrall-manager.js";
import { createSpawnBatch } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { effectColorNum } from "../system/effect-colors.js";
import { attachGhostHUD, buildOwnerMap } from "./spell-helpers.js";

export function bindSummonThrallButtons(deck, html) {
    // 1. Standard Create Thrall Buttons (Spawn 1 / 2 / 3 / 4)
    html.querySelectorAll(".spawn-btn").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            let count = parseInt(e.currentTarget.dataset.count, 10);
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!actor) return notify("warn", "No Necromancer found! Please assign a character to your user.");

            const hasPuppeteer = actor.items.some(i =>
                i.name?.toLowerCase().includes("puppeteer") ||
                i.system?.slug?.includes("puppeteer") ||
                i.system?.slug?.includes("thrall-proliferation")
            ) || getFatalMethodName(actor)?.toLowerCase().includes("puppeteer");

            const currentCombat = game.combat;
            const combatRoundKey = currentCombat ? `${currentCombat.id}-${currentCombat.round}` : null;
            const lastUsedRound = actor.getFlag("necromancer-thrall-helper", "proliferationRound");
            const applyProliferation = hasPuppeteer && (!currentCombat || lastUsedRound !== combatRoundKey);

            if (applyProliferation) count += 1;

            const presets = getThrallPresets(actor);
            let optionsHtml = `
                <option value="default">${defaultThrallLabel(actor)}</option>
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
                            const selections = [];
                            const selectedUnique = new Set();

                            for (let i = 0; i < count; i++) {
                                const val = dialogForm.querySelector(`#preset-selector-${i}`).value;
                                const preset = presets.find(p => p.id === val);
                                if (preset && preset.isUnique) {
                                    if (selectedUnique.has(val)) {
                                        notify("error", `Summoning Ritual Failed: ${preset.name} is unique and cannot be summoned multiple times.`);
                                        return;
                                    }
                                    selectedUnique.add(val);
                                }
                                selections.push(val);
                            }

                            const batch = createSpawnBatch();
                            let proliferationAnnounced = false;
                            let currentSpawnIndex = 0;

                            placementHint(`Click the canvas to place Summon ${currentSpawnIndex + 1}. Right-click or Esc undoes the last one; Enter sends early.`);
                            document.body.style.cursor = "crosshair";
                            canvas.app.view.style.cursor = "crosshair";

                            const necroTokens = actor.getActiveTokens();
                            let rangeIndicator = null;
                            if (necroTokens.length > 0) {
                                const masterToken = necroTokens[0];
                                const rangeInPixels = (30 / canvas.scene.grid.distance) * canvas.grid.size;
                                rangeIndicator = new PIXI.Graphics();
                                rangeIndicator.beginFill(effectColorNum(actor, "rangeRing", "#22c55e"), 0.08);
                                rangeIndicator.lineStyle(3, effectColorNum(actor, "rangeRing", "#22c55e"), 0.5);
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

                            const masterCenter = necroTokens.length > 0 ? necroTokens[0].center : null;
                            const updateHUD = attachGhostHUD(ghost, { necroCenter: masterCenter, maxRange: 30, getCountText: () => `Thrall ${currentSpawnIndex + 1} / ${count}` });
                            const updateGhost = (event) => {
                                const position = event.data.getLocalPosition(canvas.app.stage);
                                const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(position) : position;
                                ghost.position.set(snapped.x, snapped.y);
                                updateHUD(snapped.x, snapped.y);
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
                                    if (batch.undo()) {
                                        currentSpawnIndex--;
                                        placementHint(`Place Summon ${currentSpawnIndex + 1}. Right-click or Esc undoes the last one; Enter sends early.`);
                                        canvas.stage.once("pointerdown", interactionHandler);
                                        return;
                                    }
                                    batch.cancel();
                                    notify("info", "Summoning cancelled.");
                                    cleanUp();
                                    return;
                                }

                                const position = event.data.getLocalPosition(canvas.app.stage);
                                const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(position) : position;

                                const presetId = selections[currentSpawnIndex];
                                const basePayload = await prepareThrallPayload(actor, presetId);
                                if (!basePayload) { batch.finish(); cleanUp(); return; }

                                const finalPayload = foundry.utils.mergeObject(basePayload, {
                                    x: snapped.x,
                                    y: snapped.y,
                                    delta: { ownership: buildOwnerMap(actor) }
                                });

                                if (currentSpawnIndex === 0 && applyProliferation && !proliferationAnnounced) {
                                    proliferationAnnounced = true;
                                    if (combatRoundKey) {
                                        await actor.setFlag("necromancer-thrall-helper", "proliferationRound", combatRoundKey);
                                    }
                                    await ChatMessage.create({
                                        speaker: ChatMessage.getSpeaker({ actor }),
                                        content: `<p><strong>Thrall Proliferation!</strong> <b>${actor.name}</b> twists the magic to spawn an additional thrall this round.</p>`
                                    });
                                }

                                currentSpawnIndex++;
                                notify("info", `Summon ${currentSpawnIndex} placed.`);
                                batch.add(finalPayload);

                                if (currentSpawnIndex < count) {
                                    placementHint(`Place Summon ${currentSpawnIndex + 1}.`);
                                    canvas.stage.once("pointerdown", interactionHandler);
                                } else {
                                    cleanUp();
                                    batch.finish();
                                    notify("info", "All summons placed.");
                                }
                            };

                            batch.bindKeys({
                                onUndo: () => { currentSpawnIndex--; placementHint(`Place Summon ${currentSpawnIndex + 1}.`); },
                                onCancel: () => { canvas.stage.off("pointerdown", interactionHandler); cleanUp(); },
                                onFinish: () => { canvas.stage.off("pointerdown", interactionHandler); cleanUp(); }
                            });
                            canvas.stage.once("pointerdown", interactionHandler);
                        }
                    },
                    cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                },
                default: "summon"
            }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
        });
    });

    // 2. Instant Army Button (Up to 20 Thralls)
    const instantArmyBtn = html.querySelector(".instant-army-btn");
    if (instantArmyBtn) {
        instantArmyBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!actor) return;

            if (actor.getFlag("necromancer-thrall-helper", "instantArmyUsed")) {
                return notify("warn", "You have already exhausted your emergency cache today.");
            }

            const presets = typeof getThrallPresets === "function" ? getThrallPresets(actor) : [];
            let optionsHtml = `<option value="default">${defaultThrallLabel(actor)}</option><option value="random">(Random Non-Unique Family Member)</option>`;
            presets.forEach(p => { if (!p.isUnique) optionsHtml += `<option value="${p.id}">${p.name}</option>`; });

            new Dialog({
                title: "Instant Army",
                content: `<p>Call upon your reserve cache to spawn up to <b>20 thralls</b>!</p><form><div class="form-group" style="margin-bottom: 8px;"><label>Thrall Type:</label><select id="army-preset" style="width: 100%;">${optionsHtml}</select></div></form>`,
                buttons: {
                    summon: {
                        icon: '<i class="fas fa-skull"></i>',
                        label: "Arise",
                        callback: async (dHtml) => {
                            const presetId = dHtml.find("#army-preset").val();
                            await actor.setFlag("necromancer-thrall-helper", "instantArmyUsed", true);

                            await ChatMessage.create({
                                speaker: ChatMessage.getSpeaker({ actor }),
                                flavor: `<strong>Instant Army</strong>`,
                                content: `<div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #9333ea;"><p style="margin: 0;"><b>${actor.name}</b> tears the veil, calling upon an emergency reserve of the dead!</p><p style="margin: 4px 0 0 0; font-size: 0.9em; color: #d8b4fe;">Up to 20 thralls emerge from the grave.</p></div>`
                            });

                            const batch = createSpawnBatch();
                            let currentSpawnIndex = 0;
                            const maxSpawns = 20;

                            placementHint(`Click to place Thrall ${currentSpawnIndex + 1} of ${maxSpawns}. Right-click or Esc undoes the last one; Enter sends early.`);
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

                            const updateHUD = attachGhostHUD(ghost, { getCountText: () => `Army ${currentSpawnIndex + 1} / ${maxSpawns}` });
                            const updateGhost = (evt) => {
                                const pos = evt.data.getLocalPosition(canvas.app.stage);
                                const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                                ghost.position.set(snapped.x, snapped.y);
                                updateHUD(snapped.x, snapped.y);
                            };

                            canvas.stage.on("pointermove", updateGhost);

                            const cleanUp = () => {
                                document.body.style.cursor = "";
                                canvas.app.view.style.cursor = "";
                                canvas.stage.off("pointermove", updateGhost);
                                ghost.destroy();
                                if (currentSpawnIndex > 0) notify("info", `Instant Army deployed ${currentSpawnIndex} thrall(s).`);
                                deck.render({ force: false });
                            };

                            const interactionHandler = async (evt) => {
                                if (evt.data.button !== 0 && evt.data.button !== 2) {
                                    canvas.stage.once("pointerdown", interactionHandler);
                                    return;
                                }
                                if (evt.data.button === 2) {
                                    if (batch.undo()) {
                                        currentSpawnIndex--;
                                        placementHint(`Place Thrall ${currentSpawnIndex + 1} of ${maxSpawns}. Right-click or Esc undoes the last one; Enter sends early.`);
                                        canvas.stage.once("pointerdown", interactionHandler);
                                        return;
                                    }
                                    batch.cancel();
                                    cleanUp();
                                    return;
                                }

                                const pos = evt.data.getLocalPosition(canvas.app.stage);
                                const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;

                                const basePayload = await prepareThrallPayload(actor, presetId);
                                if (!basePayload) { batch.finish(); cleanUp(); return; }

                                const finalPayload = foundry.utils.mergeObject(basePayload, {
                                    x: snapped.x,
                                    y: snapped.y,
                                    elevation: actor?.getActiveTokens()[0]?.document?.elevation || 0,
                                    delta: { ownership: { [game.user.id]: 3 } }
                                });

                                currentSpawnIndex++;
                                batch.add(finalPayload);

                                if (currentSpawnIndex < maxSpawns) {
                                    placementHint(`Place Thrall ${currentSpawnIndex + 1} of ${maxSpawns}. Right-click or Esc undoes the last one; Enter sends early.`);
                                    canvas.stage.once("pointerdown", interactionHandler);
                                } else {
                                    cleanUp();
                                    batch.finish();
                                }
                            };

                            batch.bindKeys({
                                onUndo: () => { currentSpawnIndex--; placementHint(`Place Thrall ${currentSpawnIndex + 1} of ${maxSpawns}.`); },
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
        });
    }
}