# Development Route Discovery

Next 16.2.10 builds its development route matcher from Watchpack, separately
from Turbopack's compiled app-path manifest. A 5 ms aggregation can arrive before
the initial recursive scan finishes. Publishing that partial snapshot can omit
nested routes even though their source and compiled output exist. A root
catch-all then receives a valid document URL and returns 404.

The pinned Next dependency backports the startup snapshot barrier from upstream
[Next #97920](https://github.com/vercel/next.js/pull/97920), merged 2026-09-08.
It waits for existing snapshot page files before publishing the initial route
registry, with the upstream 30-second safety deadline. This is shared by webpack
and Turbopack; changing bundlers or enabling filesystem polling is not a fix for
the startup race. Remove the patch when the pinned stable Next release includes
the upstream fix.

An existing dev process must be replaced after installing the patched dependency;
changing source or deleting compiled caches does not update its loaded router.
Do not delete caches as a routine recovery procedure. In an absorbed workspace,
the installing workspace must also honor this pinned dependency patch.

For diagnosis, compare anonymous/synthetic HTTP probes, the source tree,
`.next/dev/types/routes.d.ts`, and `.next/dev/server/app-paths-manifest.json`.
A compiled manifest entry alone does not establish runtime reachability.
Probe both `/w/<workspace>/p` and `/w/<workspace>/p/<page>`, a nested static route,
and `/drawing-library-callback.html`. Never use real account cookies or data.

Regression coverage must run a real isolated Next server, delay Watchpack's
initial deep-directory scans, and assert that canonical nested routes reach their
leaves rather than the root catch-all. The fixture must use temporary output,
never the running application's `.next` directory.

Run `node apps/app-web/scripts/route-discovery-regression.mjs` from the OSS root.
It checks unpatched native watching and polling against the patched webpack and
Turbopack runtimes, then edits the fixture repeatedly and checks nested static
routes and hyphen/underscore/dot identifiers. Once the dependency is installed
with the patch, the unpatched controls are skipped. The ordinary app-web unit
suite also verifies the package pin, patch registration and lockfile hash.
