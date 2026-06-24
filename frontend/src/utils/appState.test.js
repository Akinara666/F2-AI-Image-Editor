import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AVAILABLE_SIZES } from '../constants';
import {
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_BRUSH_SETTINGS,
  DEFAULT_PARAMS,
  HISTORY_MAX_ITEMS,
  HISTORY_STORAGE_KEY,
  clampSidebarWidth,
  getHistoryFilename,
  isMissingHistoryError,
  loadAppSettingsFromStorage,
  loadHistoryFromStorage,
  loadSidebarWidthFromStorage,
  normalizeHistoryItems
} from './appState';

describe('appState', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('нормализует историю, сортирует по времени и ограничивает количество элементов', () => {
    vi.spyOn(Date, 'now').mockReturnValue(777);
    const items = Array.from({ length: HISTORY_MAX_ITEMS + 5 }, (_, index) => ({
      id: `item-${index}`,
      url: `/history/${index}.png`,
      timestamp: index + 1
    }));
    items.push({ id: 'broken', timestamp: 9999 });

    const normalized = normalizeHistoryItems(items);

    expect(normalized).toHaveLength(HISTORY_MAX_ITEMS);
    expect(normalized[0].id).toBe(`item-${HISTORY_MAX_ITEMS + 4}`);
    expect(normalized.at(-1).id).toBe('item-5');
  });

  it('загружает историю как из старого массива, так и из нового объекта', () => {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({
      version: 2,
      items: [
        { id: 'second', url: '/history/2.png', timestamp: 2 },
        { id: 'first', url: '/history/1.png', timestamp: 1 }
      ]
    }));

    expect(loadHistoryFromStorage().map((item) => item.id)).toEqual(['second', 'first']);

    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([
      { id: 'legacy', url: '/history/legacy.png', timestamp: 3 }
    ]));

    expect(loadHistoryFromStorage().map((item) => item.id)).toEqual(['legacy']);
  });

  it('возвращает безопасные значения по умолчанию для битых настроек приложения', () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      params: {
        prompt: 'custom prompt',
        negative_prompt: 'bad',
        seed: 'not-a-number',
        steps: 999,
        cfg: 0.1,
        denoising_strength: 2,
        mask_blur: -5,
        mask_padding: 999,
        frame_size_index: 999,
        model_id: 'custom-model',
        sampler: 'Euler'
      },
      brush: {
        brushMode: 'mask',
        brushColor: '#123456',
        brushSize: 500
      }
    }));

    const settings = loadAppSettingsFromStorage();

    expect(settings.params).toMatchObject({
      prompt: 'custom prompt',
      negative_prompt: 'bad',
      seed: DEFAULT_PARAMS.seed,
      steps: 150,
      cfg: 1,
      denoising_strength: 1,
      mask_blur: 0,
      mask_padding: 128,
      // Завышенный индекс прижимается к последнему пресету размера.
      frame_size_index: AVAILABLE_SIZES.length - 1,
      model_id: 'custom-model',
      sampler: 'Euler'
    });
    expect(settings.brush).toEqual({
      brushMode: 'mask',
      brushColor: '#123456',
      brushSize: 100
    });
  });

  it('мигрирует легаси-имя самплера и отбрасывает неизвестные', () => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      params: { sampler: 'DPM++ 2S a Karras' }
    }));
    expect(loadAppSettingsFromStorage().params.sampler).toBe('DPM++ 2M SDE Karras');

    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({
      params: { sampler: 'Totally Unknown Sampler' }
    }));
    expect(loadAppSettingsFromStorage().params.sampler).toBe(DEFAULT_PARAMS.sampler);
  });

  it('возвращает значения по умолчанию, если сохранённых настроек нет', () => {
    expect(loadAppSettingsFromStorage()).toEqual({
      params: DEFAULT_PARAMS,
      brush: DEFAULT_BRUSH_SETTINGS,
      generationMode: 'whole'
    });
  });

  it('определяет ошибки отсутствующих файлов истории', () => {
    expect(isMissingHistoryError({ response: { status: 404 } })).toBe(true);
    expect(isMissingHistoryError({ message: 'request failed with 410' })).toBe(true);
    expect(isMissingHistoryError({ response: { status: 500 } })).toBe(false);
  });

  it('вычисляет имя файла истории из URL', () => {
    expect(getHistoryFilename('/history/folder/image.png?t=123')).toBe('image.png');
    expect(getHistoryFilename('')).toBe('image.png');
  });

  it('ограничивает ширину сайдбара границами интерфейса', () => {
    expect(clampSidebarWidth(100, 1200)).toBe(320);
    expect(clampSidebarWidth(999, 900)).toBe(560);
    expect(clampSidebarWidth(700, 700)).toBe(380);
  });

  it('читает ширину сайдбара из localStorage и нормализует её', () => {
    localStorage.setItem('app_sidebar_width', '999');
    Object.defineProperty(window, 'innerWidth', {
      value: 860,
      configurable: true
    });

    expect(loadSidebarWidthFromStorage()).toBe(540);
  });
});
