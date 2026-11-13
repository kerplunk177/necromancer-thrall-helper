import { applyArtFallback, applyPartyAlliance, resolvePendingWildcard } from "./thrall-manager.js";
import { finalizePendingZone } from "./tendril-zone.js";
import { notify, notifyForce } from "./notify.js";

let socketlibSocket = undefined;

/**
 * Draw a placement marker on the token layer. `label` (e.g. "2") is centered on the square so
 * several simultaneous requests can be told apart. Returns the Graphics object, or null.
 */
function drawSpawnMarker(x, y, label) {
    if (!canvas.ready || !canvas.tokens) return null;
    const gridSize = canvas.grid.size;
    const marker = new PIXI.Graphics();
    marker.beginFill(0x990099, 0.4);
    marker.lineStyle(3, 0xff00ff, 0.9);
    marker.drawRect(0, 0, gridSize, gridSize);
    marker.endFill();
    marker.position.set(x, y);
    marker.zIndex = 2000;
    if (label !== undefined && label !== null) {
        const text = new PIXI.Text(String(label), {
            fontFamily: "Signika, sans-serif",
            fontSize: Math.round(gridSize * 0.5),
            fontWeight: "bold",
            fill: 0xffffff,
            stroke: 0x1a001a,
            strokeThickness: Math.max(3, Math.round(gridSize * 0.06))
        });
        text.anchor.set(0.5);
        text.position.set(gridSize / 2, gridSize / 2);
        marker.addChild(text);
    }
    canvas.tokens.addChild(marker);
    return marker;
}

function clearSpawnMarker(marker) {
    if (!marker || marker.destroyed) return;
    marker.parent?.removeChild(marker);
    marker.destroy({ children: true });
}

// Inevitable Return: what happens to the corpse token the new thrall rose from. GM-side only.
let rememberedCorpseFate = null; // "keep" | "hide", for this session once the GM ticks "Remember"

const CORPSE_NOTE = "Hidden corpses can't be looted by players (Lootable NPCs).";

function corpseFateHtml(name, group) {
    const esc = foundry.utils.escapeHTML ?? (t => t);
    return `<fieldset class="thrall-corpse-fate" style="margin:2px 0 6px 28px;padding:4px 8px;">
        <legend><small>Corpse: ${esc(name)}</small></legend>
        <label style="display:block;"><input type="radio" name="${group}" value="keep" checked> Keep corpse on board</label>
        <label style="display:block;"><input type="radio" name="${group}" value="hide"> Hide corpse</label>
    </fieldset>`;
}

/** Hide the corpse token if the GM chose to. Never throws: the token may already be gone. */
async function applyCorpseFate(corpse, fate) {
    if (!game.user.isGM || fate !== "hide" || !corpse) return;
    const scene = game.scenes.get(corpse.sceneId);
    const tokenDoc = scene?.tokens.get(corpse.tokenId);
    if (tokenDoc) await tokenDoc.update({ hidden: true }).catch(() => {});
}

/** GM-initiated spawn: ask what to do with the corpse once the thrall has risen. */
async function promptCorpseFate(corpse) {
    if (rememberedCorpseFate) return applyCorpseFate(corpse, rememberedCorpseFate);
    const { DialogV2 } = foundry.applications.api;
    const result = await DialogV2.wait({
        window: { title: "Inevitable Return", icon: "fas fa-skull" },
        content: `<p>The thrall has risen. What should happen to the corpse?</p>
            ${corpseFateHtml(corpse.name ?? "corpse", "corpse-fate")}
            <label style="display:block;margin-top:6px;"><input type="checkbox" name="remember"> Remember for this session</label>
            <p><small>${CORPSE_NOTE}</small></p>`,
        rejectClose: false,
        buttons: [{
            action: "ok",
            label: "Confirm",
            icon: "fas fa-check",
            default: true,
            callback: (event, button, dialog) => ({
                fate: dialog.element.querySelector("input[name=corpse-fate]:checked")?.value ?? "keep",
                remember: dialog.element.querySelector("input[name=remember]")?.checked ?? false
            })
        }]
    });
    if (!result) return; // closed: leave the corpse as it is
    if (result.remember) rememberedCorpseFate = result.fate;
    await applyCorpseFate(corpse, result.fate);
}

/**
 * A group of placements sent to the GM as ONE approval request. Players queue each placement
 * (numbered markers on their own map) and call finish(); a GM's placements spawn immediately,
 * as before. Keys while a batch is open: Esc undoes the last placement (cancels when none are
 * left), Enter sends what is placed so far.
 */
