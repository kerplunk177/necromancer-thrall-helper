const MODULE = "necromancer-thrall-helper";
const PACK = `Compendium.${MODULE}.necro-effects.Item`;
const SPELL_FX = "Compendium.pf2e.spell-effects.Item";

/**
 * Every effect the module applies, one entry per effect.
 *   official: PF2e compendium UUID (or a function of ctx returning one), tried first
 *   module:   id of our copy in the necro-effects pack, tried second
 *   inline:   last-resort builder of the full effect data (also the source of the pack entries)
 *   adaptOfficial(data, ctx): tweak the official data (level, preselected choices, duration)
 *   dynamic:  system fields the module computes at runtime; they are taken from inline(ctx) when the
 *             effect comes from our compendium copy
 *   slugs / names: how an already-applied effect is recognised (plus the effectKey flag we set)
 */
const p = (text) => `<p>${text}</p>`;
const MIN1 = { value: 1, unit: "minutes", expiry: "turn-start" };
const iconRule = (radius, color) => [{ key: "Aura", radius, colors: { border: color, fill: color } }];

/** Select a ChoiceSet option in advance so the effect never prompts. */
function preselect(data, selection) {
    const rule = data.system?.rules?.find(r => r.key === "ChoiceSet");
    if (rule) rule.selection = selection;
}

