    // ---- PANDA_ResourcePreLoad (MZ; preloads the audio of every event) --------
    //   Its Game_Interpreter#loadImages calls AudioManager.preloadAudio for every BGM / BGS /
    //   ME / SE an event mentions, and preloadAudio keeps each WebAudio (decoded PCM) in
    //   AudioManager._audioBuffers forever; nothing plays from there (AudioManager makes its
    //   own buffer when it plays). After a few maps and battles 126 MB of decoded music
    //   stayed in memory and the game ran out of RAM within 5 minutes. Here music (bgm/ bgs/
    //   me/) is not preloaded (read from the local file when it plays), and a sound effect is
    //   decoded once and dropped again (PocketMZ_Handheld's SE cache keeps the PCM for the
    //   plays). POCKETMZ_PRELOAD_FIX=off keeps the plugin's own behaviour.
    if (hasPlugin("PANDA_ResourcePreLoad") && window.AudioManager && AudioManager.preloadAudio &&
        String((window.process && process.env && process.env.POCKETMZ_PRELOAD_FIX) || "on") !== "off") {
        AudioManager.preloadAudio = function(folder, name) {
            if (!name || folder !== "se/") return;
            const key = folder + name;
            const seen = this._audioBuffers || (this._audioBuffers = []);
            if (seen[key]) return;
            seen[key] = true;                                  // the plugin only checks for presence
            if (!window.PMZ_SE) return;                        // no SE cache: nothing to warm up
            const buffer = this.createBuffer(folder, name);
            buffer.addLoadListener(() => buffer.destroy());    // the cache keeps the decoded PCM
        };
    }
