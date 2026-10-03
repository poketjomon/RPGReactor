# Pixel movement and free placement (2D)

Two opt-in 2D features, switched per map from **Map Properties › 2D Pixel**.
Both default to off, and a map without them is ordinary RPG Maker data that
the stock engine, plugins and RPG Maker itself all read unchanged. Both stand
down on a 3D map.

- **Pixel movement** — the player walks continuously instead of stepping a
  tile at a time. The held direction is a velocity; the body is a box smaller
  than a tile (default 0.7 of one) that slides along walls. Diagonal input
  walks diagonally. Steps, encounters, touch triggers, bushes, camera scroll
  and followers keep their stock meaning: one "step" is one tile of ground
  covered, and a follower trails about a body-length behind its leader.
- **Free placement** — events may be placed, dragged and pasted at pixel
  granularity, and several may share a cell. Each event stores what it needs
  in an `rrOffset: { x, y }` key (pixels, relative to its cell's top-left)
  on the event inside `MapNNN.json`; a zero offset takes the key back off.
- **Free tiles** — the toolbar's Free Tiles button (freeplace maps only)
  opens a stamp tool: the palette's selected tile is stamped at any pixel
  position, dragged to move, right-clicked to lift above the characters or
  delete. Stamps live in an `rrDecor` list on the map
  (`[{ tileId, x, y, above }]`, pixel coordinates, top-left) and are drawn
  by the runtime inside the tilemap's own scrolled layers, so each one
  depthsorts like the tiles around it. Plain sheets only (B-E, Reactor's
  F/G, and A5): a lone autotile has no shape without its neighbours, so
  A1-A4 are refused. Stamps are pure presentation — nothing to collide
  with, nothing to trigger; paint the grid underneath if a spot must block.

## Switches

| Checkbox | Map note tag | Data key | Runtime |
|---|---|---|---|
| Pixel movement | `<pixel>` | `rrPixel: true` also works | `runtime/reactor_pixel.js` |
| Free placement | `<freeplace>` | `rrFreePlacement: true` also works | editor behavior; runtime renders `rrOffset` and `rrDecor` |

A tag typed into the note by hand counts too — the checkbox and the tag can
never disagree in the saved map. `<pixel:0.6>` tunes the body box (clamped
to 0.3–1.0 of a tile).

## What stays on the grid on purpose

- Events, vehicles and move routes move per tile; only the player (and, in
  pursuit, its followers) walks freely. A move route on the player uses the
  stock grid and normalizes the position back to a tile.
- An event's **cell** is where its triggers, collision and everything
  grid-shaped live; `rrOffset` shifts the sprite only. In practice the drag
  keeps the offset within one tile of the cell, so what you see is what you
  stand on.
- Stock RPG Maker ignores `rrOffset` and the two note tags, so maps
  round-trip through it (it would drop the offsets on an edit-and-save, as
  it drops any field it does not know).

## Runtime notes

`runtime/reactor_pixel.js` patches `Game_Player`, `Game_Follower(s)` and
`Game_Event`'s screen position, every patch gated on the map's tag. The
runtime revision in `reactor_main.js` was bumped, so an existing project
picks the module up the next time it is opened in the editor (the editor
refreshes the project's `js/` copy when the revision differs). Unit tests:
`editor/tests/reactor-pixel.test.cjs`.
