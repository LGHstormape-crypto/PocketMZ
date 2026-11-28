    // ---- PluginCommonBase (per-frame getter regex churn) -----------------------
    //   PluginParam accessors call PluginManagerEx.convertVariables() on every read
    //   (e.g. ApngPicture Sprite.update reading param.FrameCount, PhantomEvent reading
    //   meta values), running 15+ RegExp passes even on static strings without escapes.
    if (hasPlugin("PluginCommonBase") && window.PluginManagerEx && PluginManagerEx.convertVariables &&
        String((window.process && process.env && process.env.POCKETMZ_PCB_FIX) || "on") !== "off") {
        const staticCache = new Map();
        const origConvertVariables = PluginManagerEx.convertVariables;
        PluginManagerEx.convertVariables = function(text, data = null) {
            if (typeof text !== "string") return text;
            if (text.indexOf("\\") < 0 && text.indexOf("\x1b") < 0) {
                if (staticCache.has(text)) return staticCache.get(text);
                if (staticCache.size >= 4096) staticCache.clear();
                let val;
                if (text === "true") val = true;
                else if (text === "false") val = false;
                else {
                    const pf = parseFloat(text);
                    val = (Number(text) === pf) ? pf : text;
                }
                staticCache.set(text, val);
                return val;
            }
            return origConvertVariables.call(this, text, data);
        };

        if (PluginManagerEx.findMetaValue) {
            const origFindMetaValue = PluginManagerEx.findMetaValue;
            PluginManagerEx.findMetaValue = function(object, nameList) {
                const meta = object && object.meta;
                if (!meta) return origFindMetaValue.call(this, object, nameList);
                if (Array.isArray(nameList)) {
                    for (let i = 0; i < nameList.length; i++) {
                        const k = nameList[i];
                        if (Object.prototype.hasOwnProperty.call(meta, k)) {
                            const raw = meta[k];
                            if (typeof raw !== "string" || (raw.indexOf("\\") < 0 && raw.indexOf("\x1b") < 0)) {
                                return this.convertVariables(raw, object);
                            }
                            return origFindMetaValue.call(this, object, nameList);
                        }
                    }
                    return undefined;
                }
                if (Object.prototype.hasOwnProperty.call(meta, nameList)) {
                    const raw = meta[nameList];
                    if (typeof raw !== "string" || (raw.indexOf("\\") < 0 && raw.indexOf("\x1b") < 0)) {
                        return this.convertVariables(raw, object);
                    }
                    return origFindMetaValue.call(this, object, nameList);
                }
                return undefined;
            };
        }
    }