export function createSpawnBatch({ sceneId = canvas.scene?.id } = {}) {
    const isGM = game.user.isGM;
    const items = [];
    let keyHandler = null;

    const unbind = () => {
        if (!keyHandler) return;
        window.removeEventListener("keydown", keyHandler, true);
        keyHandler = null;
    };
    const clearAll = () => {
        for (const it of items) clearSpawnMarker(it.marker);
        items.length = 0;
    };

    const batch = {
        get size() { return items.length; },

        /** Queue a placement (players) or spawn it right away (GM). */
        add(payload, extras = {}) {
            if (isGM) return executeSpawn(payload, sceneId, extras).catch(err => console.error(err));
            const marker = canvas.scene?.id === sceneId
                ? drawSpawnMarker(payload.x, payload.y, items.length + 1)
                : null;
            items.push({ payload, marker, corpse: extras.corpse ?? null, region: extras.region ?? null });
            return items.length;
        },

        /** Remove the last queued placement. False if there was nothing to undo. */
        undo() {
            const last = items.pop();
            if (!last) return false;
            clearSpawnMarker(last.marker);
            return true;
        },

        /** Drop everything without sending. */
        cancel() {
            unbind();
            clearAll();
        },

        /** Send everything queued as one request. Resolves with the GM's answer, or null. */
        async finish() {
            unbind();
            if (isGM || !items.length) {
                clearAll();
                return null;
            }
            if (!socketlibSocket) {
                clearAll();
                notifyForce("error", "Socketlib connection not established.");
                return null;
            }
            const total = items.length;
            const necroId = items[0].payload.flags?.["necromancer-thrall-helper"]?.masterId ?? null;
            const request = {
                sceneId,
                necroId,
                items: items.map((it, i) => ({ index: i + 1, payload: it.payload, corpse: it.corpse, region: it.region }))
            };
            try {
                const result = await socketlibSocket.executeAsGM("requestSpawnBatch", request);
                const approved = result?.approved?.length ?? 0;
                if (!approved) notify("warn", total > 1 ? "The GM denied the summon request." : "The GM denied the summon.");
                else if (total > 1) notify("info", `${approved} of ${total} thralls approved.`);
                return result;
            } catch (err) {
                console.error("Necromancer Thrall Helper | Spawn request failed:", err);
                notifyForce("error", "The summon request failed.");
                return null;
            } finally {
                clearAll();
            }
        },

        /**
         * Hook Esc / Enter for the placement loop. `onUndo` runs after a placement was undone;
         * `onCancel` when Esc is pressed with nothing left; `onFinish` on Enter (after the batch
         * was sent). The caller stops its own placement listeners in the last two.
         */
        bindKeys({ onUndo, onCancel, onFinish } = {}) {
            unbind();
            keyHandler = (ev) => {
                if (ev.key === "Escape") {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (batch.undo()) onUndo?.();
                    else { batch.cancel(); onCancel?.(); }
                } else if (ev.key === "Enter" && items.length) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    onFinish?.();
                    batch.finish();
                }
            };
            window.addEventListener("keydown", keyHandler, true);
        }
    };
    return batch;
}

