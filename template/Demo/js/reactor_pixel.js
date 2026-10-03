//=============================================================================
// reactor_pixel.js - RPG Reactor pixel movement and free placement
//=============================================================================
//
// Two opt-in 2D features, each switched on per map so a project without
// them plays exactly as before:
//
// Pixel movement — the map note tag `<pixel>` (or a `rrPixel: true` key on
// the map). The player stops stepping tile by tile and walks continuously:
// the held direction is a velocity, integrated every frame against a body
// box smaller than a tile (default 0.7 of a tile, `<pixel:0.6>` to tune it),
// sliding along walls instead of bumping them. Diagonal input walks
// diagonally. Events, vehicles and move routes keep the stock grid; only
// the player and its followers move freely. Steps, encounters, touch
// triggers, bush and camera scroll all keep their stock meaning: one "step"
// is one tile of ground covered.
//
// Free placement — the map note tag `<freeplace>` switches the editor over
// (see the editor side); the runtime half is smaller: an event may carry
// `rrOffset: { x, y }` in pixels, and its sprite is drawn shifted by that
// much, and the map may carry an `rrDecor` list of `{ tileId, x, y, above }`
// free tile stamps drawn in the tilemap's own scrolled layers. The event's
// cell stays where the data says — triggers, collision and everything
// grid-shaped read the cell; the pixels are presentation.
// Stock RPG Maker ignores the keys, so the map still round-trips.
//
// Both are 2D-only by design: on a 3D map the whole module stands down.
//=============================================================================

