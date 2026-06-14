import { describe, it, expect } from 'vitest';
import {
  GENERATION_MODES,
  INTENT_PRESETS,
  isGenerationMode,
  resolveBackendMode
} from './generationModes';

describe('resolveBackendMode', () => {
  it('«вся картинка» -> auto без отправки маски', () => {
    expect(resolveBackendMode(GENERATION_MODES.WHOLE)).toEqual({ mode: 'auto', sendMask: false });
  });

  it('inpaint -> inpainting с маской', () => {
    expect(resolveBackendMode(GENERATION_MODES.INPAINT)).toEqual({ mode: 'inpainting', sendMask: true });
  });

  it('outpaint -> inpainting с маской', () => {
    expect(resolveBackendMode(GENERATION_MODES.OUTPAINT)).toEqual({ mode: 'inpainting', sendMask: true });
  });

  it('неизвестный режим откатывается на auto без маски', () => {
    expect(resolveBackendMode('garbage')).toEqual({ mode: 'auto', sendMask: false });
  });
});

describe('isGenerationMode', () => {
  it('принимает валидные id и отклоняет мусор', () => {
    expect(isGenerationMode('inpaint')).toBe(true);
    expect(isGenerationMode('nope')).toBe(false);
  });
});

describe('INTENT_PRESETS', () => {
  it('каждый пресет несёт denoising_strength в допустимом диапазоне', () => {
    Object.values(INTENT_PRESETS).flat().forEach((preset) => {
      expect(preset.params.denoising_strength).toBeGreaterThanOrEqual(0);
      expect(preset.params.denoising_strength).toBeLessThanOrEqual(1);
    });
  });
});
