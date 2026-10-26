'use strict';

/* =============================================================================
   Sidekick: side-panel logic
   -----------------------------------------------------------------------------
   Sections, top to bottom:
      1. Settings        numbers you might want to tweak
      2. Storage         a thin wrapper around chrome.storage.local
      3. State           what we save, plus a little on-screen-only state
      4. Page elements   the HTML elements we update
      5. Helpers         dates, clock text, small utilities
      6. Lessons         fetch the course list and every lesson in it
      7. Rendering       turn state into what's on screen
      8. Auto-fit        shrink text so a step never needs scrolling
      9. Step actions    Done, Stuck, Back, quiz scoring, restart, switching lessons
     10. Focus timer     start, pause, tick, end
     11. Session log     the "walk away" screen and the streak maths
     12. Backup          export and import progress as a file
     13. Keyboard        optional shortcuts
     14. Start-up

   The pattern everywhere: an action changes `state`, saves it, then calls
   render(), which redraws the screen from `state`. Nothing else touches the page.
   ========================================================================== */


// ---- 1. Settings ------------------------------------------------------------

const COURSE_URL = 'lessons/index.json'; // the list of lessons, in course order
const LESSONS_DIR = 'lessons/';           // where each lesson's own JSON file lives
const SESSION_MINUTES = 25;
const SESSION_MS = SESSION_MINUTES * 60 * 1000;
const MIN_NOTE_CHARS = 3;     // a session note needs at least this many non-space characters
const MIN_TEXT_SCALE = 0.5;   // auto-fit never shrinks step text below half its normal size
const HERO_RATIO = { full: 1.625, smallest: 1.25 }; // instruction size relative to body text
const HERO_KEEP_SCALE = 0.85; // above this scale the instruction keeps its full ratio


// ---- 2. Storage -------------------------------------------------------------

// Inside the extension this is chrome.storage.local. If panel.html is opened as
// an ordinary web page (handy for a quick look), use a throwaway in-memory copy.
const storage = globalThis.chrome?.storage?.local ?? createMemoryStorage();

function createMemoryStorage() {
  const data = {};
  return {
    async get(keys) {
      const result = {};
      for (const key of [].concat(keys)) {
        if (key in data) result[key] = structuredClone(data[key]);
      }
      return result;
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
  };
}

// Save one or more top-level keys of `state`, e.g. save('progress', 'timer').
async function save(...keys) {
  const items = {};
  for (const key of keys) items[key] = state[key];
  try {
    await storage.set(items);
  } catch (err) {
    console.error('Sidekick could not save:', err);
  }
}


// ---- 3. State ---------------------------------------------------------------

// Saved state. Each key is stored under the same name in chrome.storage.local.
const state = {
  currentLessonId: null, // the lesson on screen, e.g. 'dataverse-tables'
  skippedLessons: [],  // ids of lessons you chose to skip; Next lesson passes over them
  progress: {},        // { [lessonId]: { index, done: [stepId], quiz: { [stepId]: 'right' | 'wrong' } } }
  stats: newStats(),   // { sessionsCompleted, streak, lastSessionDay: 'YYYY-MM-DD' | null }
  timer: newTimer(),   // { status, endsAt, remainingMs, stepsDoneThisSession }
  sessionLog: [],      // [{ endedAt, minutes, stepsDone, note }]
};

// On-screen-only state. Forgotten when the panel closes, on purpose.
const view = {
  course: null,        // lessons/index.json: the course title and its lesson list
  lessons: [],         // every lesson, fully loaded, in course order
  showLessons: false,  // the lesson list is open
  error: null,         // message for the error card
  hintShown: false,    // hint and answer reset every time the step changes
  answerShown: false,
  showBreak: false,    // the "Logged. Take a break." screen
  pendingImport: null, // a backup file read in, waiting for "Replace my progress"
  dataMessage: '',     // feedback under the Export / Import buttons
};

function newStats() {
  return { sessionsCompleted: 0, streak: 0, lastSessionDay: null };
}

function newTimer() {
  return { status: 'idle', endsAt: null, remainingMs: SESSION_MS, stepsDoneThisSession: 0 };
}

function newLessonProgress() {
  return { index: 0, done: [], quiz: {} };
}


// ---- 4. Page elements -------------------------------------------------------

const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'),
  timerGroup: $('timer-group'),
  timer: $('timer'),
  timerToggle: $('timer-toggle'),
  streak: $('streak'),
  sessions: $('sessions'),
  sessionsLabel: $('sessions-label'),
  lessonsBtn: $('lessons-btn'),
  progressBar: $('progress-bar'),

  stage: $('stage'),
  loading: $('loading'),
  stepView: $('step-view'),
  lessonChip: $('lesson-chip'),
  stepCounter: $('step-counter'),
  stepMinutes: $('step-minutes'),
  stepQuizChip: $('step-quiz-chip'),
  stepDoneChip: $('step-done-chip'),
  stepInstruction: $('step-instruction'),
  stepWhy: $('step-why'),
  stepWarning: $('step-warning'),
  hint: $('hint'),
  answer: $('answer'),

  lessonComplete: $('lesson-complete'),
  completeTitle: $('complete-lesson-title'),
  quizScoreLine: $('quiz-score-line'),
  quizScore: $('quiz-score'),
  nextLessonBtn: $('next-lesson-btn'),
  chooseLessonBtn: $('choose-lesson-btn'),
  courseDone: $('course-done'),
  restartBtn: $('restart-btn'),

  lessonList: $('lesson-list'),
  courseTitle: $('course-title'),
  lessonItems: $('lesson-items'),
  lessonsCloseBtn: $('lessons-close-btn'),
  exportBtn: $('export-btn'),
  importBtn: $('import-btn'),
  importFile: $('import-file'),
  importConfirm: $('import-confirm'),
  importSummary: $('import-summary'),
  importApplyBtn: $('import-apply-btn'),
  importCancelBtn: $('import-cancel-btn'),
  dataMessage: $('data-message'),

  error: $('error'),
  errorDetail: $('error-detail'),
  retryBtn: $('retry-btn'),

  actions: $('actions'),
  scoreRow: $('score-row'),
  rightBtn: $('right-btn'),
  wrongBtn: $('wrong-btn'),
  backBtn: $('back-btn'),
  stuckBtn: $('stuck-btn'),
  doneBtn: $('done-btn'),
  revealBtn: $('reveal-btn'),

  sessionComplete: $('session-complete'),
  logView: $('log-view'),
  sessionSteps: $('session-steps'),
  logForm: $('log-form'),
  logNote: $('log-note'),
  logBtn: $('log-btn'),
  breakView: $('break-view'),
  breakSummary: $('break-summary'),
  breakContinueBtn: $('break-continue-btn'),
};


