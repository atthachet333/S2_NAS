# PWA / MOBILE

S2 NAS is a single web application that also installs as an app. There is no separate mobile codebase: the same React bundle serves phone, tablet and desktop, and the PWA layer is an enhancement on top of it — never a requirement. If the service worker fails to register, the app works exactly as a normal website.

## Two breakpoints, two different questions

| Rule | Width | What changes |
|---|---|---|
| Phone | `< 768px` | Bottom navigation, action sheets, upload sheet, mobile folder bar |
| Compact list | `< 1024px` | File list renders as cards instead of the table |
| Desktop | `>= 1024px` | Full table, top navigation, context menus — unchanged from before F24 |

These are deliberately separate. "Is this a phone?" decides navigation; "is there room for the table?" decides list presentation. The file table grows to ~1750 px with real Thai filenames, and the share of it that requires horizontal scrolling was measured at **56% at 768 px, 45% at 1024 px, 31% at 1280 px**. A tablet in portrait therefore gets cards, while a 900 px desktop window gets cards without inheriting phone navigation.

## Installation

**Chromium (Android, desktop Chrome/Edge).** The browser fires `beforeinstallprompt`; we capture it in a module-level store that starts listening when the app boots — not inside a component, because the event fires once and early, and a listener mounted later never sees it. The install entry lives in the **"เพิ่มเติม" sheet**, not in the bottom navigation: installing is a once-per-device action and does not deserve a permanent slot.

**iOS/iPadOS.** Safari exposes no install API. Web pages **cannot** trigger Add to Home Screen. We therefore show instructions (Share → เพิ่มไปยังหน้าจอโฮม → เพิ่ม) and state plainly that Safari does not allow programmatic install, rather than showing a button that would do nothing.

**Already installed.** Detected via `display-mode: standalone` and iOS `navigator.standalone`. The install option is then hidden entirely.

**Not nagging.** Dismissal stores a single timestamp under `s2-install-dismissed-at` and stays quiet for 30 days. That key holds **only** a number — no account, email, or token. The install option remains manually reachable in the menu regardless of dismissal.

## What the service worker caches — and what it must never cache

Precached: JS, CSS, `woff2` fonts, icons, and `index.html`. That is the entire list.

**There is no runtime caching at all.** Not even network-first for `/api`. The access token travels in an `Authorization` header rather than a cookie, so two different users produce identical cache keys for the same request — a cached API response could be served to the next person on the device, and logging out would not remove it. Legacy `.woff` files and the Vietnamese subset are excluded because nothing uses them.

`navigateFallbackDenylist` keeps `/api/` and `/s/` from being answered with the app shell, so a failed API call reports a network failure instead of returning HTML that the caller tries to parse as JSON.

Never cached: API responses, document bytes, previews, PDFs, images from document routes, OCR text, search results, assistant answers, Smart Filing responses, `auth/me`, audit data, share-token content.

## Offline behaviour

The app shell loads offline. **Document data does not, and never pretends to.**

- Uploads are refused at `enqueue`, the single choke point every path goes through. Nothing is stored for later: a file parked in a web page disappears when the tab closes, which on mobile is constant. Promising delivery we cannot make would be worse than refusing.
- Preview and download refuse with "ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อเปิดไฟล์" instead of spinning.
- The Assistant refuses new questions and does not queue them.
- Smart Filing disables analyse, move-confirm and dismiss together, since all three need the server.
- There is **no background sync and no offline write queue** anywhere.

On reconnect, reads refresh automatically (`refetchOnReconnect`) and **writes do not**. Mutations run with `networkMode: 'always'` specifically to override TanStack Query's default, which parks mutations fired while offline and replays them on reconnect — that would move documents at a moment the user never chose.

## Distinguishing failures

Five causes are kept apart, because the useful next step differs for each: device offline, backend unavailable, session expired, feature unavailable, ordinary request error. **A failed request never reports the device as offline.** A server outage while the user's connection is fine is more common than a dropped connection, and blaming their device sends them to restart a router for nothing.

## Upload on mobile

Three entry points map to browser-native pickers: files (no filter), photos (`accept="image/*"`), and camera (`accept="image/*" capture="environment"`, single shot). These are **hints, not guarantees** — Android usually opens the camera directly, iOS often offers a choice, and desktop browsers generally ignore `capture`. Every path ends at the same upload queue, so nothing breaks when a hint is not honoured. Files are never recompressed or altered. Size is checked from file metadata, never by reading bytes into memory.

Uploads run in the page. If the tab is closed or the browser suspends it, the upload stops — we do not claim background upload.

## Updates

`registerType: 'prompt'`. A new version announces itself as **"มีเวอร์ชันใหม่พร้อมใช้งาน"** with **"อัปเดตตอนนี้"**. Activation reloads the page, so it is blocked while any upload is in flight; if the user taps during an upload, the intent is remembered and applied automatically once the queue drains.

## Security model

- Access token: **memory only**. Refresh: **httpOnly cookie**. Never localStorage, sessionStorage or IndexedDB — enforced by a test that scans the whole source tree.
- Downloads go `authorizedFetch → blob → object URL`; no direct storage URL is ever exposed.
- No `storageKey`, filesystem path, bucket name or S3 key appears in any response the browser receives.
- Logs exclude object keys, paths, bucket names and document content.

## Known platform limitations

- **iOS Safari renders blob-URL PDFs in an iframe inconsistently**, often showing a blank frame with no detectable error. The preview therefore always offers a download escape on narrow screens.
- iOS cannot be prompted to install programmatically.
- `capture` and `accept` behave differently across iOS, Android and desktop.
- Browser text scaling is supported to 200% without clipping; beyond that, layout is not guaranteed.
- The bottom navigation and sheets respect `env(safe-area-inset-*)`; devices reporting no insets simply get the normal spacing.
