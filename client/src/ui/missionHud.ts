export interface ObjectiveLine {
  text: string;
  state: 'done' | 'current' | 'later';
  /** "2 / 5" for the current objective. */
  progress?: string;
}

export interface ResultCard {
  title: string;
  lines: string[];
  buttons: { label: string; href: string; primary?: boolean }[];
}

const DIALOGUE_SECONDS = 4.8;

/** The mission side of the HUD: objectives, the clock, story dialogue, the boss bar and the end-of-mission card. */
export class MissionHud {
  private readonly panel = document.getElementById('mission') as HTMLElement;
  private readonly title = document.getElementById('mission-title') as HTMLElement;
  private readonly list = document.getElementById('mission-objectives') as HTMLElement;
  private readonly timer = document.getElementById('mission-timer') as HTMLElement;
  private readonly dialogue = document.getElementById('dialogue') as HTMLElement;
  private readonly boss = document.getElementById('bossbar') as HTMLElement;
  private readonly bossName = document.getElementById('boss-name') as HTMLElement;
  private readonly bossFill = document.getElementById('boss-fill') as HTMLElement;
  private readonly result = document.getElementById('result') as HTMLElement;
  private readonly lines: { speaker: string; text: string }[] = [];
  private shown = 0;
  private lastKey = '';

  setMission(title: string | null): void {
    this.panel.style.display = title ? 'block' : 'none';
    if (title) this.title.textContent = title;
  }

  /** Redraws the objective list only when something changed. */
  setObjectives(lines: readonly ObjectiveLine[], timeLeft: number | null): void {
    const key = JSON.stringify(lines);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.list.replaceChildren(
        ...lines.map((l) => {
          const li = document.createElement('li');
          li.className = l.state;
          li.textContent = (l.state === 'done' ? '✓ ' : l.state === 'current' ? '▶ ' : '• ') + l.text + (l.progress ? `  (${l.progress})` : '');
          return li;
        }),
      );
    }
    this.timer.style.display = timeLeft === null ? 'none' : 'block';
    if (timeLeft !== null) {
      this.timer.textContent = `Time left: ${Math.ceil(timeLeft)} s`;
      this.timer.classList.toggle('low', timeLeft < 10);
    }
  }

  /** Queue a line of story dialogue; each stays up for a few seconds. */
  say(speaker: string, text: string): void {
    this.lines.push({ speaker, text });
    if (this.lines.length === 1) this.show();
  }

  private show(): void {
    const line = this.lines[0];
    if (!line) {
      this.dialogue.style.display = 'none';
      return;
    }
    this.dialogue.replaceChildren();
    const who = document.createElement('b');
    who.textContent = `${line.speaker}: `;
    this.dialogue.append(who, document.createTextNode(line.text));
    this.dialogue.style.display = 'block';
    this.shown = 0;
  }

  /** The big boss health bar, or hidden when `title` is null. */
  setBoss(title: string | null, fraction = 1): void {
    this.boss.style.display = title ? 'block' : 'none';
    if (title) {
      this.bossName.textContent = title;
      this.bossFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    }
  }

  tick(dt: number): void {
    if (this.lines.length === 0) return;
    this.shown += dt;
    if (this.shown >= DIALOGUE_SECONDS) {
      this.lines.shift();
      this.show();
    }
  }

  showResult(card: ResultCard): void {
    this.result.replaceChildren();
    const box = document.createElement('div');
    box.className = 'card';
    const h = document.createElement('h2');
    h.textContent = card.title;
    box.appendChild(h);
    for (const line of card.lines) {
      const p = document.createElement('p');
      p.textContent = line;
      box.appendChild(p);
    }
    const row = document.createElement('div');
    row.className = 'buttons';
    for (const b of card.buttons) {
      const a = document.createElement('a');
      a.href = b.href;
      a.textContent = b.label;
      if (b.primary) a.className = 'primary';
      row.appendChild(a);
    }
    box.appendChild(row);
    this.result.appendChild(box);
    this.result.style.display = 'flex';
    document.body.classList.add('result');
  }
}
