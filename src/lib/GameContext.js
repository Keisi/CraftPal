// React context carrying the loaded game's dataset (PLAN.md §9, coupling
// #6). <GameProvider> (src/GameProvider.jsx) is the ONLY place that imports
// src/lib/data.js; every other component reads {items, stations, manifest}
// through useGame() instead of importing a data singleton directly. That's
// what makes a future runtime game switch (rather than today's build-time
// VITE_GAME pick) possible without touching component code.

import { createContext, useContext } from 'react';

export const GameContext = createContext(null);

/**
 * @returns {{items: object, stations: object, manifest: object, pals: (object|undefined)}}
 */
export function useGame() {
  const value = useContext(GameContext);
  if (!value) {
    throw new Error('useGame() must be used within <GameProvider>');
  }
  return value;
}
