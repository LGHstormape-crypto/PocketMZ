    // 20. The current map's JSON text kept. Scene_Map#create loads the map file again every time
    //     the map scene comes back (after the menu, a battle, a shop): a 2 MB map with 137 events
    //     took 250-540 ms to read in an MV game (1.5 s cold) before parsing. The text of the last
    //     loaded map stays in memory, and loading the same map again parses that text and runs
    //     the engine's own onLoad (plugins' load hooks included), like a fresh load without the
    //     file read. POCKETMZ_MAP_CACHE=off disables it.
    if (window.DataManager && DataManager.loadDataFile && DataManager.onLoad &&
        String((window.process && process.env && process.env.POCKETMZ_MAP_CACHE) || "on") !== "off") {
        const MAP_TEXT = window.PMZ_MAP_TEXT = { src: "", text: "", hits: 0 };
        const _loadDataFile = DataManager.loadDataFile;
        DataManager.loadDataFile = function(name, src) {
            if (name !== "$dataMap") return _loadDataFile.apply(this, arguments);
            if (MAP_TEXT.src === src && MAP_TEXT.text) {
                const text = MAP_TEXT.text;
                window[name] = null;
                MAP_TEXT.hits++;
                setTimeout(() => {            // asynchronous like the file load
                    let data;
                    try { data = JSON.parse(text); } catch (e) {
                        // not plain JSON (a data plugin transforms it): load normally from now on
                        MAP_TEXT.src = ""; MAP_TEXT.text = ""; MAP_TEXT.off = true;
                        return _loadDataFile.call(DataManager, name, src);
                    }
                    window[name] = data;
                    DataManager.onLoad(window[name]);
                }, 0);
                return;
            }
            // read through the engine; keep the text the request returns
            const _send = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function() {
                this.addEventListener("load", () => {
                    if (this.status < 400 && !MAP_TEXT.off && typeof this.responseText === "string") { MAP_TEXT.src = src; MAP_TEXT.text = this.responseText; }
                });
                return _send.apply(this, arguments);
            };
            try { return _loadDataFile.apply(this, arguments); } finally { XMLHttpRequest.prototype.send = _send; }
        };
    }
