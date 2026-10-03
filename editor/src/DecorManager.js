/**
 * Free tile stamps — the decor half of a <freeplace> map.
 *
 * The grid data of an MZ map cannot hold a tile at a fraction of a cell, so
 * freely placed tiles live beside it: `MapNNN.json` carries an optional
 * `rrDecor` list of `{ tileId, x, y, above }` (pixel coordinates, top-left,
 * `above` lifting the stamp into the above-characters band). The runtime
 * draws them in the tilemap's own scrolled layers; stock RPG Maker ignores
 * the key, so the map still round-trips.
 *
 * Stamping takes the tile the palette has selected; autotile sheets (A1-A4)
 * are refused, since a lone autotile has no shape without neighbours —
 * the plain sheets (B-E, Reactor's F/G, and A5) stamp exactly.
 */
function tm_container_add_ghost(manager) {
    const tm = manager.tilemapManager;
    if (tm?.container) tm.container.addChild(manager._ghost);
}

class DecorManager {
    constructor(projectController) {
        this.projectController = projectController;
        this.active = false;
        this.currentMap = null;
        this.selected = null;
        this.isDragging = false;
        this.draggedDecor = null;
        this.dragOffset = { x: 0, y: 0 };
        this._undoStack = [];
        this._redoStack = [];
        this._handlers = null;
        this._menu = null;
        this._belowContainer = null;
        this._aboveContainer = null;
        this._highlight = null;
        this._ghost = null;
        this._ghostTileId = 0;
        this._placing = false;
        this._lastStamp = { x: 0, y: 0 };
        this.onUndoStateChange = null;
    }

    get tilemapManager() {
        return this.projectController?.getTilemapManager?.() || null;
    }

    get eventManager() {
        return this.projectController?.eventManager || null;
    }

    get palette() {
        return this.eventManager?.tilesetPaletteViewer || null;
    }

    /** Plain-sheet bands only: B-E (0-1023), Reactor F/G (1024-1535), A5 (1536-1663). */
    static stampableTileId(tileId) {
        return Number.isInteger(tileId) && tileId > 0
            && (tileId < 1536 || (tileId >= 1536 && tileId < 1536 + 128));
    }

    setCurrentMap(map) {
        this.currentMap = map || null;
        this.clearSelection();
        this.clearUndoHistory();
        this.render();
        this.redrawFineGrid();
    }

    setActive(enabled) {
        if (!this.currentMap) enabled = false;
        if (enabled === this.active) {
            if (enabled) this.render();
            return;
        }
        this.active = enabled;
        if (!enabled) this.hideGhost();
        this.redrawFineGrid();
        if (enabled) {
            this.ensureContainers();
            this.setupInteraction();
            this.render();
            this.status('Free tiles: pick a tile in the palette, click to stamp, drag to move, right-click for more.');
        } else {
            this.removeInteraction();
            this.clearSelection();
            this.status(null);
        }
    }

    status(text) {
        const ui = typeof window !== 'undefined' ? window.reactor?.uiManager : null;
        if (ui?.updateStatus) ui.updateStatus(text || '');
    }

    tt(text) {
        return (typeof window !== 'undefined' && window.I18n) ? window.I18n.tText(text) : text;
    }

    tileWidth() {
        return this.tilemapManager?.TILE_WIDTH || 48;
    }

    tileHeight() {
        return this.tilemapManager?.TILE_HEIGHT || 48;
    }

    /**
     * The assist grid of free placement: with the map's Grid box ticked,
     * stamps snap to, and the map shows, a fine grid of SNAP pixels (six
     * to a 48px tile); with it unticked, placement is fully free at one
     * pixel and no fine grid is drawn.
     */
    static SNAP = 8;

    snapSize() {
        return this.tilemapManager?.gridVisible === false ? 1 : DecorManager.SNAP;
    }

    snapValue(v) {
        const s = this.snapSize();
        return s <= 1 ? Math.round(v) : Math.round(v / s) * s;
    }

