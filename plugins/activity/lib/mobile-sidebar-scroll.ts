// The SDK owns only the thread-list slot, not the surrounding scroll layout.
// Match BB's sidebar regions only while our compact list is mounted. If the
// host changes this structure, its content region remains the scroll fallback.
const sidebar =
  '[data-sidebar="sidebar"]:has([data-activity-sidebar][data-mobile-scroll])';

export const MOBILE_SIDEBAR_SCROLL_CSS = `
  ${sidebar} {
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior-y: contain;
  }
  ${sidebar} > :has(> [data-sidebar="content"]) {
    flex: 1 0 auto;
  }
  ${sidebar} > :has(> [data-sidebar="content"]) > [data-sidebar="content"] {
    flex: 1 0 auto;
    overflow: visible;
  }
`;
