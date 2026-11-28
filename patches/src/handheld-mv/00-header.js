/*:
 * @target MV
 * @plugindesc PocketMZ handheld (RPG Maker MV): gamepad via gptokeyb, light audio, 30/60 fps option, off-screen sprites (load last).
 * @author PocketMZ (MIT)
 *
 * @help
 * MV counterpart of PocketMZ_Handheld.js (that one is MZ only). Written against the MV 1.6 core
 * scripts (rpgtkoolmv/corescript); every part checks that what it changes exists.
 * - Gamepad: gptokeyb turns the pad into keys; the browser Gamepad API is ignored (no double input).
 * - Audio: AudioContext at 24 kHz, "playback" latency (less CPU and decoded-PCM memory).
 * - Options: frame rate 30 / 60 (default 30). At 30 only every other frame is drawn; game logic
 *   stays at 60, so the game runs at full speed.
 * - Off-screen event sprites are not drawn; their animation is updated every 15th frame.
 * MV's own image cache (ImageCache.limit, 10 Mpx) and texture GC are kept as they are.
 */
(() => {
    "use strict";
    if (!window.Utils || Utils.RPGMAKER_NAME !== "MV") return;

    if (window.process && process.env && process.env.POCKETMZ_COMPAT_MODE === "1") {
        for (const k of [
            "POCKETMZ_MAP_REFRESH_GUARD", "POCKETMZ_CLOSED_WIN_SKIP", "POCKETMZ_EMPTY_CHAR_SKIP",
            "POCKETMZ_EMPTY_PIC_SKIP", "POCKETMZ_TONEFILTER_FIX", "POCKETMZ_WIN_SCALE",
            "POCKETMZ_TILE_ATLAS", "POCKETMZ_SKIPBRANCH_CACHE"
        ]) {
            if (!process.env[k]) process.env[k] = "off";
        }
    }

    const AUDIO_SAMPLE_RATE = 24000;

    // 0. No page scrollbars (elements sized for a PC window can overflow the 640x480 screen)
