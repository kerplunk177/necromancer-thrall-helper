import { executeHazard } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { getSpellDC, getTokenDistance } from "./spell-helpers.js";

export function bindZombieHordeButtons(deck, html) {
    const sustainBtn = html.querySelector(".sustain-horde-btn");
    if (sustainBtn) {
        sustainBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!canvas.scene || !actor) return;

            const hordes = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "masterId") === deck.necroId && r.getFlag("necromancer-thrall-helper", "hordeId"));
            if (hordes.length === 0) return;

            const horde = hordes[0];
            const shape = horde.shapes[0];
            if (!shape) return;

            const gridDist = canvas.scene.grid.distance;
            const gridSize = canvas.scene.grid.size;

            placementHint("Click the canvas to Sustain and move the Zombie Horde. Right-click to cancel.");
            document.body.style.cursor = "crosshair";
            canvas.app.view.style.cursor = "crosshair";

            const ghost = new PIXI.Graphics();
            ghost.beginFill(0x228b22, 0.4);
            ghost.lineStyle(2, 0x006400, 0.8);
            ghost.drawCircle(0, 0, shape.radiusX);
            ghost.endFill();
            ghost.zIndex = 1000;
            ghost.position.set(-1000, -1000);
            canvas.tokens.addChild(ghost);

            const updateGhost = (event) => {
                const position = event.data.getLocalPosition(canvas.app.stage);
                const snapped = canvas.grid.getCenterPoint ? canvas.grid.getCenterPoint(position) : position;
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
                    notify("info", "Movement cancelled.");
                    cleanUp();
                    return;
                }

                const position = event.data.getLocalPosition(canvas.app.stage);
                const snapped = canvas.grid.getCenterPoint ? canvas.grid.getCenterPoint(position) : position;
                const targetX = snapped.x;
                const targetY = snapped.y;

                let newRadius = shape.radiusX;
                const thralls = canvas.scene.tokens.filter(t => {
                    if (t.flags?.["necromancer-thrall-helper"]?.masterId !== actor.id) return false;
                    const tCenterX = t.x + (t.width * gridSize) / 2;
                    const tCenterY = t.y + (t.height * gridSize) / 2;
                    return Math.hypot(tCenterX - targetX, tCenterY - targetY) <= shape.radiusX;
                });

                if (thralls.length > 0) {
                    const incrementPixels = (5 / gridDist) * gridSize;
                    const maxPixels = horde.getFlag("necromancer-thrall-helper", "maxPixels") || ((30 / gridDist) * gridSize);
                    newRadius = Math.min(maxPixels, newRadius + (incrementPixels * thralls.length));
                    for (const t of thralls) await t.delete();

                    if (newRadius > shape.radiusX) {
                        ChatMessage.create({
                            speaker: ChatMessage.getSpeaker({ actor }),
                            content: `<p><strong>Zombie Horde Feasts!</strong> By moving over its own thralls, the horde consumes ${thralls.length} of them instantly, swelling its radius to ${Math.round((newRadius / gridSize) * gridDist)} feet!</p>`
                        });
                    }
                }

                await horde.update({
                    shapes: [{ type: "ellipse", hole: false, x: targetX, y: targetY, radiusX: newRadius, radiusY: newRadius, rotation: 0 }]
                });

                const hordeId = horde.getFlag("necromancer-thrall-helper", "hordeId");
                const drawing = canvas.scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "hordeId") === hordeId);
                if (drawing) {
                    await drawing.update({
                        shape: { type: "e", width: newRadius * 2, height: newRadius * 2 },
                        x: targetX - newRadius,
                        y: targetY - newRadius
                    });
                }

                cleanUp();
            };

            canvas.stage.once("pointerdown", interactionHandler);
        });
    }

    const dismissHordeBtn = html.querySelector(".dismiss-horde-btn");
    if (dismissHordeBtn) {
        dismissHordeBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            if (!canvas.scene) return;
            const hordes = canvas.scene.regions.filter(r => r.getFlag("necromancer-thrall-helper", "masterId") === deck.necroId && r.getFlag("necromancer-thrall-helper", "hordeId"));
            for (const h of hordes) {
                const hId = h.getFlag("necromancer-thrall-helper", "hordeId");
                const drawing = canvas.scene.drawings.find(d => d.getFlag("necromancer-thrall-helper", "hordeId") === hId);
                if (drawing) await drawing.delete();
                await h.delete();
            }
            notify("info", "Zombie Horde dismissed.");
            deck.render({ force: false });
        });
    }
}

export async function executeZombieHorde({ actor, tokenDoc }) {
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
        const created = await actor.createEmbeddedDocuments("Item", [{ name: "Zombie Horde", type: "spell", img: "icons/magic/death/undead-zombies-horde-green.webp", system: spellSystemData }]);
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

    new Dialog({
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
                        "texture.src": "icons/magic/death/undead-zombies-horde-green.webp",
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
                            "necromancer-thrall-helper": { anchorId: tokenDoc.id },
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
                        flags: { "necromancer-thrall-helper": { anchorId: tokenDoc.id } }
                    };

                    await executeHazard(regionData, drawingData);

                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor }),
                        flavor: `<strong>Zombie Horde</strong>`,
                        content: `<p><b>${actor.name}</b> rips open the earth, unleashing a horde of ravenous zombies! The area is difficult terrain and deals damage to enemies beginning their turn inside it.</p>`
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "spawn"
    }, { classes: ["dialog", "necro-thrall", "thrall-summon-dialog"] }).render(true);
}