// ---- 5. Helpers -------------------------------------------------------------

// Local calendar day as 'YYYY-MM-DD'. Local time, not UTC, so a late-night
// session counts for the day the learner thinks it is.
function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function yesterdayKey(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - 1); // Date handles month and year boundaries for us
  return dayKey(d);
}

// 83000 ms -> '01:23'. Rounds up, so the clock only reads 00:00 at the very end.
function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Write text only when it changed (avoids repeat screen-reader announcements).
// Always textContent, never innerHTML, so lesson text can't inject markup.
function setText(node, text) {
  const value = text == null ? '' : String(text);
  if (node.textContent !== value) node.textContent = value;
}

// Fill a node with text, or hide it when there's nothing to show.
function showText(node, text) {
  setText(node, text);
  node.hidden = !node.textContent;
}


// ---- 6. Lessons -------------------------------------------------------------
// lessons/index.json lists the lessons in course order, and each lesson is its
// own JSON file (see lessons/schema.md). They are small local files, so we load
// all of them at start-up: switching lessons is then instant.

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch {
    // Inside an extension a missing file doesn't answer 404: the fetch just fails.
    throw new Error(`${url} could not be found.`);
  }
  if (!response.ok) throw new Error(`${url} answered with HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${url} is not valid JSON.`);
  }
}

async function loadCourse() {
  try {
    const course = tidyCourse(await fetchJson(COURSE_URL));
    const lessons = await Promise.all(course.lessons.map(async (entry) =>
      tidyLesson(await fetchJson(LESSONS_DIR + entry.file), entry)));

    view.course = course;
    view.lessons = lessons;
    view.error = null;
    // First visit, or the saved lesson was removed: open the lesson list so you
    // choose where to start (the first lesson is selected behind it).
    if (!findLesson(state.currentLessonId)) {
      state.currentLessonId = lessons[0].id;
      view.showLessons = true;
      save('currentLessonId');
    }
    // Saved progress may come from an older version of a lesson: make it fit.
    for (const lesson of lessons) {
      state.progress[lesson.id] = tidyProgress(state.progress[lesson.id], lesson.steps.length);
    }
  } catch (err) {
    view.course = null;
    view.lessons = [];
    view.error = err.message;
    console.error('Sidekick could not load the lessons:', err);
  }
}

function tidyCourse(raw) {
  const entries = isObject(raw) && Array.isArray(raw.lessons) ? raw.lessons : [];
  const lessons = entries.filter((entry) =>
    isObject(entry) && typeof entry.id === 'string' && typeof entry.file === 'string');
  if (lessons.length === 0) throw new Error(`${COURSE_URL} lists no lessons.`);
  return { title: raw.title || 'Lessons', lessons };
}

