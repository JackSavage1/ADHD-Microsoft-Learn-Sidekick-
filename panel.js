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
      6. Lesson          fetch and tidy the lesson JSON
      7. Rendering       turn state into what's on screen
      8. Auto-fit        shrink text so a step never needs scrolling
      9. Step actions    Done, Stuck, Back, quiz scoring, restart
     10. Focus timer     start, pause, tick, end
     11. Session log     the "walk away" screen and the streak maths
     12. Keyboard        optional shortcuts
     13. Start-up

   The pattern everywhere: an action changes `state`, saves it, then calls
   render(), which redraws the screen from `state`. Nothing else touches the page.
   ========================================================================== */


// ---- 1. Settings ------------------------------------------------------------

const LESSON_URL = 'lessons/dataverse-tables.json';
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
  progress: {},        // { [lessonId]: { index, done: [stepId], quiz: { [stepId]: 'right' | 'wrong' } } }
  stats: newStats(),   // { sessionsCompleted, streak, lastSessionDay: 'YYYY-MM-DD' | null }
  timer: newTimer(),   // { status, endsAt, remainingMs, stepsDoneThisSession }
  sessionLog: [],      // [{ endedAt, minutes, stepsDone, note }]
};

// On-screen-only state. Forgotten when the panel closes, on purpose.
const view = {
  lesson: null,        // the loaded lesson
  error: null,         // message for the error card
  hintShown: false,    // hint and answer reset every time the step changes
  answerShown: false,
  showBreak: false,    // the "Logged. Take a break." screen
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
  progressBar: $('progress-bar'),

  stage: $('stage'),
  loading: $('loading'),
  stepView: $('step-view'),
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
  restartBtn: $('restart-btn'),

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


// ---- 6. Lesson --------------------------------------------------------------

async function loadLesson() {
  try {
    const response = await fetch(LESSON_URL);
    if (!response.ok) throw new Error(`${LESSON_URL} answered with HTTP ${response.status}.`);
    view.lesson = tidyLesson(await response.json());
    view.error = null;
    // Saved progress may come from an older version of the lesson: make it fit.
    const id = view.lesson.id;
    state.progress[id] = tidyProgress(state.progress[id], view.lesson.steps.length);
  } catch (err) {
    view.lesson = null;
    view.error = err instanceof SyntaxError ? `${LESSON_URL} is not valid JSON.` : err.message;
    console.error('Sidekick could not load the lesson:', err);
  }
}

// Keep only usable steps and fill in gaps, so the rest of the code can trust the data.
function tidyLesson(raw) {
  if (!isObject(raw) || !Array.isArray(raw.steps)) {
    throw new Error('The lesson file has no "steps" list.');
  }
  const steps = raw.steps
    .filter((step) => isObject(step) && typeof step.instruction === 'string' && step.instruction.trim())
    .map((step, i) => ({
      ...step,
      id: typeof step.id === 'string' && step.id ? step.id : `step-${i + 1}`,
      type: step.type === 'quiz' ? 'quiz' : 'task',
    }));
  if (steps.length === 0) throw new Error('The lesson file has no steps.');
  return { ...raw, id: String(raw.id || 'lesson'), title: raw.title || 'Lesson', steps };
}

function tidyProgress(raw, stepCount) {
  const p = isObject(raw) ? raw : {};
  return {
    index: Number.isInteger(p.index) ? clamp(p.index, 0, stepCount) : 0,
    done: Array.isArray(p.done) ? p.done.filter((id) => typeof id === 'string') : [],
    quiz: isObject(p.quiz) ? p.quiz : {},
  };
}

function lessonProgress() {
  return state.progress[view.lesson.id];
}

// The step on screen, or null when there's no lesson or it's finished.
// (index === steps.length means "lesson complete".)
function currentStep() {
  if (!view.lesson) return null;
  return view.lesson.steps[lessonProgress().index] || null;
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
  let doneCount = 0;
  let total = 0;
  if (view.lesson) {
    const done = new Set(lessonProgress().done);
    total = view.lesson.steps.length;
    doneCount = view.lesson.steps.filter((step) => done.has(step.id)).length;
  }
  const percent = total ? (doneCount / total) * 100 : 0;
  el.progressBar.style.width = `${percent}%`;
  el.progressBar.setAttribute('aria-valuenow', String(Math.round(percent)));
  el.progressBar.setAttribute('aria-valuetext', `${doneCount} of ${total} steps done`);
}

// The middle of the panel: loading text, error card, a step, or "lesson complete".
function renderMain() {
  const step = currentStep();
  const finished = Boolean(view.lesson) && !step;

  el.loading.hidden = Boolean(view.lesson || view.error);
  el.error.hidden = !view.error;
  el.stepView.hidden = !step;
  el.lessonComplete.hidden = !finished;
  el.actions.hidden = !view.lesson;

  if (view.error) setText(el.errorDetail, view.error);
  if (step) renderStep(step);
  if (finished) renderLessonComplete();
  if (view.lesson) renderActions(step);
}

function renderStep(step) {
  const { index, done } = lessonProgress();
  setText(el.stepCounter, `Step ${index + 1} of ${view.lesson.steps.length}`);
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
  const { quiz } = lessonProgress();
  const quizSteps = view.lesson.steps.filter((step) => step.type === 'quiz');
  const right = quizSteps.filter((step) => quiz[step.id] === 'right').length;
  setText(el.completeTitle, view.lesson.title);
  el.quizScoreLine.hidden = quizSteps.length === 0;
  setText(el.quizScore, `${right}/${quizSteps.length}`);
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
  if (!view.lesson || lessonIsBlocked()) return;
  const { index } = lessonProgress();
  if (index === 0) return;
  goToStep(index - 1);
  save('progress');
}

// Clears this lesson's steps and quiz answers. Stats, streak and timer are untouched.
function onRestart() {
  if (!view.lesson || lessonIsBlocked()) return;
  state.progress[view.lesson.id] = newLessonProgress();
  goToStep(0);
  save('progress');
}

async function onRetry() {
  el.retryBtn.disabled = true;
  await loadLesson();
  el.retryBtn.disabled = false;
  render();
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
  lessonProgress().index = clamp(index, 0, view.lesson.steps.length);
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


// ---- 12. Keyboard shortcuts -------------------------------------------------
// Enter = Done (or Reveal answer on a quiz), S = Stuck, B or Left arrow = Back.
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

  let button = null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
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


// ---- 13. Start-up -----------------------------------------------------------

async function restoreState() {
  try {
    const saved = await storage.get(['progress', 'stats', 'timer', 'sessionLog']);
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
  el.retryBtn.addEventListener('click', onRetry);
  el.logNote.addEventListener('input', onNoteInput);
  el.logForm.addEventListener('submit', onLogSubmit);
  el.breakContinueBtn.addEventListener('click', onBreakContinue);
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
  await loadLesson();
  render();
}

start();
