# Answer key — pop-quiz planted bugs (Phase 3 QA-lane benchmark)

**NEVER copy, reference, or link this file from the pop-quiz repo, a sweep
agent's instructions, or any artifact a sweep could read.** Grading is the
orchestrator's job (PRD phase-3-qa-lane F5). A sweep whose transcript shows
key access is void.

Planted 2026-07-29 into commits `ec1b2f2`, `7ca0641`, `d139861` (feature-shaped
refactors; matching unit-test adjustments keep the suite green, so every bug
below is invisible to `npm test` and findable only by driving the app against
the recorded spec in pop-quiz's PRODUCT.md). Exactly 8 graded bugs, 6 classes.

| # | Class | Location | Buggy behavior | Expected (recorded spec) | Trigger steps |
|---|---|---|---|---|---|
| 1 | calculation | `src/scoring.ts` `pointsForCorrectAnswer` | Bonus is `10 × streak`: 1st correct = 110, 2nd = 120, flawless round = 1550 | 1st = 100, 2nd = 110, 3rd = 120; flawless = 1450 | Answer one question correctly; summary (or next-screen score, minus bug 6) shows 110 not 100 |
| 2 | timing | `src/timer.ts` `Countdown.start` | Countdown starts at 14 and expires after 14 s — the answer window is one second short | Visible countdown starts at 15; 15 s to answer | Start a round; the timer's first painted value is 14s |
| 3 | state/sequence | `src/main.ts` `submitAnswer` | A qualifying round that ENDS on a timeout never offers the initials form (`choiceIndex !== null && qualifies`) | Every qualifying score prompts for initials regardless of how the round ended | Score qualifying points, let the final question time out; summary shows no initials form |
| 4 | persistence | `src/highscores.ts` `saveHighScores` | Only 4 entries are written to localStorage (`PERSISTED_HIGH_SCORES = MAX − 1`); the 5th high score is lost on reload | All 5 survive a reload | Record 5 scores, reload; the table shows 4 |
| 5 | boundary | `src/game.ts` `questionNumber` | Clamp to `length − 1`: the last question displays "Question 9/10" (9 appears twice) | Last question shows "Question 10/10" | Play to the 10th question; progress label still says 9/10 |
| 6 | UI-truth | `src/main.ts` `submitAnswer`/`showQuestionScreen` | Running score shown during a question EXCLUDES the answer just given (lags one answer); summary is correct | The next question's screen shows the score including the answer just given | Answer Q1 correctly; Q2's status bar still shows Score 0 |
| 7 | UI-truth | `src/game.ts` `summarizeRound` | "Longest streak" reports the streak the round ENDED on (`score.streak`) | The longest streak reached at any point | Build a streak of 3+, end the round on wrong answers; summary says Longest streak 0 |
| 8 | state/sequence | `src/game.ts` `answerCurrentQuestion` | A TIMEOUT does not reset the streak (only a wrong click does); post-timeout correct answers keep the elevated bonus | A timeout is scored exactly like a wrong answer and resets the streak | Two correct, one timeout, one correct: the 4th scores at streak-3 rates instead of restarting |

Interactions worth knowing when grading: bugs 1 and 8 both inflate scores —
a finding that "streaks pay too much" must name the ×streak formula (bug 1)
or the timeout-survival (bug 8) specifically to count for that bug; a vague
"scores look high" matches neither. Bug 6 hides bug 1 on the question screen
(the lagged score delays the evidence by one answer) — the summary screen
shows both cleanly. Bug 2's timer also shortens the window for observing
anything per-question; it is independently visible from the first second.

Grading bar (PRD F5): ≥ 6 of 8, ≥ 4 classes, ≤ 2 false alarms, met on ≥ 2 of
3 predeclared fresh sweeps under the frozen workflow. A real unplanted bug
verified by the orchestrator is a bonus find, not a false alarm.