/** GM side: one approval dialog for a group of requested spawns. */
async function requestSpawnBatch({ sceneId, necroId, items = [] } = {}) {
    const scene = game.scenes.get(sceneId) || canvas.scene || game.scenes.active;
    if (!scene) {
        notify("warn", "No valid scene found to spawn the Thrall.");
        return { approved: [], denied: items.map(i => i.index), tokens: [] };
    }
    if (!items.length) return { approved: [], denied: [], tokens: [] };

    const isViewingScene = () => canvas.ready && canvas.scene?.id === scene.id;
    const markers = new Map();
    try {
        if (isViewingScene()) {
            const grid = canvas.grid.size;
            const cx = items.reduce((t, i) => t + i.payload.x, 0) / items.length + grid / 2;
            const cy = items.reduce((t, i) => t + i.payload.y, 0) / items.length + grid / 2;
            await canvas.animatePan({ x: cx, y: cy, duration: 400 });
            if (canvas.ping) canvas.ping({ x: cx, y: cy });
            for (const it of items) markers.set(it.index, drawSpawnMarker(it.payload.x, it.payload.y, it.index));
        }

        const necro = necroId ? game.actors.get(necroId) : null;
        const necroName = necro ? necro.name : "A Necromancer";
        let approvedIndexes;
        let fates = {};

        if (game.settings.get("necromancer-thrall-helper", "autoApproveSpawns")) {
            approvedIndexes = items.map(i => i.index);
        } else {
            const answer = await askApproval({ items, scene, necroName, markers });
            approvedIndexes = answer.approved;
            fates = answer.corpse;
        }

        const approvedSet = new Set(approvedIndexes);
        const approvedItems = items.filter(i => approvedSet.has(i.index));
        const denied = items.filter(i => !approvedSet.has(i.index)).map(i => i.index);
        if (!approvedItems.length) {
            console.log("Necromancer Thrall Helper | GM denied the spawn request.");
            return { approved: [], denied, tokens: [] };
        }

        const maxSort = Math.max(0, ...scene.tokens.map(t => t.sort || 0));
        const spawnData = [];
        for (const [n, it] of approvedItems.entries()) {
            const data = foundry.utils.mergeObject(it.payload, {
                x: it.payload.x,
                y: it.payload.y,
                elevation: it.payload.elevation ?? 0,
                sort: maxSort + 100 * (n + 1),
                hidden: false
            });
            await resolvePendingWildcard(data);
            await finalizePendingZone(data);
            applyPartyAlliance(data);
            applyArtFallback(data);
            spawnData.push(data);
        }
        const created = await scene.createEmbeddedDocuments("Token", spawnData);

        // Hazard regions (tendril saves) exist only for spawns that were approved and created.
        if (created?.length) {
            const regions = approvedItems.map(i => i.region).filter(Boolean);
            if (regions.length) await scene.createEmbeddedDocuments("Region", regions);
        }

        // Corpses are only touched for spawns that were actually approved and created.
        if (created?.length) {
            for (const it of approvedItems) {
                if (it.corpse) await applyCorpseFate(it.corpse, fates[it.index] ?? rememberedCorpseFate ?? "keep");
            }
        }

        if (created?.length && isViewingScene()) {
            setTimeout(() => {
                for (const doc of created) {
                    const tokenObj = canvas.tokens?.get(doc.id);
                    if (tokenObj?.parent) tokenObj.parent.addChild(tokenObj);
                }
            }, 100);
        }
        return {
            approved: approvedItems.map(i => i.index),
            denied,
            tokens: (created ?? []).map(t => ({ id: t.id }))
        };
    } finally {
        for (const marker of markers.values()) clearSpawnMarker(marker);
        markers.clear();
    }
}

/** Show the approval dialog. Resolves with { approved: [indexes], corpse: {index: "keep"|"hide"} }; closing denies all. */
async function askApproval({ items, scene, necroName, markers }) {
    const esc = foundry.utils.escapeHTML ?? (t => t);
    const n = items.length;
    const showCorpse = rememberedCorpseFate === null;
    const anyCorpse = items.some(i => i.corpse);
    const rows = items.map(it => `
        <label class="thrall-approve-row" data-index="${it.index}" style="display:flex;align-items:center;gap:8px;padding:3px 4px;border-radius:4px;">
            <input type="checkbox" name="approve" value="${it.index}" checked>
            <a class="thrall-approve-pan" data-index="${it.index}" title="Show on map"><b>#${it.index}</b></a>
            <span>${esc(it.payload.name || "Thrall")}</span>
        </label>${showCorpse && it.corpse ? corpseFateHtml(it.corpse.name ?? "corpse", `corpse-${it.index}`) : ""}`).join("");
    const content = `
        <p><b>${esc(necroName)}</b> wants to summon ${n} Thrall${n === 1 ? "" : "s"} on scene "<b>${esc(scene.name)}</b>". The requested spots are highlighted on the map.</p>
        <div class="thrall-approve-list">${rows}</div>${anyCorpse && showCorpse ? `
        <label style="display:block;margin-top:6px;"><input type="checkbox" name="remember"> Remember the corpse choice for this session</label>
        <p><small>${CORPSE_NOTE}</small></p>` : ""}`;

    const dim = (activeIndex) => {
        for (const [idx, marker] of markers) {
            if (marker && !marker.destroyed) marker.alpha = activeIndex === null || idx === activeIndex ? 1 : 0.35;
        }
    };

    const { DialogV2 } = foundry.applications.api;
    const result = await DialogV2.wait({
        window: { title: "Thrall Summon Request", icon: "fas fa-skull" },
        content,
        rejectClose: false,
        render: (event, dialog) => {
            for (const row of dialog.element.querySelectorAll(".thrall-approve-row")) {
                const idx = Number(row.dataset.index);
                row.addEventListener("mouseenter", () => { dim(idx); row.style.background = "rgba(168,85,247,0.2)"; });
                row.addEventListener("mouseleave", () => { dim(null); row.style.background = ""; });
            }
            for (const link of dialog.element.querySelectorAll(".thrall-approve-pan")) {
                link.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    const it = items.find(i => i.index === Number(link.dataset.index));
                    if (it && canvas.ready && canvas.scene?.id === scene.id) {
                        const grid = canvas.grid.size;
                        canvas.animatePan({ x: it.payload.x + grid / 2, y: it.payload.y + grid / 2, duration: 300 });
                    }
                });
            }
        },
        buttons: [
            {
                action: "approve",
                label: "Approve selected",
                icon: "fas fa-check",
                default: true,
                callback: (event, button, dialog) => {
                    const el = dialog.element;
                    const corpse = {};
                    for (const radio of el.querySelectorAll("input[type=radio][name^=corpse-]:checked")) {
                        corpse[Number(radio.name.slice("corpse-".length))] = radio.value;
                    }
                    if (el.querySelector("input[name=remember]")?.checked) {
                        rememberedCorpseFate = Object.values(corpse)[0] ?? rememberedCorpseFate;
                    }
                    return {
                        approved: [...el.querySelectorAll("input[name=approve]:checked")].map(i => Number(i.value)),
                        corpse
                    };
                }
            },
            { action: "deny", label: "Deny all", icon: "fas fa-times", callback: () => ({ approved: [], corpse: {} }) }
        ]
    });
    return result?.approved ? result : { approved: [], corpse: {} };
}

