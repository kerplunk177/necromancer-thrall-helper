const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PortfolioEditor extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "thrall-portfolio-editor",
        title: "Thrall Portfolio",
        tag: "form",
        position: {
            width: 450,
            height: "auto"
        },
        window: {
            icon: "fas fa-book-dead",
            resizable: false
        }
    };

    static PARTS = {
        main: {
            template: "modules/necromancer-thrall-helper/templates/portfolio-editor.hbs"
        }
    };

    constructor(actor, options = {}) {
        super(options);
        this.actor = actor;
        this.editingId = null;
    }

    async _prepareContext(options) {
        const customFamily = this.actor.getFlag("necromancer-thrall-helper", "familyTree") || [];
        return {
            presets: customFamily
        };
    }

    /** @override */
    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;

        const standardAdjectives = [
            "Angry", "Soggy", "Vengeful", "Festering", "Hollow", 
            "Shivering", "Wrinkled", "Spiteful", "Damp", "Putrid", 
            "Screaming", "Moth-Eaten", "Bitter", "Rancid", "Haunted"
        ];

        // 1. Delete Thrall Logic
        const deleteBtns = html.querySelectorAll(".delete-preset-btn");
        deleteBtns.forEach(btn => {
            btn.addEventListener("click", async (e) => {
                e.preventDefault();
                const row = e.currentTarget.closest(".portfolio-row");
                const presetId = row.dataset.id;
                
                let customFamily = this.actor.getFlag("necromancer-thrall-helper", "familyTree") || [];
                customFamily = customFamily.filter(p => p.id !== presetId);
                
                await this.actor.setFlag("necromancer-thrall-helper", "familyTree", customFamily);
                if (this.editingId === presetId) this.resetForm(html);
                this.render(true);
            });
        });

        // 2. Edit Thrall Logic
        const editBtns = html.querySelectorAll(".edit-preset-btn");
        editBtns.forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                const row = e.currentTarget.closest(".portfolio-row");
                const presetId = row.dataset.id;
                
                const customFamily = this.actor.getFlag("necromancer-thrall-helper", "familyTree") || [];
                const target = customFamily.find(p => p.id === presetId);
                if (!target) return;

                this.editingId = target.id;

                html.querySelector("#new-thrall-name").value = target.name || "";
                html.querySelector("#new-thrall-img").value = target.img || "";
                html.querySelector("#new-thrall-unique").checked = !!target.isUnique;

                const checkboxes = html.querySelectorAll("input[name='adjective']");
                const customAdjs = [];
                
                checkboxes.forEach(cb => {
                    cb.checked = target.adjectives?.includes(cb.value);
                });

                if (target.adjectives) {
                    target.adjectives.forEach(adj => {
                        if (!standardAdjectives.includes(adj)) {
                            customAdjs.push(adj);
                        }
                    });
                }
                html.querySelector("#new-thrall-custom-adj").value = customAdjs.join(", ");

                html.querySelector("#builder-heading").textContent = `Editing: ${target.name}`;
                const saveBtn = html.querySelector("#save-thrall-btn");
                saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Changes';
            });
        });

        // 3. Native File Picker Hook
        const filePickerBtn = html.querySelector(".file-picker-btn");
        if (filePickerBtn) {
            filePickerBtn.addEventListener("click", (e) => {
                e.preventDefault();
                new FilePicker({
                    type: "image",
                    callback: (path) => {
                        html.querySelector("#new-thrall-img").value = path;
                    }
                }).render(true);
            });
        }

        // 4. Select All Adjectives Toggle
        const selectAllBtn = html.querySelector("#select-all-adj-btn");
        if (selectAllBtn) {
            selectAllBtn.addEventListener("click", (e) => {
                e.preventDefault();
                const checkboxes = html.querySelectorAll("input[name='adjective']");
                const allChecked = Array.from(checkboxes.values()).every(cb => cb.checked);
                
                checkboxes.forEach(cb => cb.checked = !allChecked);
                selectAllBtn.textContent = allChecked ? "Select All" : "Deselect All";
            });
        }

        // 5. Save / Add Thrall Logic
        const saveBtn = html.querySelector("#save-thrall-btn");
        if (saveBtn) {
            saveBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const name = html.querySelector("#new-thrall-name").value.trim();
                const img = html.querySelector("#new-thrall-img").value.trim();
                const customAdjRaw = html.querySelector("#new-thrall-custom-adj").value.trim();
                const isUnique = html.querySelector("#new-thrall-unique").checked;

                if (!name || !img) {
                    ui.notifications.warn("Both name and image path are required.");
                    return;
                }

                const checkedCheckboxes = html.querySelectorAll("input[name='adjective']:checked");
                let adjectives = Array.from(checkedCheckboxes).map(cb => cb.value);

                if (customAdjRaw) {
                    const customList = customAdjRaw.split(",").map(s => s.trim()).filter(Boolean);
                    adjectives = [...adjectives, ...customList];
                }

                let customFamily = this.actor.getFlag("necromancer-thrall-helper", "familyTree") || [];

                if (this.editingId) {
                    customFamily = customFamily.map(p => {
                        if (p.id === this.editingId) {
                            return {
                                id: this.editingId,
                                name: name,
                                img: img,
                                adjectives: adjectives,
                                isUnique: isUnique
                            };
                        }
                        return p;
                    });
                } else {
                    const newId = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
                    if (customFamily.find(p => p.id === newId)) {
                        ui.notifications.warn("A thrall with a similar name already exists in the portfolio.");
                        return;
                    }

                    customFamily.push({
                        id: newId,
                        name: name,
                        img: img,
                        adjectives: adjectives,
                        isUnique: isUnique
                    });
                }

                await this.actor.setFlag("necromancer-thrall-helper", "familyTree", customFamily);
                this.resetForm(html);
                this.render(true);
            });
        }
    }

    resetForm(html) {
        this.editingId = null;
        html.querySelector("#builder-heading").textContent = "Draft New Thrall";
        html.querySelector("#new-thrall-name").value = "";
        html.querySelector("#new-thrall-img").value = "";
        html.querySelector("#new-thrall-custom-adj").value = "";
        html.querySelector("#new-thrall-unique").checked = true; // Now defaults to true
        html.querySelectorAll("input[name='adjective']").forEach(cb => cb.checked = false);
        const saveBtn = html.querySelector("#save-thrall-btn");
        saveBtn.innerHTML = '<i class="fas fa-plus"></i> Add to Portfolio';
    }
}