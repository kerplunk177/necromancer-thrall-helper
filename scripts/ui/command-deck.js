import { prepareThrallPayload, getThrallPresets } from "../system/thrall-manager.js";
import { PortfolioEditor } from "./portfolio-editor.js";
import { executeSpawn } from "../system/socket.js";

Hooks.on("pf2e.restForTheNight", async (actor) => {
    if (actor.getFlag("necromancer-thrall-helper", "consumeThrallUsed")) {
        await actor.unsetFlag("necromancer-thrall-helper", "consumeThrallUsed");
    }
});
Hooks.on("updateChatMessage", async (message, changes, options, userId) => {
    if (!game.user.isGM) return;
    const aoeFlags = message.flags?.["aoe-easy-resolve"];
    if (!aoeFlags || aoeFlags.itemName !== "Dead Weight") return;

    const targets = aoeFlags.targets || {};
    for (const [tokenId, targetData] of Object.entries(targets)) {
        if (targetData.hasApplied && !targetData._deadWeightProcessed) {
            await message.update({ [`flags.aoe-easy-resolve.targets.${tokenId}._deadWeightProcessed`]: true });

            const targetToken = canvas.tokens.get(tokenId);
            if (!targetToken?.actor) continue;

            const dos = targetData.degreeOfSuccess;
            if (!dos || dos === "criticalSuccess") continue;

            try {
                if (typeof targetToken.actor.increaseCondition === "function") {
                    await targetToken.actor.increaseCondition("off-guard");

                    if (dos === "failure") {
                        await targetToken.actor.increaseCondition("slowed", { value: 1 });
                    } else if (dos === "criticalFailure") {
                        await targetToken.actor.increaseCondition("slowed", { value: 2 });
                    }
                }
            } catch (e) {
                console.error("Necromancer Helper", e);
            }

            let flavorText = dos === "success" ? "is dragged down, leaving them <b>Off-Guard</b>!" :
                             dos === "failure" ? "is burdened by the fusing flesh! They are <b>Slowed 1</b> and <b>Off-Guard</b>!" :
                             "is completely overwhelmed by the crushing corpse! They are <b>Slowed 2</b> and <b>Off-Guard</b>!";

            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: targetToken.actor }),
                flavor: `<strong>Dead Weight Result!</strong>`,
                content: `<p><b>${targetToken.name}</b> ${flavorText}</p>`
            });
        }
    }
});
Hooks.on("updateChatMessage", async (message, changes, options, userId) => {
    if (!game.user.isGM) return;
    const aoeFlags = message.flags?.["aoe-easy-resolve"];
    if (!aoeFlags || aoeFlags.itemName !== "Blood Infusion") return;

    const targets = aoeFlags.targets || {};
    const spellRank = aoeFlags.spellRank || 1;

    for (const [tokenId, targetData] of Object.entries(targets)) {
        if (targetData.hasApplied && !targetData._bloodInfusedProcessed) {
            await message.update({ [`flags.aoe-easy-resolve.targets.${tokenId}._bloodInfusedProcessed`]: true });

            const targetToken = canvas.tokens.get(tokenId);
            if (!targetToken?.actor) continue;

            const dos = targetData.degreeOfSuccess;
            if (!dos || dos === "criticalSuccess") continue; // Unaffected on critical success

            // 1. Apply Infused Blood effect with a 1-minute duration and strip bleed immunity
            try {
                const bleedEffect = {
                    name: "Infused Blood",
                    type: "effect",
                    img: "icons/magic/water/blood-drop-skull.webp",
                    system: {
                        description: { value: "Loses immunity to bleed and is considered a creature with blood for 1 minute." },
                        duration: { value: 1, unit: "minutes", expiry: null },
                        rules: [
                            { key: "Immunity", type: "bleed", mode: "remove" }
                        ]
                    }
                };
                await targetToken.actor.createEmbeddedDocuments("Item", [bleedEffect]);
            } catch (e) {
                console.error("Necromancer Helper | Failed to apply Infused Blood effect", e);
            }

            // 2. Determine damage string and invoke the native menu using increaseCondition
            let damageFormula = "";
            let damageDesc = "";
            if (dos === "success") {
                damageFormula = `${spellRank}`;
                damageDesc = `${spellRank} flat`;
            } else if (dos === "failure") {
                damageFormula = `${spellRank}d6`;
                damageDesc = `${spellRank}d6`;
            } else if (dos === "criticalFailure") {
                damageFormula = `${spellRank * 2}d6`;
                damageDesc = `${spellRank * 2}d6`;
            }

            try {
                if (typeof targetToken.actor.increaseCondition === "function") {
                    await targetToken.actor.increaseCondition("persistent-damage", { 
                        value: damageFormula, 
                        suboption: "bleed" 
                    });
                }
            } catch (e) {
                console.error("Necromancer Helper | Failed to apply persistent bleed condition", e);
            }

            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: targetToken.actor }),
                flavor: `<strong>Blood Infusion Result!</strong>`,
                content: `
                    <div style="background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; border-left: 4px solid #990000;">
                        <p style="margin: 0 0 4px 0;"><b>${targetToken.name}</b> is filled with foreign fluid! Their bleed immunity is stripped for 1 minute.</p>
                        <p style="margin: 0; font-size: 1.1em; color: #ff6b6b; font-weight: bold;">
                            Required Persistent Bleed: <span style="color: #fff;">${damageDesc} bleed damage</span> (${damageFormula})
                        </p>
                    </div>
                `
            });
        }
    }
});
Hooks.on("updateChatMessage", async (message, changes, options, userId) => {
    if (!game.user.isGM) return;
    const aoeFlags = message.flags?.["aoe-easy-resolve"];
    if (!aoeFlags || aoeFlags.itemName !== "Life Tap") return;

    const targets = aoeFlags.targets || {};
    for (const [tokenId, targetData] of Object.entries(targets)) {
        if (targetData.hasApplied && !targetData._lifeTapProcessed) {
            await message.update({ [`flags.aoe-easy-resolve.targets.${tokenId}._lifeTapProcessed`]: true });

            const targetToken = canvas.tokens.get(tokenId);
            if (!targetToken?.actor) continue;

            const dos = targetData.degreeOfSuccess;
            if (!dos || dos === "criticalSuccess") continue; // Unaffected on critical success

            const drainedVal = dos === "success" ? 1 : dos === "failure" ? 2 : 3;

            // 1. Apply the Drained condition natively using the PF2e system API
            try {
                if (typeof targetToken.actor.increaseCondition === "function") {
                    await targetToken.actor.increaseCondition("drained", { value: drainedVal });
                } else {
                    const conditionSource = game.pf2e?.ConditionManager?.getCondition("drained")?.toObject();
                    if (conditionSource) {
                        conditionSource.system.value = drainedVal;
                        await targetToken.actor.createEmbeddedDocuments("Item", [conditionSource]);
                    }
                }
            } catch (e) {
                console.error("Necromancer Helper | Failed to apply Drained condition", e);
            }

            // 2. Calculate healing: Drained Value * Creature Level * 2
            const targetActor = targetToken.actor;
            const targetLevel = targetActor.level || targetActor.system?.details?.level?.value || 1;
            const hpLost = drainedVal * targetLevel;
            const healingAmount = hpLost * 2;

            // 3. Find eligible allies within 30 feet or default to caster
            const casterActor = game.actors.get(message.speaker?.actor) || canvas.tokens.controlled[0]?.actor;
            const eligibleAllies = canvas.tokens.placeables.filter(t => {
                if (!t.actor) return false;
                const alliance = t.actor.system?.details?.alliance;
                return alliance === "party" || t.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY;
            });

            let recipientActor = casterActor;
            if (eligibleAllies.length > 1) {
                let optionsHtml = "";
                eligibleAllies.forEach(t => {
                    optionsHtml += `<option value="${t.actor.id}">${t.name} (${t.actor.name})</option>`;
                });

                await new Promise(resolve => {
                    new Dialog({
                        title: "Life Tap: Siphon Recipient",
                        content: `<p><b>${targetToken.name}</b> lost ${hpLost} maximum Hit Points from Drained ${drainedVal}. Choose who receives <b>${healingAmount} HP</b> of healing:</p><form><select id="heal-recipient">${optionsHtml}</select></form>`,
                        buttons: {
                            select: {
                                label: "Apply Healing",
                                callback: (html) => {
                                    const selectedId = html.find("#heal-recipient").val();
                                    const found = game.actors.get(selectedId);
                                    if (found) recipientActor = found;
                                    resolve();
                                }
                            }
                        },
                        default: "select"
                    }).render(true);
                });
            }

            if (recipientActor) {
                const currentHP = recipientActor.system.attributes.hp.value;
                const maxHP = recipientActor.system.attributes.hp.max;
                const actualHealed = Math.min(maxHP - currentHP, healingAmount);
                await recipientActor.update({ "system.attributes.hp.value": currentHP + actualHealed });

                const recipientToken = recipientActor.getActiveTokens()[0];
                if (recipientToken && canvas.ready && actualHealed > 0) {
                    canvas.interface.createScrollingText(recipientToken.center, `+${actualHealed} HP`, { anchor: CONST.TEXT_ANCHOR_POINTS.TOP, fill: 0x4ade80, direction: CONST.TEXT_ANCHOR_POINTS.UP });
                }

                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor: recipientActor }),
                    flavor: `<strong>Life Tap Siphon!</strong>`,
                    content: `<p><b>${targetToken.name}</b> succumbs to the siphon, suffering <b>Drained ${drainedVal}</b> (losing ${hpLost} Max HP). <b>${recipientActor.name}</b> drinks the essence, recovering <b>${actualHealed} Hit Points</b>!</p>`
                });
            }
        }
    }
});

