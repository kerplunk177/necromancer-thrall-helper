import { prepareThrallPayload, getThrallPresets } from "../system/thrall-manager.js";
import { executeSpawn, executeDelete } from "../system/socket.js";
import { notify, placementHint } from "../system/notify.js";
import { getTokenDistance } from "./spell-helpers.js";

export async function executeReanimateFoe({ actor, tokenDoc }) {
    const currentFocus = actor.system?.resources?.focus?.value || 0;
    if (currentFocus === 0) return notify("warn", "You have no Focus Points to cast Reanimate Foe!");

    const loreSkill = Object.values(actor.skills).find(s => s.slug?.includes("undead-lore") || s.label.toLowerCase().includes("undead lore"));
    if (!loreSkill) return notify("warn", "You lack the Undead Lore skill required to weave this magic.");

    const targets = Array.from(game.user.targets);
    if (targets.length !== 1) return notify("warn", "You must target exactly one dead enemy corpse on the canvas.");

    const corpseDoc = targets[0].document;
    const corpseActor = targets[0].actor;
    if ((corpseActor.system.attributes.hp?.value || 0) > 0) {
        return notify("warn", "The target is still breathing. It must be dead (0 HP).");
    }

    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length === 0) return notify("warn", "Necromancer token not found on the canvas.");
    const necroToken = necroTokens[0];

    if (getTokenDistance(tokenDoc, necroToken) > 30) {
        return notify("warn", `${tokenDoc.name} is too far from you (must be within 30 feet).`);
    }

    if (getTokenDistance(tokenDoc, targets[0]) > 30) {
        return notify("warn", `${tokenDoc.name} is too far from the corpse (must be within 30 feet of it).`);
    }

    const corpseLevel = corpseActor.level || 1;
    const standardDCs = [14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50];
    const exactDC = corpseLevel < 0 ? 14 : (corpseLevel > 25 ? 50 : standardDCs[corpseLevel]);

    new Dialog({
        title: "Reanimate Foe",
        content: `<p>Launch <b>${tokenDoc.name}</b> into the corpse of <b>${corpseDoc.name}</b>?</p><p>Rolling <b>Undead Lore</b> against DC ${exactDC} (Level ${corpseLevel}).</p>`,
        buttons: {
            cast: {
                icon: '<i class="fas fa-bolt"></i>',
                label: "Launch",
                callback: async () => {
                    await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                    const roll = await new Roll(`1d20 + ${loreSkill.mod}`).evaluate({ async: true });
                    const total = roll.total;
                    let dosNum = total >= exactDC + 10 ? 3 : total >= exactDC ? 2 : total <= exactDC - 10 ? 0 : 1;
                    if (roll.dice[0].results[0].result === 20) dosNum = Math.min(3, dosNum + 1);
                    if (roll.dice[0].results[0].result === 1) dosNum = Math.max(0, dosNum - 1);

                    const dosMap = ["Critical Failure", "Failure", "Success", "Critical Success"];
                    const dosColors = ["#ef4444", "#eab308", "#3b82f6", "#22c55e"];

                    let chatContent = `
                        <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid ${dosColors[dosNum]};">
                            <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> violently launches <b>${tokenDoc.name}</b> into the corpse of <b>${corpseDoc.name}</b>!</p>
                            <p style="margin: 0; font-size: 1.1em;">Undead Lore: <b>${total}</b> vs DC ${exactDC}</p>
                            <p style="margin: 0; font-weight: bold; color: ${dosColors[dosNum]};">${dosMap[dosNum]}!</p>
                    `;

                    await executeDelete(tokenDoc.id);

                    if (dosNum === 0) {
                        await actor.update({ "system.resources.focus.value": currentFocus });
                        chatContent += `<p style="margin: 5px 0 0 0;">The ritual violently rejects the corpse. A basic thrall spawns in its place, and the Focus Point is refunded.</p></div>`;

                        const presets = typeof getThrallPresets === "function" ? getThrallPresets(actor) : [];
                        const presetId = presets.length > 0 ? presets[0].id : "default";
                        const basePayload = await prepareThrallPayload(actor, presetId);
                        if (basePayload) {
                            const finalPayload = foundry.utils.mergeObject(basePayload, {
                                x: corpseDoc.x,
                                y: corpseDoc.y,
                                delta: { ownership: { [game.user.id]: 3 } }
                            });
                            executeSpawn(finalPayload);
                        }
                    } else {
                        const decayAmount = dosNum === 1 ? 50 : 15;
                        const isFailure = dosNum === 1;

                        chatContent += `
                            <p style="margin: 5px 0 0 0;">The corpse violently jerks back to un-life! It has 100 HP and decays <b>${decayAmount} HP</b> each turn.</p>
                            <p style="margin: 5px 0 0 0; font-size: 0.85em; font-style: italic; color: #aaa;">Special abilities and Strike side-effects are disabled by the ritual.</p>
                        </div>`;

                        placementHint("Click an adjacent space to spawn the Reanimated Foe.");
                        document.body.style.cursor = "crosshair";
                        canvas.app.view.style.cursor = "crosshair";

                        const ghost = new PIXI.Graphics();
                        ghost.beginFill(0x9900ff, 0.4);
                        ghost.lineStyle(2, 0x6600cc, 0.8);
                        ghost.drawRect(0, 0, (corpseDoc.width || 1) * canvas.grid.size, (corpseDoc.height || 1) * canvas.grid.size);
                        ghost.endFill();
                        ghost.zIndex = 1000;
                        canvas.tokens.addChild(ghost);

                        const updateGhost = (evt) => {
                            const pos = evt.data.getLocalPosition(canvas.app.stage);
                            const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                            ghost.position.set(snapped.x, snapped.y);
                        };
                        canvas.stage.on("pointermove", updateGhost);

                        const cleanUp = () => {
                            document.body.style.cursor = "";
                            canvas.app.view.style.cursor = "";
                            canvas.stage.off("pointermove", updateGhost);
                            ghost.destroy();
                        };

                        canvas.stage.once("pointerdown", async (evt) => {
                            if (evt.data.button !== 0) { cleanUp(); return; }
                            const pos = evt.data.getLocalPosition(canvas.app.stage);
                            const snapped = canvas.grid.getTopLeftPoint ? canvas.grid.getTopLeftPoint(pos) : pos;
                            cleanUp();

                            const payload = corpseDoc.toObject();
                            payload.actorLink = false;
                            payload.x = snapped.x;
                            payload.y = snapped.y;
                            payload.name = `Reanimated ${corpseDoc.name}`;

                            const ownerIds = Object.keys(actor.ownership).filter(k => actor.ownership[k] === 3 && k !== "default");
                            const newOwnership = { default: 0 };
                            ownerIds.forEach(id => { newOwnership[id] = 3; });

                            payload.delta = payload.delta || {};
                            payload.delta.ownership = newOwnership;
                            payload.flags = payload.flags || {};
                            payload.flags["necromancer-thrall-helper"] = {
                                masterId: actor.id,
                                isReanimatedFoe: true
                            };

                            const spawned = await executeSpawn(payload);
                            const spawnedId = spawned?.[0]?.id || spawned?.[0]?._id;
                            let newTokenDoc = null;
                            for (let i = 0; i < 20; i++) {
                                newTokenDoc = canvas.scene?.tokens?.get(spawnedId);
                                if (newTokenDoc?.actor) break;
                                await new Promise(r => setTimeout(r, 100));
                            }

                            if (newTokenDoc && newTokenDoc.actor) {
                                const newActor = newTokenDoc.actor;
                                await newActor.update({
                                    "system.attributes.immunities": [],
                                    "system.attributes.weaknesses": [],
                                    "system.attributes.resistances": [],
                                    "system.details.alliance": "party"
                                });

                                const effectData = {
                                    name: "Reanimated Foe",
                                    type: "effect",
                                    img: "icons/magic/death/undead-zombie-glowing-green.webp",
                                    system: {
                                        duration: { value: 1, unit: "minutes", expiry: "turn-start" },
                                        description: { value: `<b>Decay:</b> Loses ${decayAmount} HP at the end of its turn. Cannot be healed.<br>${isFailure ? "<b>Failure:</b> Strikes deal half damage." : ""}` },
                                        rules: [
                                            { key: "Immunity", type: "healing" },
                                            { key: "ActiveEffectLike", mode: "override", path: "system.attributes.hp.max", value: 100 }
                                        ]
                                    },
                                    flags: {
                                        "necromancer-thrall-helper": {
                                            isReanimatedFoe: true,
                                            decayAmount: decayAmount,
                                            masterId: actor.id
                                        }
                                    }
                                };

                                await newActor.createEmbeddedDocuments("Item", [effectData]);

                                for (let i = 0; i < 20; i++) {
                                    if (newActor.system.attributes.hp.max === 100) {
                                        await newActor.update({
                                            "system.attributes.hp.value": 100,
                                            "system.attributes.hp.temp": 0
                                        });
                                        break;
                                    }
                                    await new Promise(resolve => setTimeout(resolve, 100));
                                }
                            }
                        });
                    }

                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor }),
                        flavor: `<strong>Reanimate Foe</strong>`,
                        content: chatContent
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "cast"
    }).render(true);
}