(function(root) {
    "use strict";

    //-------------------------------------------------------------------------
    // ReactorPixel

    const ReactorPixel = root.ReactorPixel = {};

    ReactorPixel.PIXEL_PATTERN = /<pixel(?::\s*([0-9.]+))?>/i;
    ReactorPixel.FREE_PATTERN = /<freeplace>/i;

    /** The body box as a share of a tile, and its floor and ceiling. */
    ReactorPixel.DEFAULT_BODY = 0.7;
    ReactorPixel.MIN_BODY = 0.3;
    ReactorPixel.MAX_BODY = 1;

    /** A hair of a tile, keeping edge arithmetic off exact boundaries. */
    ReactorPixel.EPS = 1e-6;
    /** The gap a blocked slide leaves before a wall, in tiles. */
    ReactorPixel.GAP = 1e-4;
    /** How far a follower trails its leader, in tiles. */
    ReactorPixel.FOLLOW_GAP = 0.85;
    /** Close enough to the player to count as gathered, in tiles. */
    ReactorPixel.GATHERED_WITHIN = 0.5;

    ReactorPixel._modeMemo = new WeakMap();

    /**
     * The map's pixel settings: null (off), or the body size. Memoized per
     * map — this is asked several times a frame per character.
     */
    ReactorPixel.mapMode = function(mapData) {
        if (!mapData) return null;
        const memo = this._modeMemo.get(mapData);
        if (memo !== undefined) return memo;
        let mode = null;
        // A 3D map never steps in tiles, so it never walks in pixels either.
        const threeD = typeof Reactor3D !== "undefined" && Reactor3D.isMap3D
            && Reactor3D.isMap3D(mapData);
        const meta = mapData.meta && mapData.meta.pixel;
        const match = typeof mapData.note === "string" ? this.PIXEL_PATTERN.exec(mapData.note) : null;
        if (!threeD && (meta || mapData.rrPixel === true || match)) {
            let body = this.DEFAULT_BODY;
            // The size rides the tag: `<pixel:0.6>` — from meta when the
            // loader extracted it, straight out of the note otherwise.
            const asked = typeof meta === "string" ? meta : (match ? match[1] : null);
            if (asked) {
                const size = Number(asked);
                if (Number.isFinite(size) && size > 0) {
                    body = Math.max(this.MIN_BODY, Math.min(this.MAX_BODY, size));
                }
            }
            mode = { body };
        }
        this._modeMemo.set(mapData, mode);
        return mode;
    };

    /** Whether the current map walks in pixels. */
    ReactorPixel.enabled = function() {
        if (typeof $dataMap === "undefined" || !$dataMap) return false;
        return !!this.mapMode($dataMap);
    };

    /** Whether a map lets events be placed off the grid. */
    ReactorPixel.freePlacement = function(mapData) {
        const map = mapData || (typeof $dataMap !== "undefined" ? $dataMap : null);
        if (!map) return false;
        if (typeof Reactor3D !== "undefined" && Reactor3D.isMap3D && Reactor3D.isMap3D(map)) return false;
        return !!(map.rrFreePlacement === true
            || (map.meta && map.meta.freeplace)
            || this.FREE_PATTERN.test(map.note || ""));
    };

    /** Whether this character walks in pixels: the player, on foot, unscripted. */
    ReactorPixel.walksFreely = function(character) {
        if (!this.enabled()) return false;
        if (typeof Game_Player === "undefined" || !(character instanceof Game_Player)) return false;
        return !character.isInVehicle()
            && !character._vehicleGettingOn && !character._vehicleGettingOff
            && !character.isMoveRouteForcing();
    };

    /** Whether this character's chase runs in pixels: a follower on a pixel map. */
    ReactorPixel.chasesFreely = function(character) {
        if (!this.enabled()) return false;
        if (typeof Game_Follower === "undefined" || !(character instanceof Game_Follower)) return false;
        if (typeof $gamePlayer === "undefined" || !$gamePlayer || $gamePlayer.isInVehicle()) return false;
        return true;
    };

    /** The body box of a character, in tile units: a smaller, foot-anchored tile. */
    ReactorPixel.bodyBox = function(character) {
        const mode = this.mapMode(typeof $dataMap !== "undefined" ? $dataMap : null);
        const s = mode ? mode.body : this.DEFAULT_BODY;
        const rx = Number.isFinite(character._realX) ? character._realX : character.x;
        const ry = Number.isFinite(character._realY) ? character._realY : character.y;
        const inset = (1 - s) / 2;
        return {
            left: rx + inset,
            right: rx + 1 - inset,
            top: ry + 1 - s,
            bottom: ry + 1,
            width: s
        };
    };

    /**
     * Whether the edge of tile (x, y) toward direction d can be crossed —
     * the stock double-sided rule, without the 3D terrain clause this
     * module never meets.
     */
    ReactorPixel.edgePassable = function(x, y, d) {
        const x2 = $gameMap.roundXWithDirection(x, d);
        const y2 = $gameMap.roundYWithDirection(y, d);
        if (!$gameMap.isValid(x2, y2)) return false;
        const d2 = 10 - d;
        return $gameMap.isPassable(x, y, d) && $gameMap.isPassable(x2, y2, d2);
    };

    /** The tile columns a box lies over, edges kept off the boundaries. */
    ReactorPixel.boxColumns = function(box) {
        return this.span(Math.floor(box.left + this.EPS), Math.floor(box.right - this.EPS));
    };

    /** The tile rows a box lies over, edges kept off the boundaries. */
    ReactorPixel.boxRows = function(box) {
        return this.span(Math.floor(box.top + this.EPS), Math.floor(box.bottom - this.EPS));
    };

    ReactorPixel.span = function(first, last) {
        const list = [];
        for (let i = first; i <= last; i++) list.push(i);
        return list;
    };

    /** Whether anything the stock cell rules block sits on the tile (x, y). */
    ReactorPixel.cellBlockedFor = function(character, x, y) {
        if (!$gameMap.isValid(x, y)) return true;
        return character.isCollidedWithCharacters(x, y);
    };

    /**
     * One frame of free walking: the velocity moved axis by axis so walls
     * are slid along rather than stopped at. Returns whether the character
     * ended the frame somewhere new.
     */
    ReactorPixel.integrate = function(character, vx, vy, through) {
        const map = $gameMap;
        let movedX = 0;
        let movedY = 0;
        if (through) {
            movedX = vx;
            movedY = vy;
            character._realX += movedX;
            character._realY += movedY;
        } else {
            // One axis at a time, each written back before the other reads
            // the box, so a diagonal takes its bearings from where the
            // first axis actually landed.
            if (vx) {
                movedX = this.slide(character, vx, true);
                character._realX += movedX;
            }
            if (vy) {
                movedY = this.slide(character, vy, false);
                character._realY += movedY;
            }
        }
        if (map.isLoopHorizontal()) {
            const width = map.width();
            character._realX = ((character._realX % width) + width) % width;
        }
        if (map.isLoopVertical()) {
            const height = map.height();
            character._realY = ((character._realY % height) + height) % height;
        }
        return movedX !== 0 || movedY !== 0;
    };

    /**
     * A move of `v` along one axis, cut short at the first wall, event or
     * map edge the body would newly enter. Speeds stay under a tile a
     * frame, so one slide crosses at most one line of tiles.
     */
    ReactorPixel.slide = function(character, v, horizontal) {
        const eps = this.EPS;
        const gap = this.GAP;
        const box = this.bodyBox(character);
        const positive = v > 0;
        const direction = horizontal ? (positive ? 6 : 4) : (positive ? 2 : 8);
        const leading = horizontal ? (positive ? box.right : box.left) : (positive ? box.bottom : box.top);
        const across = horizontal ? this.boxRows(box) : this.boxColumns(box);
        const target = leading + v;
        const here = Math.floor(leading + (positive ? -eps : eps));
        const there = Math.floor(target + (positive ? -eps : eps));
        if (there === here) return v;
        // The tile line being entered: its near side, index `wall`.
        const wall = there;
        for (const cell of across) {
            const fromX = horizontal ? (positive ? wall - 1 : wall + 1) : cell;
            const fromY = horizontal ? cell : (positive ? wall - 1 : wall + 1);
            const blocked = !this.edgePassable(fromX, fromY, direction)
                || this.cellBlockedFor(character, horizontal ? wall : cell, horizontal ? cell : wall);
            if (blocked) {
                const room = (positive ? wall - gap : wall + 1 + gap) - leading;
                if (positive ? room <= 0 : room >= 0) return 0;
                return positive ? Math.min(v, room) : Math.max(v, room);
            }
        }
        return v;
    };

    /** Where an event's sprite sits, shifted by its free-placement offset. */
    ReactorPixel.offsetOf = function(event) {
        const offset = event && event.rrOffset;
        if (!offset) return { x: 0, y: 0 };
        return { x: Math.round(Number(offset.x) || 0), y: Math.round(Number(offset.y) || 0) };
    };

    //-------------------------------------------------------------------------
    // The player's frame of free walking, from held input or a click.

    ReactorPixel.updatePlayerMove = function(player) {
        if (!this.walksFreely(player) || !player.canMove()) {
            player._reactorPixelMoving = false;
            return;
        }
        // Dash is decided per step in the stock engine; a free walk has no
        // steps, so it is refreshed here instead.
        player._dashing = !player.isInVehicle() && !$gameMap.isDashDisabled()
            && (player.isDashButtonPressed() || $gameTemp.isDestinationValid());
        let direction = root.Input ? root.Input.dir8 : 0;
        const fromInput = direction > 0;
        if (fromInput) $gameTemp.clearDestination();
        if (!direction && $gameTemp.isDestinationValid()) {
            direction = player.findDirectionTo($gameTemp.destinationX(), $gameTemp.destinationY());
        }
        if (!direction) {
            player._reactorPixelMoving = false;
            return;
        }
        const speed = player.distancePerFrame();
        let vx = 0;
        let vy = 0;
        if (direction === 4) vx = -speed;
        else if (direction === 6) vx = speed;
        else if (direction === 2) vy = speed;
        else if (direction === 8) vy = -speed;
        else if (direction === 1) { vx = -speed / Math.SQRT2; vy = speed / Math.SQRT2; }
        else if (direction === 3) { vx = speed / Math.SQRT2; vy = speed / Math.SQRT2; }
        else if (direction === 7) { vx = -speed / Math.SQRT2; vy = -speed / Math.SQRT2; }
        else if (direction === 9) { vx = speed / Math.SQRT2; vy = -speed / Math.SQRT2; }
        // Face the way the walk leans, diagonals included.
        const face = Math.abs(vx) >= Math.abs(vy) && vx !== 0 ? (vx > 0 ? 6 : 4)
            : vy !== 0 ? (vy > 0 ? 2 : 8) : player.direction();
        player.setDirection(face);
        const beforeX = player._realX;
        const beforeY = player._realY;
        this.integrate(player, vx, vy, player.isThrough() || player.isDebugThrough());
        player._x = Math.round(player._realX);
        player._y = Math.round(player._realY);
        const moved = player._realX !== beforeX || player._realY !== beforeY;
        player._reactorPixelMoving = moved;
        if (!moved) {
            // Pressed into something that stopped us: the stock bump trigger.
            this.triggerTouchAt(player, vx, vy);
        } else {
            this.crossedTiles(player, beforeX, beforeY);
        }
        player.refreshBushDepth();
    };

    /**
     * Everything the stock engine hangs on a committed step, folded onto
     * the whole tiles the player walked this frame: step counts, the
     * party's walk, encounter progress and the under-foot touch triggers.
     */
    ReactorPixel.crossedTiles = function(player, beforeX, beforeY) {
        const tiles = Math.abs(Math.round(player._realX) - Math.round(beforeX))
            + Math.abs(Math.round(player._realY) - Math.round(beforeY));
        if (tiles <= 0) return;
        player.increaseSteps();
        if (!$gameMap.isEventRunning()) {
            $gameParty.onPlayerWalk();
            if (player.canStartLocalEvents()) {
                player.startMapEvent(player.x, player.y, [1, 2], false);
            }
            player.updateEncounterCount();
        }
    };

    /**
     * The bump: pressed into something and stopped. If it is an event a
     * walk-onto trigger answers to, start it — the stock moveStraight does
     * this on its failed branch.
     */
    ReactorPixel.triggerTouchAt = function(player, vx, vy) {
        if (vy !== 0 && (vx === 0 || Math.abs(vy) > Math.abs(vx))) {
            const y2 = $gameMap.roundYWithDirection(player.y, vy > 0 ? 2 : 8);
            player.checkEventTriggerTouch(player.x, y2);
        } else if (vx !== 0) {
            const x2 = $gameMap.roundXWithDirection(player.x, vx > 0 ? 6 : 4);
            player.checkEventTriggerTouch(x2, player.y);
        }
    };

    //-------------------------------------------------------------------------
    // Followers: the same free walk, aimed at a point behind their leader.

    ReactorPixel.updateFollowerChase = function(follower) {
        const player = $gamePlayer;
        const followers = player.followers();
        const line = followers._data || [];
        const index = line.indexOf(follower);
        const leader = index <= 0 ? player : line[index - 1];
        const gap = followers.areGathering() ? 0 : this.FOLLOW_GAP;
        const dx = leader._realX - follower._realX;
        const dy = leader._realY - follower._realY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance <= gap + 0.02) {
            follower._reactorPixelMoving = false;
            return;
        }
        const stride = Math.min(follower.distancePerFrame(), distance - gap);
        const vx = (dx / distance) * stride;
        const vy = (dy / distance) * stride;
        const beforeX = follower._realX;
        const beforeY = follower._realY;
        // A follower chases on the through flag it already carries: it walks
        // its leader's path, and the path is clear by construction.
        this.integrate(follower, vx, vy, true);
        follower._x = Math.round(follower._realX);
        follower._y = Math.round(follower._realY);
        follower._reactorPixelMoving = follower._realX !== beforeX || follower._realY !== beforeY;
        if (follower._reactorPixelMoving) {
            const face = Math.abs(vx) >= Math.abs(vy) ? (vx > 0 ? 6 : 4) : (vy > 0 ? 2 : 8);
            follower.setDirection(face);
        }
    };

    /** A follower is gathered when it stands with the player, roughly. */
    ReactorPixel.followerIsGathered = function(follower) {
        const dx = $gamePlayer._realX - follower._realX;
        const dy = $gamePlayer._realY - follower._realY;
        return !follower.isMoving() && Math.sqrt(dx * dx + dy * dy) < this.GATHERED_WITHIN;
    };

    //-------------------------------------------------------------------------
    // Patches. Each one stands down unless the map asked for pixels.

    if (typeof Game_Player !== "undefined") {
        const _isMoving = Game_Player.prototype.isMoving;
        Game_Player.prototype.isMoving = function() {
            if (ReactorPixel.walksFreely(this)) return !!this._reactorPixelMoving;
            return _isMoving.apply(this, arguments);
        };

        const _moveByInput = Game_Player.prototype.moveByInput;
        Game_Player.prototype.moveByInput = function() {
            if (ReactorPixel.walksFreely(this)) {
                ReactorPixel.updatePlayerMove(this);
                return;
            }
            return _moveByInput.apply(this, arguments);
        };

        // The frame's walking already happened in moveByInput; the stock
        // tile-to-tile lerp has nothing to do here.
        const _updateMove = Game_Player.prototype.updateMove;
        Game_Player.prototype.updateMove = function() {
            if (ReactorPixel.walksFreely(this) && this._reactorPixelMoving) return;
            return _updateMove.apply(this, arguments);
        };
    }

    if (typeof Game_Follower !== "undefined") {
        const _followerIsMoving = Game_Follower.prototype.isMoving;
        Game_Follower.prototype.isMoving = function() {
            if (ReactorPixel.chasesFreely(this)) return !!this._reactorPixelMoving;
            return _followerIsMoving.apply(this, arguments);
        };

        const _followerUpdate = Game_Follower.prototype.update;
        Game_Follower.prototype.update = function() {
            _followerUpdate.apply(this, arguments);
            if (ReactorPixel.chasesFreely(this) && this.isVisible()) {
                ReactorPixel.updateFollowerChase(this);
            }
        };

        const _isGathered = Game_Follower.prototype.isGathered;
        Game_Follower.prototype.isGathered = function() {
            if (ReactorPixel.chasesFreely(this)) return ReactorPixel.followerIsGathered(this);
            return _isGathered.apply(this, arguments);
        };
    }

    if (typeof Game_Followers !== "undefined") {
        // The chase runs per follower in its own update; the stock back-to-
        // front step issuer would double-step the line.
        const _followersUpdateMove = Game_Followers.prototype.updateMove;
        Game_Followers.prototype.updateMove = function() {
            if (ReactorPixel.enabled() && typeof $gamePlayer !== "undefined" && $gamePlayer
                && !$gamePlayer.isInVehicle()) return;
            return _followersUpdateMove.apply(this, arguments);
        };
    }

    if (typeof Game_Event !== "undefined") {
        // Free placement: the sprite draws where the map put it, pixels and
        // all; the cell it answers to never moves. On a 3D map the projection
        // owns the position and the offset stands down.
        const _eventScreenX = Game_Event.prototype.screenX;
        Game_Event.prototype.screenX = function() {
            const base = _eventScreenX.apply(this, arguments);
            if (!this._reactorOffsetX) return base;
            if (typeof Reactor3D !== "undefined" && Reactor3D.shouldRender3D && typeof $dataMap !== "undefined"
                && Reactor3D.shouldRender3D($dataMap)) return base;
            return base + this._reactorOffsetX;
        };
        const _eventScreenY = Game_Event.prototype.screenY;
        Game_Event.prototype.screenY = function() {
            const base = _eventScreenY.apply(this, arguments);
            if (!this._reactorOffsetY) return base;
            if (typeof Reactor3D !== "undefined" && Reactor3D.shouldRender3D && typeof $dataMap !== "undefined"
                && Reactor3D.shouldRender3D($dataMap)) return base;
            return base + this._reactorOffsetY;
        };

        const _eventInitMembers = Game_Event.prototype.initMembers;
        Game_Event.prototype.initMembers = function() {
            _eventInitMembers.apply(this, arguments);
            this._reactorOffsetX = 0;
            this._reactorOffsetY = 0;
        };

        const _eventInitialize = Game_Event.prototype.initialize;
        Game_Event.prototype.initialize = function(mapId, eventId) {
            _eventInitialize.apply(this, arguments);
            const offset = this.event() && this.event().rrOffset;
            if (offset) {
                this._reactorOffsetX = Math.round(Number(offset.x) || 0);
                this._reactorOffsetY = Math.round(Number(offset.y) || 0);
            }
        };
    }

    /** The sheet bitmap and source rect of a stampable tile, or null. */
    ReactorPixel.decorTileSource = function(tileId) {
        if (typeof $gameMap === "undefined" || !$gameMap || typeof ImageManager === "undefined") return null;
        const tileset = $gameMap.tileset();
        if (!tileset || !tileset.tilesetNames) return null;
        const tw = $gameMap.tileWidth();
        const th = $gameMap.tileHeight();
        const a5 = typeof Tilemap !== "undefined" && Tilemap.TILE_ID_A5 !== undefined ? Tilemap.TILE_ID_A5 : 1536;
        if (tileId >= a5 && tileId < a5 + 128) {
            const bitmap = ImageManager.loadTileset(tileset.tilesetNames[4]);
            if (!bitmap) return null;
            const local = tileId - a5;
            return { bitmap, sx: (local % 8) * tw, sy: Math.floor(local / 8) * th, width: tw, height: th };
        }
        // Autotile sheets (2048 and up) have no lone shape without neighbours,
        // so the decor layer stamps the plain sheets only.
        if (tileId < 0 || tileId >= a5) return null;
        const bitmap = ImageManager.loadTileset(tileset.tilesetNames[5 + Math.floor(tileId / 256)]);
        if (!bitmap) return null;
        const sx = ((Math.floor(tileId / 128) % 2) * 8 + (tileId % 8)) * tw;
        const sy = (Math.floor((tileId % 256) / 8) % 16) * th;
        return { bitmap, sx, sy, width: tw, height: th };
    };

    /**
     * The map's free tile stamps, drawn into the tilemap's own scrolled
     * layers: below-characters stamps live with the lower tiles, above-
     * characters stamps with the upper ones, so each depthsorts exactly
     * like the tiles around it and follows the camera for free.
     */
    ReactorPixel.createDecorSprites = function(spriteset) {
        const mapData = typeof $dataMap !== "undefined" ? $dataMap : null;
        const decor = mapData && Array.isArray(mapData.rrDecor) ? mapData.rrDecor : null;
        if (!decor || !decor.length || typeof Sprite === "undefined") return;
        if (typeof Reactor3D !== "undefined" && Reactor3D.isMap3D && Reactor3D.isMap3D(mapData)) return;
        const tilemap = spriteset && spriteset._tilemap;
        if (!tilemap || !tilemap._lowerLayer || !tilemap._upperLayer) return;
        for (const entry of decor) {
            if (!entry || !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) continue;
            const source = this.decorTileSource(entry.tileId);
            if (!source) continue;
            const sprite = new Sprite();
            sprite.bitmap = source.bitmap;
            sprite.setFrame(source.sx, source.sy, source.width, source.height);
            sprite.x = entry.x;
            sprite.y = entry.y;
            (entry.above ? tilemap._upperLayer : tilemap._lowerLayer).addChild(sprite);
        }
    };

    if (typeof Spriteset_Map !== "undefined") {
        const _createCharacters = Spriteset_Map.prototype.createCharacters;
        Spriteset_Map.prototype.createCharacters = function() {
            _createCharacters.apply(this, arguments);
            ReactorPixel.createDecorSprites(this);
        };
    }

    if (typeof module !== "undefined" && module.exports) module.exports = ReactorPixel;
})(typeof window !== "undefined" ? window : globalThis);
