# Sidekick lesson format (schema_version 1)

## Purpose

A lesson file turns one Microsoft Learn module into a sequence of small, hands-on
steps that the Sidekick side panel shows **one at a time** while the learner works in
their real environment (for example make.powerapps.com). Each step tells the learner
what to do, why it matters, and offers a hint and an answer on demand.

The panel is built for ADHD-friendly focus:

- Only one step is on screen at a time, in a ~360px-wide side panel with large type.
- The panel **does not scroll**. If a field is too long, it gets cut off or crowds out
  the buttons. That is why every text field has a hard word limit.
- Steps are short (1 to 5 minutes is the sweet spot) so a 25-minute focus session
  holds several clear wins.
- Steps are **actions, not reading**. The learner clicks, creates, looks, predicts and
  checks. Doing keeps attention; reading a wall of text loses it.

## Where lessons live and how they load

- One JSON file per module in `lessons/`, named after the lesson `id`:
  `lessons/<id>.json` (for example `lessons/dataverse-tables.json`).
- The UI loads a lesson from the path in the `LESSON_URL` constant near the top of
  `panel.js`. To ship a different module, add its JSON file here and point
  `LESSON_URL` at it.
- The file must be valid JSON (UTF-8, no comments, no trailing commas).

## Top-level fields

| Field | Type | Required | Rule | Example |
|---|---|---|---|---|
| `schema_version` | integer | yes | Always `1` for this format. | `1` |
| `id` | string | yes | Unique kebab-case lesson id; matches the file name. Never rename it once published. | `"dataverse-tables"` |
| `title` | string | yes | The Microsoft Learn module title, as shown on Learn. | `"Manage tables in Dataverse"` |
| `source` | string | yes | https URL of the Learn module's landing page. | `"https://learn.microsoft.com/en-us/training/modules/create-manage-entities/"` |
| `steps` | array | yes | Ordered list of step objects (below). Shown in array order. | `[ { ... } ]` |

No other top-level keys.

## Step fields

Words are counted as whitespace-separated tokens ("Set advanced properties" = 3 words).

| Field | Type | Required | Limit | Meaning | Example |
|---|---|---|---|---|---|
| `id` | string | yes | kebab-case, unique within the lesson | Stable key used to save progress. | `"enable-attachments"` |
| `type` | string | yes | `"task"` or `"quiz"` | Hands-on step or knowledge check. | `"task"` |
| `instruction` | string | yes | **under 40 words** (max 39) | Task: an imperative naming the exact page and button or menu. Quiz: the question. | `"Open the Interaction table and click Properties on the command bar. Check Enable attachments (including notes and files), then click Save."` |
| `why` | string | yes | **one sentence, max 25 words** | The concept this step teaches, and why it matters. | `"Attachments let users add notes and files to each record, such as meeting slides or call summaries."` |
| `estimated_minutes` | integer | yes | whole number **1 to 10** | Honest time estimate, used for session planning. | `3` |
| `hint` | string | yes | **max 30 words** | A nudge that does not give the answer away: where to look, what a label might be called, the common UI alternative. | `"Properties may hide under the three dots on the command bar."` |
| `answer` | string | yes | **max 50 words** | Task: the exact click path plus what the learner should see when it worked. Quiz: the correct answer plus a one-line reason. | `"Edit table panel: check Enable attachments, then Save. Reopen Properties: the box stays checked and greyed out."` |
| `warning` | string | no | **max 25 words** | Shown in a caution box. Use it only for irreversible or risky actions. **Omit the key** when not needed (no `null`, no `""`). | `"Irreversible. Once attachments are enabled on a table, they can never be turned off again."` |

No other step keys.

### Plain text only

Every text field is inserted with `textContent`, so formatting characters would show
up literally. Do not use markdown or HTML: no `*`, `**`, `_ _`, backticks, `#`,
`[ ]`, `< >`, HTML entities, or line breaks. Write UI labels as they appear on screen
(for example: click New table, then Set advanced properties) and use commas or
"then" instead of arrows.

## task vs. quiz

- **task**: something the learner does in their own environment: open, click, create,
  look at, or predict-then-check. `instruction` is an order ("Click ..."), `hint` helps
  if they are stuck, `answer` confirms the path and the visible result.
