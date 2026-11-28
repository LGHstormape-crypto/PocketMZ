    // ---- PhantomEvent (per-frame party trait scan for every phantom event) ---
    //   Map events with <VisibleDistance> call $gameParty.findVisibleDistanceRate()
    //   for every event on every frame, re-scanning actor.traitObjects() + meta tags.
    if (hasPlugin("PhantomEvent") && window.Game_Party && Game_Party.prototype.findVisibleDistanceRate) {
        const origFindVdr = Game_Party.prototype.findVisibleDistanceRate;
        Game_Party.prototype.findVisibleDistanceRate = function() {
            const fc = window.Graphics ? Graphics.frameCount : -1;
            if (fc >= 0 && this._pmzVdrFrame === fc) return this._pmzVdrVal;
            const v = origFindVdr.call(this);
            this._pmzVdrFrame = fc;
            this._pmzVdrVal = v;
            return v;
        };
    }
