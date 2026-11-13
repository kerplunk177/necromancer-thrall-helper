import { createSpawnBatch } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { buildTendrilEffect, noteZoneVisibility, getZoneConfig } from "../system/tendril-zone.js";
import { getSpellDC, getOrImportActor, applyCustomVisuals, createRangeIndicator, attachGhostHUD } from "./spell-helpers.js";

export function bindBloodyTendrilsButton(deck, html) {
    const conjureBtn = html.querySelector(".conjure-tendrils-btn");
    if (!conjureBtn) return;

    conjureBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        const actor = game.actors.get(deck.necroId) || game.user.character;
        if (!actor) return notify("warn", "No Necromancer found!");

        const sRank = Math.max(1, Math.ceil(actor.level / 2));
        const count = 3 + Math.floor(Math.max(0, sRank - 3) / 3);

        const tendrilActor = await getOrImportActor("Bloody Tendril");
        if (!tendrilActor) return;

        const currentFocus = actor.system?.resources?.focus?.value || 0;
        if (currentFocus === 0) return notify("warn", "You have no Focus Points to conjure tendrils!");

        await actor.update({ "system.resources.focus.value": currentFocus - 1 });

        const spellRank = Math.ceil(actor.level / 2);
        const diceCount = 1 + Math.floor(Math.max(0, spellRank - 3) / 3);
        const exactDC = getSpellDC(actor);

        let tendrilsSpell = actor.items.find(i => ["spell", "feat", "action"].includes(i.type) && (i.name.toLowerCase().includes("bloody tendrils") || i.system?.slug?.includes("bloody-tendrils")));
        const spellSystemData = {
            level: { value: spellRank },
            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
            tradition: { value: "divine" },
            defense: { save: { statistic: "reflex", basic: true, dc: { value: exactDC } } },
            damage: { "0": { formula: `${diceCount}d12`, type: "bludgeoning" } }
        };

        if (!tendrilsSpell) {
            const created = await actor.createEmbeddedDocuments("Item", [{ name: "Bloody Tendrils", type: "spell", img: "icons/skills/wounds/blood-spurt-spray-red.webp", system: spellSystemData }]);
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

        const batch = createSpawnBatch();
        let currentSpawnIndex = 0;
        placementHint(`Click the canvas to place Tendril ${currentSpawnIndex + 1} within 30 feet. Right-click to stop.`);
        document.body.style.cursor = "crosshair";
        canvas.app.view.style.cursor = "crosshair";

        const { necroCenter, rangeIndicator } = createRangeIndicator(actor, 30);
        const gridSize = canvas.grid.size;
        const ghost = new PIXI.Graphics();
        const zoneAlpha = getZoneConfig(actor).alpha;
        ghost.beginFill(0xc0392b, zoneAlpha / 3);
        ghost.lineStyle(2, 0xc0392b, Math.max(0.4, zoneAlpha));
        ghost.drawCircle(gridSize / 2, gridSize / 2, gridSize * 2.5);
        ghost.endFill();
        ghost.beginFill(0x990000, 0.4);
        ghost.lineStyle(2, 0x990000, 0.8);
        ghost.drawCircle(gridSize / 2, gridSize / 2, gridSize / 2);
        ghost.endFill();
        ghost.zIndex = 1000;
        ghost.position.set(-1000, -1000);
        canvas.tokens.addChild(ghost);

        const updateHUD = attachGhostHUD(ghost, { necroCenter, maxRange: 30, getCountText: () => `Tendril ${currentSpawnIndex + 1} / ${count}` });
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
                    placementHint(`Place Tendril ${currentSpawnIndex + 1} of ${count}. Right-click or Esc undoes the last one; Enter sends early.`);
                    canvas.stage.once("pointerdown", interactionHandler);
                    return;
                }
                batch.cancel();
                if (currentSpawnIndex === 0) {
                    await actor.update({ "system.resources.focus.value": currentFocus });
                    notify("info", "Conjuration cancelled.");
                } else {
                    notify("info", `Placed ${currentSpawnIndex} tendril(s).`);
                }
                cleanUp();
                return;
            }

            const position = event.data.getLocalPosition(canvas.app.stage);
            const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(position) : position;

            if (necroCenter) {
                const targetCenter = { x: snapped.x + (gridSize * 0.5), y: snapped.y + (gridSize * 0.5) };
                const dist = (Math.max(Math.abs(necroCenter.x - targetCenter.x), Math.abs(necroCenter.y - targetCenter.y)) / canvas.grid.size) * canvas.scene.grid.distance;
                if (dist > 30) {
                    notify("warn", "Bloody Tendrils must be placed within 30 feet.");
                    canvas.stage.once("pointerdown", interactionHandler);
                    return;
                }
            }

            const tetherId = foundry.utils.randomID();
            const tokenDoc = await tendrilActor.getTokenDocument({ x: snapped.x, y: snapped.y });
            const finalPayload = foundry.utils.mergeObject(tokenDoc.toObject(), {
                actorLink: false,
                ownership: { [game.user.id]: 3 },
                flags: { "necromancer-thrall-helper": { masterId: actor.id, tendrilTetherId: tetherId } },
                elevation: actor?.getActiveTokens()[0]?.document?.elevation || 0,
                delta: { ownership: { [game.user.id]: 3 } }
            });
            await applyCustomVisuals(finalPayload, actor, "tendril");

            const auraFeet = 2 * canvas.scene.grid.distance;
            finalPayload.delta = finalPayload.delta || {};
            const { effect: zoneEffect, pending: zonePending } = await buildTendrilEffect(actor, auraFeet);
            finalPayload.delta.items = [...(finalPayload.delta.items || []), zoneEffect];
            if (zonePending) foundry.utils.setProperty(finalPayload, "flags.necromancer-thrall-helper.pendingZone", zonePending);

            currentSpawnIndex++;

            const regionData = {
                name: "Bloody Tendril Hazard",
                color: "#880000",
                shapes: [{
                    type: "ellipse",
                    hole: false,
                    x: snapped.x + (gridSize / 2),
                    y: snapped.y + (gridSize / 2),
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
                        source: `if (game.modules.get('aoe-easy-resolve')?.api?.handleRegionEvent) {\n  game.modules.get('aoe-easy-resolve').api.handleRegionEvent(event, '${tendrilsSpell.uuid}');\n}`
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

            await batch.add(finalPayload, { region: regionData });

            if (currentSpawnIndex < count) {
                placementHint(`Place Tendril ${currentSpawnIndex + 1} of ${count}. Right-click or Esc undoes the last one; Enter sends early.`);
                canvas.stage.once("pointerdown", interactionHandler);
            } else {
                cleanUp();
                batch.finish();
                notify("info", "All tendrils placed.");
            }
        };

        batch.bindKeys({
            onUndo: () => { currentSpawnIndex--; placementHint(`Place Tendril ${currentSpawnIndex + 1} of ${count}. Right-click or Esc undoes the last one; Enter sends early.`); },
            onCancel: () => { canvas.stage.off("pointerdown", interactionHandler); if (currentSpawnIndex === 0) actor.update({ "system.resources.focus.value": currentFocus }); cleanUp(); },
            onFinish: () => { canvas.stage.off("pointerdown", interactionHandler); cleanUp(); }
        });
        noteZoneVisibility();
        canvas.stage.once("pointerdown", interactionHandler);
    });
}