    // ---- CharacterPictureManager (triacontane, stand pictures) -----------------
    //   Every frame, for every picture layer of every shown actor, the plugin copies and
    //   reverses the layer's file list and tests each file with 10 new closures, one of
    //   them eval(file.Script), until one matches. A game with 1179 files / 1140 scripts
    //   (a battle-heavy MZ game) spent ~13 of ~29 ms per battle frame there, mostly in a.hpRate(): its mhp
    //   runs through every trait/passive-skill plugin (~35 us each) and was asked up to twice
    //   per file. Same tests here, same order and short-circuiting, the HP rate computed once
    //   per scan (it cannot change during it), no copies/closures, each script compiled
    //   once. Scripts that are not a plain expression (statements, strings, comments
    //   inside) and scripts that need the plugin's own scope still go through the plugin.
    //   Only applied when the plugin's code is the version this was written against.
    if (hasPlugin("CharacterPictureManager") && Scene_Base.prototype.updateStandPicture) {
        const EXPECT = ["!file.HpUpperLimit || file.HpUpperLimit >= a.hpRate() * 100",
            "!file.HpLowerLimit || file.HpLowerLimit <= a.hpRate() * 100", "!file.Damage || a.isDamage()",
            "!file.Action || a.isAction()", "!file.State || a.isStateAffected(file.State)",
            "!file.Weapon || a.hasWeapon($dataWeapons[file.Weapon])", "!file.Armor || a.hasArmor($dataArmors[file.Armor])",
            "!file.Note || this.findStandPictureMeta() === file.Note", "!file.Switch || $gameSwitches.value(file.Switch)",
            "!file.Script || eval(file.Script)"];
        const compile = src => {
            let s = String(src);
            if (/['"`\\]|\/\*/.test(s)) return null;          // strings / escapes / block comments
            const c = s.indexOf("//");
            if (c >= 0) s = s.slice(0, c);                     // trailing line comment
            s = s.trim().replace(/;+\s*$/, "").trim();
            if (!s || s[0] === "{" || /[;\n]/.test(s)) return null; // one expression only
            try { return new Function("a", "file", "picture", "return (" + s + ");"); } catch (e) { return null; }
        };
        const patch = P => {
            if (!P || typeof P.setFileNameIfValid !== "function" || typeof P.updatePictureFiles !== "function") return;
            const srcSet = String(P.setFileNameIfValid), srcUpd = String(P.updatePictureFiles);
            let at = 0;
            for (const e of EXPECT) { const i = srcSet.indexOf(e, at); if (i < 0) return; at = i + e.length; }
            if (!srcUpd.includes("picture.FileList.clone().reverse().some(file => this.setFileNameIfValid(file, picture))")) return;
            const origSet = P.setFileNameIfValid, origUpd = P.updatePictureFiles;
            const scripts = new Map();                         // script text -> function | null (use plugin)
            P.setFileNameIfValid = function(file, picture) {
                let fn = null;
                if (file.Script) {
                    fn = scripts.get(file.Script);
                    if (fn === undefined) { fn = compile(file.Script); scripts.set(file.Script, fn); }
                    if (fn === null) return origSet.call(this, file, picture);
                }
                picture.FileName = null;
                const a = this._actor;
                // a.hpRate() is the expensive part (mhp goes through every trait/passive plugin:
                // ~35 us on RK3566 in that game); it cannot change during one scan of the lists
                const hpr = () => this._gkdHpScan ? (this._gkdHp === undefined ? (this._gkdHp = a.hpRate() * 100) : this._gkdHp) : a.hpRate() * 100;
                if ((!file.HpUpperLimit || file.HpUpperLimit >= hpr()) &&
                    (!file.HpLowerLimit || file.HpLowerLimit <= hpr()) &&
                    (!file.Damage || a.isDamage()) &&
                    (!file.Action || a.isAction()) &&
                    (!file.State || a.isStateAffected(file.State)) &&
                    (!file.Weapon || a.hasWeapon($dataWeapons[file.Weapon])) &&
                    (!file.Armor || a.hasArmor($dataArmors[file.Armor])) &&
                    (!file.Note || this.findStandPictureMeta() === file.Note) &&
                    (!file.Switch || $gameSwitches.value(file.Switch))) {
                    if (fn) {
                        let ok;
                        try { ok = fn.call(this, a, file, picture); } catch (e) {
                            if (!(e instanceof ReferenceError)) throw e;
                            scripts.set(file.Script, null);    // needs the plugin's scope
                            return origSet.call(this, file, picture);
                        }
                        if (!ok) return false;
                    }
                    picture.FileName = file.FileName;
                    return true;
                }
                return false;
            };
            // Memo: when every file of an actor only tests HP limits, states and scripts made of
            // a.isStateAffected(n) / a.tpRate() / a.hpRate() and operators, the chosen files depend
            // on (HP rate, TP rate, states) only: if those did not change, the last result is reused.
            const memoOk = new WeakMap();
            const plainScript = src => /^[\s()0-9.<>=!&|+\-*\/;]*$/.test(String(src).replace(/\/\/[^\n]*/g, "")
                .replace(/a\.isStateAffected\(\d+\)|a\.tpRate\(\)|a\.hpRate\(\)/g, ""));
            const canMemo = pics => {
                let ok = memoOk.get(pics);
                if (ok === undefined) {
                    ok = pics.every(pic => !pic.DynamicFileName && (pic.FileList || []).every(f =>
                        !f.Damage && !f.Action && !f.Weapon && !f.Armor && !f.Note && !f.Switch &&
                        (!f.Script || (plainScript(f.Script) && compile(f.Script)))));
                    memoOk.set(pics, ok);
                }
                return ok;
            };
            P.updatePictureFiles = function() {
                const pics = this._standPictures;
                let key = null;
                this._gkdHp = undefined;
                if (canMemo(pics)) {
                    const a = this._actor;
                    this._gkdHp = a.hpRate() * 100;
                    key = this._gkdHp + "|" + a.tpRate() + "|" + a._states.join(",");
                    if (key === this._gkdKey) {
                        pics.forEach((pic, i) => { if (pic.FileList && pic.FileList.length) pic.FileName = this._gkdNames[i]; });
                        return pics;
                    }
                }
                this._gkdHpScan = true;
                try { this._standPictures.forEach(picture => {
                    if (!picture.FileList) return;
                    const list = picture.FileList;
                    for (let i = list.length - 1; i >= 0; i--) {
                        if (this.setFileNameIfValid(list[i], picture)) break;
                    }
                    if (!picture.FileName && picture.DynamicFileName) {
                        picture.FileName = this.createDynamicFileName(picture.DynamicFileName);
                    }
                }); } finally { this._gkdHpScan = false; }
                if (key !== null) { this._gkdKey = key; this._gkdNames = pics.map(pic => pic.FileName); }
                return this._standPictures;
            };
            window.PMZ_FIX = Object.assign(window.PMZ_FIX || {}, {
                cpmProto: P, cpmSetOrig: origSet, cpmUpdOrig: origUpd,
                cpmSetFast: P.setFileNameIfValid, cpmUpdFast: P.updatePictureFiles, cpmScripts: scripts, cpmCanMemo: canMemo });
        };
        let tried = false;
        const _updateStandPicture = Scene_Base.prototype.updateStandPicture;
        Scene_Base.prototype.updateStandPicture = function(actor) {
            _updateStandPicture.apply(this, arguments);
            if (!tried && this._standSprites && actor) {
                const s = this._standSprites.get(actor.actorId());
                if (s && s._pictures) { tried = true; patch(Object.getPrototypeOf(s._pictures)); }
            }
        };
    }
