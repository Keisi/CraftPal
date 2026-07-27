import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useGame } from '../lib/GameContext.js';
import { loadMapData, loadHabitat } from '../lib/mapData.js';
import {
  TILE_SIZE,
  MIN_ZOOM,
  MAX_ZOOM,
  mapSizeAtZoom,
  worldToPixel,
  pixelToWorld,
  formatIngameCoord,
} from '../lib/mapProject.js';
import { groupTypesByCategory, countMarkersByType, partitionMarkersForRender, nearestMarker } from '../lib/mapMarkers.js';

// The map view (PLAN.md §8). No map library (no Leaflet/MapLibre, no new
// dependency) — the base map is the local XYZ tile pyramid rendered as plain
// absolutely-positioned <img>s, and the world<->pixel math is
// src/lib/mapProject.js's ported transform. See that module's docblock for
// the orientation evidence.
//
// Rendering split (deliberate, for performance): a handful of enabled marker
// types (Fast Travel, Tower, ...) render as real DOM nodes — a few hundred
// <button>s is fine, and it's what makes them individually
// hover/keyboard/click-accessible. Any enabled type whose marker COUNT is
// large (Ore 1463, Salvage Rank2 ~2000, NPC 431, ...) — not a fixed list of
// type names, whatever crosses CANVAS_MARKER_THRESHOLD — is routed to a
// single shared <canvas> instead, since a few thousand DOM nodes visibly
// jank scrolling/zooming. The pal habitat point cloud (up to ~1000+ points
// per pal) always draws on that same canvas. Canvas markers stay clickable
// via a nearest-point hit test (src/lib/mapMarkers.js's nearestMarker).

// Sensible default layers — enough to get oriented without rendering all
// 13,944 markers at once. Ids must match map.json's types[].id exactly.
const DEFAULT_ENABLED_TYPES = ['Fast Travel', 'Tower', 'Dungeon', 'Alpha Pal'];

// A type with more markers than this renders on canvas even if the user
// enabled it like any other layer (see the module docblock).
const CANVAS_MARKER_THRESHOLD = 300;

const MARKER_ICON_SIZE = 22; // px, DOM marker icon button
const HABITAT_POINT_RADIUS = 2.5; // px, canvas habitat dot
const CANVAS_MARKER_RADIUS = 3; // px, canvas POI dot

// Small fixed palette for canvas-rendered POI dots, keyed by the type's
// legend `category` — canvas markers don't get a full icon sprite (that
// would mean preloading hundreds of Image() objects for a rarely-zoomed-in
// layer), just a color-coded dot; the DOM-rendered default layers still get
// their real icons. Falls back to a neutral gray for an unrecognized/absent
// category rather than throwing.
const CATEGORY_DOT_COLORS = {
  Enemies: '#f87171',
  Resource: '#4ade80',
  Locations: '#60a5fa',
  Fishing: '#22d3ee',
  Eggs: '#f472b6',
  Mine: '#fbbf24',
  NPCs: '#c084fc',
  Collectibles: '#facc15',
  Oilrig: '#fb923c',
  Other: '#a1a1aa',
};

function categoryDotColor(category) {
  return CATEGORY_DOT_COLORS[category] ?? CATEGORY_DOT_COLORS.Other;
}

function markerKey(marker) {
  return marker.id ?? `${marker.type}|${marker.name}|${marker.x}|${marker.y}`;
}

function assetUrl(manifest, relPath) {
  return `${import.meta.env.BASE_URL}${manifest.assetBase}${relPath}`;
}

// Marker-type icons are stored PUBLIC-ROOT-relative in map.json (e.g.
// "games/palworld/icons/markers/x.webp") — unlike item/pal icons, which are
// assetBase-relative. Resolving them must NOT go through assetUrl().
function markerIconUrl(icon) {
  return `${import.meta.env.BASE_URL}${icon}`;
}

function ZoomControl({ zoom, onChange }) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900/90 px-1.5 py-1">
      <button
        type="button"
        onClick={() => onChange(zoom - 1)}
        disabled={zoom <= MIN_ZOOM}
        title="Zoom out"
        className="flex h-6 w-6 items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-30"
      >
        −
      </button>
      <span className="w-10 text-center text-xs tabular-nums text-zinc-400">z{zoom}</span>
      <button
        type="button"
        onClick={() => onChange(zoom + 1)}
        disabled={zoom >= MAX_ZOOM}
        title="Zoom in"
        className="flex h-6 w-6 items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}

