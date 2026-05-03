import { describe, expect, it } from 'vitest';
import { createEditBudget } from './edit-budget.js';

describe('createEditBudget', () => {
  it('returns null until the threshold is reached', () => {
    const budget = createEditBudget(5);
    expect(budget.recordEdit('index.html')).toBeNull();
    expect(budget.recordEdit('index.html')).toBeNull();
    expect(budget.recordEdit('index.html')).toBeNull();
    expect(budget.recordEdit('index.html')).toBeNull();
    expect(budget.countFor('index.html')).toBe(4);
    const warn = budget.recordEdit('index.html');
    expect(warn).not.toBeNull();
    expect(warn).toContain('[edit-budget]');
    expect(warn).toContain('5 consecutive str_replace calls against index.html');
  });

  it('keeps emitting warnings on subsequent edits past the threshold (the next one matters too)', () => {
    const budget = createEditBudget(3);
    budget.recordEdit('a');
    budget.recordEdit('a');
    expect(budget.recordEdit('a')).toContain('3 consecutive');
    expect(budget.recordEdit('a')).toContain('4 consecutive');
  });

  it('counts each path independently', () => {
    const budget = createEditBudget(3);
    budget.recordEdit('a');
    budget.recordEdit('a');
    budget.recordEdit('b');
    expect(budget.countFor('a')).toBe(2);
    expect(budget.countFor('b')).toBe(1);
    expect(budget.recordEdit('a')).toContain('against a');
  });

  it('reset() clears every path', () => {
    const budget = createEditBudget(3);
    budget.recordEdit('a');
    budget.recordEdit('b');
    budget.reset();
    expect(budget.countFor('a')).toBe(0);
    expect(budget.countFor('b')).toBe(0);
    expect(budget.recordEdit('a')).toBeNull();
  });

  it('default threshold is 5', () => {
    const budget = createEditBudget();
    for (let i = 0; i < 4; i += 1) {
      expect(budget.recordEdit('p')).toBeNull();
    }
    expect(budget.recordEdit('p')).toContain('5 consecutive');
  });
});
