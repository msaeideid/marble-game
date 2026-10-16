import { Game } from './game/game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hud = document.getElementById('build') as HTMLElement;

const game = new Game(canvas, hud);
game.start();

// Handy for debugging and automated browser checks.
(window as unknown as { __vanguard: Game }).__vanguard = game;
