/**
 * Two 2D map switches the runtime reads from the map note, in the same
 * spirit as the `<3d>` tag: a checkbox in Map Properties, a tag in the note,
 * and a map that stays ordinary RPG Maker data either way.
 *
 * `<pixel>` — the player walks in pixels instead of tile steps (an optional
 * body size rides along: `<pixel:0.6>`).
 * `<freeplace>` — events may be placed and dragged at pixel granularity,
 * several to a cell, each carrying an `rrOffset` in pixels.
 */
(function(root) {
    'use strict';

    const PIXEL_TAG = '<pixel>';
    const PIXEL_PATTERN = /<pixel(?::\s*([0-9.]+))?>/i;
    const FREE_TAG = '<freeplace>';
    const FREE_PATTERN = /<freeplace>/i;

    const hasPixel = mapData => PIXEL_PATTERN.test((mapData && mapData.note) || '');
    const hasFreePlacement = mapData => FREE_PATTERN.test((mapData && mapData.note) || '');

    /** Append a tag to the note on its own line, and mirror it into meta. */
    const appendTag = (mapData, tag, metaKey, metaValue) => {
        if (!mapData) return false;
        const note = typeof mapData.note === 'string' ? mapData.note : '';
        mapData.note = note && !note.endsWith('\n') ? `${note}\n${tag}` : `${note}${tag}`;
        if (mapData.meta && typeof mapData.meta === 'object') mapData.meta[metaKey] = metaValue;
        return true;
    };

    const removeTag = (mapData, pattern, metaKey) => {
        if (!mapData) return false;
        if (!pattern.test(mapData.note || '')) return false;
        mapData.note = String(mapData.note).replace(pattern, '').replace(/\n{2,}/g, '\n').trim();
        if (mapData.meta && typeof mapData.meta === 'object') delete mapData.meta[metaKey];
        return true;
    };

    /** Mark the map pixel-walking, reporting whether anything changed. */
    const setPixel = (mapData, enabled) => {
        if (!mapData) return false;
        return enabled ? appendTag(mapData, PIXEL_TAG, 'pixel', true) : removeTag(mapData, PIXEL_PATTERN, 'pixel');
    };

    /** Mark the map free-placeable, reporting whether anything changed. */
    const setFreePlacement = (mapData, enabled) => {
        if (!mapData) return false;
        return enabled ? appendTag(mapData, FREE_TAG, 'freeplace', true) : removeTag(mapData, FREE_PATTERN, 'freeplace');
    };

    /** The note with both pixel tags taken out, for the note textarea. */
    const noteWithoutTags = note => {
        const text = typeof note === 'string' ? note : '';
        return text.replace(PIXEL_PATTERN, '').replace(FREE_PATTERN, '').replace(/\n{3,}/g, '\n\n').trim();
    };

    const api = {
        PIXEL_TAG, PIXEL_PATTERN, FREE_TAG, FREE_PATTERN,
        hasPixel, hasFreePlacement, setPixel, setFreePlacement, noteWithoutTags
    };

    root.RRMapPixelTags = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
