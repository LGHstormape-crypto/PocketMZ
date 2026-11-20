// Dev (test sessions only - replaces WindowLayer.prototype.render for PMZ_PROFILE_MS ms):
// splits MZ's WindowLayer.render (same steps as rmmz_core) into window drawing, the stencil
// shape (PIXI.Graphics clear/drawShape/render) and batch flushes. Result: ms per frame.
new Promise((resolve) => {
    const ms = window.PMZ_PROFILE_MS || 5000;
    const now = () => performance.now();
    const P = WindowLayer.prototype, orig = P.render;
    let frames = 0, tAll = 0, tWin = 0, tShape = 0, tFlush = 0, nWin = 0;
    P.render = function render(renderer) {
        if (!this.visible) return;
        const a0 = now(); frames++;
        const graphics = new PIXI.Graphics();
        const gl = renderer.gl;
        const children = this.children.clone();
        renderer.framebuffer.forceStencil();
        graphics.transform = this.transform;
        let a = now(); renderer.batch.flush(); tFlush += now() - a;
        gl.enable(gl.STENCIL_TEST);
        while (children.length > 0) {
            const win = children.pop();
            if (win._isWindow && win.visible && win.openness > 0) {
                nWin++;
                gl.stencilFunc(gl.EQUAL, 0, ~0);
                gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
                a = now(); win.render(renderer); tWin += now() - a;
                a = now(); renderer.batch.flush(); tFlush += now() - a;
                a = now();
                graphics.clear();
                win.drawShape(graphics);
                gl.stencilFunc(gl.ALWAYS, 1, ~0);
                gl.stencilOp(gl.REPLACE, gl.REPLACE, gl.REPLACE);
                gl.blendFunc(gl.ZERO, gl.ONE);
                graphics.render(renderer);
                tShape += now() - a;
                a = now(); renderer.batch.flush(); tFlush += now() - a;
                gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            }
        }
        gl.disable(gl.STENCIL_TEST);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.clearStencil(0);
        a = now(); renderer.batch.flush(); tFlush += now() - a;
        for (const child of this.children) {
            if (!child._isWindow && child.visible) {
                a = now(); child.render(renderer); tWin += now() - a;
            }
        }
        a = now(); renderer.batch.flush(); tFlush += now() - a;
        tAll += now() - a0;
    };
    setTimeout(() => {
        P.render = orig;
        const f = Math.max(frames, 1);
        resolve("WindowLayer.render per frame " + (tAll / f).toFixed(2) + "ms, open windows " + (nWin / f).toFixed(1) +
            ": windows " + (tWin / f).toFixed(2) + " | stencil shapes " + (tShape / f).toFixed(2) + " | flushes " + (tFlush / f).toFixed(2));
    }, ms);
});
