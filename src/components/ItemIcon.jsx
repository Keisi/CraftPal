import { useState } from 'react';

// Icon with a graceful fallback for missing files (real icons land in
// Phase 3's scraper — see PLAN.md §2). Shared by the item grid (App.jsx),
// tree node cards, station chips, and the raw-materials strip so the
// fallback pattern lives in exactly one place.
export function ItemIcon({ src, alt, className = 'h-16 w-16' }) {
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
      src={`${import.meta.env.BASE_URL}${src}`}
      alt={alt}
      className={`${className} shrink-0 rounded-md bg-zinc-800 object-contain p-1`}
      onError={() => setErrored(true)}
    />
  );
}
