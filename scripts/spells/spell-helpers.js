import { DMG_COLORS } from "../system/dmg-palette.js";
import { getGrantedSlugs, resolveImageSet, applyRingArt, tokenPortrait } from "../system/thrall-manager.js";
import { notify, notifyForce } from "../system/notify.js";
import { effectColorNum } from "../system/effect-colors.js";
import { executeDeleteBatch } from "../system/socket.js";
import { isNecroEffect } from "../system/effect-catalog.js";
import { createNecroCard } from "../system/necro-card.js";

export const THRALL_DMG_COLORS = { spirit: DMG_COLORS.spirit, void: DMG_COLORS.void, vitality: DMG_COLORS.vitality };

/**
 * Update a document only if it still exists; ignores "does not exist" race conditions.
 */
export async function updateIfExists(doc, data) {
    if (!doc || doc.collection?.has?.(doc.id) === false) return null;
    try {
        return await doc.update(data);
    } catch (err) {
        if (/does not exist/i.test(err?.message ?? "")) return null;
        throw err;
    }
}

export function getFascinations(actor) {
    if (!actor) return [];
    return [...new Set([
        ...getGrantedSlugs(actor, "grim-fascination"),
        ...getGrantedSlugs(actor, "widespread-fascination")
    ])];
}

export function actorHasSpiritFascination(actor) {
    return actor?.items.some(i => i.slug === "spirit" || i.name === "Spirit" || i.name.includes("Spirit Fascination"))
        || getFascinations(actor).includes("spirit")
        || false;
}

export function actorHasMasteryOfLifeAndDeath(actor) {
    return actor?.items.some(i => i.name === "Mastery of Life and Death" || i.slug === "mastery-of-life-and-death") || false;
}

export function canThrallDealVitality(actor) {
    return game.settings.get("necromancer-thrall-helper", "allowThrallVitality")
        && actorHasSpiritFascination(actor)
        && actorHasMasteryOfLifeAndDeath(actor);
}

/**
 * Calculate the highest spellcasting DC (or class DC fallback) for a Necromancer actor.
 */
export function getSpellDC(actor) {
    const level = actor?.level || 1;
    let spellDC = 10 + Math.floor(level * 1.5);
    if (actor?.spellcasting) {
        const entries = typeof actor.spellcasting.contents === "function"
            ? actor.spellcasting.contents()
            : Array.from(actor.spellcasting);
        let maxDC = 0;
        for (const entry of entries) {
            const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
            if (dcVal && dcVal > maxDC) maxDC = dcVal;
        }
        if (maxDC > 0) spellDC = maxDC;
    }
    if (spellDC === 10 && actor?.system?.attributes?.classDC?.dc) {
        spellDC = actor.system.attributes.classDC.dc.value;
    }
    return spellDC;
}

/**
 * Measure grid distance in feet between any two Token placeables or TokenDocuments.
 */
