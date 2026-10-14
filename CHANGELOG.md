# Changelog

**0.6 is the only tLib that was ever released.** 0.7 through 0.17 were never
shipped to anyone — they are development milestones in this tree, kept below
because they are the clearest way to group what 1.0.0 contains. Nothing in the
world runs one of them.

So there is no compatibility surface between 0.6 and 1.0.0, nothing to deprecate
forward, and a consumer pin below `1.0` is meaningless. Every consumer pins
`tlib_min_version '1.0'`. Where a note below says "nothing that worked against
0.15.0 behaves differently", it is describing the shape of a change within this
tree, not a promise to an installed base — do not reintroduce a fallback on the
strength of one.

Each entry below records what was absorbed and the one fact about it that is
expensive to rediscover. The modules themselves carry the rest.

## 1.0.0

### The deprecation machinery is gone

Three facilities existed only to keep an older spelling working. 1.0.0 removes
all three, and nothing in this tree calls any of them.

| Gone | Use instead |
| --- | --- |
| `tlib.net.retired.*` (`fromClient`, `fromServer`, `toClient`, `trigger`) | `tlib.net.fromClient` / `fromServer` under the one canonical name. Rename the event in both resources |
| `tlib.access.migrate(block, legacy, opts)` | Write `Config.access` directly. tRadar and tDetector had already dropped their calls |
| `tlib.config.check`'s `deprecated = { old = { replacement, removeIn } }` spec field | Delete the entry. An old key now falls through to the unknown-key warning, which names it and suggests the closest real key |

`removeIn` is no longer read anywhere. A spec still passing `deprecated` is
ignored silently, so delete the field rather than leaving it.

`tlib.net.fromClient` and `fromServer` stay — they are the source and rate-limit
guards, not compatibility.

### `drivenprop` — uniform scale for a prop attached to a vehicle

There is no `SetEntityScale`; the native is `nil` on a live Enhanced client.
Scale is carried in the basis-vector lengths of `SetEntityMatrix`, and the engine
does not renormalise what you write.

Scale does not survive `AttachEntityToEntity`, and **a same-tick read-back
reports success falsely** — it reads 3.000 in the same tick and 1.000 on the next
frame. Driving the matrix every frame while attached loses it too. The entity
never detaches (`IsEntityAttached` stays true); attachment rebuilds the basis
from the parent's matrix and has no notion of a scale. Only an unattached, frozen
prop holds a scale, so every assertion about scale spans at least one frame.

Three things in the module are load-bearing, each commented where it is enforced:

- **The rotation convention is measured, not assumed.** `localRotation`
  reproduces `AttachEntityToEntity`'s own reading of (rx, ry, rz) as three
  right-handed rotations composed Rz·Ry·Rx. Getting it wrong reorients every
  existing placement the moment it gains a scale.
- **Handedness is asserted, not commented.** A left-handed basis renders the mesh
  inside-out and cannot be caught by reading the matrix back, because a sign does
  not change a length.
- **A unit-scaled prop still attaches.** Per-frame cost is paid only by
  placements that ask for a scale.

`vehicleprop`'s orphan sweep had to change with it: it asked
`attached[GetEntityAttachedTo(obj)] ~= obj`, which reads 0 for a scaled prop
(attached to nothing by design) and deleted every one of them on sight. It now
asks the tracking table directly.

### Four more cross-resource duplications absorbed

All additive — no consumer has been migrated onto them yet, and migrating them is
its own pass with its own breaking-change list.

**`permission.onChange`** (`shared/imports/permission/client.lua`, a new file —
the module was server-only). Three resources carried the same six lines mirroring
`tLib:receiveAdminPermission` byte for byte, and tAFK carried none, which is why
revoking a player's `tlib.admin` on a running server left their panel drawing the
admin section until they reconnected.

Two things in it are deliberate and a copy gets both wrong. It **seeds** from
`exports.tLib:GetPermissionLevel()`, because a module loading lazily on a
consumer's first `onChange` has already missed tLib's own startup reply. And the
first answer fires a listener **even when it is 0**, because a listener
registered before any answer has not run yet; without that, a panel built for a
non-admin is never drawn at all.

It also unblocks the largest rename in the estate: the wire name appears once in
the module and nowhere in its interface, so once the three consumers are migrated
the rename to `tlib:permission:receive` becomes an internal edit. Until then it
cannot be touched.