// Keep only usable steps and fill in gaps, so the rest of the code can trust the data.
// The id always comes from index.json, because saved progress is filed under it.
function tidyLesson(raw, entry) {
  if (!isObject(raw) || !Array.isArray(raw.steps)) {
    throw new Error(`${entry.file} has no "steps" list.`);
  }
  const steps = raw.steps
    .filter((step) => isObject(step) && typeof step.instruction === 'string' && step.instruction.trim())
    .map((step, i) => ({
      ...step,
      id: typeof step.id === 'string' && step.id ? step.id : `step-${i + 1}`,
      type: step.type === 'quiz' ? 'quiz' : 'task',
    }));
  if (steps.length === 0) throw new Error(`${entry.file} has no steps.`);
  return { ...raw, id: entry.id, title: raw.title || entry.title || 'Lesson', steps };
}

function tidyProgress(raw, stepCount) {
  const p = isObject(raw) ? raw : {};
  return {
    index: Number.isInteger(p.index) ? clamp(p.index, 0, stepCount) : 0,
    done: Array.isArray(p.done) ? p.done.filter((id) => typeof id === 'string') : [],
    quiz: isObject(p.quiz) ? p.quiz : {},
  };
}

function findLesson(lessonId) {
  return view.lessons.find((lesson) => lesson.id === lessonId) || null;
}

// The lesson on screen, or null while loading (or if loading failed).
function activeLesson() {
  return findLesson(state.currentLessonId);
}

function isSkipped(lesson) {
  return state.skippedLessons.includes(lesson.id);
}

// `p` defaults to your saved progress; a backup file can pass its own.
function isComplete(lesson, p = state.progress[lesson.id]) {
  const total = lesson.steps.length;
  return countDone(lesson, p) === total || p.index >= total;
}

// The next lesson worth doing: the first one after this lesson in course order
// (wrapping around to the start) that is neither complete nor skipped.
function nextLesson() {
  const i = view.lessons.indexOf(activeLesson());
  const after = [...view.lessons.slice(i + 1), ...view.lessons.slice(0, Math.max(i, 0))];
  return after.find((lesson) => !isComplete(lesson) && !isSkipped(lesson)) || null;
}

function lessonProgress() {
  return state.progress[state.currentLessonId];
}

// The step on screen, or null when there's no lesson or it's finished.
// (index === steps.length means "lesson complete".)
function currentStep() {
  const lesson = activeLesson();
  if (!lesson) return null;
  return lesson.steps[lessonProgress().index] || null;
}


// ---- 7. Rendering -----------------------------------------------------------

function render() {
  renderTimer();
  renderStats();
  renderProgress();
  renderMain();
  renderOverlay();
  fitStep();
}

function renderTimer() {
  const { status } = state.timer;
  setText(el.timer, formatClock(timeLeftMs()));
  el.timerGroup.dataset.status = status; // CSS swaps the play/pause icon from this

  const label = status === 'running' ? 'Pause timer'
    : status === 'paused' ? 'Resume timer'
    : `Start ${SESSION_MINUTES}-minute timer`;
  el.timerToggle.setAttribute('aria-label', label);
  el.timerToggle.title = label;
  el.timerToggle.disabled = status === 'ended';
}

function renderStats() {
  const { sessionsCompleted } = state.stats;
  setText(el.streak, visibleStreak(state.stats, new Date()));
  setText(el.sessions, sessionsCompleted);
  setText(el.sessionsLabel, sessionsCompleted === 1 ? 'session' : 'sessions');
}

// A saved streak only counts if the last session was today or yesterday.
// ('YYYY-MM-DD' strings sort like dates, so >= works.)
function visibleStreak(stats, now) {
  if (!stats.lastSessionDay) return 0;
  return stats.lastSessionDay >= yesterdayKey(now) ? stats.streak : 0;
}

function renderProgress() {
  const lesson = activeLesson();
  const total = lesson ? lesson.steps.length : 0;
  const doneCount = lesson ? countDone(lesson) : 0;
  const percent = total ? (doneCount / total) * 100 : 0;
  el.progressBar.style.width = `${percent}%`;
  el.progressBar.setAttribute('aria-valuenow', String(Math.round(percent)));
  el.progressBar.setAttribute('aria-valuetext', `${doneCount} of ${total} steps done`);
}

// Steps of a lesson that are marked done (ignoring ids a newer lesson version dropped).
function countDone(lesson, p = state.progress[lesson.id]) {
  const done = new Set(p.done);
  return lesson.steps.filter((step) => done.has(step.id)).length;
}

// What the middle of the panel shows. Exactly one of these at a time.
function mainMode() {
  if (view.showLessons && view.lessons.length) return 'list';
  if (view.error) return 'error';
  if (!activeLesson()) return 'loading';
  return currentStep() ? 'step' : 'complete';
}

function renderMain() {
  const mode = mainMode();
  el.loading.hidden = mode !== 'loading';
  el.error.hidden = mode !== 'error';
  el.stepView.hidden = mode !== 'step';
  el.lessonComplete.hidden = mode !== 'complete';
  el.lessonList.hidden = mode !== 'list';
  el.actions.hidden = mode !== 'step' && mode !== 'complete';

  el.lessonsBtn.disabled = view.lessons.length === 0;
  el.lessonsBtn.setAttribute('aria-expanded', String(mode === 'list'));

  if (mode === 'error') setText(el.errorDetail, view.error);
  if (mode === 'step') renderStep(currentStep());
  if (mode === 'complete') renderLessonComplete();
  if (mode === 'list') renderLessonList();
  if (mode === 'step' || mode === 'complete') renderActions(currentStep());
}

