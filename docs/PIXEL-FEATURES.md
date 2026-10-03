# Pixel movement and free placement (2D)

A runtime opt-in and an editor way of working:

- **Pixel movement** — per map, from **Map Properties › 2D Pixel** (the note
  tag `<pixel>`). The player walks continuously instead of stepping a tile at
  a time: the held direction is a velocity, the body is a box smaller than a
  tile (default 0.7 of one, `<pixel:0.6>` to tune it) that slides along
  walls, and diagonal input walks diagonally. Steps, encounters, touch
  triggers, bushes, camera scroll and followers keep their stock meaning.
- **Free placement** — always on, no switch. Events place, drag and paste at
  pixel granularity and may share a cell (each event carries an
  `rrOffset: { x, y }` in pixels on the event inside `MapNNN.json`; a zero
  offset takes the key back off, and stock RPG Maker ignores the key).
- **Free tiles** — the toolbar's **Free Tiles** button opens a stamp tool for
  any map: the palette's selected tile is stamped at any pixel position,
  dragged to move, right-clicked to lift above the characters or delete.
  Stamps live in an `rrDecor` list on the map
  (`[{ tileId, x, y, above }]`, pixel coordinates, top-left) and are drawn
  by the runtime inside the tilemap's own scrolled layers, so each one
  depthsorts like the tiles around it. Plain sheets and A5 stamp; the
  autotile sheets (A1-A4) stay grid-painted with the pencil, since a
  free-floating autotile has no shape of its own and the pencil is what
  autotiles. Stamps are pure presentation — nothing to collide with,
  nothing to trigger; paint the grid underneath if a spot must block.
  With the map's Grid box ticked, the tool shows a fine eight-pixel
  assist grid and snaps stamps to it; unticked, placement is free at
  single-pixel precision.

The old `<freeplace>` note tag still opens nothing and blocks nothing: free
placement is simply how the editor works now. A map carrying the tag keeps
working unchanged.

## Switches

| Switch | Map note tag | Data key | Runtime |
|---|---|---|---|
| Pixel movement (per map) | `<pixel>` | `rrPixel: true` also works | `runtime/reactor_pixel.js` |
| Free placement (always on) | — | `rrOffset` / `rrDecor` on the map data | editor behavior; runtime renders both |

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