**`net`** (`shared/imports/net/{client,server}.lua`). The `source ~= 65535`
server-only-event guard, open-coded in every client net handler across six
resources. It was a convention, and a convention can be forgotten — tRadar
guarded two of three adjacent events.

A rejection is **reported once per event name per session**, not dropped
silently: the two things that produce one are a resource firing a server-only
event locally by mistake (otherwise completely invisible, since the handler just
never runs) and something spoofing it. Once per name, because anything printing
per call hands an attacker a console flood as the payload.

`net.fromClient` is where `tlib.ratelimit` composes — the client guard has
nothing to compose with, since ratelimit's buckets are keyed by player and swept
on `playerDropped`. The rate limit **defaults on** at 1000 ms, because an
unlimited request-shaped handler is a free amplifier: a few bytes in, a framework
job lookup and a whole panel payload out.

**`opengate`** (`shared/imports/opengate/{client,server}.lua`). The
`requestOpenSettings` → `openSettings` / `accessDenied` handshake, in three
near-identical implementations, one of them half-built with a client side that was
never written, so both of its events were dead.

It carries two pieces of knowledge only tRadar had. **The decision order** is
rate limit, then `configOk`, then `allow`: a broken config is not a permissions
problem, and answering "you are not allowed" to a player on a misconfigured
server sends them to the wrong person — which is also why a missing `onBroken` on
the client is never routed to `onDenied`. And **`panel:reopen()`**, because the
request path is rate-limited to one call per second on the server and drops the
extra silently, so an admin who opened the 3D prop editor and cancelled straight
away would get nothing back. It replays the grant the server already gave and
makes no round trip.

`allow` is **required** with no default, because a missing option quietly meaning
"open" is how a gate meant to restrict something ends up granting it. A panel
genuinely open to everyone writes `allow = function() return true end`, which
mirrors `tlib.access`'s own `mode = 'everyone'` and is greppable in a way an
absent option is not.

**`permission.hasAll`** — the one shape tMenu's `shared/ace.lua` had that the
module did not. Over `hasBatch`, so a four-key gate is still one round trip. Not
a drop-in for `TMenuAceAllowed`: that reads ACE directly, this goes through tLib,
where a registered framework resolver outranks ACE.

The suites for these drive the **real** `tlib.ratelimit` and `tlib.net` rather
than stubs, because composition is the whole reason the server halves exist and a
stubbed bucket proves the call was made and nothing about whether it refuses.
Each asserts the source guard against the set of plausible weakenings rather than
one representative value: a nil source (which passes `if source and source ~=
65535`), the string `'65535'` (which passes a tostring comparison) and `0` (which
passes a truthiness test). Nothing here is proven against a live FXServer.

## 0.16.0

**`soundfields`** (`shared/imports/soundfields/client.lua`) — the Sounds tab of a
settings dialog, carried whole by two resources. It is a module rather than a
copy because both hazards in it are ordering ones that raise nothing when you get
them wrong: the refresh must key off what was **drawn** rather than off the
arriving config (a key added server-side after the dialog opened has no control
to patch, and `UpdateDialogField` cannot report addressing a field that does not
exist), and `options` must travel in the **same patch** as `defaultValue`,
because the value is validated against the options it arrives with.

**`shared/ts/audio/wav.ts`** gains `encodeWav`/`writeWav` and
`decodeWavChannels`. This one is a deliberate **behaviour** change: of four
copies of the writer, two scaled negative samples symmetrically (`v * 32767`),
one LSB short of the int16 floor. Unifying them changes emitted bytes — on a
full-scale ramp, 11,978 of 48,000 samples, every one negative, every one by
exactly 1, −90.3 dBFS — and that delta is the bug rather than a reason not to
touch it. The 44-byte header is unchanged in every case. `decodeWavChannels`
exists because the fifth reader copy edits per channel and writes back, so
`decodeWav`'s mono downmix could not serve it.

Additive otherwise, `decodeWav`/`readWav` included — they now downmix from
`decodeWavChannels`.

## 0.15.0

The shared answer to two cross-cutting duplications a filename-based scan cannot
see: Escape ownership, and settings persistence.