export const NECRO_EFFECTS = {
    songRecipient: {
        official: `${SPELL_FX}.tnbmzwool95tqqhy`,
        slugs: ["spell-effect-song-of-the-soul", "song-of-the-soul-recipient"],
        names: ["Effect: Song of the Soul (Recipient)", "Spell Effect: Song of the Soul"],
        adaptOfficial: (d, ctx) => { d.system.level = { value: ctx.spellRank }; },
        inline: (ctx = {}) => ({
            name: "Effect: Song of the Soul (Recipient)", type: "effect",
            img: "systems/pf2e/icons/spells/hymn-of-healing.webp",
            system: {
                duration: { ...MIN1 },
                description: { value: p(`Gains Fast Healing ${ctx.spellRank ?? 1} as long as you are within 15 feet of the instrument thrall.`) },
                rules: [{ key: "FastHealing", value: ctx.spellRank ?? 1, type: "fast-healing" }]
            }
        })
    },
    songInstrument: {
        module: "necroSongInstrmt", slugs: ["song-instrument"], names: ["Effect: Song Instrument"],
        dynamic: ["description"],
        inline: (ctx = {}) => ({
            name: "Effect: Song Instrument", type: "effect",
            img: "systems/pf2e/icons/spells/spirit-song.webp",
            system: {
                slug: "song-instrument",
                duration: { ...MIN1 },
                description: { value: p(`Playing the Song of the Soul${ctx.targetName ? ` for ${ctx.targetName}` : ""}.`) },
                rules: iconRule(15, "#00ffff")
            }
        })
    },
    infusedBlood: {
        official: `${SPELL_FX}.45PrZ9h5nrll0zr9`,
        slugs: ["spell-effect-blood-infusion", "infused-blood"], names: ["Infused Blood", "Spell Effect: Blood Infusion"],
        adaptOfficial: (d) => { d.system.duration = { value: 1, unit: "minutes", sustained: false, expiry: null }; },
        inline: () => ({
            name: "Infused Blood", type: "effect",
            img: "icons/skills/wounds/blood-cells-vessel-red-orange.webp",
            system: {
                description: { value: p("Loses immunity to bleed and is considered a creature with blood for 1 minute.") },
                duration: { value: 1, unit: "minutes", expiry: null },
                rules: [{ key: "Immunity", type: "bleed", mode: "remove" }]
            }
        })
    },
    calcification: {
        official: (ctx) => ctx.dos === "success" ? `${SPELL_FX}.YdRhso3b64wgdB4D` : `${SPELL_FX}.UoZv5TXHJNU3QBzy`,
        slugs: ["effect-calcification", "spell-effect-calcification"], names: ["Effect: Calcification", "Spell Effect: Calcification"],
        adaptOfficial: (d, ctx) => { if (ctx.dos !== "success") preselect(d, ctx.dos === "failure" ? "failure" : "critical-failure"); },
        inline: (ctx = {}) => ({
            name: "Effect: Calcification", type: "effect",
            img: "icons/magic/death/skeleton-skull-soul-blue.webp",
            system: {
                slug: "effect-calcification",
                level: { value: 9 },
                duration: { value: ctx.dos === "success" ? 1 : -1, unit: ctx.dos === "success" ? "rounds" : "unlimited", expiry: "turn-start" },
                description: { value: p(`You are calcifying. Weakness ${ctx.weakVal ?? 5} to bludgeoning.`) },
                rules: [{ key: "Weakness", type: "bludgeoning", value: ctx.weakVal ?? 5 }]
            }
        })
    },
    reinforcedSkeleton: {
        official: "Compendium.pf2e.feat-effects.Item.Tf9i4pIixA0RqLav",
        slugs: ["effect-reinforced-skeleton-speed", "effect-reinforced-skeleton"], names: ["Reinforced Skeleton: Speed Surge", "Effect: Reinforced Skeleton"],
        adaptOfficial: (d) => { d.system.duration = { value: 1, unit: "rounds", sustained: false, expiry: "turn-end" }; },
        inline: () => ({
            name: "Reinforced Skeleton: Speed Surge", type: "effect",
            img: "icons/magic/movement/trail-streak-zigzag-teal.webp",
            system: {
                slug: "effect-reinforced-skeleton-speed",
                description: { value: p("Whenever you destroy a thrall, your status bonus to Speeds increases to +10 feet for 1 round.") },
                duration: { value: 1, unit: "rounds", expiry: "turn-end" },
                rules: [{ key: "FlatModifier", selector: "speed", value: 10, type: "status", slug: "reinforced-skeleton-status-speed" }]
            }
        })
    },
    thrallCharge: {
        official: `${SPELL_FX}.Wd1fYphfUNpZlgcH`,
        slugs: ["spell-effect-thrall-charge", "thrall-charge"], names: ["Thrall Charge", "Thrall Charge (Kamikaze)", "Spell Effect: Thrall Charge"],
        hideTokenIcon: true,
        adaptOfficial: (d, ctx) => {
            d.system.level = { value: ctx.spellRank };
            d.system.duration = ctx.duration ?? { value: 1, unit: "rounds", sustained: false, expiry: "turn-end" };
            preselect(d, ctx.isKamikaze ? "yes" : "no");
            // Dice from other features (Living Graveyard, Perfected Thrall...) on top of the spell's own table.
            const baseDice = ctx.chargeDice ?? ctx.baseDice;
            if (ctx.dice && baseDice && ctx.dice > baseDice) {
                d.system.rules.push({ key: "DamageDice", selector: "strike-damage", slug: "thrall-charge-bonus", diceNumber: ctx.dice - baseDice, dieSize: "d6" });
            }
        },
        inline: (ctx = {}) => {
            const rules = [{ key: "DamageDice", selector: "strike-damage", diceNumber: ctx.dice ?? 1, dieSize: "d6", slug: "thrall-charge-dice" }];
            if (ctx.isKamikaze) rules.push({ key: "FlatModifier", selector: "strike-damage", value: ctx.spellRank ?? 1, type: "status", slug: "thrall-charge-status" });
            return {
                type: "effect", name: ctx.isKamikaze ? "Thrall Charge (Kamikaze)" : "Thrall Charge",
                img: "icons/magic/death/undead-ghost-strike-white.webp",
                system: { level: { value: ctx.spellRank ?? 1 }, duration: ctx.duration ?? { value: 1, unit: "rounds", expiry: "turn-end" }, rules }
            };
        }
    },
    bindHeroicSpirit: {
        official: `${SPELL_FX}.z5eKhhGw4vIFg9a9`,
        slugs: ["spell-effect-bind-heroic-spirit", "effect-bind-heroic-spirit"], names: ["Effect: Bind Heroic Spirit", "Spell Effect: Bind Heroic Spirit"],
        adaptOfficial: (d, ctx) => { d.system.level = { value: ctx.spellRank }; },
        inline: (ctx = {}) => ({
            name: "Effect: Bind Heroic Spirit", type: "effect",
            img: "icons/magic/death/weapon-sword-skull-purple.webp",
            system: {
                level: { value: ctx.spellRank ?? 1 },
                duration: { ...MIN1 },
                description: { value: p(`You gain a +${ctx.buffValue ?? 1} status bonus to attack rolls and saving throws. Whenever you critically hit a creature with a Strike, you can create a thrall adjacent to the target.`) },
                rules: [
                    { key: "FlatModifier", selector: "attack", value: ctx.buffValue ?? 1, type: "status" },
                    { key: "FlatModifier", selector: "saving-throw", value: ctx.buffValue ?? 1, type: "status" },
                    { key: "RollOption", domain: "strike-damage", option: "heroic-spirit-active" }
                ]
            }
        })
    },
    muscleBarrier: {
        official: `${SPELL_FX}.MfwP114GZ1Vn8aDL`,
        slugs: ["spell-effect-muscle-barrier", "effect-muscle-barrier"], names: ["Effect: Muscle Barrier", "Spell Effect: Muscle Barrier"],
        adaptOfficial: (d, ctx) => { d.system.level = { value: ctx.spellRank }; },
        inline: (ctx = {}) => ({
            name: "Effect: Muscle Barrier", type: "effect",
            img: "icons/magic/defensive/shield-barrier-flaming-pentagon-red.webp",
            system: {
                duration: { ...MIN1 },
                description: { value: p(`Grants ${ctx.tempHP ?? 10} temporary Hit Points and a +1 status bonus to Athletics checks. The spell ends when all temporary Hit Points are gone.`) },
                rules: [
                    { key: "TempHP", value: ctx.tempHP ?? 10 },
                    { key: "FlatModifier", selector: "athletics", value: 1, type: "status" }
                ]
            }
        })
    },

    boneFascination: {
        module: "necroBoneFascin0", slugs: ["bone-fascination"], names: ["Effect: Bone Fascination"],
        inline: () => ({
            name: "Effect: Bone Fascination", type: "effect",
            img: "icons/magic/death/skull-pile-glowing-pink.webp",
            system: {
                slug: "bone-fascination",
                description: { value: p("Your thralls are well constructed and nimble. They gain a +5 foot bonus to Speed.") },
                duration: { value: -1, unit: "unlimited" },
                rules: [{ key: "FlatModifier", selector: "speed", value: 5, type: "untyped" }]
            }
        })
    },
    // Built by tendril-zone.js (it has its own appearance logic); listed here so lookups know it.
    tendrilZone: {
        module: "necroTendrilZone", slugs: ["bloody-tendril-zone"], names: ["Effect: Bloody Tendril Zone"], inline: null
    },
    necroticBlood: {
        module: "necroNecroBlood0", slugs: ["effect-necrotic-blood"], names: ["Effect: Necrotic Blood"],
        dynamic: ["rules", "description", "duration"],
        inline: (ctx = {}) => {
            const stage = ctx.stage ?? 1, type = ctx.chosenType ?? "void";
            return {
                name: "Effect: Necrotic Blood", type: "effect",
                img: "icons/magic/unholy/strike-beam-blood-red-purple.webp",
                system: {
                    slug: "effect-necrotic-blood",
                    level: { value: 18 },
                    duration: { value: ctx.dos === "success" ? 1 : 6, unit: "rounds", expiry: "turn-end" },
                    description: { value: `<p><b>Necrotic Blood (Stage ${stage})</b><br>Stage 1: 3d10 ${type}, Sickened 1, Weakness 5 Bleed.<br>Stage 2: 4d10 ${type}, Sickened 2, Weakness 10 Bleed.<br>Stage 3: 5d10 ${type}, Sickened 3, Weakness 20 Bleed.<br><br><i>If this creature dies, a thrall rises from its corpse.</i></p>` },
                    rules: [{ key: "Weakness", type: "bleed", value: stage === 3 ? 20 : stage * 5 }]
                }
            };
        }
    },
    puppetedCorpse: {
        module: "necroPuppetCorps", slugs: ["puppeted-corpse"], names: ["Effect: Puppeted Corpse"],
        inline: (ctx = {}) => ({
            name: "Effect: Puppeted Corpse", type: "effect",
            img: "icons/magic/control/control-influence-puppet.webp",
            system: {
                slug: "puppeted-corpse",
                duration: { ...MIN1 },
                description: { value: p("Your heroic spirit puppets your corpse. You are an undead object. Immune to bleed, death effects, disease, healing, nonlethal, poison, void, doomed, drained, fatigued, sickened, and unconscious. Broken Threshold 100 (Slowed 1).") },
                rules: [
                    { key: "FlatModifier", selector: "hp", value: ctx.hpAdjust ?? 0, type: "untyped" },
                    ...["bleed", "death-effects", "disease", "healing", "nonlethal-attacks", "poison", "void", "doomed", "drained", "fatigued", "sickened", "unconscious", "prone"]
                        .map(type => ({ key: "Immunity", type }))
                ]
            }
        })
    },
    goryRemains: {
        module: "necroGoryRemains", slugs: ["hazard-gory-remains"], names: ["Hazard: Gory Remains"], dynamic: [],
        inline: () => ({
            name: "Hazard: Gory Remains", type: "effect",
            img: "systems/pf2e/icons/spells/massacre.webp",
            system: {
                slug: "hazard-gory-remains",
                description: { value: p("Tracks the duration of a Gory Remains difficult terrain hazard. Deleting this will clear the hazard from the map.") },
                duration: { value: 10, unit: "minutes", expiry: "turn-start" }, rules: []
            }
        })
    },
    hallowedDead: {
        module: "necroHallowdDead", slugs: ["the-hallowed-dead-effect"], names: ["The Hallowed Dead"], dynamic: ["rules", "description"],
        inline: (ctx = {}) => deadEffect("holy", ctx.damageBonus ?? 1)
    },
    unholyDead: {
        module: "necroUnholyDead0", slugs: ["the-unholy-dead-effect"], names: ["The Unholy Dead"], dynamic: ["rules", "description"],
        inline: (ctx = {}) => deadEffect("unholy", ctx.damageBonus ?? 1)
    },
    boneArmor: {
        // Bony Barrage's own armor: +1 status to AC until the start of the caster's next turn.
        official: `${SPELL_FX}.77AwscdL6dI0ZfnH`,
        module: "necroBoneArmor00",
        slugs: ["spell-effect-bony-barrage", "effect-bone-armor"], names: ["Spell Effect: Bony Barrage", "Effect: Bone Armor"],
        adaptOfficial: (d, ctx) => { if (ctx.spellRank) d.system.level = { value: ctx.spellRank }; },
        inline: () => ({
            name: "Effect: Bone Armor", type: "effect",
            img: "systems/pf2e/icons/spells/armor-of-bones.webp",
            system: {
                slug: "effect-bone-armor",
                description: { value: p("A +1 status bonus to AC.") },
                duration: { value: 1, unit: "rounds", expiry: "turn-start" },
                rules: [{ key: "FlatModifier", selector: "ac", value: 1, type: "status" }]
            }
        })
    },
    livingGraveyardLogic: {
        module: "necroLivGravLogc", slugs: ["living-graveyard-logic"], names: ["Living Graveyard Logic"],
        inline: () => ({
            name: "Living Graveyard Logic", type: "effect",
            img: "icons/magic/death/undead-zombie-grave-green.webp",
            system: {
                slug: "living-graveyard-logic",
                description: { value: p("Marks a living graveyard so the module can track it.") },
                duration: { ...MIN1 }, rules: []
            }
        })
    },
    blossomingGore: {
        module: "necroBlosmGore00", slugs: ["hazard-blossoming-gore"], names: ["Hazard: Blossoming Gore"], dynamic: [],
        inline: () => ({
            name: "Hazard: Blossoming Gore", type: "effect",
            img: "icons/magic/unholy/projectiles-blood-salvo-red.webp",
            system: {
                slug: "hazard-blossoming-gore",
                description: { value: p("Tracks the duration of the Blossoming Gore hazard. Deleting this clears the hazard from the map.") },
                duration: { ...MIN1 }, rules: []
            }
        })
    },
    bodyShield: {
        module: "necroBodyShield0", slugs: ["effect-body-shield-sacrifice"], names: ["Effect: Body Shield"], dynamic: ["rules", "level"],
        inline: (ctx = {}) => ({
            name: "Effect: Body Shield", type: "effect",
            img: "icons/magic/death/undead-skeleton-deformed-red.webp",
            system: {
                slug: "effect-body-shield-sacrifice",
                level: { value: ctx.necroLevel ?? 1 },
                duration: { value: 1, unit: "rounds", expiry: "turn-start" },
                description: { value: p("You threw a thrall in the way! +2 circumstance bonus to AC, and resistance to all damage equal to your level against the triggering attack.") },
                rules: [
                    { key: "FlatModifier", selector: "ac", value: 2, type: "circumstance" },
                    { key: "Resistance", type: "all-damage", value: ctx.necroLevel ?? 1 }
                ]
            }
        })
    },
    hallowedEarth: {
        module: "necroHallowEarth", slugs: ["effect-hallowed-earth"], names: ["Effect: Hallowed Earth"],
        inline: () => ({
            name: "Effect: Hallowed Earth", type: "effect",
            img: "systems/pf2e/icons/spells/circle-of-protection.webp",
            system: {
                slug: "effect-hallowed-earth",
                duration: { ...MIN1 },
                description: { value: p("Aura of holy vitality.") },
                rules: iconRule(10, "#ffd700")
            }
        })
    },
    corruptedGround: {
        module: "necroCorruptGrnd", slugs: ["effect-corrupted-ground"], names: ["Effect: Corrupted Ground"],
        inline: () => ({
            name: "Effect: Corrupted Ground", type: "effect",
            img: "systems/pf2e/icons/spells/blight.webp",
            system: {
                slug: "effect-corrupted-ground",
                duration: { ...MIN1 },
                description: { value: p("Aura of unholy void.") },
                rules: iconRule(10, "#8a2be2")
            }
        })
    },
    collateralReinforcement: {
        module: "necroCollatReinf", slugs: ["collateral-reinforcement"], names: ["Collateral Reinforcement"],
        inline: () => ({
            name: "Collateral Reinforcement", type: "effect",
            img: "icons/magic/defensive/shield-hex-gold.webp",
            system: {
                slug: "collateral-reinforcement",
                duration: { value: 1, unit: "rounds", expiry: "turn-start" },
                description: { value: p("Immune to area and splash damage.") },
                rules: [{ key: "Immunity", type: "area-damage" }, { key: "Immunity", type: "area" }, { key: "Immunity", type: "splash" }]
            }
        })
    },
    reanimatedFoe: {
        module: "necroReanimFoe00", slugs: ["reanimated-foe"], names: ["Reanimated Foe"], dynamic: ["description"],
        inline: (ctx = {}) => ({
            name: "Reanimated Foe", type: "effect",
            img: "systems/pf2e/icons/spells/create-undead.webp",
            system: {
                slug: "reanimated-foe",
                duration: { ...MIN1 },
                description: { value: p(`<b>Decay:</b> Loses ${ctx.decayAmount ?? 0} HP at the end of its turn. Cannot be healed.${ctx.isFailure ? "<br><b>Failure:</b> Strikes deal half damage." : ""}`) },
                rules: [
                    { key: "Immunity", type: "healing" },
                    { key: "ActiveEffectLike", mode: "override", path: "system.attributes.hp.max", value: 100 }
                ]
            }
        })
    },
    amalgamation: {
        module: "necroAmalgamatn0", slugs: ["effect-amalgamation"], names: ["Effect: Amalgamation"], dynamic: ["rules", "description"],
        inline: (ctx = {}) => ({
            name: "Effect: Amalgamation", type: "effect",
            img: "systems/pf2e/icons/spells/summon-ancient-fleshforged.webp",
            system: {
                slug: "effect-amalgamation",
                description: { value: p(`Fused from two thralls. Large size with 10-foot reach, 25-foot Speed, and a +${ctx.masterLevel ?? 1} status bonus to Strike damage.`) },
                duration: { value: -1, unit: "unlimited" },
                rules: [
                    { key: "CreatureSize", value: "lg" },
                    { key: "BaseSpeed", selector: "land", value: 25 },
                    { key: "FlatModifier", selector: "strike-damage", value: ctx.masterLevel ?? 1, type: "status", label: "Amalgamation Status Damage" },
                    { key: "AdjustStrike", mode: "upgrade", property: "weapon-traits", value: "reach" }
                ]
            }
        })
    }
};

