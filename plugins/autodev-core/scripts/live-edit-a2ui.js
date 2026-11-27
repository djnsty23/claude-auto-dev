#!/usr/bin/env node
/**
 * live-edit-a2ui.js - the checks and the data model for the choices live edit
 * draws on a page, in A2UI v1.0 message shapes (https://a2ui.org).
 *
 * WHY ONE FUNCTION. `a2uiKit` names nothing outside itself, so the overlay can
 * carry its source to the browser and run the same checks there that the
 * command line runs before a message is queued. A message the session writes
 * is refused twice if it is bad, never rendered once.
 *
 * WHAT IS IMPLEMENTED. Agent to renderer: createSurface, updateComponents,
 * updateDataModel and deleteSurface, against this module's own catalog of six
 * components (Column, Row, Text, Button, Swatch, Slider). Renderer to agent:
 * action and error. Data binding by `{"@path": JSON Pointer}` with `/` as the
 * root, as the spec reads it.
 *
 * WHAT IS REFUSED, on purpose. callRendererFunction, agentFunctionResponse and
 * callAgentFunction (no function runs on either side), `{"@call": ...}`
 * bindings, `action.functionCall`, child templates, `sendDataModel: true`,
 * surface and component metadata, any component outside the catalog, any
 * property the catalog does not name, and any URL-bearing property. The page
 * is a place a third-party script can run, so nothing the session sends may
 * execute there or fetch from elsewhere.
 */
'use strict';

