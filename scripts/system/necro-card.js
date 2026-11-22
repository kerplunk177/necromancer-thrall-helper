// Every chat card the module posts goes through here, so chat-fx can style it in the module's colors
// (cards without a roll, like Conglomerate Grab or "Bone Armor Activated!", included).

const MODULE = "necromancer-thrall-helper";

/** ChatMessage.create, with the module's card flag added. */
export function createNecroCard(data, options) {
    // Shallow on purpose: the data can carry Roll instances, which must not be cloned.
    const tag = (d = {}) => ({ ...d, flags: { ...d.flags, [MODULE]: { ...d.flags?.[MODULE], card: true } } });
    return ChatMessage.create(Array.isArray(data) ? data.map(tag) : tag(data), options);
}
