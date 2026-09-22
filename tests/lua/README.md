# tLib Lua suites

```bash
bun run test:lua                                              # all of them
bunx --bun --package fengari-node-cli fengari scripts/run-lua-suite.lua tests/lua/engine-theme.lua
```

Run from the tLib resource root: a suite loads the engine with a relative path
(`client/lib/menu/...`), so the working directory is part of the contract. They execute the
real modules off disk against stub hosts — no FiveM, no browser, no consumer.

## What belongs here

Oracles for behaviour tLib itself owns. The menu engine is the case that exists
today: `engine-actions` (client dispatch and the effect scheduler), `engine-catalog`
(descriptor validation, hydration, cross-owner ordering), `engine-context`
(presenters, cache keying, context keys), `engine-funcref` (every gate that accepts
a callback, fed the funcref table the host actually delivers instead of a function)
`engine-theme` (the branding validator and the three theme layers) and
`adapter-nui` (the FiveM NUI adapter's reply encoding — the one link in the
menu's round trip that is host code rather than engine code, and the link every
other suite here stubs).

The test of whether a suite belongs here is whether it would still mean something
with every consumer of tLib deleted. These six would; they name resources like
`alpha`, `blue_resource` and `cooldown_plugin` that exist only inside the suite.

## What does not

A suite that drives the engine with a *consumer's* real menu tree is an oracle for
that consumer's integration, not for the engine, and it lives in that resource.
tMenu keeps several of those (`engine-client`, `engine-server`, `registry-authority`,
`schema-port-equivalence`) and runs this directory first, before its own, so an
engine regression is reported by the suite that isolates it rather than by the fifty
that inherit it.

Comments here may mention a consumer by name when they are explaining history — why
an invariant had to be written down once the engine stopped having exactly one user.
Nothing in the code under `lua/menu` may.