/* eslint-disable no-var */
function a2uiKit() {
    var CATALOG_ID = 'https://github.com/djnsty23/claude-auto-dev/live-edit/catalog/1';
    var VERSION = '1.0';
    var ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
    var SURFACE = /^[A-Za-z0-9_-]{1,64}$/;
    var EVENT = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
    var COLOR = /^#[0-9a-fA-F]{6}$/;
    var XID = /^[\p{XID_Start}_][\p{XID_Continue}]*$/u;
    var MAX_TEXT = 500;
    var MAX_COMPONENTS = 64;
    var MAX_CHILDREN = 32;
    var MAX_SURFACES = 8;
    var MAX_DEPTH = 8;
    var MAX_SELECTOR = 200;
    var STYLE_PROPS = ['color', 'background-color', 'border-color', 'font-size', 'font-weight', 'letter-spacing', 'line-height', 'text-align',
        'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'padding-block', 'padding-inline',
        'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'margin-block', 'margin-inline',
        'gap', 'row-gap', 'column-gap', 'border-radius', 'opacity', 'max-width'];
    // A value with no function that can reach outside the page's own styles, and nothing that ends a declaration.
    var STYLE_VALUE = /^(?![\s\S]*(?:url|image|expression|var|attr|env|element|paint)\s*\()[#A-Za-z0-9 .,%()+-]{1,64}$/i;
    var VALIDATION = ['VALIDATION_FAILED', 'UNALLOWED_PARENT', 'UNALLOWED_CHILD'];
    var BLOCKED_SEGMENTS = ['__proto__', 'prototype', 'constructor'];
    var ALIGN = ['start', 'center', 'end', 'stretch'];
    var CATALOG = {
        Column: { req: ['children'], props: { children: 'ids', align: ALIGN } },
        Row: { req: ['children'], props: { children: 'ids', align: ALIGN, wrap: 'bool' } },
        Text: { req: ['text'], props: { text: 'dynString', variant: ['body', 'caption', 'heading'] } },
        Button: { req: ['child', 'action'], props: { child: 'id', action: 'action', variant: ['default', 'primary', 'borderless'], preview: 'preview' } },
        Swatch: { req: ['color', 'label', 'action'], props: { color: 'color', label: 'string', action: 'action', preview: 'preview' } },
        Slider: { req: ['value', 'max'], props: { value: 'dynNumber', min: 'number', max: 'number', steps: 'int', label: 'string', unit: ['px', 'rem', 'em', '%', ''], preview: 'stylePreview' } },
    };
    var COMMON = ['id', 'component', '@catalogId', '@accessibility'];

    var plain = function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v); };
    var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
    var bad = function (path, message, code) { return { ok: false, code: code || 'VALIDATION_FAILED', path: path, message: message }; };
    var OK = { ok: true };
    var onlyKeys = function (o, allowed, path) {
        var keys = Object.keys(o);
        for (var i = 0; i < keys.length; i++) {
            if (allowed.indexOf(keys[i]) === -1) {
                var why = keys[i].charAt(0) === '@' && keys[i].charAt(1) !== '@' ? 'is a directive live edit does not implement' : 'is not a property live edit accepts here';
                return bad(path + '/' + keys[i], '"' + keys[i] + '" ' + why);
            }
        }
        return OK;
    };
    var needKeys = function (o, required, path) {
        for (var i = 0; i < required.length; i++) if (!own(o, required[i])) return bad(path, 'missing "' + required[i] + '"');
        return OK;
    };

    // JSON Pointer, RFC 6901, with "" and "/" both the whole model, as the spec reads it.
    var segments = function (pointer) {
        if (typeof pointer !== 'string' || pointer.length > 200) return null;
        if (pointer === '' || pointer === '/') return [];
        if (pointer.charAt(0) !== '/') return null;
        var parts = pointer.slice(1).split('/');
        for (var i = 0; i < parts.length; i++) {
            if (/~(?![01])/.test(parts[i])) return null;
            parts[i] = parts[i].replace(/~1/g, '/').replace(/~0/g, '~');
            if (BLOCKED_SEGMENTS.indexOf(parts[i]) !== -1) return null;
        }
        return parts;
    };
    var getPointer = function (model, pointer) {
        var parts = segments(pointer);
        if (!parts) return undefined;
        var at = model;
        for (var i = 0; i < parts.length; i++) {
            if (at === null || typeof at !== 'object' || !own(at, parts[i])) return undefined;
            at = at[parts[i]];
        }
        return at;
    };
    // Upsert: a missing parent is created as an object, null removes the key. Returns the new root.
    var setPointer = function (model, pointer, value) {
        var parts = segments(pointer);
        if (!parts) return model;
        if (!parts.length) return plain(value) ? value : {};
        var root = plain(model) ? model : {};
        var at = root;
        for (var i = 0; i < parts.length - 1; i++) {
            if (at[parts[i]] === null || typeof at[parts[i]] !== 'object') at[parts[i]] = {};
            at = at[parts[i]];
        }
        var last = parts[parts.length - 1];
        if (value === null) { if (Array.isArray(at)) at.splice(Number(last), 1); else delete at[last]; } else at[last] = value;
        return root;
    };

    // Plain JSON: depth, string length and key names bounded, no key that could reach a prototype.
    var checkJson = function (v, path, depth) {
        if (depth > MAX_DEPTH) return bad(path, 'nested deeper than ' + MAX_DEPTH);
        if (v === null || typeof v === 'boolean') return OK;
        if (typeof v === 'number') return isFinite(v) ? OK : bad(path, 'not a finite number');
        if (typeof v === 'string') return v.length <= MAX_TEXT ? OK : bad(path, 'longer than ' + MAX_TEXT + ' characters');
        if (Array.isArray(v)) {
            if (v.length > 64) return bad(path, 'more than 64 items');
            for (var i = 0; i < v.length; i++) { var r = checkJson(v[i], path + '/' + i, depth + 1); if (!r.ok) return r; }
            return OK;
        }
        if (!plain(v)) return bad(path, 'not JSON');
        var keys = Object.keys(v);
        if (keys.length > 64) return bad(path, 'more than 64 keys');
        for (var k = 0; k < keys.length; k++) {
            if (BLOCKED_SEGMENTS.indexOf(keys[k]) !== -1 || keys[k].length > 64) return bad(path + '/' + keys[k], 'a key live edit refuses');
            var c = checkJson(v[keys[k]], path + '/' + keys[k], depth + 1);
            if (!c.ok) return c;
        }
        return OK;
    };

    var binding = function (v, path) {
        var keys = Object.keys(v);
        if (keys.length !== 1 || keys[0] !== '@path') {
            if (own(v, '@call')) return bad(path + '/@call', 'functions are not implemented by live edit');
            return bad(path, 'a binding is exactly {"@path": pointer}');
        }
        return segments(v['@path']) ? OK : bad(path + '/@path', 'not a JSON Pointer live edit accepts');
    };

    var checkKind = function (kind, v, path) {
        if (Array.isArray(kind)) return typeof v === 'string' && kind.indexOf(v) !== -1 ? OK : bad(path, 'one of ' + kind.join(', '));
        if (kind === 'ids') {
            if (!Array.isArray(v)) return bad(path, plain(v) ? 'child templates are not implemented by live edit' : 'a list of component ids');
            if (v.length > MAX_CHILDREN) return bad(path, 'more than ' + MAX_CHILDREN + ' children');
            for (var i = 0; i < v.length; i++) if (typeof v[i] !== 'string' || !ID.test(v[i])) return bad(path + '/' + i, 'not a component id');
            return OK;
        }
        if (kind === 'id') return typeof v === 'string' && ID.test(v) ? OK : bad(path, 'not a component id');
        if (kind === 'string') return typeof v === 'string' && v.length <= MAX_TEXT ? OK : bad(path, 'a string of at most ' + MAX_TEXT + ' characters');
        if (kind === 'dynString') return plain(v) ? binding(v, path) : checkKind('string', v, path);
        if (kind === 'number') return typeof v === 'number' && isFinite(v) ? OK : bad(path, 'a finite number');
        if (kind === 'dynNumber') return plain(v) ? binding(v, path) : checkKind('number', v, path);
        if (kind === 'int') return typeof v === 'number' && Math.floor(v) === v && v >= 1 && v <= 1000 ? OK : bad(path, 'a whole number from 1 to 1000');
        if (kind === 'bool') return typeof v === 'boolean' ? OK : bad(path, 'true or false');
        if (kind === 'color') return typeof v === 'string' && COLOR.test(v) ? OK : bad(path, 'a colour as #rrggbb');
        if (kind === 'action') return checkAction(v, path);
        if (kind === 'preview') return checkPreview(v, path);
        if (kind === 'stylePreview') return checkStylePreview(v, path);
        return bad(path, 'unknown kind');
    };

    var checkAction = function (v, path) {
        if (!plain(v)) return bad(path, 'an action object');
        if (own(v, 'functionCall')) return bad(path + '/functionCall', 'function calls are not implemented by live edit');
        var r = onlyKeys(v, ['event'], path);
        if (!r.ok) return r;
        if (!plain(v.event)) return bad(path + '/event', 'an action is {"event": {"name": ...}}');
        r = onlyKeys(v.event, ['name', 'context', 'userMessage'], path + '/event');
        if (!r.ok) return r;
        if (typeof v.event.name !== 'string' || !EVENT.test(v.event.name)) return bad(path + '/event/name', 'an event name of letters, digits, _ . -');
        if (own(v.event, 'userMessage') && (r = checkKind('string', v.event.userMessage, path + '/event/userMessage')) && !r.ok) return r;
        if (!own(v.event, 'context')) return OK;
        if (!plain(v.event.context)) return bad(path + '/event/context', 'an object');
        var keys = Object.keys(v.event.context);
        if (keys.length > 16) return bad(path + '/event/context', 'more than 16 keys');
        for (var i = 0; i < keys.length; i++) {
            var p = path + '/event/context/' + keys[i];
            var val = v.event.context[keys[i]];
            if (!ID.test(keys[i])) return bad(p, 'a context key is an identifier');
            if (plain(val)) { r = binding(val, p); if (!r.ok) return r; continue; }
            if (val === null || typeof val === 'boolean' || (typeof val === 'number' && isFinite(val))) continue;
            r = checkKind('string', val, p);
            if (!r.ok) return r;
        }
        return OK;
    };

    var checkSelector = function (v, path) {
        // Selectors only ever reach querySelectorAll. ">" is a combinator the overlay itself
        // writes when the owner points at an element, so it must pass.
        return typeof v === 'string' && v.length > 0 && v.length <= MAX_SELECTOR && !/[{}<]/.test(v) ? OK : bad(path, 'a CSS selector of at most ' + MAX_SELECTOR + ' characters, without { } or <');
    };
    var checkStyle = function (prop, value, path) {
        if (STYLE_PROPS.indexOf(prop) === -1) return bad(path, '"' + prop + '" is not a style live edit previews');
        return value === undefined || (typeof value === 'string' && STYLE_VALUE.test(value)) ? OK : bad(path, 'a style value live edit refuses');
    };
    var checkPreview = function (v, path) {
        if (!plain(v)) return bad(path, 'a preview object');
        var r = onlyKeys(v, ['selector', 'text', 'style'], path);
        if (!r.ok || !(r = checkSelector(v.selector, path + '/selector')).ok) return r;
        if (!own(v, 'text') && !own(v, 'style')) return bad(path, 'a preview sets "text" or "style"');
        if (own(v, 'text') && !(r = checkKind('string', v.text, path + '/text')).ok) return r;
        if (!own(v, 'style')) return OK;
        if (!plain(v.style) || Object.keys(v.style).length > 8) return bad(path + '/style', 'an object of at most 8 styles');
        var props = Object.keys(v.style);
        for (var i = 0; i < props.length; i++) if (!(r = checkStyle(props[i], v.style[props[i]], path + '/style/' + props[i])).ok) return r;
        return OK;
    };
    var checkStylePreview = function (v, path) {
        if (!plain(v)) return bad(path, 'a preview object');
        var r = onlyKeys(v, ['selector', 'property'], path);
        if (!r.ok || !(r = needKeys(v, ['selector', 'property'], path)).ok || !(r = checkSelector(v.selector, path + '/selector')).ok) return r;
        return checkStyle(v.property, undefined, path + '/property');
    };

    var checkComponent = function (c, path) {
        if (!plain(c)) return bad(path, 'a component object');
        if (typeof c.id !== 'string' || !ID.test(c.id)) return bad(path + '/id', 'a component id of letters, digits and _');
        if (typeof c.component !== 'string') return bad(path + '/component', 'missing "component"');
        if (!own(CATALOG, c.component)) return bad(path + '/component', '"' + c.component + '" is not in the live edit catalog');
        var def = CATALOG[c.component];
        var r = onlyKeys(c, COMMON.concat(Object.keys(def.props)), path);
        if (!r.ok || !(r = needKeys(c, def.req, path)).ok) return r;
        if (own(c, '@catalogId') && c['@catalogId'] !== CATALOG_ID) return bad(path + '/@catalogId', 'live edit renders its own catalog only');
        if (own(c, '@accessibility')) {
            var a = c['@accessibility'];
            if (!plain(a) || !(r = onlyKeys(a, ['label', 'description'], path + '/@accessibility')).ok) return r.ok ? bad(path + '/@accessibility', 'an object') : r;
            if (own(a, 'label') && !(r = checkKind('string', a.label, path + '/@accessibility/label')).ok) return r;
            if (own(a, 'description') && !(r = checkKind('string', a.description, path + '/@accessibility/description')).ok) return r;
        }
        var props = Object.keys(def.props);
        for (var i = 0; i < props.length; i++) {
            if (own(c, props[i]) && !(r = checkKind(def.props[props[i]], c[props[i]], path + '/' + props[i])).ok) return r;
        }
        if (c.component === 'Slider' && (c.min || 0) >= c.max) return bad(path + '/max', 'max must be above min');
        return OK;
    };

    var checkComponents = function (list, path) {
        if (!Array.isArray(list) || !list.length) return bad(path, 'a list of at least one component');
        if (list.length > MAX_COMPONENTS) return bad(path, 'more than ' + MAX_COMPONENTS + ' components');
        for (var i = 0; i < list.length; i++) { var r = checkComponent(list[i], path + '/' + i); if (!r.ok) return r; }
        return OK;
    };

    // The protocol's own envelope rules, with no catalog: the spec's examples pass here.
    var SHAPES = {
        createSurface: { req: ['surfaceId'], keys: ['surfaceId', 'catalogId', 'sendDataModel', 'components', 'dataModel', 'metadata'] },
        updateComponents: { req: ['surfaceId', 'components'], keys: ['surfaceId', 'components'] },
        updateDataModel: { req: ['surfaceId', 'value'], keys: ['surfaceId', 'path', 'value'] },
        deleteSurface: { req: ['surfaceId'], keys: ['surfaceId'] },
        callRendererFunction: { req: ['functionCallId', 'callFunction'], keys: ['functionCallId', 'callFunction', 'surfaceId'] },
        agentFunctionResponse: { req: ['functionCallId'], keys: ['functionCallId', 'value', 'error'] },
    };
    var checkEnvelope = function (msg) {
        if (!plain(msg)) return bad('', 'a message is a JSON object');
        if (msg.version !== VERSION) return bad('/version', 'version must be "' + VERSION + '"');
        var keys = Object.keys(msg).filter(function (k) { return k !== 'version'; });
        if (keys.length !== 1 || !own(SHAPES, keys[0])) return bad('', 'a message holds "version" and exactly one of ' + Object.keys(SHAPES).join(', '));
        var type = keys[0];
        var body = msg[type];
        var path = '/' + type;
        if (!plain(body)) return bad(path, 'an object');
        var r = onlyKeys(body, SHAPES[type].keys, path);
        if (!r.ok || !(r = needKeys(body, SHAPES[type].req, path)).ok) return r;
        if (typeof body.surfaceId !== 'string' && own(body, 'surfaceId')) return bad(path + '/surfaceId', 'a string');
        if (type === 'createSurface' && own(body, 'catalogId') && typeof body.catalogId !== 'string') return bad(path + '/catalogId', 'a string');
        if (type === 'updateDataModel' && own(body, 'path') && typeof body.path !== 'string') return bad(path + '/path', 'a string');
        if ((type === 'createSurface' && own(body, 'components')) || type === 'updateComponents') {
            if (!Array.isArray(body.components) || !body.components.length) return bad(path + '/components', 'a list of at least one component');
            for (var i = 0; i < body.components.length; i++) {
                var c = body.components[i];
                if (!plain(c) || typeof c.id !== 'string' || typeof c.component !== 'string') return bad(path + '/components/' + i, 'a component has "id" and "component"');
            }
        }
        return { ok: true, type: type, body: body };
    };

    /**
     * An agent message as live edit accepts it: the envelope, then this module's
     * restrictions and catalog. `state` (from newState) adds the checks that need
     * the surfaces already drawn; pass null to check one message alone.
     */
    var checkAgentMessage = function (msg, state) {
        var e = checkEnvelope(msg);
        if (!e.ok) return e;
        var type = e.type;
        var body = e.body;
        var path = '/' + type;
        if (type === 'callRendererFunction' || type === 'agentFunctionResponse') return bad(path, type + ' is not implemented by live edit: no function runs on the page');
        if (!SURFACE.test(body.surfaceId)) return bad(path + '/surfaceId', 'a surface id of letters, digits, _ and -');
        var r;
        var exists = state ? state.surfaces.has(body.surfaceId) : null;
        if (type === 'createSurface') {
            if (body.catalogId !== CATALOG_ID) return bad(path + '/catalogId', 'live edit renders its own catalog only: ' + CATALOG_ID);
            if (own(body, 'sendDataModel') && body.sendDataModel !== false) return bad(path + '/sendDataModel', 'live edit never sends the data model');
            if (own(body, 'metadata')) return bad(path + '/metadata', 'surface metadata is not implemented by live edit');
            if (own(body, 'components') && !(r = checkComponents(body.components, path + '/components')).ok) return r;
            if (own(body, 'dataModel') && (!plain(body.dataModel) || !(r = checkJson(body.dataModel, path + '/dataModel', 0)).ok)) return r && !r.ok ? r : bad(path + '/dataModel', 'an object');
            if (state && exists) return bad(path + '/surfaceId', 'surface "' + body.surfaceId + '" exists: delete it first');
            if (state && state.surfaces.size >= MAX_SURFACES) return bad(path, 'more than ' + MAX_SURFACES + ' surfaces at once');
            return OK;
        }
        if (state && !exists) return bad(path + '/surfaceId', 'no surface "' + body.surfaceId + '"');
        if (type === 'updateComponents') return checkComponents(body.components, path + '/components');
        if (type === 'updateDataModel') {
            if (own(body, 'path') && !segments(body.path)) return bad(path + '/path', 'not a JSON Pointer live edit accepts');
            return checkJson(body.value, path + '/value', 0);
        }
        return OK;
    };

    var newState = function () { return { surfaces: new Map() }; };
    var newSurface = function (id) { return { id: id, components: new Map(), data: {} }; };
    /** Applies a message checkAgentMessage accepted. Returns the surface id it touched. */
    var apply = function (state, msg) {
        var type = Object.keys(msg).filter(function (k) { return k !== 'version'; })[0];
        var body = msg[type];
        if (type === 'deleteSurface') { state.surfaces.delete(body.surfaceId); return body.surfaceId; }
        if (type === 'createSurface') state.surfaces.set(body.surfaceId, newSurface(body.surfaceId));
        var s = state.surfaces.get(body.surfaceId);
        if (!s) return null;
        var list = body.components || [];
        for (var i = 0; i < list.length; i++) s.components.set(list[i].id, JSON.parse(JSON.stringify(list[i])));
        if (type === 'createSurface' && body.dataModel) s.data = JSON.parse(JSON.stringify(body.dataModel));
        if (type === 'updateDataModel') s.data = setPointer(s.data, own(body, 'path') ? body.path : '/', JSON.parse(JSON.stringify(body.value)));
        return body.surfaceId;
    };

    /** A literal, or the value a binding points at; null when the pointer holds nothing. */
    var resolve = function (surface, v) {
        if (plain(v) && own(v, '@path')) { var got = getPointer(surface.data, v['@path']); return got === undefined ? null : got; }
        return v;
    };
    /** A value as text, the way the spec interpolates it. */
    var asText = function (v) { return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); };

    /** The action message for a tap on `componentId`, with its context resolved against the surface's data. */
    var actionMessage = function (surface, componentId, at) {
        var c = surface.components.get(componentId);
        if (!c || !c.action) return null;
        var context = {};
        var declared = c.action.event.context || {};
        var keys = Object.keys(declared);
        for (var i = 0; i < keys.length; i++) context[keys[i]] = resolve(surface, declared[keys[i]]);
        return { version: VERSION, action: { name: c.action.event.name, surfaceId: surface.id, sourceComponentId: c.id, timestamp: new Date(at).toISOString(), context: context } };
    };

    /** A renderer to agent message, by the protocol's own rules (the spec's renderer_messages cases). */
    var checkRendererMessage = function (msg) {
        if (!plain(msg)) return bad('', 'a message is a JSON object');
        if (msg.version !== VERSION) return bad('/version', 'version must be "' + VERSION + '"');
        var keys = Object.keys(msg).filter(function (k) { return k !== 'version'; });
        var kinds = ['action', 'error', 'callAgentFunction', 'rendererFunctionResponse'];
        if (keys.length !== 1 || kinds.indexOf(keys[0]) === -1) return bad('', 'a message holds "version" and exactly one of ' + kinds.join(', '));
        var type = keys[0];
        var b = msg[type];
        var path = '/' + type;
        if (!plain(b)) return bad(path, 'an object');
        var r;
        if (type === 'action') {
            if (!(r = onlyKeys(b, ['name', 'surfaceId', 'sourceComponentId', 'timestamp', 'context', 'userMessage', 'metadata'], path)).ok) return r;
            if (!(r = needKeys(b, ['name', 'surfaceId', 'sourceComponentId', 'timestamp', 'context'], path)).ok) return r;
            if (typeof b.name !== 'string' || typeof b.surfaceId !== 'string' || typeof b.sourceComponentId !== 'string') return bad(path, 'name, surfaceId and sourceComponentId are strings');
            if (typeof b.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(b.timestamp)) return bad(path + '/timestamp', 'an ISO 8601 date-time');
            if (!plain(b.context)) return bad(path + '/context', 'an object');
            if (own(b, 'userMessage') && typeof b.userMessage !== 'string') return bad(path + '/userMessage', 'a string');
            if (own(b, 'metadata')) {
                if (!plain(b.metadata) || !(r = onlyKeys(b.metadata, ['extensions'], path + '/metadata')).ok) return r && !r.ok ? r : bad(path + '/metadata', 'an object');
                if (own(b.metadata, 'extensions')) {
                    if (!plain(b.metadata.extensions)) return bad(path + '/metadata/extensions', 'an object');
                    var ext = Object.keys(b.metadata.extensions);
                    for (var i = 0; i < ext.length; i++) if (!XID.test(ext[i])) return bad(path + '/metadata/extensions/' + ext[i], 'an extension key is a Unicode identifier');
                }
            }
            return OK;
        }
        if (type === 'error') {
            if (typeof b.code !== 'string' || typeof b.message !== 'string') return bad(path, 'an error has a string "code" and "message"');
            if (VALIDATION.indexOf(b.code) !== -1) {
                if (!(r = onlyKeys(b, ['code', 'surfaceId', 'path', 'message'], path)).ok) return r;
                return typeof b.surfaceId === 'string' && typeof b.path === 'string' ? OK : bad(path, b.code + ' names "surfaceId" and "path"');
            }
            if (!(r = onlyKeys(b, ['code', 'message', 'surfaceId', 'functionCallId'], path)).ok) return r;
            return own(b, 'surfaceId') !== own(b, 'functionCallId') ? OK : bad(path, 'an error names exactly one of "surfaceId" and "functionCallId"');
        }
        return bad(path, type + ' is not implemented by live edit');
    };

    /**
     * An action a page sent, against the surface the session drew. The surface and
     * the tapped component must exist, the name must be the one that component
     * declares, every literal in the context must be the declared one, and a value
     * bound to a slider must sit inside that slider's range. So a page can only
     * pick among what was offered.
     */
    var checkTap = function (msg, state) {
        var r = checkRendererMessage(msg);
        if (!r.ok) return r;
        if (!plain(msg.action)) return bad('', 'not an action');
        var a = msg.action;
        if (own(a, 'metadata') || own(a, 'userMessage')) return bad('/action', 'live edit sends neither metadata nor userMessage');
        var s = state.surfaces.get(a.surfaceId);
        if (!s) return bad('/action/surfaceId', 'no surface "' + a.surfaceId + '"');
        var c = s.components.get(a.sourceComponentId);
        if (!c || !c.action) return bad('/action/sourceComponentId', 'no component "' + a.sourceComponentId + '" that takes a tap');
        if (a.name !== c.action.event.name) return bad('/action/name', 'the component declares "' + c.action.event.name + '"');
        var declared = c.action.event.context || {};
        var want = Object.keys(declared).sort();
        var got = Object.keys(a.context).sort();
        if (want.join('\u0000') !== got.join('\u0000')) return bad('/action/context', 'the context holds exactly the declared keys: ' + (want.join(', ') || 'none'));
        var sliders = [];
        s.components.forEach(function (x) { if (x.component === 'Slider' && plain(x.value)) sliders.push(x); });
        for (var i = 0; i < want.length; i++) {
            var d = declared[want[i]];
            var v = a.context[want[i]];
            var p = '/action/context/' + want[i];
            if (!plain(d)) { if (JSON.stringify(d) !== JSON.stringify(v)) return bad(p, 'not the value offered'); continue; }
            var range = sliders.filter(function (x) { return x.value['@path'] === d['@path']; })[0];
            if (range) {
                if (typeof v !== 'number' || !isFinite(v) || v < (range.min || 0) || v > range.max) return bad(p, 'outside the slider range ' + (range.min || 0) + ' to ' + range.max);
                continue;
            }
            if (!(v === null || typeof v === 'boolean' || (typeof v === 'number' && isFinite(v)) || (typeof v === 'string' && v.length <= MAX_TEXT))) return bad(p, 'a short plain value');
        }
        return OK;
    };

    return {
        CATALOG_ID: CATALOG_ID, VERSION: VERSION, CATALOG: CATALOG, STYLE_PROPS: STYLE_PROPS, MAX_DEPTH: MAX_DEPTH,
        segments: segments, getPointer: getPointer, setPointer: setPointer, checkEnvelope: checkEnvelope, checkAgentMessage: checkAgentMessage,
        checkComponent: checkComponent, newState: newState, apply: apply, resolve: resolve, asText: asText, actionMessage: actionMessage,
        checkRendererMessage: checkRendererMessage, checkTap: checkTap, checkStyle: checkStyle,
    };
}
/* eslint-enable no-var */

module.exports = { a2uiKit, ...a2uiKit() };
