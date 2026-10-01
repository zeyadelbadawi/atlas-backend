/**
 * Labelled scenarios for evaluating the integrity signals (P5).
 *
 * WHAT THESE ARE: scripted event sequences, each describing one way a
 * learner might behave during an attempt, written BEFORE looking at what
 * the rules output, with two labels:
 *   - `dishonest` — whether the behaviour breaks the quiz's rules;
 *   - `footprint` — for a dishonest scenario, the signals whose channel the
 *     behaviour actually shows up in (a tab switch shows up in `time_away`;
 *     a phone on the desk shows up nowhere).
 *
 * WHAT THESE ARE NOT: observations of real learners. Metrics computed on
 * them measure whether the rules do what they were designed to do on the
 * behaviours listed — including the honest behaviours that trip them and
 * the dishonest ones they cannot see. They say nothing about how often
 * each behaviour happens in a real class, so they are not real-world
 * accuracy and must not be quoted as such.
 *
 * Times are seconds from the start of the attempt. Each event arrives in
 * its own batch at that second (server time), heartbeats every 60 s unless
 * the scenario is about silence.
 */
import type { QuizAttemptEventType } from '@prisma/client';
import type { IntegritySignalKey } from '../integrity-signals.util';

export type ScenarioEvent = readonly [
  seconds: number,
  type: QuizAttemptEventType,
  payload?: Record<string, string>,
];

export interface IntegrityScenario {
  readonly id: string;
  readonly description: string;
  readonly dishonest: boolean;
  /** Signals the dishonest behaviour shows up in (empty for honest scenarios). */
  readonly footprint: readonly IntegritySignalKey[];
  readonly requireFullscreen: boolean;
  readonly durationSeconds: number;
  readonly events: readonly ScenarioEvent[];
  /** Omit the regular heartbeats (the browser is silent). */
  readonly silent?: boolean;
}

const fsStart: ScenarioEvent[] = [[0, 'fullscreen_enter']];

