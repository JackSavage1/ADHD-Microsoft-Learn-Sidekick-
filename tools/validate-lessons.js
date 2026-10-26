// Checks lessons/index.json and every lesson it lists against lessons/schema.md.
// Optional, like make-icons.js: the extension never runs this file.
//
// Usage:
//   node tools/validate-lessons.js                        check the index and every lesson in it
//   node tools/validate-lessons.js lessons/my-lesson.json  check one lesson (not yet in the index)
// Exits with code 1 and lists every problem if anything is wrong.
'use strict';

const fs = require('fs');
const path = require('path');

const LESSONS_DIR = path.join(__dirname, '..', 'lessons');
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Word limits from lessons/schema.md ("under 40 words" means at most 39).
const LIMITS = { instruction: 39, why: 25, hint: 30, answer: 50, warning: 25 };
const REQUIRED_STEP_KEYS = ['id', 'type', 'instruction', 'why', 'estimated_minutes', 'hint', 'answer'];
const OPTIONAL_STEP_KEYS = ['warning'];

// Markdown and HTML would show up literally, because the panel uses textContent.
const FORBIDDEN = [
  ['*', /\*/], ['__', /__/], ['`', /`/], ['<', /</], ['>', />/], ['#', /#/],
  ['[', /\[/], [']', /\]/], ['line break', /[\r\n]/], ['HTML entity', /&[a-z]+;/i],
];

const problems = [];
const problem = (where, message) => problems.push(`${where}: ${message}`);
const countWords = (text) => text.trim().split(/\s+/).filter(Boolean).length;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(LESSONS_DIR, file), 'utf8'));
  } catch (err) {
    problem(file, `cannot read as JSON (${err.message})`);
    return null;
  }
}


// ---- The course index -------------------------------------------------------
// With file arguments, skip the index and check just those lessons.

const args = process.argv.slice(2);
const index = args.length ? null : readJson('index.json');
let entries = index && Array.isArray(index.lessons) ? index.lessons : [];
if (index && entries.length === 0) problem('index.json', '"lessons" must be a non-empty list');
const standalone = args.length > 0;

const lessonIds = new Set();
for (const entry of entries) {
  const where = `index.json ${entry && entry.id}`;
  if (!entry || typeof entry.id !== 'string' || !KEBAB.test(entry.id)) problem(where, 'id must be kebab-case');
  else if (lessonIds.has(entry.id)) problem(where, 'duplicate lesson id');
  else lessonIds.add(entry.id);
  if (!entry || typeof entry.title !== 'string' || !entry.title.trim()) problem(where, 'title is missing');
  if (!entry || entry.file !== `${entry.id}.json`) problem(where, 'file must be "<id>.json"');
}


// ---- Each lesson -------------------------------------------------------------

if (standalone) {
  entries = args.map((arg) => {
    const file = path.resolve(arg);
    const lesson = readJson(file) || {};
    return { id: path.basename(file, '.json'), title: lesson.title, file };
  });
}

let grandTotal = 0;
for (const entry of entries) {
  if (!entry || typeof entry.file !== 'string') continue;
  const lesson = readJson(entry.file);
  if (!lesson) continue;
  const file = path.basename(entry.file);

  if (lesson.schema_version !== 1) problem(file, 'schema_version must be 1');
  if (lesson.id !== entry.id) problem(file, `id "${lesson.id}" must match ${standalone ? 'the file name' : `index.json "${entry.id}"`}`);
  if (typeof lesson.title !== 'string' || !lesson.title.trim()) problem(file, 'title is missing');
  else if (lesson.title !== entry.title) problem(file, 'title does not match index.json');
  if (typeof lesson.source !== 'string' || !lesson.source.startsWith('https://')) problem(file, 'source must be an https URL');
  for (const key of Object.keys(lesson)) {
    if (!['schema_version', 'id', 'title', 'source', 'steps'].includes(key)) problem(file, `unexpected key "${key}"`);
  }

  const steps = Array.isArray(lesson.steps) ? lesson.steps : [];
  if (steps.length === 0) problem(file, 'steps must be a non-empty list');

  const stepIds = new Set();
  let minutes = 0;
  steps.forEach((step, i) => {
    const where = `${file} step ${i + 1} (${step && step.id})`;
    if (!step || typeof step !== 'object') return problem(where, 'not an object');

    for (const key of REQUIRED_STEP_KEYS) if (!(key in step)) problem(where, `missing "${key}"`);
    for (const key of Object.keys(step)) {
      if (!REQUIRED_STEP_KEYS.includes(key) && !OPTIONAL_STEP_KEYS.includes(key)) problem(where, `unexpected key "${key}"`);
    }

    if (typeof step.id !== 'string' || !KEBAB.test(step.id)) problem(where, 'id must be kebab-case');
    else if (stepIds.has(step.id)) problem(where, 'duplicate step id');
    else stepIds.add(step.id);

    // Convention: exactly 3 quiz steps, and they come last.
    const inLastThree = i >= steps.length - 3;
    if (step.type !== 'task' && step.type !== 'quiz') problem(where, 'type must be "task" or "quiz"');
    else if (inLastThree && step.type !== 'quiz') problem(where, 'the last 3 steps must be quiz steps');
    else if (!inLastThree && step.type === 'quiz') problem(where, 'quiz steps belong only at the end');

    if (!Number.isInteger(step.estimated_minutes) || step.estimated_minutes < 1 || step.estimated_minutes > 10) {
      problem(where, 'estimated_minutes must be a whole number from 1 to 10');
    } else {
      minutes += step.estimated_minutes;
    }

    for (const [field, max] of Object.entries(LIMITS)) {
      if (!(field in step)) continue;
      const text = step[field];
      if (typeof text !== 'string' || !text.trim()) {
        problem(where, `${field} must be non-empty text (omit "warning" instead of leaving it empty)`);
        continue;
      }
      if (countWords(text) > max) problem(where, `${field} has ${countWords(text)} words (max ${max})`);
      for (const [label, pattern] of FORBIDDEN) {
        if (pattern.test(text)) problem(where, `${field} contains "${label}"`);
      }
    }
  });

  grandTotal += minutes;
  console.log(`${file}: ${steps.length} steps, about ${minutes} min`);
}


// ---- Report ------------------------------------------------------------------

console.log(`${entries.length} lesson(s), about ${grandTotal} min in total`);
if (problems.length) {
  console.log(`\nFAIL: ${problems.length} problem(s)`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('PASS');
