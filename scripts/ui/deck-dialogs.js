import { artKind, BUNDLED_THRALL } from "../system/thrall-manager.js";
import { notify } from "../system/notify.js";
import { getZoneConfig, describeDramatisStyle } from "../system/tendril-zone.js";
import { ownerColor, syncAllParticleColors, EFFECT_COLOR_KEYS } from "../system/effect-colors.js";

/**
 * Open the "Default Thrall Look" configuration dialog for all summon types.
 */
export function openDefaultLookDialog(actor) {
    if (!actor) return;

    const configKeys = {
        thrall: { label: "Base Thrall", img: "defaultThrallImg", ring: "defaultRingEnabled", scale: "defaultThrallScale" },
        shed: { label: "Shed Corpse", img: "shedImg", ring: "shedRing", scale: "shedScale" },
        lancer: { label: "Skeletal Lancer", img: "lancerImg", ring: "lancerRing", scale: "lancerScale" },
        nightmare: { label: "Recurring Nightmare", img: "nightmareImg", ring: "nightmareRing", scale: "nightmareScale" },
        graveyard: { label: "Living Graveyard", img: "graveyardImg", ring: "graveyardRing", scale: "graveyardScale" },
        tendril: { label: "Bloody Tendril", img: "tendrilImg", ring: "tendrilRing", scale: "tendrilScale" },
        conglom: { label: "Conglomerate of Limbs", img: "conglomImg", ring: "conglomRing", scale: "conglomScale" }
    };

    for (const map of Object.values(configKeys)) {
        map.portrait = map.img.replace(/Img$/, "Portrait");
        map.ringScale = map.scale.replace(/Scale$/, "RingScale");
        map.ringSubject = map.img.replace(/Img$/, "RingSubject");
    }

    const getCfg = (type) => ({
        img: actor.getFlag("necromancer-thrall-helper", configKeys[type].img) || "",
        portrait: actor.getFlag("necromancer-thrall-helper", configKeys[type].portrait) || "",
        ringSubject: actor.getFlag("necromancer-thrall-helper", configKeys[type].ringSubject) || "",
        ringScale: actor.getFlag("necromancer-thrall-helper", configKeys[type].ringScale),
        ring: actor.getFlag("necromancer-thrall-helper", configKeys[type].ring) ?? true,
        scale: actor.getFlag("necromancer-thrall-helper", configKeys[type].scale) ?? 1.0
    });

    const useBundledSaved = actor.getFlag("necromancer-thrall-helper", "useBundledDefault") === true;
    const bundledControls = `
        <hr>
        <div class="form-group">
            <label title="Use the module's included thrall art as the default look, even if Paizo token packs are installed.">Use bundled default instead of compendium art</label>
            <input type="checkbox" id="use-bundled-default" ${useBundledSaved ? "checked" : ""} title="Use the module's included thrall art as the default look, even if Paizo token packs are installed.">
        </div>
        <small>A custom look set above always wins. Without Paizo token packs installed, the bundled art is used automatically.</small>
        <button type="button" id="use-bundled-art-btn" data-tooltip="Fill the fields above with the bundled art"><i class="fas fa-skull"></i> Use bundled art</button>
    `;

    const zoneCfg = getZoneConfig(actor);
    const zoneModes = { outline: "Outline", dramatis: "Outrider: Dramatis", custom: "Custom file(s)" };
    const zoneControls = `
        <hr>
        <h4>Zone Appearance</h4>
        <div class="form-group">
            <label>Zone style</label>
            <select id="tendril-zone-mode">${Object.entries(zoneModes).map(([v, l]) => `<option value="${v}" ${v === zoneCfg.mode ? "selected" : ""}>${l}</option>`).join("")}</select>
        </div>
        <small class="tz-dramatis">${foundry.utils.escapeHTML(describeDramatisStyle(actor))}</small>
        <div class="form-group tz-custom">
            <label>File(s)</label>
            <input type="text" id="tendril-zone-path" value="${foundry.utils.escapeHTML(zoneCfg.customPath)}" placeholder="path/zone.webp or wildcard: path/zone-*.webp">
            <button type="button" class="img-picker-btn" data-target="tendril-zone-path" data-type="imagevideo"><i class="fas fa-file-import"></i></button>
        </div>
        <small class="tz-custom">Wildcards (*) work for files on this server, not remote URLs.</small>
        <div class="form-group">
            <label>Opacity</label>
            <div class="scale-wrap">
                <input type="range" class="scale-slider" id="tendril-zone-alpha" data-val-target="tendril-zone-alpha-val" min="0.05" max="1" step="0.05" value="${zoneCfg.alpha}">
                <input type="number" min="0.05" max="1" step="0.05" value="${zoneCfg.alpha}" id="tendril-zone-alpha-val" class="scale-num" data-slider="tendril-zone-alpha" title="Type an exact value">
            </div>
        </div>
        <small id="tendril-zone-hint"></small>
    `;

    let optionsHtml = "";
    let groupsHtml = "";

    for (const [key, map] of Object.entries(configKeys)) {
        optionsHtml += `<option value="${key}">${map.label}</option>`;
        const c = getCfg(key);

        groupsHtml += `
            <div class="summon-cfg-group" data-target="${key}" style="display: ${key === "thrall" ? "block" : "none"};">
                <div class="form-group">
                    <label>Token Art</label>
                    <input type="text" id="${key}-img-path" value="${c.img}" placeholder="path/art.webp, .webm, or wildcard: path/thrall-*.webm">
                    <button type="button" class="img-picker-btn" data-target="${key}-img-path" data-type="imagevideo"><i class="fas fa-file-import"></i></button>
                </div>
                <div class="form-group">
                    <label>Portrait</label>
                    <input type="text" id="${key}-portrait-path" value="${c.portrait}" placeholder="Optional still image or wildcard (blank = token art)">
                    <button type="button" class="img-picker-btn" data-target="${key}-portrait-path" data-type="image"><i class="fas fa-file-import"></i></button>
                </div>
                <div class="form-group">
                    <label>Ring Subject</label>
                    <input type="text" id="${key}-subject-path" value="${c.ringSubject}" placeholder="Optional transparent cutout for the ring (blank = token art)">
                    <button type="button" class="img-picker-btn" data-target="${key}-subject-path" data-type="image"><i class="fas fa-file-import"></i></button>
                </div>
                <div class="form-group">
                    <label>Enable Token Ring</label>
                    <input type="checkbox" id="${key}-ring-enabled" ${c.ring ? "checked" : ""}>
                </div>
                <small id="${key}-ring-hint"></small>
                <div class="form-group">
                    <label>Image Scale</label>
                    <div class="scale-wrap">
                        <input type="range" class="scale-slider" id="${key}-img-scale" data-val-target="${key}-scale-val" min="0.25" max="5" step="0.05" value="${c.scale}">
                        <input type="number" min="0.25" max="5" step="0.05" value="${c.scale}" id="${key}-scale-val" class="scale-num" data-slider="${key}-img-scale" title="Type an exact value">
                    </div>
                </div>
                <div class="form-group">
                    <label>Ring Subject Scale</label>
                    <div class="scale-wrap">
                        <input type="range" class="scale-slider" id="${key}-ring-scale" data-val-target="${key}-ring-scale-val" min="0.5" max="5" step="0.05" value="${c.ringScale ?? c.scale}" ${c.ringScale === undefined ? "disabled" : ""}>
                        <input type="number" min="0.5" max="5" step="0.05" value="${c.ringScale ?? c.scale}" id="${key}-ring-scale-val" class="scale-num" data-slider="${key}-ring-scale" title="Type an exact value" ${c.ringScale === undefined ? "disabled" : ""}>
                    </div>
                </div>
                <div class="form-group">
                    <label>Ring scale matches art scale</label>
                    <input type="checkbox" id="${key}-ring-link" ${c.ringScale === undefined ? "checked" : ""}>
                </div>
                ${key === "thrall" ? bundledControls : ""}
                ${key === "tendril" ? zoneControls : ""}
            </div>
        `;
    }

    const formHtml = `
        <form autocomplete="off">
            <p>Default appearance for each summon type.</p>
            <div class="form-group">
                <label>Summon</label>
                <select id="summon-type-selector">${optionsHtml}</select>
            </div>
            ${groupsHtml}
        </form>
    `;

    new Dialog({
        title: "Default Thrall Look",
        content: formHtml,
        render: (dialogHtml) => {
            const app = dialogHtml.closest(".app, .window-app");
            app.removeClass("theme-light").addClass("theme-dark");
            app.find(".window-title").prepend('<i class="fas fa-image" style="margin-right: 6px;"></i>');
            dialogHtml.find("#summon-type-selector").on("change", (evt) => {
                const selected = evt.target.value;
                dialogHtml.find(".summon-cfg-group").hide();
                dialogHtml.find(`.summon-cfg-group[data-target="${selected}"]`).show();
            });

            if (!game.user.hasPermission("FILES_BROWSE")) dialogHtml.find(".img-picker-btn").hide();

            dialogHtml.find(".img-picker-btn").on("click", (evt) => {
                evt.preventDefault();
                const targetId = $(evt.currentTarget).data("target");
                const inputElt = dialogHtml.find(`#${targetId}`);
                new FilePicker({
                    type: $(evt.currentTarget).data("type") || "image",
                    current: inputElt.val(),
                    callback: (path) => inputElt.val(path).trigger("change")
                }).render(true);
            });

            dialogHtml.find(".scale-slider").on("input", (evt) => {
                const targetId = $(evt.currentTarget).data("val-target");
                dialogHtml.find(`#${targetId}`).val(evt.target.value);
            });

            dialogHtml.find(".scale-num").on("change", (evt) => {
                const slider = dialogHtml.find(`#${$(evt.currentTarget).data("slider")}`);
                const v = parseFloat(evt.currentTarget.value);
                if (Number.isFinite(v)) slider.val(v);
                slider.trigger("input");
            });

            const syncRingHint = (key) => {
                const hasSubject = !!dialogHtml.find(`#${key}-subject-path`).val().trim();
                const kind = hasSubject ? "subject" : artKind(dialogHtml.find(`#${key}-img-path`).val().trim());
                const box = dialogHtml.find(`#${key}-ring-enabled`);
                const cutout = "Ring requires transparent cutout art. Full-frame images will cover the ring.";
                const text = {
                    video: "Dynamic token rings don't support animated art. Set a Ring Subject image to use the ring.",
                    mixed: "Ring is skipped automatically for any video file selected (unless a Ring Subject is set)."
                }[kind] ?? cutout;
                if (kind === "video") {
                    if (box.data("savedRing") === undefined) box.data("savedRing", box.is(":checked"));
                    box.prop("checked", false).prop("disabled", true);
                } else {
                    box.prop("disabled", false);
                    if (box.data("savedRing") !== undefined) {
                        box.prop("checked", box.data("savedRing"));
                        box.removeData("savedRing");
                    }
                }
                box.attr("title", cutout);
                dialogHtml.find(`#${key}-ring-hint`).text(text);
            };
            for (const key of Object.keys(configKeys)) {
                dialogHtml.find(`#${key}-img-path, #${key}-subject-path`).on("input change", () => syncRingHint(key));
                syncRingHint(key);
            }

            const zoneHints = {
                outline: "Calm red outline; readable on light and dark maps.",
                dramatis: "Random tile per tendril from 0utrider/dramatis. Outline hidden.",
                custom: "One file per tendril (wildcard picks randomly). Outline hidden."
            };
            const syncZoneMode = () => {
                const mode = dialogHtml.find("#tendril-zone-mode").val();
                dialogHtml.find(".tz-dramatis").toggle(mode === "dramatis");
                dialogHtml.find(".tz-custom").toggle(mode === "custom");
                dialogHtml.find("#tendril-zone-hint").text(zoneHints[mode]);
            };
            dialogHtml.find("#tendril-zone-mode").on("change", syncZoneMode);
            syncZoneMode();

            dialogHtml.find("#use-bundled-art-btn").on("click", (evt) => {
                evt.preventDefault();
                dialogHtml.find("#thrall-img-path").val(BUNDLED_THRALL.subject);
                dialogHtml.find("#thrall-portrait-path").val(BUNDLED_THRALL.portrait);
                dialogHtml.find("#thrall-subject-path").val(BUNDLED_THRALL.subject);
                dialogHtml.find("#thrall-ring-enabled").prop("checked", true);
                dialogHtml.find("#thrall-img-scale").val(1).trigger("input");
                dialogHtml.find("#thrall-ring-link").prop("checked", false).trigger("change");
                dialogHtml.find("#thrall-ring-scale").val(BUNDLED_THRALL.subjectScale).trigger("input");
                syncRingHint("thrall");
            });

            const syncRing = (key) => {
                const linked = dialogHtml.find(`#${key}-ring-link`).is(":checked");
                const ring = dialogHtml.find(`#${key}-ring-scale`);
                ring.prop("disabled", linked);
                if (linked) ring.val(dialogHtml.find(`#${key}-img-scale`).val());
                dialogHtml.find(`#${key}-ring-scale-val`).val(ring.val()).prop("disabled", linked);
            };
            for (const key of Object.keys(configKeys)) {
                dialogHtml.find(`#${key}-ring-link`).on("change", () => syncRing(key));
                dialogHtml.find(`#${key}-img-scale`).on("input", () => syncRing(key));
            }
        },
        buttons: {
            save: {
                icon: '<i class="fas fa-save"></i>',
                label: "Save",
                callback: async (dialogHtml) => {
                    const updates = {};
                    for (const [key, map] of Object.entries(configKeys)) {
                        updates[`flags.necromancer-thrall-helper.${map.img}`] = dialogHtml.find(`#${key}-img-path`).val();
                        const ringBox = dialogHtml.find(`#${key}-ring-enabled`);
                        updates[`flags.necromancer-thrall-helper.${map.ring}`] =
                            ringBox.is(":disabled") && ringBox.data("savedRing") !== undefined
                                ? ringBox.data("savedRing")
                                : ringBox.is(":checked");
                        updates[`flags.necromancer-thrall-helper.${map.scale}`] = parseFloat(dialogHtml.find(`#${key}-img-scale`).val());
                        updates[`flags.necromancer-thrall-helper.${map.portrait}`] = dialogHtml.find(`#${key}-portrait-path`).val().trim();
                        updates[`flags.necromancer-thrall-helper.${map.ringSubject}`] = dialogHtml.find(`#${key}-subject-path`).val().trim();
                        if (dialogHtml.find(`#${key}-ring-link`).is(":checked")) {
                            updates[`flags.necromancer-thrall-helper.-=${map.ringScale}`] = null;
                        } else {
                            updates[`flags.necromancer-thrall-helper.${map.ringScale}`] = parseFloat(dialogHtml.find(`#${key}-ring-scale`).val());
                        }
                    }
                    const zoneAlpha = parseFloat(dialogHtml.find("#tendril-zone-alpha").val());
                    updates["flags.necromancer-thrall-helper.tendrilZone"] = {
                        mode: dialogHtml.find("#tendril-zone-mode").val(),
                        customPath: dialogHtml.find("#tendril-zone-path").val().trim(),
                        alpha: Number.isFinite(zoneAlpha) ? Math.min(1, Math.max(0.05, zoneAlpha)) : 0.3
                    };
                    updates["flags.necromancer-thrall-helper.useBundledDefault"] = dialogHtml.find("#use-bundled-default").is(":checked");
                    await actor.update(updates);
                    notify("info", "Summon configurations updated successfully.");
                }
            }
        },
        default: "save"
    }, { classes: ["dialog", "necro-thrall", "necro-look", "necro-dark"], width: 380 }).render(true);
}

