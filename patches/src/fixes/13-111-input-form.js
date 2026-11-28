    // ---- 111_InputForm (MV on β: bridge HTML <input> form to native gamepad Scene_Name) ----
    if (Utils.RPGMAKER_NAME === "MV" &&
        String((window.process && process.env && process.env.POCKETMZ_INPUTFORM_FIX) || "on").toLowerCase() !== "off" &&
        hasPlugin("111_InputForm") &&
        typeof document !== "undefined" && !("selectionStart" in document.createElement("input")) &&
        window.Game_Interpreter && Game_Interpreter.prototype.pluginCommand &&
        window.Scene_Name && !Game_Interpreter.prototype.pluginCommand._pmzIfBridge) {
        const ifParam = PluginManager.parameters("111_InputForm") || {};
        const okSw = Number(ifParam["Switch ID Selected OK"] || 0);
        const resolveVarId = tok => {
            const s = String(tok || "").trim();
            const m = /^(V?)([0-9]+)$/i.exec(s);
            if (m) return m[1] ? $gameVariables.value(+m[2]) : +m[2];
            const vars = window.$dataSystem && $dataSystem.variables;
            if (vars) {
                for (let i = 1; i < vars.length; i++) if (vars[i] === s) return i;
            }
            return 0;
        };
        const parseIfArgs = raw => {
            const out = {};
            for (const part of String(raw || "").split(";")) {
                const m = /^(\w+)=(\S*)$/i.exec(part.trim());
                if (!m) continue;
                const k = m[1].toLowerCase(), v = m[2];
                if (k === "v" || k === "init_v") out[k] = resolveVarId(v);
                else if (k === "init") out[k] = v;
                else out[k] = Number(v);
            }
            return out;
        };
        let pendingIf = null;
        const _origPluginCmd = Game_Interpreter.prototype.pluginCommand;
        const wrappedPluginCmd = function(command, args) {
            if (command !== "InputForm") return _origPluginCmd.apply(this, arguments);
            const p = parseIfArgs(args && args[0]);
            const varId = p.v || 0;
            const actorId = p.n || 0;
            const maxLen = Math.max(1, Number(p.max) || 8);
            let initStr = "";
            if (p.init !== undefined) initStr = String(p.init);
            else if (p.init_n && $gameActors.actor(p.init_n)) initStr = $gameActors.actor(p.init_n).name();
            else if (actorId && $gameActors.actor(actorId)) initStr = $gameActors.actor(actorId).name();
            else if (p.init_v) {
                const vv = $gameVariables.value(p.init_v);
                if (typeof vv === "string") initStr = vv;
            } else if (varId) {
                const vv = $gameVariables.value(varId);
                if (typeof vv === "string") initStr = vv;
            }
            const actor = actorId > 0 ? $gameActors.actor(actorId) : null;
            if (actor) {
                const origName = actor.name();
                if (initStr !== origName && (p.init !== undefined || p.init_n || p.init_v)) actor.setName(initStr);
                pendingIf = { actorId, varId, okSw, origName, varOnly: false, val: initStr };
                SceneManager.push(Scene_Name);
                SceneManager.prepareNextScene(actorId, maxLen);
            } else {
                pendingIf = { actorId: 0, varId, okSw, origName: initStr, varOnly: true, val: initStr };
                SceneManager.push(Scene_Name);
                SceneManager.prepareNextScene(0, maxLen);
            }
        };
        wrappedPluginCmd._pmzIfBridge = true;
        Game_Interpreter.prototype.pluginCommand = wrappedPluginCmd;

        const _snCreate = Scene_Name.prototype.create;
        Scene_Name.prototype.create = function() {
            if (!pendingIf || !pendingIf.varOnly) return _snCreate.apply(this, arguments);
            const dummyActor = {
                actorId: () => 0, faceName: () => "", faceIndex: () => 0,
                name: () => pendingIf.val, setName: s => { pendingIf.val = s; }
            };
            const _gaActor = $gameActors.actor;
            $gameActors.actor = function(id) { return id === 0 ? dummyActor : _gaActor.apply(this, arguments); };
            try { return _snCreate.apply(this, arguments); }
            finally { $gameActors.actor = _gaActor; }
        };

        const _snOnOk = Scene_Name.prototype.onInputOk;
        Scene_Name.prototype.onInputOk = function() {
            if (!pendingIf) return _snOnOk.apply(this, arguments);
            const cur = pendingIf;
            pendingIf = null;
            const name = this._editWindow ? this._editWindow.name() : cur.val;
            if (cur.varOnly) {
                if (cur.varId > 0) $gameVariables.setValue(cur.varId, name);
                if (cur.okSw > 0) $gameSwitches.setValue(cur.okSw, true);
                this.popScene();
                return;
            }
            const r = _snOnOk.apply(this, arguments);
            if (cur.varId > 0) $gameVariables.setValue(cur.varId, name);
            if (cur.okSw > 0) $gameSwitches.setValue(cur.okSw, true);
            return r;
        };

        const _snTerm = Scene_Name.prototype.terminate;
        Scene_Name.prototype.terminate = function() {
            if (pendingIf) {
                const cur = pendingIf;
                pendingIf = null;
                if (!cur.varOnly && cur.actorId > 0 && $gameActors.actor(cur.actorId)) {
                    $gameActors.actor(cur.actorId).setName(cur.origName);
                }
                if (cur.okSw > 0) $gameSwitches.setValue(cur.okSw, false);
            }
            return _snTerm.apply(this, arguments);
        };

        // Compact Scene_Name layout on short screens (e.g. 745x400) so all 9 rows + edit box fit
        if (window.Window_NameEdit && window.Window_NameInput) {
            const WNE = Window_NameEdit.prototype;
            const _wneInit = WNE.initialize, _wneWh = WNE.windowHeight, _wneFw = WNE.faceWidth;
            const _wnePad = WNE.standardPadding, _wneLh = WNE.lineHeight, _wneIr = WNE.itemRect;
            const compact = () => !!pendingIf && Graphics.boxHeight < 560;
            WNE.windowHeight = function() { return compact() ? 64 : _wneWh.call(this); };
            WNE.faceWidth = function() { return compact() ? 0 : _wneFw.call(this); };
            WNE.standardPadding = function() { return compact() ? 10 : _wnePad.call(this); };
            WNE.lineHeight = function() { return compact() ? 28 : _wneLh.call(this); };
            WNE.initialize = function(actor, maxLength) {
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
