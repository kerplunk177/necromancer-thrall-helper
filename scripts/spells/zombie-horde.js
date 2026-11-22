import { executeDelete, executeHazard } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { getSpellDC, getTokenDistance, snapTopLeft, buildNecroSpellData } from "./spell-helpers.js";
import { NecroDialog } from "../ui/necro-dialog.js";
import { createNecroCard } from "../system/necro-card.js";

export function bindZombieHordeButtons(deck, html) {
    const sustainBtn = html.querySelector(".sustain-horde-btn");
    if (sustainBtn) {
        sustainBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!canvas.scene || !actor) return;

            const anchors = canvas.scene.tokens.filter(t =>
                t.getFlag("necromancer-thrall-helper", "masterId") === deck.necroId &&
                t.getFlag("necromancer-thrall-helper", "isHordeAnchor")
            );
            if (anchors.length === 0) return notify("warn", "No active Zombie Horde found on the scene.");

            const anchor = anchors[0];
            const gridDist = canvas.scene.grid.distance || 5;
            const gridSize = canvas.scene.grid.size || 100;
            const currentRadiusFeet = anchor.getFlag("necromancer-thrall-helper", "hordeRadius") || 10;
            const currentRadiusPixels = (currentRadiusFeet / gridDist) * gridSize;

            placementHint("Click the canvas to Sustain and move the Zombie Horde. Right-click to cancel.");
            document.body.style.cursor = "crosshair";
            canvas.app.view.style.cursor = "crosshair";

            const ghost = new PIXI.Graphics();
            ghost.beginFill(0x228b22, 0.35);
            ghost.lineStyle(2, 0x006400, 0.8);
            ghost.drawCircle((anchor.width * gridSize) / 2, (anchor.height * gridSize) / 2, currentRadiusPixels);
            ghost.endFill();
            ghost.zIndex = 1000;
            ghost.position.set(-1000, -1000);
            canvas.tokens.addChild(ghost);

            const updateGhost = (event) => {
                const pos = event.data.getLocalPosition(canvas.app.stage);
                const snapped = snapTopLeft(pos);
                ghost.position.set(snapped.x, snapped.y);
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
                    notify("info", "Zombie Horde movement cancelled.");
                    cleanUp();
                    return;
                }

                const pos = event.data.getLocalPosition(canvas.app.stage);
                const snapped = snapTopLeft(pos);
                const destCenterX = snapped.x + (anchor.width * gridSize) / 2;
                const destCenterY = snapped.y + (anchor.height * gridSize) / 2;

                cleanUp();

                let newRadiusFeet = currentRadiusFeet;
                const consumedThralls = canvas.scene.tokens.filter(t => {
                    if (t.id === anchor.id) return false;
                    if (t.getFlag("necromancer-thrall-helper", "isHordeAnchor")) return false;
                    if (t.getFlag("necromancer-thrall-helper", "masterId") !== actor.id) return false;
                    const tCenterX = t.x + (t.width * gridSize) / 2;
                    const tCenterY = t.y + (t.height * gridSize) / 2;
                    return Math.hypot(tCenterX - destCenterX, tCenterY - destCenterY) <= currentRadiusPixels;
                });

                if (consumedThralls.length > 0) {
                    newRadiusFeet = Math.min(30, currentRadiusFeet + (5 * consumedThralls.length));
                    for (const t of consumedThralls) {
                        await executeDelete(t.id);
                    }

                    if (newRadiusFeet > currentRadiusFeet) {
                        createNecroCard({
                            speaker: ChatMessage.getSpeaker({ actor }),
                            content: `<p><strong>Zombie Horde Feasts!</strong> By moving over its own thralls, the horde consumes ${consumedThralls.length} of them instantly, swelling its radius to ${newRadiusFeet} feet!</p>`
                        });
                    }
                }

                await anchor.update({
                    x: snapped.x,
                    y: snapped.y,
                    "flags.necromancer-thrall-helper.hordeRadius": newRadiusFeet
                });
            };

            canvas.stage.once("pointerdown", interactionHandler);
        });
    }

    const dismissHordeBtn = html.querySelector(".dismiss-horde-btn");
    if (dismissHordeBtn) {
        dismissHordeBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            if (!canvas.scene) return;
            const anchors = canvas.scene.tokens.filter(t =>
                t.getFlag("necromancer-thrall-helper", "masterId") === deck.necroId &&
                t.getFlag("necromancer-thrall-helper", "isHordeAnchor")
            );
            for (const a of anchors) {
                const rIds = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "anchorId") === a.id).map(r => r.id);
                const dIds = canvas.scene.drawings.filter(d => d.getFlag("necromancer-thrall-helper", "anchorId") === a.id).map(d => d.id);
                if (rIds.length || dIds.length) {
                    globalThis.NecroThrallHelper.purgeGraphics(canvas.scene.id, { regionIds: rIds, drawingIds: dIds });
                }
                await executeDelete(a.id);
            }
            notify("info", "Zombie Horde dismissed.");
            setTimeout(() => deck.render({ force: false }), 150);
        });
    }
}

