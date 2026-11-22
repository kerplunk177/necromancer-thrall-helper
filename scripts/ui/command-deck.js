import "../system/necro-hooks.js";
import { getFatalMethodName, tokenPortrait } from "../system/thrall-manager.js";
import { PortfolioEditor } from "./portfolio-editor.js";
import { executeDelete } from "../system/socket.js";
import { notify, notifyForce, guardAction } from "../system/notify.js";
import { userOwns } from "../system/necro-resolve.js";
import { findNecroEffect } from "../system/effect-catalog.js";
import { openDefaultLookDialog, openNecroSettingsDialog, openSpellcastingCheckDialog } from "./deck-dialogs.js";
import { bindHeaderSpellButtons, THRALL_ACTIONS } from "../spells/index.js";
import {
    THRALL_DMG_COLORS,
    actorHasSpiritFascination,
    actorHasMasteryOfLifeAndDeath,
    canThrallDealVitality,
    getFascinations,
    getTokenDistance,
    getActorThrallTokens,
    checkNecroSpellcasting,
    dismissAllThrallsForActor,
    dismissAllEffectsForActor
} from "../spells/spell-helpers.js";

export {
    actorHasSpiritFascination,
    actorHasMasteryOfLifeAndDeath,
    canThrallDealVitality,
    getFascinations
};

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// Thrall tokens with an action in flight. Stops double-clicks from running one action twice.
const BUSY_THRALLS = new Set();