function renderStep(step) {
  const { index, done } = lessonProgress();
  const lessonNumber = view.lessons.indexOf(activeLesson()) + 1;
  setText(el.lessonChip, `Lesson ${lessonNumber} of ${view.lessons.length}`);
  el.lessonChip.setAttribute('aria-label', `Lesson ${lessonNumber} of ${view.lessons.length}. Choose a lesson`);
  setText(el.stepCounter, `Step ${index + 1} of ${activeLesson().steps.length}`);
  showText(el.stepMinutes, step.estimated_minutes ? `~${step.estimated_minutes} min` : '');
  el.stepQuizChip.hidden = step.type !== 'quiz';
  el.stepDoneChip.hidden = !done.includes(step.id);

  setText(el.stepInstruction, step.instruction);
  showText(el.stepWhy, step.why);
  showText(el.stepWarning, step.warning);
  showText(el.hint, view.hintShown ? step.hint : '');
  showText(el.answer, view.answerShown ? step.answer : '');
}

function renderLessonComplete() {
  const lesson = activeLesson();
  const { quiz } = lessonProgress();
  const quizSteps = lesson.steps.filter((step) => step.type === 'quiz');
  const right = quizSteps.filter((step) => quiz[step.id] === 'right').length;
  setText(el.completeTitle, lesson.title);
  el.quizScoreLine.hidden = quizSteps.length === 0;
  setText(el.quizScore, `${right}/${quizSteps.length}`);

  // Point straight at the next lesson, so there's no decision to make.
  const next = nextLesson();
  el.nextLessonBtn.hidden = !next;
  el.courseDone.hidden = Boolean(next);
  if (next) setText(el.nextLessonBtn, `Next lesson: ${next.title}`);
}

// The lesson list: one row per lesson, with how far along it is and a
// Skip / Add back button. Built with createElement (not innerHTML), like all lesson text.
function renderLessonList() {
  setText(el.courseTitle, view.course.title);
  el.importConfirm.hidden = !view.pendingImport;
  if (view.pendingImport) setText(el.importSummary, backupSummary(view.pendingImport));
  setText(el.dataMessage, view.dataMessage);
  el.lessonItems.replaceChildren(...view.lessons.map((lesson, i) => {
    const title = document.createElement('span');
    title.className = 'lesson-item-title';
    title.textContent = `${i + 1}. ${lesson.title}`;

    const status = document.createElement('span');
    status.className = 'lesson-item-status';
    status.textContent = lessonStatus(lesson);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lesson-item';
    button.dataset.lessonId = lesson.id;
    if (lesson.id === state.currentLessonId) button.setAttribute('aria-current', 'true');
    button.classList.toggle('is-skipped', isSkipped(lesson));
    button.append(title, status);

    const item = document.createElement('li');
    item.className = 'lesson-row';
    item.append(button);

    // A finished lesson has nothing left to skip.
    if (!isComplete(lesson)) {
      const label = isSkipped(lesson) ? 'Add back' : 'Skip';
      const skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'btn btn-secondary skip-btn';
      skip.dataset.skipId = lesson.id;
      skip.textContent = label;
      skip.setAttribute('aria-label', `${label}: ${lesson.title}`);
      item.append(skip);
    }
    return item;
  }));
}

// "Complete", "Skipped", "5 of 24 steps done", or "24 steps, about 70 min".
function lessonStatus(lesson) {
  const total = lesson.steps.length;
  const doneCount = countDone(lesson);
  if (isComplete(lesson)) return 'Complete';
  if (isSkipped(lesson)) return 'Skipped';
  if (doneCount > 0) return `${doneCount} of ${total} steps done`;
  const minutes = lesson.steps.reduce((sum, step) => sum + (Number(step.estimated_minutes) || 0), 0);
  return `${total} steps, about ${minutes} min`;
}

// Which buttons show depends on the step type:
//   task: Back, Stuck, Done
//   quiz: Back, Stuck, Reveal answer  ->  after reveal: I got it right / wrong
function renderActions(step) {
  const isQuiz = step?.type === 'quiz';
  el.backBtn.disabled = lessonProgress().index === 0;
  el.stuckBtn.hidden = !step;
  el.doneBtn.hidden = !step || isQuiz;
  el.revealBtn.hidden = !isQuiz || view.answerShown;
  el.scoreRow.hidden = !isQuiz || !view.answerShown;
  if (step) renderStuckButton(step);
}

// What the next Stuck press reveals: the hint first, then (task steps only)
// the answer. Quiz answers come from "Reveal answer" instead.
function nextHelp(step) {
  if (!view.hintShown && step.hint) return 'hint';
  if (step.type === 'task' && !view.answerShown && step.answer) return 'answer';
  return null;
}

