--[[
    tLib — the Sounds tab of a settings dialog (client)

        local fields = {}
        tlib.soundfields.append(fields, { config = soundConfig, noun = 'detector' })

        -- in onChange:
        local soundKey = tlib.soundfields.keyOf(fieldId)
        if soundKey then ... end

        -- on submit/cancel, and when the viewer turns out not to be an admin:
        tlib.soundfields.clear()

        -- when the server pushes a new sound config:
        tlib.soundfields.refresh('tdet_settings', data)

     The remembered key list is the whole reason this is a module

      * The live refresh keys off what was DRAWN, not off the current config, so
        a sound key added server-side after the dialog opened has no control to
        patch and simply appears the next time the dialog is opened. Refreshing
        from the config instead would address a field that does not exist.
      * The list must be CLEARED on submit, on cancel, and when the viewer turns
        out not to be an admin (in which case `append` never ran at all). Left
        set, a refresh patches a dialog that is not open.

]]

local SoundFields = {}

-- `SOUND_FIELD_PREFIX` is how a dialog's onChange tells these dynamic fields
-- apart from its fixed ones. The key is whatever FOLLOWS it, so a key
-- containing a colon still round-trips.
local SOUND_FIELD_PREFIX = 'sound:'

-- The empty option IS the old "Clear" button. A select cannot express "no
-- value" without an option carrying it, and tLib's validValue only accepts ''
-- for a non-required field, which these are.
local SOUND_NONE = { value = '', label = '— none —' }

--- The sound keys the OPEN dialog drew a field for, in the order it drew them.
--- Empty when no dialog is open or the viewer is not an admin.
local drawnKeys = {}

--- The options for one sound select.
---
--- @param sc table  a sound config: { installedSounds = {...}, soundWavMap = {...} }
--- @param mapped string|nil  the filename this key currently points at
local function buildSoundOptions(sc, mapped)
    local opts = { SOUND_NONE }
    local seen = {}
    for _, sound in ipairs(sc.installedSounds or {}) do
        local filename = type(sound) == 'table' and sound.filename or nil
        if type(filename) == 'string' and filename ~= '' and not seen[filename] then
            seen[filename] = true
            opts[#opts + 1] = { value = filename, label = filename }
        end
    end
    -- A mapping can outlive the file it names -- an admin removes a sound and the
    -- key still points at it. Without this the select would render blank and read
    -- as "unmapped", which is a lie: the server still has the mapping and the
    -- layout still tries to play it. Shown, and labelled as the problem it is.
    if type(mapped) == 'string' and mapped ~= '' and not seen[mapped] then
        opts[#opts + 1] = { value = mapped, label = mapped .. '  (missing)' }
    end
    return opts
end

local function soundKeys(sc)
    local keys = {}
    for _, key in ipairs(sc.defaultSoundKeys or {}) do
        if type(key) == 'string' and key ~= '' then keys[#keys + 1] = key end
    end
    table.sort(keys)
    return keys
end

--- The field id this module would draw for one sound key.
--- @param key string
--- @return string
function SoundFields.fieldId(key)
    return SOUND_FIELD_PREFIX .. key
end

--- The sound key a field id names, or nil if the id is not one of ours.
--- @param fieldId string|nil
--- @return string|nil
function SoundFields.keyOf(fieldId)
    if type(fieldId) ~= 'string' then return nil end
    if fieldId:sub(1, #SOUND_FIELD_PREFIX) ~= SOUND_FIELD_PREFIX then return nil end
    local key = fieldId:sub(#SOUND_FIELD_PREFIX + 1)
    if key == '' then return nil end
    return key
end

--- Forget what the last dialog drew. Call on submit, on cancel, and when the
--- viewer turns out not to be an admin.
function SoundFields.clear()
    drawnKeys = {}
end

--- @return string[]
function SoundFields.drawn()
    local out = {}
    for i, k in ipairs(drawnKeys) do out[i] = k end
    return out
end

--- Append the Sounds tab's fields to a dialog field list.
---
--- @param fields table  the dialog's field list, appended to in place
--- @param opts table    { config = <sound config>, noun = 'detector', tab = 'sounds' }
--- @return string[]  the keys drawn, in order
function SoundFields.append(fields, opts)
    assert(type(fields) == 'table', 'tlib.soundfields.append: fields must be a table')
    opts = opts or {}
    local sc   = type(opts.config) == 'table' and opts.config or {}
    local tab  = opts.tab or 'sounds'
    local noun = opts.noun or 'resource'
    local map  = type(sc.soundWavMap) == 'table' and sc.soundWavMap or {}
    local keys = soundKeys(sc)
    drawnKeys = keys

    if #keys == 0 then
        -- A disabled control rather than no tab: an empty panel under a tab the
        -- player just clicked reads as a broken menu, not as "nothing to map".
        fields[#fields + 1] = {
            id          = 'soundsEmpty',
            type        = 'text',
            label       = 'Sound Mappings',
            description = 'No sound keys are configured on this server yet.',
            disabled    = true,
            tab         = tab,
        }
        return keys
    end

    for index, key in ipairs(keys) do
        local mapped = type(map[key]) == 'string' and map[key] or ''
        fields[#fields + 1] = {
            id           = SOUND_FIELD_PREFIX .. key,
            type         = 'dropdown',
            label        = key,
            options      = buildSoundOptions(sc, mapped),
            defaultValue = mapped,
            tab          = tab,
            section      = index == 1
                and ('Sound Mappings — map %s events to installed sound files. Unmapped keys play nothing.')
                    :format(noun)
                or nil,
        }
    end
    return keys
end

--- Keep an OPEN Sounds tab current.
---
---
--- A no-op when no dialog is open, which is what makes it safe to call from an
--- unconditional event handler.
---
--- @param dialogId string  the dialog the fields live in
--- @param data table       the sound config that just arrived
--- @param patch fun(dialogId: string, fieldId: string, patch: table)|nil
---        injection seam for tests; defaults to tLib's UpdateDialogField export
--- @return number  how many fields were patched
function SoundFields.refresh(dialogId, data, patch)
    if #drawnKeys == 0 or type(data) ~= 'table' then return 0 end
    if type(dialogId) ~= 'string' or dialogId == '' then return 0 end

    patch = patch or function(id, fieldId, p)
        exports['tLib']:UpdateDialogField(id, fieldId, p)
    end

    local map = type(data.soundWavMap) == 'table' and data.soundWavMap or {}
    local n = 0
    for _, key in ipairs(drawnKeys) do
        local mapped = type(map[key]) == 'string' and map[key] or ''
        -- Options before value: UpdateDialogField validates defaultValue against
        -- the options in the SAME patch, so a filename installed since the
        -- dialog opened would be rejected if the two were sent separately.
        patch(dialogId, SOUND_FIELD_PREFIX .. key, {
            options      = buildSoundOptions(data, mapped),
            defaultValue = mapped,
        })
        n = n + 1
    end
    return n
end

return SoundFields