export function getTokenDistance(tokenA, tokenB) {
    if (!tokenA || !tokenB || !canvas.scene) return 999;
    const objA = tokenA.object || tokenA;
    const objB = tokenB.object || tokenB;
    if (typeof objA.distanceTo === "function" && typeof objB.center !== "undefined") {
        return objA.distanceTo(objB);
    }
    const ax = objA.center?.x ?? objA.x ?? 0;
    const ay = objA.center?.y ?? objA.y ?? 0;
    const bx = objB.center?.x ?? objB.x ?? 0;
    const by = objB.center?.y ?? objB.y ?? 0;
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    return (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
}

/**
 * Check if the Necromancer has Conjurer of Corpses.
 */
export function hasConjurerOfCorpses(actor) {
    return actor?.items.some(i =>
        ["spell", "feat", "action"].includes(i.type) &&
        (i.name.toLowerCase().includes("conjurer of corpses") || i.system?.slug?.includes("conjurer-of-corpses"))
    ) || false;
}

/**
 * Check that the Necromancer's sheet is set up for the deck: a Focus spellcasting entry, spells
 * in it, and a Focus Pool. Returns a list of problem codes, worst first (empty when all is well).
 */
export function checkNecroSpellcasting(actor) {
    if (!actor) return [];
    const entries = actor.items.filter(i => i.type === "spellcastingEntry");
    const focusEntries = entries.filter(e => e.isFocusPool === true || e.system?.prepared?.value === "focus");
    const problems = [];
    if (!focusEntries.length) {
        problems.push("noFocusEntry");
    } else {
        const ids = new Set(focusEntries.map(e => e.id));
        const hasSpells = actor.items.some(i => i.type === "spell" && ids.has(i.system?.location?.value));
        if (!hasSpells) problems.push("noFocusSpells");
    }
    if (!(actor.system?.resources?.focus?.max > 0)) problems.push("noFocusPool");
    return problems;
}

/**
 * Return all TokenDocuments on the current scene controlled as thralls by this Necromancer.
 */
export function getActorThrallTokens(actor, { includeReanimated = false } = {}) {
    if (!canvas.scene || !actor) return [];
    const hasConjurer = hasConjurerOfCorpses(actor);
    return canvas.scene.tokens.filter(t => {
        if (!includeReanimated && t.flags?.["necromancer-thrall-helper"]?.isReanimatedFoe) return false;
        const customMasterId = t.flags?.["necromancer-thrall-helper"]?.masterId;
        if (customMasterId && customMasterId === actor.id) return true;

        if (hasConjurer && t.actor) {
            const traits = t.actor.system?.traits?.value || [];
            const isUndead = traits.includes("undead") || traits.some(tr => typeof tr === "string" && tr.toLowerCase() === "undead");
            if (isUndead) {
                const pf2eMasterId = t.actor.getFlag("pf2e", "master")?.id;
                if (pf2eMasterId === actor.id) return true;
                if (t.name.startsWith(`${actor.name}'s`) || t.name.includes(actor.name)) return true;
            }
        }
        return false;
    });
}

/**
 * Build an ownership map granting owner permissions to the Necromancer's owners and the current user.
 */
export function buildOwnerMap(actor) {
    const ownerIds = Object.keys(actor?.ownership || {}).filter(k => actor.ownership[k] === 3 && k !== "default");
    const newOwnership = { default: 0 };
    ownerIds.forEach(id => { newOwnership[id] = 3; });
    newOwnership[game.user.id] = 3;
    return newOwnership;
}

/**
 * Snap a canvas stage position to the top-left grid vertex across Foundry v12/v13.
 */
export function snapTopLeft(pos) {
    if (canvas.grid.getSnappedPoint) {
        return canvas.grid.getSnappedPoint(pos, { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_VERTEX });
    }
    if (canvas.grid.getTopLeftPoint) {
        return canvas.grid.getTopLeftPoint(pos);
    }
    if (canvas.grid.getTopLeft) {
        const [x, y] = canvas.grid.getTopLeft(pos.x, pos.y);
        return { x, y };
    }
    return pos;
}

/**
 * Fetch an actor by name from the world, falling back to the module compendium.
 */
export async function getOrImportActor(actorName) {
    let actor = game.actors.find(a => a.name === actorName);
    if (actor) return actor;

    const pack = game.packs.get("necromancer-thrall-helper.necro-thralls");
    if (!pack) {
        notifyForce("error", "Could not find the Necromancer Thralls compendium pack.");
        return null;
    }

    const index = await pack.getIndex();
    const entry = index.find(a => a.name === actorName);
    if (!entry) {
        notify("error", `Could not find '${actorName}' in the compendium.`);
        return null;
    }

    return await pack.getDocument(entry._id);
}

/**
 * Apply custom token art, portrait, ring subject, and scale flags for a specific summon prefix.
 */
export async function applyCustomVisuals(payload, actor, typePrefix) {
    const img = actor.getFlag("necromancer-thrall-helper", `${typePrefix}Img`);
    const useRing = actor.getFlag("necromancer-thrall-helper", `${typePrefix}Ring`);
    const scale = actor.getFlag("necromancer-thrall-helper", `${typePrefix}Scale`);
    const ringScale = actor.getFlag("necromancer-thrall-helper", `${typePrefix}RingScale`);
    const portrait = actor.getFlag("necromancer-thrall-helper", `${typePrefix}Portrait`);
    const ringSubjectPath = actor.getFlag("necromancer-thrall-helper", `${typePrefix}RingSubject`);

    let ringBlocked = false;
    if (img || ringSubjectPath) {
        const set = await resolveImageSet(img || payload.texture?.src, { portrait, ringSubject: ringSubjectPath });
        if (img) {
            payload.texture = payload.texture || {};
            payload.texture.src = set.art;
        }
        if (payload.ring) {
            payload.ring.subject = payload.ring.subject || {};
            ringBlocked = applyRingArt(payload, set, payload.ring.subject.texture);
        }
        if (set.portrait) {
            foundry.utils.setProperty(payload, "flags.necromancer-thrall-helper.portrait", set.portrait);
        }
    }
    if (useRing !== undefined) {
        payload.ring = payload.ring || {};
        payload.ring.enabled = useRing;
    }
    if (ringBlocked && payload.ring) payload.ring.enabled = false;
    if (scale !== undefined) {
        payload.texture = payload.texture || {};
        payload.texture.scaleX = scale;
        payload.texture.scaleY = scale;
    }
    const effectiveRingScale = ringScale ?? scale;
    if (effectiveRingScale !== undefined && payload.ring?.subject) {
        payload.ring.subject.scale = effectiveRingScale;
    }
    return payload;
}

/**
 * Attach a range/counter HUD label and out-of-range X overlay to a PIXI placement ghost.
 */
export function attachGhostHUD(ghost, { width = canvas.grid.size, height = canvas.grid.size, necroCenter = null, maxRange = null, getCountText = null } = {}) {
    const overlay = new PIXI.Graphics();
    overlay.beginFill(0xff0000, 0.35);
    overlay.lineStyle(3, 0xff0000, 1);
    overlay.drawRect(0, 0, width, height);
    overlay.endFill();
    overlay.moveTo(0, 0);
    overlay.lineTo(width, height);
    overlay.moveTo(width, 0);
    overlay.lineTo(0, height);
    overlay.visible = false;
    ghost.addChild(overlay);

    const fontSize = Math.max(28, Math.round((canvas.grid?.size || 100) * 0.32));
    const badge = new PIXI.Text("", {
        fontFamily: "Signika",
        fontSize: fontSize,
        fontWeight: "bold",
        fill: 0x4ade80,
        stroke: 0x000000,
        strokeThickness: Math.max(5, Math.round(fontSize * 0.2)),
        dropShadow: true,
        dropShadowColor: 0x000000,
        dropShadowBlur: 4,
        dropShadowDistance: 0,
        align: "center"
    });
    badge.resolution = 2;
    badge.anchor.set(0.5, 1);
    badge.position.set(width / 2, -Math.round(fontSize * 0.3));
    ghost.addChild(badge);

    const origDestroy = ghost.destroy.bind(ghost);
    ghost.destroy = (opts) => origDestroy(opts ?? { children: true });

    return (snappedX, snappedY) => {
        let dist = 0;
        let inRange = true;
        if (necroCenter && maxRange && canvas.scene) {
            const targetCenter = { x: snappedX + (width * 0.5), y: snappedY + (height * 0.5) };
            const dx = Math.abs(necroCenter.x - targetCenter.x);
            const dy = Math.abs(necroCenter.y - targetCenter.y);
            dist = Math.round((Math.max(dx, dy) / canvas.grid.size) * (canvas.scene.grid.distance || 5));
            inRange = dist <= maxRange;
        }
        overlay.visible = !inRange;
        const countStr = getCountText ? getCountText() : "";
        const distStr = (necroCenter && maxRange) ? `${dist}ft` : "";
        if (!inRange) {
            badge.text = `OUT OF RANGE (${dist}ft / ${maxRange}ft)`;
            badge.style.fill = 0xff4444;
        } else {
            badge.text = [countStr, distStr].filter(Boolean).join(" • ");
            badge.style.fill = 0x4ade80;
        }
    };
}

/**
 * Draw a temporary PIXI range ring around the Necromancer's active token.
 */
export function createRangeIndicator(actor, rangeFeet, fillAlpha = 0.05) {
    const necroTokens = actor?.getActiveTokens() || [];
    if (necroTokens.length === 0 || !canvas.scene) return { necroCenter: null, rangeIndicator: null };

    const necroCenter = necroTokens[0].center;
    const rangeInPixels = (rangeFeet / canvas.scene.grid.distance) * canvas.grid.size;
    const rangeIndicator = new PIXI.Graphics();
    rangeIndicator.beginFill(effectColorNum(actor, "rangeRing", "#22c55e"), fillAlpha);
    rangeIndicator.lineStyle(3, effectColorNum(actor, "rangeRing", "#22c55e"), 0.5);
    rangeIndicator.drawCircle(necroCenter.x, necroCenter.y, rangeInPixels);
    rangeIndicator.endFill();
    rangeIndicator.zIndex = 998;
    canvas.tokens.addChild(rangeIndicator);

    return { necroCenter, rangeIndicator };
}

const SPELL_PACK = "pf2e.spells-srd";
/** Official PF2e spells by the name the module uses: [pack item id, slug]. Bone Burst is a feat, so it has none. */
const OFFICIAL_SPELLS = {
    "Bone Spear": ["4JXxqBXigKECcpTm", "bone-spear"],
    "Dead Weight": ["4kQMFyRKj5Gv13zl", "dead-weight"],
    "Blood Infusion": ["tFWa3ouvMC5Zz3P0", "blood-infusion"],
    "Flesh Tsunami": ["jtACJQc6n9ZaG9kA", "flesh-tsunami"],
    "Temporary Possession": ["yZpWaJzm7kUjKvlQ", "temporary-possession"],
    "Calcification": ["L13n9NKvfGLApse1", "calcification"],
    "Deathly Scream": ["aIPa7Yp4vGeKIKNG", "deathly-scream"],
    "Necrotic Bomb": ["cg1l2AxBenLU6JFE", "necrotic-bomb"],
    "Life Tap": ["fgmxDC2PH2TEYGKG", "life-tap"],
    "Bony Barrage": ["yfaTZv8nCsS4GtrA", "bony-barrage"],
    "Dread Mosquito Storm": ["Q6cvsLytYffpeN3g", "dread-mosquito-storm"],
    "Zombie Horde": ["ziujByCygD3MO2CK", "zombie-horde"],
    "Bloody Tendrils": ["qy5NVKy2A3LwNleW", "bloody-tendrils"],
    "Recurring Nightmare": ["ecXhGEAX3PYd6FqK", "recurring-nightmare"]
};
const officialSpellCache = new Map();

/**
 * The official PF2e spell as plain item data: looked up by UUID, then by slug (so renames and
 * translated names don't break it). Null when it can't be found.
 */
export async function getOfficialSpellData(name) {
    const ref = OFFICIAL_SPELLS[name];
    if (!ref) return null;
    if (!officialSpellCache.has(name)) {
        officialSpellCache.set(name, (async () => {
            const [id, slug] = ref;
            try {
                let doc = await fromUuid(`Compendium.${SPELL_PACK}.Item.${id}`);
                if (!doc) {
                    const pack = game.packs.get(SPELL_PACK);
                    const entry = (await pack?.getIndex({ fields: ["system.slug"] }))?.find(e => e.system?.slug === slug);
                    doc = entry ? await pack.getDocument(entry._id) : null;
                }
                if (!doc || doc.type !== "spell") return null;
                const data = doc.toObject();
                for (const k of ["_id", "folder", "ownership", "_stats", "sort"]) delete data[k];
                data._stats = { compendiumSource: doc.uuid };
                return data;
            } catch { return null; }
        })());
    }
    const data = await officialSpellCache.get(name);
    return data ? foundry.utils.deepClone(data) : null;
}

/**
 * Item data for a spell the module adds to an actor: a copy of the official PF2e spell (art, traits,
 * text) with the module's rank, DC and damage applied; an inline stand-in when it can't be found.
 */
export async function buildNecroSpellData(name, img, systemData) {
    const official = await getOfficialSpellData(name);
    if (!official) return { name, type: "spell", img, system: systemData };
    for (const key of ["level", "defense", "damage"]) {
        if (systemData[key] !== undefined) official.system[key] = foundry.utils.deepClone(systemData[key]);
    }
    return official;
}

/**
 * Find or create a Necromancer spell on the actor and apply system data + AoE Easy Resolve flags.
 */
export async function ensureNecroSpell(actor, { name, img, systemData, aoeFlags = {}, necroFlags = {}, extraUpdates = {} }) {
    let spell = actor.items.find(i => ["spell", "feat", "action"].includes(i.type) && i.name === name);
    if (!spell) {
        const created = await actor.createEmbeddedDocuments("Item", [await buildNecroSpellData(name, img, systemData)]);
        spell = created[0];
    } else {
        await spell.update({ system: systemData, ...extraUpdates });
    }
    for (const [k, v] of Object.entries(aoeFlags)) {
        await spell.setFlag("aoe-easy-resolve", k, v);
    }
    for (const [k, v] of Object.entries(necroFlags)) {
        await spell.setFlag("necromancer-thrall-helper", k, v);
    }
    return spell;
}

/**
 * Render and post an AoE Easy Resolve manual-target save card for 1 or more tokens.
 */
export async function postManualSaveCard({
    actor,
    spell,
    itemName,
    saveTypeLabel,
    saveTypeSlug,
    saveDC,
    targetTokens,
    flavor = undefined,
    wrapContent = null,
    isBasicSave = false,
    templateId = null,
    extraAoeFlags = {}
}) {
    const targetsData = {};
    for (const t of targetTokens) {
        const doc = t.document || t;
        targetsData[doc.id] = {
            id: doc.id,
            name: doc.name,
            img: tokenPortrait(doc),
            hasRolled: false,
            rollTotal: null,
            degreeOfSuccess: null,
            isHealing: false,
            isImmune: false,
            hasApplied: false
        };
    }

    const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
    const htmlContent = await renderTemplate(templatePath, {
        targets: Object.values(targetsData),
        itemName,
        saveType: saveTypeLabel,
        saveDC
    });

    const msgData = {
        speaker: ChatMessage.getSpeaker({ actor }),
        content: wrapContent ? wrapContent(htmlContent) : htmlContent,
        flags: {
            "aoe-easy-resolve": {
                templateId,
                documentName: "ManualTarget",
                itemUuid: spell.uuid,
                itemName,
                saveType: saveTypeSlug,
                saveDC,
                isBasicSave,
                targets: targetsData,
                hazardDamage: null,
                isReactive: false,
                originMessageId: null,
                ...extraAoeFlags
            }
        }
    };
    if (flavor) msgData.flavor = flavor;
    return await createNecroCard(msgData);
}

// Register global graphics helpers on globalThis.NecroThrallHelper
globalThis.NecroThrallHelper = globalThis.NecroThrallHelper || {};

globalThis.NecroThrallHelper.purgeGraphics = (sceneId, { regionIds = [], drawingIds = [], templateIds = [] }) => {
    if (game.user.isGM) {
        const scene = game.scenes.get(sceneId);
        if (!scene) return;
        if (regionIds.length) scene.deleteEmbeddedDocuments("Region", regionIds.filter(id => scene.regions.has(id))).catch(() => {});
        if (drawingIds.length) scene.deleteEmbeddedDocuments("Drawing", drawingIds.filter(id => scene.drawings.has(id))).catch(() => {});
        if (templateIds.length) scene.deleteEmbeddedDocuments("MeasuredTemplate", templateIds.filter(id => scene.templates.has(id))).catch(() => {});
    } else {
        game.socket.emit("module.necromancer-thrall-helper", { action: "purgeMapGraphics", sceneId, regionIds, drawingIds, templateIds });
    }
};

globalThis.NecroThrallHelper.spawnOriginMarker = async (sceneId, drawingData, durationMs = 20000) => {
    if (game.user.isGM) {
        const scene = game.scenes.get(sceneId);
        if (!scene) return;
        const payload = foundry.utils.mergeObject(drawingData, { author: game.user.id });
        const [marker] = await scene.createEmbeddedDocuments("Drawing", [payload]).catch(() => []);
        if (marker) {
            setTimeout(() => {
                if (scene.drawings.has(marker.id)) {
                    scene.deleteEmbeddedDocuments("Drawing", [marker.id]).catch(() => {});
                }
            }, durationMs);
        }
    } else {
        game.socket.emit("module.necromancer-thrall-helper", {
            action: "spawnOriginMarker",
            sceneId,
            drawingData,
            durationMs
        });
    }
};
/**
 * Dismiss all active thrall tokens on the current scene belonging to this Necromancer.
 */
export async function dismissAllThrallsForActor(actor) {
    if (!actor || !canvas.scene) return 0;

    // Same set the deck lists, plus reanimated foes (they carry masterId too).
    const thrallIds = getActorThrallTokens(actor, { includeReanimated: true }).map(t => t.id);
    return await executeDeleteBatch(thrallIds, canvas.scene.id);
}

/**
 * Dismiss all active Necromancer regions, drawings, templates, and aura/tracker effects on the scene.
 */
export async function dismissAllEffectsForActor(actor) {
    if (!canvas.scene) return;

    const isNecroGraphic = (doc) => {
        const flags = doc.flags?.["necromancer-thrall-helper"];
        if (flags) {
            if (
                flags.stormRegionId ||
                flags.goreRegionId ||
                flags.isFleshTerrain ||
                flags.hazardId ||
                flags.poolId ||
                flags.isBloodPool ||
                flags.tendrilTetherId ||
                flags.anchorId ||
                flags.hordeId ||
                flags.source
            ) return true;
        }
        const originActorUuid = doc.flags?.pf2e?.origin?.actor;
        if (actor && originActorUuid && originActorUuid.endsWith(actor.id)) return true;
        return false;
    };

    const regionIds = canvas.scene.regions.filter(isNecroGraphic).map(r => r.id);
    const drawingIds = canvas.scene.drawings.filter(isNecroGraphic).map(d => d.id);
    const templateIds = canvas.scene.templates.filter(isNecroGraphic).map(t => t.id);

    if (regionIds.length || drawingIds.length || templateIds.length) {
        globalThis.NecroThrallHelper.purgeGraphics(canvas.scene.id, { regionIds, drawingIds, templateIds });
    }

    if (actor) {
        const effectIdsToRemove = actor.items.filter(i =>
            i.type === "effect" && (
                i.getFlag("necromancer-thrall-helper", "isHazardTracker") ||
                isNecroEffect(i, "hallowedEarth") ||
                isNecroEffect(i, "corruptedGround")
            )
        ).map(i => i.id);

        if (effectIdsToRemove.length > 0) {
            await actor.deleteEmbeddedDocuments("Item", effectIdsToRemove);
        }
    }
}