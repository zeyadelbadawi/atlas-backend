# Assessment integrity — signals, full screen, evaluation

Status: implemented on `claude/practical-wozniak-pjcdhe` (not merged, not deployed).
Scope: quizzes/exams with integrity mode `monitor`, `warn` or `strict`.

## 1. What Atlas records — and what it never does

Recorded (only while an attempt is open, only on the quiz page, each with
server time and the client's time):

| Event | Source |
|---|---|
| tab hidden / visible | `visibilitychange` |
| window lost / regained focus | `blur` / `focus` |
| full screen left / entered / unavailable | `fullscreenchange`, request outcome |
| copy, cut, paste, context menu | events on the quiz container |
| print started | `beforeprint` |
| connection check | heartbeat every 60 s |
| warning acknowledged | the learner's click |

Never: camera, microphone, screen capture, keystrokes or typed text,
clipboard contents, face or emotion analysis, browsing outside the page,
device fingerprinting. Event payloads are allow-listed server-side
(`sanitizeEventPayload`): today only `fullscreen_unavailable.reason` ∈
{`unsupported`, `refused`} is kept; anything else a client sends is
dropped before storage.

Learners are told this before Start (`learning:quiz.integrity.*`): what
is recorded, that the reviewer sees it with explanations, and that nothing
outside the page is seen.

## 2. Full-screen exams (P4)

Root cause of "full screen never happens": the runner called
`requestFullscreen()` from a mount effect. Browsers only allow it during a
user gesture, so it was refused, and the refusal was swallowed. A second,
latent defect: the quiz container (not the document) was the full-screen
element, so dialogs portaled to `document.body` (submit confirmation,
integrity warnings) would have been invisible in full screen.

Policy now:

1. **Server-authoritative.** The attempt's settings snapshot decides:
   `requireFullscreen = engineV2 && integrity flag && integrityMode ≠ off && quiz.requireFullscreen`.
   The learner quiz view applies the same rule. A stored switch under
   integrity "off" (hidden in the editor) has no effect.
2. **Start is the gesture.** The Start click requests full screen on the
   document synchronously, before the start request is awaited.
3. **Exit policy.** Out of full screen, the questions are replaced by a
   gate ("Return to full screen to continue"); the header, autosave and
   the timer continue; answers are kept. Leaving is recorded
   (`fullscreen_exit`, a counted violation per the integrity mode).
4. **Refused** (the browser declined the request): recorded as
   `fullscreen_unavailable{reason: refused}`; the gate then also offers
   "Continue without full screen".
5. **Unsupported** (no Fullscreen API — e.g. iPhone Safari, a frame
   without `allowfullscreen`): a notice, never a gate; recorded as
   `fullscreen_unavailable{reason: unsupported}`.
6. **Resume** after reload: full screen is lost on reload, so the gate
   shows; one click restores it. Progress is the server's (session).
7. **Results** leave full screen.

No client bypass is *invisible*: a modified client can always skip full
screen, but then the reviewer sees "Never in full screen" or a claimed
"unavailable" — both are signals (§3). Client-side code cannot enforce
anything against a modified client, and this design does not pretend to.

## 3. Explainable signals (P5)

`deriveIntegritySignals` (`src/learning/services/integrity-signals.util.ts`)
turns one attempt's events into facts. Each has a level — `review`
("worth a look") or `info` (context) — its numbers, and the event ids it
was built from. There is **no score, probability or verdict**. The
reviewer UI shows each signal with its innocent explanations and can
highlight its evidence rows in the timeline.

| Signal | Rule | Worth a look when | Innocent explanations shown |
|---|---|---|---|
| `time_away` | hidden→visible intervals ≥ 2 s | total ≥ 30 s or ≥ 3 times | screen lock, call, break, quick app switch |
| `focus_lost` | blur→focus ≥ 2 s while the tab stayed visible | total ≥ 60 s | notifications, 2nd monitor, magnifier/screen reader |
| `fullscreen_left` | exit→enter (required only) | total ≥ 30 s or ≥ 2 exits | Esc by accident, system prompt |
| `fullscreen_never_entered` | required, no enter, no unavailable | always | outdated client, extension |
| `fullscreen_unavailable` | reported by the browser | never (context) | phones/tablets, settings; can be claimed falsely |
| `paste_without_copy` | paste with no earlier copy/cut in the attempt | always | dictation and assistive input |
| `paste_after_copy` | paste after an in-attempt copy | never (context) | moving one's own text |
| `copy` | copy/cut | never (context) | copying own answer |
| `print` | print started | always | Ctrl+P by mistake |
| `connection_gap` | no batch for ≥ 180 s | never (context) | offline, sleep, closed tab |

Each signal also carries a **category**: `technical` (`connection_gap`,
`fullscreen_unavailable` — interruptions and browser limits) or
`behaviour`. The reviewer UI shows three groups — "Worth a look",
"Technical interruptions", "For context" — and opens with the policy the
attempt ran under (mode, event limit, full screen required or not), read
from the attempt's own snapshot.

**Historical attempts need no migration**: signals are derived on read
from the stored events, so every past attempt gets them as is. The
previous counted-violation fields (`violationCount`, `integrityFlagged`,
strict-mode auto-submit) are unchanged; the signals sit beside them.

**Not built, and why**: answer-timing and answer-change patterns (too
easily misread — fast typists, prepared students — without real data to
calibrate on); `second_session` and `device_change` exist as event
types but nothing produces them today (no detector; listed so the gap is
visible, not implied as coverage).

Durations use server time; two events in the same batch are measured with
the client clock (the only measure of that gap). The client clock is never
used for order or escalation (`decideIntegrity` is unchanged).

## 4. Evaluation methodology

Corpus: `src/learning/services/integrity-eval/scenarios.ts`, 29
scripted scenarios written before reading the rules' output. Each has a
label (`dishonest`) and, for dishonest ones, a *footprint*: the signals
whose channel the behaviour shows up in (a phone on the desk has none).

Per signal S: a scenario is positive if it is dishonest and S is in its
footprint; S *fires* if it is at `review` level. Attempt level: positive
= dishonest, fires = any signal at `review`. A rate with a zero
denominator is reported as n/a.

**Scope — read before quoting.** These are designed scenarios, not a
sample of real learners. The numbers measure whether the rules behave as
designed on the listed behaviours, including the honest ones that trip
them and the dishonest ones they cannot see. They do not estimate
real-world precision or recall (that depends on how often each behaviour
occurs in a real cohort, which Atlas does not know). No accuracy claim —
"95%" or otherwise — is made or supported.

Re-run: `npx ts-node -r tsconfig-paths/register scripts/integrity-eval.ts`
(pure computation; the spec `integrity-signals.util.spec.ts` pins the
false positives and false negatives below so a rule change is deliberate).

### Results (generated)

Scenarios: 29 (14 honest, 15 dishonest). Designed scenarios, not real learners — see the scope note.

| Signal | TP | FP | FN | TN | Precision | Recall | FPR | FNR | FP scenarios | FN scenarios |
|---|---|---|---|---|---|---|---|---|---|---|
| time_away | 6 | 2 | 1 | 20 | 75% | 86% | 9% | 14% | H10, H11 | D15 |
| focus_lost | 1 | 0 | 1 | 27 | 100% | 50% | 0% | 50% | — | D04 |
| fullscreen_left | 1 | 0 | 0 | 28 | 100% | 100% | 0% | 0% | — | — |
| fullscreen_never_entered | 1 | 1 | 0 | 27 | 50% | 100% | 4% | 0% | H13 | — |
| paste_without_copy | 1 | 1 | 1 | 26 | 50% | 50% | 4% | 50% | H12 | D06 |
| print | 1 | 0 | 0 | 28 | 100% | 100% | 0% | 0% | — | — |
| connection_gap | 0 | 0 | 2 | 27 | n/a | 0% | 0% | 100% | — | D11, D12 |
| **Attempt (any signal)** | 10 | 4 | 5 | 10 | 71% | 67% | 29% | 33% | H10, H11, H12, H13 | D04, D08, D09, D12, D15 |

| Scenario | Label | Worth a look | Context |
|---|---|---|---|
| H01 — Focused learner, full screen throughout. | honest | — | — |
| H02 — Two OS notification flickers (focus lost for under a second each). | honest | — | — |
| H03 — Clicks a calendar notification, back after 5 s. | honest | — | focus_lost |
| H04 — Phone call locks the screen once for 20 s. | honest | — | time_away |
| H05 — Wi-Fi drops for 4 minutes; nothing reaches the server. | honest | — | connection_gap |
| H06 — Copies a sentence from one of their own answers into another. | honest | — | paste_after_copy, copy |
| H07 — iPhone: the browser has no full screen; otherwise focused. | honest | — | fullscreen_unavailable |
| H08 — Presses Esc by accident, back in full screen after 4 s. | honest | — | fullscreen_left |
| H09 — Checks the time in another tab twice, 10 s each. | honest | — | time_away |
| H10 — Bathroom break of 3 minutes in an untimed quiz (screen locks). | honest | time_away | — |
| H11 — Laptop lid closed for 10 minutes (sleep): hidden and silent. | honest | time_away | connection_gap |
| H12 — Dictation / assistive input tool inserts text by pasting. | honest | paste_without_copy | — |
| H13 — Outdated client that never reports entering full screen. | honest | fullscreen_never_entered | — |
| H14 — Reads a long question with a screen magnifier window on top for 50 s. | honest | — | focus_lost |
| D01 — Looks answers up in another tab three times, ~40 s each. | dishonest | time_away | — |
| D02 — One 90 s search in another tab. | dishonest | time_away | — |
| D03 — Chat assistant open side by side for 5 minutes (page stays visible). | dishonest | focus_lost | — |
| D04 — Three 10 s glances at a side-by-side window. | dishonest | — | focus_lost |
| D05 — Pastes an answer copied from outside the quiz. | dishonest | paste_without_copy | — |
| D06 — Copies the question, asks an assistant in another tab (45 s), pastes the reply. | dishonest | time_away | paste_after_copy, copy |
| D07 — Leaves full screen to search for 40 s, then returns. | dishonest | time_away, fullscreen_left | — |
| D08 — Looks answers up on a phone on the desk. | dishonest | — | — |
| D09 — Another person in the room dictates answers. | dishonest | — | — |
| D10 — Prints the quiz to share it. | dishonest | print | — |
| D11 — Modified client blocks every event; full screen was required. | dishonest | fullscreen_never_entered | connection_gap |
| D12 — Modified client blocks every event; no full screen required. | dishonest | — | connection_gap |
| D13 — Two 15 s lookups in another tab. | dishonest | time_away | — |
| D14 — Claims full screen is unavailable (modified client), then searches 60 s in another tab. | dishonest | time_away | fullscreen_unavailable |
| D15 — One 12 s lookup in another tab. | dishonest | — | time_away |

### What the numbers say

- Common honest noise — notifications, a short call, an accidental Esc,
  an iPhone, a Wi-Fi drop, pasting one's own text — is never flagged.
- Known false positives, each explained next to the signal in the UI:
  a 3-minute break (H10), a laptop going to sleep (H11), dictation
  pasting text (H12), an outdated client (H13).
- Known false negatives: brief side-window glances (D04), one 12 s
  lookup (D15), a client that blocks events when full screen is not
  required (D12) — and anything outside the browser: a phone (D08),
  another person (D09). No browser-only signal can see those; proctoring
  that could (camera, microphone) is deliberately out of scope.
- `connection_gap` is context only by design (recall 0%): silence is far
  more often a network than a person.

## 5. Real-browser verification

The P7 journeys drive these behaviours in Chromium against the local
stack (full screen on Start, exit → gate → return, tab switches, paste)
and read the reviewer's signals back through the API; see the P7 report
section for results.
