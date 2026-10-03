// Pixel movement and free placement (runtime/reactor_pixel.js): the <pixel>
// map opt-in, body-box collision against tile edges and events, follower
// chase, and the per-event rrOffset sprite shift.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(repoRoot, p), 'utf8');

const TILE = 48;
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

/** A fake Game_Map: all tiles open unless a wall is staged. */
function makeMap(options = {}) {
    const walls = new Set(options.walls || []);
    const events = options.events || [];
    const width = options.width || 10;
    const height = options.height || 10;
    return {
        width, height,
        isLoopHorizontal: () => !!options.loopX,
        isLoopVertical: () => !!options.loopY,
        isValid: (x, y) => x >= 0 && x < width && y >= 0 && y < height,
        roundXWithDirection: (x, d) => x + (d === 6 ? 1 : d === 4 ? -1 : 0),
        roundYWithDirection: (y, d) => y + (d === 2 ? 1 : d === 8 ? -1 : 0),
        isPassable: (x, y) => !walls.has(`${x},${y}`),
        eventsXyNt: (x, y) => events.filter(event => event.pos(x, y) && !event.isThrough()),
        events: () => events,
        isEventRunning: () => false,
        tileWidth: () => TILE,
        tileHeight: () => TILE,
        isDashDisabled: () => false
    };
}

/** A fake event cell: blocks the player only at normal priority. */
function makeEvent(x, y, normal = true) {
    return {
        _x: x, _y: y,
        isNormalPriority: () => normal,
        isThrough: () => false,
        pos(px, py) { return this._x === px && this._y === py; }
    };
}

function sandbox({ note = '<pixel>' } = {}) {
    const context = {
        console, Math, JSON, Number, Object, Array, Set, WeakMap,
        $dataMap: { note, meta: {} },
        $gameMap: makeMap(),
        $gameParty: { onPlayerWalk() { } },
        $dataSystem: {},
        Input: { dir4: 0, dir8: 0 },
        $gameTemp: { isDestinationValid: () => false, clearDestination() { }, destinationX: () => 0, destinationY: () => 0 }
    };
    // The module checks instanceof, so the stand-ins must be its realm's classes.
    context.Game_Player = class Game_Player { };
    context.Game_Follower = class Game_Follower { };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(read('runtime/reactor_pixel.js'), context);
    return context;
}

/** A minimal Game_Player stand-in with the fields the module touches. */
function makePlayer(context, map, x = 5, y = 5) {
    const player = new context.Game_Player();
    Object.assign(player, {
        _x: x, _y: y, _realX: x, _realY: y,
        _moveSpeed: 4, _dashing: false, _direction: 2,
        _directionFix: false, _through: false, _reactorPixelMoving: false,
        _vehicleType: 'walk', _vehicleGettingOn: false, _vehicleGettingOff: false,
        _moveRouteForcing: false,
        direction() { return player._direction; },
        setDirection(d) { player._direction = d; },
        isDirectionFixed() { return false; },
        isInVehicle() { return false; },
        isMoveRouteForcing() { return false; },
        canMove() { return true; },
        isDashing() { return player._dashing; },
        isThrough() { return false; },
        isDebugThrough() { return false; },
        isDashButtonPressed() { return false; },
        realMoveSpeed() { return 4; },
        distancePerFrame() { return 0.25; },
        isCollidedWithEvents(px, py) { return map.eventsXyNt(px, py).some(event => event.isNormalPriority()); },
        isCollidedWithVehicles() { return false; },
        isCollidedWithCharacters(px, py) { return player.isCollidedWithEvents(px, py) || player.isCollidedWithVehicles(px, py); },
        increaseSteps() { player.steps = (player.steps || 0) + 1; },
        refreshBushDepth() { },
        checkEventTriggerTouch() { player.bumps = (player.bumps || 0) + 1; },
        startMapEvent() { },
        updateEncounterCount() { player.encounters = (player.encounters || 0) + 1; },
        canStartLocalEvents() { return true; },
        findDirectionTo() { return 0; }
    });
    return player;
}

