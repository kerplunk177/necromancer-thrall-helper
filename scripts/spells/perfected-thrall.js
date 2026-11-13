import { executeSpawn } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { getOrImportActor, createRangeIndicator, attachGhostHUD } from "./spell-helpers.js";

export function bindPerfectedThrallButton(deck, html) {
    $(html).off("click", "button:contains('Perfected'), .conjure-perfected-btn")
        .on("click", "button:contains('Perfected'), .conjure-perfected-btn", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!actor) return notify("warn", "No Necromancer found!");

            const currentFocus = actor.system?.resources?.focus?.value || 0;
            if (currentFocus === 0) return notify("warn", "You have no Focus Points to conjure a Perfected Thrall!");

            const perfActor = await getOrImportActor("Perfected Thrall");
            if (!perfActor) return;

            await actor.update({ "system.resources.focus.value": currentFocus - 1 });

            placementHint("Click the canvas to place the Perfected Thrall within 60 feet. Right-click to cancel.");
            document.body.style.cursor = "crosshair";
            canvas.app.view.style.cursor = "crosshair";

            const { necroCenter, rangeIndicator } = createRangeIndicator(actor, 60);
            const gridSize = canvas.grid.size;
            const ghost = new PIXI.Graphics();
            ghost.beginFill(0x9333ea, 0.35);
            ghost.lineStyle(2, 0x7e22ce, 0.9);
            ghost.drawRect(0, 0, gridSize, gridSize);
            ghost.endFill();
            ghost.zIndex = 1000;
            ghost.position.set(-1000, -1000);
            canvas.tokens.addChild(ghost);

            const updateHUD = attachGhostHUD(ghost, { necroCenter, maxRange: 60, getCountText: () => "Perfected Thrall" });
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
                    await actor.update({ "system.resources.focus.value": currentFocus });
                    cleanUp();
                    return;
                }

                const pos = evt.data.getLocalPosition(canvas.app.stage);
                const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;

                if (necroCenter) {
                    const targetCenter = { x: snapped.x + (gridSize * 0.5), y: snapped.y + (gridSize * 0.5) };
                    const dist = (Math.max(Math.abs(necroCenter.x - targetCenter.x), Math.abs(necroCenter.y - targetCenter.y)) / canvas.grid.size) * canvas.scene.grid.distance;
                    if (dist > 60) {
                        notify("warn", "The Perfected Thrall must be placed within 60 feet.");
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
                    elevation: actor?.getActiveTokens()[0]?.document?.elevation || 0,
                    delta: { ownership: { [game.user.id]: 3 } }
                });

                await executeSpawn(finalPayload).catch(err => console.error(err));
            };

            canvas.stage.once("pointerdown", interactionHandler);
        });
}