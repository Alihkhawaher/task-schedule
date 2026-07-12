import os
import json
import sys

V6_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASS = '[PASS]'
FAIL = '[FAIL]'
results = {'passed': 0, 'failed': 0, 'errors': []}


def check(condition, test_name, detail=''):
    if condition:
        print(f'  {PASS} {test_name}')
        results['passed'] += 1
    else:
        msg = f'  {FAIL} {test_name}' + (f' -- {detail}' if detail else '')
        print(msg)
        results['failed'] += 1
        results['errors'].append(test_name)


def read_file(rel_path):
    path = os.path.join(V6_DIR, rel_path)
    if not os.path.exists(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


# ============================================================
print()
print('=== TEST 1: Icon files exist and are valid SVG ===')
# ============================================================
for size in ['192x192', '512x512']:
    icon_path = os.path.join(V6_DIR, 'app', 'icons', f'icon-{size}.svg')
    check(os.path.exists(icon_path), f'icon-{size}.svg exists')
    if os.path.exists(icon_path):
        content = read_file(f'app/icons/icon-{size}.svg')
        check('<svg' in content, f'icon-{size}.svg is valid SVG')
        check('xmlns=' in content, f'icon-{size}.svg has xmlns')

# ============================================================
print()
print('=== TEST 2: Manifest references SVG icons ===')
# ============================================================
manifest_path = os.path.join(V6_DIR, 'manifest.json')
check(os.path.exists(manifest_path), 'manifest.json exists')
if os.path.exists(manifest_path):
    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)
    icons = manifest.get('icons', [])
    check(len(icons) == 2, f'manifest has 2 icons (found {len(icons)})')
    for icon in icons:
        src = icon.get('src', '')
        mime = icon.get('type', '')
        check(src.endswith('.svg'), f'Icon {src} is SVG')
        check(mime == 'image/svg+xml', f'Icon {src} has correct MIME type')
        icon_file = os.path.join(V6_DIR, src)
        check(os.path.exists(icon_file), f'Icon file {src} exists on disk')

# ============================================================
print()
print('=== TEST 3: P2P peerId defensive checks ===')
# ============================================================
p2p_content = read_file('app/p2p.js')
check(p2p_content is not None, 'p2p.js exists')
if p2p_content:
    check("typeof meta === 'object' ? meta.peerId : meta" in p2p_content,
          'p2p.js has defensive peerId extraction')
    check("typeof peerId !== 'string'" in p2p_content,
          'p2p.js validates peerId is string')
    check('Unexpected peerId type' in p2p_content,
          'p2p.js has warning log for unexpected types')
    check('actions.data.onMessage' in p2p_content,
          'p2p.js has data.onMessage handler')
    check('actions.family.onMessage' in p2p_content,
          'p2p.js has family.onMessage handler')
    check('actions.request.onMessage' in p2p_content,
          'p2p.js has request.onMessage handler')
    req_start = p2p_content.find('actions.request.onMessage')
    if req_start > 0:
        req_block = p2p_content[req_start:req_start + 1000]
        check('{ target: peerId }' in req_block,
              'request handler uses peerId variable')
        check('{ target: meta.peerId }' not in req_block,
              'request handler does NOT use meta.peerId directly')

# ============================================================
print()
print('=== TEST 4: No legacy relay references ===')
# ============================================================
config_content = read_file('app/config.js')
check(config_content is not None, 'config.js exists')
if config_content:
    check('saveRelayConfig' not in config_content,
          'config.js has no saveRelayConfig')
    check('testRelayConnection' not in config_content,
          'config.js has no testRelayConnection')
    check('relayServer' not in config_content,
          'config.js has no relayServer references')

index_content = read_file('index.html')
check(index_content is not None, 'index.html exists')
if index_content:
    check('relayServer' not in index_content,
          'index.html has no relayServer references')
    check('savedRelay' not in index_content,
          'index.html has no savedRelay variable')
    check('peers: []' in index_content,
          'index.html Gun.js uses empty peers array')

app_index_content = read_file('app/index.html')
check(app_index_content is not None, 'app/index.html exists')

# ============================================================
print()
print('=== TEST 5: Script cache busting versions ===')
# ============================================================
if index_content:
    check('p2p.js?v=4' in index_content,
          'index.html loads p2p.js?v=4')
if app_index_content:
    check('p2p.js?v=4' in app_index_content,
          'app/index.html loads p2p.js?v=4')
    check('app.js?v=9' in app_index_content,
          'app/index.html loads app.js?v=9')
    check('config.js?v=9' in app_index_content,
          'app/index.html loads config.js?v=9')

# ============================================================
print()
print('=== TEST 6: File structure integrity ===')
# ============================================================
required_files = [
    'index.html', 'manifest.json', 'app/index.html', 'app/app.js',
    'app/config.js', 'app/p2p.js', 'app/styles.css',
    'app/libs/trystero-bundle.js', 'app/libs/gun.js',
    'app/libs/bootstrap.min.css', 'app/libs/bootstrap.bundle.min.js',
    'app/libs/jquery-3.7.0.min.js', 'app/libs/sweetalert2.all.min.js',
    'app/libs/chart.umd.min.js', 'app/libs/moment.min.js',
    'app/libs/moment-ar.min.js', 'app/libs/qrcode.min.js',
    'app/libs/tajawal.css', 'app/libs/bootstrap-icons.css',
    'app/icons/icon-192x192.svg', 'app/icons/icon-512x512.svg',
]
for f in required_files:
    check(os.path.exists(os.path.join(V6_DIR, f)), f'{f} exists')

# ============================================================
print()
total = results['passed'] + results['failed']
print('=' * 50)
print(f"Results: {results['passed']}/{total} passed, {results['failed']} failed")
if results['errors']:
    print()
    print('Failed tests:')
    for e in results['errors']:
        print(f'  - {e}')
print('=' * 50)
sys.exit(0 if results['failed'] == 0 else 1)