function renderStuckButton(step) {
  const next = nextHelp(step);
  const usedAny = view.hintShown || view.answerShown;
  el.stuckBtn.disabled = next === null;
  setText(el.stuckBtn, next === null ? (usedAny ? 'Help used' : 'No hint') : view.hintShown ? 'Still stuck?' : 'Stuck?');
  el.stuckBtn.title = next === 'answer' ? 'Show the answer (S)' : next === 'hint' ? 'Show a hint (S)' : '';
}

// The full-panel overlay is up while a finished session waits to be logged,
// and for the "take a break" screen right after.
function renderOverlay() {
  const ended = state.timer.status === 'ended';
  const open = ended || view.showBreak;
  const wasOpen = !el.sessionComplete.hidden;

  el.sessionComplete.hidden = !open;
  el.app.inert = open; // nothing behind the overlay can be clicked or tabbed to
  el.logView.hidden = !ended;
  el.breakView.hidden = ended || !view.showBreak;

  if (ended) {
    setText(el.sessionSteps, state.timer.stepsDoneThisSession);
    if (!wasOpen) el.logNote.focus();
  }
  if (view.showBreak) {
    const streak = visibleStreak(state.stats, new Date());
    const sessions = state.stats.sessionsCompleted;
    setText(el.breakSummary,
      `${streak} day streak · ${sessions} ${sessions === 1 ? 'session' : 'sessions'} completed`);
  }
}


// ---- 8. Auto-fit ------------------------------------------------------------
// A step must never scroll. Everything inside the step card is sized in `em`,
// so one CSS variable (--text-scale) shrinks it all together. We binary-search
// for the largest scale at which the content still fits inside the card.

function fitStep() {
  const card = el.stepView;
  if (card.hidden) return;
  card.classList.remove('is-scrollable');

  setTextScale(card, 1);
  if (fits(card)) return; // the usual case: full size fits

  let good = MIN_TEXT_SCALE;
  let bad = 1;
  setTextScale(card, good);
  if (!fits(card)) {
    // A panel far smaller than we design for: allow scrolling rather than cut text off.
    card.classList.add('is-scrollable');
    return;
  }
  for (let i = 0; i < 7; i++) { // 7 halvings lands within 0.5% of the best size
    const mid = (good + bad) / 2;
    setTextScale(card, mid);
    if (fits(card)) good = mid;
    else bad = mid;
  }
  setTextScale(card, good);
}

// When the text has to shrink a lot (usually because the hint and answer are
// open), the instruction shrinks a little faster than the rest, from 1.625x the
// body size down to 1.25x, so the hint and answer stay readable.
function setTextScale(card, scale) {
  const t = clamp((scale - MIN_TEXT_SCALE) / (HERO_KEEP_SCALE - MIN_TEXT_SCALE), 0, 1); // 1 = keep full ratio
  const heroRatio = HERO_RATIO.smallest + (HERO_RATIO.full - HERO_RATIO.smallest) * t;
  card.style.setProperty('--text-scale', scale.toFixed(3));
  card.style.setProperty('--hero-ratio', heroRatio.toFixed(3));
}

// Reading scrollHeight makes the browser lay out the card at the current scale.
function fits(node) {
  return node.scrollHeight <= node.clientHeight + 1;
}

// Re-fit when the panel is resized, at most once per frame.
let fitQueued = false;
function queueFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitStep();
  });
}


// ---- 9. Step actions --------------------------------------------------------

// The overlay already covers the lesson; this also stops keyboard shortcuts.
function lessonIsBlocked() {
  return state.timer.status === 'ended' || view.showBreak;
}

function onDone() {
  const step = currentStep();
  if (!step || step.type === 'quiz' || lessonIsBlocked()) return;
  startTimerIfIdle();
  completeStep(step);
}

function onStuck() {
  const step = currentStep();
  if (!step || lessonIsBlocked()) return;
  const next = nextHelp(step);
  if (!next) return;
  startTimerIfIdle();
  if (next === 'hint') view.hintShown = true;
  else view.answerShown = true;
  render();
}

function onReveal() {
  const step = currentStep();
  if (!step || step.type !== 'quiz' || lessonIsBlocked()) return;
  startTimerIfIdle();
  view.answerShown = true;
  render();
}

// Quiz self-score: record 'right' or 'wrong', then move on like Done.
function onScore(result) {
  const step = currentStep();
  if (!step || step.type !== 'quiz' || !view.answerShown || lessonIsBlocked()) return;
  startTimerIfIdle();
  lessonProgress().quiz[step.id] = result;
  completeStep(step);
}

function onBack() {
  if (!activeLesson() || lessonIsBlocked()) return;
  const { index } = lessonProgress();
  if (index === 0) return;
  goToStep(index - 1);
  save('progress');
}

// Clears this lesson's steps and quiz answers. Stats, streak and timer are untouched.
function onRestart() {
  if (!activeLesson() || lessonIsBlocked()) return;
  state.progress[state.currentLessonId] = newLessonProgress();
  goToStep(0);
  save('progress');
}

