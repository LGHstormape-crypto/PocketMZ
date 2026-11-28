    // ---- FTKR_ExMessageWindow2 (MV: skip closed-idle Window_MessageEx updates) ----
    if (Utils.RPGMAKER_NAME === "MV" &&
        String((window.process && process.env && process.env.POCKETMZ_FTKR_MSG_FIX) || "on").toLowerCase() !== "off" &&
        hasPlugin("FTKR_ExMessageWindow2") &&
        window.Window_MessageEx && Window_MessageEx.prototype.update &&
        !Window_MessageEx.prototype.update._pmzFtkrSkip) {
        const _wmExUpdate = Window_MessageEx.prototype.update;
        const wrappedWmExUpdate = function() {
            if (this.openness === 0 && !this._opening && !this._closing &&
                !this._textState && !this._waitCount &&
                this._gameMessage && !this._gameMessage.isBusy()) {
                return;
            }
            return _wmExUpdate.apply(this, arguments);
        };
        wrappedWmExUpdate._pmzFtkrSkip = true;
        Window_MessageEx.prototype.update = wrappedWmExUpdate;
    }
