/**
 * On ready, the active GM removes empty leftover regions: 0 shapes, and made by this module or by
 * AoE Easy Resolve for a Necrotic Bomb / Blast or a tendril. Such husks come from an abandoned or
 * errored resolution and would otherwise sit on the scene forever.
 */
function isOurs(region) {
    const flags = region.flags ?? {};
    return !!flags["necromancer-thrall-helper"]
        || !!flags["aoe-easy-resolve"]?.isAoERegion
        || /^necrotic (bomb|blast)/i.test(region.name ?? "");
}

export async function sweepEmptyRegions() {
    if (!game.users.activeGM?.isSelf) return;
    for (const scene of game.scenes) {
        const ids = scene.regions
            .filter(r => r.shapes.length === 0 && isOurs(r))
            .map(r => r.id);
        if (!ids.length) continue;
        console.log(`Necromancer Thrall Helper | Removing ${ids.length} empty region(s) from "${scene.name}".`);
        await scene.deleteEmbeddedDocuments("Region", ids).catch(() => {});
    }
}
