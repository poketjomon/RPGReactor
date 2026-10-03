//=============================================================================
// reactor_pixel.js - RPG Reactor pixel movement and free placement
//=============================================================================
//
// Pixel movement — on for every 2D map by default (2026-10-03, matching the
// littleRPG_PixelMove packaging): the player stops stepping tile by tile and
// walks continuously — the held direction is a velocity, integrated every
// frame against a body box smaller than a tile (0.7 of a tile by default,
// `<pixel:0.6>` to tune it), sliding along walls instead of bumping them.
// Diagonal input walks diagonally. A map note `<nopixel>` returns that one
// map to the stock tile steps. Events, vehicles and move routes keep the
// stock grid; only the player and its followers move freely. Steps,
// encounters, touch triggers, bush and camera scroll all keep their stock
// meaning: one "step" is one tile of ground covered.
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

    // <pixel> | <pixel:0.6> | <pixel:0.6x0.5> | <pixel:0.6x0.5@middle>
    // Size is width x height in tiles (each 0.3..1); the anchor places the
    // box inside the tile band: bottom (the feet, default), middle or top.
    ReactorPixel.PIXEL_PATTERN = /<pixel(?::\s*([0-9.]+)(?:\s*[x×*]\s*([0-9.]+))?(?:\s*@\s*(top|middle|bottom|[tmb]))?)?>/i;
    ReactorPixel.NO_PIXEL_PATTERN = /<nopixel>/i;
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
     *
     * Pixel walking is the default for every 2D map; `<nopixel>` opts a
     * single map back out, and `<pixel:X>` only sizes the body box.
     */
    ReactorPixel.mapMode = function(mapData) {
        if (!mapData) return null;
        const memo = this._modeMemo.get(mapData);
        if (memo !== undefined) return memo;
        let mode = null;
        // A 3D map never steps in tiles, so it never walks in pixels either.
        const threeD = typeof Reactor3D !== "undefined" && Reactor3D.isMap3D
            && Reactor3D.isMap3D(mapData);
        const off = typeof mapData.note === "string" ? this.NO_PIXEL_PATTERN.test(mapData.note) : false;
        const meta = mapData.meta && mapData.meta.pixel;
        const match = typeof mapData.note === "string" ? this.PIXEL_PATTERN.exec(mapData.note) : null;
        if (!threeD && !off) {
            let body = this.defaultBody();
            // The spec rides the tag: from meta when the loader extracted
            // it, straight out of the note otherwise.
            if (typeof meta === "string") {
                const metaMatch = this.PIXEL_PATTERN.exec(`<pixel:${meta}>`);
                body = this.parseBody(metaMatch ? metaMatch[1] : meta,
                    metaMatch ? metaMatch[2] : null, metaMatch ? metaMatch[3] : null);
            } else if (match) {
                body = this.parseBody(match[1], match[2], match[3]);
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
    /** The stock body: 0.7 of a tile square, anchored at the feet. */
    ReactorPixel.defaultBody = function() {
        return { width: this.DEFAULT_BODY, height: this.DEFAULT_BODY, anchor: "bottom" };
    };

    /** One size clamped into range. */
    ReactorPixel.clampSize = function(value) {
        const size = Number(value);
        return Number.isFinite(size) && size > 0
            ? Math.max(this.MIN_BODY, Math.min(this.MAX_BODY, size)) : null;
    };

    /** Width x height plus the vertical anchor, all optional, all clamped. */
    ReactorPixel.parseBody = function(widthSpec, heightSpec, anchorSpec) {
        const body = this.defaultBody();
        const width = this.clampSize(widthSpec);
        if (width !== null) body.width = width;
        const height = this.clampSize(heightSpec);
        if (height !== null) body.height = height;
        // One number sizes the whole body, as it always did; only the
        // two-number form sets width and height apart.
        else if (width !== null) body.height = width;
        const anchor = { t: "top", m: "middle", b: "bottom" }[String(anchorSpec || "").toLowerCase()]
            || String(anchorSpec || "").toLowerCase();
        if (anchor === "top" || anchor === "middle" || anchor === "bottom") body.anchor = anchor;
        return body;
    };

    ReactorPixel.bodyBox = function(character) {
        const mode = this.mapMode(typeof $dataMap !== "undefined" ? $dataMap : null);
        const body = mode ? mode.body : this.defaultBody();
        const rx = Number.isFinite(character._realX) ? character._realX : character.x;
        const ry = Number.isFinite(character._realY) ? character._realY : character.y;
        const inset = (1 - body.width) / 2;
        // The anchor places the box inside the character's tile band: the
        // feet (bottom) by default, so a sprite's boots line up with its box.
        let top;
        if (body.anchor === "top") top = ry;
        else if (body.anchor === "middle") top = ry + (1 - body.height) / 2;
        else top = ry + 1 - body.height;
        return {
            left: rx + inset,
            right: rx + 1 - inset,
            top,
            bottom: top + body.height,
            width: body.width,
            height: body.height
        };
    };

    /**
     * F7 debug overlay: the player's body box (red), each visible follower's
     * (blue), the logical cell the engine hangs steps and triggers on
     * (white cross) and the tiles of blocking events (yellow). Toggled in
     * play with F7 or from the console (ReactorPixel.debugBodies = true).
     */
    ReactorPixel.debugBodies = false;
    ReactorPixel.DEBUG_KEY = "F7";

    ReactorPixel.updateDebugOverlay = function(spriteset) {
        const overlay = spriteset && spriteset._reactorPixelDebug;
        if (!overlay) return;
        overlay.clear();
        if (!this.debugBodies || typeof $gameMap === "undefined" || !$gameMap) return;
        const tw = $gameMap.tileWidth();
        const th = $gameMap.tileHeight();
        const cell = (character, color) => {
            // The logical cell: what touch triggers, encounters and events
            // still read while the body slides between tiles.
            const cx = $gameMap.adjustX(character.x + 0.5) * tw;
            const cy = $gameMap.adjustY(character.y + 0.5) * th;
            overlay.moveTo(cx - 5, cy); overlay.lineTo(cx + 5, cy);
            overlay.moveTo(cx, cy - 5); overlay.lineTo(cx, cy + 5);
            overlay.stroke({ width: 1, color, alpha: 0.9 });
        };
        const body = (character, color) => {
            const box = this.bodyBox(character);
            const x1 = $gameMap.adjustX(box.left) * tw;
            const x2 = $gameMap.adjustX(box.right) * tw;
            const y1 = $gameMap.adjustY(box.top) * th;
            const y2 = $gameMap.adjustY(box.bottom) * th;
            overlay.rect(x1, y1, x2 - x1, y2 - y1);
            overlay.fill({ color, alpha: 0.22 });
            overlay.stroke({ width: 1, color, alpha: 0.9 });
        };
        if (typeof $gamePlayer !== "undefined" && $gamePlayer) {
            body($gamePlayer, 0xff4d4d);
            cell($gamePlayer, 0xffffff);
            for (const follower of $gamePlayer.followers().visibleFollowers()) {
                body(follower, 0x4da6ff);
            }
        }
        for (const event of $gameMap.events()) {
            if (!event.isNormalPriority() || event.isThrough() || event._erased) continue;
            const x1 = $gameMap.adjustX(event.x) * tw;
            const y1 = $gameMap.adjustY(event.y) * th;
            overlay.rect(x1 + 1, y1 + 1, tw - 2, th - 2);
            overlay.stroke({ width: 1, color: 0xffd529, alpha: 0.45 });
        }
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
        // A body taller than one tile straddles rows, and demanding every
        // overlapped row's blessing jammed it against furniture it merely
        // brushed. One clear row lets it slip past the corner; only when
        // every row says no does the wall take hold.
        let anyClear = false;
        for (const cell of across) {
            const fromX = horizontal ? (positive ? wall - 1 : wall + 1) : cell;
            const fromY = horizontal ? cell : (positive ? wall - 1 : wall + 1);
            if (this.edgePassable(fromX, fromY, direction)
                && !this.cellBlockedFor(character, horizontal ? wall : cell, horizontal ? cell : wall)) {
                anyClear = true;
                break;
            }
        }
        if (!anyClear) {
            const room = (positive ? wall - gap : wall + 1 + gap) - leading;
            if (positive ? room <= 0 : room >= 0) return 0;
            return positive ? Math.min(v, room) : Math.max(v, room);
        }
        return v;
    };

    /** Where an event's sprite sits, shifted by its free-placement offset. */
    ReactorPixel.offsetOf = function(event) {
        const offset = event && event.rrOffset;
        if (!offset) return { x: 0, y: 0 };
        return { x: Math.round(Number(offset.x) || 0), y: Math.round(Number(offset.y) || 0) };
    };

    /**
     * A click that lands on (or behind) a wall should still walk somewhere:
     * ring outward from the click for the closest tile a path can actually
     * reach, so the body ends up beside the click like the stock walker
     * would, instead of standing still because the click itself is solid.
     */
    ReactorPixel.nearestReachable = function(player, tx, ty, maxRadius) {
        maxRadius = maxRadius || 6;
        if (this.findPath(player, player.x, player.y, tx, ty) !== null) {
            return { x: tx, y: ty };
        }
        const map = $gameMap;
        for (let r = 1; r <= maxRadius; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    const x = tx + dx;
                    const y = ty + dy;
                    if (!map.isValid(x, y)) continue;
                    if (this.findPath(player, player.x, player.y, x, y) !== null) {
                        return { x, y };
                    }
                }
            }
        }
        return null;
    };

    /**
     * A* over walkable tile edges, four directions. Returns the tile path
     * from start (exclusive) to goal (inclusive), [] when already there,
     * or null when no way through — the greedy stock search returned 0 and
     * left the walker pinned to a wall.
     */
    ReactorPixel.findPath = function(player, sx, sy, tx, ty) {
        const map = $gameMap;
        if (!map.isValid(sx, sy) || !map.isValid(tx, ty)) return null;
        if (sx === tx && sy === ty) return [];
        const width = map.width(), height = map.height(), size = width * height;
        const dirs = [[2, 0, 1], [4, -1, 0], [6, 1, 0], [8, 0, -1]];
        const hCost = (x, y) => Math.abs(map.deltaX(x, tx)) + Math.abs(map.deltaY(y, ty));
        const start = sy * width + sx, goal = ty * width + tx;
        const came = new Int32Array(size).fill(-1);
        const gScore = new Float64Array(size).fill(Infinity);
        const closed = new Uint8Array(size);
        const heap = [];
        const push = (f, idx) => {
            heap.push([f, idx]);
            let i = heap.length - 1;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (heap[p][0] <= heap[i][0]) break;
                [heap[p], heap[i]] = [heap[i], heap[p]];
                i = p;
            }
        };
        const pop = () => {
            const top = heap[0];
            const last = heap.pop();
            if (heap.length) {
                heap[0] = last;
                let i = 0;
                for (;;) {
                    const l = i * 2 + 1, r = l + 1;
                    let m = i;
                    if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
                    if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
                    if (m === i) break;
                    [heap[m], heap[i]] = [heap[i], heap[m]];
                    i = m;
                }
            }
            return top;
        };
        gScore[start] = 0;
        push(hCost(sx, sy), start);
        let found = false;
        while (heap.length) {
            const current = pop()[1];
            if (current === goal) { found = true; break; }
            if (closed[current]) continue;
            closed[current] = 1;
            const cx = current % width, cy = (current / width) | 0;
            for (const [d] of dirs) {
                const nx = map.roundXWithDirection(cx, d);
                const ny = map.roundYWithDirection(cy, d);
                // The first step out of a straddled, blocked start tile is
                // judged by the destination tile alone.
                if (current !== start && !this.edgePassable(cx, cy, d)) continue;
                if (this.cellBlockedFor(player, nx, ny)) continue;
                if (current === start && !map.isPassable(nx, ny, d)) continue;
                const ni = ny * width + nx;
                if (closed[ni]) continue;
                const tentative = gScore[current] + 1;
                if (tentative < gScore[ni]) {
                    gScore[ni] = tentative;
                    came[ni] = current;
                    push(tentative + hCost(nx, ny), ni);
                }
            }
        }
        if (!found) return null;
        const tiles = [];
        let cur = goal;
        while (cur !== start) {
            tiles.push({ x: cur % width, y: (cur / width) | 0 });
            cur = came[cur];
            if (cur < 0) return null;
        }
        tiles.reverse();
        return tiles;
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
            // A click walks an A* path: steer straight at each waypoint's
            // centre, in pixels, and give the destination up quietly when
            // nothing can reach it (or a door closes mid-walk for a while).
            const tx = $gameTemp.destinationX(), ty = $gameTemp.destinationY();
            let path = player._rrPixelPath;
            if (!path || path.tx !== tx || path.ty !== ty) {
                // The goal is the click itself, or when that tile is solid
                // the closest reachable one beside it.
                const goal = this.nearestReachable(player, tx, ty);
                path = player._rrPixelPath = { tx, ty, i: 0, stuck: 0,
                    tiles: goal ? this.findPath(player, player.x, player.y, goal.x, goal.y) : null };
                if (!goal && typeof console !== "undefined") {
                    console.info("ReactorPixel: no way to (" + tx + "," + ty + ") — the click is given up.");
                }
            }
            if (!path.tiles) {
                $gameTemp.clearDestination();
            } else {
                const speed = player.distancePerFrame();
                // Turn on the spot at each corner: skipping ahead to a
                // farther waypoint cut the corner diagonally, and a body
                // wider than the path swept the furniture standing on it.
                // Only waypoints in a straight line with the next may be
                // passed in stride.
                let wp = path.tiles[path.i];
                while (wp) {
                    const next = path.tiles[path.i + 1];
                    const dx = $gameMap.deltaX(wp.x + 0.5, player._realX);
                    const dy = $gameMap.deltaY(wp.y + 0.5, player._realY);
                    const dist = Math.hypot(dx, dy);
                    const straightOn = next && (next.x === wp.x || next.y === wp.y);
                    if (dist > (straightOn ? speed * 0.55 : 0.02)) break;
                    path.i++;
                    wp = path.tiles[path.i];
                }
                if (!wp) {
                    // The whole path is under our feet.
                    $gameTemp.clearDestination();
                    player._reactorPixelMoving = false;
                    return;
                }
                const dx = $gameMap.deltaX(wp.x + 0.5, player._realX);
                const dy = $gameMap.deltaY(wp.y + 0.5, player._realY);
                const dist = Math.hypot(dx, dy) || 1e-9;
                const stride = Math.min(speed, dist);
                const vx = dx / dist * stride;
                const vy = dy / dist * stride;
                player.setDirection(Math.abs(vx) >= Math.abs(vy) ? (vx > 0 ? 6 : 4) : (vy > 0 ? 2 : 8));
                const beforeX = player._realX;
                const beforeY = player._realY;
                this.integrate(player, vx, vy, player.isThrough() || player.isDebugThrough());
                player._x = Math.round(player._realX);
                player._y = Math.round(player._realY);
                const moved = player._realX !== beforeX || player._realY !== beforeY;
                player._reactorPixelMoving = moved;
                path.stuck = moved ? 0 : path.stuck + 1;
                if (moved) this.crossedTiles(player, beforeX, beforeY);
                player.refreshBushDepth();
                if (path.stuck > 90) $gameTemp.clearDestination();
                return;
            }
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
            // Offsets live in the map's sidecar (reactor3d.eventOffsets),
            // keyed by event id; a legacy event.rrOffset still counts.
            const side = typeof $dataMap !== "undefined" && $dataMap && $dataMap.reactor3d;
            const offsets = side && side.eventOffsets;
            const offset = (offsets && offsets[String(this._eventId)])
                || (this.event() && this.event().rrOffset);
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
        // The stamps live in the map's sidecar (reactor3d.decor), where the
        // RPG Maker editor's whole-file rewrite cannot reach; older maps
        // carried them as rrDecor inside Map###.json.
        const side = mapData && mapData.reactor3d;
        const decor = side && Array.isArray(side.decor) && side.decor.length ? side.decor
            : (mapData && Array.isArray(mapData.rrDecor) ? mapData.rrDecor : null);
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

    if (typeof Game_Player !== "undefined") {
        // A click walk must survive a blocked frame: the stock engine clears
        // the touch destination the moment a frame moves nothing, which cut
        // an A* walk short at the first wall graze. The path's own stuck
        // counter is what gives the destination up when truly wedged.
        const _updateNonmoving = Game_Player.prototype.updateNonmoving;
        Game_Player.prototype.updateNonmoving = function(wasMoving, sceneActive) {
            const path = this._rrPixelPath;
            if (ReactorPixel.enabled() && path && path.tiles
                && typeof $gameTemp !== "undefined" && $gameTemp.isDestinationValid()) {
                return _updateNonmoving.call(this, true, sceneActive);
            }
            return _updateNonmoving.apply(this, arguments);
        };
    }

    if (typeof Spriteset_Map !== "undefined") {
        const _createCharacters = Spriteset_Map.prototype.createCharacters;
        Spriteset_Map.prototype.createCharacters = function() {
            _createCharacters.apply(this, arguments);
            ReactorPixel.createDecorSprites(this);
            // The debug overlay rides above everything the tilemap sorts.
            if (typeof PIXI !== "undefined" && this._tilemap && !this._reactorPixelDebug) {
                this._reactorPixelDebug = new PIXI.Graphics();
                this._reactorPixelDebug.z = 8;
                this._tilemap.addChild(this._reactorPixelDebug);
            }
        };
        const _spritesetUpdate = Spriteset_Map.prototype.update;
        Spriteset_Map.prototype.update = function() {
            _spritesetUpdate.apply(this, arguments);
            if (typeof Input !== "undefined" && Input.isTriggered
                && Input.isTriggered(ReactorPixel.DEBUG_KEY)) {
                ReactorPixel.debugBodies = !ReactorPixel.debugBodies;
            }
            ReactorPixel.updateDebugOverlay(this);
        };
    }

    if (typeof module !== "undefined" && module.exports) module.exports = ReactorPixel;
})(typeof window !== "undefined" ? window : globalThis);
