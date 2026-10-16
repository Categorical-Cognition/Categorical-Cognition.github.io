# Third-party notices

GoLog uses Three.js for browser rendering and ws for WebSocket transport. Their
MIT license notices remain in their installed packages. The standalone runtime
also carries the Three.js license alongside its copied browser module. The
hosted and static profiles import that pinned browser module from jsDelivr instead.
The static website does not include the Node runtime or ws package.

Acorn is the JavaScript parser used for source auditing. Playwright is used only
for browser tests. Installed dependency packages retain their own license files.
The lockfile records exact versions and integrity hashes; GoLog's license does
not replace dependency licenses or claim authorship of their implementations.

The original license texts are in `node_modules/three/LICENSE`,
`node_modules/ws/LICENSE`, `node_modules/acorn/LICENSE`, and
`node_modules/playwright/LICENSE` after installation.