export async function executeZombieHorde({ deck, actor, tokenDoc }) {
    const currentFocus = actor.system?.resources?.focus?.value || 0;
    if (currentFocus === 0) return notify("warn", "You have no Focus Points to cast Zombie Horde!");

    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length > 0 && getTokenDistance(tokenDoc, necroTokens[0]) > 30) {
        return notify("warn", "You must be within 30 feet of the thrall to cast Zombie Horde.");
    }

    await actor.update({ "system.resources.focus.value": currentFocus - 1 });

    const spellRank = Math.max(3, Math.ceil(actor.level / 2));
    const diceCount = spellRank;
    const exactDC = getSpellDC(actor);

    let zhSpell = actor.items.find(i => ["spell", "feat", "action"].includes(i.type) && i.name === "Zombie Horde");
    const spellSystemData = {
        level: { value: spellRank },
        traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
        tradition: { value: "divine" },
        defense: { save: { statistic: "fortitude", basic: true, dc: { value: exactDC } } },
        damage: { "0": { formula: `${diceCount}d4`, type: "bludgeoning" } }
    };

    if (!zhSpell) {
        const created = await actor.createEmbeddedDocuments("Item", [await buildNecroSpellData("Zombie Horde", "systems/pf2e/icons/spells/animate-dead.webp", spellSystemData)]);
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

    new NecroDialog({
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
                        "texture.src": "systems/pf2e/icons/spells/animate-dead.webp",
                        "flags.necromancer-thrall-helper.isHordeAnchor": true,
                        "flags.necromancer-thrall-helper.hordeRadius": 10
                    });

                    const regionData = {
                        name: "Zombie Horde",
                        color: "#228b22",
                        shapes: [{ type: "ellipse", hole: false, x: centerX, y: centerY, radiusX: pixels, radiusY: pixels, rotation: 0 }],
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
                            "necromancer-thrall-helper": { anchorId: tokenDoc.id, masterId: actor.id },
                            "aoe-easy-resolve": { isAoERegion: true, originItemUuid: zhSpell.uuid, saveDC: exactDC }
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
                        flags: { "necromancer-thrall-helper": { anchorId: tokenDoc.id, masterId: actor.id } }
                    };

                    await executeHazard(regionData, drawingData);
                    deck?.render({ force: false });

                    await createNecroCard({
                        speaker: ChatMessage.getSpeaker({ actor }),
                        flavor: `<strong>Zombie Horde</strong>`,
                        content: `<p><b>${actor.name}</b> rips open the earth, unleashing a horde of ravenous zombies! The area is difficult terrain and deals damage to enemies beginning their turn inside it.</p>`
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "spawn"
    }).render(true);
}