    // ---- FilterSelectableItems (game data bug, same on PC) --------------------
    //   "SetSelectableItems" restricts the Select Item window to a list of item IDs.
    //   2 of its 71 uses in this game have an empty list (e.g. map 118 EV002, the
    //   persuasion that then checks for item 502), which leaves the window empty and
    //   the player stuck with "cancel". An empty list now means "no restriction".
    if (hasPlugin("FilterSelectableItems")) {
        const key = "FilterSelectableItems:SetSelectableItems";
        const orig = PluginManager._commands && PluginManager._commands[key];
        if (orig) {
            PluginManager._commands[key] = function(args) {
                let ids = [];
                try { ids = JSON.parse(args.itemIds || "[]"); } catch (e) {}
                if (!Array.isArray(ids) || ids.length === 0) {
                    return PluginManager.callCommand(this, "FilterSelectableItems", "ClearSelectableItems", {});
                }
                return orig.apply(this, arguments);
            };
        }
    }
