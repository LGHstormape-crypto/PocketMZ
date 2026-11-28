/*:
 * @target MZ
 * @plugindesc PocketMZ handheld fixes for RPG Maker MZ (load last).
 * @author PocketMZ (MIT)
 *
 * @help
 * Loaded after all other plugins. Does not modify other plugin files.
 * 1. Window: never resize the window (keeps the Wayland window fullscreen).
 * 2. Input: the pad is read by gptokeyb as keys; the browser Gamepad API is ignored.
 * 3. Preload: back to the stock MZ preload (faces/pictures in the first 200
 *    commands). PANDA_ResourcePreLoad loaded every resource of a whole event
 *    and Scene_Map waits for all of them -> endless spinner + out of memory.
 * 4. Image cache budget: MZ never drops cached images while playing. On every
 *    scene change the least recently used images beyond the budget are
 *    dropped from the cache (not destroyed: anything still holding one keeps
 *    a working bitmap; GC and PIXI's texture GC free the rest).
 *    A full GC follows (window.gc, --expose-gc) so the dropped images' decoded pixels
 *    are really freed; the budget is also checked every 60 s inside one scene.
 * 5. PIXI texture GC runs sooner (GPU memory is system RAM on this device).
 * 6. ColorFilter (tone / flash / fade) is skipped while it is neutral. MZ keeps
 *    three of them on screen; each one is a full-screen offscreen pass per frame.
 * 7. Audio: the AudioContext runs at 24 kHz. decodeAudioData() decodes to the
 *    context rate, so every decoded BGM/BGS/SE takes half the memory (a 160 s
 *    stereo BGM: 59 MB -> 29 MB) and half the decode time.
 *    Set AUDIO_SAMPLE_RATE to 0 for the browser default (48 kHz).
 * 8. Frame rate option (Options menu, "画面フレームレート" 30/60, default 30):
 *    game logic always runs 60 times a second, at 30 only every second frame
 *    is drawn. Most of the cost on this device is per drawn frame (Chromium
 *    compositing + ~800 display objects), so 30 saves ~1/3 of the CPU and
 *    gives steady pacing instead of 45-50 fps with jitter.
 * 9. Off-screen character sprites are not drawn and their animation is refreshed
 *    every 15th frame only (game logic is untouched).
 * 10. Menu/battle background snapshots are taken at half size (1/4 GPU read-back).
 * 11. Blurred snapshot backgrounds are blurred once on the CPU instead of a
 *    BlurFilter running every frame.
 * 12. The renderer draws at screen size (resolution = display scale): a 1280x720
 *    game fills 640x360 pixels instead of 1280x720; filters (map tone etc.) follow it.
 *    POCKETMZ_RENDER_SCALE=off disables.
 * 13. Gauges / names / state icons of hidden or closed status windows (e.g. the
 *    hidden Window_BattleActor in battle) are not updated; they catch up when shown.
 * 14-16. Windows: contents clipped by scissor instead of an AlphaFilter pass, toned
 *    backgrounds drawn from a cached texture, stencil shapes written by scissored clears.
 */

(() => {
    "use strict";
    // Written against RPG Maker MZ 1.x internals; MV games get PocketMZ_HandheldMV.js instead.
    if (!window.Utils || Utils.RPGMAKER_NAME !== "MZ") return;

    if (window.process && process.env && process.env.POCKETMZ_COMPAT_MODE === "1") {
        for (const k of [
            "POCKETMZ_MAP_REFRESH_GUARD", "POCKETMZ_CLOSED_WIN_SKIP", "POCKETMZ_EMPTY_CHAR_SKIP",
            "POCKETMZ_EMPTY_PIC_SKIP", "POCKETMZ_TONEFILTER_FIX", "POCKETMZ_WIN_SCALE",
            "POCKETMZ_TILE_ATLAS", "POCKETMZ_SKIPBRANCH_CACHE"
        ]) {
            if (!process.env[k]) process.env[k] = "off";
        }
    }

    const IMAGE_BUDGET_PX = 16 * 1024 * 1024; // ~64 MB of RGBA (protected map images not counted out)
    const TEXTURE_GC_MAX_IDLE = 900;          // frames (~15 s), PIXI default 3600
    const AUDIO_SAMPLE_RATE = 24000;          // 0 = browser default

    // 1. Window
    Scene_Boot.prototype.adjustWindow = function() {};
