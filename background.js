// Sidekick background service worker (Manifest V3).
//
// In Manifest V3 the "background page" is a service worker: Chrome starts it
// when the extension needs it and shuts it down again when it is idle. Sidekick
// only needs it for one job, so this file is deliberately tiny.
//
// The job: make a click on Sidekick's toolbar icon open the side panel.
// Without this call, clicking the icon does nothing useful, and the learner
// would have to open the panel by hand from Chrome's side panel menu every
// time. One click to open is much friendlier when attention is precious.
//
// Chrome remembers this setting, but calling it every time the worker starts
// is harmless and keeps the behavior correct after updates or reinstalls.
// setPanelBehavior needs Chrome 116+, which is why manifest.json sets
// "minimum_chrome_version": "116".
//
// Privacy note: Sidekick never reads or changes the pages you visit. There are
// no tab listeners, no content scripts and no host permissions here on purpose.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => {
    // setPanelBehavior returns a Promise. If it ever fails, log the reason so it
    // shows up under "Errors" on chrome://extensions instead of failing silently.
    console.error('Sidekick: could not set the side panel to open on icon click.', error);
  });
