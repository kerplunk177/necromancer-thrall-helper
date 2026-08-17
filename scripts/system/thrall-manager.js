
export function setupHooks() {
    console.log("Necromancer Thrall Helper | Thrall management hooks standing by.");

    // The Auto-Refresh Hook
    const refreshDeck = (tokenDocument) => {
        const isThrall = tokenDocument.getFlag("necromancer-thrall-helper", "masterId");
        if (!isThrall) return;

        for (const app of foundry.applications.instances.values()) {
            if (app.id === "thrall-command-deck") {
                app.render(false);
            }
        }
    };

    Hooks.on("createToken", refreshDeck);
    Hooks.on("deleteToken", refreshDeck);

    // The MAP Combat Reset Hook
    const resetMap = (combat) => {
        for (const deck of foundry.applications.instances.values()) {
            if (deck.id === "thrall-command-deck" && deck.necroId) {
                if (combat.combatant?.actorId === deck.necroId) {
                    deck.currentMap = 0;
                    deck.render(false);
                }
            }
        }
    };

    Hooks.on("combatTurn", resetMap);
    Hooks.on("combatRound", resetMap);

    // The Canvas-to-UI Sync Hook
    const syncHover = (token, hovered) => {
        const isThrall = token.document.getFlag("necromancer-thrall-helper", "masterId");
        if (!isThrall) return;

        for (const app of foundry.applications.instances.values()) {
            if (app.id === "thrall-command-deck" && app.element) {
                const row = app.element.querySelector(`.thrall-row[data-token-id="${token.id}"]`);
                if (row) {
                    if (hovered) {
                        row.classList.add("highlight");
                    } else {
                        row.classList.remove("highlight");
                    }
                }
            }
        }
    };

    Hooks.on("hoverToken", syncHover);
}

// Master list of standard adjectives for default and random pools
const STANDARD_ADJECTIVES = [
    "Angry", "Soggy", "Vengeful", "Festering", "Hollow", 
    "Shivering", "Wrinkled", "Spiteful", "Damp", "Putrid", 
    "Screaming", "Moth-Eaten", "Bitter", "Rancid", "Haunted"
];

export function getThrallPresets(actor = null) {
    if (actor) {
        const customFamily = actor.getFlag("necromancer-thrall-helper", "familyTree");
        if (customFamily && Array.isArray(customFamily) && customFamily.length > 0) {
            return customFamily;
        }
    }

    return [
        { id: "uncle-arthur", name: "Uncle Arthur", img: "icons/magic/death/undead-ghost-scream-teal.webp", adjectives: STANDARD_ADJECTIVES },
        { id: "aunt-martha", name: "Aunt Martha", img: "icons/magic/death/undead-skeleton-mage-red.webp", adjectives: STANDARD_ADJECTIVES }
    ];
}

export async function prepareThrallPayload(necroActor, presetId = "default") {
    const pack = game.packs.get("necromancer-thrall-helper.necro-thralls");
    if (!pack) {
        ui.notifications.error("Could not find the Necromancer Thralls compendium pack.");
        return null;
    }

    const index = await pack.getIndex();
    const thrallEntry = index.find(a => a.name === "Thrall");
    if (!thrallEntry) return null;

    const protoActor = await pack.getDocument(thrallEntry._id);
    const necroLevel = necroActor.level || 1;
    const damageDice = Math.max(1, Math.floor((necroLevel - 1) / 4) + 1);
    
    const tokenDocument = await protoActor.getTokenDocument();
    const tokenData = tokenDocument.toObject();

    const customPresets = getThrallPresets(necroActor);
    const defaultPreset = { 
        id: "default", 
        name: "Thrall", 
        img: "systems/pf2e/icons/default-icons/npc.svg", 
        adjectives: STANDARD_ADJECTIVES, 
        isUnique: false 
    };
    
    let preset;
    if (presetId === "random" && customPresets.length > 0) {
        const activePresetIds = canvas.scene ? canvas.scene.tokens.map(t => t.flags["necromancer-thrall-helper"]?.presetId) : [];
        const availablePresets = customPresets.filter(p => !p.isUnique || !activePresetIds.includes(p.id));

        if (availablePresets.length === 0) {
            preset = defaultPreset;
        } else {
            const randomIndex = Math.floor(Math.random() * availablePresets.length);
            preset = availablePresets[randomIndex];
        }
    } else if (presetId === "default") {
        preset = defaultPreset;
    } else {
        preset = customPresets.find(p => p.id === presetId) || defaultPreset;
    }

    // --- ADJECTIVE RESOLUTION ---
    let finalName = preset.name;
    if (preset.adjectives && preset.adjectives.length > 0) {
        const randomAdjective = preset.adjectives[Math.floor(Math.random() * preset.adjectives.length)];
        finalName = `${randomAdjective} ${preset.name}`;
    }

    if (preset) {
        tokenData.name = finalName;
        tokenData.texture.src = preset.img;
        
        if (tokenData.ring) {
            if (preset.id === "default") {
                tokenData.ring.enabled = true;
            } else {
                tokenData.ring.enabled = false;
            }
        }
    }

    tokenData.disposition = 1;

    // 1. Flag the Token itself for external modules and parsers
    tokenData.flags = foundry.utils.mergeObject(tokenData.flags || {}, {
        "necromancer-thrall-helper": {
            masterId: necroActor.id,
            damageScale: `${damageDice}d6`,
            presetId: preset?.id || "default"
        },
        pf2e: {
            master: {
                id: necroActor.id
            }
        }
    });

    // 2. Inject the master link and summoned traits into the Thrall's private Actor sheet
    const existingTraits = protoActor.system?.traits?.value || [];
    const newTraits = [...new Set([...existingTraits, "summoned", "minion"])];

    tokenData.delta = foundry.utils.mergeObject(tokenData.delta || {}, {
        flags: {
            pf2e: {
                master: {
                    id: necroActor.id
                }
            }
        },
        system: {
            traits: {
                value: newTraits
            }
        }
    });

    return tokenData;
}