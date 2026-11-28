    // ---- LL_VariableWindowMV / MV2 / MV3 (MV: avoid 4x full-screen Window bitmaps on Scene_Map) ----
    if (Utils.RPGMAKER_NAME === "MV" &&
        String((window.process && process.env && process.env.POCKETMZ_LLVAR_FIX) || "on").toLowerCase() !== "off" &&
        (hasPlugin("LL_VariableWindowMV") || hasPlugin("LL_VariableWindowMV2") || hasPlugin("LL_VariableWindowMV3")) &&
        window.Window_Base && Window_Base.prototype.initialize &&
        !Window_Base.prototype.initialize._pmzLlVarFix) {
        const _llWbInit = Window_Base.prototype.initialize;
        const wrappedLlWbInit = function(x, y, w, h) {
            if (this.constructor && this.constructor.name === "Window_ExVariableWindow" &&
                w === Graphics.boxWidth && h === Graphics.boxHeight && typeof this.fittingHeight === "function") {
                h = this.fittingHeight(1);
            }
            return _llWbInit.call(this, x, y, w, h);
        };
        wrappedLlWbInit._pmzLlVarFix = true;
        Window_Base.prototype.initialize = wrappedLlWbInit;
    }
