/**
 * Unit tests for the VirtualClock helper (F#69, 2026-05-28).
 * These pin the behavior other tests' assertions depend on —
 * if VirtualClock breaks, the watcher logic tests inherit the
 * breakage and the failure mode would be confusing.
 */
import { describe, it, expect, vi } from 'vitest';
import { VirtualClock, tick } from './helpers/virtual-clock.js';

describe('VirtualClock', () => {
  it('starts at t=0', () => {
    const clock = new VirtualClock();
    expect(clock.now()).toBe(0);
  });

  it('advance() without timers just moves the clock', () => {
    const clock = new VirtualClock();
    clock.advance(500);
    expect(clock.now()).toBe(500);
  });

  it('setTimeout fires once at the right virtual time', () => {
    const clock = new VirtualClock();
    const fn = vi.fn();
    clock.setTimeout(fn, 200);
    expect(fn).not.toHaveBeenCalled();
    clock.advance(199);
    expect(fn).not.toHaveBeenCalled();
    clock.advance(2);
    expect(fn).toHaveBeenCalledTimes(1);
    clock.advance(1000);
    expect(fn).toHaveBeenCalledTimes(1); // still once — one-shot
  });

  it('cancel() prevents a pending setTimeout from firing', () => {
    const clock = new VirtualClock();
    const fn = vi.fn();
    const h = clock.setTimeout(fn, 100);
    h.cancel();
    clock.advance(500);
    expect(fn).not.toHaveBeenCalled();
  });

  it('setInterval fires repeatedly at the configured cadence', () => {
    const clock = new VirtualClock();
    const fn = vi.fn();
    clock.setInterval(fn, 100);
    clock.advance(350); // fires at 100, 200, 300
    expect(fn).toHaveBeenCalledTimes(3);
    clock.advance(50); // total 400; should fire once more at t=400
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('setInterval cancel() stops further firings', () => {
    const clock = new VirtualClock();
    const fn = vi.fn();
    const h = clock.setInterval(fn, 100);
    clock.advance(250); // fires at 100, 200
    expect(fn).toHaveBeenCalledTimes(2);
    h.cancel();
    clock.advance(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('timers scheduled inside a callback fire within the same advance() window', () => {
    const clock = new VirtualClock();
    const outer = vi.fn();
    const inner = vi.fn();
    clock.setTimeout(() => {
      outer();
      clock.setTimeout(inner, 50);
    }, 100);
    clock.advance(200);
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
    // Inner should fire at t=150 (the outer fired at 100, scheduled +50).
    expect(clock.now()).toBe(200);
  });

  it('out-of-order pending timers fire in chronological order', () => {
    const clock = new VirtualClock();
    const order: number[] = [];
    clock.setTimeout(() => order.push(300), 300);
    clock.setTimeout(() => order.push(100), 100);
    clock.setTimeout(() => order.push(200), 200);
    clock.advance(500);
    expect(order).toEqual([100, 200, 300]);
  });

  it('tick() flushes microtasks so async callbacks see post-state', async () => {
    const clock = new VirtualClock();
    let value = 0;
    clock.setTimeout(() => {
      void Promise.resolve().then(() => {
        value = 42;
      });
    }, 100);
    await tick(clock, 100);
    expect(value).toBe(42);
  });
});