export class ThrallCommandDeck extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "thrall-command-deck",
        classes: ["necro-thrall"],
        title: "Command Deck",
        tag: "form",
        position: { width: 350, height: "auto" },
        window: { icon: "fas fa-skull", resizable: true }
    };

    static PARTS = {
        main: { template: "modules/necromancer-thrall-helper/templates/command-deck.hbs" }
    };

    constructor(necroId, options = {}) {
        if (typeof necroId === "object") {
            options = necroId;
            necroId = null;
        }

        // The caller resolves and authorizes the necromancer (see resolveNecromancer).
        if (!necroId || !game.actors.get(necroId)) {
            throw new Error("Command Deck aborted: no necromancer was resolved.");
        }

        const savedPos = localStorage.getItem(`necro-deck-bounds-${game.user?.id}`);
        if (savedPos) {
            try {
                // Height is never restored: the deck sizes itself to its thralls (see _onRender).
                const { left, top, width } = JSON.parse(savedPos);
                options.position = foundry.utils.mergeObject(options.position || {}, { left, top, width });
            } catch (e) {
                console.error("Necromancer Helper | Failed to parse saved window position.");
            }
        }
        super(options);

        this.necroId = necroId;
        this.actionStates = {};
        this.spiritStates = {};
        this.imageCache = {};

        this._onCreateToken = Hooks.on("createToken", () => {
            if (this.rendered) setTimeout(() => this.render({ force: false }), 200);
        });
        this._onTokenUpdate = Hooks.on("updateToken", (_doc, changes) => {
            if (this.rendered && ("x" in changes || "y" in changes || "elevation" in changes)) {
                setTimeout(() => this.render({ force: false }), 150);
            }
        });
        this._onTokenDelete = Hooks.on("deleteToken", () => {
            if (this.rendered) this.render({ force: false });
        });
        this._onActorUpdate = Hooks.on("updateActor", (doc) => {
            if (this.rendered && doc.id === this.necroId) this.render({ force: false });
        });
    }

    /** @override */
    async close(options) {
        Hooks.off("createToken", this._onCreateToken);
        Hooks.off("updateToken", this._onTokenUpdate);
        Hooks.off("deleteToken", this._onTokenDelete);
        Hooks.off("updateActor", this._onActorUpdate);
        return super.close(options);
    }

    async _prepareContext(options) {
        await super._prepareContext(options);
        const actor = game.actors.get(this.necroId);
        const necroLevel = actor?.level || 1;
        const dice = Math.max(1, Math.floor((necroLevel - 1) / 4) + 1);
        const damageScale = `${dice}d6`;
        const mapPenalty = this.currentMap !== undefined ? this.currentMap : 0;

        const necroToken = actor?.getActiveTokens()?.[0] || canvas.tokens?.placeables?.find(t => t.actor?.id === this.necroId);
        const thrallDocs = getActorThrallTokens(actor, { includeReanimated: false });

        const activeThralls = thrallDocs.map(t => {
            const tokenObj = t.object;
            let nearbyEnemies = 0;
            let nearbyFriendlies = 0;

            if (tokenObj && canvas.tokens?.placeables) {
                for (const other of canvas.tokens.placeables) {
                    if (other.id === tokenObj.id || !other.actor) continue;
                    if ((other.actor.system?.attributes?.hp?.value || 0) <= 0) continue;

                    if (getTokenDistance(tokenObj, other) <= 10) {
                        const alliance = other.actor.system?.details?.alliance;
                        const disp = other.document.disposition;
                        if (alliance === "opposition" || disp === CONST.TOKEN_DISPOSITIONS.HOSTILE) nearbyEnemies++;
                        else if (alliance === "party" || disp === CONST.TOKEN_DISPOSITIONS.FRIENDLY) nearbyFriendlies++;
                    }
                }
            }

            let imgPath = tokenPortrait(t) || "icons/svg/mystery-man.svg";
            if (imgPath && !imgPath.includes("mystery-man") && !imgPath.startsWith("data:") && !imgPath.startsWith("blob:")) {
                this.imageCache[t.id] = imgPath;
            } else if (this.imageCache[t.id]) {
                imgPath = this.imageCache[t.id];
            }

            const distToMaster = (necroToken && tokenObj) ? Math.round(getTokenDistance(tokenObj, necroToken)) : null;
            const hasMasterDist = distToMaster !== null;

            return {
                id: t.id,
                name: t.name,
                img: imgPath,
                nearbyEnemies,
                nearbyFriendlies,
                distToMaster,
                hasMasterDist,
                within30ft: !hasMasterDist || distToMaster <= 30,
                within60ft: !hasMasterDist || distToMaster <= 60,
                distClass: !hasMasterDist ? "" : (distToMaster > 60 ? "out-far" : (distToMaster > 30 ? "out-mid" : "in-range")),
                isConglomerate: t.name.toLowerCase().includes("conglomerate"),
                isLivingGraveyard: t.name.includes("Living Graveyard")
            };
        });

        const hasSpell = (spellName) => {
            const searchStr = spellName.toLowerCase().trim();
            const searchSlug = searchStr.replace(/\s+/g, "-");
            return actor?.items.some(i =>
                ["spell", "feat", "action"].includes(i.type) &&
                (i.name.toLowerCase().trim() === searchStr || i.system?.slug === searchSlug)
            ) || false;
        };
        const hasItemSubstring = (sub) => {
            const slugSub = sub.replace(/\s+/g, "-");
            return actor?.items.some(i =>
                ["spell", "feat", "action"].includes(i.type) &&
                (i.name.toLowerCase().includes(sub) || i.system?.slug?.includes(slugSub))
            ) || false;
        };

        const consumeUsed = actor?.getFlag("necromancer-thrall-helper", "consumeThrallUsed") || false;
        const currentFP = actor?.system?.resources?.focus?.value || 0;
        const maxFocus = Math.min(3, actor?.system?.resources?.focus?.max || 0);
        const focusPips = Array.from({ length: maxFocus }, (_, idx) => ({ index: idx + 1, filled: idx + 1 <= currentFP }));

        let consumeText = "Consume Thrall";
        let consumeDisabled = false;
        if (consumeUsed) {
            consumeText = "Consume Thrall (Used Today)";
            consumeDisabled = true;
        } else if (currentFP > 0) {
            consumeText = "Consume Thrall (Requires 0 FP)";
            consumeDisabled = true;
        }

        const hasBloodyTendrils = hasItemSubstring("bloody tendrils");
        const spellRank = Math.ceil(necroLevel / 2);
        const tendrilCount = hasBloodyTendrils ? (3 + Math.floor(Math.max(0, spellRank - 3) / 3)) : 0;

        const hasRecurringNightmare = hasSpell("Recurring Nightmare");
        const nightmareDestroyed = actor?.getFlag("necromancer-thrall-helper", "nightmareDestroyed") || false;
        const activeNightmare = activeThralls.some(t => t.name.includes("Recurring Nightmare"));
        const activeStorms = canvas.scene?.regions?.filter(r => r.getFlag("necromancer-thrall-helper", "stormRegionId")) || [];
        const activeGores = canvas.scene?.regions?.filter(r => r.getFlag("necromancer-thrall-helper", "goreRegionId")) || [];
        const activeHordes = canvas.scene?.tokens?.filter(t =>
            t.getFlag("necromancer-thrall-helper", "masterId") === this.necroId &&
            t.getFlag("necromancer-thrall-helper", "isHordeAnchor")
        ) || [];

        return {
            canBrowse: game.user.hasPermission("FILES_BROWSE"),
            actorName: actor?.name || "Necromancer",
            actorLevel: necroLevel,
            fatalMethod: getFatalMethodName(actor),
            maxFocus,
            focusPips,
            thrallDamage: damageScale,
            activeThralls,
            map0Active: mapPenalty === 0 ? "active" : "",
            map5Active: mapPenalty === -5 ? "active" : "",
            map10Active: mapPenalty === -10 ? "active" : "",
            consumeText,
            consumeDisabled,
            hasSpiritFascination: actorHasSpiritFascination(actor),
            hasThrallVitality: canThrallDealVitality(actor),
            hasPuppeteer: actor?.items.some(i => i.name.toLowerCase().includes("puppeteer") || i.system?.slug?.includes("puppeteer")) || false|| getFatalMethodName(actor)?.toLowerCase().includes("puppeteer"),
            hasDeathlyScream: hasSpell("Deathly Scream"),
            hasBindHeroicSpirit: hasSpell("Bind Heroic Spirit"),
            hasRecurringNightmare,
            canSustainNightmare: hasRecurringNightmare && nightmareDestroyed && !activeNightmare,
            canConjureNightmare: hasRecurringNightmare && !activeNightmare && !nightmareDestroyed,
            hasSkeletalLancers: hasSpell("Skeletal Lancers"),
            hasReanimateFoe: hasSpell("Reanimate Foe"),
            hasAmalgamate: hasSpell("Amalgamate"),
            hasFleshTsunami: hasSpell("Flesh Tsunami"),
            hasPerfectedThrall: hasSpell("Perfected Thrall"),
            hasTemporaryPossession: hasSpell("Temporary Possession"),
            hasSongOfTheSoul: hasSpell("Song of the Soul"),
            hasBonyBarrage: hasSpell("Bony Barrage"),
            hasCalcification: hasSpell("Calcification"),
            hasLivingGraveyard: hasSpell("Living Graveyard"),
            isGraveyardActive: activeThralls.some(t => t.isLivingGraveyard),
            hasBodyShield: hasSpell("Body Shield"),
            hasNecroticBomb: hasSpell("Necrotic Bomb"),
            hasLifeTap: hasSpell("Life Tap"),
            hasBloodInfusion: hasSpell("Blood Infusion"),
            hasBoneSpear: hasSpell("Bone Spear"),
            hasDeadWeight: hasSpell("Dead Weight"),
            hasDreadMosquitoStorm: hasSpell("Dread Mosquito Storm") || hasSpell("Dread Mosquito Swarm"),
            activeStormCount: activeStorms.length,
            hasBloodyTendrils,
            tendrilCount,
            hasBoneBurst: hasItemSubstring("bone burst"),
            hasCollateralReinforcement: hasItemSubstring("collateral reinforcement"),
            hasReclaimPower: hasItemSubstring("reclaim power"),
            hasZombieHorde: hasItemSubstring("zombie horde"),
            hasMuscleBarrier: hasSpell("Muscle Barrier"),
            hasConglomerateOfLimbs: hasSpell("Conglomerate of Limbs"),
            hasHallowedEarth: hasItemSubstring("hallowed earth"),
            hasCorruptedGround: hasItemSubstring("corrupted ground"),
            isHallowedActive: !!findNecroEffect(actor, "hallowedEarth"),
            isCorruptedActive: !!findNecroEffect(actor, "corruptedGround"),
            activeHordeCount: activeHordes.length,
            hasBlossomingGore: hasSpell("Blossoming Gore"),
            activeGoreCount: activeGores.length,
            hasInstantArmy: hasSpell("Instant Army"),
            instantArmyUsed: actor?.getFlag("necromancer-thrall-helper", "instantArmyUsed") || false
        };
    }

    /** Point the open deck at another necromancer and run the setup check for them. */
    setNecromancer(necroId) {
        if (!game.actors.get(necroId)) return;
        this.necroId = necroId;
        this.actionStates = {};
        this.spiritStates = {};
        this._spellcastingChecked = false;
        return this.render({ force: true });
    }

    /** Show the setup reminder if the user owns this Necromancer and hasn't suppressed it. */
    _checkSpellcasting() {
        const actor = game.actors.get(this.necroId);
        if (!actor || actor.getFlag("necromancer-thrall-helper", "suppressSpellcastingCheck")) return;
        // GMs implicitly own everything; only prompt them for characters they own explicitly.
        if (!userOwns(actor, { explicit: true })) return;
        openSpellcastingCheckDialog(actor, checkNecroSpellcasting(actor));
    }

    /** @override */
    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;

        // 0. Spellcasting / Focus Pool reminder, once per deck instance
        if (!this._spellcastingChecked) {
            this._spellcastingChecked = true;
            this._checkSpellcasting();
        }

        // Grow with the thrall list; past the viewport cap (CSS max-height) the list scrolls instead.
        this.setPosition({ height: "auto" });

        // 1. Persist window position and width once per instance
        if (!this._boundsListenerBound) {
            this._boundsListenerBound = true;
            html.addEventListener("pointerup", () => {
                if (!this.position) return;
                localStorage.setItem(`necro-deck-bounds-${game.user.id}`, JSON.stringify({
                    left: this.position.left,
                    top: this.position.top,
                    width: this.position.width
                }));
            });
        }

        // 2. Top-bar configuration & portfolio dialogs
        html.querySelector(".set-default-img-btn")?.addEventListener("click", (e) => {
            e.preventDefault();
            openDefaultLookDialog(game.actors.get(this.necroId) || game.user.character);
        });
        html.querySelector(".effect-colors-btn")?.addEventListener("click", (e) => {
            e.preventDefault();
            openNecroSettingsDialog(game.actors.get(this.necroId) || game.user.character);
        });
        html.querySelector(".edit-portfolio-btn")?.addEventListener("click", (e) => {
            e.preventDefault();
            const actor = game.actors.get(this.necroId);
            if (!actor) return notify("warn", "No Necromancer found!");
            new PortfolioEditor(actor).render(true);
        });

        // 3. Focus Pips & MAP Pips
        html.querySelectorAll(".focus-pip").forEach(pip => {
            pip.addEventListener("click", async (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId) || game.user.character;
                if (!actor) return;
                const clickedIndex = parseInt(e.currentTarget.dataset.index, 10);
                const currentFP = actor.system?.resources?.focus?.value || 0;
                const newFP = (clickedIndex === currentFP) ? currentFP - 1 : clickedIndex;
                await actor.update({ "system.resources.focus.value": Math.max(0, newFP) });
            });
        });

        html.querySelectorAll(".map-pip").forEach(pip => {
            pip.addEventListener("click", (e) => {
                this.currentMap = parseInt(e.currentTarget.dataset.value, 10);
                this.render();
            });
        });

        // 4. Bind all top-bar summon & utility buttons
        bindHeaderSpellButtons(this, html);

        // 5. Per-thrall dropdown & Spirit/Void/Vitality damage toggle buttons
        html.querySelectorAll(".action-dropdown").forEach(dropdown => {
            const thrallRow = dropdown.closest(".thrall-row");
            const thrallId = thrallRow.getAttribute("data-token-id");
            const toggleGroup = thrallRow.querySelector(".spirit-toggle-group");

            if (this.actionStates[thrallId]) dropdown.value = this.actionStates[thrallId];
            dropdown.addEventListener("change", (e) => { this.actionStates[thrallId] = e.target.value; });

            const updateToggle = () => {
                if (!toggleGroup) return;
                const val = dropdown.value;
                toggleGroup.style.display = (val === "strike" || val === "charge" || val === "conglomerate-charge") ? "flex" : "none";
            };
            dropdown.addEventListener("change", updateToggle);
            updateToggle();

            if (toggleGroup) {
                const savedType = this.spiritStates[thrallId] || "bludgeoning";
                const targetBtn = toggleGroup.querySelector(`[data-type="${savedType}"]`);
                if (targetBtn) {
                    toggleGroup.querySelectorAll(".spirit-dmg-btn").forEach(b => {
                        b.classList.remove("active");
                        b.style.background = "#222";
                        b.style.color = "#999";
                    });
                    targetBtn.classList.add("active");
                    targetBtn.style.background = THRALL_DMG_COLORS[savedType] ?? "#555";
                    targetBtn.style.color = "#fff";
                }
            }
        });

        html.querySelectorAll(".spirit-dmg-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                const group = btn.closest(".spirit-toggle-group");
                const thrallId = btn.closest(".thrall-row").getAttribute("data-token-id");
                const type = btn.getAttribute("data-type");

                this.spiritStates[thrallId] = type;
                group.querySelectorAll(".spirit-dmg-btn").forEach(b => {
                    b.classList.remove("active");
                    b.style.background = "#222";
                    b.style.color = "#999";
                });
                btn.classList.add("active");
                btn.style.background = THRALL_DMG_COLORS[type] ?? "#555";
                btn.style.color = "#fff";
            });
        });

        // 6. Per-thrall Execute button router
        html.querySelectorAll(".execute-btn").forEach(btn => {
            btn.addEventListener("click", async (e) => {
                e.preventDefault();
                const row = e.currentTarget.closest(".thrall-row");
                const tokenId = row.dataset.tokenId;
                if (BUSY_THRALLS.has(tokenId)) return;
                const action = row.querySelector(".action-dropdown").value;
                const actor = game.actors.get(this.necroId) || game.user.character;

                if (!actor || !canvas.scene) return notify("error", "Execution Failed: Necromancer or Canvas not found.");
                const tokenDoc = canvas.scene.tokens.get(tokenId);
                if (!tokenDoc) return notify("error", "Execution Failed: Thrall token not found on the canvas.");
                if (!tokenDoc.actor?.isOwner) return notifyForce("warn", "You don't own this thrall. Ask the GM to give you ownership.");

                const handler = THRALL_ACTIONS[action];
                if (!handler) return;
                const button = e.currentTarget;
                BUSY_THRALLS.add(tokenId);
                button.disabled = true;
                try {
                    await guardAction(() => handler({ deck: this, actor, tokenDoc, tokenId, event: e }));
                } finally {
                    BUSY_THRALLS.delete(tokenId);
                    if (button.isConnected) button.disabled = false;
                }
            });
        });

        // 7. Per-thrall Dismiss, Click-to-Pan, and Hover Sync
        html.querySelectorAll(".kill-btn").forEach(killBtn => {
            killBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const tokenId = e.currentTarget.closest(".thrall-row")?.dataset?.tokenId;
                const tokenDoc = canvas.scene?.tokens?.get(tokenId);
                if (tokenDoc) {
                    await executeDelete(tokenDoc.id);
                    notify("info", `Dismissed ${tokenDoc.name}.`);
                }
            });
        });

        html.querySelectorAll(".thrall-top").forEach(top => {
            top.addEventListener("click", (e) => {
                e.preventDefault();
                const tokenId = e.currentTarget.closest(".thrall-row")?.dataset?.tokenId;
                if (!tokenId || !canvas.scene) return;
                const token = canvas.tokens.get(tokenId);
                if (token) {
                    token.control({ releaseOthers: !e.shiftKey });
                    canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
                }
            });
        });

        html.querySelectorAll(".thrall-row").forEach(row => {
            row.addEventListener("mouseenter", (e) => {
                const token = canvas.tokens?.get(row.dataset.tokenId);
                if (token && token.isVisible && !token.controlled) token._onHoverIn(e);
            });
            row.addEventListener("mouseleave", (e) => {
                const token = canvas.tokens?.get(row.dataset.tokenId);
                if (token && token.isVisible && !token.controlled) token._onHoverOut(e);
            });
        });

        // 8. Dismiss All Thralls & Dismiss All Effects footer buttons
        const dismissAllBtn = html.querySelector(".dismiss-all-btn");
        if (dismissAllBtn) {
            dismissAllBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                dismissAllBtn.disabled = true;
                const actor = game.actors.get(this.necroId) || game.user.character;
                try {
                    await dismissAllThrallsForActor(actor);
                    notify("info", "All thralls dismissed.");
                } catch (err) {
                    console.error(err);
                    notify("error", `Dismiss All Thralls failed: ${err?.message ?? err}`);
                } finally {
                    dismissAllBtn.disabled = false;
                    this.render({ force: false });
                }
            });
        }

        const dismissEffectsBtn = html.querySelector(".dismiss-effects-btn");
        if (dismissEffectsBtn) {
            dismissEffectsBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                dismissEffectsBtn.disabled = true;
                const actor = game.actors.get(this.necroId) || game.user.character;
                try {
                    await dismissAllEffectsForActor(actor);
                    notify("info", "All grave effects and hazards dismissed.");
                } catch (err) {
                    console.error(err);
                    notify("error", `Dismiss All Effects failed: ${err?.message ?? err}`);
                } finally {
                    dismissEffectsBtn.disabled = false;
                    setTimeout(() => this.render({ force: false }), 150);
                }
            });
        }
    }
}