let socketlibSocket = undefined;

async function requestSpawn(payload) {
    // 1. Automatically pan the GM camera to the target location
    await canvas.pan({ x: payload.x, y: payload.y, duration: 400 });

    // 2. Ping the map so the GM's eye is drawn straight to it
    if (canvas.ping) {
        canvas.ping({ x: payload.x, y: payload.y });
    }

    // 3. Draw a temporary highlighted box on the GM's screen
    const gridSize = canvas.grid.size;
    const highlight = new PIXI.Graphics();
    highlight.beginFill(0x990099, 0.4); // Summoner purple glow
    highlight.lineStyle(3, 0xff00ff, 0.9);
    highlight.drawRect(0, 0, gridSize, gridSize);
    highlight.endFill();
    highlight.position.set(payload.x, payload.y);
    highlight.zIndex = 2000;
    canvas.tokens.addChild(highlight);

    const masterId = payload.flags?.["necromancer-thrall-helper"]?.masterId;
    const necro = masterId ? game.actors.get(masterId) : null;
    const necroName = necro ? necro.name : "A Necromancer";

    let confirm = true;
    try {
        confirm = await Dialog.confirm({
            title: "Thrall Summon Request",
            content: `<p><b>${necroName}</b> is attempting to summon a Thrall at this highlighted location. Allow?</p>`,
            yes: () => true,
            no: () => false,
            defaultYes: true
        });
    } catch (e) {
        console.error("Necromancer Helper | Dialog confirmation failed:", e);
    }

    // Remove the highlight box once the GM makes a choice
    highlight.destroy();

    if (!confirm) {
        console.log("Necromancer Thrall Helper | GM denied the spawn request.");
        return;
    }

    const scene = game.scenes.active;
    if (!scene) {
        ui.notifications.warn("No active scene to spawn the Thrall.");
        return;
    }

    const spawnData = foundry.utils.mergeObject(payload, {
        x: payload.x,
        y: payload.y,
        hidden: false
    });

    return await scene.createEmbeddedDocuments("Token", [spawnData]);
}

export const setupSocket = () => {
    if (globalThis.socketlib) {
        socketlibSocket = globalThis.socketlib.registerModule("necromancer-thrall-helper");
        if (socketlibSocket) {
            socketlibSocket.register("requestSpawn", requestSpawn);
        }
    }
    return !!socketlibSocket;
};

export async function executeSpawn(payload) {
    if (game.user.isGM) {
        const scene = game.scenes.active;
        if (!scene) return;
        const spawnData = foundry.utils.mergeObject(payload, { x: payload.x, y: payload.y, hidden: false });
        return await scene.createEmbeddedDocuments("Token", [spawnData]);
    } else {
        if (!socketlibSocket) {
            ui.notifications.error("Socketlib connection not established.");
            return;
        }
        return await socketlibSocket.executeAsGM("requestSpawn", payload);
    }
}