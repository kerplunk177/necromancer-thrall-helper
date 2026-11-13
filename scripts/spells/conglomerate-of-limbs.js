import { executeSpawn } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { getOrImportActor, applyCustomVisuals, createRangeIndicator, attachGhostHUD } from "./spell-helpers.js";

export function bindConglomerateButton(deck, html) {
    const conjureConglomBtn = html.querySelector(".conjure-conglom-btn");
    if (!conjureConglomBtn) return;

    conjureConglomBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        const actor = game.actors.get(deck.necroId) || game.user.character;
        if (!actor) return notify("warn", "No Necromancer found!");
        const conglomActor = await getOrImportActor("Conglomerate of Limbs");
        if (!conglomActor) return;

        const currentFocus = actor.system?.resources?.focus?.value || 0;
        if (currentFocus === 0) return notify("warn", "You have no Focus Points to conjure the Conglomerate!");

        await actor.update({ "system.resources.focus.value": currentFocus - 1 });

        const spellRank = Math.max(4, Math.ceil(actor.level / 2));
        const bonusHP = Math.max(0, spellRank - 4) * 10;
        const totalHP = 40 + bonusHP;

        placementHint("Click the canvas to place the Huge Conglomerate within 30 feet. Right-click to cancel.");
        document.body.style.cursor = "crosshair";
        canvas.app.view.style.cursor = "crosshair";

        const { necroCenter, rangeIndicator } = createRangeIndicator(actor, 30);
        const gridSize = canvas.grid.size;
        const ghost = new PIXI.Graphics();
        ghost.beginFill(0x550000, 0.4);
        ghost.lineStyle(2, 0xff0000, 0.8);
        ghost.drawRect(0, 0, gridSize * 3, gridSize * 3);
        ghost.endFill();
        ghost.zIndex = 1000;
        ghost.position.set(-1000, -1000);
        canvas.tokens.addChild(ghost);

        const updateHUD = attachGhostHUD(ghost, { width: gridSize * 3, height: gridSize * 3, necroCenter, maxRange: 30, getCountText: () => "Conglomerate" });
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
                await actor.update({ "system.resources.focus.value": currentFocus });
                notify("info", "Conjuration cancelled.");
                cleanUp();
                return;
            }

            const position = event.data.getLocalPosition(canvas.app.stage);
            const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(position) : position;

            if (necroCenter) {
                const targetCenter = { x: snapped.x + (gridSize * 1.5), y: snapped.y + (gridSize * 1.5) };
                const dist = (Math.max(Math.abs(necroCenter.x - targetCenter.x), Math.abs(necroCenter.y - targetCenter.y)) / gridSize) * canvas.scene.grid.distance;
                if (dist > 30) {
                    notify("warn", "The Conglomerate must be placed within 30 feet.");
                    canvas.stage.once("pointerdown", interactionHandler);
                    return;
                }
            }

            cleanUp();

            const tokenDoc = await conglomActor.getTokenDocument({ x: snapped.x, y: snapped.y });
            const finalPayload = foundry.utils.mergeObject(tokenDoc.toObject(), {
                actorLink: false,
                ownership: { [game.user.id]: 3 },
                flags: { "necromancer-thrall-helper": { masterId: actor.id } },
                elevation: actor?.getActiveTokens()[0]?.document?.elevation || 0,
                delta: {
                    ownership: { [game.user.id]: 3 },
                    system: { attributes: { hp: { value: totalHP, max: totalHP } } }
                }
            });
            await applyCustomVisuals(finalPayload, actor, "conglom");

            executeSpawn(finalPayload).then(() => {
                ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor }),
                    flavor: `<strong>Conglomerate of Limbs</strong>`,
                    content: `<p><b>${actor.name}</b> conjures a hulking mass of severed limbs to the battlefield!</p>`
                });
            }).catch(err => console.error("Necromancer Helper | Spawn failed:", err));
        };

        canvas.stage.once("pointerdown", interactionHandler);
    });
}