    /** Draw (or clear) the fine assist grid over the map's tiles. */
    redrawFineGrid() {
        this.ensureContainers();
        const tm = this.tilemapManager;
        if (!tm || !tm.container || !this._belowContainer) return;
        if (!this._fineGrid) {
            this._fineGrid = new PIXI.Graphics();
            tm.container.addChildAt(this._fineGrid, tm.container.children.indexOf(this._belowContainer));
        }
        this._fineGrid.clear();
        const map = this.currentMap;
        if (!this.active || !map || this.snapSize() <= 1) return;
        const s = DecorManager.SNAP;
        const w = map.width * this.tileWidth();
        const h = map.height * this.tileHeight();
        for (let x = s; x < w; x += s) {
            this._fineGrid.moveTo(x, 0);
            this._fineGrid.lineTo(x, h);
        }
        for (let y = s; y < h; y += s) {
            this._fineGrid.moveTo(0, y);
            this._fineGrid.lineTo(w, y);
        }
        this._fineGrid.stroke({ color: 0x9aa7b0, width: 0.5, alpha: 0.22 });
    }

    decorList() {
        if (!this.currentMap) return null;
        if (!Array.isArray(this.currentMap.rrDecor)) this.currentMap.rrDecor = [];
        return this.currentMap.rrDecor;
    }

    ensureContainers() {
        const tm = this.tilemapManager;
        if (!tm || !tm.container) return;
        // A reopened project replaces the map canvas; the old layers would
        // keep rendering into a detached container, invisible forever.
        if (this._belowContainer && !this._belowContainer.destroyed && this._belowContainer.parent !== tm.container) {
            this._belowContainer.destroy({ children: true });
            this._aboveContainer?.destroy({ children: true });
            this._highlight?.destroy();
            this._ghost?.destroy({ children: true });
            this._belowContainer = null;
            this._aboveContainer = null;
            this._highlight = null;
            this._ghost = null;
            this._fineGrid?.destroy();
            this._fineGrid = null;
            this._ghostTileId = 0;
        }
        if (!this._belowContainer || this._belowContainer.destroyed) {
            this._belowContainer = new PIXI.Container();
            this._aboveContainer = new PIXI.Container();
            this._highlight = new PIXI.Graphics();
            this._highlight.visible = false;
            // Below stamps sit under the event layer; above stamps over it —
            // both inside the map canvas' own coordinate space.
            const eventLayer = this.eventManager?.eventContainer;
            if (eventLayer && eventLayer.parent === tm.container) {
                const index = tm.container.children.indexOf(eventLayer);
                tm.container.addChildAt(this._belowContainer, index);
                tm.container.addChildAt(this._aboveContainer, index + 1);
            } else {
                tm.container.addChild(this._belowContainer);
                tm.container.addChild(this._aboveContainer);
            }
            tm.container.addChild(this._highlight);
        }
    }

    /** Rebuild every stamp sprite from the map's decor list. */
    render() {
        if (!this.active) return;
        this.ensureContainers();
        if (!this._belowContainer) return;
        const list = this.currentMap ? (this.currentMap.rrDecor || []) : [];
        this._belowContainer.removeChildren().forEach(child => child.destroy({ children: true }));
        this._aboveContainer.removeChildren().forEach(child => child.destroy({ children: true }));
        for (const entry of list) {
            if (!entry) continue;
            const sprite = this.createStampSprite(entry);
            (entry.above ? this._aboveContainer : this._belowContainer).addChild(sprite);
        }
        this.updateHighlight();
    }

    createStampSprite(entry) {
        const tileId = entry.tileId;
        let sprite = this.eventManager?.createTileSprite
            ? this.eventManager.createTileSprite(tileId)
            : null;
        if (!sprite) {
            // No palette texture yet: a placeholder keeps the stamp editable.
            sprite = new PIXI.Graphics();
            sprite.rect(0, 0, this.tileWidth(), this.tileHeight());
            sprite.fill({ color: 0xff00ff, alpha: 0.4 });
        } else {
            // The event tile factory draws for a cell; a stamp is the same size.
            sprite.x = 0;
            sprite.y = 0;
        }
        const wrap = new PIXI.Container();
        wrap.addChild(sprite);
        wrap.x = entry.x;
        wrap.y = entry.y;
        return wrap;
    }