async function onRetry() {
  el.retryBtn.disabled = true;
  await loadCourse();
  el.retryBtn.disabled = false;
  render();
}

// Switch to another lesson. Each lesson keeps its own place, so you land on
// the step where you left it (or its "Lesson complete" card).
function openLesson(lessonId) {
  if (!findLesson(lessonId) || lessonIsBlocked()) return;
  state.currentLessonId = lessonId;
  view.showLessons = false;
  goToStep(lessonProgress().index);
  save('currentLessonId');
}

function onNextLesson() {
  const next = nextLesson();
  if (next) openLesson(next.id);
}

function onLessonsToggle() {
  if (view.lessons.length === 0 || lessonIsBlocked()) return;
  view.showLessons = !view.showLessons;
  view.pendingImport = null;
  view.dataMessage = '';
  render();
  // Put keyboard focus somewhere useful in the view that just opened.
  if (view.showLessons) el.lessonItems.querySelector('[aria-current="true"]')?.focus();
  else el.lessonsBtn.focus();
}

function onLessonListClick(event) {
  const skip = event.target.closest('button[data-skip-id]');
  if (skip) {
    toggleSkip(skip.dataset.skipId);
    return;
  }
  const lesson = event.target.closest('button[data-lesson-id]');
  if (lesson) openLesson(lesson.dataset.lessonId);
}

function toggleSkip(lessonId) {
  const skipped = state.skippedLessons;
  state.skippedLessons = skipped.includes(lessonId)
    ? skipped.filter((id) => id !== lessonId)
    : [...skipped, lessonId];
  save('skippedLessons');
  render();
  // The list was rebuilt, so put focus back on the same row's button.
  el.lessonItems.querySelector(`[data-skip-id="${CSS.escape(lessonId)}"]`)?.focus();
}

// Mark a step done, count it toward this session (first time only), move on.
function completeStep(step) {
  const progress = lessonProgress();
  if (!progress.done.includes(step.id)) {
    progress.done.push(step.id);
    state.timer.stepsDoneThisSession += 1;
  }
  goToStep(progress.index + 1);
  save('progress', 'timer');
}

function goToStep(index) {
  lessonProgress().index = clamp(index, 0, activeLesson().steps.length);
  view.hintShown = false;
  view.answerShown = false;
  render();
}


// ---- 10. Focus timer --------------------------------------------------------
// While running, the timer is saved as an end time (endsAt) rather than as
// "time left", so it keeps counting while the panel is closed. Pausing turns
// it back into remainingMs.

function timeLeftMs() {
  const t = state.timer;
  if (t.status === 'running') return Math.max(0, t.endsAt - Date.now());
  if (t.status === 'ended') return 0;
  return t.remainingMs;
}

function startTimer() {
  const t = state.timer;
  const left = t.status === 'paused' && t.remainingMs > 0 ? t.remainingMs : SESSION_MS;
  t.status = 'running';
  t.endsAt = Date.now() + left;
  t.remainingMs = left;
  save('timer');
}

function pauseTimer() {
  const t = state.timer;
  t.remainingMs = Math.max(0, t.endsAt - Date.now());
  t.endsAt = null;
  t.status = 'paused';
  save('timer');
}

// A session starts by itself on the first Done or Stuck press.
function startTimerIfIdle() {
  if (state.timer.status === 'idle') startTimer();
}

function onTimerToggle() {
  const { status } = state.timer;
  if (status === 'running') pauseTimer();
  else if (status === 'idle' || status === 'paused') startTimer();
  renderTimer();
}

// Runs a few times a second: refresh the clock and catch the moment it hits zero.
function tick() {
  const t = state.timer;
  if (t.status === 'running' && Date.now() >= t.endsAt) endSession();
  else renderTimer();
}

function endSession() {
  const t = state.timer;
  t.status = 'ended';
  t.remainingMs = 0; // endsAt is kept: it records when the session finished
  save('timer');
  render();
}

// Make sure a saved timer has a sane shape; anything odd becomes a fresh timer.
function tidyTimer(raw) {
  if (!isObject(raw)) return newTimer();
  const t = { ...newTimer(), ...raw };
  if (!['idle', 'running', 'paused', 'ended'].includes(t.status)) return newTimer();
  if (t.status === 'running' && !Number.isFinite(t.endsAt)) return newTimer();
  if (!Number.isFinite(t.remainingMs)) t.remainingMs = SESSION_MS;
  if (!Number.isInteger(t.stepsDoneThisSession)) t.stepsDoneThisSession = 0;
  return t;
}


// ---- 11. Session log --------------------------------------------------------

function noteIsValid(text) {
  return text.replace(/\s/g, '').length >= MIN_NOTE_CHARS;
}

function onNoteInput() {
  el.logBtn.disabled = !noteIsValid(el.logNote.value);
}

