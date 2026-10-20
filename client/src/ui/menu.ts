import type { Content, UpgradeData } from '../data/content';
import type { MissionData } from '../campaign/missions';
import { buy, levelFromXp, levelProgress, missionUnlocked, whatIsMissing, whyNot, type SaveData } from '../campaign/progress';

const CHAPTERS: { id: string; title: string; blurb: string }[] = [
  { id: 'chapter.city', title: 'Brightport', blurb: 'Learn the ropes, take on challenges, and face a shadow over the skyline.' },
  { id: 'chapter.world1', title: 'Sugarworks', blurb: 'A candy factory gone wild.' },
  { id: 'chapter.world2', title: 'Cloudspire', blurb: 'Islands in the sky.' },
  { id: 'chapter.world3', title: 'Gearhollow', blurb: 'Tunnels, gears and a clockwork duchess.' },
  { id: 'chapter.finale', title: 'The Shard Engine', blurb: 'No more running.' },
];

export interface MenuOptions {
  content: Content;
  save: SaveData;
  /** Persist a changed save (buying an upgrade). */
  onSave(save: SaveData): void;
  /** The page's current search params; hero and teammate choices are carried into every link. */
  params: URLSearchParams;
  /** Which tab to open first. */
  tab: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** A link that reloads the game with the given parameters (and keeps the hero and teammate picks). */
export function playUrl(params: URLSearchParams, extra: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const k of ['hero', 'buddy']) {
    const v = params.get(k);
    if (v) q.set(k, v);
  }
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return `?${q.toString()}`;
}

function wallet(save: SaveData): HTMLElement {
  const box = el('div', 'wallet');
  const [into, need] = levelProgress(save.xp);
  box.append(el('span', 'lvl', `Level ${levelFromXp(save.xp)}`), el('span', 'xp', `${into} / ${need} XP`), el('span', 'scrap', `${save.scrap} scrap`));
  return box;
}

function missionCard(m: MissionData, o: MenuOptions): HTMLElement {
  const { save, content } = o;
  const card = el('div', 'mission-card');
  const times = save.completed[m.id] ?? 0;
  const unlocked = missionUnlocked(m, save);
  card.classList.toggle('locked', !unlocked);
  card.classList.toggle('done', times > 0);
  const head = el('div', 'mc-head');
  head.append(el('b', '', m.title), el('span', 'tag', m.kind === 'challenge' ? 'challenge' : 'story'));
  if (times > 0) head.append(el('span', 'tick', m.kind === 'challenge' ? `✓ ×${times}` : '✓'));
  card.append(head, el('div', 'mc-sum', m.summary));
  if (unlocked) {
    const a = el('a', 'play', times > 0 ? 'Play again' : 'Play');
    a.href = playUrl(o.params, { mission: m.id });
    a.addEventListener('click', (e) => e.stopPropagation());
    card.append(a, el('span', 'reward', `${m.reward.scrap} scrap · ${m.reward.xp} XP`));
  } else {
    const need = whatIsMissing(m.requires, save, (id) => content.missions[id]?.title ?? id);
    card.append(el('div', 'need', `Locked: ${need.join(', ')}`));
  }
  return card;
}

function campaignPanel(o: MenuOptions): HTMLElement {
  const root = el('div', 'campaign');
  root.append(wallet(o.save));
  const free = el('a', 'play wide', o.save.flags.includes('vastorEscaped') ? 'Free roam in Brightport (after VASTOR)' : 'Free roam in Brightport');
  free.href = playUrl(o.params, { campaign: '1' });
  free.addEventListener('click', (e) => e.stopPropagation());
  root.append(free, el('p', 'hint', 'Free roam: fight waves of thugs for scrap and XP, then spend them in the Upgrade Bay.'));
  const missions = Object.values(o.content.missions);
  for (const ch of CHAPTERS) {
    const mine = missions.filter((m) => m.chapter === ch.id);
    if (mine.length === 0) continue;
    const block = el('section', 'chapter');
    block.append(el('h3', '', ch.title), el('p', 'blurb', ch.blurb));
    const story = mine.filter((m) => m.kind === 'story');
    const side = mine.filter((m) => m.kind === 'challenge');
    for (const m of [...story, ...side]) block.append(missionCard(m, o));
    root.append(block);
  }
  return root;
}