function LayerControl({ groupedTypes, enabledTypes, onToggle, manifest }) {
  return (
    <div className="space-y-4">
      {groupedTypes.map((group) => (
        <div key={group.category}>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">{group.category}</div>
          <div className="space-y-0.5">
            {group.types.map((t) => (
              <label
                key={t.id}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm text-zinc-300 hover:bg-zinc-800/60"
              >
                <input
                  type="checkbox"
                  checked={enabledTypes.has(t.id)}
                  onChange={() => onToggle(t.id)}
                  className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-900 text-zinc-100 focus:ring-2 focus:ring-zinc-500"
                />
                <img src={markerIconUrl(t.icon)} alt="" loading="lazy" className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{t.label}</span>
                <span className="text-xs tabular-nums text-zinc-500">{t.count}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="border-t border-zinc-800 pt-2 text-[11px] text-zinc-500">
        Data: {(manifest.attribution ?? []).map((a, i) => (
          <span key={a.url}>
            {i > 0 && ', '}
            <a href={a.url} target="_blank" rel="noreferrer" className="underline hover:text-zinc-300">
              {a.label}
            </a>
          </span>
        ))}
      </div>
    </div>
  );
}

function HabitatPicker({ pals, focusPal, onFocusPalChange, dayNight, onDayNightChange, habitatState }) {
  const options = useMemo(
    () =>
      Object.entries(pals ?? {})
        .filter(([, pal]) => pal.hasHabitat)
        .sort((a, b) => a[1].name.localeCompare(b[1].name)),
    [pals],
  );
  const focusedPal = focusPal ? pals?.[focusPal] : null;
  const hasLevelRange = focusedPal?.habitat?.levelMin != null && focusedPal?.habitat?.levelMax != null;

  return (
    <div className="border-t border-zinc-800 pt-3">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Pal habitat</div>
      <select
        value={focusPal ?? ''}
        onChange={(event) => onFocusPalChange(event.target.value || null)}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
      >
        <option value="">None</option>
        {options.map(([code, pal]) => (
          <option key={code} value={code}>
            {pal.name}
          </option>
        ))}
      </select>

      {focusPal && (
        <div className="mt-2 space-y-1.5">
          <div className="flex gap-1">
            {['day', 'night'].map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onDayNightChange(option)}
                aria-pressed={dayNight === option}
                className={`flex-1 rounded-md border px-2 py-1 text-xs font-medium capitalize transition-colors ${
                  dayNight === option
                    ? 'border-zinc-400 bg-zinc-700 text-zinc-100'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
          {hasLevelRange && (
            <div className="text-xs text-zinc-400">
              Lv. {focusedPal.habitat.levelMin}–{focusedPal.habitat.levelMax}
            </div>
          )}
          {habitatState.status === 'loading' && <div className="text-xs text-zinc-500">Loading habitat…</div>}
          {habitatState.status === 'error' && (
            <div className="text-xs text-red-400">Failed to load habitat: {habitatState.message}</div>
          )}
        </div>
      )}
    </div>
  );
}

function MarkerInfoPanel({ marker, typesById, items, onClose }) {
  if (!marker) return null;
  const typeDef = typesById.get(marker.type);
  const linkedItem = marker.itemId ? items[marker.itemId] : null;

  return (
    <div className="absolute bottom-3 right-3 z-20 max-w-xs rounded-lg border border-zinc-700 bg-zinc-900/95 p-3 text-sm shadow-lg backdrop-blur">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="float-right -mr-1 -mt-1 rounded px-1.5 text-zinc-500 hover:text-zinc-200"
      >
        ✕
      </button>
      <div className="font-semibold text-zinc-100">{marker.name}</div>
      <div className="text-xs text-zinc-400">{typeDef?.label ?? marker.type}</div>
      <div className="mt-1.5 space-y-0.5 text-xs text-zinc-300">
        <div>In-game: {formatIngameCoord(marker) ?? 'unknown'}</div>
        {marker.lv != null && <div>Level {marker.lv}</div>}
        {marker.boss && <div className="text-amber-300">Boss</div>}
        {marker.onlyTime && <div className="text-amber-300">{marker.onlyTime === 'night' ? 'Night only' : marker.onlyTime}</div>}
        {marker.cooldown && <div>Cooldown: {marker.cooldown}</div>}
        {marker.comment && <div className="text-zinc-400">{marker.comment}</div>}
        {linkedItem && <div className="text-zinc-400">Contains: {linkedItem.name}</div>}
      </div>
    </div>
  );
}

export function MapView({ onBack, focusPalCode }) {
  const { manifest, pals, items } = useGame();

  const [mapState, setMapState] = useState({ status: 'loading' });
  const [retryToken, setRetryToken] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [enabledTypes, setEnabledTypes] = useState(() => new Set(DEFAULT_ENABLED_TYPES));
  const [selectedMarker, setSelectedMarker] = useState(null);
  const [focusPal, setFocusPal] = useState(() => focusPalCode ?? null);
  const [dayNight, setDayNight] = useState('day');
  const [habitatState, setHabitatState] = useState({ status: 'idle' });
  const [recenterWorld, setRecenterWorld] = useState(null);

  const viewportRef = useRef(null);
  const canvasRef = useRef(null);

  const hasHabitats = manifest.datasets?.includes('habitats');

  useEffect(() => {
    let cancelled = false;
    setMapState({ status: 'loading' });
    loadMapData(manifest)
      .then((data) => {
        if (!cancelled) setMapState({ status: 'ready', data });
      })
      .catch((err) => {
        if (!cancelled) setMapState({ status: 'error', message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [manifest, retryToken]);

  useEffect(() => {
    if (!focusPal) {
      setHabitatState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setHabitatState({ status: 'loading' });
    loadHabitat(manifest, focusPal)
      .then((data) => {
        if (!cancelled) setHabitatState({ status: 'ready', data });
      })
      .catch((err) => {
        if (!cancelled) setHabitatState({ status: 'error', message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [manifest, focusPal]);

  const world = mapState.data?.world;

  const countsByType = useMemo(() => countMarkersByType(mapState.data?.markers ?? []), [mapState.data]);
  const groupedTypes = useMemo(
    () => groupTypesByCategory(mapState.data?.types ?? [], countsByType),
    [mapState.data, countsByType],
  );
  const typesById = useMemo(() => new Map((mapState.data?.types ?? []).map((t) => [t.id, t])), [mapState.data]);

  const { dom: domMarkers, canvas: canvasMarkers } = useMemo(
    () => partitionMarkersForRender(mapState.data?.markers ?? [], enabledTypes, countsByType, CANVAS_MARKER_THRESHOLD),
    [mapState.data, enabledTypes, countsByType],
  );

  const domPositioned = useMemo(() => {
    if (!world) return [];
    return domMarkers.map((marker) => ({ marker, ...worldToPixel({ x: marker.x, y: marker.y }, world, zoom) }));
  }, [domMarkers, world, zoom]);

  const canvasPositioned = useMemo(() => {
    if (!world) return [];
    return canvasMarkers.map((marker) => ({ marker, ...worldToPixel({ x: marker.x, y: marker.y }, world, zoom) }));
  }, [canvasMarkers, world, zoom]);

  const habitatPoints = useMemo(() => {
    if (!world || habitatState.status !== 'ready') return [];
    const flat = habitatState.data?.[dayNight] ?? [];
    const points = [];
    for (let i = 0; i + 2 < flat.length; i += 3) {
      const pixel = worldToPixel({ x: flat[i], y: flat[i + 1] }, world, zoom);
      points.push({ x: pixel.x, y: pixel.y, lv: flat[i + 2] });
    }
    return points;
  }, [world, habitatState, dayNight, zoom]);

  // Redraw the shared canvas layer whenever anything it depends on changes.
  // Imperative (not JSX) because a canvas is a pixel buffer, not a DOM tree —
  // this is the "thousands of points would jank as DOM nodes" escape hatch.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !world) return;
    const size = mapSizeAtZoom(zoom);
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);

    for (const { marker, x, y } of canvasPositioned) {
      ctx.beginPath();
      ctx.fillStyle = categoryDotColor(typesById.get(marker.type)?.category);
      ctx.arc(x, y, CANVAS_MARKER_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }

    if (habitatPoints.length > 0) {
      ctx.fillStyle = dayNight === 'day' ? 'rgba(251,191,36,0.7)' : 'rgba(129,140,248,0.75)';
      for (const point of habitatPoints) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, HABITAT_POINT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [canvasPositioned, habitatPoints, zoom, world, dayNight, typesById]);

  // Keep the viewport centered on the same world point across a zoom change
  // (otherwise the top-left corner stays put and the view visibly drifts).
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !recenterWorld || !world) return;
    const p = worldToPixel(recenterWorld, world, zoom);
    viewport.scrollLeft = Math.max(0, p.x - viewport.clientWidth / 2);
    viewport.scrollTop = Math.max(0, p.y - viewport.clientHeight / 2);
    setRecenterWorld(null);
    // recenterWorld is intentionally consumed then dropped — it's a one-shot
    // instruction for this effect, not part of steady-state render inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, world]);

  function changeZoom(nextZoom) {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    if (clamped === zoom) return;
    const viewport = viewportRef.current;
    if (viewport && world) {
      const centerPixel = { x: viewport.scrollLeft + viewport.clientWidth / 2, y: viewport.scrollTop + viewport.clientHeight / 2 };
      setRecenterWorld(pixelToWorld(centerPixel, world, zoom));
    }
    setZoom(clamped);
  }

  function toggleType(id) {
    setEnabledTypes((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleCanvasClick(event) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const found = nearestMarker(canvasPositioned, point, 8);
    if (found) setSelectedMarker(found);
  }

  const size = mapSizeAtZoom(zoom);
  const tilesPerSide = 2 ** zoom;

  return (
    // h-screen (not min-h-screen) + min-h-0 on the row below is load-bearing:
    // the tile grid at deep zoom is thousands of px tall, and without an
    // explicit height bound here, a flex child's default min-height:auto lets
    // it grow to fit that content instead of scrolling internally — the inner
    // overflow-auto viewport silently stops clipping and the whole page
    // scrolls instead, which also throws off the marker-info-panel's
    // "bottom of the pane" positioning (it ends up thousands of px below the
    // fold). Confirmed by an actual headless-Chrome render, not assumed.
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex flex-wrap items-center gap-4 border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-500"
        >
          ← Back
        </button>
        <h2 className="text-lg font-semibold text-zinc-100">Map</h2>
        {mapState.status === 'ready' && (
          <span className="text-xs text-zinc-500">
            {mapState.data.markers.length.toLocaleString()} markers, {mapState.data.types.length} layers
          </span>
        )}
        <div className="ml-auto">
          <ZoomControl zoom={zoom} onChange={changeZoom} />
        </div>
      </header>

      {mapState.status === 'loading' && (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Loading map data…</div>
      )}

      {mapState.status === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-red-400">
          <div>Failed to load the map: {mapState.message}</div>
          <button
            type="button"
            onClick={() => setRetryToken((t) => t + 1)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:border-zinc-500"
          >
            Retry
          </button>
        </div>
      )}

      {mapState.status === 'ready' && (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside className="w-64 shrink-0 overflow-y-auto border-r border-zinc-800 bg-zinc-900/40 px-4 py-4">
            <LayerControl groupedTypes={groupedTypes} enabledTypes={enabledTypes} onToggle={toggleType} manifest={manifest} />
            {hasHabitats && (
              <HabitatPicker
                pals={pals}
                focusPal={focusPal}
                onFocusPalChange={setFocusPal}
                dayNight={dayNight}
                onDayNightChange={setDayNight}
                habitatState={habitatState}
              />
            )}
          </aside>

          <div className="relative flex-1 overflow-hidden">
            <div ref={viewportRef} className="h-full w-full overflow-auto bg-black">
              <div style={{ position: 'relative', width: size, height: size }}>
                {Array.from({ length: tilesPerSide }, (_, ty) =>
                  Array.from({ length: tilesPerSide }, (_, tx) => (
                    <img
                      key={`${tx}-${ty}`}
                      src={assetUrl(manifest, `tiles/z${zoom}x${tx}y${ty}.webp`)}
                      alt=""
                      loading="lazy"
                      draggable={false}
                      style={{ position: 'absolute', left: tx * TILE_SIZE, top: ty * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE }}
                    />
                  )),
                )}

                <canvas
                  ref={canvasRef}
                  onClick={handleCanvasClick}
                  style={{ position: 'absolute', left: 0, top: 0, width: size, height: size }}
                />

                {domPositioned.map(({ marker, x, y }) => (
                  <button
                    key={markerKey(marker)}
                    type="button"
                    onClick={() => setSelectedMarker(marker)}
                    title={marker.name}
                    style={{
                      position: 'absolute',
                      left: x - MARKER_ICON_SIZE / 2,
                      top: y - MARKER_ICON_SIZE / 2,
                      width: MARKER_ICON_SIZE,
                      height: MARKER_ICON_SIZE,
                    }}
                    className="rounded-full bg-zinc-950/70 ring-1 ring-black/50 hover:ring-2 hover:ring-white focus:outline-none focus:ring-2 focus:ring-white"
                  >
                    <img
                      src={markerIconUrl(typesById.get(marker.type)?.icon)}
                      alt={marker.type}
                      loading="lazy"
                      draggable={false}
                      className="h-full w-full rounded-full object-contain p-0.5"
                    />
                  </button>
                ))}
              </div>
            </div>

            <MarkerInfoPanel marker={selectedMarker} typesById={typesById} items={items} onClose={() => setSelectedMarker(null)} />
          </div>
        </div>
      )}
    </div>
  );
}