**`shared/ts/escape-layer.ts`** — `createEscapeLayer()`, one Escape owner for a
page. Five resources bound Escape independently across 23 files, and three
separate mechanisms had been invented for the same question, each knowing
something the others did not: a `data-editor-modal` DOM marker (works, but every
modal is equally blocking, so a stack cannot say which is on top);
sample-ownership-on-capture (the one insight neither other had — without it a
panel that closes on keydown lets the keyup *also* hide what is underneath: one
press, two dismissals); and internal-layer-first plus an `active` gate for a
component with two mounts. The registry is all three. `registerEscapeGuard` is
the DOM marker's real content, kept because Ark UI's popovers and listboxes
handle Escape themselves and can never register.

**NUI focus release is now one sequence.** There were three orderings of
`SetNuiFocus(false,false)` and `SetNuiFocusKeepInput(false)` in this tree, two of
them in `shared/imports/platform/client.lua` itself, with two mutually
incompatible comments justifying them and no measurement. Neither can be settled
offline — those two natives are not in the native reference at all. So
`releaseNuiFocus` clears keepInput on **both** sides of the release, which is
correct under either premise, and the suite proves each two-call form leaks under
one of them while the three-call form leaks under neither.

**`platform.releaseCursorDeferred(session, current)`** folds in the defer-a-frame
release and its session-generation guard, discovered three times and present in no
shared helper. Both halves matter: `SetNuiFocus` from inside a NUI callback can
fail silently, and a UI that reopens before the thread resumes has already taken
focus synchronously, so an unguarded release revokes the new session's.

**`kvp.view(opts)` / `kvp.serverTag()` / `settings`' `serverScoped`** — the
settings-persistence half. Two forks existed, each for exactly one missing
option:

- Per-server key scoping, implemented twice in one resource (once in Lua, once in
  TypeScript). The suite pins the composed key strings as byte-identical to both
  forks: they are persisted on players' machines, so a shared implementation that
  namespaced them differently would pass every behavioural test and silently reset
  everyone on upgrade.
- A namespace plus reads that answer `nil` rather than a type zero, for tri-state
  prefs. `prefix` + `nilWhenUnset`.

