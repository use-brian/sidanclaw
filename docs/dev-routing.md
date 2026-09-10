# Development Route Discovery

Next's development route matcher can omit nested pages when Watchpack publishes
a partial startup scan. The app pins Next `16.4.0-canary.25`, which includes the
upstream snapshot barrier from [Next #97920](https://github.com/vercel/next.js/pull/97920).
Stable `16.3.4` does not yet contain this fix. Move back to a stable release once
it includes the barrier. No local dependency patch or Docker patch-copy setup is
required.

Restart the development server after installing the new Next version. Cache
deletion is not required. The web, authentication app, and platform toolchain use
the same exact version.

Run `node apps/app-web/scripts/route-discovery-regression.mjs` from the OSS root
to delay the initial nested-directory scan and verify real webpack/Turbopack HTTP
responses across subsequent edits. It uses temporary output and synthetic routes,
never the running application's `.next` directory or account credentials.
