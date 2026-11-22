const MODULE_BASE = "modules/necromancer-thrall-helper/";
const ICON_RE = /["'`]((?:icons|systems\/pf2e\/icons)\/[^"'`$\s]+\.(?:webp|svg|png|jpg|jpeg|webm))["'`]/g;

/** Follow the relative imports from main.js and collect every script's text. */
async function crawlScripts() {
    const seen = new Map();
    const queue = ["scripts/main.js"];
    while (queue.length) {
        const path = queue.pop();
        if (seen.has(path)) continue;
        const text = await (await fetch(MODULE_BASE + path)).text();
        seen.set(path, text);
        for (const [, rel] of text.matchAll(/from\s+["'](\.[^"']+\.js)["']/g)) {
            queue.push(new URL(rel, `http://x/${path}`).pathname.slice(1));
        }
    }
    return seen;
}

/**
 * Dev check: HEAD every icon path the module's scripts and effects pack refer to and report the
 * ones the server can't find. Run from the console: `await NecroThrallHelper.checkIcons()`.
 */
export async function checkIcons() {
    const paths = new Set();
    for (const text of (await crawlScripts()).values()) for (const m of text.matchAll(ICON_RE)) paths.add(m[1]);
    const pack = game.packs.get("necromancer-thrall-helper.necro-effects");
    for (const e of (await pack?.getIndex({ fields: ["img"] })) ?? []) if (e.img) paths.add(e.img);

    const missing = [];
    for (const path of paths) {
        try {
            const res = await fetch(foundry.utils.getRoute(path), { method: "HEAD" });
            if (!res.ok) missing.push(path);
        } catch { missing.push(path); }
    }
    console.log(`necromancer-thrall-helper | Icon check: ${paths.size} paths, ${missing.length} missing`, missing);
    return missing;
}
