# Suggested Home Header

`SuggestedView` (`?suggested=1`) displays today's date and a time-of-day
greeting using the browser's local clock and timezone, not the server's.
Morning is before 12:00, afternoon is 12:00 through 17:59, and evening starts
at 18:00. The greeting comes from the selected app dictionary.

The date uses the app locale: `en`, `ja`, `zh-CN` (the `zh-cn.ts` dictionary),
or `zh-TW` for the app's Traditional Chinese `zh` locale. It must not inherit
the server or browser's default formatting locale.

SSR and the first hydration render leave the date and greeting empty, with
their line heights reserved. A mount effect enables browser-local rendering
of both labels together, including the optional user-name suffix. This avoids
locale, timezone, and midnight/hour-boundary mismatches without suppressing
hydration warnings. Without JavaScript these two labels remain empty.

After mount, both labels read the same current Date on each render, as before.
There is no automatic rollover timer: an otherwise idle view updates on its
next render or remount. Locale changes reformat the date on the next render.

Regression coverage server-renders then hydrates the actual component under
different mocked runtime formatting/timezone and clock conditions, checking
zero recoverable hydration errors and the eventual localized date/greeting.
This scoped contract does not change dock data or card timestamp formatting.