function deadEffect(alignment, damageBonus) {
    const holy = alignment === "holy";
    return {
        name: holy ? "The Hallowed Dead" : "The Unholy Dead", type: "effect",
        img: holy ? "icons/magic/life/cross-embers-glow-yellow-purple.webp" : "icons/magic/symbols/rune-sigil-horned-white-purple.webp",
        system: {
            slug: holy ? "the-hallowed-dead-effect" : "the-unholy-dead-effect",
            duration: { value: -1, unit: "unlimited" },
            description: { value: p(`Thrall gains the ${alignment} trait. Strikes deal +${damageBonus} spirit damage and gain the ${alignment} trait.`) },
            rules: [
                { key: "RollOption", domain: "all", option: `trait:${alignment}` },
                { key: "FlatModifier", selector: "strike-damage", value: damageBonus, damageType: "spirit", type: "untyped" },
                { key: "AdjustStrike", mode: "add", property: "weapon-traits", value: alignment }
            ]
        }
    };
}

// --- Resolution ---------------------------------------------------------------------------------

const docCache = new Map();   // uuid -> Promise<plain data | null>
const sources = new WeakMap(); // resolved data -> "official" | "module" | "inline"

async function loadSource(uuid) {
    if (!docCache.has(uuid)) {
        docCache.set(uuid, (async () => {
            try {
                const doc = await fromUuid(uuid);
                return doc?.type === "effect" ? doc.toObject() : null;
            } catch { return null; }
        })());
    }
    const data = await docCache.get(uuid);
    return data ? foundry.utils.deepClone(data) : null;
}