    updateHighlight() {
        if (!this._highlight) return;
        this._highlight.clear();
        if (!this.selected) {
            this._highlight.visible = false;
            return;
        }
        const w = this.tileWidth();
        const h = this.tileHeight();
        this._highlight.rect(this.selected.x, this.selected.y, w, h);
        this._highlight.stroke({ color: 0xffd700, width: 2 });
        this._highlight.visible = true;
    }

    /**
     * The free-floating preview under the cursor: the selected tile at
     * exactly where a click would land, never snapped to a cell. This is
     * what makes the mode read as Tiled-style placement rather than
     * painting with extra steps.
     */
    showGhost(tileId, px, py) {
        this.ensureContainers();
        if (!this._ghost) {
            this._ghost = new PIXI.Container();
            this._ghost.alpha = 0.65;
            this._ghost.visible = false;
            if (this._aboveContainer) tm_container_add_ghost(this);
        }
        if (this._ghostTileId !== tileId) {
            this._ghost.removeChildren().forEach(child => child.destroy({ children: true }));
            const sprite = this.eventManager?.createTileSprite
                ? this.eventManager.createTileSprite(tileId) : null;
            if (sprite) {
                sprite.x = 0;
                sprite.y = 0;
                this._ghost.addChild(sprite);
            } else {
                const box = new PIXI.Graphics();
                box.rect(0, 0, this.tileWidth(), this.tileHeight());
                box.stroke({ color: 0xffd700, width: 1.5 });
                this._ghost.addChild(box);
            }
            this._ghostTileId = tileId;
        }
        this._ghost.x = this.snapValue(px - this.tileWidth() / 2);
        this._ghost.y = this.snapValue(py - this.tileHeight() / 2);
        this._ghost.visible = true;
    }

    hideGhost() {
        if (this._ghost) this._ghost.visible = false;
        this._ghostTileId = 0;
        this._placing = false;
    }

    clearSelection() {
        this.selected = null;
        this.updateHighlight();
    }

    //-------------------------------------------------------------------------
    // Data operations (each mutates the map's rrDecor list)

    decorAtPoint(px, py) {
        const list = this.currentMap?.rrDecor;
        if (!Array.isArray(list)) return null;
        const w = this.tileWidth();
        const h = this.tileHeight();
        let found = null;
        for (const entry of list) {
            if (!entry) continue;
            if (px >= entry.x && px < entry.x + w && py >= entry.y && py < entry.y + h) found = entry;
        }
        return found;
    }

    stamp(tileId, px, py, skipHistory = false) {
        const list = this.decorList();
        if (!list || !DecorManager.stampableTileId(tileId)) {
            this.status('Autotile sheets (A1-A4) cannot be stamped freely — pick a B-E, F/G or A5 tile.');
            return null;
        }
        if (!skipHistory) this.saveState();
        const w = this.tileWidth();
        const h = this.tileHeight();
        const entry = {
            tileId,
            x: this.snapValue(Math.max(-w / 2, Math.min(px - w / 2, this.currentMap.width * w - w / 2))),
            y: this.snapValue(Math.max(-h / 2, Math.min(py - h / 2, this.currentMap.height * h - h / 2))),
            above: false
        };
        list.push(entry);
        this.render();
        return entry;
    }

    moveDecor(entry, px, py) {
        const w = this.tileWidth();
        const h = this.tileHeight();
        entry.x = this.snapValue(Math.max(-w / 2, Math.min(px, this.currentMap.width * w - w / 2)));
        entry.y = this.snapValue(Math.max(-h / 2, Math.min(py, this.currentMap.height * h - h / 2)));
        this.render();
    }

