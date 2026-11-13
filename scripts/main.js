import { ThrallCommandDeck } from "./ui/command-deck.js";
import { setupHooks, repairWorldThrallArt } from "./system/thrall-manager.js";
import { setupSocket } from "./system/socket.js";
import { checkBrowsePermissions } from "./system/permissions-notice.js";
import { sweepEmptyRegions } from "./system/region-sweep.js";
import { setupEffectColorHooks } from "./system/effect-colors.js";
import { notify, notifyForce } from "./system/notify.js";

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
    game.settings.register("necromancer-thrall-helper", "pairWildcardFiles", {
        name: "Pair Wildcard Art by Filename",
        hint: "If enabled, when a thrall's token art, portrait and ring subject are all wildcards, files that share the same text in place of the * are used together (thrall-03.webm with portrait-03.webp). If disabled, each image is picked at random on its own.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register("necromancer-thrall-helper", "replaceMissingArt", {
        name: "Replace missing thrall art with bundled art",
        hint: "If a thrall actor's images point at a token pack that isn't active, use the module's bundled art instead. The original paths are remembered and restored when the pack is active again.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register("necromancer-thrall-helper", "allowThrallVitality", {
        name: "Allow Vitality Thrall Strikes",
        hint: "If enabled, a necromancer with the spirit Grim Fascination (Thrall Enhancement) and Mastery of Life and Death can set thrall Strikes to deal vitality damage. Disable to hide the vitality option if your table does not allow this reading of the rules.",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register("necromancer-thrall-helper", "suppressBrowseWarning", {
        name: "Hide the file-browser permission notice",
        hint: "Stops the GM notice about necromancer players who lack the Use File Browser permission.",
        scope: "world",
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register("necromancer-thrall-helper", "notificationLevel", {
        name: "Notification Level",
        hint: "Which pop-up messages to show you. Placement instructions and permission problems always show. Suppressed messages are still written to the console.",
        scope: "client",
        config: true,
        type: String,
        choices: {
            all: "All",
            important: "Warnings & errors",
            errors: "Errors only",
            none: "Off"
        },
        default: "important"
    });
});

Hooks.once("ready", () => {
    console.log("Necromancer Thrall Helper | Binding hooks.");
    setupHooks();
    setupEffectColorHooks();
    repairWorldThrallArt().catch(err => console.warn("Necromancer Thrall Helper | Could not repair thrall art:", err));
    sweepEmptyRegions().catch(err => console.warn("Necromancer Thrall Helper | Region sweep failed:", err));
    checkBrowsePermissions().catch(err => console.warn("Necromancer Thrall Helper | Permission check failed:", err));
});

Hooks.on("getSceneControlButtons", (controls) => {
    const thrallTool = {
        name: "thrall-command",
        title: "Open Thrall Command Deck",
        icon: "fas fa-skull",
        visible: true, 
        button: true,
        onChange: () => {
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
                return notifyForce("warn", "You lack the dark blood and discipline required to command the dead.");
            }
            try {
                const existing = foundry.applications.instances.get("thrall-command-deck");
                if (existing) {
                    existing.render({ force: true });
                    existing.bringToFront?.();
                } else {
                    new ThrallCommandDeck().render(true);
                }
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