// TypeScript test bed
import { Helper } from './helper';

export interface Box<T> { value: T; }

export class Container<T> {
  private items: Box<T>[] = [];
  add(item: Box<T>): void { this.items.push(item); }
  size(): number { return this.items.length; }
}

export function process(input: Box<string>): Container<string> {
  const c = new Container<string>();
  c.add(input);
  Helper.log(c);
  return c;
}

const FOO: number = 42;
