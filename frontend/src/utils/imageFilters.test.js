import { describe, expect, it } from 'vitest';

import {
    ADJUSTMENT_TYPES,
    applyAdjustment,
    applyBrightnessContrast,
    applyCurves,
    applyGaussianBlur,
    applyHueSaturation,
    applyInvert,
    applyLevels,
    applyNoise,
    applyUnsharpMask,
    buildCurveLut,
    buildLuminanceHistogram
} from './imageFilters';

const buildImage = (width, height, fill = [128, 128, 128, 255]) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
        data.set(fill, pixel * 4);
    }
    return { data, width, height };
};

const buildGradientImage = (width, height) => {
    const image = buildImage(width, height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 4;
            const value = Math.round((x / Math.max(1, width - 1)) * 255);
            image.data[offset] = value;
            image.data[offset + 1] = value;
            image.data[offset + 2] = value;
            image.data[offset + 3] = 255;
        }
    }
    return image;
};

const luminanceSum = (image) => {
    let sum = 0;
    for (let offset = 0; offset < image.data.length; offset += 4) {
        sum += image.data[offset] + image.data[offset + 1] + image.data[offset + 2];
    }
    return sum;
};

describe('imageFilters: LUT-фильтры', () => {
    it('инверсия дважды — тождество', () => {
        const image = buildGradientImage(16, 4);
        const original = new Uint8ClampedArray(image.data);
        applyInvert(image);
        expect(image.data).not.toEqual(original);
        applyInvert(image);
        expect(image.data).toEqual(original);
    });

    it('яркость клампится в [0, 255] и не трогает альфу', () => {
        const image = buildImage(4, 4, [250, 5, 128, 200]);
        applyBrightnessContrast(image, { brightness: 100, contrast: 0 });
        expect(image.data[0]).toBe(255);
        expect(image.data[1]).toBe(105);
        expect(image.data[3]).toBe(200);
    });

    it('нулевые яркость/контраст — тождество', () => {
        const image = buildGradientImage(16, 2);
        const original = new Uint8ClampedArray(image.data);
        applyBrightnessContrast(image, { brightness: 0, contrast: 0 });
        expect(image.data).toEqual(original);
    });

    it('контраст растягивает значения от середины', () => {
        const image = buildImage(2, 1, [100, 160, 128, 255]);
        applyBrightnessContrast(image, { brightness: 0, contrast: 50 });
        expect(image.data[0]).toBeLessThan(100);
        expect(image.data[1]).toBeGreaterThan(160);
        expect(image.data[2]).toBe(128);
    });

    it('levels отображает inBlack→outBlack и inWhite→outWhite', () => {
        const image = buildImage(2, 1, [50, 200, 128, 255]);
        applyLevels(image, { inBlack: 50, inWhite: 200, gamma: 1, outBlack: 10, outWhite: 240 });
        expect(image.data[0]).toBe(10);
        expect(image.data[1]).toBe(240);
    });

    it('гамма > 1 осветляет средние тона', () => {
        const image = buildImage(1, 1, [128, 128, 128, 255]);
        applyLevels(image, { gamma: 2 });
        expect(image.data[0]).toBeGreaterThan(170);
    });
});

describe('imageFilters: кривые', () => {
    it('диагональные точки дают identity-LUT', () => {
        const lut = buildCurveLut([{ x: 0, y: 0 }, { x: 255, y: 255 }]);
        for (let value = 0; value < 256; value += 16) {
            expect(lut[value]).toBe(value);
        }
    });

    it('кривая монотонна без выбросов (Fritsch–Carlson)', () => {
        const lut = buildCurveLut([
            { x: 0, y: 0 },
            { x: 64, y: 200 },
            { x: 128, y: 210 },
            { x: 255, y: 255 }
        ]);
        for (let value = 1; value < 256; value += 1) {
            expect(lut[value]).toBeGreaterThanOrEqual(lut[value - 1]);
        }
    });

    it('applyCurves использует контрольные точки', () => {
        const image = buildImage(1, 1, [128, 128, 128, 255]);
        applyCurves(image, { points: [{ x: 0, y: 0 }, { x: 128, y: 64 }, { x: 255, y: 255 }] });
        expect(image.data[0]).toBe(64);
    });
});