// 1. Inject Void/Vitality toggles and manage save button visibility cleanly
Hooks.on("renderChatMessage", (message, html) => {
    const isErasCard = message.flags?.["aoe-easy-resolve"]?.itemName === "Necrotic Bomb" || message.content?.includes("Necrotic Bomb");
    if (!isErasCard) return;

    const $html = html instanceof jQuery ? html : $(html);
    
    if ($html.find('#necro-bomb-style').length === 0) {
        $html.prepend(`
            <style id="necro-bomb-style">
                .necro-type-toggle { display: inline-flex; align-items: center; margin-left: 5px; }
                .necro-type-toggle button { margin: 0; padding: 2px 6px; font-size: 0.7em; line-height: 1; border: 1px solid #444; cursor: pointer; }
                .void-opt { border-radius: 3px 0 0 3px; }
                .vit-opt { border-radius: 0 3px 3px 0; }
                .no-save-badge { font-weight: bold; color: #4ade80; font-size: 0.75em; margin-left: 5px; white-space: nowrap; }
            </style>
        `);
    }

    const updates = {};

    $html.find('[data-token-id]').each((i, el) => {
        const $row = $(el);
        const tokenId = $row.attr('data-token-id');
        if (!tokenId || $row.find('.necro-type-toggle').length > 0) return;

        const targetToken = canvas.tokens.get(tokenId);
        if (!targetToken?.actor) return;

        const currentType = message.getFlag("necromancer-thrall-helper", `dmgType_${tokenId}`) || "void";
        const negHeal = targetToken.actor.system.attributes.hp?.negativeHealing || false;
        
        const isUnaffected = (currentType === 'vitality' && !negHeal) || (currentType === 'void' && negHeal);

        if (game.user.isGM) {
            const aoeTarget = message.flags?.["aoe-easy-resolve"]?.targets?.[tokenId];
            if (aoeTarget && aoeTarget.isImmune !== isUnaffected) {
                updates[`flags.aoe-easy-resolve.targets.${tokenId}.isImmune`] = isUnaffected;
            }
        }

        const toggleHtml = `
            <div class="necro-type-toggle" data-token-id="${tokenId}">
                <button type="button" class="type-btn void-opt ${currentType === 'void' ? 'active' : ''}" data-type="void" style="background: ${currentType === 'void' ? '#660066' : '#222'}; color: #fff;">Void</button>
                <button type="button" class="type-btn vit-opt ${currentType === 'vitality' ? 'active' : ''}" data-type="vitality" style="background: ${currentType === 'vitality' ? '#b58900' : '#222'}; color: #fff;">Vit</button>
            </div>
        `;
        
        $row.find('.save-btn-container, .roll-save-btn').first().before(toggleHtml);

        const $saveBtn = $row.find('.roll-save-btn');
        if (isUnaffected) {
            $saveBtn.hide();
            if ($row.find('.no-save-badge').length === 0) {
                $saveBtn.after('<span class="no-save-badge">(Unaffected)</span>');
            }
        } else {
            $saveBtn.show();
            $row.find('.no-save-badge').remove();
        }
    });

    if (!foundry.utils.isEmpty(updates) && game.user.isGM) {
        setTimeout(() => message.update(updates), 50);
    }

    $html.find('.type-btn').off('click').on('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const $btn = $(e.currentTarget);
        const type = $btn.attr('data-type');
        const tokenId = $btn.parent().attr('data-token-id');
        
        await message.setFlag("necromancer-thrall-helper", `dmgType_${tokenId}`, type);
        Hooks.callAll("renderChatMessage", message, html);
    });
});

