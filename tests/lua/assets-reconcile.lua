-- Reconciling a tracked asset registry against disk. The regression that made
-- this shared: tELS and tDetector both adopted the reconciled list only when
-- its *length* changed, so a boot that removed one file and added another
-- cancelled out and applied neither.
local scanReply = nil
GetCurrentResourceName = function() return 'tELS' end
exports = { tLib = { ScanResourceFiles = function(_, _, _) return scanReply end } }
json = { decode = function(text)
    -- Enough of a decoder for the shapes ScanResourceFiles emits.
    if text == 'BAD' then error('not json') end
    return assert(load('return ' .. text))()
end }

local assets = dofile('shared/imports/assets/shared.lua')

local function names(list)
    local out = {}
    for index, record in ipairs(list) do out[index] = record.filename end
    return table.concat(out, ',')
end

-- A swap keeps the count identical. This is the case both consumers got wrong.
local tracked = { { filename = 'a.wav', slug = 'a' }, { filename = 'b.wav', slug = 'b' } }
local result, changed = assets.reconcile(tracked, { 'a.wav', 'c.wav' })
assert(changed, 'one file removed and one added is a change, whatever the count says')
assert(names(result) == 'a.wav,c.wav', 'the swap is applied in both directions')

-- Genuinely unchanged means unchanged.
result, changed = assets.reconcile(tracked, { 'a.wav', 'b.wav' })
assert(not changed, 'the same membership is not a change')
assert(names(result) == 'a.wav,b.wav')

-- Retained records are carried through, not rebuilt: consumer-owned fields survive.
tracked = { { filename = 'a.wav', slug = 'custom', label = 'Air Horn' } }
result = assets.reconcile(tracked, { 'a.wav', 'b.wav' })
assert(result[1].slug == 'custom' and result[1].label == 'Air Horn',
    'a surviving record keeps the fields its owner put on it')
assert(result[2].slug == 'b', 'a new record gets a slug derived from the filename')

-- Pruning to empty is still a change.
result, changed = assets.reconcile(tracked, {})
assert(changed and #result == 0, 'an empty disk prunes everything')

-- scan() distinguishes unreadable from empty, which is what makes the above safe.
scanReply = '{ok=true,entries={"b.wav","a.wav","notes.txt"}}'
local files, reason = assets.scan('layouts/sounds', { extensions = assets.AUDIO })
assert(reason == nil and #files == 2, 'non-audio files are filtered out')
assert(files[1] == 'a.wav' and files[2] == 'b.wav', 'results are sorted')

scanReply = '{ok=true,entries={}}'
files, reason = assets.scan('layouts/sounds', { extensions = assets.AUDIO })
assert(files and #files == 0 and reason == nil, 'an empty folder is a successful scan')

scanReply = '{ok=false,reason="read-failed"}'
files, reason = assets.scan('layouts/sounds')
assert(files == nil and reason == 'read-failed', 'a failure is reported, not flattened to empty')

scanReply = 'BAD'
files, reason = assets.scan('layouts/sounds')
assert(files == nil and reason == 'undecodable', 'an undecodable reply is a failure')

exports.tLib.ScanResourceFiles = function() error('export not registered yet') end
files, reason = assets.scan('layouts/sounds')
assert(files == nil and reason == 'unavailable',
    'tLib starting late reads as "could not look", never as "empty"')

-- sync() must refuse to prune on a failed scan.
tracked = { { filename = 'a.wav', slug = 'a' } }
local synced, syncChanged, syncReason = assets.sync(tracked, 'layouts/sounds')
assert(syncReason == 'unavailable' and not syncChanged and synced == tracked,
    'a failed scan returns the caller list untouched rather than wiping it')

print('PASS: asset reconciliation compares membership, and a failed scan never prunes')
