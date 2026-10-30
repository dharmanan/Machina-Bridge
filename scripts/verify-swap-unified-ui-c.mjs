// Shard c of verify-swap-unified-ui (group ranges and the coverage guard live in that file).
process.env.MACHINA_SWAP_SHARD = 'c'
await import('./verify-swap-unified-ui.mjs')
