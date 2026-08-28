let socketlibSocket = undefined;

async function requestSpawn(payload) {

    await canvas.pan({ x: payload.x, y: payload.y, duration: 400 });

    if (canvas.ping) {
        canvas.ping({ x: payload.x, y: payload.y });
    }

    const gridSize = canvas.grid.size;
    const highlight = new PIXI.Graphics();
    highlight.beginFill(0x990099, 0.4); 
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
        elevation: (payload.elevation || 0) + 1,
        hidden: false
    });

    const createdTokens = await scene.createEmbeddedDocuments("Token", [spawnData]);
    
    // Clean PIXI layer re-ordering to pop it to the visual top
    if (createdTokens && createdTokens.length > 0) {
        setTimeout(() => {
            const tokenObj = canvas.tokens.get(createdTokens[0].id);
            if (tokenObj && tokenObj.parent) {
                tokenObj.parent.addChild(tokenObj);
            }
        }, 100);
    }

    return createdTokens;
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
        const spawnData = foundry.utils.mergeObject(payload, { 
            x: payload.x, 
            y: payload.y, 
            elevation: (payload.elevation || 0) + 1, 
            hidden: false 
        });
        const createdTokens = await scene.createEmbeddedDocuments("Token", [spawnData]);
        
        if (createdTokens && createdTokens.length > 0) {
            setTimeout(() => {
                const tokenObj = canvas.tokens.get(createdTokens[0].id);
                if (tokenObj && tokenObj.parent) {
                    tokenObj.parent.addChild(tokenObj);
                }
            }, 100);
        }
        return createdTokens;
    } else {
        if (!socketlibSocket) {
            ui.notifications.error("Socketlib connection not established.");
            return;
        }
        return await socketlibSocket.executeAsGM("requestSpawn", payload);
    }
}