async function deleteTokenAsGM(tokenId, sceneId) {
    const scene = game.scenes.get(sceneId) || canvas.scene || game.scenes.active;
    if (!scene) return;
    const tokenDoc = scene.tokens.get(tokenId);
    if (tokenDoc) await tokenDoc.delete();
}

async function createHazardAsGM(regionData, drawingData, sceneId) {
    const scene = game.scenes.get(sceneId) || canvas.scene || game.scenes.active;
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
            socketlibSocket.register("requestSpawnBatch", requestSpawnBatch);
            socketlibSocket.register("deleteTokenAsGM", deleteTokenAsGM);
            socketlibSocket.register("createHazardAsGM", createHazardAsGM);
        }
    }
    return !!socketlibSocket;
};

export async function executeSpawn(payload, sceneId = canvas.scene?.id, extras = {}) {
    if (game.user.isGM) {
        const scene = game.scenes.get(sceneId) || canvas.scene || game.scenes.active;
        if (!scene) return;
        const maxSort = Math.max(0, ...scene.tokens.map(t => t.sort || 0));
        const spawnData = foundry.utils.mergeObject(payload, { 
            x: payload.x, 
            y: payload.y, 
            elevation: payload.elevation ?? 0,
            sort: maxSort + 100, 
            hidden: false 
        });
        await resolvePendingWildcard(spawnData);
        await finalizePendingZone(spawnData);
        applyPartyAlliance(spawnData);
        applyArtFallback(spawnData);
        const createdTokens = await scene.createEmbeddedDocuments("Token", [spawnData]);
        
        if (createdTokens && createdTokens.length > 0 && canvas.scene?.id === scene.id) {
            setTimeout(() => {
                const tokenObj = canvas.tokens?.get(createdTokens[0].id);
                if (tokenObj && tokenObj.parent) {
                    tokenObj.parent.addChild(tokenObj);
                }
            }, 100);
        }
        if (createdTokens?.length && extras.region) await scene.createEmbeddedDocuments("Region", [extras.region]);
        if (createdTokens?.length && extras.corpse) promptCorpseFate(extras.corpse).catch(err => console.error(err));
        return createdTokens;
    } else {
        if (!socketlibSocket) {
            notifyForce("error", "Socketlib connection not established.");
            return;
        }
        // A single request is a batch of one: same markers, same approval dialog.
        const batch = createSpawnBatch({ sceneId });
        batch.add(payload, extras);
        const result = await batch.finish();
        return result?.tokens ?? [];
    }
}

export async function executeDelete(tokenId, sceneId = canvas.scene?.id) {
    if (game.user.isGM) {
        const scene = game.scenes.get(sceneId) || canvas.scene || game.scenes.active;
        const tokenDoc = scene?.tokens.get(tokenId);
        if (tokenDoc) await tokenDoc.delete();
    } else {
        if (!socketlibSocket) {
            notifyForce("error", "Socketlib connection not established.");
            return;
        }
        await socketlibSocket.executeAsGM("deleteTokenAsGM", tokenId, sceneId);
    }
}

export async function executeHazard(regionData, drawingData, sceneId = canvas.scene?.id) {
    if (game.user.isGM) {
        return await createHazardAsGM(regionData, drawingData, sceneId);
    } else {
        if (!socketlibSocket) {
            notifyForce("error", "Socketlib connection not established.");
            return;
        }
        return await socketlibSocket.executeAsGM("createHazardAsGM", regionData, drawingData, sceneId);
    }
}