    deleteDecor(entry) {
        const list = this.currentMap?.rrDecor;
        if (!Array.isArray(list) || !entry) return;
        const index = list.indexOf(entry);
        if (index < 0) return;
        this.saveState();
        list.splice(index, 1);
        if (this.selected === entry) this.clearSelection();
        this.render();
    }

    toggleAbove(entry) {
        if (!entry) return;
        this.saveState();
        entry.above = !entry.above;
        this.render();
    }

    //-------------------------------------------------------------------------
    // Undo (its own stack; UIManager routes here while the tool is active)

    saveState() {
        this._undoStack.push(JSON.stringify(this.currentMap?.rrDecor || []));
        if (this._undoStack.length > 100) this._undoStack.shift();
        this._redoStack = [];
        this.onUndoStateChange?.(this.canUndo(), this.canRedo());
    }

    _apply(snapshot) {
        if (!this.currentMap) return;
        this.currentMap.rrDecor = JSON.parse(snapshot);
        this.clearSelection();
        this.render();
        this.onUndoStateChange?.(this.canUndo(), this.canRedo());
    }

    undo() {
        if (!this.canUndo()) return;
        this._redoStack.push(JSON.stringify(this.currentMap?.rrDecor || []));
        this._apply(this._undoStack.pop());
    }

    redo() {
        if (!this.canRedo()) return;
        this._undoStack.push(JSON.stringify(this.currentMap?.rrDecor || []));
        this._apply(this._redoStack.pop());
    }

    canUndo() {
        return this.active && this._undoStack.length > 0;
    }

    canRedo() {
        return this.active && this._redoStack.length > 0;
    }

    clearUndoHistory() {
        this._undoStack = [];
        this._redoStack = [];
        this.onUndoStateChange?.(false, false);
    }

    //-------------------------------------------------------------------------
    // Map interaction

    setupInteraction() {
        const tm = this.tilemapManager;
        if (!tm || !tm.container || this._handlers) return;
        const container = tm.container;
        const on = (name, handler) => {
            container.on(name, handler);
            this._handlers.push({ name, handler });
        };
        this._handlers = [];

        on('pointerdown', event => {
            if (event.data.button !== 0 || event.data.originalEvent?.shiftKey) return;
            if (!this.currentMap) return;
            this.hideMenu();
            const pos = event.data.getLocalPosition(container);
            const hit = this.decorAtPoint(pos.x, pos.y);
            if (hit) {
                this.selected = hit;
                this.updateHighlight();
                this.isDragging = true;
                this.draggedDecor = hit;
                this.dragOffset.x = pos.x - hit.x;
                this.dragOffset.y = pos.y - hit.y;
                container.cursor = 'grabbing';
                return;
            }
            // Empty ground: stamp the palette's selected tile under the
            // cursor, then keep stamping while the button drags — one undo
            // step for the whole stroke, like a paintbrush.
            const tileId = this.selectedPaletteTileId();
            if (tileId > 0) {
                if (DecorManager.stampableTileId(tileId)) {
                    this._placing = true;
                    this._lastStamp = { x: pos.x, y: pos.y };
                    this.saveState();
                    this.stamp(tileId, pos.x, pos.y, true);
                } else {
                    this.status('Autotile sheets (A1-A4) cannot be stamped freely — pick a B-E, F/G or A5 tile.');
                }
            } else {
                this.clearSelection();
                this.hideGhost();
                this.status('Pick a tile in the palette first, then click the map to stamp it.');
            }
        });

        on('pointermove', event => {
            const pos = event.data.getLocalPosition(container);
            if (this.isDragging && this.draggedDecor) {
                this.moveDecor(this.draggedDecor, pos.x - this.dragOffset.x, pos.y - this.dragOffset.y);
                this.updateHighlight();
                return;
            }
            // The free ghost trails the cursor whenever a stampable tile is picked.
            const tileId = this.selectedPaletteTileId();
            if (tileId > 0 && DecorManager.stampableTileId(tileId)) {
                this.showGhost(tileId, pos.x, pos.y);
            } else {
                this.hideGhost();
            }
            if (!this._placing) return;
            const dx = pos.x - this._lastStamp.x;
            const dy = pos.y - this._lastStamp.y;
            if (dx * dx + dy * dy >= 144) {
                this._lastStamp = { x: pos.x, y: pos.y };
                this.stamp(tileId, pos.x, pos.y, true);
            }
        });

        const finishDrag = () => {
            this.isDragging = false;
            this.draggedDecor = null;
            this.dragOffset = { x: 0, y: 0 };
            this._placing = false;
            if (container) container.cursor = 'default';
        };
        on('pointerup', finishDrag);
        on('pointerupoutside', finishDrag);
        on('pointerleave', () => this.hideGhost());
        // The Grid box toggles the fine assist grid while the tool holds the
        // map, and returns the stock cell grid when it hands it back.
        if (typeof window !== 'undefined') {
            window.addEventListener('rr-show-grid-changed', () => this.redrawFineGrid());
        }

        on('rightdown', event => {
            event.stopPropagation();
            event.data.originalEvent.preventDefault();
            if (!this.currentMap) return;
            const pos = event.data.getLocalPosition(container);
            const hit = this.decorAtPoint(pos.x, pos.y);
            if (hit) {
                this.selected = hit;
                this.updateHighlight();
                this.showMenu(event.data.originalEvent.clientX, event.data.originalEvent.clientY, hit);
            } else {
                this.hideMenu();
            }
        });
    }

