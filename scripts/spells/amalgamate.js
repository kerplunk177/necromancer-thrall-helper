import { notify } from "../system/notify.js";
import { getTokenDistance } from "./spell-helpers.js";

export async function executeAmalgamate({ deck, actor, tokenDoc }) {
    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length === 0) return notify("warn", "No Necromancer token found on the canvas.");
    const necroToken = necroTokens[0];

    if (getTokenDistance(tokenDoc, necroToken) > 30) {
        return notify("warn", `${tokenDoc.name} is too far from you (must be within 30 feet).`);
    }

    const eligibleThralls = canvas.tokens.placeables.filter(t => {
        if (t.id === tokenDoc.id || !t.actor) return false;
        const masterId = t.document.getFlag("necromancer-thrall-helper", "masterId") || t.actor.getFlag("necromancer-thrall-helper", "masterId");
        if (masterId !== actor.id) return false;
        if (getTokenDistance(tokenDoc, t) > 5) return false;
        return getTokenDistance(necroToken, t) <= 30;
    });

    if (eligibleThralls.length === 0) {
        return notify("warn", `There are no other adjacent thralls within 30 feet of you to fuse with ${tokenDoc.name}.`);
    }

    const optionsHtml = eligibleThralls.map(t => `<option value="${t.id}">${t.name}</option>`).join("");
    const dialogContent = `
        <form>
            <p>Select an adjacent thrall to sacrifice and fuse into <b>${tokenDoc.name}</b>:</p>
            <div class="form-group" style="margin-bottom: 8px;">
                <label style="font-weight: bold;">Secondary Thrall:</label>
                <div class="form-fields" style="margin-top: 4px;">
                    <select id="amalgamate-target-select" style="width: 100%; padding: 4px;">${optionsHtml}</select>
                </div>
            </div>
        </form>
    `;

    new Dialog({
        title: "Amalgamate Thralls",
        content: dialogContent,
        buttons: {
            fuse: {
                icon: '<i class="fas fa-biohazard"></i>',
                label: "Amalgamate",
                callback: async ($html) => {
                    const secondaryId = $html.find("#amalgamate-target-select").val();
                    const secondaryToken = canvas.tokens.get(secondaryId);
                    if (!secondaryToken) return;

                    const secondaryName = secondaryToken.name;
                    const masterLevel = actor.level || 1;

                    await tokenDoc.update({
                        name: `Amalgamation (${tokenDoc.name})`,
                        width: 2,
                        height: 2,
                        "texture.scaleX": 1.25,
                        "texture.scaleY": 1.25
                    });

                    const effectData = {
                        name: "Effect: Amalgamation",
                        type: "effect",
                        img: "icons/magic/death/undead-zombie-glowing-green.webp",
                        system: {
                            slug: "effect-amalgamation",
                            description: {
                                value: `Fused from two thralls. Large size with 10-foot reach, 25-foot Speed, and a +${masterLevel} status bonus to Strike damage.`
                            },
                            duration: { value: -1, unit: "unlimited" },
                            rules: [
                                { key: "CreatureSize", value: "lg" },
                                { key: "BaseSpeed", selector: "land", value: 25 },
                                { key: "FlatModifier", selector: "strike-damage", value: masterLevel, type: "status", label: "Amalgamation Status Damage" },
                                { key: "AdjustStrike", mode: "upgrade", property: "weapon-traits", value: "reach" }
                            ]
                        }
                    };

                    if (tokenDoc.actor) {
                        await tokenDoc.actor.createEmbeddedDocuments("Item", [effectData]);
                    }

                    await secondaryToken.document.delete();
                    deck.render({ force: false });

                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor }),
                        flavor: `<strong>Amalgamate!</strong>`,
                        content: `
                            <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #a855f7;">
                                <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> tears apart <b>${secondaryName}</b> and grafts its remains onto <b>${tokenDoc.name}</b>!</p>
                                <p style="margin: 0; font-size: 0.95em;">The thrall swells into a <b>Large Amalgamation</b> (Speed 25 ft, Reach 10 ft) with <b>+${masterLevel} status bonus to Strike damage</b>.</p>
                            </div>
                        `
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "fuse"
    }).render(true);
}