/**
 * Open the "Necromancer Settings" dialog (zone borders, effect colors, notification verbosity).
 */
export function openNecroSettingsDialog(actor) {
    if (!actor) return;

    const saved = actor.getFlag("necromancer-thrall-helper", "effectColors") || {};
    const playerColor = ownerColor(actor);
    const zoneLinked = saved.zoneBorder?.linked !== false;
    const zoneColor = saved.zoneBorder?.color || playerColor;
    const rows = EFFECT_COLOR_KEYS.map(({ key, label, fallback }) => `
        <div class="necro-row">
            <label>${label}</label>
            <input type="color" class="necro-swatch fx-color" data-key="${key}" value="${saved[key] || fallback || playerColor}">
        </div>`).join("");
    const level = game.settings.get("necromancer-thrall-helper", "notificationLevel");
    const levelOptions = Object.entries(game.settings.settings.get("necromancer-thrall-helper.notificationLevel").choices)
        .map(([v, l]) => `<option value="${v}" ${v === level ? "selected" : ""}>${l}</option>`).join("");

    new Dialog({
        title: "Necromancer Settings",
        content: `
            <form autocomplete="off" class="necro-settings-form">
                <h3>Zones</h3>
                <div class="necro-row">
                    <label>Zone borders</label>
                    <span class="necro-zone-controls">
                        <button type="button" id="fx-zone-link" class="necro-link-btn ${zoneLinked ? "linked" : ""}"><i class="fas fa-user"></i></button>
                        <input type="color" id="fx-zone-color" class="necro-swatch" value="${zoneLinked ? playerColor : zoneColor}" ${zoneLinked ? "disabled" : ""}>
                    </span>
                </div>
                <h3>Effect Colors</h3>
                <div class="necro-row">
                    <label title="Use the color of the player who owns this necromancer, even when the GM places the effect.">Effects use player color <span class="necro-chip" style="background: ${playerColor};"></span></label>
                    <input type="checkbox" id="fx-use-player" ${saved.usePlayer ? "checked" : ""}>
                </div>
                ${rows}
                <h3>Notifications</h3>
                <div class="necro-row">
                    <label title="Applies to you only, on this device.">Pop-ups</label>
                    <select id="fx-notify-level">${levelOptions}</select>
                </div>
            </form>`,
        render: (dialogHtml) => {
            const app = dialogHtml.closest(".app, .window-app");
            app.removeClass("theme-light").addClass("theme-dark");
            app.find(".window-title").prepend('<i class="fas fa-cog" style="margin-right: 6px;"></i>');
            const linkBtn = dialogHtml.find("#fx-zone-link");
            const zoneInput = dialogHtml.find("#fx-zone-color");
            const syncZone = () => {
                const linked = linkBtn.hasClass("linked");
                zoneInput.prop("disabled", linked);
                if (linked) zoneInput.val(playerColor);
                linkBtn.attr("title", linked ? "Linked to player color (click to customize)" : "Custom (click to link to player color)");
            };
            linkBtn.on("click", (evt) => {
                evt.preventDefault();
                linkBtn.toggleClass("linked");
                if (!linkBtn.hasClass("linked")) zoneInput.val(zoneColor);
                syncZone();
            });
            syncZone();
            const syncEffects = () => dialogHtml.find(".fx-color").prop("disabled", dialogHtml.find("#fx-use-player").is(":checked"));
            dialogHtml.find("#fx-use-player").on("change", syncEffects);
            syncEffects();
        },
        buttons: {
            reset: {
                icon: '<i class="fas fa-rotate-left"></i>',
                label: "",
                callback: async () => {
                    await actor.unsetFlag("necromancer-thrall-helper", "effectColors");
                    for (const item of actor.items) {
                        if (item.type === "spell" && item.flags?.["aoe-easy-resolve"]?.useCustomColor) {
                            await item.update({ "flags.aoe-easy-resolve.useCustomColor": false });
                        }
                    }
                    notify("info", "Settings reset to defaults.");
                }
            },
            save: {
                icon: '<i class="fas fa-save"></i>',
                label: "Save",
                callback: async (dialogHtml) => {
                    const linked = dialogHtml.find("#fx-zone-link").hasClass("linked");
                    const cfg = {
                        usePlayer: dialogHtml.find("#fx-use-player").is(":checked"),
                        zoneBorder: { linked, color: linked ? zoneColor : dialogHtml.find("#fx-zone-color").val() }
                    };
                    dialogHtml.find(".fx-color").each((_i, el) => { cfg[el.dataset.key] = el.value; });
                    await actor.setFlag("necromancer-thrall-helper", "effectColors", cfg);
                    await syncAllParticleColors(actor);
                    await game.settings.set("necromancer-thrall-helper", "notificationLevel", dialogHtml.find("#fx-notify-level").val());
                    notify("info", "Settings saved.");
                }
            }
        },
        default: "save"
    }, { classes: ["dialog", "necro-thrall", "necro-settings", "necro-dark"], width: 400 }).render(true);
}