    // No page scrollbars: the game is one canvas sized to the screen, but other elements sized
    // for a PC window (e.g. an error screen plugin's 1152 px error box) overflow the 640x480
    // screen and the browser shows scrollbars over the game.
    const noScroll = () => {
        for (const el of [document.documentElement, document.body]) if (el) el.style.overflow = "hidden";
    };
    noScroll();
    window.addEventListener("load", noScroll);
    // The game window is fullscreen. Plugins that fit a PC window to the game size
    // (YEP_CoreEngine: window.moveBy + window.resizeBy at start) would take it out of
    // fullscreen under sway and leave it tiled next to ES at half the screen.
    for (const k of ["resizeBy", "resizeTo", "moveBy", "moveTo"]) {
        try { window[k] = function() {}; } catch (e) {}
    }
    // Always fit the game to the screen: the engines stretch only under NW.js or on phones, so in
    // a plain browser (WPE WebKit) the canvas stayed at game size, cropped, and render scale was 1.
    if (window.Graphics) {
        Graphics._defaultStretchMode = function() { return true; };
        Graphics._stretchEnabled = true;
    }
    // Start sends Escape again (cancel / menu); quitting is F2 + Start (pocketmz-hotkeys.py ->
    // PocketMZ_Menu.js). End stays an alias of Escape for button maps made while Start sent End.
    if (window.Input && Input.keyMapper) Input.keyMapper[35] = "escape";
