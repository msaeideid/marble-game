# Gate 1 playtest: "is swinging fun, and is a fight readable?"

Goal (PLAN.md section 5): decide whether the core is fun in the browser on PC, with placeholder art, before any
content or art spend. Run this with you plus 2-3 testers, 15-20 minutes each.

## Setup
1. `npm install` then `npm run dev` (http://localhost:5173), or the deployed URL once Pages is enabled.
2. Use a real mouse and keyboard in Chrome or Edge. Gamepad works too (left stick move, right stick look,
   A jump, X strike, Y zip, B snare, RT swing, LT reel).
3. Click the start screen. **Do not coach beyond "the controls are on the start screen".** Watch what they try first.

## The five-minute path
1. Run around the street and jump on the stairs.
2. Hold `E` aiming at a green marker on a building: swing across the streets. Try to reach a tall tower.
3. Fight the first wave (strike `J`, snare `Q`). Notice whether the orange telegraph reads.
4. Get defeated once on purpose; check the respawn and the base pad.
5. Try `F` aimed just under a roof edge to climb up.

## Questions (score 1-5, then ask why)
**Swinging**
- Did it feel good within the first minute without being told how?
- Did the launch feel right (not too floaty, not too violent)? Did you ever feel stuck or confused?
- Did you want to keep swinging for its own sake? How long before you got bored?
- Was running out of energy fun tension or just annoying?

**Combat**
- Could you tell when a thug was about to hit you? Did you feel hits were fair?
- Were thugs too easy, about right, or too hard?
- Was strike satisfying (sound, flash, slash, damage numbers)? Was snare useful or ignored?
- Did you use swinging in the fights, or only on the ground?

**Overall**
- Would you play 30 more minutes? What would you want next (more heroes, missions, co-op)?
- What was the single most frustrating moment? The single best moment?
- Anything unreadable (UI, health, aim marker, controls)?

## Record
For each tester: age/experience, 1-5 scores, the moments they stalled, and what they tried that I did not expect.

## Go / no-go for Phase 2
- **Go** if most testers rate swinging 4+ and want to keep playing, and fights are understood without coaching.
- **Tune** if the scores are 3: use `TUNING.md`; swing launch, thug telegraph and energy cost are the usual culprits.
- **Rethink** if swinging is still below 3 after a tuning pass: that changes the plan, so stop and decide before
  building more heroes.
