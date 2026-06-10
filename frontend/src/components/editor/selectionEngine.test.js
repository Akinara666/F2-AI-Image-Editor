import { describe, expect, it } from 'vitest';

import {
    combineSelections,
    createSelectionFromEllipse,
    createSelectionFromPolygon,
    createSelectionFromRect,
    featherSelection,
    invertSelection,
    isSelectionEmpty,
    magicWandMask,
    renderSelectionToRGBA,
    sampleMaskForLayer,
    sampleSelectionAt,
    traceSelectionOutline,
    trimSelection
} from './selectionEngine';

const maskSum = (selection) => {
    if (!selection) return 0;
    let sum = 0;
    for (let index = 0; index < selection.mask.length; index += 1) {
        sum += selection.mask[index];
    }
    return sum;
};

const coverageCount = (selection) => {
    if (!selection) return 0;
    let count = 0;
    for (let index = 0; index < selection.mask.length; index += 1) {
        if (selection.mask[index] >= 128) count += 1;
    }
    return count;
};

describe('selectionEngine: построение масок', () => {
    it('прямоугольник даёт полную маску с точной площадью', () => {
        const selection = createSelectionFromRect({ left: 10, top: 20, width: 8, height: 4 });
        expect(selection.left).toBe(10);
        expect(selection.top).toBe(20);
        expect(selection.width).toBe(8);
        expect(selection.height).toBe(4);
        expect(coverageCount(selection)).toBe(32);
        expect(isSelectionEmpty(selection)).toBe(false);
    });

    it('прямоугольник нормализует отрицательные размеры (drag вверх-влево)', () => {
        const selection = createSelectionFromRect({ left: 30, top: 30, width: -10, height: -5 });
        expect(selection.left).toBe(20);
        expect(selection.top).toBe(25);
        expect(selection.width).toBe(10);
        expect(selection.height).toBe(5);
    });

    it('вырожденный прямоугольник → null', () => {
        expect(createSelectionFromRect({ left: 0, top: 0, width: 0.2, height: 50 })).toBeNull();
    });

    it('эллипс покрывает ~π/4 ограничивающего прямоугольника', () => {
        const selection = createSelectionFromEllipse({ left: 0, top: 0, width: 40, height: 40 });
        const coverage = coverageCount(selection);
        const expected = Math.PI * 20 * 20;
        expect(coverage).toBeGreaterThan(expected * 0.92);
        expect(coverage).toBeLessThan(expected * 1.08);
        // Центр — полный, угол — пустой.
        expect(sampleSelectionAt(selection, 20, 20)).toBe(255);
        expect(sampleSelectionAt(selection, 1, 1)).toBe(0);
    });

    it('полигон заливается по чётно-нечётному правилу', () => {
        const selection = createSelectionFromPolygon([
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 }
        ]);
        expect(coverageCount(selection)).toBe(100);
    });

    it('полигон из < 3 точек → null', () => {
        expect(createSelectionFromPolygon([{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBeNull();
    });
});

describe('selectionEngine: волшебная палочка', () => {
    // Синтетика 8×8: левая половина чёрная, правая белая.
    const buildHalves = () => {
        const data = new Uint8ClampedArray(8 * 8 * 4);
        for (let y = 0; y < 8; y += 1) {
            for (let x = 0; x < 8; x += 1) {
                const offset = (y * 8 + x) * 4;
                const value = x < 4 ? 0 : 255;
                data[offset] = value;
                data[offset + 1] = value;
                data[offset + 2] = value;
                data[offset + 3] = 255;
            }
        }
        return { data, width: 8, height: 8 };
    };

    it('выделяет связную область одного цвета', () => {
        const selection = magicWandMask(buildHalves(), 1, 1, { tolerance: 10 });
        expect(coverageCount(selection)).toBe(32);
        expect(selection.left).toBe(0);
        expect(selection.width).toBe(4);
    });

    it('низкий допуск не перетекает через границу, высокий — заливает всё', () => {
        const strict = magicWandMask(buildHalves(), 6, 6, { tolerance: 0 });
        expect(coverageCount(strict)).toBe(32);

        const loose = magicWandMask(buildHalves(), 6, 6, { tolerance: 255 });
        expect(coverageCount(loose)).toBe(64);
    });

    it('учитывает альфу: прозрачный фон не совпадает с чёрным', () => {
        const image = buildHalves();
        // Левая половина: чёрный, но прозрачный.
        for (let y = 0; y < 8; y += 1) {
            for (let x = 0; x < 4; x += 1) {
                image.data[(y * 8 + x) * 4 + 3] = 0;
            }
        }
        // Сид на непрозрачном чёрном — теперь его нет, выделяется только белая половина.
        const selection = magicWandMask(image, 6, 1, { tolerance: 30 });
        expect(coverageCount(selection)).toBe(32);
    });

    it('сид вне изображения → null', () => {
        expect(magicWandMask(buildHalves(), 100, 1, { tolerance: 10 })).toBeNull();
    });
});

describe('selectionEngine: алгебра выделений', () => {
    it('add объединяет с union-границами', () => {
        const a = createSelectionFromRect({ left: 0, top: 0, width: 10, height: 10 });
        const b = createSelectionFromRect({ left: 20, top: 0, width: 10, height: 10 });
        const merged = combineSelections(a, b, 'add');
        expect(merged.left).toBe(0);
        expect(merged.width).toBe(30);
        expect(coverageCount(merged)).toBe(200);
    });

    it('subtract вычитает и сжимает границы', () => {
        const base = createSelectionFromRect({ left: 0, top: 0, width: 20, height: 10 });
        const hole = createSelectionFromRect({ left: 10, top: 0, width: 10, height: 10 });
        const result = combineSelections(base, hole, 'subtract');
        expect(coverageCount(result)).toBe(100);
        expect(result.width).toBe(10);
    });

    it('полное вычитание → null', () => {
        const base = createSelectionFromRect({ left: 0, top: 0, width: 5, height: 5 });
        const all = createSelectionFromRect({ left: -1, top: -1, width: 10, height: 10 });
        expect(combineSelections(base, all, 'subtract')).toBeNull();
    });

    it('replace возвращает новое выделение', () => {
        const a = createSelectionFromRect({ left: 0, top: 0, width: 5, height: 5 });
        const b = createSelectionFromRect({ left: 50, top: 50, width: 5, height: 5 });
        expect(combineSelections(a, b, 'replace')).toBe(b);
    });

    it('двойная инверсия восстанавливает исходную область', () => {
        const frame = { left: 0, top: 0, width: 30, height: 30 };
        const original = createSelectionFromRect({ left: 5, top: 5, width: 10, height: 10 });
        const inverted = invertSelection(original, frame);
        expect(coverageCount(inverted)).toBe(900 - 100);

        const restored = invertSelection(inverted, frame);
        expect(restored.left).toBe(5);
        expect(restored.top).toBe(5);
        expect(coverageCount(restored)).toBe(100);
    });

    it('инверсия пустого выделения — вся рамка, инверсия полной рамки → null', () => {
        const frame = { left: 10, top: 10, width: 20, height: 20 };
        const full = invertSelection(null, frame);
        expect(coverageCount(full)).toBe(400);
        expect(invertSelection(full, frame)).toBeNull();
    });
});

describe('selectionEngine: растушёвка', () => {
    it('сохраняет суммарную массу и расширяет границы', () => {
        const sharp = createSelectionFromRect({ left: 50, top: 50, width: 20, height: 20 });
        const sharpMass = maskSum(sharp);
        const soft = featherSelection(sharp, 6);

        expect(soft.width).toBeGreaterThan(sharp.width);
        const softMass = maskSum(soft);
        expect(softMass).toBeGreaterThan(sharpMass * 0.93);
        expect(softMass).toBeLessThan(sharpMass * 1.07);
        // Край стал мягким: на бывшей границе значение промежуточное.
        expect(sampleSelectionAt(soft, 50, 60)).toBeGreaterThan(40);
        expect(sampleSelectionAt(soft, 50, 60)).toBeLessThan(220);
        expect(soft.feather).toBe(6);
    });

    it('нулевой или отрицательный радиус — без изменений', () => {
        const selection = createSelectionFromRect({ left: 0, top: 0, width: 4, height: 4 });
        expect(featherSelection(selection, 0)).toBe(selection);
        expect(featherSelection(selection, -3)).toBe(selection);
    });
});

describe('selectionEngine: адаптеры', () => {
    it('trimSelection сжимает до содержимого', () => {
        const selection = createSelectionFromRect({ left: 0, top: 0, width: 10, height: 10 });
        selection.mask.fill(0);
        selection.mask[5 * 10 + 7] = 255;
        const trimmed = trimSelection(selection);
        expect(trimmed.left).toBe(7);
        expect(trimmed.top).toBe(5);
        expect(trimmed.width).toBe(1);
        expect(trimmed.height).toBe(1);
    });

    it('sampleMaskForLayer ресемплит в пиксели слоя с учётом масштаба', () => {
        const selection = createSelectionFromRect({ left: 10, top: 10, width: 10, height: 10 });
        // Слой 10×10 с масштабом 2 → покрывает мир 0..20; выделение покрывает
        // мировые 10..20 → правый нижний квадрант локальной маски.
        const layerMask = sampleMaskForLayer(
            selection,
            { left: 0, top: 0, scaleX: 2, scaleY: 2 },
            10,
            10
        );
        expect(layerMask[0]).toBe(0);
        expect(layerMask[9 * 10 + 9]).toBe(255);
        let covered = 0;
        for (let index = 0; index < layerMask.length; index += 1) {
            if (layerMask[index] === 255) covered += 1;
        }
        expect(covered).toBe(25);
    });

    it('sampleMaskForLayer без пересечения → null', () => {
        const selection = createSelectionFromRect({ left: 100, top: 100, width: 5, height: 5 });
        expect(sampleMaskForLayer(selection, { left: 0, top: 0, scaleX: 1, scaleY: 1 }, 10, 10)).toBeNull();
    });

    it('traceSelectionOutline на квадрате — одна петля из 4 углов', () => {
        const selection = createSelectionFromRect({ left: 3, top: 4, width: 5, height: 6 });
        const loops = traceSelectionOutline(selection);
        expect(loops).toHaveLength(1);
        expect(loops[0]).toHaveLength(4);
        const xs = loops[0].map((point) => point.x);
        const ys = loops[0].map((point) => point.y);
        expect(Math.min(...xs)).toBe(3);
        expect(Math.max(...xs)).toBe(8);
        expect(Math.min(...ys)).toBe(4);
        expect(Math.max(...ys)).toBe(10);
    });

    it('traceSelectionOutline различает несвязные области', () => {
        const a = createSelectionFromRect({ left: 0, top: 0, width: 3, height: 3 });
        const b = createSelectionFromRect({ left: 10, top: 0, width: 3, height: 3 });
        const merged = combineSelections(a, b, 'add');
        expect(traceSelectionOutline(merged)).toHaveLength(2);
    });

    it('renderSelectionToRGBA пишет white-on-black', () => {
        const selection = createSelectionFromRect({ left: 1, top: 1, width: 2, height: 2 });
        const bounds = { left: 0, top: 0, width: 4, height: 4 };
        const rgba = new Uint8ClampedArray(4 * 4 * 4);
        renderSelectionToRGBA(selection, bounds, rgba);
        // (0,0) — чёрный непрозрачный; (1,1) — белый.
        expect(rgba[0]).toBe(0);
        expect(rgba[3]).toBe(255);
        const inside = (1 * 4 + 1) * 4;
        expect(rgba[inside]).toBe(255);
        expect(rgba[inside + 3]).toBe(255);
    });
});
