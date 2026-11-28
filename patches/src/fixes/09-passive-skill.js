    // ---- PassiveSkill (Game_Actor.enableSkills O(N^2) concat churn) ----------
    //   PassiveSkill.js:624 runs `this._enableSkills.reduce((r, id) => r.concat([$dataSkills[id]]), [])`
    //   on every Game_Actor.traitObjects() call. Cache the resolved array between refreshes.
    if (hasPlugin("PassiveSkill") && window.Game_Actor && Game_Actor.prototype.enableSkills) {
        const origEnableSkills = Game_Actor.prototype.enableSkills;
        Game_Actor.prototype.enableSkills = function() {
            if (!this._enableSkills || this._passiveRefresh || this._pmzSkillIds !== this._enableSkills) {
                const rebuilt = origEnableSkills.call(this);
                this._pmzSkillIds = this._enableSkills;
                this._pmzSkillObjs = rebuilt;
                return rebuilt;
            }
            return this._pmzSkillObjs.slice();
        };
    }
