/**
 * On ready, the active GM is told which necromancer players lack "Use File Browser" (so they
 * can't use the file-picker buttons), why, and how to fix it. Only fixes that would actually work
 * are offered. Informational: pasting a path or URL, and wildcard art, work without the permission.
 */
const MODULE = "necromancer-thrall-helper";
const ROLE_NAMES = { 1: "Player", 2: "Trusted Player", 3: "Assistant GM" };

const rolePermitted = (role) => (game.settings.get("core", "permissions").FILES_BROWSE ?? []).includes(role);

/** Users who own a Necromancer but can't browse files, each with the cause. */
function affectedUsers() {
    const necros = game.actors.filter(a => a.class?.slug === "necromancer");
    const rows = [];
    for (const user of game.users) {
        if (user.isGM || user.can("FILES_BROWSE")) continue;
        const actors = necros.filter(a => a.testUserPermission(user, "OWNER"));
        if (!actors.length) continue;
        const role = user.role;
        let cause;
        if (role > CONST.USER_ROLES.PLAYER) cause = "role-lacks"; // Trusted/Assistant, but their role lost the permission
        else cause = rolePermitted(CONST.USER_ROLES.TRUSTED) ? "player" : "player-and-trusted";
        rows.push({ user, actors, cause });
    }
    return rows;
}

async function setRolePermission(role, allowed = true) {
    const perms = foundry.utils.deepClone(game.settings.get("core", "permissions"));
    const roles = new Set(perms.FILES_BROWSE ?? []);
    if (allowed) roles.add(role); else roles.delete(role);
    perms.FILES_BROWSE = [...roles];
    await game.settings.set("core", "permissions", perms);
}

export async function checkBrowsePermissions() {
    if (!game.users.activeGM?.isSelf) return;
    if (game.settings.get(MODULE, "suppressBrowseWarning")) return;

    // Each pass shows what is still wrong; after any fix the check runs again until nothing is left.
    for (let pass = 0; pass < 8; pass++) {
        const rows = affectedUsers();
        if (!rows.length) return;
        const action = await showNotice(rows);
        if (!action) return;
        await action();
    }
}

function showNotice(rows) {
    const esc = foundry.utils.escapeHTML ?? (t => t);
    const who = ({ user, actors }) => `<b>${esc(user.name)}</b> (${ROLE_NAMES[user.role] ?? "Player"}) &rarr; ${esc(actors.map(a => a.name).join(", "))}`;
    const btn = (id, icon, label) => `<button type="button" data-fix="${id}"><i class="fas ${icon}"></i> ${label}</button>`;
    const fixes = new Map();
    const sections = [];
    let n = 0;
    const addFix = (icon, label, fn) => { const id = `f${n++}`; fixes.set(id, fn); return btn(id, icon, label); };

    const lacks = rows.filter(r => r.cause === "role-lacks");
    const player = rows.filter(r => r.cause === "player");
    const both = rows.filter(r => r.cause === "player-and-trusted");

    if (lacks.length) {
        const roles = [...new Set(lacks.map(r => r.user.role))];
        sections.push(`<h4>Their role can't use the file browser</h4>
            <p>These users already have an elevated role, but <b>Use File Browser</b> was removed from it, so promoting them won't help.</p>
            <ul style="list-style:none;padding:0;">${lacks.map(r => `<li>${who(r)}</li>`).join("")}</ul>
            <p>${roles.map(role => addFix("fa-unlock", `Restore Use File Browser for ${ROLE_NAMES[role] ?? "this role"}`, () => setRolePermission(role))).join(" ")}</p>`);
    }
    if (player.length) {
        sections.push(`<h4>Player role</h4>
            <p>Trusted Players can use the file browser; these users are still plain Players.</p>
            <ul style="list-style:none;padding:0;">${player.map(r => `<li style="display:flex;align-items:center;gap:8px;justify-content:space-between;margin:4px 0;"><span>${who(r)}</span>${addFix("fa-user-check", "Make Trusted Player", () => r.user.update({ role: CONST.USER_ROLES.TRUSTED }))}</li>`).join("")}</ul>`);
    }
    if (both.length) {
        sections.push(`<h4>Neither Player nor Trusted can browse</h4>
            <p><b>Use File Browser</b> is off for Trusted Players too, so a promotion alone won't help.</p>
            <ul style="list-style:none;padding:0;">${both.map(r => `<li style="display:flex;align-items:center;gap:8px;justify-content:space-between;margin:4px 0;"><span>${who(r)}</span>${addFix("fa-user-check", "Restore for Trusted + make Trusted", async () => { await setRolePermission(CONST.USER_ROLES.TRUSTED); await r.user.update({ role: CONST.USER_ROLES.TRUSTED }); })}</li>`).join("")}</ul>`);
    }

    const hasPlayers = player.length + both.length > 0;
    const content = `${sections.join("")}
        <p>Without it they won't see the file-picker buttons for thrall art. They can paste a path or URL instead, and wildcard art still works.</p>
        <p><small><b>Security:</b> this lets them browse the server's data folders. Trusted Player also grants other core permissions.</small></p>`;

    const { DialogV2 } = foundry.applications.api;
    return new Promise((resolve) => {
        let chosen = null;
        const buttons = [];
        if (hasPlayers) buttons.push({
            action: "grant",
            label: "Grant Use File Browser to Player role",
            icon: "fas fa-unlock",
            callback: () => { chosen = () => setRolePermission(CONST.USER_ROLES.PLAYER); }
        });
        buttons.push(
            {
                action: "suppress",
                label: "Don't show again",
                icon: "fas fa-eye-slash",
                callback: () => game.settings.set(MODULE, "suppressBrowseWarning", true)
            },
            { action: "close", label: "Close", icon: "fas fa-times", default: true }
        );
        DialogV2.wait({
            window: { title: "Thrall Helper: File Browser Permission", icon: "fas fa-folder-open" },
            content,
            rejectClose: false,
            render: (event, dialog) => {
                for (const b of dialog.element.querySelectorAll("button[data-fix]")) {
                    b.addEventListener("click", () => {
                        chosen = fixes.get(b.dataset.fix);
                        dialog.close();
                    });
                }
            },
            buttons
        }).then(() => resolve(chosen), () => resolve(null));
    });
}
