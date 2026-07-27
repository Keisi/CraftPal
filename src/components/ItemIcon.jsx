import { useState } from 'react';
import { useGame } from '../lib/GameContext.js';

// Icon with a graceful fallback for missing files (real icons land in
// Phase 3's scraper — see PLAN.md §2). Shared by the item grid (App.jsx),
// tree node cards, station chips, and the raw-materials strip so the
// fallback pattern lives in exactly one place.
//
// `src` is the path stored in the data (e.g. "icons/assault_rifle.webp"),
// relative to the loaded game's own asset folder — resolving the actual URL
// needs the manifest's `assetBase` (PLAN.md §9), e.g.
// BASE_URL + "games/palworld/" + "icons/assault_rifle.webp".
export function ItemIcon({ src, alt, className = 'h-16 w-16' }) {
  const { manifest } = useGame();
  const [errored, setErrored] = useState(false);

  if (errored || !src) {
    return (
      <div
        className={`flex ${className} shrink-0 items-center justify-center rounded-md bg-zinc-800 text-[10px] text-zinc-500`}
      >
        no icon
      </div>
    );
  }

  return (
    <img
      src={`${import.meta.env.BASE_URL}${manifest.assetBase}${src}`}
      alt={alt}
      // The browse grid renders ~1600 cards; eager loading would pull the
      // whole ~14 MB icon set on first paint.
      loading="lazy"
      decoding="async"
      className={`${className} shrink-0 rounded-md bg-zinc-800 object-contain p-1`}
      onError={() => setErrored(true)}
    />
  );
}