export const INTEGRITY_SCENARIOS: readonly IntegrityScenario[] = [
  /* ------------------------------ honest ------------------------------ */
  {
    id: 'H01',
    description: 'Focused learner, full screen throughout.',
    dishonest: false,
    footprint: [],
    requireFullscreen: true,
    durationSeconds: 1200,
    events: fsStart,
  },
  {
    id: 'H02',
    description: 'Two OS notification flickers (focus lost for under a second each).',
    dishonest: false,
    footprint: [],
    requireFullscreen: false,
    durationSeconds: 900,
    events: [
      [200, 'blur'],
      [200.6, 'focus'],
      [500, 'blur'],
      [500.8, 'focus'],
    ],
  },
  {
    id: 'H03',
    description: 'Clicks a calendar notification, back after 5 s.',
    dishonest: false,
    footprint: [],
    requireFullscreen: false,
    durationSeconds: 900,
    events: [
      [300, 'blur'],
      [305, 'focus'],
    ],
  },
  {
    id: 'H04',
    description: 'Phone call locks the screen once for 20 s.',
    dishonest: false,
    footprint: [],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [
      [400, 'visibility_hidden'],
      [420, 'visibility_visible'],
    ],
  },
  {
    id: 'H05',
    description: 'Wi-Fi drops for 4 minutes; nothing reaches the server.',
    dishonest: false,
    footprint: [],
    requireFullscreen: false,
    durationSeconds: 1200,
    silent: true,
    events: [
      [60, 'heartbeat'],
      [120, 'heartbeat'],
      [360, 'heartbeat'],
      [420, 'heartbeat'],
      [480, 'heartbeat'],
      [540, 'heartbeat'],
      [600, 'heartbeat'],
      [660, 'heartbeat'],
      [720, 'heartbeat'],
      [780, 'heartbeat'],
      [840, 'heartbeat'],
      [900, 'heartbeat'],
      [960, 'heartbeat'],
      [1020, 'heartbeat'],
      [1080, 'heartbeat'],
      [1140, 'heartbeat'],
    ],
  },
  {
    id: 'H06',
    description: 'Copies a sentence from one of their own answers into another.',
    dishonest: false,
    footprint: [],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [
      [500, 'copy'],
      [520, 'paste'],
    ],
  },
  {
    id: 'H07',
    description: 'iPhone: the browser has no full screen; otherwise focused.',
    dishonest: false,
    footprint: [],
    requireFullscreen: true,
    durationSeconds: 1200,
    events: [[0, 'fullscreen_unavailable', { reason: 'unsupported' }]],
  },
  {
    id: 'H08',
    description: 'Presses Esc by accident, back in full screen after 4 s.',
    dishonest: false,
    footprint: [],
    requireFullscreen: true,
    durationSeconds: 1200,
    events: [...fsStart, [600, 'fullscreen_exit'], [604, 'fullscreen_enter']],
  },
  {
    id: 'H09',
    description: 'Checks the time in another tab twice, 10 s each.',
    dishonest: false,
    footprint: [],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [
      [300, 'visibility_hidden'],
      [310, 'visibility_visible'],
      [800, 'visibility_hidden'],
      [810, 'visibility_visible'],
    ],
  },
  {
    id: 'H10',
    description: 'Bathroom break of 3 minutes in an untimed quiz (screen locks).',
    dishonest: false,
    footprint: [],
    requireFullscreen: false,
    durationSeconds: 1800,
    events: [
      [700, 'visibility_hidden'],
      [880, 'visibility_visible'],
    ],
  },
  {
    id: 'H11',
    description: 'Laptop lid closed for 10 minutes (sleep): hidden and silent.',
    dishonest: false,
    footprint: [],
    requireFullscreen: false,
    durationSeconds: 2400,
    silent: true,
    events: [
      [60, 'heartbeat'],
      [120, 'heartbeat'],
      [180, 'heartbeat'],
      [200, 'visibility_hidden'],
      [800, 'visibility_visible'],
      [860, 'heartbeat'],
      [920, 'heartbeat'],
      [980, 'heartbeat'],
      [1040, 'heartbeat'],
      [1100, 'heartbeat'],
      [1160, 'heartbeat'],
      [1220, 'heartbeat'],
      [1280, 'heartbeat'],
      [1340, 'heartbeat'],
      [1400, 'heartbeat'],
      [1460, 'heartbeat'],
      [1520, 'heartbeat'],
      [1580, 'heartbeat'],
      [1640, 'heartbeat'],
      [1700, 'heartbeat'],
      [1760, 'heartbeat'],
      [1820, 'heartbeat'],
      [1880, 'heartbeat'],
      [1940, 'heartbeat'],
      [2000, 'heartbeat'],
      [2060, 'heartbeat'],
      [2120, 'heartbeat'],
      [2180, 'heartbeat'],
      [2240, 'heartbeat'],
      [2300, 'heartbeat'],
      [2360, 'heartbeat'],
    ],
  },
  {
    id: 'H12',
    description: 'Dictation / assistive input tool inserts text by pasting.',
    dishonest: false,
    footprint: [],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [
      [400, 'paste'],
      [700, 'paste'],
    ],
  },
  {
    id: 'H13',
    description: 'Outdated client that never reports entering full screen.',
    dishonest: false,
    footprint: [],
    requireFullscreen: true,
    durationSeconds: 1200,
    events: [],
  },
  {
    id: 'H14',
    description: 'Reads a long question with a screen magnifier window on top for 50 s.',
    dishonest: false,
    footprint: [],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [
      [300, 'blur'],
      [350, 'focus'],
    ],
  },

  /* ----------------------------- dishonest ---------------------------- */
  {
    id: 'D01',
    description: 'Looks answers up in another tab three times, ~40 s each.',
    dishonest: true,
    footprint: ['time_away'],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [
      [200, 'visibility_hidden'],
      [240, 'visibility_visible'],
      [500, 'visibility_hidden'],
      [545, 'visibility_visible'],
      [800, 'visibility_hidden'],
      [838, 'visibility_visible'],
    ],
  },
  {
    id: 'D02',
    description: 'One 90 s search in another tab.',
    dishonest: true,
    footprint: ['time_away'],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [
      [600, 'visibility_hidden'],
      [690, 'visibility_visible'],
    ],
  },
  {
    id: 'D03',
    description: 'Chat assistant open side by side for 5 minutes (page stays visible).',
    dishonest: true,
    footprint: ['focus_lost'],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [
      [300, 'blur'],
      [420, 'focus'],
      [600, 'blur'],
      [780, 'focus'],
    ],
  },
  {
    id: 'D04',
    description: 'Three 10 s glances at a side-by-side window.',
    dishonest: true,
    footprint: ['focus_lost'],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [
      [300, 'blur'],
      [310, 'focus'],
      [600, 'blur'],
      [610, 'focus'],
      [900, 'blur'],
      [910, 'focus'],
    ],
  },
  {
    id: 'D05',
    description: 'Pastes an answer copied from outside the quiz.',
    dishonest: true,
    footprint: ['paste_without_copy'],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [[650, 'paste']],
  },
  {
    id: 'D06',
    description: 'Copies the question, asks an assistant in another tab (45 s), pastes the reply.',
    dishonest: true,
    footprint: ['time_away', 'paste_without_copy'],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [
      [400, 'copy'],
      [401, 'visibility_hidden'],
      [446, 'visibility_visible'],
      [447, 'paste'],
    ],
  },
  {
    id: 'D07',
    description: 'Leaves full screen to search for 40 s, then returns.',
    dishonest: true,
    footprint: ['time_away', 'fullscreen_left'],
    requireFullscreen: true,
    durationSeconds: 1200,
    events: [
      ...fsStart,
      [500, 'fullscreen_exit'],
      [501, 'visibility_hidden'],
      [541, 'visibility_visible'],
      [542, 'fullscreen_enter'],
    ],
  },
  {
    id: 'D08',
    description: 'Looks answers up on a phone on the desk.',
    dishonest: true,
    footprint: [],
    requireFullscreen: true,
    durationSeconds: 1200,
    events: fsStart,
  },
  {
    id: 'D09',
    description: 'Another person in the room dictates answers.',
    dishonest: true,
    footprint: [],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [],
  },
  {
    id: 'D10',
    description: 'Prints the quiz to share it.',
    dishonest: true,
    footprint: ['print'],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [[100, 'print']],
  },
  {
    id: 'D11',
    description: 'Modified client blocks every event; full screen was required.',
    dishonest: true,
    footprint: ['fullscreen_never_entered', 'connection_gap'],
    requireFullscreen: true,
    durationSeconds: 1200,
    silent: true,
    events: [],
  },
  {
    id: 'D12',
    description: 'Modified client blocks every event; no full screen required.',
    dishonest: true,
    footprint: ['connection_gap'],
    requireFullscreen: false,
    durationSeconds: 1200,
    silent: true,
    events: [],
  },
  {
    id: 'D13',
    description: 'Two 15 s lookups in another tab.',
    dishonest: true,
    footprint: ['time_away'],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [
      [300, 'visibility_hidden'],
      [315, 'visibility_visible'],
      [700, 'visibility_hidden'],
      [715, 'visibility_visible'],
    ],
  },
  {
    id: 'D14',
    description: 'Claims full screen is unavailable (modified client), then searches 60 s in another tab.',
    dishonest: true,
    footprint: ['time_away'],
    requireFullscreen: true,
    durationSeconds: 1200,
    events: [
      [0, 'fullscreen_unavailable', { reason: 'unsupported' }],
      [400, 'visibility_hidden'],
      [460, 'visibility_visible'],
    ],
  },
  {
    id: 'D15',
    description: 'One 12 s lookup in another tab.',
    dishonest: true,
    footprint: ['time_away'],
    requireFullscreen: false,
    durationSeconds: 1200,
    events: [
      [500, 'visibility_hidden'],
      [512, 'visibility_visible'],
    ],
  },
];
