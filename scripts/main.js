import { ThrallCommandDeck } from "./ui/command-deck.js";
import { dedupeSceneThrallStrikes } from "./spells/thrall-strike.js";
import { registerDicerSettings, setupDicerThemes } from "./system/dicer-themes.js";
import { registerNecroChatFx, registerStrikeArtSetting } from "./system/chat-fx.js";
import { setupTransientEffectHooks } from "./system/transient-effects.js";
import { resolveNecromancer, resolveNecromancerOrNotify, setupResolveHooks } from "./system/necro-resolve.js";
import { setupHooks, repairWorldThrallArt } from "./system/thrall-manager.js";
import { setupSocket } from "./system/socket.js";
import { checkBrowsePermissions } from "./system/permissions-notice.js";
import { sweepEmptyRegions } from "./system/region-sweep.js";
import { setupEffectColorHooks } from "./system/effect-colors.js";
import { notifyForce } from "./system/notify.js";
import { checkIcons } from "./system/icon-check.js";

async function toggleCommandDeck() {
    try {
        const existing = foundry.applications.instances.get("thrall-command-deck");
        if (existing?.rendered) {
            // The same necromancer closes the deck; a different one that the selection points at swaps it.
            const { actor: selected, reason } = await resolveNecromancer({ prompt: false });
            if (selected && reason?.startsWith("controlled") && selected.id !== existing.necroId) {
                return existing.setNecromancer(selected.id);
            }
            return existing.close();
        }

        const actor = await resolveNecromancerOrNotify();
        if (!actor) return;

        if (existing) {
            existing.necroId = actor.id;
            existing.render({ force: true });
            existing.bringToFront?.();
        } else {
            new ThrallCommandDeck(actor.id).render(true);
        }
    } catch (e) {
        console.error("Necromancer Helper | Command Deck failed to open:", e);
        notifyForce("error", `The Command Deck failed to open: ${e?.message ?? e}`);
    }
}

Hooks.once("setup", function () {
    if (!setupSocket()) {
        console.error("Error: Unable to set up socketlib for Necromancer Thrall Helper.");
    }
});

Hooks.once("init", () => {
    console.log("Necromancer Thrall Helper | Initializing the dark arts...");
    registerStrikeArtSetting();
    registerDicerSettings();
    setupDicerThemes();

    game.keybindings.register("necromancer-thrall-helper", "toggleCommandDeck", {
        name: "Toggle Thrall Command Deck",
        hint: "Opens or closes the Necromancer Thrall Command Deck.",
        editable: [],
        onDown: () => {
            toggleCommandDeck();
            return true;
        },
        restricted: false,
        precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
    });

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

    game.settings.register("necromancer-thrall-helper", "followSelection", {
        name: "Command Deck Follows Selection",
        hint: "If enabled, an open Command Deck switches to another necromancer when you select that necromancer or one of their thralls (you must own them).",
        scope: "world",
        config: true,
        type: Boolean,
        default: false
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

    game.settings.register("necromancer-thrall-helper", "promptEndCombatCleanup", {
        name: "Prompt Cleanup After Combat",
        hint: "If enabled, asks you when an encounter ends if you want to dismiss your active thralls and/or grave effects.",
        scope: "client",
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
    setupResolveHooks();
    setupTransientEffectHooks();
    registerNecroChatFx();
    globalThis.NecroThrallHelper = globalThis.NecroThrallHelper || {};
    globalThis.NecroThrallHelper.checkIcons = checkIcons; // dev check: await NecroThrallHelper.checkIcons()
    setupEffectColorHooks();
    const dedupe = () => dedupeSceneThrallStrikes().catch(err => console.warn("Necromancer Thrall Helper | Strike dedupe failed:", err));
    Hooks.on("canvasReady", dedupe);
    if (canvas.ready) dedupe();
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
        onChange: () => toggleCommandDeck()
    };

    let tokenControls;
    if (Array.isArray(controls)) {
        tokenControls = controls.find(c => c.name === "token");
        if (tokenControls && Array.isArray(tokenControls.tools)) {
            tokenControls.tools.push(thrallTool);
        }
    } else if (controls.tokens || controls.token) {
        tokenControls = controls.tokens || controls.token;
        if (Array.isArray(tokenControls.tools)) {
            tokenControls.tools.push(thrallTool);
        } else {
            tokenControls.tools["thrall-command"] = thrallTool;
        }
    }
});