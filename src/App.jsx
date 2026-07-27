import { useState } from 'react'
import data from './data/items.json'
import { ItemIcon } from './components/ItemIcon.jsx'
import { CraftTree } from './components/CraftTree.jsx'
import { RawSummary } from './components/RawSummary.jsx'
import { rarityBadgeClass } from './lib/rarity.js'

function RarityBadge({ rarity }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${rarityBadgeClass(rarity)}`}>
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

function ItemCard({ id, item, onSelect }) {
  return (
    <div
      key={id}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(id)
        }
      }}
      className="flex cursor-pointer flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-sm transition-colors hover:border-zinc-600 hover:ring-1 hover:ring-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-500"
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

function TreeHeader({ item, qty, onQtyChange, onBack }) {
  return (
    <header className="flex flex-wrap items-center gap-4 border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
      <button
        type="button"
        onClick={onBack}
        className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-500"
      >
        ← All items
      </button>

      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-zinc-100">{item.name}</h2>
        <RarityBadge rarity={item.rarity} />
      </div>

      <label className="ml-auto flex items-center gap-2 text-sm text-zinc-400">
        Qty
        <input
          type="number"
          min={1}
          step={1}
          value={qty}
          onChange={(event) => {
            const next = Math.floor(Number(event.target.value))
            onQtyChange(Number.isFinite(next) && next >= 1 ? next : 1)
          }}
          className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500"
        />
      </label>
    </header>
  )
}

function App() {
  const items = data.items
  const entries = Object.entries(items)
  const [selectedId, setSelectedId] = useState(null)
  const [qty, setQty] = useState(1)

  const selectedItem = selectedId ? items[selectedId] : null

  function handleSelect(id) {
    setSelectedId(id)
    setQty(1)
  }

  if (selectedItem) {
    return (
      <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
        <TreeHeader
          item={selectedItem}
          qty={qty}
          onQtyChange={setQty}
          onBack={() => setSelectedId(null)}
        />

        <main className="flex-1 px-6 py-6">
          <CraftTree itemId={selectedId} qty={qty} />
        </main>

        <RawSummary itemId={selectedId} qty={qty} />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
        <h1 className="text-2xl font-semibold tracking-tight">Paltree</h1>
        <p className="text-sm text-zinc-400">Palworld crafting-tree explorer</p>
      </header>

      <main className="px-6 py-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {entries.map(([id, item]) => (
            <ItemCard key={id} id={id} item={item} onSelect={handleSelect} />
          ))}
        </div>
      </main>
    </div>
  )
}

export default App
