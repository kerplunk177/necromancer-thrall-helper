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
        sort: 100,
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
}

async function deleteTokenAsGM(tokenId) {
    const scene = game.scenes.active;
    if (!scene) return;
    const tokenDoc = scene.tokens.get(tokenId);
    if (tokenDoc) await tokenDoc.delete();
}

async function createHazardAsGM(regionData, drawingData) {
    const scene = game.scenes.active;
    if (!scene) return;
    
    const [region] = await scene.createEmbeddedDocuments("Region", [regionData]);
    let drawing = null;
    
    if (drawingData) {
        const [createdDrawing] = await scene.createEmbeddedDocuments("Drawing", [drawingData]);
        drawing = createdDrawing;
    }
    
    return { regionId: region?.id, drawingId: drawing?.id };
}

export const setupSocket = () => {
    if (globalThis.socketlib) {
        socketlibSocket = globalThis.socketlib.registerModule("necromancer-thrall-helper");
        if (socketlibSocket) {
            socketlibSocket.register("requestSpawn", requestSpawn);
            socketlibSocket.register("deleteTokenAsGM", deleteTokenAsGM);
            socketlibSocket.register("createHazardAsGM", createHazardAsGM);
        }
    }
    return !!socketlibSocket;
};

export async function executeSpawn(payload) {
    if (game.user.isGM) {
        const scene = game.scenes.active;
        if (!scene) return;
        const maxSort = Math.max(0, ...canvas.tokens.placeables.map(t => t.document.sort));
        const spawnData = foundry.utils.mergeObject(payload, { 
            x: payload.x, 
            y: payload.y, 
            elevation: payload.elevation ?? 0,
            sort: maxSort + 100, 
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
export async function executeDelete(tokenId) {
    if (game.user.isGM) {
        const tokenDoc = canvas.scene?.tokens.get(tokenId);
        if (tokenDoc) await tokenDoc.delete();
    } else {
        if (!socketlibSocket) {
            ui.notifications.error("Socketlib connection not established.");
            return;
        }
        await socketlibSocket.executeAsGM("deleteTokenAsGM", tokenId);
    }
}
export async function executeHazard(regionData, drawingData) {
    if (game.user.isGM) {
        return await createHazardAsGM(regionData, drawingData);
    } else {
        if (!socketlibSocket) {
            ui.notifications.error("Socketlib connection not established.");
            return;
        }
        return await socketlibSocket.executeAsGM("createHazardAsGM", regionData, drawingData);
    }
}

export async function executeDamage(tokenId, rollJSON) {
    if (game.user.isGM) {
        return await applyDamageAsGM(tokenId, rollJSON);
    } else {
        if (!socketlibSocket) {
            ui.notifications.error("Socketlib connection not established.");
            return;
        }
        return await socketlibSocket.executeAsGM("applyDamageAsGM", tokenId, rollJSON);
    }
}