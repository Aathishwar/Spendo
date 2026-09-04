#!/usr/bin/env python3
"""
Spendo - single-file preview build.

Flattens the app into one HTML file so it can be opened from a phone without
deploying anything. The real app stays multi-file and unbundled; this exists only
so a preview is always generated from the actual source rather than copied by hand
and left to drift.

    python tools/build-preview.py            writes dist/spendo-preview.html

Each ES module becomes an IIFE that returns its exports, which keeps every module's
private names private and avoids the collisions a plain concatenation would cause
(two modules here both define a local `esc`). Import statements are rewritten to
destructure from the module object that was already built.

Not a general bundler. It handles the import forms this project actually uses:

    import { a, b } from './x.js';        including the multi-line form
    import * as ns from './x.js';
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Dependency order. A module may only import from ones above it.
# Dependency order, and it must be COMPLETE: a module app.js imports that is not
# listed here is rewritten to `const x = __m_x;` against an identifier nothing
# defines, which is a ReferenceError on the first line of the bundle - a blank
# page, not a degraded one. identity, sync, ai and categorise were all missing.
MODULES = [
    'format', 'categories', 'charts', 'xlsx', 'voice',
    'identity', 'store', 'bulk', 'categorise', 'ai', 'sync', 'ui',
]
ENTRY = 'app'

IMPORT_RE = re.compile(
    r"^import\s+(?P<what>\*\s+as\s+\w+|\{[^}]*\})\s+from\s+'\./(?P<mod>[\w-]+)\.js';\s*$",
    re.MULTILINE | re.DOTALL,
)
EXPORT_DECL_RE = re.compile(r"^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)", re.MULTILINE)


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding='utf-8') as fh:
        return fh.read()


def rewrite_imports(src):
    def sub(match):
        what = match.group('what').strip()
        mod = match.group('mod')
        if what.startswith('*'):
            alias = what.split()[-1]
            return f'const {alias} = __m_{mod};'
        names = ' '.join(what.split())
        return f'const {names} = __m_{mod};'
    return IMPORT_RE.sub(sub, src)


def module_iife(name):
    src = read('js', f'{name}.js')
    exports = EXPORT_DECL_RE.findall(src)
    if not exports:
        sys.exit(f'{name}.js exports nothing; check the export syntax')
    body = rewrite_imports(src)
    body = re.sub(r'^export\s+', '', body, flags=re.MULTILINE)
    names = ', '.join(exports)
    return f'/* ---- {name}.js ---- */\nconst __m_{name} = (() => {{\n{body}\nreturn {{ {names} }};\n}})();\n'


def build():
    parts = [module_iife(m) for m in MODULES]

    entry = rewrite_imports(read('js', f'{ENTRY}.js'))
    # There is no service worker file beside a single-file preview, and a failed
    # registration would only print a warning the reader cannot act on.
    entry = re.sub(
        r"if \('serviceWorker' in navigator\) \{.*?\n\}\n",
        '/* service worker omitted from the preview build */\n',
        entry,
        flags=re.DOTALL,
    )
    parts.append(f'/* ---- {ENTRY}.js ---- */\n(() => {{\n{entry}\n}})();\n')

    # The export writes a Blob to a download, and a preview hosted inside a sandboxed
    # frame is not allowed to hand the viewer a file. Rather than ship a button that
    # silently does nothing, the preview drops it and says why.
    #
    # Asserted rather than attempted: a replacement that quietly stops matching when
    # the markup is reworded is how a preview ends up shipping the thing it was
    # supposed to remove, which is exactly what happened when the button became
    # "Export to Excel".
    export_button = """          <button class="btn btn-text btn-sm" data-action="export-json" type="button">
            ${icon('download-simple')} Export to Excel
          </button>"""
    ui_part = parts[MODULES.index('ui')]
    if export_button not in ui_part:
        sys.exit('build-preview: the export button markup moved; update the snippet above')
    parts[MODULES.index('ui')] = ui_part.replace(
        export_button,
        """          <span class="card-note">Export is disabled in this preview.</span>""",
    )

    script = '\n'.join(parts)
    css = read('styles', 'tokens.css') + '\n' + read('styles', 'app.css')

    html = read('index.html')
    html = html.replace(
        '<link rel="stylesheet" href="styles/tokens.css">\n'
        '<link rel="stylesheet" href="styles/app.css">',
        f'<script>\n{read("js", "boot-theme.js")}\n</script>\n<style>\n{css}\n</style>',
    )
    html = html.replace('<script type="module" src="js/app.js"></script>',
                        f'<script type="module">\n{script}\n</script>')
    # Nothing to install and nothing to fetch in a single file. The icon links go
    # too: they point at files that are not travelling with this one.
    for tag in (
        # Inlined into the head below rather than dropped: without it the
        # preview flashes light before the modules run.
        '<script src="js/boot-theme.js"></script>\n',
        '<link rel="manifest" href="manifest.webmanifest">\n',
        '<link rel="icon" href="icons/favicon-32.png" sizes="32x32" type="image/png">\n',
        '<link rel="icon" href="icons/icon-192.png" sizes="192x192" type="image/png">\n',
        '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">\n',
    ):
        html = html.replace(tag, '')
    # And the comment that explains one of them, which would otherwise be left
    # describing a tag that is no longer there.
    html = re.sub(r"<!-- iOS ignores the manifest.*?-->\n", '', html, flags=re.S)

    out_dir = os.path.join(ROOT, 'dist')
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, 'spendo-preview.html')
    with open(out, 'w', encoding='utf-8') as fh:
        fh.write(html)
    print(f'{out}  {len(html) / 1024:.0f} KB')


if __name__ == '__main__':
    build()