function bayPanel(o: MenuOptions, heroId: string, rerender: (heroId: string) => void): HTMLElement {
  const root = el('div', 'bay');
  root.append(wallet(o.save));
  const picks = el('div', 'bay-heroes');
  for (const h of Object.values(o.content.heroes)) {
    const a = el('a', h.id === heroId ? 'selected' : '', h.displayName);
    a.href = '#';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      rerender(h.id);
    });
    picks.append(a);
  }
  root.append(picks, el('p', 'hint', 'Upgrades give you more options, not just bigger numbers. Some unlock as you level up or beat a world.'));
  const ups = Object.values(o.content.upgrades)
    .filter((u) => u.hero === heroId)
    .sort((a, b) => a.cost - b.cost);
  for (const u of ups) root.append(upgradeRow(u, o, () => rerender(heroId)));
  return root;
}

function upgradeRow(u: UpgradeData, o: MenuOptions, refresh: () => void): HTMLElement {
  const row = el('div', 'upgrade');
  const problem = whyNot(o.save, u);
  row.classList.toggle('owned', problem === 'owned');
  row.classList.toggle('locked', problem === 'locked');
  row.append(el('b', '', u.displayName), el('span', 'desc', u.description ?? ''));
  if (problem === 'owned') {
    row.append(el('span', 'state', 'Owned'));
  } else if (problem === 'locked') {
    const r = u.requires ?? {};
    const need: string[] = [];
    if (r.level) need.push(`level ${r.level}`);
    for (const f of r.flags ?? []) need.push(f.replace(/^world(\d)Done$/, 'beat world $1'));
    row.append(el('span', 'state', `Locked: ${need.join(', ')}`));
  } else {
    const b = el('button', '', `Buy · ${u.cost} scrap`);
    b.disabled = problem === 'poor';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = buy(o.save, u);
      if (!next) return;
      o.save = next;
      o.onSave(next);
      refresh();
    });
    row.append(b);
  }
  return row;
}

/** Builds the start-screen tabs: Play (the controls), Campaign and Upgrade Bay. */
export function buildMenu(o: MenuOptions): void {
  const tabs = document.getElementById('menu-tabs');
  const panels: Record<string, HTMLElement | null> = {
    play: document.getElementById('tab-play'),
    campaign: document.getElementById('tab-campaign'),
    bay: document.getElementById('tab-bay'),
  };
  if (!tabs) return;
  let bayHero = o.params.get('hero') && o.params.get('hero')! in o.content.heroes ? o.params.get('hero')! : 'hero.swinger';
  const draw = (name: string) => {
    for (const [k, p] of Object.entries(panels)) if (p) p.style.display = k === name ? '' : 'none';
    for (const a of tabs.querySelectorAll('a')) a.classList.toggle('selected', a.dataset.tab === name);
    if (name === 'campaign' && panels.campaign) panels.campaign.replaceChildren(campaignPanel(o));
    if (name === 'bay' && panels.bay) {
      const render = (heroId: string) => {
        bayHero = heroId;
        panels.bay!.replaceChildren(bayPanel(o, bayHero, render));
      };
      render(bayHero);
    }
  };
  for (const [name, label] of [['play', 'Play'], ['campaign', 'Campaign'], ['bay', 'Upgrade Bay']] as const) {
    const a = el('a', '', label);
    a.href = '#';
    a.dataset.tab = name;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      draw(name);
    });
    tabs.append(a);
  }
  draw(panels[o.tab] ? o.tab : 'play');
}
