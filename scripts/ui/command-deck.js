import "../system/necro-hooks.js";
import { getFatalMethodName, tokenPortrait } from "../system/thrall-manager.js";
import { PortfolioEditor } from "./portfolio-editor.js";
import { executeDelete } from "../system/socket.js";
import { notify, notifyForce } from "../system/notify.js";
import { openDefaultLookDialog, openNecroSettingsDialog } from "./deck-dialogs.js";
import { bindHeaderSpellButtons, THRALL_ACTIONS } from "../spells/index.js";
import {
    THRALL_DMG_COLORS,
    actorHasSpiritFascination,
    actorHasMasteryOfLifeAndDeath,
    canThrallDealVitality,
    getFascinations,
    getTokenDistance,
    getActorThrallTokens
} from "../spells/spell-helpers.js";

export {
    actorHasSpiritFascination,
    actorHasMasteryOfLifeAndDeath,
    canThrallDealVitality,
    getFascinations
};

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

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

        if (!necroId) {
            const controlled = canvas.tokens?.controlled[0]?.actor;
            if (controlled) {
                necroId = controlled.id;
            } else if (game.user.character) {
                necroId = game.user.character.id;
            } else if (canvas.scene) {
                const existingThrall = canvas.scene.tokens.find(t => t.flags?.["necromancer-thrall-helper"]?.masterId);
                if (existingThrall) necroId = existingThrall.flags["necromancer-thrall-helper"].masterId;
            } else if (game.user.isGM) {
                const necro = game.actors.find(a => a.flags?.["necromancer-thrall-helper"]?.familyTree);
                if (necro) {
                    necroId = necro.id;
                    notify("info", `Auto-assigned Command Deck to ${necro.name}.`);
                }
            }
        }

        if (!necroId) {
            notify("warn", "No Necromancer found. Please select your token before opening the Command Deck.");
            throw new Error("Command Deck aborted: No valid Necromancer target.");
        }

        const actor = game.actors.get(necroId);
        const requireNecro = game.settings.get("necromancer-thrall-helper", "requireNecromancer");

        if (actor && requireNecro) {
            const isAuthorized = actor.items.some(i => {
                const name = i.name.toLowerCase();
                const slug = i.system?.slug || "";
                if (name.includes("necro") || slug.includes("necro") || name.includes("reanimator") || name.includes("undead master")) return true;
                if (name.includes("conjurer of corpses") || i.flags?.["necromancer-thrall-helper"]) return true;
                return false;
            });

            if (!isAuthorized && !game.user.isGM) {
                notifyForce("warn", "This mortal lacks the dark blood and discipline required to command the dead.");
                throw new Error("Unauthorized Command Deck access.");
            }
        }

        const savedPos = localStorage.getItem(`necro-deck-bounds-${game.user?.id}`);
        if (savedPos) {
            try {
                options.position = foundry.utils.mergeObject(options.position || {}, JSON.parse(savedPos));
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
            hasPuppeteer: actor?.items.some(i => i.name.toLowerCase().includes("puppeteer") || i.system?.slug?.includes("puppeteer")) || false,
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
            isHallowedActive: actor?.items.some(i => i.type === "effect" && i.name === "Effect: Hallowed Earth") || false,
            isCorruptedActive: actor?.items.some(i => i.type === "effect" && i.name === "Effect: Corrupted Ground") || false,
            activeHordeCount: 0,
            hasBlossomingGore: hasSpell("Blossoming Gore"),
            activeGoreCount: activeGores.length,
            hasInstantArmy: hasSpell("Instant Army"),
            instantArmyUsed: actor?.getFlag("necromancer-thrall-helper", "instantArmyUsed") || false
        };
    }

    /** @override */
    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;

        // 1. Persist window bounds once per instance
        if (!this._boundsListenerBound) {
            this._boundsListenerBound = true;
            html.addEventListener("pointerup", () => {
                if (!this.position) return;
                localStorage.setItem(`necro-deck-bounds-${game.user.id}`, JSON.stringify({
                    left: this.position.left,
                    top: this.position.top,
                    width: this.position.width,
                    height: this.position.height
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
                const action = row.querySelector(".action-dropdown").value;
                const actor = game.actors.get(this.necroId) || game.user.character;

                if (!actor || !canvas.scene) return notify("error", "Execution Failed: Necromancer or Canvas not found.");
                const tokenDoc = canvas.scene.tokens.get(tokenId);
                if (!tokenDoc) return notify("error", "Execution Failed: Thrall token not found on the canvas.");

                const handler = THRALL_ACTIONS[action];
                if (handler) {
                    await handler({ deck: this, actor, tokenDoc, tokenId, event: e });
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

        // 8. Dismiss All Thralls footer button
        if (!html.querySelector(".dismiss-all-btn")) {
            const tempDiv = document.createElement("div");
            tempDiv.innerHTML = `<button type="button" class="dismiss-all-btn" style="margin-top: 15px; width: 100%; padding: 6px;">Dismiss All Thralls</button>`;
            const dismissBtn = tempDiv.firstElementChild;
            html.appendChild(dismissBtn);

            dismissBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                dismissBtn.disabled = true;
                const actor = game.actors.get(this.necroId) || game.user.character;
                try {
                    if (game.user.isGM) {
                        for (const combat of game.combats) {
                            const badIds = combat.combatants.filter(c => {
                                if (!c.actor || !c.token || !canvas.scene?.tokens.get(c.tokenId)) return true;
                                if (actor && c.token.getFlag("necromancer-thrall-helper", "masterId") === actor.id) return true;
                                return false;
                            }).map(c => c.id);
                            if (badIds.length > 0) await combat.deleteEmbeddedDocuments("Combatant", badIds);
                        }
                    }
                    if (canvas.scene && actor) {
                        const thrallIds = canvas.scene.tokens
                            .filter(t => t.getFlag("necromancer-thrall-helper", "masterId") === actor.id)
                            .map(t => t.id);
                        for (const id of thrallIds) await executeDelete(id);
                    }
                } finally {
                    dismissBtn.disabled = false;
                    this.render(false);
                }
            });
        }
    }
}