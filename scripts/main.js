import { ThrallCommandDeck } from "./ui/command-deck.js";
import { setupHooks } from "./system/thrall-manager.js";
import { setupSocket } from "./system/socket.js";

Hooks.once("setup", function () {
    if (!setupSocket()) {
        console.error("Error: Unable to set up socketlib for Necromancer Thrall Helper.");
    }
});

Hooks.once("init", () => {
    console.log("Necromancer Thrall Helper | Initializing the dark arts...");
    
    game.settings.register("necromancer-thrall-helper", "autoApproveSpawns", {
        name: "Auto-Approve Player Spawns",
        hint: "If enabled, player requests to spawn thralls will bypass the GM approval prompt and spawn immediately.",
        scope: "world",
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register("necromancer-thrall-helper", "requireNecromancer", {
        name: "Require Necromancer Features",
        hint: "If disabled, any character can open the Command Deck regardless of their class, archetype, or items.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });
});

Hooks.once("ready", () => {
    console.log("Necromancer Thrall Helper | Binding hooks.");
    setupHooks();
});

Hooks.on("getSceneControlButtons", (controls) => {
    const thrallTool = {
        name: "thrall-command",
        title: "Open Thrall Command Deck",
        icon: "fas fa-skull",
        visible: true, 
        button: true,
        onClick: () => {
            let isNecro = game.user.isGM;
            const requireNecro = game.settings.get("necromancer-thrall-helper", "requireNecromancer");
            
            if (!requireNecro) {
                isNecro = true;
            } else if (!isNecro && game.user.character) {
                const actor = game.user.character;
                isNecro = actor.items.some(i => {
                    const name = i.name.toLowerCase();
                    const slug = i.system?.slug || "";
                    
                    if (name.includes("necro") || slug.includes("necro") || name.includes("reanimator") || name.includes("undead master")) return true;
                    if (name.includes("conjurer of corpses") || i.flags?.["necromancer-thrall-helper"]) return true;
                    
                    return false;
                });
            }

            if (!isNecro) {
                return ui.notifications.warn("You lack the dark blood and discipline required to command the dead.");
            }

            try {
                new ThrallCommandDeck().render(true);
            } catch (e) {
                console.warn("Necromancer Helper | Command Deck failed to open:", e);
            }
        }
    };

    let tokenControls;
    if (Array.isArray(controls)) {
        tokenControls = controls.find(c => c.name === "token");
        if (tokenControls && Array.isArray(tokenControls.tools)) {
            tokenControls.tools.push(thrallTool);
        }
    } 
    else if (controls.tokens || controls.token) {
        tokenControls = controls.tokens || controls.token;
        if (Array.isArray(tokenControls.tools)) {
            tokenControls.tools.push(thrallTool);
        } else {
            tokenControls.tools["thrall-command"] = thrallTool;
        }
    }
});