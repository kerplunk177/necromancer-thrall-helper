import { executeDelete } from "../system/socket.js";
import { notify } from "../system/notify.js";
import { getTokenDistance, getActorThrallTokens } from "./spell-helpers.js";
import { getNecroEffect, findNecroEffect } from "../system/effect-catalog.js";
import { NecroDialog } from "../ui/necro-dialog.js";
import { createNecroCard } from "../system/necro-card.js";

async function applyBodyShieldSacrifice(actor, tokenDoc) {
    const necroLevel = actor.level || 1;
    const currentAC = actor.system?.attributes?.ac?.value || 10;
    const boostedAC = currentAC + 2;

    await actor.createEmbeddedDocuments("Item", [await getNecroEffect("bodyShield", {}, { necroLevel })]);

    await executeDelete(tokenDoc.id);

    await createNecroCard({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `<strong>Body Shield Reaction!</strong>`,
        content: `
            <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #b58900;">
                <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> coldly yanks <b>${tokenDoc.name}</b> into the path of an incoming attack, obliterating them instantly!</p>
                <p style="margin: 0; font-size: 1.1em;">Current AC: <b><span style="color: #4ade80;">${boostedAC}</span></b> <i>(+2 circ)</i></p>
                <p style="margin: 5px 0 0 0;">If the attack still hits, ${actor.name} gains <b>Resistance ${necroLevel} to all damage</b>. <i>(Expires at the start of your next turn)</i></p>
            </div>
        `
    });
}

export async function executeBodyShield({ actor, tokenDoc }) {
    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length === 0) return notify("warn", "No Necromancer token found on the canvas.");

    if (getTokenDistance(tokenDoc, necroTokens[0]) > 5) {
        return notify("warn", `${tokenDoc.name} is too far away to use as a meat shield. They must be adjacent (5 feet).`);
    }

    await applyBodyShieldSacrifice(actor, tokenDoc);
}

