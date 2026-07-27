import { useState } from 'react'
import data from './data/items.json'

// Rarity badge colors matching Palworld convention.
const RARITY_STYLES = {
  common: 'bg-gray-500/20 text-gray-300 border-gray-500/40',
  uncommon: 'bg-green-500/20 text-green-300 border-green-500/40',
  rare: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  epic: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  legendary: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
}

function RarityBadge({ rarity }) {
  const classes = RARITY_STYLES[rarity] ?? RARITY_STYLES.common
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${classes}`}>
      {rarity}
    </span>
  )
}

function CategoryBadge({ category }) {
  return (
    <span className="rounded-full border border-zinc-600/60 bg-zinc-700/40 px-2 py-0.5 text-xs font-medium capitalize text-zinc-300">
      {category}
    </span>
  )
}

// Icon with a graceful fallback for missing files (real icons land in Phase 3).
function ItemIcon({ src, alt }) {
  const [errored, setErrored] = useState(false)

  if (errored || !src) {
    return (
      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-[10px] text-zinc-500">
        no icon
      </div>
    )
  }

  return (
    <img
      src={`/${src}`}
      alt={alt}
      className="h-16 w-16 shrink-0 rounded-md bg-zinc-800 object-contain p-1"
      onError={() => setErrored(true)}
    />
  )
}

function ItemCard({ id, item }) {
  return (
    <div
      key={id}
      className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-sm transition-colors hover:border-zinc-700"
    >
      <div className="flex items-center gap-3">
        <ItemIcon src={item.icon} alt={item.name} />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium text-zinc-100">{item.name}</span>
          <div className="flex flex-wrap gap-1.5">
            <CategoryBadge category={item.category} />
            <RarityBadge rarity={item.rarity} />
          </div>
        </div>
      </div>
    </div>
  )
}

function App() {
  const items = Object.entries(data.items)

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
        <h1 className="text-2xl font-semibold tracking-tight">Paltree</h1>
        <p className="text-sm text-zinc-400">Palworld crafting-tree explorer</p>
      </header>

      <main className="px-6 py-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {items.map(([id, item]) => (
            <ItemCard key={id} id={id} item={item} />
          ))}
        </div>
      </main>
    </div>
  )
}

export default App