One safety divergence was resolved to the stricter side while moving: a tag that
hashed an unresolved endpoint to `00001505` (djb2's seed) — a plausible-looking
tag for no server. An empty endpoint now yields no tag and the key stays
unscoped.

Additive: `kvp.key(key)` with no options, and every existing accessor, are
byte-for-byte what they were. The module's own accessors **are** a no-option view,
so `tlib.kvp.getBool` cannot drift from `tlib.kvp.view({}).getBool`.

**`framerelay`** (`shared/imports/framerelay/client.lua`) — the statebag relay
that puts a device's finished picture on the props of clients not running it. Two
resources had the whole mechanism each.

The **election** is the part that is expensive to rediscover and impossible to
notice missing alone: both front-seat occupants run their own NUI and both have a
frame, so two writers on one statebag key alternate two devices' pictures into
everyone else's prop. The reader's half is the pair of facts that `seq` and the
stale window exist for — a statebag is not withdrawn when its writer
disconnects, and the write only lands while the writer owns the entity, so
ownership migration stops it silently.

What stayed in the consumers is the **payload**, which is genuinely different, so
`sanitise` and `differs` are parameters. The relay touches exactly three fields:
it writes `seq` and `netId`, and it reads `powered` — a switched-off device
publishes nothing rather than an off frame, because the prop's baked artwork
already is the off state.

Its suite drives the two-client case no resource suite could reach: a correctness
regression in the election only manifests with two players in one vehicle.

**`runtimetxd`** (`shared/imports/runtimetxd/client.lua`) — the create-once
lifecycle for `CREATE_RUNTIME_TXD`. That native permanently consumes and pins one
of the game's finite `ytd` streaming slots, has no destructor bound in the engine,
and is **not idempotent across resource loads**: a second registration of a name
yields a second dictionary, and every later `AddReplaceTexture` silently resolves
to the one that does not hold the textures. The same name was observed handing out
handle 20 and handle 6 minutes apart.

That fact was written down twice and the two copies disagreed — one said the
dictionary name was "deliberately NOT tokenised" four lines above the code that
tokenises it. The copy with the measurement is what moved. `textureName` came
with it, because the rule it enforces (a runtime texture name must carry the
per-load tag) is one a name built by hand can forget.

## 0.14.0

**`diag.command`** (`shared/imports/diag/shared.lua`) — the whole of the
`<resource>_diag` console command that eight resources had written by hand, two of
them sharing 54 lines of literal copy-paste.

The report **content** stays with the consumer and is a callback; it is the half
that was never duplicated. What moves here is the half where the copies had
drifted apart on safety, and in each case the strictest copy's behaviour is now
the default:

- **Redaction**, which only two copies had at all and which four omitted on the
  grounds that "this config holds no secrets" — the exact assumption the first
  copy's own comment says is unsafe over time. It is **derived** rather than
  hand-listed: `harvest` walks the config for values under credential-looking key
  names and no line carrying one survives, so a config that gains a credential
  next year is covered without anybody editing anything.
- **The pcall guard** — "a diagnostic that dies mid-report is worse than none" —
  which now also flushes the partial report rather than discarding it.
- **Spec-derived key listing.** A hand-listed dump silently omits every key added
  after it was written.
- **`RegisterCommand(..., true)`**, applied here so copy nine cannot forget it.

Routing is the union of the three the copies had, not a pick between them: the
server console always (it is the copy that survives the caller disconnecting) and
the caller too when there was one.

**`marketplace.standardTypes` / `registerType` / `soundConflict`**
(`shared/imports/marketplace/server.lua`). Four resources each declared the same
two item types at the same two install paths inside the same pcall wrapper, then
branched a pair of lifecycle handlers on an event name that was nothing but their
own resource name with a suffix. `soundConflict` is why it is worth a module
rather than a comment: the sound-overwrite warning was fired at `-1` — every
player on the server, about an admin action — and in three of the four nothing
anywhere registered the event. The targeted send at `meta.src`, and the
unconditional server log that has to survive the admin disconnecting mid-install,
are now one implementation.

Additive: `diag`'s existing wrap/fatal/error/warn/info are untouched, as is
marketplace's upsertSound/removeSound/migrateBuiltinSlugs.

## 0.13.0

**`vehicleprop`** (`shared/imports/vehicleprop/shared.lua`) — the whole of the
in-vehicle prop: model registry, placement store, ownership mark and the lifecycle
pass, which two resources each carried as their own 591-line `cl_props.lua`.
Normalising only the prefix, the model name and the device noun left 80 differing
lines between the two, every one of them comment prose or whitespace. It is
`shared.lua` rather than `client.lua` because the registry rules are asked on both
sides: the client builds it to decide what to spawn, the server to decide what a
save may store.

**`ratelimit`** (`shared/imports/ratelimit/server.lua`) — the twelve-line
per-player floor on request-shaped net events that existed as seven byte-identical
copies. The disconnect sweep is inside it, because that is the half a hand-written
copy forgets; without it every bucket keeps one timestamp per player who has ever
connected, for the life of the server.

**`access.gate` now sweeps itself on `playerDropped`.** `Gate:allowed` memoises
one answer per player it is ever asked about and the TTL only makes an entry
stale, so every gate was a slow leak; exactly two resources had noticed and swept
their own by hand. A behaviour change, but only in the direction of a gate
re-evaluating sooner for a player who left and came back.

**`jsonstore`** (`shared/imports/jsonstore/server.lua`) — *the* writer of a
consumer's `data.json`. Two resources' `sv_data.lua` were identical in all 46 code
lines, a third had the same shape, and `soundstore` wrote two sections of the same
document: four writers, safe together only because of an invariant restated in
prose in two headers. `open` memoises per resource-and-file and `soundstore` now
goes through it, so there is one writer, one re-entrancy flag and one queue — the
invariant is removed rather than restated. `soundstore`'s own API is unchanged.

Additive otherwise.

## 0.12.0

Two things a consumer can need and cannot probe for:

- **`tLib:HasPermissionBatch`** resolves many permission keys in one export round
  trip. One resource was making 40+ consecutive export calls per permission
  resolution, which a profiler attributed ~5.2 ms to.
- **The optional `validate` content contract** on a marketplace install target,
  so a consumer can refuse a bundle that is safe to extract but is not a valid
  instance of its own item type.

Both additive. The pin that makes them safe to call is `tlib_min_version '1.0'`,
which `imports.lua`'s header calls the real guarantee: a capability probe cannot
report its own absence.
