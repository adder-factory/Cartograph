// JavaScript test bed
import { Helper } from './helper.js';

export class Container {
  constructor() { this.items = []; }
  add(item) { this.items.push(item); }
  size() { return this.items.length; }
}

export function process(input) {
  const c = new Container();
  c.add(input);
  Helper.log(c);
  return c;
}

const FOO = 42;
