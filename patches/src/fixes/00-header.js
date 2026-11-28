/*:
 * @target MZ
 * @plugindesc PocketMZ: speed fixes for specific third-party plugins (load last).
 * @author PocketMZ (MIT)
 *
 * @help
 * Each fix only applies when its plugin is present and its parameters are plain values;
 * otherwise the plugin's own code is used unchanged. Plugin files are not modified.
 *
 * ARTM_PlayerSensorMZ (enemy sight, <PsensorF:...> etc.)
 *   Every sensing event rebuilds its view area every frame and calls
 *   isMapPassableEx() for each tile (~400 calls per frame on a map with 10 sensing
 *   monsters). Each call re-parsed plugin parameters (regex + escape expansion) and
 *   rebuilt the region list: ~25 of ~45 ms per frame on the RK3566 -> big maps ran at
 *   40 % speed. Same logic here with the constant parts parsed once; values that use
 *   \V[n] / \S[n] escapes still go through the plugin's own code.
 */

(() => {
    "use strict";

    const hasPlugin = name => $plugins.some(p => p.name === name && p.status);
