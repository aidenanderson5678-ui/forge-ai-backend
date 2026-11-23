'use strict';

/**
 * Game-system categories Forge AI knows how to build. Each category carries
 * targeted engineering guidance that is injected into the system prompt only
 * when the category is requested or detected in the user's prompt.
 */
const CATEGORIES = [
  {
    id: 'simulator',
    label: 'Simulator system',
    summary: 'Click/collect core loop, upgrades, zones and persistent stats.',
    keywords: /\b(simulator|simulation|clicker|clicking|idle game|grind|tapper)\b/i,
    guidance:
      'Build a complete core loop on the server: a repeatable action (click, swing, collect) that grants the main currency scaled by server-side multipliers; upgrades that raise power or capacity; areas/zones unlocked by cost or rebirth; persistent stats. All gains are computed on the server with a per-player action cooldown; the client only requests the action. Put balance numbers (base gain, upgrade cost curves, zone costs) in a Config ModuleScript so the creator can tune them.',
  },
  {
    id: 'tycoon',
    label: 'Tycoon system',
    summary: 'Owned plots, droppers, conveyors, collectors and purchasable upgrades.',
    keywords: /\b(tycoon|dropper|conveyor|factory|plots?)\b/i,
    guidance:
      'Assign each player an owned plot, built procedurally in code (base, spawn, droppers, conveyor, collector, purchase buttons) so nothing has to be hand-built. Use a fixed number of plot slots laid out in a grid or circle and free the slot when the player leaves. Droppers spawn parts on a timer (cap live parts, clean up with Debris), conveyors move parts, and a collector converts parts into cash credited to the owner. Purchase buttons work only for the owner, deduct cost on the server, unlock items in dependency order, and the purchased item IDs are persisted and rebuilt on rejoin.',
  },
  {
    id: 'obby',
    label: 'Obby (obstacle course)',
    summary: 'Procedural stages, checkpoints, kill bricks and moving obstacles.',
    keywords: /\b(obby|obstacle|parkour|checkpoints?|stages?)\b/i,
    guidance:
      'Generate the course procedurally in code (stages of platforms, kill bricks, moving/rotating obstacles with TweenService, checkpoints, a finish pad), and also support parts the creator tags "Checkpoint" or "KillBrick" through CollectionService. Track each player\'s stage on the server (leaderstats "Stage"), set the player\'s RespawnLocation to the last checkpoint, debounce Touched per player, reward the finish, and save progress.',
  },
  {
    id: 'pets',
    label: 'Pet system',
    summary: 'Eggs, rarity-weighted hatching, inventory, equip and following pets.',
    keywords: /\b(pets?|eggs?|hatch(?:ing)?|companions?)\b/i,
    guidance:
      'Define pets in a Config ModuleScript (name, rarity, weight, multiplier, colour/shape). Egg hatching is decided on the server with weighted random selection after the cost is deducted; the client only requests a hatch. Keep a per-player inventory (max size) and equipped list (max equipped); equip, unequip and delete requests are validated on the server. The total pet multiplier feeds the currency system. Build pet models procedurally from simple Parts and make them follow the owner smoothly on the client; replicate equipped pets to other players with an Attribute or a folder. Persist the inventory.',
  },
  {
    id: 'shop',
    label: 'Shop',
    summary: 'Server-validated in-game shop plus gamepass / developer product handling.',
    keywords: /\b(shops?|stores?|purchas\w*|buy|game ?pass(?:es)?|developer products?|marketplace)\b/i,
    guidance:
      'Every purchase is validated and executed on the server. In-game shop: catalog in a Config ModuleScript (id, display name, price, effect); the purchase request checks the item exists, the player can afford it and does not already own a one-time item, then deducts currency and applies the effect. Real-money items: use MarketplaceService; implement ProcessReceipt idempotently (record the PurchaseId in saved data, grant, and return PurchaseGranted only once the grant is applied) and check gamepasses with UserOwnsGamePassAsync (cached per player). The client may only request PromptGamePassPurchase / PromptProductPurchase. Use obviously marked placeholder IDs (0) in Config and add a warning telling the creator to replace them.',
  },
  {
    id: 'currency',
    label: 'Coins and currencies',
    summary: 'Authoritative multi-currency service with leaderstats and persistence.',
    keywords: /\b(coins?|currenc(?:y|ies)|cash|gems?|money|gold|credits?)\b/i,
    guidance:
      'Create one authoritative CurrencyService: Get/Add/Spend/Set with validation (finite numbers, no negatives, clamped to a maximum), leaderstats values kept in sync, a callback/event for changes, and persistence. Support several currencies (for example Coins and Gems) through a table of definitions. Never let the client set a balance. Use the currency name from the settings if one is provided.',
  },
  {
    id: 'rebirth',
    label: 'Rebirth system',
    summary: 'Scaling-cost prestige reset with a permanent multiplier.',
    keywords: /\b(rebirths?|prestige|ascen\w+)\b/i,
    guidance:
      'Rebirth cost scales by a formula in Config (for example base * growth ^ rebirths). A server-validated rebirth request checks the cost, resets the configured stats (currency, upgrades) while keeping permanent progress, increments Rebirths, and applies a permanent multiplier that the currency system uses. The GUI shows a confirmation step. Persist rebirths.',
  },
  {
    id: 'leaderboard',
    label: 'Leaderboards',
    summary: 'leaderstats plus a throttled global OrderedDataStore board.',
    keywords: /\b(leaderboards?|leaderstats|rankings?|top players|scoreboard)\b/i,
    guidance:
      'Use leaderstats (a Folder named exactly "leaderstats" parented to the Player) for the in-server leaderboard. For a global all-time board use an OrderedDataStore with throttled writes (only on meaningful change, at most about once per minute per player) and a refresh loop of 60 seconds or slower that reads GetSortedAsync; show it on a SurfaceGui/Part created in code or in a GUI panel. Wrap every DataStore call in pcall with retries and handle failures without erroring.',
  },
  {
    id: 'combat',
    label: 'Combat system',
    summary: 'Server-authoritative attacks, cooldowns, hit validation and rewards.',
    keywords: /\b(combat|sword|weapons?|fight\w*|pvp|damage|melee|attack\w*|gun|shoot\w*|boss)\b/i,
    guidance:
      'The server is authoritative. The client sends only an intent (such as "attack" and an aim direction); the server enforces a per-player cooldown, checks the player is alive, validates range and line of sight with Raycast/OverlapParams, applies damage with Humanoid:TakeDamage using values from a Config module, and ignores any damage numbers sent by the client. Include kill tracking (attributes or tags for kill credit), kill rewards, respawn handling, simple knockback and per-player remote rate limiting. Create weapons in code (do not rely on pre-made Tools) or drive abilities from input in a LocalScript with ContextActionService/UserInputService.',
  },
  {
    id: 'gui',
    label: 'Custom GUIs',
    summary: 'Code-built, mobile-friendly interfaces driven by server data.',
    keywords: /\b(gui|ui|interface|menu|hud|buttons?|frames?|screen|inventory|panel)\b/i,
    guidance:
      'Build every interface entirely in code from a LocalScript in StarterPlayer/StarterPlayerScripts (create a ScreenGui with ResetOnSpawn = false under the PlayerGui). Use Scale-based sizing with UIAspectRatio/UISizeConstraint, UICorner, UIStroke and UIListLayout/UIGridLayout/UIPadding; touch-friendly buttons; TweenService for open/close and feedback; one theme table at the top of the script. Update from server data through RemoteEvents or replicated Values instead of polling, never keep authoritative state on the client, give every panel a clear close button, and support both mouse and touch.',
  },
  {
    id: 'general',
    label: 'General',
    summary: 'No specific system detected; Forge AI chooses suitable systems.',
    keywords: null,
    guidance:
      'No specific focus was detected. Choose the systems that best fit the request and apply all common rules above.',
  },
];

const CATEGORY_MAP = new Map(CATEGORIES.map((category) => [category.id, category]));
const CATEGORY_IDS = CATEGORIES.map((category) => category.id);

/** Returns the category ids whose keywords appear in the prompt (or ["general"]). */
function detectCategories(prompt) {
  const found = CATEGORIES.filter((category) => category.keywords && category.keywords.test(prompt)).map(
    (category) => category.id,
  );
  return found.length > 0 ? found : ['general'];
}

module.exports = { CATEGORIES, CATEGORY_MAP, CATEGORY_IDS, detectCategories };
