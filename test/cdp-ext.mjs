// Load the extension into the running Chrome via CDP Target.createTarget with
// the extension path in the --load-extension style. MV3 requires launching
// Chrome with --load-extension, which cannot be done on a running instance.
// Instead, this script drives the extension's panel directly via CDP by
// opening chrome-extension://<id>/panel.html after we discover the id.
//
// For now: open the panel.html as a standalone page via the extension URL once
// loaded. Discovery: query chrome://extensions is not scriptable; the common
// trick is to read the id from the manifest hash, which Chrome derives
// deterministically from the path on unpacked installs.
import { createHash } from 'node:crypto'

// Chrome's extension id for unpacked extensions is derived from the absolute
// path: first 16 bytes of SHA256 of the path, mapped to a-p (0-25) as hex nibbles.
function extIdFromPath(p) {
  const abs = p.replace(/\/+$/, '')
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 32)
  let id = ''
  for (const ch of hash) id += String.fromCharCode(97 + parseInt(ch, 16))
  return id
}

const dir = '/Users/jimmy/work/demo/dsh-browser-host/browser-ext/extension'
console.log('predicted extension id:', extIdFromPath(dir))
