// Damage-type colors and icons shared by the Command Deck buttons and the chat cards.
// Icon colors (and the deck's damage buttons). Physical icons are a lighter violet so they stand out on violet cards.
export const DMG_COLORS = {
    bludgeoning: "#a78bfa", piercing: "#a78bfa", slashing: "#a78bfa",
    spirit: "#4fc3d9", vitality: "#f2c94c", void: "#9b59d0",
    bleed: "#d0413b", untyped: "#c24fca"
};
// Card border/tint colors. Physical and the module's own cards ("necro") use the module's base purple; vitality gets
// a silvery-white card (icon stays gold); void gets the dark indigo of its Dramatis art (icon stays brighter).
const NECRO_PURPLE = "#7c3aed";
export const CARD_COLORS = {
    ...DMG_COLORS, bludgeoning: NECRO_PURPLE, piercing: NECRO_PURPLE, slashing: NECRO_PURPLE,
    vitality: "#eef2f6", void: "#4d3b7f", necro: NECRO_PURPLE
};
export const DMG_ICONS = {
    bludgeoning: "hammer", piercing: "bow-arrow", slashing: "axe",
    spirit: "ghost", vitality: "sun", void: "skull", bleed: "droplet"
};
