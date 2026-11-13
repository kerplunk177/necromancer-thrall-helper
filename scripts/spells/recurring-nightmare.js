import { executeSpawn } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { getOrImportActor, applyCustomVisuals, createRangeIndicator, attachGhostHUD } from "./spell-helpers.js";

export function bindRecurringNightmareButtons(deck, html) {
    const nightmareBtn = html.querySelector(".conjure-nightmare-btn, .sustain-nightmare-btn");
    if (nightmareBtn) {
        nightmareBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const isSustain = e.currentTarget.classList.contains("sustain-nightmare-btn");
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!actor) return;

            const currentCombat = game.combat;
            const currentRound = currentCombat ? `${currentCombat.id}-${currentCombat.round}` : "out-of-combat";

            if (isSustain) {
                const lastSustained = actor.getFlag("necromancer-thrall-helper", "nightmareSustainRound");
                if (currentCombat && lastSustained === currentRound) {
                    return notify("warn", "You can only resummon the Recurring Nightmare once per round.");
                }
            } else {
                const currentFocus = actor.system?.resources?.focus?.value || 0;
                if (currentFocus === 0) return notify("warn", "You have no Focus Points to cast Recurring Nightmare!");
                await actor.update({ "system.resources.focus.value": currentFocus - 1 });
            }

            placementHint("Click the canvas within 60 feet (even on occupied spaces) to manifest the Nightmare. Right-click to cancel.");
            document.body.style.cursor = "crosshair";
            canvas.app.view.style.cursor = "crosshair";

            const { necroCenter, rangeIndicator } = createRangeIndicator(actor, 60);
            const gridSize = canvas.scene.grid.size;
            const ghost = new PIXI.Graphics();
            ghost.beginFill(0x38bdf8, 0.35);
            ghost.lineStyle(2, 0x0284c7, 0.9);
            ghost.drawRect(0, 0, gridSize, gridSize);
            ghost.endFill();
            ghost.zIndex = 1000;
            ghost.position.set(-1000, -1000);
            canvas.tokens.addChild(ghost);

            const updateHUD = attachGhostHUD(ghost, { necroCenter, maxRange: 60, getCountText: () => "Nightmare" });
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
                if (rangeIndicator) rangeIndicator.destroy();
            };

            const interactionHandler = async (evt) => {
                if (evt.data.button !== 0 && evt.data.button !== 2) {
                    canvas.stage.once("pointerdown", interactionHandler);
                    return;
                }
                if (evt.data.button === 2) {
                    if (!isSustain) {
                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                        await actor.update({ "system.resources.focus.value": currentFocus + 1 });
                    }
                    cleanUp();
                    return;
                }

                const pos = evt.data.getLocalPosition(canvas.app.stage);
                const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;

                if (necroCenter) {
                    const targetCenter = { x: snapped.x + (gridSize * 0.5), y: snapped.y + (gridSize * 0.5) };
                    const dist = (Math.max(Math.abs(necroCenter.x - targetCenter.x), Math.abs(necroCenter.y - targetCenter.y)) / canvas.grid.size) * canvas.scene.grid.distance;
                    if (dist > 60) {
                        notify("warn", "The Recurring Nightmare must be placed within 60 feet.");
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
                    flags: { "necromancer-thrall-helper": { masterId: actor.id, isRecurringNightmare: true } },
                    elevation: actor?.getActiveTokens()[0]?.document?.elevation || 0,
                    delta: { ownership: { [game.user.id]: 3 } }
                });
                await applyCustomVisuals(finalPayload, actor, "nightmare");

                const spawned = await executeSpawn(finalPayload);
                const createdTokenId = spawned?.[0]?.id || spawned?.[0]?._id;

                if (isSustain && currentCombat) {
                    await actor.setFlag("necromancer-thrall-helper", "nightmareSustainRound", currentRound);
                }
                await actor.unsetFlag("necromancer-thrall-helper", "nightmareDestroyed");

                let attempts = 0;
                const triggerHaunt = async () => {
                    const liveTokenDoc = canvas.scene?.tokens?.get(createdTokenId);
                    if (liveTokenDoc) {
                        globalThis.NecroThrallHelper?.checkNightmareHaunt(liveTokenDoc);
                    } else if (attempts < 20) {
                        attempts++;
                        setTimeout(triggerHaunt, 100);
                    }
                };
                triggerHaunt();

                deck.render({ force: false });

                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor }),
                    flavor: `<strong>Recurring Nightmare</strong>`,
                    content: `<p><b>${actor.name}</b> ${isSustain ? "Sustains the nightmare, resummoning" : "conjures"} the <b>Recurring Nightmare</b> into reality!</p>`
                });
            };

            canvas.stage.once("pointerdown", interactionHandler);
        });
    }

    const endNightmareBtn = html.querySelector(".end-nightmare-btn");
    if (endNightmareBtn) {
        endNightmareBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!actor) return;
            await actor.unsetFlag("necromancer-thrall-helper", "nightmareDestroyed");
            notify("info", "The Recurring Nightmare fades completely into the ether.");
        });
    }
}