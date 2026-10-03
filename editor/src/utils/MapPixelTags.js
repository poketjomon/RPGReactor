/**
 * Two 2D map switches the runtime reads from the map note, in the same
 * spirit as the `<3d>` tag: a checkbox in Map Properties, a tag in the note,
 * and a map that stays ordinary RPG Maker data either way.
 *
 * Pixel movement — on for every 2D map by default (2026-10-03, matching the
 * littleRPG_PixelMove packaging): the checkbox clears or restores a
 * `<nopixel>` opt-out, and `<pixel:0.6>` typed in the note still sizes the
 * body box.
 * `<freeplace>` — events may be placed and dragged at pixel granularity,
 * several to a cell, each carrying an `rrOffset` in pixels.
 */
(function(root) {
    'use strict';

    const PIXEL_TAG = '<pixel>';
    const PIXEL_PATTERN = /<pixel(?::\s*([0-9.]+))?>/i;
    const NO_PIXEL_TAG = '<nopixel>';
    const NO_PIXEL_PATTERN = /<nopixel>/i;
    const FREE_TAG = '<freeplace>';
    const FREE_PATTERN = /<freeplace>/i;

    /** A 2D map walks in pixels unless its note opts out with <nopixel>. */
    const pixelEnabled = mapData => !NO_PIXEL_PATTERN.test((mapData && mapData.note) || '');
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

    /** Set the map's pixel movement: enabled clears <nopixel>, disabled adds it. */
    const setPixel = (mapData, enabled) => {
        if (!mapData) return false;
        return enabled ? removeTag(mapData, NO_PIXEL_PATTERN, 'nopixel')
            : appendTag(mapData, NO_PIXEL_TAG, 'nopixel', true);
    };

    /** Mark the map free-placeable, reporting whether anything changed. */
    const setFreePlacement = (mapData, enabled) => {
        if (!mapData) return false;
        return enabled ? appendTag(mapData, FREE_TAG, 'freeplace', true) : removeTag(mapData, FREE_PATTERN, 'freeplace');
    };

    /** The note with the pixel tags taken out, for the note textarea. */
    const noteWithoutTags = note => {
        const text = typeof note === 'string' ? note : '';
        return text.replace(NO_PIXEL_PATTERN, '').replace(PIXEL_PATTERN, '').replace(FREE_PATTERN, '')
            .replace(/\n{3,}/g, '\n\n').trim();
    };

    const api = {
        PIXEL_TAG, PIXEL_PATTERN, NO_PIXEL_TAG, NO_PIXEL_PATTERN, FREE_TAG, FREE_PATTERN,
        pixelEnabled, hasFreePlacement, setPixel, setFreePlacement, noteWithoutTags
    };

    root.RRMapPixelTags = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
