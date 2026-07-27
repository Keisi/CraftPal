import { items, stations, manifest, pals } from './lib/data.js';
import { GameContext } from './lib/GameContext.js';

// The single place src/lib/data.js is imported (PLAN.md §9, coupling #6).
// Every other component reads the loaded game's items/stations/manifest/pals
// via useGame() (src/lib/GameContext.js) instead of importing that singleton
// directly, which is what actually decouples the component tree from "there
// is exactly one dataset, bound at build time."
export function GameProvider({ children }) {
  return <GameContext.Provider value={{ items, stations, manifest, pals }}>{children}</GameContext.Provider>;
}
