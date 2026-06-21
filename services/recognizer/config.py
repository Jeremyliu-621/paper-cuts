"""
RECOGNIZER — freeform doodle classifier contract (single source of truth).

The third engine: a kid draws ANYTHING, this maps the strokes -> a game label, so the menu
disappears. The label then drives CAELLUM (sprite, conditioned on label) and CHLOE (mechanic graph,
conditioned on the label/archetype). A tiny CNN over a 28x28 raster of the drawing — trainable on
Trainium (the workshop's "PyTorch on Trainium"; a plain CNN, NO LoRA, so NO consolidation pain) and
instant to serve on CPU.

CATEGORIES maps a Google QuickDraw class -> {label, archetype, element?}. We train on whatever
classes actually download (some QuickDraw names 404 -> the downloader skips them and the trained
class list is saved to classes.json), and at serve time the predicted class -> this mapping.

KEEP the archetypes in sync with js/mechanics.js / services/chloe; elements with js/graph.js.
"""

IMG_SIZE = 28            # QuickDraw numpy_bitmap is 28x28 grayscale; the game rasterizes strokes to this
PORT = 8600
RECOGNIZE_ENDPOINT = "/recognize"
HEALTH_ENDPOINT = "/healthz"
CONF_THRESHOLD = 0.40   # top-1 below this -> "unsure" (game falls back to a pick / top-3 chooser)

# quickdraw class -> game meaning. label feeds CAELLUM+CHLOE; archetype seeds the default mechanic;
# element (optional) seeds the graph's tags so interactions (fire+water=fizzle) light up from a drawing.
CATEGORIES = {
    # melee --------------------------------------------------------------------------------
    "sword":        {"label": "sword",  "archetype": "melee_weapon"},
    "knife":        {"label": "knife",  "archetype": "melee_weapon"},
    "hammer":       {"label": "hammer", "archetype": "melee_weapon"},
    "axe":          {"label": "axe",    "archetype": "melee_weapon"},
    "baseball bat": {"label": "bat",    "archetype": "melee_weapon"},
    # thrown -------------------------------------------------------------------------------
    "boomerang":    {"label": "boomerang", "archetype": "throwable"},
    "anvil":        {"label": "anvil",  "archetype": "throwable", "element": "metal"},
    # heal ---------------------------------------------------------------------------------
    "apple":        {"label": "fruit",  "archetype": "heal"},
    "banana":       {"label": "fruit",  "archetype": "heal"},
    "bread":        {"label": "bread",  "archetype": "heal"},
    "birthday cake": {"label": "cake",  "archetype": "heal"},
    "pizza":        {"label": "food",   "archetype": "heal"},
    "hot dog":      {"label": "food",   "archetype": "heal"},
    # buff ---------------------------------------------------------------------------------
    "star":         {"label": "star",   "archetype": "buff"},
    "crown":        {"label": "crown",  "archetype": "buff"},
    "diamond":      {"label": "gem",    "archetype": "buff"},
    "key":          {"label": "key",    "archetype": "buff"},
    # hazards + elements -------------------------------------------------------------------
    "campfire":     {"label": "fire",   "archetype": "hazard", "element": "fire"},
    "lightning":    {"label": "lightning", "archetype": "hazard", "element": "electric"},
    "snowflake":    {"label": "ice",    "archetype": "hazard", "element": "ice"},
    "skull":        {"label": "skull",  "archetype": "hazard", "element": "dark"},
    # environment / props ------------------------------------------------------------------
    "cloud":        {"label": "cloud",  "archetype": "platform"},
    "mushroom":     {"label": "mushroom", "archetype": "bouncy"},
    "tree":         {"label": "tree",   "archetype": "prop", "element": "plant"},
    "umbrella":     {"label": "umbrella", "archetype": "prop"},
}


def game_for(category: str) -> dict:
    """Predicted quickdraw class -> {label, archetype, element?}. Unknown -> a safe generic prop."""
    return CATEGORIES.get(category, {"label": category or "thing", "archetype": "throwable"})


def quickdraw_classes() -> list:
    """All candidate quickdraw class names (the downloader fetches these, skipping any that 404)."""
    return list(CATEGORIES.keys())