/** Where a resolved effect came from: "official", "module" or "inline". */
export const necroEffectSource = (data) => sources.get(data);

/**
 * Resolve an effect's data: official PF2e effect, then our compendium copy, then the inline builder.
 * `overrides` are deep-merged last (flags, duration, level...); `ctx` feeds the builders.
 */
export async function getNecroEffect(key, overrides = {}, ctx = {}) {
    const entry = NECRO_EFFECTS[key];
    if (!entry) throw new Error(`Unknown necro effect "${key}"`);
    let data = null, source = null, uuid = null;

    const officialUuid = typeof entry.official === "function" ? entry.official(ctx) : entry.official;
    if (officialUuid && !ctx.skipOfficial) {
        data = await loadSource(officialUuid);
        if (data) { source = "official"; uuid = officialUuid; entry.adaptOfficial?.(data, ctx); }
    }
    if (!data && entry.module) {
        const modUuid = `${PACK}.${entry.module}`;
        data = await loadSource(modUuid);
        if (data) {
            source = "module"; uuid = modUuid;
            const live = entry.inline?.(ctx);
            for (const field of entry.dynamic ?? ["rules"]) {
                if (live?.system?.[field] !== undefined) data.system[field] = live.system[field];
            }
        }
    }
    if (!data) {
        if (!entry.inline) throw new Error(`No source for necro effect "${key}"`);
        data = entry.inline(ctx);
        source = "inline";
    }

    for (const k of ["_id", "folder", "ownership", "_stats", "_key", "sort"]) delete data[k];
    if (entry.hideTokenIcon) data.system.tokenIcon = { show: false };
    if (uuid) data._stats = { compendiumSource: uuid };
    data.type = "effect";
    data = foundry.utils.mergeObject(data, overrides, { inplace: false });
    data.flags = foundry.utils.mergeObject(data.flags ?? {}, { [MODULE]: { effectKey: key } });
    sources.set(data, source);
    return data;
}

/** Does this item match the effect `key`? effectKey flag first, then slug, then the legacy name. */
export function isNecroEffect(item, key) {
    const entry = NECRO_EFFECTS[key];
    if (!entry || item?.type !== "effect") return false;
    if (item.flags?.[MODULE]?.effectKey === key) return true;
    const slug = item.system?.slug ?? item.slug;
    return (slug && entry.slugs?.includes(slug)) || entry.names?.includes(item.name) || false;
}

/** Find an applied effect on an actor (works for effects created before this catalog existed). */
export function findNecroEffect(actor, key) {
    return actor?.items?.find(i => isNecroEffect(i, key)) ?? null;
}

/** All matching effects on an actor. */
export function findNecroEffects(actor, key) {
    return actor?.items?.filter(i => isNecroEffect(i, key)) ?? [];
}
