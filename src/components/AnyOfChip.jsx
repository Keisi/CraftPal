import { useGame } from '../lib/GameContext.js';
import { ItemIcon } from './ItemIcon.jsx';

// "Any of a set" disclosure (schema v3 axis 1, PLAN.md §1 decision 3 /
// CLAUDE.md "Known schema limit"): an ingredient slot that collapsed a
// multi-member tag/array down to one representative still needs to say so
// truthfully, without turning into dozens of extra tree branches. Renders as
// a compact chip ("any Log (48)", or "any of 40" when the slot had no tag
// name to derive a label from) that discloses the real option list INLINE —
// a native <details>/<summary> element, so expand/collapse is keyboard- and
// screen-reader-accessible for free (no custom ARIA wiring needed).
//
// Game-agnostic on purpose (PLAN.md §9): Palworld data never sets `anyOf` on
// an ingredient, so this component never renders anything for it — nothing
// here names Minecraft. Shared by both tree views (TreeNode.jsx's diagram
// cards, TreeRows.jsx's compact rows), which is why it stops click/keydown
// propagation itself rather than relying on the caller's layout to keep it
// out of a clickable collapse-toggle region.
export function AnyOfChip({ anyOf, anyOfLabel, compact = false }) {
  const { items } = useGame();

  // Decision 3: never rendered for a single concrete item — absent/short
  // anyOf is "no choice", not a substitution set to disclose.
  if (!Array.isArray(anyOf) || anyOf.length < 2) return null;

  const summary = anyOfLabel ? `any ${anyOfLabel} (${anyOf.length})` : `any of ${anyOf.length}`;

  return (
    <details
      className="group relative"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <summary
        title="Any of these are acceptable substitutes for this ingredient"
        className={`inline-flex cursor-pointer list-none items-center gap-1 rounded-full border border-dashed border-zinc-600 bg-zinc-800/70 text-zinc-400 transition-colors hover:border-zinc-400 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 [&::-webkit-details-marker]:hidden ${
          compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]'
        }`}
      >
        <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">
          ▸
        </span>
        {summary}
      </summary>

      <div className="absolute left-0 top-full z-10 mt-1 max-h-48 w-56 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 p-2 text-left shadow-lg">
        <ul className="flex flex-col gap-1">
          {anyOf.map((itemId) => {
            const item = items[itemId];
            return (
              <li key={itemId} className="flex items-center gap-1.5">
                <ItemIcon src={item?.icon} alt={item?.name ?? itemId} className="h-4 w-4" />
                <span className="truncate text-xs text-zinc-200">{item?.name ?? itemId}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