- **quiz**: a question that checks understanding of the module's most important ideas.
  `instruction` is the question, `hint` points at the step that taught it, `answer` is
  the correct answer with a one-line reason. Scenario questions ("Your manager asks
  ...") work better than definitions.
- **Convention**: every module ends with **exactly 3 quiz steps** as the last three
  entries, and no quiz step appears earlier.

## Writing rules: hands-on, not reading

1. Never write "Read about X" or "Learn what X is". Turn the idea into an action: open a
   real example, find the setting, create the thing, or predict and then check.
2. Name the exact place: page, left-menu item, tab, button, and field label. Example:
   "In your Power Apps tab, left menu, click Tables, then open your Interaction table".
3. Labels in the maker portal move around. Put the common alternative in `hint` or
   `answer` ("No Tables in the left menu? Click More, then Tables").
4. For ideas with no natural click (licensing, design choices), make a decision task:
   "Look at table X and write down which license it needs, then check the answer."
5. Start with setup (correct environment, never production). Build up concepts in the
   order the learner needs them.
6. One idea per step. If a step needs "and also", split it.
7. Add a `warning` for anything permanent (table type, schema names, enabling
   attachments, deleting data), and only then, so warnings keep their weight.
8. Be accurate to the Learn module. If a detail cannot be verified, keep the claim
   general rather than inventing specifics.
9. Aim for 18 to 25 steps, 1 to 5 minutes each, about 60 to 80 minutes in total
   (two or three 25-minute focus sessions).

## Why the limits exist

| Limit | Reason |
|---|---|
| instruction under 40 words | It is the first thing on screen and must be readable at a glance, with room for the buttons, without scrolling. |
| why: one sentence, 25 words | One clear reason keeps motivation without becoming a reading task. |
| hint: 30 words | A nudge, not a second instruction. Short hints keep the learner thinking. |
| answer: 50 words | Long enough for a click path and the visible result, short enough to fit the panel. |
| warning: 25 words | Caution boxes must be scannable in one look. |
| estimated_minutes 1 to 10 | Small steps give frequent wins. Anything longer must be split. |

## Id stability

Progress is saved by step `id` (and lessons by lesson `id`). **Renaming an id loses
every learner's saved progress for that step.** So:

- Choose short, descriptive kebab-case ids (`add-date-column`, `quiz-licensing`).
- You can freely edit a step's text, reorder steps, or insert new steps with new ids.
- Do not reuse an old id for a different step; give the new step a new id.
- Delete a step only if you accept that its saved progress disappears.

## Full minimal example

```json
{
  "schema_version": 1,
  "id": "example-module",
  "title": "Example module title",
  "source": "https://learn.microsoft.com/en-us/training/modules/example-module/",
  "steps": [
    {
      "id": "check-environment",
      "type": "task",
      "instruction": "At make.powerapps.com, click the Environment picker at the top right and confirm you are in a Developer or Trial environment.",
      "why": "Everything you build lands in the selected environment, so practice where mistakes cannot hurt real data.",
      "estimated_minutes": 2,
      "hint": "Not sure of the type? Check the Type column under Environments in the Power Platform admin center.",
      "answer": "Top right, click Environment and pick your developer environment. The page reloads with its name shown at the top right.",
      "warning": "Never practice in production. Some settings in this lesson can never be undone."
    },
    {
      "id": "open-tables-list",
      "type": "task",
      "instruction": "In the left menu, click Tables, then click the All tab above the list.",
      "why": "The Tables list is your home base for Dataverse tables.",
      "estimated_minutes": 1,
      "hint": "No Tables in the left menu? Click More, then Tables.",
      "answer": "Left menu, Tables, then the All tab. You see every table with columns such as Name and Type."
    },
    {
      "id": "quiz-environment",
      "type": "quiz",
      "instruction": "Why should you practice in a developer environment instead of production?",
      "why": "Choosing a safe environment is the first habit of every Power Platform maker.",
      "estimated_minutes": 1,
      "hint": "Think about settings that cannot be undone.",
      "answer": "Because some changes are permanent and affect everyone in that environment. A developer environment keeps mistakes away from real users."
    }
  ]
}
```

(A real module needs exactly 3 quiz steps at the end. This example has one to stay short.)

## Checklist for a new module

- [ ] File is `lessons/<id>.json`, valid JSON, `schema_version` is `1`.
- [ ] `id` is kebab-case and matches the file name; `title` and `source` match the Learn module.
- [ ] Every step has `id`, `type`, `instruction`, `why`, `estimated_minutes`, `hint`, `answer`; `warning` only where needed.
- [ ] Step ids are unique, kebab-case, and none were renamed from a published version.
- [ ] Word limits hold: instruction under 40, why one sentence of 25 or fewer, hint 30, answer 50, warning 25.
- [ ] `estimated_minutes` is a whole number from 1 to 10; total is about 60 to 80 minutes.
- [ ] No markdown or HTML characters in any text field.
- [ ] Every task is something to do in the real environment, not something to read.
- [ ] The first step checks the environment; irreversible actions carry a `warning`.
- [ ] The last 3 steps are `quiz`, and no earlier step is.
- [ ] UI labels were checked against the current portal, with alternatives in hints.
- [ ] `LESSON_URL` in `panel.js` points at the lesson you want to load.
