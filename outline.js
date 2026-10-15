// Module / Unit / Section detection. v2 (table-of-contents aware, never drops units) first; the older detector is a fallback.
const V2 = require('./outline_core');
const V1 = require('./outline_v1');
function buildOutline(pages) {
  let a; try { a = V2.buildOutline(pages); } catch (e) { console.error('[outline v2]', e.message); a = null; }
  if (a && a.structured && a.foundUnits >= 2) return a;
  let b; try { b = V1.buildOutline(pages); } catch { b = null; }
  return b && b.structured ? Object.assign(b, { warnings: [] }) : (a || { structured: false, modules: [], pages: pages.length, warnings: [] });
}
module.exports = { buildOutline, sectionText: V2.sectionText, textOf: V2.textOf };
