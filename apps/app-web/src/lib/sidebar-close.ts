/**
 * Drawer hygiene signal (responsive contract M7).
 *
 * Below `md` the sidebar is a drawer over the page. Every action launched
 * from inside it that opens a modal / sheet or navigates must close it,
 * otherwise the user lands back on an open drawer over a dimmed page and pays
 * a backdrop tap to get to work (the extra step in the 2026-09-08 invite
 * trace: Settings and Invite opened the modal and left the drawer open).
 *
 * The drawer's open state lives in `DocSidebarDataProvider` and is owned by
 * `WorkspaceChrome`. Components that run inside the provider can call
 * `setSidebarOpen(false)` directly; this window event is the seam for the
 * ones that should not know about the chrome at all (the workspace switcher,
 * which also renders outside the doc surface) - the same cross-component idiom
 * as `doc:open-settings`. `WorkspaceChrome` is the one listener.
 *
 * [COMP:app-web/sidebar-drawer-close]
 */

export const SIDEBAR_CLOSE_EVENT = "doc:sidebar-close";

/** Ask the chrome to close the mobile sidebar drawer. No-op on the server. */
export function requestSidebarClose(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SIDEBAR_CLOSE_EVENT));
}