// 2. Intercept damage application to handle immunities, resistances, and type-swapping behind the scenes
if (!CONFIG.Actor.documentClass.prototype._necroBombApplyDamage) {
    CONFIG.Actor.documentClass.prototype._necroBombApplyDamage = CONFIG.Actor.documentClass.prototype.applyDamage;
    
    CONFIG.Actor.documentClass.prototype.applyDamage = async function(options) {
        const isBomb = options.item?.name === "Necrotic Bomb" || options.source?.name === "Necrotic Bomb" || options.message?.flags?.["aoe-easy-resolve"];
        
        if (isBomb) {
            let msg = game.messages.contents.slice(-10).reverse().find(m => m.flags?.["aoe-easy-resolve"]?.itemName === "Necrotic Bomb" || m.content?.includes("Necrotic Bomb"));
            let dmgType = "void"; 
            
            if (msg) {
                const token = this.getActiveTokens()[0];
                if (token) {
                    dmgType = msg.getFlag("necromancer-thrall-helper", `dmgType_${token.id}`) || "void";
                }
            }

            const negHeal = this.system.attributes.hp?.negativeHealing || false;

            // Strict rules check: Living + Vitality = 0 damage. Undead + Void = 0 damage.
            if ((dmgType === 'vitality' && !negHeal) || (dmgType === 'void' && negHeal)) {
                if (options.damage) options.damage = 0;
                if (options.roll) options.roll = 0;
                if (options.damage?.instances) options.damage.instances.forEach(i => { i.total = 0; i.type = dmgType; });
                return this._necroBombApplyDamage(options);
            }

            // Morph damage type so vulnerabilities and resistances calculate correctly
            if (options.damage?.instances) {
                options.damage.instances.forEach(i => i.type = dmgType);
            } else if (options.roll?.instances) {
                options.roll.instances.forEach(i => i.type = dmgType);
            }
        }
        return this._necroBombApplyDamage(options);
    };
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ThrallCommandDeck extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "thrall-command-deck", // This static ID is required for Foundry to remember its state
        title: "Command Deck",
        tag: "form",
        position: {
            width: 350,
            height: "auto"
        },
        window: {
            icon: "fas fa-skull",
            resizable: true // This must be true for size memory to activate
        }
    };

    static PARTS = {
        main: {
            template: "modules/necromancer-thrall-helper/templates/command-deck.hbs"
        }
    };
    constructor(necroId, options = {}) {
        if (typeof necroId === "object") {
            options = necroId;
            necroId = null;
        }

        // --- SMART ID RESOLUTION ---
        if (!necroId) {
            // 1. Try the currently selected token's actor
            const controlled = canvas.tokens?.controlled[0]?.actor;
            if (controlled) {
                necroId = controlled.id;
            } 
            // 2. Try the user's assigned character
            else if (game.user.character) {
                necroId = game.user.character.id;
            } 
            // 3. Sniff scene tokens for an existing masterId flag so reloads never orphan thralls
            else if (canvas.scene) {
                const existingThrall = canvas.scene.tokens.find(t => t.flags?.["necromancer-thrall-helper"]?.masterId);
                if (existingThrall) {
                    necroId = existingThrall.flags["necromancer-thrall-helper"].masterId;
                }
            }
            // 4. GM Failsafe: Hunt the actor directory for anyone holding a Thrall Portfolio
            else if (game.user.isGM) {
                const necro = game.actors.find(a => a.flags?.["necromancer-thrall-helper"]?.familyTree);
                if (necro) {
                    necroId = necro.id;
                    ui.notifications.info(`Auto-assigned Command Deck to ${necro.name}.`);
                }
            }
        }

        if (!necroId) {
            ui.notifications.warn("No Necromancer found. Please select your token before opening the Command Deck.");
            throw new Error("Command Deck aborted: No valid Necromancer target.");
        }

        // --- THE NECROMANCER BOUNCER ---
        const actor = game.actors.get(necroId);
        if (actor) {
            const hasNecroClass = actor.items.some(i => i.type === "class" && (i.name.toLowerCase().includes("necromancer") || i.system?.slug?.includes("necromancer")));
            const hasNecroDedication = actor.items.some(i => i.type === "feat" && (i.name.toLowerCase().includes("necromancer") || i.system?.slug?.includes("necromancer")));
            
            if (!hasNecroClass && !hasNecroDedication && !game.user.isGM) {
                ui.notifications.warn("This mortal lacks the dark blood and discipline required to command the dead.");
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
        this.imageCache = {}; 

        this._onTokenUpdate = Hooks.on("updateToken", (doc, changes) => {
            if (this.rendered && ("x" in changes || "y" in changes || "elevation" in changes)) {
                setTimeout(() => this.render({ force: false }), 150);
            }
        });
        
        this._onTokenDelete = Hooks.on("deleteToken", () => {
            if (this.rendered) this.render({ force: false });
        });

        this._onActorUpdate = Hooks.on("updateActor", (doc, changes) => {
            if (this.rendered && doc.id === this.necroId) {
                this.render({ force: false });
            }
        });
    }
    /** @override */
    async close(options) {
        Hooks.off("updateToken", this._onTokenUpdate);
        Hooks.off("deleteToken", this._onTokenDelete);
        Hooks.off("updateActor", this._onActorUpdate);
        return super.close(options);
    }

    async _prepareContext(options) {
        const actor = game.actors.get(this.necroId);
        let damageScale = "1d6";
        if (actor) {
            const necroLevel = actor.level || 1;
            const dice = Math.max(1, Math.floor((necroLevel - 1) / 4) + 1);
            damageScale = `${dice}d6`;
        }

        const mapPenalty = this.currentMap !== undefined ? this.currentMap : 0;
        
        let activeThralls = [];
        if (canvas.scene && this.necroId) {
            // Hardened filter: The token MUST have a masterId, and it MUST match the necroId
            const tokens = canvas.scene.tokens.filter(t => {
                const masterId = t.flags["necromancer-thrall-helper"]?.masterId;
                return masterId && masterId === this.necroId;
            });
            
            activeThralls = tokens.map(t => {
                const tokenObj = t.object;
                let nearbyEnemies = 0;
                let nearbyFriendlies = 0;

                // 10-FOOT TACTICAL SCANNER
                if (tokenObj && canvas.tokens?.placeables) {
                    for (const other of canvas.tokens.placeables) {
                        if (other.id === tokenObj.id) continue;
                        if (!other.actor) continue;
                        
                        // Ignore dead entities - corpses don't care about explosions
                        const hp = other.actor.system?.attributes?.hp?.value || 0;
                        if (hp <= 0) continue;

                        let distance = 999;
                        if (typeof tokenObj.distanceTo === "function") {
                            distance = tokenObj.distanceTo(other);
                        } else {
                            // Fallback math in case PF2e's native method hiccups
                            const dx = Math.abs(tokenObj.x - other.x);
                            const dy = Math.abs(tokenObj.y - other.y);
                            distance = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                        }
                        
                        if (distance <= 10) {
                            // PF2e uses 'alliance' for party vs enemy, which overrides standard Foundry dispositions
                            const alliance = other.actor.system?.details?.alliance;
                            const disp = other.document.disposition;

                            if (alliance === "opposition" || disp === CONST.TOKEN_DISPOSITIONS.HOSTILE) {
                                nearbyEnemies++;
                            } else if (alliance === "party" || disp === CONST.TOKEN_DISPOSITIONS.FRIENDLY) {
                                nearbyFriendlies++;
                            }
                        }
                    }
                }

           
                let imgPath = t.texture?.src || t.actor?.img || "icons/svg/mystery-man.svg";
                
                if (imgPath && !imgPath.includes("mystery-man") && !imgPath.startsWith("data:") && !imgPath.startsWith("blob:")) {
                    this.imageCache[t.id] = imgPath;
                } else if (this.imageCache[t.id]) {
                    imgPath = this.imageCache[t.id];
                }

                return {
                    id: t.id,
                    name: t.name,
                    img: imgPath,
                    nearbyEnemies: nearbyEnemies,
                    nearbyFriendlies: nearbyFriendlies
                };
            });
        }

        const hasFocus = (actor?.system?.resources?.focus?.max || 0) > 0;
        const hasSpell = (spellName) => {
            const searchStr = spellName.toLowerCase().trim();
            const searchSlug = searchStr.replace(/\s+/g, '-');
            return actor?.items.some(i => 
                ["spell", "feat", "action"].includes(i.type) && 
                (i.name.toLowerCase().trim() === searchStr || i.system?.slug === searchSlug)
            ) || false;
        };
        const hasPuppeteer = actor?.items.some(i => i.name.toLowerCase().includes("puppeteer") || (i.system?.slug && i.system.slug.includes("puppeteer"))) || false;
        const consumeUsed = actor?.getFlag("necromancer-thrall-helper", "consumeThrallUsed") || false;
        const currentFP = actor?.system?.resources?.focus?.value || 0;
        
        let consumeText = "Consume Thrall";
        let consumeDisabled = false;

        if (consumeUsed) {
            consumeText = "Consume Thrall (Used Today)";
            consumeDisabled = true;
        } else if (currentFP > 0) {
            consumeText = "Consume Thrall (Requires 0 FP)";
            consumeDisabled = true;
        }

        return {
            actorName: actor?.name || "Necromancer",
            actorLevel: actor?.level || 1,
            thrallDamage: damageScale,
            activeThralls: activeThralls,
            map0Active: mapPenalty === 0 ? "active" : "",
            map5Active: mapPenalty === -5 ? "active" : "",
            map10Active: mapPenalty === -10 ? "active" : "",
            hasNecroticBomb: hasSpell("Necrotic Bomb"),
            hasLifeTap: hasSpell("Life Tap"),
            hasBloodInfusion: hasSpell("Blood Infusion"),
            hasBoneSpear: hasSpell("Bone Spear"),
            hasDeadWeight: hasSpell("Dead Weight"),
            hasPuppeteer: hasPuppeteer,
            consumeText: consumeText,
            consumeDisabled: consumeDisabled
        };
    }

    /** @override */
    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;

        // --- RESTORE & TRACK DROPDOWN STATES ---
        const dropdowns = html.querySelectorAll(".action-dropdown");
        dropdowns.forEach(dropdown => {
            const row = dropdown.closest(".thrall-row");
            if (row) {
                const tokenId = row.dataset.tokenId;
                // Restore previously selected value if it exists
                if (this.actionStates[tokenId]) {
                    dropdown.value = this.actionStates[tokenId];
                }
                // Track changes so they survive the next re-render
                dropdown.addEventListener("change", (e) => {
                    this.actionStates[tokenId] = e.target.value;
                });
            }
        });

        // Save position/size to local storage whenever you let go of the mouse
        html.addEventListener("pointerup", () => {
            if (!this.position) return;
            localStorage.setItem(`necro-deck-bounds-${game.user.id}`, JSON.stringify({
                left: this.position.left,
                top: this.position.top,
                width: this.position.width,
                height: this.position.height
            }));
        });
        
        // Edit Portfolio Button Logic
        const editPortfolioBtn = html.querySelector(".edit-portfolio-btn");
        if (editPortfolioBtn) {
            editPortfolioBtn.addEventListener("click", (e) => {
                e.preventDefault();
                const actor = game.actors.get(this.necroId);
                if (!actor) {
                    ui.notifications.warn("No Necromancer found!");
                    return;
                }
                
                // Instantiate and render the new UI
                new PortfolioEditor(actor).render(true);
            });
        }

        // MAP button click logic
        const mapPips = html.querySelectorAll(".map-pip");
        mapPips.forEach(pip => {
            pip.addEventListener("click", (e) => {
                this.currentMap = parseInt(e.currentTarget.dataset.value, 10);
                this.render(); // Re-render to show the new active state
            });
        });

        // Execute Action Logic
        const executeBtns = html.querySelectorAll(".execute-btn");
        executeBtns.forEach(btn => {
            btn.addEventListener("click", async (e) => {
                e.preventDefault();
                const row = e.currentTarget.closest(".thrall-row");
                const tokenId = row.dataset.tokenId;
                const action = row.querySelector(".action-dropdown").value;
                const actor = game.actors.get(this.necroId) || game.user.character;
                
                if (!actor || !canvas.scene) return;
                const tokenDoc = canvas.scene.tokens.get(tokenId);
                if (!tokenDoc) return;

                const necroLevel = actor.level || 1;
                const baseDice = Math.max(1, Math.floor((necroLevel - 1) / 4) + 1);

                // Helper: Arm the thrall, apply buffs, and roll the native PF2e Strike
                const rollNativeStrike = async (eventObj, isKamikaze = false, chargeDice = 0, spellRank = 0) => {
                    const mapPenalty = this.currentMap !== undefined ? this.currentMap : 0;
                    let variantIndex = 0;
                    if (mapPenalty === -5) variantIndex = 1;
                    if (mapPenalty === -10) variantIndex = 2;

                    // 1. Check for weapon, forge it silently if missing
                    let existingWeapon = tokenDoc.actor.items.find(i => i.type === "melee" && i.name.includes("Thrall Strike"));
                    if (!existingWeapon) {
                        let attackMod = Math.floor(necroLevel * 1.5); 
                        const spellcasting = actor.spellcasting?.filter(s => s.statistic)?.sort((a,b) => b.statistic.check.mod - a.statistic.check.mod)[0];
                        if (spellcasting) attackMod = spellcasting.statistic.check.mod;

                        const weaponData = {
                            name: "Thrall Strike",
                            type: "melee", 
                            img: "systems/pf2e/icons/spells/ghoul-touch.webp",
                            system: {
                                weaponType: { value: "melee" },
                                bonus: { value: attackMod },
                                damageRolls: {
                                    base: {
                                        damage: `${baseDice}d6`,
                                        damageType: "bludgeoning" 
                                    }
                                },
                                traits: { value: ["magical"] }
                            }
                        };
                        await tokenDoc.actor.createEmbeddedDocuments("Item", [weaponData]);
                        await new Promise(resolve => setTimeout(resolve, 150));
                    }

                    // 2. Apply temporary Kamikaze/Charge buffs if needed
                    let addedEffectIds = [];
                    if (chargeDice > 0) {
                        const rules = [{
                            key: "DamageDice",
                            selector: "strike-damage",
                            diceNumber: chargeDice,
                            dieSize: "d6",
                            slug: "thrall-charge-dice"
                        }];

                        if (isKamikaze) {
                            rules.push({
                                key: "FlatModifier",
                                selector: "strike-damage",
                                value: spellRank,
                                type: "status",
                                slug: "thrall-charge-status"
                            });
                        }

                        const effectData = {
                            type: "effect",
                            name: isKamikaze ? "Thrall Charge (Kamikaze)" : "Thrall Charge",
                            img: "icons/magic/death/undead-ghost-scream-teal.webp",
                            system: {
                                level: { value: spellRank },
                                duration: { value: 1, unit: "rounds", expiry: "turn-end" },
                                rules: rules
                            }
                        };
                        
                        const createdEffects = await tokenDoc.actor.createEmbeddedDocuments("Item", [effectData]);
                        addedEffectIds = createdEffects.map(effect => effect.id);
                        await new Promise(resolve => setTimeout(resolve, 150));
                    }

                    // 3. Find the Strike action on the sheet
                    const actions = tokenDoc.actor?.system?.actions;
                    const strike = actions?.find(a => a.item?.name?.includes("Thrall Strike") || a.slug?.includes("thrall-strike"));

                    if (!strike || !strike.variants || !strike.variants[variantIndex]) {
                        ui.notifications.warn(`Execution failed. ${tokenDoc.name} could not draw its weapon.`);
                        return;
                    }

                   // 4. Roll the Native PF2e Strike (Generates the Attack card)
await strike.variants[variantIndex].roll({ event: eventObj });


if (this.currentMap === undefined || this.currentMap === 0) {
    this.currentMap = -5;
} else if (this.currentMap === -5) {
    this.currentMap = -10;
}
this.render(false); 
                    
                    if (isKamikaze) {
                        await tokenDoc.actor.update({ "system.attributes.hp.value": 0 }); // Visually drop them instantly
                    }

                    if (addedEffectIds.length > 0 || isKamikaze) {
                        const hookId = Hooks.on("createChatMessage", async (msg) => {
                            if (msg.speaker?.token === tokenDoc.id && msg.flags?.pf2e?.context?.type === "damage-roll") {
                                Hooks.off("createChatMessage", hookId);
                                
                                // Strip the temporary charge buffs now that damage is calculated
                                if (addedEffectIds.length > 0 && tokenDoc.actor) {
                                    await tokenDoc.actor.deleteEmbeddedDocuments("Item", addedEffectIds);
                                }
                                
                                // Vaporize the token
                                if (isKamikaze && tokenDoc) {
                                    await tokenDoc.delete();
                                }
                            }
                        });

                        // Failsafe: If you miss and never roll damage, clean up the buffs after 2 minutes
                        setTimeout(async () => {
                            Hooks.off("createChatMessage", hookId);
                            if (addedEffectIds.length > 0 && tokenDoc?.actor) {
                                // Only delete the items if they still exist on the actor
                                const activeBuffs = tokenDoc.actor.items.filter(i => addedEffectIds.includes(i.id)).map(i => i.id);
                                if (activeBuffs.length > 0) {
                                    await tokenDoc.actor.deleteEmbeddedDocuments("Item", activeBuffs);
                                }
                            }
                        }, 120000);
                    }
                };

                switch (action) {
                    case "consume-thrall": {
                        const necroTokens = actor.getActiveTokens();
                        if (necroTokens.length > 0) {
                            const necroToken = necroTokens[0];
                            let distance = 999;
                            if (typeof tokenDoc.object.distanceTo === "function") {
                                distance = tokenDoc.object.distanceTo(necroToken);
                            } else {
                                const dx = Math.abs(tokenDoc.x - necroToken.x);
                                const dy = Math.abs(tokenDoc.y - necroToken.y);
                                distance = (Math.max(dx, dy) / canvas.grid.size) * (canvas.scene?.grid?.distance || 5);
                            }
                            if (distance > 30) {
                                ui.notifications.warn("That thrall is beyond 30 feet.");
                                break;
                            }
                        }

                        new Dialog({
                            title: "Consume Thrall",
                            content: `<p>Destroy <b>${tokenDoc.name}</b> to regain 1 Focus Point?</p>`,
                            buttons: {
                                consume: {
                                    icon: '<i class="fas fa-skull"></i>',
                                    label: "Consume",
                                    callback: async () => {
                                        await tokenDoc.delete();
                                        await actor.setFlag("necromancer-thrall-helper", "consumeThrallUsed", true);
                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
                                        await actor.update({ "system.resources.focus.value": currentFocus + 1 });
                                        
                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            flavor: `<strong>Consume Thrall</strong>`,
                                            content: `<p><b>${actor.name}</b> consumes the animus of <b>${tokenDoc.name}</b>, regaining 1 Focus Point (restricted to grave spells).</p>`
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "consume"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "dead-weight": {
                        const spellRank = Math.ceil(necroLevel / 2);
                        
                        let exactDC = 10 + Math.floor(necroLevel * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) exactDC = maxDC;
                        }
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) {
                            exactDC = actor.system.attributes.classDC.dc.value;
                        }

                        let dwSpell = actor.items.find(i => ["spell", "feat", "action"].includes(i.type) && i.name === "Dead Weight");
                        const spellSystemData = {
                            level: { value: spellRank },
                            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                            tradition: { value: "divine" },
                            defense: { save: { statistic: "fortitude", basic: false, dc: { value: exactDC } } }
                        };

                        if (!dwSpell) {
                            const spellData = { name: "Dead Weight", type: "spell", img: "icons/magic/death/undead-zombie-glowing-green.webp", system: spellSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            dwSpell = created[0];
                        } else {
                            await dwSpell.update({ system: spellSystemData });
                        }

                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
                        const gridDist = canvas.scene?.grid?.distance || 5;
                        const gridSize = canvas.scene?.grid?.size || 100;
                        const rangePixels = (15 / gridDist) * gridSize;

                        const validTargets = Array.from(game.user.targets).filter(t => {
                            const dist = Math.hypot(t.center.x - tokenCenter.x, t.center.y - tokenCenter.y);
                            return dist <= rangePixels;
                        });

                        if (validTargets.length !== 1) {
                            ui.notifications.warn("Dead Weight requires exactly one target selected on the canvas within 15 feet of the thrall.");
                            break;
                        }

                        const targetToken = validTargets[0];

                        new Dialog({
                            title: "Dead Weight",
                            content: `<p>Hurl <b>${tokenDoc.name}</b> at <b>${targetToken.name}</b> to fuse their flesh together?</p>`,
                            buttons: {
                                hurl: {
                                    icon: '<i class="fas fa-meteor"></i>',
                                    label: "Hurl",
                                    callback: async () => {
                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        const targetsData = {};
                                        targetsData[targetToken.document.id] = {
                                            id: targetToken.document.id,
                                            name: targetToken.document.name,
                                            img: targetToken.document.texture.src,
                                            hasRolled: false,
                                            rollTotal: null,
                                            degreeOfSuccess: null,
                                            isHealing: false,
                                            isImmune: false,
                                            hasApplied: false
                                        };

                                        const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
                                        const htmlContent = await renderTemplate(templatePath, {
                                            targets: Object.values(targetsData),
                                            itemName: "Dead Weight",
                                            saveType: "Fortitude",
                                            saveDC: exactDC
                                        });

                                        await tokenDoc.delete();

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            content: htmlContent,
                                            flags: {
                                                "aoe-easy-resolve": {
                                                    templateId: null,
                                                    documentName: "ManualTarget",
                                                    itemUuid: dwSpell.uuid,
                                                    itemName: "Dead Weight",
                                                    saveType: "fortitude",
                                                    saveDC: exactDC,
                                                    isBasicSave: false,
                                                    targets: targetsData,
                                                    hazardDamage: null,
                                                    isReactive: false,
                                                    originMessageId: null
                                                }
                                            }
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "hurl"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "bone-spear": {
                        const spellRank = Math.ceil(necroLevel / 2);
                        const damageDice = spellRank * 2;
                        
                        let exactDC = 10 + Math.floor(necroLevel * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) exactDC = maxDC;
                        }
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) {
                            exactDC = actor.system.attributes.classDC.dc.value;
                        }

                        let spearSpell = actor.items.find(i => i.type === "spell" && i.name === "Bone Spear");
                        const spellSystemData = {
                            level: { value: spellRank },
                            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                            tradition: { value: "divine" },
                            area: { type: "line", value: 15 },
                            defense: { save: { statistic: "reflex", basic: true, dc: { value: exactDC } } },
                            damage: { "0": { formula: `${damageDice}d6`, type: "piercing" } }
                        };

                        if (!spearSpell) {
                            const spellData = { name: "Bone Spear", type: "spell", img: "icons/magic/weapons/projectile-spear-bone.webp", system: spellSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            spearSpell = created[0];
                        } else {
                            await spearSpell.update({ system: spellSystemData });
                        }

                        // Override flags to ensure AOE Easy Resolve catches the exact math
                        await spearSpell.setFlag("aoe-easy-resolve", "useCustomDamage", true);
                        await spearSpell.setFlag("aoe-easy-resolve", "customDamage", `${damageDice}d6`);
                        await spearSpell.setFlag("aoe-easy-resolve", "customDamageType", "piercing");
                        await spearSpell.setFlag("aoe-easy-resolve", "useOverride", true);
                        await spearSpell.setFlag("aoe-easy-resolve", "saveDC", exactDC);
                        await spearSpell.setFlag("aoe-easy-resolve", "saveType", "reflex");
                        await spearSpell.setFlag("aoe-easy-resolve", "allyBaseEffect", "standard");
                        await spearSpell.setFlag("aoe-easy-resolve", "enemyBaseEffect", "standard");

                        new Dialog({
                            title: "Bone Spear",
                            content: `<p>Shatter <b>${tokenDoc.name}</b> into a 15-foot line of jagged bone for <b>${damageDice}d6 piercing</b> damage?</p>`,
                            buttons: {
                                fire: {
                                    icon: '<i class="fas fa-location-arrow"></i>',
                                    label: "Shatter & Fire",
                                    callback: async () => {
                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        await tokenDoc.delete();
                                        
                                        // Push the spell to chat so you can draw the line from the template button
                                        await spearSpell.toMessage(e);
                                        ui.notifications.info("Draw your 15-foot line starting from the thrall's former space.");
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "fire"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "charge": {
                        const spellRank = Math.ceil(necroLevel / 2);
                        let chargeDice = 1;
                        if (spellRank >= 10) chargeDice = 4;
                        else if (spellRank >= 6) chargeDice = 3;
                        else if (spellRank >= 2) chargeDice = 2;

                        new Dialog({
                            title: "Thrall Charge",
                            content: `<p>Detonate <b>${tokenDoc.name}</b> upon impact for an additional +${spellRank} status bonus to damage?</p>`,
                            buttons: {
                                charge: {
                                    icon: '<i class="fas fa-running"></i>',
                                    label: "Just Charge",
                                    callback: async () => {
                                        await rollNativeStrike(e, false, chargeDice, spellRank);
                                    }
                                },
                                destroy: {
                                    icon: '<i class="fas fa-bomb"></i>',
                                    label: "Charge & Destroy",
                                    callback: async () => {

                                        await rollNativeStrike(e, true, chargeDice, spellRank);
                                    }
                                }
                            },
                            default: "charge"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                    case "blood-infusion": {
                        const spellRank = Math.ceil((actor.level || 1) / 2);
                        
                        let infusionDC = 10 + Math.floor((actor.level || 1) * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) infusionDC = maxDC;
                        }
                        if (infusionDC === 10 && actor.system?.attributes?.classDC?.dc) {
                            infusionDC = actor.system.attributes.classDC.dc.value;
                        }

                        let infusionSpell = actor.items.find(i => i.type === "spell" && i.name === "Blood Infusion");
                        const infusionSystemData = {
                            level: { value: spellRank },
                            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                            tradition: { value: "divine" },
                            defense: { save: { statistic: "fortitude", basic: false, dc: { value: infusionDC } } }
                        };

                        if (!infusionSpell) {
                            const spellData = { name: "Blood Infusion", type: "spell", img: "icons/magic/water/blood-drop-skull.webp", system: infusionSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            infusionSpell = created[0];
                        } else {
                            await infusionSpell.update({ system: infusionSystemData });
                        }

                        // Validate target is within 15 feet of the thrall
                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
                        const gridDist = canvas.scene?.grid?.distance || 5;
                        const gridSize = canvas.scene?.grid?.size || 100;
                        const rangePixels = (15 / gridDist) * gridSize;

                        const validTargets = Array.from(game.user.targets).filter(t => {
                            const dist = Math.hypot(t.center.x - tokenCenter.x, t.center.y - tokenCenter.y);
                            return dist <= rangePixels;
                        });

                        if (validTargets.length !== 1) {
                            ui.notifications.warn("Blood Infusion requires exactly one target selected on the canvas within 15 feet of the thrall.");
                            break;
                        }

                        const targetToken = validTargets[0];

                        new Dialog({
                            title: "Blood Infusion",
                            content: `<p>Infuse blood through <b>${tokenDoc.name}</b> into <b>${targetToken.name}</b>?</p>`,
                            buttons: {
                                infuse: {
                                    icon: '<i class="fas fa-tint"></i>',
                                    label: "Infuse",
                                    callback: async () => {
                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        const targetsData = {};
                                        targetsData[targetToken.document.id] = {
                                            id: targetToken.document.id,
                                            name: targetToken.document.name,
                                            img: targetToken.document.texture.src,
                                            hasRolled: false,
                                            rollTotal: null,
                                            degreeOfSuccess: null,
                                            isHealing: false,
                                            isImmune: false,
                                            hasApplied: false
                                        };

                                        const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
                                        const htmlContent = await renderTemplate(templatePath, {
                                            targets: Object.values(targetsData),
                                            itemName: "Blood Infusion",
                                            saveType: "Fortitude",
                                            saveDC: infusionDC
                                        });

                                        await tokenDoc.delete();

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            content: htmlContent,
                                            flags: {
                                                "aoe-easy-resolve": {
                                                    templateId: null,
                                                    documentName: "ManualTarget",
                                                    itemUuid: infusionSpell.uuid,
                                                    itemName: "Blood Infusion",
                                                    saveType: "fortitude",
                                                    saveDC: infusionDC,
                                                    isBasicSave: false,
                                                    targets: targetsData,
                                                    hazardDamage: null,
                                                    isReactive: false,
                                                    originMessageId: null,
                                                    spellRank: spellRank
                                                }
                                            }
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "infuse"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                        
                    case "strike": {
                        await rollNativeStrike(e);
                        break;
                    }
                        
            
                        
                    case "explode": {
                        const bombRank = Math.ceil(necroLevel / 2);
                        
                        let exactDC = 10 + Math.floor(necroLevel * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) exactDC = maxDC;
                        }
                        if (exactDC === 10 && actor.system?.attributes?.classDC?.dc) {
                            exactDC = actor.system.attributes.classDC.dc.value;
                        }

                        let bombSpell = actor.items.find(i => i.type === "spell" && i.name === "Necrotic Bomb");
                        const spellSystemData = {
                            level: { value: bombRank },
                            traits: { value: ["necromancer", "manipulate", "concentrate"] },
                            tradition: { value: "divine" },
                            area: { type: "emanation", value: 10 },
                            defense: { save: { statistic: "fortitude", basic: true, dc: { value: exactDC } } },
                            damage: { "0": { formula: `${bombRank}d12`, type: "untyped" } }
                        };

                        if (!bombSpell) {
                            const spellData = { name: "Necrotic Bomb", type: "spell", img: "icons/magic/death/projectile-skull-flaming-green.webp", system: spellSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            bombSpell = created[0];
                        } else {
                            await bombSpell.update({ system: spellSystemData });
                        }

                        await bombSpell.setFlag("aoe-easy-resolve", "useCustomDamage", true);
                        await bombSpell.setFlag("aoe-easy-resolve", "customDamage", `${bombRank}d12`);
                        await bombSpell.setFlag("aoe-easy-resolve", "customDamageType", "untyped");
                        await bombSpell.setFlag("aoe-easy-resolve", "useOverride", true);
                        await bombSpell.setFlag("aoe-easy-resolve", "saveDC", exactDC);
                        await bombSpell.setFlag("aoe-easy-resolve", "saveType", "fortitude");
                        await bombSpell.setFlag("aoe-easy-resolve", "allyBaseEffect", "standard");
                        await bombSpell.setFlag("aoe-easy-resolve", "enemyBaseEffect", "standard");

                        new Dialog({
                            title: "Necrotic Bomb",
                            content: `<p>Detonate <b>${tokenDoc.name}</b> for <b>${bombRank}d12</b> damage in a 10-foot emanation?</p>`,
                            buttons: {
                                explode: {
                                    icon: '<i class="fas fa-radiation"></i>',
                                    label: "Detonate",
                                    callback: async () => {
                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
                                        
                                        window.aoeEasyResolveCache = {
                                            item: bombSpell,
                                            name: "Necrotic Bomb",
                                            dc: exactDC,
                                            type: "fortitude",
                                            hazardDuration: null,
                                            originMessageId: null
                                        };

                                        const gridDist = canvas.scene?.grid?.distance || 5;
                                        const tokenWidth = tokenDoc.width || 1;
                                        const tokenRadiusFeet = (tokenWidth * gridDist) / 2;
                                        const totalEmanationFeet = 10 + tokenRadiusFeet;

                                        await tokenDoc.delete();

                                        await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{
                                            t: "circle", 
                                            user: game.user.id, 
                                            x: tokenCenter.x, 
                                            y: tokenCenter.y, 
                                            distance: totalEmanationFeet, 
                                            fillColor: "#660066"
                                        }]);
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "explode"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }

                    case "life-tap": {
                        let lifeTapDC = 10 + Math.floor((actor.level || 1) * 1.5);
                        if (actor.spellcasting) {
                            const entries = typeof actor.spellcasting.contents === "function" ? actor.spellcasting.contents() : Array.from(actor.spellcasting);
                            let maxDC = 0;
                            for (const entry of entries) {
                                const dcVal = entry.dc?.value || entry.statistic?.dc?.value || entry.system?.dc?.value;
                                if (dcVal && dcVal > maxDC) maxDC = dcVal;
                            }
                            if (maxDC > 0) lifeTapDC = maxDC;
                        }
                        if (lifeTapDC === 10 && actor.system?.attributes?.classDC?.dc) {
                            lifeTapDC = actor.system.attributes.classDC.dc.value;
                        }

                        let lifeTapSpell = actor.items.find(i => i.type === "spell" && i.name === "Life Tap");
                        const lifeTapSystemData = {
                            level: { value: 1 },
                            traits: { value: ["necromancer", "manipulate", "concentrate", "focus", "uncommon"] },
                            tradition: { value: "divine" },
                            defense: { save: { statistic: "fortitude", basic: false, dc: { value: lifeTapDC } } }
                        };

                        if (!lifeTapSpell) {
                            const spellData = { name: "Life Tap", type: "spell", img: "icons/magic/life/heart-glowing-red.webp", system: lifeTapSystemData };
                            const created = await actor.createEmbeddedDocuments("Item", [spellData]);
                            lifeTapSpell = created[0];
                        } else {
                            await lifeTapSpell.update({ system: lifeTapSystemData });
                        }

                        const tokenCenter = tokenDoc.object?.center || { x: tokenDoc.x, y: tokenDoc.y };
                        const gridDist = canvas.scene?.grid?.distance || 5;
                        const gridSize = canvas.scene?.grid?.size || 100;
                        const rangePixels = (30 / gridDist) * gridSize;

                        const validTargets = Array.from(game.user.targets).filter(t => {
                            const dist = Math.hypot(t.center.x - tokenCenter.x, t.center.y - tokenCenter.y);
                            return dist <= rangePixels;
                        });

                        if (validTargets.length !== 1) {
                            ui.notifications.warn("Life Tap requires exactly one target selected on the canvas within 30 feet of the thrall.");
                            break;
                        }

                        const targetToken = validTargets[0];

                        new Dialog({
                            title: "Life Tap",
                            content: `<p>Siphon life essence through <b>${tokenDoc.name}</b> targeting <b>${targetToken.name}</b>?</p>`,
                            buttons: {
                                tap: {
                                    icon: '<i class="fas fa-heart-broken"></i>',
                                    label: "Siphon",
                                    callback: async () => {

                                        const currentFocus = actor.system?.resources?.focus?.value || 0;
if (currentFocus > 0) await actor.update({ "system.resources.focus.value": currentFocus - 1 });
                                        const targetsData = {};
                                        targetsData[targetToken.document.id] = {
                                            id: targetToken.document.id,
                                            name: targetToken.document.name,
                                            img: targetToken.document.texture.src,
                                            hasRolled: false,
                                            rollTotal: null,
                                            degreeOfSuccess: null,
                                            isHealing: false,
                                            isImmune: false,
                                            hasApplied: false
                                        };

                                        const templatePath = "modules/aoe-easy-resolve/templates/chat-card.hbs";
                                        const htmlContent = await renderTemplate(templatePath, {
                                            targets: Object.values(targetsData),
                                            itemName: "Life Tap",
                                            saveType: "Fortitude",
                                            saveDC: lifeTapDC
                                        });

                                        await tokenDoc.delete();

                                        await ChatMessage.create({
                                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                                            content: htmlContent,
                                            flags: {
                                                "aoe-easy-resolve": {
                                                    templateId: null,
                                                    documentName: "ManualTarget",
                                                    itemUuid: lifeTapSpell.uuid,
                                                    itemName: "Life Tap",
                                                    saveType: "fortitude",
                                                    saveDC: lifeTapDC,
                                                    isBasicSave: false,
                                                    targets: targetsData,
                                                    hazardDamage: null,
                                                    isReactive: false,
                                                    originMessageId: null
                                                }
                                            }
                                        });
                                    }
                                },
                                cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
                            },
                            default: "tap"
                        }, { classes: ["dialog", "thrall-summon-dialog"] }).render(true);
                        break;
                    }
                }
            });
        });

        // The Spawn Button Logic
        const spawnBtns = html.querySelectorAll(".spawn-btn");
        spawnBtns.forEach(btn => {
            btn.addEventListener("click", async (e) => {
                let count = parseInt(e.currentTarget.dataset.count, 10);
                const actor = game.actors.get(this.necroId) || game.user.character;

                if (!actor) {
                    ui.notifications.warn("No Necromancer found! Please assign a character to your user.");
                    return;
                }

                const hasPuppeteer = actor.items.some(i => i.system?.slug === "puppeteer");
                if (hasPuppeteer) {
                    const currentCombat = game.combat;
                    const currentRound = currentCombat ? currentCombat.round : 0;
                    const lastUsedRound = actor.getFlag("necromancer-thrall-helper", "proliferationRound");
                    
                    if (!currentCombat || lastUsedRound !== currentRound) {
                        count += 1;
                        if (currentCombat) {
                            await actor.setFlag("necromancer-thrall-helper", "proliferationRound", currentRound);
                        }
                        await ChatMessage.create({
                            speaker: ChatMessage.getSpeaker({ actor: actor }),
                            content: `<p><strong>Thrall Proliferation!</strong> <b>${actor.name}</b> twists the magic to spawn an additional thrall this round.</p>`
                        });
                    }
                }

                const presets = getThrallPresets(actor);

                let optionsHtml = `
                    <option value="default">(Default Thrall)</option>
                    <option value="random">(Random Family Member)</option>
                `;
                presets.forEach(p => {
                    optionsHtml += `<option value="${p.id}">${p.name}</option>`;
                });

                // 2. Dynamically build the dialog form based on how many we are spawning
                let formHtml = `<form><p>Select the identities for your summons:</p>`;
                for (let i = 0; i < count; i++) {
                    formHtml += `
                        <div class="form-group">
                            <label>Summon ${i + 1}:</label>
                            <div class="form-fields">
                                <select id="preset-selector-${i}">${optionsHtml}</select>
                            </div>
                        </div>`;
                }
                formHtml += `</form>`;

                new Dialog({
                    title: "Summoning Ritual",
                    content: formHtml,
                    buttons: {
                        summon: {
                            icon: '<i class="fas fa-magic"></i>',
                            label: "Summon",
                            callback: async (dialogHtml) => {
                                // Gather the selections from the form
                                const dialogForm = dialogHtml[0];
                                let selections = [];
                                for (let i = 0; i < count; i++) {
                                    selections.push(dialogForm.querySelector(`#preset-selector-${i}`).value);
                                }

                                // 4. Start the canvas placement phase
                                let currentSpawnIndex = 0;

                                ui.notifications.info(`Click the canvas to place Summon ${currentSpawnIndex + 1}. Right-click to cancel.`);
                                document.body.style.cursor = "crosshair";
                                canvas.app.view.style.cursor = "crosshair";

                                const gridSize = canvas.grid.size;
                                const ghost = new PIXI.Graphics();
                                ghost.beginFill(0x33ff33, 0.3);
                                ghost.lineStyle(2, 0x33ff33, 0.8);
                                ghost.drawRect(0, 0, gridSize, gridSize);
                                ghost.endFill();
                                ghost.zIndex = 1000;
                                ghost.position.set(-1000, -1000);
                                canvas.tokens.addChild(ghost);

                                const updateGhost = (event) => {
                                    const position = event.data.getLocalPosition(canvas.app.stage);
                                    let spawnX = position.x;
                                    let spawnY = position.y;
                                    
                                    if (canvas.grid.getTopLeftPoint) {
                                        const snapped = canvas.grid.getTopLeftPoint(position);
                                        spawnX = snapped.x; 
                                        spawnY = snapped.y;
                                    }
                                    ghost.position.set(spawnX, spawnY);
                                };

                                canvas.stage.on("pointermove", updateGhost);

                                const cleanUp = () => {
                                    document.body.style.cursor = "";
                                    canvas.app.view.style.cursor = "";
                                    canvas.stage.off("pointermove", updateGhost);
                                    ghost.destroy();
                                };

                                const interactionHandler = async (event) => {
                                    if (event.data.button !== 0 && event.data.button !== 2) {
                                        canvas.stage.once("pointerdown", interactionHandler);
                                        return;
                                    }

                                    if (event.data.button === 2) {
                                        ui.notifications.info("Summoning cancelled.");
                                        cleanUp();
                                        return;
                                    }

                                    const position = event.data.getLocalPosition(canvas.app.stage);
                                    let spawnX = position.x;
                                    let spawnY = position.y;
                                    
                                    if (canvas.grid.getTopLeftPoint) {
                                        const snapped = canvas.grid.getTopLeftPoint(position);
                                        spawnX = snapped.x; 
                                        spawnY = snapped.y;
                                    }

                                    // Fetch the payload for the specific preset chosen for this step
                                    const presetId = selections[currentSpawnIndex];
                                    const basePayload = await prepareThrallPayload(actor, presetId);
                                    
                                    if (!basePayload) { cleanUp(); return; }

                                    const finalPayload = foundry.utils.mergeObject(basePayload, {
                                        x: spawnX,
                                        y: spawnY
                                    });

                                    currentSpawnIndex++;
                                    ui.notifications.info(`Spawn request for Summon ${currentSpawnIndex} sent to GM...`);

                                    // Fire the socket call without blocking the multi-placement loop
                                    executeSpawn(finalPayload).catch(err => {
                                        console.error("Necromancer Helper | Spawn execution failed:", err);
                                        ui.notifications.error("Failed to materialize the thrall.");
                                    });

                                    if (currentSpawnIndex < count) {
                                        ui.notifications.info(`Place Summon ${currentSpawnIndex + 1}.`);
                                        canvas.stage.once("pointerdown", interactionHandler);
                                    } else {
                                        cleanUp();
                                        ui.notifications.info("All summons placed.");
                                    }
                                };

                                canvas.stage.once("pointerdown", interactionHandler);
                            }
                        },
                        cancel: {
                            icon: '<i class="fas fa-times"></i>',
                            label: "Cancel"
                        }
                    },
                    default: "summon"
                }, {
                    classes: ["dialog", "thrall-summon-dialog"]
                }).render(true);
            });
        });
        
        // The Dismiss (Kill) Button Logic
        const killBtns = html.querySelectorAll(".kill-btn");
        killBtns.forEach(killBtn => {
            killBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const row = e.currentTarget.closest('.thrall-row');
                const tokenId = row.dataset.tokenId;
                
                if (!canvas.scene) return;
                
                const tokenDoc = canvas.scene.tokens.get(tokenId);
                if (tokenDoc) {
                    await tokenDoc.delete();
                    ui.notifications.info(`Dismissed ${tokenDoc.name}.`);
                }
            });
        });

        // UI-to-Canvas Sync: Hovering a row highlights the token
        const thrallRows = html.querySelectorAll(".thrall-row");
        thrallRows.forEach(row => {
            row.addEventListener("mouseenter", (e) => {
                const tokenId = row.dataset.tokenId;
                if (!canvas.scene) return;
                
                const token = canvas.tokens.get(tokenId);
                if (token && token.isVisible && !token.controlled) {
                    token._onHoverIn(e);
                }
            });

            row.addEventListener("mouseleave", (e) => {
                const tokenId = row.dataset.tokenId;
                if (!canvas.scene) return;
                
                const token = canvas.tokens.get(tokenId);
                if (token && token.isVisible && !token.controlled) {
                    token._onHoverOut(e);
                }
            });
        });
    }
}