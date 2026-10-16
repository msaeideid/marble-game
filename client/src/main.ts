import { Game } from './game/game';

const canvas = document.getElementById('game') as HTMLCanvasElement;

const game = new Game(canvas);
game.start();

// Handy for debugging and automated browser checks.
(window as unknown as { __vanguard: Game }).__vanguard = game;