export async function executeConsumeThrall({ actor, tokenDoc }) {
    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length > 0 && getTokenDistance(tokenDoc, necroTokens[0]) > 30) {
        return notify("warn", "That thrall is beyond 30 feet.");
    }

    new NecroDialog({
        title: "Consume Thrall",
        content: `<p>Destroy <b>${tokenDoc.name}</b> to regain 1 Focus Point?</p>`,
        buttons: {
            consume: {
                icon: '<i class="fas fa-skull"></i>',
                label: "Consume",
                callback: async () => {
                    await executeDelete(tokenDoc.id);
                    await actor.setFlag("necromancer-thrall-helper", "consumeThrallUsed", true);
                    const currentFocus = actor.system?.resources?.focus?.value || 0;
                    await actor.update({ "system.resources.focus.value": currentFocus + 1 });

                    await createNecroCard({
                        speaker: ChatMessage.getSpeaker({ actor }),
                        flavor: `<strong>Consume Thrall</strong>`,
                        content: `<p><b>${actor.name}</b> consumes the animus of <b>${tokenDoc.name}</b>, regaining 1 Focus Point (restricted to grave spells).</p>`
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "consume"
    }).render(true);
}

export function bindHeaderUtilityButtons(deck, html) {
    // 1. Hallowed Earth Aura Toggle
    const hallowedBtn = html.querySelector(".hallowed-btn");
    if (hallowedBtn) {
        hallowedBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!actor) return;

            const existing = findNecroEffect(actor, "hallowedEarth");
            if (existing) {
                await existing.delete();
                notify("info", "Hallowed Earth dismissed.");
            } else {
                await actor.createEmbeddedDocuments("Item", [await getNecroEffect("hallowedEarth")]);
                notify("info", "Hallowed Earth activated.");
            }
            deck.render({ force: false });
        });
    }

    // 2. Corrupted Ground Aura Toggle
    const corruptedBtn = html.querySelector(".corrupted-btn");
    if (corruptedBtn) {
        corruptedBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!actor) return;

            const existing = findNecroEffect(actor, "corruptedGround");
            if (existing) {
                await existing.delete();
                notify("info", "Corrupted Ground dismissed.");
            } else {
                await actor.createEmbeddedDocuments("Item", [await getNecroEffect("corruptedGround")]);
                notify("info", "Corrupted Ground activated.");
            }
            deck.render({ force: false });
        });
    }

    // 3. Body Shield Header Button
    const bodyShieldBtn = html.querySelector(".body-shield-btn");
    if (bodyShieldBtn) {
        bodyShieldBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!actor || !canvas.scene) return;

            const necroTokens = actor.getActiveTokens();
            if (necroTokens.length === 0) return notify("warn", "Necromancer token not found on the canvas.");
            const necroToken = necroTokens[0];

            const allThralls = getActorThrallTokens(actor, { includeReanimated: true });
            const eligibleThralls = allThralls.filter(t => getTokenDistance(necroToken, t) <= 5);
            if (eligibleThralls.length === 0) return notify("warn", "No eligible thralls within 5 feet to use as a meat shield.");

            const optionsHtml = eligibleThralls.map(t => `<option value="${t.id}">${t.name}</option>`).join("");

            new NecroDialog({
                title: "Body Shield Reaction",
                content: `<p>Select an adjacent thrall to throw into the attack's path:</p><form><div class="form-group"><select id="shield-thrall">${optionsHtml}</select></div></form>`,
                buttons: {
                    shield: {
                        icon: '<i class="fas fa-shield-virus"></i>',
                        label: "Sacrifice",
                        callback: async (dialogHtml) => {
                            const selectedId = dialogHtml.find("#shield-thrall").val();
                            const tokenDoc = canvas.scene.tokens.get(selectedId);
                            if (!tokenDoc) return;
                            await applyBodyShieldSacrifice(actor, tokenDoc);
                        }
                    },
                    cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                },
                default: "shield"
            }).render(true);
        });
    }

    // 4. Reclaim Power Header Button
    const reclaimBtn = html.querySelector(".reclaim-btn");
    if (reclaimBtn) {
        reclaimBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!actor || !canvas.scene) return;

            const necroTokens = actor.getActiveTokens();
            if (necroTokens.length === 0) return notify("warn", "Necromancer token not found on the canvas.");
            const necroToken = necroTokens[0];

            const allThralls = getActorThrallTokens(actor, { includeReanimated: true });
            const eligibleThralls = allThralls.filter(t => getTokenDistance(necroToken, t) <= 60);
            if (eligibleThralls.length === 0) return notify("warn", "No eligible thralls within 60 feet.");

            const checkboxes = eligibleThralls.map((t, index) => `
                <div style="display: flex; align-items: center; margin-bottom: 5px;">
                    <input type="checkbox" id="reclaim-thrall-${index}" value="${t.id}" class="reclaim-checkbox" style="margin-right: 10px;">
                    <label for="reclaim-thrall-${index}" style="display: flex; align-items: center; cursor: pointer;">
                        <img src="${t.texture?.src}" width="30" height="30" style="border: none; margin-right: 10px; border-radius: 4px; object-fit: cover;">
                        ${t.name}
                    </label>
                </div>
            `).join("");

            new NecroDialog({
                title: "Reclaim Power",
                content: `<form id="reclaim-form" style="margin-bottom: 10px;"><p>Select up to 3 thralls to destroy and siphon their essence (within 60 feet).</p><div style="max-height: 200px; overflow-y: auto; border: 1px solid #333; padding: 5px; background: rgba(0,0,0,0.2); border-radius: 4px;">${checkboxes}</div></form>`,
                buttons: {
                    reclaim: {
                        icon: '<i class="fas fa-heart-crack"></i>',
                        label: "Reclaim",
                        callback: async (dialogHtml) => {
                            const selectedIds = [];
                            dialogHtml.find(".reclaim-checkbox:checked").each((_i, cb) => selectedIds.push(cb.value));
                            if (selectedIds.length === 0) return notify("warn", "You must select at least one thrall.");

                            const necroLevel = actor.level || 1;
                            const hpGained = selectedIds.length * necroLevel;
                            const currentHP = actor.system.attributes.hp.value;
                            const maxHP = actor.system.attributes.hp.max;
                            const actualHealed = Math.min(maxHP - currentHP, hpGained);

                            const dbUpdates = { "system.attributes.hp.value": currentHP + actualHealed };
                            const hasPowerHungry = actor.items.some(i => i.name === "Power Hungry" || i.system?.slug?.includes("power-hungry"));
                            let powerHungryTriggered = false;

                            if (selectedIds.length === 3 && hasPowerHungry) {
                                const maxFocus = actor.system.resources?.focus?.max || 0;
                                if (maxFocus > 0) {
                                    dbUpdates["system.resources.focus.value"] = maxFocus;
                                    powerHungryTriggered = true;
                                }
                            }

                            await actor.update(dbUpdates);

                            const tokensToDelete = selectedIds.map(id => canvas.scene.tokens.get(id)).filter(Boolean);
                            const names = tokensToDelete.map(t => t.name).join(", ");
                            for (const tDoc of tokensToDelete) await executeDelete(tDoc.id);

                            if (actualHealed > 0 && canvas.ready && necroToken) {
                                canvas.interface.createScrollingText(necroToken.center, `+${actualHealed} HP`, {
                                    anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
                                    fill: 0x4ade80,
                                    direction: CONST.TEXT_ANCHOR_POINTS.UP
                                });
                            }

                            let chatContent = `<p><b>${actor.name}</b> draws the life force from their creations, destroying <b>${names}</b> to recover <b>${actualHealed} HP</b>.</p>`;
                            if (powerHungryTriggered) {
                                chatContent += `<p style="color: #c084fc; font-weight: bold; margin-top: 4px;">Power Hungry: Focus Pool fully restored!</p>`;
                            }

                            if (selectedIds.length === 3) {
                                const eligibleConditions = ["clumsy", "enfeebled", "frightened", "sickened", "stupefied"];
                                const activeConditions = actor.items.filter(i => i.type === "condition" && eligibleConditions.includes(i.system.slug));

                                if (activeConditions.length > 0) {
                                    const condOptions = activeConditions.map(c => `<option value="${c.system.slug}">${c.name}</option>`).join("");
                                    await new Promise(resolve => {
                                        new NecroDialog({
                                            title: "Reduce Condition",
                                            content: `<p>You destroyed 3 thralls! Select a condition to decrease by 1:</p><form><select id="cond-select">${condOptions}</select></form>`,
                                            buttons: {
                                                reduce: {
                                                    label: "Reduce",
                                                    callback: async (cHtml) => {
                                                        const selectedSlug = cHtml.find("#cond-select").val();
                                                        await actor.decreaseCondition(selectedSlug);
                                                        chatContent += `<p style="color: #4ade80; font-weight: bold;">Condition Reduced: ${selectedSlug.charAt(0).toUpperCase() + selectedSlug.slice(1)}</p>`;
                                                        resolve();
                                                    }
                                                },
                                                skip: { label: "Skip", callback: () => resolve() }
                                            },
                                            default: "reduce"
                                        }).render(true);
                                    });
                                }
                            }

                            await createNecroCard({
                                speaker: ChatMessage.getSpeaker({ actor }),
                                flavor: `<strong>Reclaim Power</strong>`,
                                content: chatContent
                            });
                        }
                    },
                    cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                },
                default: "reclaim",
                render: (dialogHtml) => {
                    dialogHtml.find(".reclaim-checkbox").on("change", function () {
                        if (dialogHtml.find(".reclaim-checkbox:checked").length > 3) {
                            this.checked = false;
                            notify("warn", "You can only reclaim up to 3 thralls at a time.");
                        }
                    });
                }
            }).render(true);
        });
    }

    // 5. Collateral Reinforcement Header Button
    const collateralBtn = html.querySelector(".collateral-btn");
    if (collateralBtn) {
        collateralBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const actor = game.actors.get(deck.necroId) || game.user.character;
            if (!actor || !canvas.scene) return;

            const thrallTokens = getActorThrallTokens(actor, { includeReanimated: true });
            if (thrallTokens.length === 0) return notify("warn", "No thralls on the battlefield to reinforce.");

            const effectData = await getNecroEffect("collateralReinforcement");

            for (const tDoc of thrallTokens) {
                if (tDoc.actor) await tDoc.actor.createEmbeddedDocuments("Item", [effectData]);
            }

            await createNecroCard({
                speaker: ChatMessage.getSpeaker({ actor }),
                flavor: `<strong>Collateral Reinforcement</strong>`,
                content: `<p><b>${actor.name}</b> thickens the bone and flesh of their minions! All active thralls are immune to area and splash damage for 1 round.</p>`
            });
        });
    }
}