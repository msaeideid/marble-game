import { handPos } from './controller';
import type { Sim } from './sim';
import { NEUTRAL_INTENT, type PlayerIntent, type Vec3 } from './types';
import type { Target } from './weapons';

/** Stay roughly this close to the player you are helping (metres, flat distance). */
const FOLLOW_DISTANCE = 5;
/** A thrown car lands about 12 m away, so throw from inside this. */
const THROW_RANGE = 9;
/** Enemies this close to a flying car make it worth setting off (a bit under the car's blast radius). */
const DETONATE_NEAR = 3.6;
/** Only chase fights this close. */
const ENGAGE_RANGE = 30;

const centre = (t: Target): Vec3 => ({ x: t.pos.x, y: t.pos.y + t.height / 2, z: t.pos.z });
const flat = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
const dist3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * A very simple AI teammate. It only ever produces a `PlayerIntent`, exactly like a human, so it plays by the same rules.
 * It follows the player, fights with whatever its hero has, and knows the team-up combo from both sides:
 * a lifter throws cars at enemies, and a shooter sets off any thrown car that is near enemies.
 */
export class BuddyBrain {
  constructor(
    readonly id: string,
    readonly leaderId: string,
  ) {}

  think(sim: Sim): PlayerIntent {
    const intent: PlayerIntent = { ...NEUTRAL_INTENT };
    const me = sim.players.get(this.id);
    if (!me || me.defeatedTimer !== null) return intent;
    const hero = sim.heroOf(this.id);
    const leader = sim.players.get(this.leaderId);
    const hand = handPos(me, hero);
    const enemies = sim.liveTargets();
    const seen = (to: Vec3): boolean => {
      const d = dist3(hand, to) || 1;
      const hit = sim.world.raycast(hand, { x: (to.x - hand.x) / d, y: (to.y - hand.y) / d, z: (to.z - hand.z) / d }, d);
      return !hit || hit.distance > d - 0.6;
    };

    let goal: Vec3 | null = null;
    let goalStop = 1;
    let aim: Vec3 | null = null;

    const nearest = (list: Target[], from: Vec3, limit: number): Target | null => {
      let best: Target | null = null;
      let bestD = limit;
      for (const t of list) {
        const d = flat(t.pos, from);
        if (d < bestD) {
          best = t;
          bestD = d;
        }
      }
      return best;
    };
    const foe = nearest(enemies, me.pos, ENGAGE_RANGE);

    // ---- the combo, shooter side: a thrown car or dumpster near enemies gets a laser bolt ----
    const airborne = sim.volatileTargets();
    if (hero.laser) {
      for (const prop of airborne) {
        const c = centre(prop);
        const victims = enemies.filter((e) => dist3(centre(e), c) <= DETONATE_NEAR);
        // Wait for the car to be over a group, unless it is about to land and a single enemy is all there is.
        const worthIt = victims.length >= Math.min(2, enemies.length) || (victims.length > 0 && prop.pos.y < 0.9);
        if (worthIt && dist3(hand, c) <= hero.laser.range && seen(c)) {
          aim = c;
          intent.fireHeld = true;
          break;
        }
      }
    }

    // ---- the combo, thrower side: carry a car to the enemies and throw it ----
    if (hero.lift && sim.propSystem && !intent.fireHeld) {
      if (me.carrying) {
        if (foe) {
          const d = flat(foe.pos, me.pos);
          if (d > THROW_RANGE) {
            goal = foe.pos;
            goalStop = THROW_RANGE - 1;
            aim = centre(foe);
          } else {
            aim = centre(foe);
            if (me.grabCooldown <= 0) intent.grabPressed = true;
          }
        }
      } else if (foe) {
        let best: { pos: Vec3; half: number } | null = null;
        let bestD = 22;
        for (const pr of sim.propSystem.props) {
          const def = sim.propSystem.defs[pr.defId]!;
          if (pr.mode !== 'resting' || !def.detonation) continue;
          const d = flat(pr.pos, me.pos);
          if (d < bestD) {
            best = { pos: pr.pos, half: def.size.halfWidth };
            bestD = d;
          }
        }
        if (best) {
          const reach = hero.lift.liftRange + best.half - 0.4;
          if (bestD <= reach) {
            if (me.grabCooldown <= 0) intent.grabPressed = true;
          } else {
            goal = best.pos;
            goalStop = reach - 0.3;
          }
        }
      }
    }

    // ---- ordinary fighting ----
    if (!aim && !goal && foe) {
      const c = centre(foe);
      const d = dist3(hand, c);
      if (hero.laser && d <= hero.laser.range && seen(c)) {
        aim = c;
        // A car in the air is wide to hit (propAssist): do not set it off early with a shot at something else.
        intent.fireHeld = airborne.length === 0;
        // Rockets are the shooter's other half of the combo; spend them on enemies only if there is nobody to throw cars.
        const hasLifter = [...sim.players.keys()].some((pid) => sim.heroOf(pid).lift !== undefined);
        if (hero.rockets && !hasLifter && me.rocketCooldown <= 0 && me.energy >= hero.rockets.cost) intent.rocketPressed = true;
      } else if (hero.chain && d <= hero.chain.range && seen(c)) {
        aim = c;
        if (me.chainCooldown <= 0 && me.energy >= hero.chain.cost) intent.chainPressed = true;
        if (hero.tempest && me.stormCooldown <= 0 && me.energy >= hero.tempest.cost + hero.chain.cost) {
          const crowd = enemies.filter((e) => flat(e.pos, foe.pos) <= hero.tempest!.radius).length;
          if (crowd >= 2 && flat(foe.pos, me.pos) > hero.tempest.radius + 2) {
            aim = { x: foe.pos.x, y: foe.pos.y, z: foe.pos.z };
            intent.stormPressed = true;
            intent.chainPressed = false;
          }
        }
      } else if (!hero.laser && !hero.chain) {
        // Melee heroes go and hit things.
        if (flat(foe.pos, me.pos) > hero.melee.range * 0.8) {
          goal = foe.pos;
          goalStop = hero.melee.range * 0.7;
        } else {
          aim = centre(foe);
          intent.attackPressed = true;
        }
      }
    }

    // ---- otherwise stay with the player ----
    if (!goal && !aim && leader && flat(leader.pos, me.pos) > FOLLOW_DISTANCE) {
      goal = leader.pos;
      goalStop = FOLLOW_DISTANCE - 1.5;
    }
    // Even while shooting, drift back toward the player if left far behind.
    if (!goal && leader && flat(leader.pos, me.pos) > FOLLOW_DISTANCE * 3) {
      goal = leader.pos;
      goalStop = FOLLOW_DISTANCE;
    }

    // ---- turn the plan into a camera heading and a stick ----
    const look = aim ?? goal;
    if (look) {
      const dx = look.x - hand.x;
      const dy = look.y - hand.y;
      const dz = look.z - hand.z;
      intent.yaw = Math.atan2(dx, dz);
      if (aim) intent.pitch = -Math.asin(Math.max(-1, Math.min(1, dy / (Math.hypot(dx, dy, dz) || 1))));
    }
    if (goal && flat(goal, me.pos) > goalStop) {
      const gx = goal.x - me.pos.x;
      const gz = goal.z - me.pos.z;
      const len = Math.hypot(gx, gz) || 1;
      const wx = gx / len;
      const wz = gz / len;
      intent.moveZ = wx * Math.sin(intent.yaw) + wz * Math.cos(intent.yaw);
      intent.moveX = wx * Math.cos(intent.yaw) - wz * Math.sin(intent.yaw);
    }
    return intent;
  }
}
