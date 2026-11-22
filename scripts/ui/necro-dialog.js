/** Classes every module dialog carries so it picks up the shared dark theme (set at creation, not in a render hook). */
export const NECRO_DIALOG_CLASSES = ["dialog", "necro-thrall", "necro-dark"];

/**
 * Re-fit a legacy dialog after its first render. Foundry measures the height before the theme's
 * spacing and fonts apply, which left a few pixels of overflow and a stray scrollbar.
 */
export function fitDialog(app) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = app.element?.[0] ?? app.element;
        const c = el?.querySelector?.(".window-content");
        if (!c) return;
        app.setPosition({ height: "auto" });
        const over = c.scrollHeight - c.clientHeight;
        if (over > 0) app.setPosition({ height: Math.min(el.offsetHeight + over, Math.floor(window.innerHeight * 0.85)) });
    }));
}

/** Legacy Dialog with the module theme applied and the height fitted after the first render. */
export class NecroDialog extends Dialog {
    constructor(data, options = {}) {
        const classes = [...new Set([...NECRO_DIALOG_CLASSES, ...(options.classes ?? [])])];
        super(data, { ...options, classes });
    }

    /** @override */
    async _render(force, options) {
        const first = !this.rendered;
        const result = await super._render(force, options);
        if (first) fitDialog(this);
        return result;
    }
}
