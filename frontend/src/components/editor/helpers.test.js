import { describe, expect, it, vi } from 'vitest';

import {
  applyFrameViewportStyle,
  areTransformsEqual,
  serializeFrameVisualState,
  snapshotObjectTransform
} from './helpers';

describe('editor helpers', () => {
  it('снимает transform-снэпшот только с нужных полей', () => {
    const snapshot = snapshotObjectTransform({
      left: 12,
      top: 24,
      width: 320,
      height: 180,
      scaleX: 1.5,
      scaleY: 0.75,
      angle: 30,
      flipX: true,
      flipY: false,
      stroke: '#fff'
    });

    expect(snapshot).toEqual({
      left: 12,
      top: 24,
      width: 320,
      height: 180,
      scaleX: 1.5,
      scaleY: 0.75,
      angle: 30,
      flipX: true,
      flipY: false
    });
  });

  it('сравнивает transform-состояния без ложных совпадений', () => {
    const base = {
      left: 10,
      top: 20,
      width: 200,
      height: 100,
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      flipX: false,
      flipY: false
    };

    expect(areTransformsEqual(base, { ...base })).toBe(true);
    expect(areTransformsEqual(base, { ...base, scaleY: 2 })).toBe(false);
    expect(areTransformsEqual(base, { ...base, angle: 90 })).toBe(false);
    expect(areTransformsEqual(base, { ...base, flipX: true })).toBe(false);
    expect(areTransformsEqual(base, { ...base, flipY: true })).toBe(false);
  });

  it('сериализует визуальное состояние рамки и копирует dash-массив', () => {
    const source = {
      left: 5,
      top: 6,
      width: 512,
      height: 512,
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      visible: true,
      strokeWidth: 3,
      strokeDashArray: [10, 5]
    };

    const serialized = serializeFrameVisualState(source);

    expect(serialized).toEqual({
      left: 5,
      top: 6,
      width: 512,
      height: 512,
      scaleX: 1,
      scaleY: 1,
      angle: 0,
      visible: true,
      strokeWidth: 3,
      strokeDashArray: [10, 5]
    });
    expect(serialized.strokeDashArray).not.toBe(source.strokeDashArray);
  });

  it('масштабирует обводку рамки относительно текущего zoom', () => {
    const frameVisualObject = {
      set: vi.fn()
    };

    applyFrameViewportStyle(frameVisualObject, 2);

    expect(frameVisualObject.set).toHaveBeenCalledWith({
      strokeWidth: 1.5,
      strokeDashArray: [5, 2.5]
    });
  });

  it('использует безопасный минимальный zoom при отрицательном значении', () => {
    const frameVisualObject = {
      set: vi.fn()
    };

    applyFrameViewportStyle(frameVisualObject, -2);

    expect(frameVisualObject.set).toHaveBeenCalledWith({
      strokeWidth: 30,
      strokeDashArray: [100, 50]
    });
  });
});