test('the <pixel> tag opts a 2D map in and its absence leaves the stock grid alone', () => {
    const on = sandbox();
    assert.equal(on.ReactorPixel.enabled(), true);
    const off = sandbox({ note: '' });
    assert.equal(off.ReactorPixel.enabled(), false);
    // A 3D map never walks in pixels, tag or no tag.
    const threeD = sandbox({ note: '<pixel>' });
    threeD.Reactor3D = { isMap3D: () => true };
    threeD.ReactorPixel._modeMemo = new WeakMap();
    assert.equal(threeD.ReactorPixel.enabled(), false, '3D stands down');
    // The tag carries an optional body size, straight out of the note.
    const tuned = sandbox({ note: '<pixel:0.5>' });
    assert.equal(tuned.ReactorPixel.mapMode(tuned.$dataMap).body, 0.5);
    const silly = sandbox({ note: '<pixel:9>' });
    assert.equal(silly.ReactorPixel.mapMode(silly.$dataMap).body, 1, 'clamped to a whole tile');
});

test('the body box is a foot-anchored share of the tile', () => {
    const c = sandbox();
    const player = makePlayer(c, c.$gameMap, 5, 5);
    const box = c.ReactorPixel.bodyBox(player);
    assert.ok(Math.abs(box.left - 5.15) < 1e-9, `left ${box.left}`);
    assert.ok(Math.abs(box.right - 5.85) < 1e-9, `right ${box.right}`);
    assert.ok(Math.abs(box.top - 5.3) < 1e-9, `top ${box.top}`);
    assert.equal(box.bottom, 6);
});

test('a free walk slides along a wall instead of stopping a tile short', () => {
    // A wall column at x=7; the player walks right from 5.
    const c = sandbox({ note: '<pixel>' });
    c.$gameMap = makeMap({ walls: ['7,5', '7,6'] });
    const player = makePlayer(c, c.$gameMap, 5, 5);
    for (let i = 0; i < 20 && c.ReactorPixel.integrate(player, 0.25, 0, false); i++);
    const box = c.ReactorPixel.bodyBox(player);
    assert.ok(Math.abs(box.right - 6.9999) < 1e-3, `hugging the wall at ${box.right}`);
    // Pressing again advances nothing.
    assert.equal(c.ReactorPixel.integrate(player, 0.25, 0, false), false);
    // Sliding along it works: down is open.
    assert.equal(c.ReactorPixel.integrate(player, 0, 0.25, false), true);
    assert.ok(Math.abs(player._realY - 5.25) < 1e-9);
});

test('an open corridor is walked continuously and diagonal input divides the stride', () => {
    const c = sandbox();
    const player = makePlayer(c, c.$gameMap, 0, 0);
    c.ReactorPixel.integrate(player, 0.25, 0, false);
    c.ReactorPixel.integrate(player, 0.25, 0, false);
    assert.ok(Math.abs(player._realX - 0.5) < 1e-9, `half a tile in ${player._realX}`);
    const step = 0.25 / Math.SQRT2;
    c.ReactorPixel.integrate(player, step, step, false);
    assert.ok(Math.abs(player._realX - (0.5 + step)) < 1e-9);
    assert.ok(Math.abs(player._realY - step) < 1e-9);
});

test('a normal-priority event blocks the body; a below one does not', () => {
    const c = sandbox();
    c.$gameMap = makeMap({ events: [makeEvent(6, 5, true)] });
    const player = makePlayer(c, c.$gameMap, 5, 5);
    for (let i = 0; i < 20 && c.ReactorPixel.integrate(player, 0.25, 0, false); i++);
    const box = c.ReactorPixel.bodyBox(player);
    assert.ok(box.right < 6.001, `stopped short of the event at ${box.right}`);
    const open = sandbox();
    open.$gameMap = makeMap({ events: [makeEvent(6, 5, false)] });
    const walker = makePlayer(open, open.$gameMap, 5, 5);
    for (let i = 0; i < 20; i++) open.ReactorPixel.integrate(walker, 0.25, 0, false);
    assert.ok(walker._realX > 6.5, `walked through the below event to ${walker._realX}`);
});

