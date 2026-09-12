// Exact <private> tags are case-insensitive privacy boundaries, not HTML.
// Nesting keeps an outer region private until its matching close. A missing
// close redacts the rest of that string; unrelated text/tags remain unchanged.
function stripPrivate(text) {
    if (!text) return text;
    if (typeof text !== 'string') throw new TypeError('Memory text must be a string');
    const tags = /<\/?private>/gi;
    const parts = [];
    let depth = 0;
    let cursor = 0;
    let match;
    while ((match = tags.exec(text)) !== null) {
        if (match[0][1] !== '/') {
            if (depth === 0) parts.push(text.slice(cursor, match.index), '[REDACTED]');
            depth++;
        } else if (depth > 0) {
            depth--;
            if (depth === 0) cursor = tags.lastIndex;
        }
    }
    if (depth === 0) parts.push(text.slice(cursor));
    return parts.join('');
}

// Sanitize each JSON string token (keys as well as values), not the entire
// serialized document. Otherwise an unclosed value would eat later fields and
// JSON delimiters. JSON.stringify provides valid tokens; parse/stringify decodes
// and re-escapes each token so quotes and backslashes keep their original value.
function stringifyPrivate(value) {
    try {
        const json = JSON.stringify(value);
        if (typeof json !== 'string') throw new TypeError('Not serializable');
        return json.replace(/"(?:[^"\\]|\\.)*"/g,
            token => JSON.stringify(stripPrivate(JSON.parse(token))));
    } catch {
        // Never return the original payload, and do not forward a user-supplied
        // toJSON/getter/parser error message into the memory hook's diagnostics.
        throw new TypeError('Cannot serialize memory field safely');
    }
}

module.exports = { stripPrivate, stringifyPrivate };