function onLogSubmit(event) {
  event.preventDefault(); // stay on the page; we handle the form ourselves
  const note = el.logNote.value.trim();
  if (state.timer.status !== 'ended' || !noteIsValid(note)) return;

  const now = new Date();
  updateStreak(state.stats, now);
  state.stats.sessionsCompleted += 1;
  state.sessionLog.push({
    endedAt: new Date(state.timer.endsAt || now.getTime()).toISOString(),
    minutes: SESSION_MINUTES,
    stepsDone: state.timer.stepsDoneThisSession,
    note,
  });
  state.timer = newTimer(); // back to idle 25:00 until the next Done, Stuck, or play
  save('stats', 'sessionLog', 'timer');

  el.logNote.value = '';
  el.logBtn.disabled = true;
  view.showBreak = true;
  render();
  el.breakContinueBtn.focus();
}

// Streak = consecutive local calendar days with at least one logged session.
function updateStreak(stats, now) {
  const today = dayKey(now);
  if (stats.lastSessionDay === today) {
    stats.streak = Math.max(1, stats.streak);   // already counted today
  } else if (stats.lastSessionDay === yesterdayKey(now)) {
    stats.streak += 1;                          // kept the chain going
  } else {
    stats.streak = 1;                           // first session, or a gap: start again
  }
  stats.lastSessionDay = today;
}

function onBreakContinue() {
  view.showBreak = false;
  render();
}

function tidyStats(raw) {
  const s = isObject(raw) ? raw : {};
  const count = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);
  return {
    sessionsCompleted: count(s.sessionsCompleted),
    streak: count(s.streak),
    lastSessionDay: /^\d{4}-\d{2}-\d{2}$/.test(s.lastSessionDay) ? s.lastSessionDay : null,
  };
}


// ---- 12. Backup -------------------------------------------------------------
// Your progress lives only in this browser (chrome.storage.local). A backup is
// a small JSON file of it, so you can keep a copy or move to another computer.
// The timer is left out on purpose: a backup is about progress, not a session.

const BACKUP_FORMAT = 1;

function onExport() {
  const backup = {
    app: 'sidekick',
    format: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    data: {
      currentLessonId: state.currentLessonId,
      skippedLessons: state.skippedLessons,
      progress: state.progress,
      stats: state.stats,
      sessionLog: state.sessionLog,
    },
  };
  // Clicking a temporary link with the download attribute saves the file,
  // without needing Chrome's "downloads" permission.
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `sidekick-progress-${dayKey(new Date())}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  view.pendingImport = null;
  view.dataMessage = `Exported ${link.download}. Check your downloads.`;
  render();
}

function onImportClick() {
  el.importFile.click();
}

// Read the chosen file and ask before replacing anything.
async function onImportFile() {
  const file = el.importFile.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    el.importFile.value = ''; // so picking the same file again still counts as a change
    view.pendingImport = readBackup(JSON.parse(text));
    view.dataMessage = '';
  } catch {
    el.importFile.value = '';
    view.pendingImport = null;
    view.dataMessage = `${file.name} isn't a Sidekick progress file. Nothing was changed.`;
  }
  render();
  if (view.pendingImport) el.importApplyBtn.focus();
}

// Check the file's shape and keep only data the panel understands.
function readBackup(raw) {
  if (!isObject(raw) || raw.app !== 'sidekick' || raw.format !== BACKUP_FORMAT || !isObject(raw.data)) {
    throw new Error('Not a Sidekick backup.');
  }
  const d = raw.data;
  return {
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null,
    currentLessonId: typeof d.currentLessonId === 'string' ? d.currentLessonId : null,
    skippedLessons: Array.isArray(d.skippedLessons) ? d.skippedLessons.filter((id) => typeof id === 'string') : [],
    progress: isObject(d.progress) ? d.progress : {},
    stats: tidyStats(d.stats),
    sessionLog: Array.isArray(d.sessionLog) ? d.sessionLog.filter(isObject) : [],
  };
}

// "This file is from 26/10/2026: 3 of 7 lessons complete, ..." so you know what you're loading.
function backupSummary(backup) {
  const date = backup.exportedAt ? new Date(backup.exportedAt).toLocaleDateString() : 'an unknown date';
  const complete = view.lessons.filter((lesson) =>
    isComplete(lesson, tidyProgress(backup.progress[lesson.id], lesson.steps.length))).length;
  const sessions = backup.stats.sessionsCompleted;
  const streak = visibleStreak(backup.stats, new Date());
  return `This file is from ${date}: ${complete} of ${view.lessons.length} lessons complete, `
    + `${sessions} ${sessions === 1 ? 'session' : 'sessions'}, ${streak} day streak. `
    + 'Replace your progress in this browser with it?';
}

