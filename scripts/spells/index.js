import { bindSummonThrallButtons } from "./summon-thrall.js";
import { bindPerfectedThrallButton } from "./perfected-thrall.js";
import { bindSkeletalLancersButton } from "./skeletal-lancers.js";
import { bindRecurringNightmareButtons } from "./recurring-nightmare.js";
import { bindLivingGraveyardButtons } from "./living-graveyard.js";
import { bindConglomerateButton } from "./conglomerate-of-limbs.js";
import { bindBloodyTendrilsButton } from "./bloody-tendrils.js";
import { bindDreadMosquitoButtons } from "./dread-mosquito-storm.js";
import { bindZombieHordeButtons, executeZombieHorde } from "./zombie-horde.js";
import { bindBlossomingGoreButtons, executeBlossomingGore } from "./blossoming-gore.js";
import { bindHeaderUtilityButtons, executeConsumeThrall, executeBodyShield } from "./sacrifice-utils.js";

import { executeStrike, executeCharge, executeConglomerateCharge } from "./thrall-strike.js";
import { executeReanimateFoe } from "./reanimate-foe.js";
import { executeCalcification } from "./calcification.js";
import { executeTemporaryPossession } from "./temporary-possession.js";
import { executeFleshTsunami } from "./flesh-tsunami.js";
import { executeAmalgamate } from "./amalgamate.js";
import { executeBindHeroicSpirit } from "./bind-heroic-spirit.js";
import { executeDeathlyScream } from "./deathly-scream.js";
import { executeBoneBurst } from "./bone-burst.js";
import { executeDeadWeight } from "./dead-weight.js";
import { executeBoneSpear } from "./bone-spear.js";
import { executeBloodInfusion } from "./blood-infusion.js";
import { executeNecroticBomb } from "./necrotic-bomb.js";
import { executeLifeTap } from "./life-tap.js";
import { executeMuscleBarrier } from "./muscle-barrier.js";
import { executeBonyBarrage } from "./bony-barrage.js";
import { executeSongOfTheSoul } from "./song-of-the-soul.js";

/**
 * Bind all top-bar summon, hazard, and utility buttons on the Command Deck.
 */
export function bindHeaderSpellButtons(deck, html) {
    bindSummonThrallButtons(deck, html);
    bindPerfectedThrallButton(deck, html);
    bindSkeletalLancersButton(deck, html);
    bindRecurringNightmareButtons(deck, html);
    bindLivingGraveyardButtons(deck, html);
    bindConglomerateButton(deck, html);
    bindBloodyTendrilsButton(deck, html);
    bindDreadMosquitoButtons(deck, html);
    bindZombieHordeButtons(deck, html);
    bindBlossomingGoreButtons(deck, html);
    bindHeaderUtilityButtons(deck, html);
}

/**
 * Dispatch table for per-thrall dropdown actions.
 * Each handler receives `{ deck, actor, tokenDoc, tokenId, event }`.
 */
export const THRALL_ACTIONS = {
    "strike": executeStrike,
    "charge": executeCharge,
    "conglomerate-charge": executeConglomerateCharge,
    "reanimate-foe": executeReanimateFoe,
    "calcification": executeCalcification,
    "temporary-possession": executeTemporaryPossession,
    "flesh-tsunami": executeFleshTsunami,
    "amalgamate": executeAmalgamate,
    "bind-heroic-spirit": executeBindHeroicSpirit,
    "body-shield": executeBodyShield,
    "blossoming-gore": executeBlossomingGore,
    "zombie-horde": executeZombieHorde,
    "deathly-scream": executeDeathlyScream,
    "bone-burst": executeBoneBurst,
    "consume-thrall": executeConsumeThrall,
    "dead-weight": executeDeadWeight,
    "bone-spear": executeBoneSpear,
    "blood-infusion": executeBloodInfusion,
    "explode": executeNecroticBomb,
    "life-tap": executeLifeTap,
    "muscle-barrier": executeMuscleBarrier,
    "bony-barrage": executeBonyBarrage,
    "song-of-the-soul": executeSongOfTheSoul
};