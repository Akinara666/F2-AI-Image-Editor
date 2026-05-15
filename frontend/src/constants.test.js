import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AVAILABLE_SIZES,
  createClientId,
  normalizeGenerationParams,
  parseGenerationNumericParam,
  resolveApiUrl
} from './constants';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('constants', () => {
  it('оставляет абсолютный URL без изменений', () => {
    expect(resolveApiUrl('https://example.com/image.png')).toBe('https://example.com/image.png');
  });

  it('собирает относительный путь от пустой базы', () => {
    expect(resolveApiUrl('/health')).toBe('/health');
    expect(resolveApiUrl('')).toBe('');
  });

  it('нормализует целочисленный параметр и ограничивает его диапазон', () => {
    expect(parseGenerationNumericParam('steps', '999')).toMatchObject({
      valid: true,
      value: 150
    });
  });

  it('отклоняет нецелое значение для целочисленного параметра', () => {
    expect(parseGenerationNumericParam('seed', '12.5')).toMatchObject({
      valid: false,
      reason: 'not_integer',
      value: -1
    });
  });

  it('нормализует float-параметр и ограничивает его диапазон', () => {
    expect(parseGenerationNumericParam('cfg', '0.1')).toMatchObject({
      valid: true,
      value: 1
    });
  });

  it('возвращает список некорректных числовых полей', () => {
    const result = normalizeGenerationParams({
      frame_size_index: '',
      seed: -1,
      steps: 'oops',
      cfg: 7.5,
      denoising_strength: 0.75,
      mask_blur: 4,
      mask_padding: 32
    });

    expect(result.invalidFields).toEqual([
      { name: 'frame_size_index', label: 'Размер рамки', reason: 'empty' },
      { name: 'steps', label: 'Шаги', reason: 'nan' }
    ]);
  });

  it('использует crypto.randomUUID для клиентского идентификатора', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('uuid-123');
    expect(createClientId('history')).toBe('history-uuid-123');
  });

  it('корректно ограничивает индекс размера рамки', () => {
    const lastIndex = AVAILABLE_SIZES.length - 1;
    expect(parseGenerationNumericParam('frame_size_index', String(lastIndex + 10))).toMatchObject({
      valid: true,
      value: lastIndex
    });
  });
});
