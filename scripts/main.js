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
            
            if (!isNecro && game.user.character) {
                const actor = game.user.character;
                const hasNecroClass = actor.items.some(i => i.type === "class" && (i.name.toLowerCase().includes("necromancer") || i.system?.slug?.includes("necromancer")));
                const hasNecroDedication = actor.items.some(i => i.type === "feat" && (i.name.toLowerCase().includes("necromancer") || i.system?.slug?.includes("necromancer")));
                isNecro = hasNecroClass || hasNecroDedication;
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