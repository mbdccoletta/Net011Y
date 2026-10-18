# Moving the Live map onto `strato-geo`, keeping the effects

Asked: can the hand-rolled canvas map become the Dynatrace map without losing its animations?

**Yes — and not by a workaround.** The earlier audit said the animations would die because
`ConnectionLayer` has no animation prop and `MapViewRef` does not expose the maplibre
instance. Both are still true, and both turned out to be the wrong question.

## What makes it possible

`MapView` renders its children inside `<Map>` from `@vis.gl/react-maplibre`
(`map/components/MapContent.js:186`), and before that it runs them through `setLayersId`,
whose first line is:

```js
if (!isValidLayer(child)) { return child; }
```

Anything that is not one of its own layers is **passed through untouched**. So a child of
ours mounts inside the map, and `@vis.gl/react-maplibre` exports exactly what that child
needs: `Source`, `Layer` and `useMap`. `Layer` is typed
`LayerSpecification | CustomLayerInterface` — every maplibre layer type, custom WebGL
included.

That is the difference between this and the audit's conclusion. We are not reaching around
the component for a handle it refuses to give; we are mounting our own layers in the map it
draws, which is how maplibre is meant to be used. The platform draws the basemap, the sites
and the links; we draw what moves.

## The four effects, one at a time

| effect | today | on `strato-geo` | confidence |
|---|---|---|---|
| **Packets along a route** — dots on a quadratic curve, count, speed and size by volume, two directions parked either side by the curve's normal, phase per link | ~40 lines in the shared 2D canvas | our own `Layer` of type `custom` (WebGL), or a GeoJSON source rewritten per frame | high on mechanism, **medium on effort** |
| **Marching ants** on Critical links — `lineDashOffset = -(now/70) % 8` | canvas dash offset | our own `line` layer with `line-dasharray` stepped per frame through `useMap().current.setPaintProperty` | high |
| **Fly-to** — 1,100 ms cubic ease to the focus | hand-written tween over the camera | `map.easeTo({ center, zoom, duration: 1100, easing })` — native, and more correct than ours because it eases the map's own transform rather than our projection | high |
| **Focus glow** behind the affected sites | radial gradient on canvas | a `circle` layer with `circle-blur`, or `BubbleLayer` | high |

`prefers-reduced-motion` stays ours to honour, as it is now.

Two things get *better* rather than merely survive:

- **Label placement.** We run a 240-try solver. maplibre's symbol layer does collision
  detection natively, at every zoom.
- **Clustering.** We cluster by hand above 600 sites. A GeoJSON source takes
  `cluster: true` with a radius.

## What is lost, and what is unknown

- **The land dot-matrix.** Our map draws continents as a field of dots; `MapView` draws a
  real vector basemap from `dt-cdn.net`. That is a change of visual identity, not a lost
  capability, and it is the one thing no amount of custom layers brings back.
- **Schematic mode** (the geography dropped entirely). `MapViewProvider` takes
  `displayWorldMap?: boolean`, which looks like exactly this — **unverified**: nobody has
  seen what it renders with the basemap off, and whether our layers still place.
- **The packets are the expensive half.** Today they are a loop in a canvas that is already
  open. As a custom WebGL layer they are a shader, a buffer and a projection matrix; as a
  GeoJSON source they are ~600 features rewritten at 60 fps on 100 links, which maplibre can
  do but will not love.

## Risks worth stating before anyone starts

1. **We would depend on a transitive package.** `@vis.gl/react-maplibre` is a dependency of
   `strato-geo`, not ours. Using `Source`, `Layer` and `useMap` means declaring it in our own
   `package.json` and pinning it to the version `strato-geo` mounts — a second copy reads a
   different React context and `useMap()` comes back empty. A minor `strato-geo` bump that
   swaps the library takes the animations with it, silently. This ecosystem has already gone
   `react-map-gl` → `@vis.gl/react-maplibre` once.
2. **It is undocumented ground.** The pass-through in `setLayersId` is an implementation
   detail, not a contract. It is very unlikely to change — it is how React composition works
   — but nothing in the docs promises it.
3. **Colours must be literals.** Everything the platform draws goes through canvas/WebGL,
   where `var(--token)` is an invalid colour dropped in silence. `hooks/useToken.ts` already
   exists for this and would be used throughout.

## Shape of the work

Roughly, in order, each independently verifiable:

1. `MapView` + `DotLayer` for the sites and `ConnectionLayer` for the routes — the static
   map, replacing the projection, the land, the clustering and the label solver.
2. `easeTo` for the focus, `circle-blur` for the glow — both native, both small.
3. Our own `line` layer for the Critical links, with the dash offset stepped per frame.
4. The packets, last and alone, because it is the only piece whose cost is not yet known.

Stopping after (1) already leaves a working map on the platform's component, with the two
static layers and no animation — which is a decision point, not a failure.
