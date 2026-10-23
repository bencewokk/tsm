import { N } from './constants';
import { Rng } from './rng';
import { generateTerrain, type Grid } from './terrain';
import type { Command, InitMsg, StateMsg, Stats } from './protocol';

export class Sim {
  rng: Rng;
  g: Grid;
  month = 0;
  speed = 1;
  target = new Uint8Array(N * N);
  constr = new Uint8Array(N * N);
  constrTotal = new Uint8Array(N * N);
  lv = new Float32Array(N * N);
  planType = new Uint8Array(N * N);
  planLevel = new Uint8Array(N * N);
  log: string[] = [];

  constructor(public seed: number) {
    this.rng = new Rng(seed);
    this.g = generateTerrain(seed, this.rng);
  }

  apply(cmd: Command) {
    if (cmd.type === 'speed') this.speed = cmd.speed;
  }

  paused(): boolean {
    return false;
  }

  quoteLine(_stations: number[]) {
    return { cost: 0, km: 0, underwaterKm: 0 };
  }

  tick() {
    this.month++;
  }

  initMsg(): InitMsg {
    return { type: 'init', seed: this.seed, height: this.g.height, water: this.g.water, villages: this.g.villages, bay: this.g.bay };
  }

  stats(): Stats {
    return {
      month: this.month, population: 0, homes: 0, jobs: 0, money: 0, income: 0, expenses: 0, build: 0,
      resDemand: 0, comDemand: 0, indDemand: 0, congestion: 0, driveSpeed: 0, transitShare: 0, transitTrips: 0, rating: 0, buildings: 0,
    };
  }

  snapshot(): StateMsg {
    const g = this.g;
    return {
      type: 'state', stats: this.stats(),
      road: g.road.slice(), btype: g.btype.slice(), level: g.level.slice(), target: this.target.slice(),
      constr: this.constr.slice(), constrTotal: this.constrTotal.slice(), lv: this.lv.slice(), flags: g.flags.slice(),
      planType: this.planType.slice(), planLevel: this.planLevel.slice(),
      stations: [], lines: [], event: null,
      docks: { state: 'none', deal: '', dealName: '', brief: '', deadline: 0, served: 0, planned: 0, carLocked: 0, built: 0, centre: { x: 0, y: 0 } },
      desire: [], log: this.log.slice(-8), speed: this.speed,
    };
  }
}
