    // ---- Generic <input>/<textarea> IME bridge -> native gamepad Scene_Name ----
    if (String((window.process && process.env && process.env.POCKETMZ_GENERIC_IME) || "on").toLowerCase() !== "off" &&
        window.SceneManager && window.Scene_Name && window.$gameActors) {
        let pendingIme = null;
        if (!Scene_Name.prototype._pmzImeWrapped) {
            Scene_Name.prototype._pmzImeWrapped = true;
            const _snCreate = Scene_Name.prototype.create;
            Scene_Name.prototype.create = function() {
                if (!pendingIme) return _snCreate.apply(this, arguments);
                const dummyActor = {
                    actorId: () => 0, faceName: () => "", faceIndex: () => 0,
                    name: () => pendingIme.val, setName: s => { pendingIme.val = String(s || ""); }
                };
                const _gaActor = $gameActors.actor;
                $gameActors.actor = function(id) { return id === 0 ? dummyActor : _gaActor.apply(this, arguments); };
                try { return _snCreate.apply(this, arguments); }
                finally { $gameActors.actor = _gaActor; }
            };
            const _snOnOk = Scene_Name.prototype.onInputOk;
            Scene_Name.prototype.onInputOk = function() {
                if (!pendingIme) return _snOnOk.apply(this, arguments);
                const cur = pendingIme;
                pendingIme = null;
                const name = this._editWindow ? this._editWindow.name() : cur.val;
                cur.el.value = name;
                const dispatch = (type, extra) => {
                    if (typeof cur.el.dispatchEvent === "function") {
                        cur.el.dispatchEvent(Object.assign({ type, target: cur.el, currentTarget: cur.el }, extra));
                    }
                };
                dispatch("input", {});
                dispatch("change", {});
                dispatch("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13 });
                this.popScene();
                if (typeof cur.el.blur === "function") cur.el.blur();
            };
            const _snTerm = Scene_Name.prototype.terminate;
            Scene_Name.prototype.terminate = function() {
                if (pendingIme) {
                    const cur = pendingIme;
                    pendingIme = null;
                    if (typeof cur.el.blur === "function") cur.el.blur();
                }
                return _snTerm.apply(this, arguments);
            };
            if (window.Window_NameEdit && window.Window_NameInput) {
                const compact = () => !!pendingIme && window.Graphics && Graphics.boxHeight < 560;
                const WNE = Window_NameEdit.prototype;
                const _wneInit = WNE.initialize, _wneWh = WNE.windowHeight, _wneFw = WNE.faceWidth;
                const _wnePad = WNE.standardPadding, _wneLh = WNE.lineHeight, _wneIr = WNE.itemRect;
                WNE.windowHeight = function() { return compact() ? 64 : _wneWh.call(this); };
                WNE.faceWidth = function() { return compact() ? 0 : _wneFw.call(this); };
                WNE.standardPadding = function() { return compact() ? 10 : _wnePad.call(this); };
                WNE.lineHeight = function() { return compact() ? 28 : _wneLh.call(this); };
                WNE.initialize = function() {
                    const r = _wneInit.apply(this, arguments);
                    if (compact()) { this.y = 8; this.refresh(); }
                    return r;
                };
                WNE.itemRect = function(index) {
                    const r = _wneIr.call(this, index);
                    if (compact()) r.y = Math.max(0, Math.floor((this.contentsHeight() - r.height) / 2));
                    return r;
                };
                const WNI = Window_NameInput.prototype;
                const _wniInit = WNI.initialize, _wniPad = WNI.standardPadding;
                const _wniFs = WNI.standardFontSize, _wniLh = WNI.lineHeight;
                WNI.standardPadding = function() { return compact() ? 10 : _wniPad.call(this); };
                WNI.standardFontSize = function() { return compact() ? 20 : _wniFs.call(this); };
                WNI.lineHeight = function() { return compact() ? Math.max(24, Math.floor((Graphics.boxHeight - 104) / 9)) : _wniLh.call(this); };
                WNI.initialize = function(editWindow) {
                    const r = _wniInit.apply(this, arguments);
                    if (compact() && editWindow) {
                        this.y = editWindow.y + editWindow.height + 6;
                        this.refresh();
                        this.updateCursor();
                    }
                    return r;
                };
            }
        }
        window.__pmzOpenIme = function(el) {
            if (!el || !window.SceneManager || !window.Scene_Name || !window.$gameActors) return false;
            if (pendingIme || SceneManager._scene instanceof Scene_Name) return false;
            const initVal = String(el.value || "");
            const maxLen = el.maxLength > 0 ? Math.min(32, Math.max(1, Number(el.maxLength))) : 16;
            pendingIme = { el, val: initVal };
            SceneManager.push(Scene_Name);
            SceneManager.prepareNextScene(0, maxLen);
            return true;
        };
    }
