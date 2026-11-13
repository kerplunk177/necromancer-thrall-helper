import { executeDelete } from "../system/socket.js";
import { notify } from "../system/notify.js";
import { getTokenDistance } from "./spell-helpers.js";

export async function executeBindHeroicSpirit({ actor, tokenDoc }) {
    const currentFocus = actor.system?.resources?.focus?.value || 0;
    if (currentFocus === 0) return notify("warn", "You have no Focus Points to cast Bind Heroic Spirit!");

    const necroTokens = actor.getActiveTokens();
    if (necroTokens.length === 0) return notify("warn", "No Necromancer token found on the canvas.");

    if (getTokenDistance(tokenDoc, necroTokens[0]) > 30) {
        return notify("warn", `${tokenDoc.name} is too far away. They must be within 30 feet.`);
    }

    const spellRank = Math.max(3, Math.ceil((actor.level || 1) / 2));
    const buffValue = spellRank >= 6 ? 2 : 1;

    new Dialog({
        title: "Bind Heroic Spirit",
        content: `<p>Sacrifice <b>${tokenDoc.name}</b> to channel an ancient warlord into your body?</p>`,
        buttons: {
            cast: {
                icon: '<i class="fas fa-ghost"></i>',
                label: "Bind Spirit",
                callback: async () => {
                    await actor.update({ "system.resources.focus.value": currentFocus - 1 });

                    const effectData = {
                        name: "Effect: Bind Heroic Spirit",
                        type: "effect",
                        img: "icons/magic/light/explosion-star-glow-blue-purple.webp",
                        system: {
                            level: { value: spellRank },
                            duration: { value: 1, unit: "minutes", expiry: "turn-start" },
                            description: { value: `You gain a +${buffValue} status bonus to attack rolls and saving throws. Whenever you critically hit a creature with a Strike, you can create a thrall adjacent to the target.` },
                            rules: [
                                { key: "FlatModifier", selector: "attack", value: buffValue, type: "status" },
                                { key: "FlatModifier", selector: "saving-throw", value: buffValue, type: "status" },
                                { key: "RollOption", domain: "strike-damage", option: "heroic-spirit-active" }
                            ]
                        }
                    };

                    await actor.createEmbeddedDocuments("Item", [effectData]);
                    await executeDelete(tokenDoc.id);

                    await ChatMessage.create({
                        speaker: ChatMessage.getSpeaker({ actor }),
                        flavor: `<strong>Bind Heroic Spirit</strong>`,
                        content: `
                            <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #e6b800;">
                                <p style="margin: 0 0 5px 0;"><b>${actor.name}</b> destroys <b>${tokenDoc.name}</b>, transforming their fading animus into a conduit for a heroic spirit!</p>
                                <p style="margin: 0; font-size: 1.1em; color: #4ade80;"><b>+${buffValue} Status Bonus to Attacks and Saves</b></p>
                                <p style="margin: 5px 0 0 0; font-size: 0.9em; font-style: italic;">If you critically hit a creature with a Strike, the heroic energy will inspire a new thrall to rise adjacent to them!</p>
                            </div>
                        `
                    });
                }
            },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "cast"
    }).render(true);
}