function onImportApply() {
  const backup = view.pendingImport;
  if (!backup) return;
  state.progress = backup.progress;
  state.stats = backup.stats;
  state.sessionLog = backup.sessionLog;
  state.skippedLessons = backup.skippedLessons;
  state.currentLessonId = findLesson(backup.currentLessonId) ? backup.currentLessonId : view.lessons[0].id;
  for (const lesson of view.lessons) {
    state.progress[lesson.id] = tidyProgress(state.progress[lesson.id], lesson.steps.length);
  }
  save('currentLessonId', 'skippedLessons', 'progress', 'stats', 'sessionLog');

  view.pendingImport = null;
  view.hintShown = false;
  view.answerShown = false;
  view.dataMessage = 'Progress imported.';
  render();
}

function onImportCancel() {
  view.pendingImport = null;
  view.dataMessage = 'Import cancelled. Nothing was changed.';
  render();
}


// ---- 13. Keyboard shortcuts -------------------------------------------------
// Enter = Done (or Reveal answer on a quiz), S = Stuck, B or Left arrow = Back,
// L = open or close the lesson list, Escape = close it.
// Ignored while typing, while the session overlay is up, and for held-down keys.

function onKeyDown(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;

  if (event.repeat) {
    // Holding Enter on a focused button would otherwise race through steps.
    if (event.key === 'Enter' || event.key === ' ') event.preventDefault();
    return;
  }
  if (lessonIsBlocked()) return;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === 'l' || (key === 'Escape' && view.showLessons)) {
    event.preventDefault();
    onLessonsToggle();
    return;
  }
  if (view.showLessons) return; // the step shortcuts don't apply while the list is open

  let button = null;
  if (key === 'Enter' && !target?.closest('button')) {
    // (On a focused button, Enter already clicks that button.)
    button = el.doneBtn.hidden ? el.revealBtn : el.doneBtn;
  } else if (key === 's') {
    button = el.stuckBtn;
  } else if (key === 'b' || key === 'ArrowLeft') {
    button = el.backBtn;
  }

  if (button && !button.disabled && button.checkVisibility()) {
    event.preventDefault();
    button.click();
  }
}


// ---- 14. Start-up -----------------------------------------------------------

async function restoreState() {
  try {
    const saved = await storage.get(['currentLessonId', 'skippedLessons', 'progress', 'stats', 'timer', 'sessionLog']);
    state.currentLessonId = typeof saved.currentLessonId === 'string' ? saved.currentLessonId : null;
    state.skippedLessons = Array.isArray(saved.skippedLessons)
      ? saved.skippedLessons.filter((id) => typeof id === 'string')
      : [];
    state.progress = isObject(saved.progress) ? saved.progress : {};
    state.stats = tidyStats(saved.stats);
    state.timer = tidyTimer(saved.timer);
    state.sessionLog = Array.isArray(saved.sessionLog) ? saved.sessionLog : [];
  } catch (err) {
    console.error('Sidekick could not read saved data:', err);
  }

  // The panel was closed mid-session and the time ran out meanwhile.
  const t = state.timer;
  if (t.status === 'running' && Date.now() >= t.endsAt) {
    t.status = 'ended';
    t.remainingMs = 0;
    save('timer');
  }
}

function wireEvents() {
  el.timerToggle.addEventListener('click', onTimerToggle);
  el.doneBtn.addEventListener('click', onDone);
  el.stuckBtn.addEventListener('click', onStuck);
  el.backBtn.addEventListener('click', onBack);
  el.revealBtn.addEventListener('click', onReveal);
  el.rightBtn.addEventListener('click', () => onScore('right'));
  el.wrongBtn.addEventListener('click', () => onScore('wrong'));
  el.restartBtn.addEventListener('click', onRestart);
  el.nextLessonBtn.addEventListener('click', onNextLesson);
  el.lessonsBtn.addEventListener('click', onLessonsToggle);
  el.lessonsCloseBtn.addEventListener('click', onLessonsToggle);
  el.lessonChip.addEventListener('click', onLessonsToggle);
  el.chooseLessonBtn.addEventListener('click', onLessonsToggle);
  el.lessonItems.addEventListener('click', onLessonListClick);
  el.retryBtn.addEventListener('click', onRetry);
  el.logNote.addEventListener('input', onNoteInput);
  el.logForm.addEventListener('submit', onLogSubmit);
  el.breakContinueBtn.addEventListener('click', onBreakContinue);
  el.exportBtn.addEventListener('click', onExport);
  el.importBtn.addEventListener('click', onImportClick);
  el.importFile.addEventListener('change', onImportFile);
  el.importApplyBtn.addEventListener('click', onImportApply);
  el.importCancelBtn.addEventListener('click', onImportCancel);
  document.addEventListener('keydown', onKeyDown);
  // Check the clock straight away when the panel comes back into view.
  document.addEventListener('visibilitychange', tick);
  new ResizeObserver(queueFit).observe(el.stage);
}

async function start() {
  await restoreState(); // first, so no click can overwrite saved data with defaults
  wireEvents();
  render();             // timer and stats appear while the lesson loads
  setInterval(tick, 250);
  await loadCourse();
  render();
}

start();