describe('imageFilters: тон/насыщенность', () => {
    it('hue +120° превращает красный в зелёный', () => {
        const image = buildImage(1, 1, [255, 0, 0, 255]);
        applyHueSaturation(image, { hue: 120 });
        expect(image.data[0]).toBeLessThan(10);
        expect(image.data[1]).toBeGreaterThan(245);
    });

    it('насыщенность -100 даёт оттенки серого', () => {
        const image = buildImage(1, 1, [200, 50, 100, 255]);
        applyHueSaturation(image, { saturation: -100 });
        expect(image.data[0]).toBe(image.data[1]);
        expect(image.data[1]).toBe(image.data[2]);
    });

    it('нулевые параметры почти не меняют изображение', () => {
        const image = buildGradientImage(16, 2);
        const original = new Uint8ClampedArray(image.data);
        applyHueSaturation(image, { hue: 0, saturation: 0, lightness: 0 });
        for (let offset = 0; offset < image.data.length; offset += 4) {
            expect(Math.abs(image.data[offset] - original[offset])).toBeLessThanOrEqual(1);
        }
    });
});

describe('imageFilters: пространственные фильтры', () => {
    it('размытие сохраняет суммарную яркость непрозрачного изображения', () => {
        const image = buildGradientImage(32, 32);
        const before = luminanceSum(image);
        applyGaussianBlur(image, { radius: 4 });
        const after = luminanceSum(image);
        expect(Math.abs(after - before) / before).toBeLessThan(0.02);
    });

    it('размытие сглаживает резкую границу', () => {
        const image = buildImage(16, 1);
        for (let x = 0; x < 16; x += 1) {
            const value = x < 8 ? 0 : 255;
            image.data.set([value, value, value, 255], x * 4);
        }
        applyGaussianBlur(image, { radius: 3 });
        const boundary = image.data[8 * 4];
        expect(boundary).toBeGreaterThan(40);
        expect(boundary).toBeLessThan(215);
    });

    it('радиус 0 — тождество', () => {
        const image = buildGradientImage(8, 2);
        const original = new Uint8ClampedArray(image.data);
        applyGaussianBlur(image, { radius: 0 });
        expect(image.data).toEqual(original);
    });

    it('unsharp с amount 0 — тождество, с amount > 0 усиливает границу', () => {
        const buildEdge = () => {
            const image = buildImage(16, 1);
            for (let x = 0; x < 16; x += 1) {
                const value = x < 8 ? 64 : 192;
                image.data.set([value, value, value, 255], x * 4);
            }
            return image;
        };

        const identity = buildEdge();
        const original = new Uint8ClampedArray(identity.data);
        applyUnsharpMask(identity, { amount: 0, radius: 2 });
        expect(identity.data).toEqual(original);

        const sharpened = buildEdge();
        applyUnsharpMask(sharpened, { amount: 200, radius: 2 });
        expect(sharpened.data[7 * 4]).toBeLessThan(64);
        expect(sharpened.data[8 * 4]).toBeGreaterThan(192);
    });

    it('шум детерминирован при подменённом random и щадит прозрачные пиксели', () => {
        const image = buildImage(4, 1, [128, 128, 128, 255]);
        image.data[3] = 0; // первый пиксель прозрачный
        let counter = 0;
        const fakeRandom = () => {
            counter += 1;
            return (counter % 10) / 10;
        };
        applyNoise(image, { amount: 20, monochrome: true, random: fakeRandom });
        expect(image.data[0]).toBe(128); // прозрачный не тронут
        expect(image.data[4]).not.toBe(128);
        // Монохромный шум одинаков по каналам.
        expect(image.data[4]).toBe(image.data[5]);
    });
});

describe('imageFilters: диспетчер и гистограмма', () => {
    it('applyAdjustment маршрутизирует по типу и бросает на неизвестном', () => {
        const image = buildImage(2, 2, [10, 20, 30, 255]);
        applyAdjustment(image, ADJUSTMENT_TYPES.INVERT);
        expect(image.data[0]).toBe(245);
        expect(() => applyAdjustment(image, 'nope')).toThrow();
    });

    it('гистограмма считает только непрозрачные пиксели', () => {
        const image = buildImage(4, 1, [255, 255, 255, 255]);
        image.data[3] = 0;
        const histogram = buildLuminanceHistogram(image, 1);
        expect(histogram[255]).toBe(3);
        let total = 0;
        histogram.forEach((count) => { total += count; });
        expect(total).toBe(3);
    });
});
