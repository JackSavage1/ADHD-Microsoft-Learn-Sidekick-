# Sidekick

An ADHD-friendly learning companion for Microsoft Power Platform. Sidekick lives in Chrome's side panel next to make.powerapps.com and turns a Microsoft Learn module into one small, hands-on step at a time, with a 25-minute focus timer that tells you when to walk away.

## What it does

- **One step at a time.** Each step is a single, concrete action in your real Power Apps environment ("left menu, click Tables, then..."), in big type, with no scrolling.
- **Done** marks the step finished and fills the progress bar.
- **Stuck** shows a hint. Press it again to see the answer.
- **25-minute countdown**, always visible. At zero, a full-panel "Session complete, walk away" screen asks you to log what you got done before you can continue.
- **Quiz steps** at the end: reveal the answer, then score yourself right or wrong.
- **A whole course.** Finish a lesson and a **Next lesson** button takes you straight to the next one. The list button (top right) shows every lesson and how far along you are.
- **Remembers everything** (your step, streak of study days, sessions completed) in `chrome.storage.local`, so closing the panel loses nothing.
- **Private by design.** Only two permissions (`sidePanel`, `storage`). No content scripts, no host permissions: it never reads or changes Microsoft's pages, and it makes no network requests.

## Install (2 minutes)

1. Download this repository: **Code > Download ZIP** on GitHub, then unzip it. (Or `git clone` it.)
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`).
5. Click the puzzle-piece icon in Chrome's toolbar and pin **Sidekick**.
6. Open https://make.powerapps.com in a tab, then click the Sidekick icon. The side panel opens on the right.

After you edit any file, go back to `chrome://extensions` and click the reload arrow on the Sidekick card.

## How to use a session

1. Open your Power Apps tab and the Sidekick panel side by side.
2. Do what the step says in Power Apps, then press **Done**. Your first Done (or Stuck) starts the 25-minute timer. The play/pause button next to the timer also starts it.
3. Stuck? Press **Stuck** once for a hint, twice for the answer.
4. When the timer hits zero, write one line about what you did, press **Log session**, and take a real break.

Good to know:

- The timer keeps counting if you close the panel. If time ran out while it was closed, the walk-away screen is waiting when you reopen it.
- Keyboard shortcuts: **Enter** = Done (or Reveal answer on a quiz), **S** = Stuck, **B** or **←** = Back.
- Your streak counts days in a row with at least one logged session.
- Power Apps sometimes renames buttons. If a label in a step doesn't match your screen, press Stuck: the hints cover the common alternatives.

## Project files

| File | What it is |
| --- | --- |
| `manifest.json` | Manifest V3 config: name, icons, the side panel, and the two permissions. |
| `background.js` | Tiny service worker that opens the side panel when you click the toolbar icon. |
| `panel.html` / `panel.css` / `panel.js` | The side panel UI: step card, buttons, timer, progress, quiz, session log. |
| `lessons/index.json` | The course: which lessons exist, in order. |
| `lessons/*.json` | One file per Microsoft Learn module, converted into hands-on steps plus 3 quiz questions. |
| `lessons/schema.md` | The lesson JSON format, so new modules can be added the same way. |
| `icons/` | Toolbar and store icons (PNG). |
| `tools/make-icons.js` | Optional script that regenerated the icons: `node tools/make-icons.js`. Not needed to run the extension. |
| `tools/validate-lessons.js` | Optional checker for lesson files: `node tools/validate-lessons.js`. Not needed to run the extension. |

Everything is plain HTML, CSS and JavaScript: no frameworks, no libraries, no build step. Every file is meant to be read.

## Adding another Microsoft Learn module

1. Write a new JSON file in `lessons/` following `lessons/schema.md`.
2. Add it to `lessons/index.json`, in course order.
3. Optional: run `node tools/validate-lessons.js` to check it (needs Node.js).
4. Reload the extension in `chrome://extensions`.

## About the project (for LinkedIn)

I built Sidekick, a Chrome extension that makes studying Microsoft Power Platform work with an ADHD brain instead of against it. It sits in Chrome's side panel next to Power Apps and turns a Microsoft Learn module (Manage tables in Dataverse) into one small, hands-on step at a time, done in my real environment: create the table, rename the primary column, add the columns, check the licensing. A Stuck button gives a hint and then the answer, so I never stall for long, and a 25-minute focus timer ends each session with a "walk away" screen that has me log what I got done, which builds a daily streak. It's written in plain JavaScript, HTML and CSS on Manifest V3 with only two permissions and no access to the pages I'm working in, and the lesson format is documented so any Learn module can be added next.
