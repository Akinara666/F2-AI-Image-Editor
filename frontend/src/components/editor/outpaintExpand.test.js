import { describe, it, expect } from 'vitest';
import { snapDim, computeExpand, computeAspect } from './outpaintExpand';

describe('snapDim', () => {
  it('округляет до кратного 8 и не опускается ниже 8', () => {
    expect(snapDim(512)).toBe(512);
    expect(snapDim(515)).toBe(512);
    expect(snapDim(516)).toBe(520);
    expect(snapDim(1)).toBe(8);
  });
});

describe('computeExpand', () => {
  const size = { width: 512, height: 512 };

  it('вправо растит ширину, якорит контент слева, размеры кратны 8', () => {
    const r = computeExpand(size, 'right');
    expect(r.width).toBeGreaterThan(512);
    expect(r.height).toBe(512);
    expect(r.anchorX).toBe(0);
    expect(r.width % 8).toBe(0);
  });

  it('вверх растит высоту, якорит контент снизу', () => {
    const r = computeExpand(size, 'up');
    expect(r.height).toBeGreaterThan(512);
    expect(r.width).toBe(512);
    expect(r.anchorY).toBe(1);
  });

  it('все стороны растят оба измерения, центр-якорь', () => {
    const r = computeExpand(size, 'all');
    expect(r.width).toBeGreaterThan(512);
    expect(r.height).toBeGreaterThan(512);
    expect(r.anchorX).toBe(0.5);
    expect(r.anchorY).toBe(0.5);
  });

  it('возвращает null на мусоре', () => {
    expect(computeExpand(null, 'right')).toBeNull();
    expect(computeExpand(size, 'nope')).toBeNull();
  });
});

describe('computeAspect', () => {
  it('из портрета в 16:9 расширяет ширину, не трогая высоту', () => {
    const r = computeAspect({ width: 512, height: 768 }, 16, 9);
    expect(r.height).toBe(768);
    expect(r.width).toBeGreaterThanOrEqual(768 * 16 / 9 - 8);
    expect(r.width % 8).toBe(0);
  });

  it('только растит, никогда не уменьшает', () => {
    const r = computeAspect({ width: 1024, height: 512 }, 1, 1);
    expect(r.width).toBeGreaterThanOrEqual(1024);
    expect(r.height).toBeGreaterThanOrEqual(1024);
  });

  it('уже нужное соотношение оставляет как есть', () => {
    const r = computeAspect({ width: 512, height: 512 }, 1, 1);
    expect(r.width).toBe(512);
    expect(r.height).toBe(512);
  });
});