    removeInteraction() {
        const tm = this.tilemapManager;
        if (this._handlers && tm?.container) {
            for (const { name, handler } of this._handlers) tm.container.off(name, handler);
        }
        this._handlers = null;
        this.hideMenu();
        if (tm?.container) tm.container.cursor = 'default';
    }

    /** The palette's selected tile as a tile id, through the event manager's converter. */
    selectedPaletteTileId() {
        const palette = this.palette;
        const eventManager = this.eventManager;
        if (!palette || !eventManager?.convertToTileId) return 0;
        const selectedTiles = palette.getSelectedTiles();
        if (!selectedTiles || selectedTiles.length === 0) return 0;
        const tile = selectedTiles[0];
        return eventManager.convertToTileId(tile.layer, tile.x, tile.y) || 0;
    }

    //-------------------------------------------------------------------------
    // The small right-click menu

    showMenu(clientX, clientY, entry) {
        this.hideMenu();
        const menu = document.createElement('div');
        menu.id = 'decor-context-menu';
        menu.style.cssText = `
            position: fixed;
            left: ${clientX}px;
            top: ${clientY}px;
            background-color: var(--color-bg-menubar);
            border: 1px solid var(--color-border);
            border-radius: 4px;
            padding: 4px 0;
            z-index: 10001;
            min-width: 160px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
        `;
        const item = (label, action) => {
            const button = document.createElement('div');
            button.textContent = label;
            button.style.cssText = 'padding: 6px 14px; cursor: pointer; font-size: 12px; color: var(--color-text);';
            button.addEventListener('mouseenter', () => { button.style.backgroundColor = 'var(--color-bg-hover)'; });
            button.addEventListener('mouseleave', () => { button.style.backgroundColor = 'transparent'; });
            button.addEventListener('click', () => { this.hideMenu(); action(); });
            menu.appendChild(button);
        };
        item(this.tt(entry.above ? 'Put below characters' : 'Put above characters'), () => this.toggleAbove(entry));
        item(this.tt('Delete stamp'), () => this.deleteDecor(entry));
        item(this.tt('Cancel'), () => {});
        document.body.appendChild(menu);
        this._menu = menu;
        const close = () => this.hideMenu();
        document.addEventListener('click', close, { once: true });
        this._menuCloseHandler = close;
    }

    hideMenu() {
        if (this._menuCloseHandler) {
            document.removeEventListener('click', this._menuCloseHandler);
            this._menuCloseHandler = null;
        }
        if (this._menu) {
            this._menu.remove();
            this._menu = null;
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = DecorManager;
}
