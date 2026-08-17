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

// Injecting the quick-access button into the token HUD or scene controls
Hooks.on("getSceneControlButtons", (controls) => {
    const thrallTool = {
        name: "thrall-command",
        title: "Open Thrall Command Deck",
        icon: "fas fa-skull",
        visible: true,
        button: true,
        onClick: () => {
            new ThrallCommandDeck().render(true);
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