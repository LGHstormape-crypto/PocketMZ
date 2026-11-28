    // 25. Game_Interpreter.skipBranch jump table (avoid linear re-scan of long event lists)
    if (String((window.process && process.env && process.env.POCKETMZ_SKIPBRANCH_CACHE) || "on").toLowerCase() !== "off" &&
        window.Game_Interpreter && Game_Interpreter.prototype.skipBranch &&
        !Game_Interpreter.prototype.skipBranch._pmzCached) {
        const origSkip = Game_Interpreter.prototype.skipBranch;
        if (String(origSkip).includes("this._list[this._index + 1]")) {
            const branchCache = new WeakMap();
            const wrapped = function() {
                const list = this._list;
                if (!list || !list.length) return origSkip.call(this);
                let entry = branchCache.get(list);
                if (!entry || entry.len !== list.length) {
                    entry = { len: list.length, map: new Map() };
                    branchCache.set(list, entry);
                }
                const indent = this._indent | 0;
                const key = (this._index << 8) | (indent & 0xff);
                const cached = entry.map.get(key);
                if (cached !== undefined && cached >= this._index && cached < list.length &&
                    (cached + 1 >= list.length || list[cached + 1].indent <= indent)) {
                    this._index = cached;
                    return;
                }
                origSkip.call(this);
                entry.map.set(key, this._index);
            };
            wrapped._pmzCached = true;
            Game_Interpreter.prototype.skipBranch = wrapped;
        }
    }