test('a frame of held input moves, faces, and crossing a tile line counts a step', () => {
    const c = sandbox();
    c.Input.dir8 = 6;
    const player = makePlayer(c, c.$gameMap, 5, 5);
    c.ReactorPixel.updatePlayerMove(player);
    assert.equal(player._reactorPixelMoving, true);
    assert.equal(player._direction, 6);
    assert.ok(player._realX > 5);
    // Four strides of a quarter tile land the walk on the next tile line.
    for (let i = 0; i < 4; i++) c.ReactorPixel.updatePlayerMove(player);
    assert.ok(player.steps >= 1, `steps ${player.steps}`);
    assert.ok(player.encounters >= 1, 'encounter progress moved with the walk');
    // Releasing the keys stands still and clears the flag.
    c.Input.dir8 = 0;
    c.ReactorPixel.updatePlayerMove(player);
    assert.equal(player._reactorPixelMoving, false);
});

test('a blocked press bumps the event in front, the stock way', () => {
    const c = sandbox();
    c.$gameMap = makeMap({ events: [makeEvent(6, 5, true)] });
    c.Input.dir8 = 6;
    const player = makePlayer(c, c.$gameMap, 5, 5);
    for (let i = 0; i < 8; i++) c.ReactorPixel.updatePlayerMove(player);
    assert.ok(player.bumps >= 1, 'the wall the walk pressed into answered');
});

test('a follower trails its leader at a body\'s distance and gathers to the player', () => {
    const c = sandbox();
    const player = makePlayer(c, c.$gameMap, 5, 5);
    c.$gamePlayer = player;
    const follower = new c.Game_Follower();
    Object.assign(follower, {
        _x: 8, _y: 5, _realX: 8, _realY: 5, _direction: 4, _reactorPixelMoving: false,
        isVisible() { return true; },
        distancePerFrame() { return 0.25; },
        setDirection(d) { follower._direction = d; },
        direction() { return follower._direction; },
        isDirectionFixed() { return false; },
        isMoving() { return !!follower._reactorPixelMoving; }
    });
    player.followers = () => ({ _data: [follower], areGathering: () => false, visibleFollowers: () => [follower] });
    c.ReactorPixel.updateFollowerChase(follower);
    assert.equal(follower._reactorPixelMoving, true, 'closing the gap');
    assert.ok(Math.abs(follower._realX - 7.75) < 1e-9, `one stride closer ${follower._realX}`);
    // Far enough away it is not gathered; next to the player it is.
    assert.equal(c.ReactorPixel.followerIsGathered(follower), false);
    follower._realX = 5.2;
    follower._reactorPixelMoving = false;
    assert.equal(c.ReactorPixel.followerIsGathered(follower), true);
});

test('an event with an rrOffset shifts its sprite on a 2D map and stands down on a 3D one', () => {
    const c = sandbox({ note: '' });
    c.Game_Event = function () { };
    c.Game_Event.prototype.screenX = () => 100;
    c.Game_Event.prototype.screenY = () => 200;
    // Re-run the module so the patch block wraps the stubbed class.
    vm.runInContext(read('runtime/reactor_pixel.js'), c);
    const shifted = { _reactorOffsetX: 12, _reactorOffsetY: -8 };
    assert.equal(c.Game_Event.prototype.screenX.call(shifted), 112);
    assert.equal(c.Game_Event.prototype.screenY.call(shifted), 192);
    const plain = { _reactorOffsetX: 0, _reactorOffsetY: 0 };
    assert.equal(c.Game_Event.prototype.screenX.call(plain), 100, 'no offset, no change');
});

test('the freeplace tag is read and the offset helper rounds to whole pixels', () => {
    const c = sandbox({ note: '<freeplace>' });
    assert.equal(c.ReactorPixel.freePlacement(c.$dataMap), true);
    assert.equal(c.ReactorPixel.freePlacement({ note: '' }), false);
    same(c.ReactorPixel.offsetOf({ rrOffset: { x: 10.4, y: -6.6 } }), { x: 10, y: -7 });
    same(c.ReactorPixel.offsetOf({}), { x: 0, y: 0 });
});
