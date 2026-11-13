import { createSpawnBatch } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { getOrImportActor, applyCustomVisuals, createRangeIndicator, attachGhostHUD } from "./spell-helpers.js";

export function bindSkeletalLancersButton(deck, html) {
    const lancersBtn = html.querySelector(".conjure-lancers-btn");
    if (!lancersBtn) return;

    lancersBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        const actor = game.actors.get(deck.necroId) || game.user.character;
        if (!actor) return;

        const currentFocus = actor.system?.resources?.focus?.value || 0;
        if (currentFocus === 0) return notify("warn", "You have no Focus Points to cast Skeletal Lancers!");

        const lancerActor = await getOrImportActor("Skeletal Lancer");
        if (!lancerActor) return;

        await actor.update({ "system.resources.focus.value": currentFocus - 1 });

        const batch = createSpawnBatch();
        let currentSpawnIndex = 0;
        const maxSpawns = 5;

        placementHint(`Click the canvas to place Skeletal Lancer 1 of ${maxSpawns} within 60 feet. Right-click or Esc undoes the last one; Enter sends early.`);
        document.body.style.cursor = "crosshair";
        canvas.app.view.style.cursor = "crosshair";

        const { necroCenter, rangeIndicator } = createRangeIndicator(actor, 60);
        const gridSize = canvas.grid.size;
        const ghost = new PIXI.Graphics();
        ghost.beginFill(0xd97706, 0.35);
        ghost.lineStyle(2, 0xb45309, 0.9);
        ghost.drawRect(0, 0, gridSize, gridSize);
        ghost.endFill();
        ghost.zIndex = 1000;
        ghost.position.set(-1000, -1000);
        canvas.tokens.addChild(ghost);

        const updateHUD = attachGhostHUD(ghost, { necroCenter, maxRange: 60, getCountText: () => `Lancer ${currentSpawnIndex + 1} / ${maxSpawns}` });
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
                if (batch.undo()) {
                    currentSpawnIndex--;
                    placementHint(`Place Skeletal Lancer ${currentSpawnIndex + 1} of ${maxSpawns}. Right-click or Esc undoes the last one; Enter sends early.`);
                    canvas.stage.once("pointerdown", interactionHandler);
                    return;
                }
                batch.cancel();
                if (currentSpawnIndex === 0) await actor.update({ "system.resources.focus.value": currentFocus });
                cleanUp();
                notify("info", `Finished summoning ${currentSpawnIndex} Skeletal Lancer(s).`);
                return;
            }

            const pos = evt.data.getLocalPosition(canvas.app.stage);
            const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;

            if (necroCenter) {
                const targetCenter = { x: snapped.x + (gridSize * 0.5), y: snapped.y + (gridSize * 0.5) };
                const dist = (Math.max(Math.abs(necroCenter.x - targetCenter.x), Math.abs(necroCenter.y - targetCenter.y)) / canvas.grid.size) * canvas.scene.grid.distance;
                if (dist > 60) {
                    notify("warn", "Skeletal Lancers must be placed within 60 feet.");
                    canvas.stage.once("pointerdown", interactionHandler);
                    return;
                }
            }

            const tokenDoc = await lancerActor.getTokenDocument({ x: snapped.x, y: snapped.y });
            const finalPayload = foundry.utils.mergeObject(tokenDoc.toObject(), {
                actorLink: false,
                ownership: { [game.user.id]: 3 },
                flags: { "necromancer-thrall-helper": { masterId: actor.id, isSkeletalLancer: true } },
                elevation: actor?.getActiveTokens()[0]?.document?.elevation || 0,
                delta: { ownership: { [game.user.id]: 3 } }
            });
            await applyCustomVisuals(finalPayload, actor, "lancer");

            currentSpawnIndex++;
            await batch.add(finalPayload);

            if (currentSpawnIndex < maxSpawns) {
                placementHint(`Place Skeletal Lancer ${currentSpawnIndex + 1} of ${maxSpawns}. Right-click to stop.`);
                canvas.stage.once("pointerdown", interactionHandler);
            } else {
                cleanUp();
                batch.finish();
                notify("info", "All 5 Skeletal Lancers deployed.");
            }
        };

        batch.bindKeys({
            onUndo: () => { currentSpawnIndex--; placementHint(`Place Skeletal Lancer ${currentSpawnIndex + 1} of ${maxSpawns}.`); },
            onCancel: () => { canvas.stage.off("pointerdown", interactionHandler); if (currentSpawnIndex === 0) actor.update({ "system.resources.focus.value": currentFocus }); cleanUp(); },
            onFinish: () => { canvas.stage.off("pointerdown", interactionHandler); cleanUp(); }
        });
        canvas.stage.once("pointerdown", interactionHandler);
    });
}