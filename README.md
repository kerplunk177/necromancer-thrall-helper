**Tactical Action Hub**
* Native PF2e Strikes: Dynamically forges and rolls native system strikes for your thralls, scaling damage dice automatically based on your Necromancer level (1d6 scaling progression).
* MAP Integration: Built-in Multiple Attack Penalty pips (0, -5, -10) that dynamically affect your thrall strike rolls.
* Thrall Charge & Detonation: Command your minions to charge or detonate upon impact, automatically calculating status bonuses and handling kamikaze cleanups.
* Tactical Proximity Scanner: Scans a 10-foot radius around each active thrall to display nearby enemies and friendly units at a glance.
* Integrates cleanly with my AOE-Easy-Resolve module for Necrotic bomb, Life Tap, Blood Infusion, and more to come. 
* Thralls display how many friendlies and enemies are within 10 feet in order to give the best indication of when to Necrotic Bomb. 
**Custom Presets & Family Tree**
* Custom Identities: Configure custom unique thrall identities via actor flags.
* Randomized Adjective Generator: Automatically prefixes summons with modifiers like "Angry", "Putrid", or "Moth-Eaten" from a robust adjective pool.
**Automated Spell Integration**
* Necrotic Bomb: Automatically handles emanation templates, fortitude saves, and custom void versus vitality type-swapping toggles directly embedded inside chat cards.
* Blood Infusion & Life Tap: Full integration with area-of-effect resolution tools, stripping bleed immunities, applying persistent damage, managing drained conditions, and routing siphon healing to eligible allies.
**Secure Multiplayer & Socketlib Integration**
* Player Summon Requests: Players can initiate summoning rituals and place ghost previews on the canvas.
* GM Approval Workflow: Leverages socketlib to securely route spawn requests to the GM.
* Tactical GM Pings: When a player requests a spawn, the GM screen automatically pans to the target location, pings the map, and flashes a glowing tactical highlight box while awaiting confirmation.

  **Video of features as of 1.0.2 with more coming all the time:** https://www.youtube.com/watch?v=0kgbYnEZim8

**Permissions and player summons**
* File browser: players need the core "Use File Browser" permission to see the file-picker buttons for thrall art. Without it they can paste a path or URL instead, and wildcard art still works. On load, the GM gets a notice listing necromancer players who lack it, with one-click options to grant it to the Player role, make a player Trusted, or hide the notice. Granting it lets those players browse the server's data folders, and Trusted Player also grants other core permissions.
* Approval: when a player summons several thralls, they place them all (numbered markers) and the GM gets ONE approval dialog listing each spot. The GM can untick any thrall and approve the rest. Esc or right-click undoes the last placement and Enter sends early.
* Inevitable Return: the GM decides what happens to the corpse token the thrall rose from, Keep (default) or Hide. For a player's summon the choice is a row in the GM's approval dialog and only applies if the spawn is approved. GM-initiated summons get a small prompt after the thrall appears, with an optional "Remember for this session". Hidden corpses can't be looted by players (Lootable NPCs).

**Bloody Tendrils zone**
* Each tendril carries an aura effect ("Effect: Bloody Tendril Zone") showing the danger zone; it moves with the token. Saves and damage come from a hidden region that follows the tendril, and exist only for tendrils the GM approved. Esc or right-click undoes the last tendril placed, and Enter sends early.
* Visibility follows PF2e's aura rules: the zone is visible when the scene has Token Vision on, during an encounter, or when a tendril is selected or hovered (hold Alt to show all). Saves and damage work either way.
* Zone Appearance (Default Thrall Look, Bloody Tendril): Outline (default, a calm red outline), Outrider: Dramatis (a random tile per tendril from the 0utrider/dramatis repo, picked by your Grim Fascination: Blood, Bone, Flesh or Spirit; otherwise the neutral template set), or Custom file(s) (a path or a local wildcard). Opacity defaults to 0.30. If a tile can't load, the outline is used instead.
* Thralls and tendrils spawn with the party alliance so players can see their auras and PF2e treats them as allies.

**Token art**
* Wildcard art: any image path can be a pattern such as `path/to/art/thrall-*.webp`; one matching file is picked at random each time a thrall is summoned.
  Wildcard art works for every player, including those without file-browser permission: the GM's client resolves the pattern when approving the summon. On older versions, give the Player role "Use File Browser" in Configure Permissions.
* Animated art: token art can be a `.webm`. Dynamic token rings don't support animation, so the ring is skipped for animated art unless you also set a Ring Subject (a transparent cutout image).
* Portraits and ring subjects: each look can have a still-image Portrait (shown in the Command Deck and chat cards) and a Ring Subject (the cutout the dynamic ring draws). If the art and these are all wildcards, files that share the same `*` text are paired, e.g. `thrall-03.webm` with `portrait-03.webp` and `subject-03.webp`.
* Missing token packs: if a thrall or summon type points at art from a token pack that isn't installed, a bundled fallback image is used instead. The plain Thrall's look is chosen in this order: your own default art (Default Summon Config), the bundled art if "Use bundled default instead of compendium art" is checked, the compendium art if its token pack is active, and the bundled art otherwise. "Use bundled art" in Default Summon Config fills the fields in for you to tweak.

**Effect colors and notifications**
* Effect Colors (button under Default Thrall Look): choose colors for spell particles from AoE Easy Resolve (Necrotic Bomb/Blast, Desperate Revival, Dread Mosquito), the Blood Pool, the Living Graveyard area, the Thick Skin emanation and range rings, or use the color of the player who owns the necromancer. Nothing changes until you set it. The Necrotic Bomb/Blast zone stays in the owner's player color.
* Notification Level (client setting, also in Effect Colors): choose all messages, warnings and errors (default), errors only, or none. Placement instructions and permission problems always show.

**Credits**
* The fallback image `assets/thrall.webp` (and the portrait, ring subject and token cut from it by `tools/make_thrall_subject.py`) comes from The Battle for Wesnoth (artist doofus-01, GPL v2+). Details are in [`assets/CREDITS.md`](assets/CREDITS.md).
