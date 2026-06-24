// Ядро классических выделений. Выделение — маска покрытия в мировых
// координатах: { left, top, width, height, mask: Uint8ClampedArray, feather }.
// Все функции чистые и работают на typed arrays — без DOM-канвасов,
// чтобы модуль был тестируем под jsdom.

const SELECTION_THRESHOLD = 128;

const allocSelection = (left, top, width, height) => ({
    left: Math.round(left),
    top: Math.round(top),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    mask: new Uint8ClampedArray(Math.max(1, Math.round(width)) * Math.max(1, Math.round(height))),
    feather: 0
});

export const isSelectionEmpty = (selection) => {
    if (!selection?.mask) {
        return true;
    }
    for (let index = 0; index < selection.mask.length; index += 1) {
        if (selection.mask[index] !== 0) {
            return false;
        }
    }
    return true;
};

// Сжимает границы до непустого содержимого; пустое выделение → null.
export const trimSelection = (selection) => {
    if (!selection?.mask) {
        return null;
    }
    const { width, height, mask } = selection;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
        const rowOffset = y * width;
        for (let x = 0; x < width; x += 1) {
            if (mask[rowOffset + x] !== 0) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }

    if (maxX < 0) {
        return null;
    }
    if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) {
        return selection;
    }

    const next = allocSelection(
        selection.left + minX,
        selection.top + minY,
        maxX - minX + 1,
        maxY - minY + 1
    );
    next.feather = selection.feather;
    for (let y = 0; y < next.height; y += 1) {
        const sourceOffset = (y + minY) * width + minX;
        next.mask.set(mask.subarray(sourceOffset, sourceOffset + next.width), y * next.width);
    }
    return next;
};

export const createSelectionFromRect = (rect) => {
    const left = Math.round(Math.min(rect.left, rect.left + rect.width));
    const top = Math.round(Math.min(rect.top, rect.top + rect.height));
    const width = Math.round(Math.abs(rect.width));
    const height = Math.round(Math.abs(rect.height));
    if (width < 1 || height < 1) {
        return null;
    }

    const selection = allocSelection(left, top, width, height);
    selection.mask.fill(255);
    return selection;
};

export const createSelectionFromEllipse = (rect) => {
    const left = Math.min(rect.left, rect.left + rect.width);
    const top = Math.min(rect.top, rect.top + rect.height);
    const width = Math.abs(rect.width);
    const height = Math.abs(rect.height);
    if (width < 1 || height < 1) {
        return null;
    }

    const selection = allocSelection(left, top, width, height);
    const radiusX = selection.width / 2;
    const radiusY = selection.height / 2;
    const centerX = radiusX;
    const centerY = radiusY;
    // ~1px антиалиасинг по радиальному расстоянию.
    const edgeScale = Math.min(radiusX, radiusY);

    for (let y = 0; y < selection.height; y += 1) {
        const normalizedY = (y + 0.5 - centerY) / radiusY;
        const rowOffset = y * selection.width;
        for (let x = 0; x < selection.width; x += 1) {
            const normalizedX = (x + 0.5 - centerX) / radiusX;
            const radial = Math.sqrt(normalizedX * normalizedX + normalizedY * normalizedY);
            const coverage = (1 - radial) * edgeScale + 0.5;
            selection.mask[rowOffset + x] = Math.max(0, Math.min(1, coverage)) * 255;
        }
    }
    return trimSelection(selection);
};

export const createSelectionFromPolygon = (points) => {
    if (!Array.isArray(points) || points.length < 3) {
        return null;
    }

    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const left = Math.floor(Math.min(...xs));
    const top = Math.floor(Math.min(...ys));
    const width = Math.ceil(Math.max(...xs)) - left;
    const height = Math.ceil(Math.max(...ys)) - top;
    if (width < 1 || height < 1) {
        return null;
    }

    const selection = allocSelection(left, top, width, height);

    // Чётно-нечётная скан-линия по центрам пикселей.
    for (let y = 0; y < selection.height; y += 1) {
        const sampleY = top + y + 0.5;
        const crossings = [];
        for (let index = 0; index < points.length; index += 1) {
            const start = points[index];
            const end = points[(index + 1) % points.length];
            if ((start.y <= sampleY && end.y > sampleY) || (end.y <= sampleY && start.y > sampleY)) {
                const t = (sampleY - start.y) / (end.y - start.y);
                crossings.push(start.x + t * (end.x - start.x));
            }
        }
        crossings.sort((a, b) => a - b);

        const rowOffset = y * selection.width;
        for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
            const spanStart = Math.max(0, Math.round(crossings[pair] - left));
            const spanEnd = Math.min(selection.width, Math.round(crossings[pair + 1] - left));
            for (let x = spanStart; x < spanEnd; x += 1) {
                selection.mask[rowOffset + x] = 255;
            }
        }
    }
    return trimSelection(selection);
};

// Заливка от затравки по RGBA-допуску (scanline flood fill, 4-связность).
// imageData: { data, width, height }; результат в координатах imageData.
export const magicWandMask = (imageData, seedX, seedY, { tolerance = 32 } = {}) => {
    const { data, width, height } = imageData;
    const startX = Math.round(seedX);
    const startY = Math.round(seedY);
    if (startX < 0 || startY < 0 || startX >= width || startY >= height) {
        return null;
    }

    const seedOffset = (startY * width + startX) * 4;
    const seedR = data[seedOffset];
    const seedG = data[seedOffset + 1];
    const seedB = data[seedOffset + 2];
    const seedA = data[seedOffset + 3];

    const matches = (pixelIndex) => {
        const offset = pixelIndex * 4;
        return Math.abs(data[offset] - seedR) <= tolerance
            && Math.abs(data[offset + 1] - seedG) <= tolerance
            && Math.abs(data[offset + 2] - seedB) <= tolerance
            && Math.abs(data[offset + 3] - seedA) <= tolerance;
    };

    const selection = allocSelection(0, 0, width, height);
    const { mask } = selection;
    const visited = new Uint8Array(width * height);
    const stack = [startY * width + startX];

    while (stack.length > 0) {
        const pixelIndex = stack.pop();
        if (visited[pixelIndex]) {
            continue;
        }
        const y = Math.floor(pixelIndex / width);

        // Расширяем горизонтальный отрезок в обе стороны.
        let spanStart = pixelIndex;
        while (spanStart % width > 0 && !visited[spanStart - 1] && matches(spanStart - 1)) {
            spanStart -= 1;
        }
        let spanEnd = pixelIndex;
        while ((spanEnd + 1) % width !== 0 && !visited[spanEnd + 1] && matches(spanEnd + 1)) {
            spanEnd += 1;
        }
        if (!matches(pixelIndex)) {
            visited[pixelIndex] = 1;
            continue;
        }

        for (let index = spanStart; index <= spanEnd; index += 1) {
            visited[index] = 1;
            mask[index] = 255;
            if (y > 0 && !visited[index - width] && matches(index - width)) {
                stack.push(index - width);
            }
            if (y < height - 1 && !visited[index + width] && matches(index + width)) {
                stack.push(index + width);
            }
        }
    }

    return trimSelection(selection);
};

export const sampleSelectionAt = (selection, worldX, worldY) => {
    if (!selection?.mask) {
        return 0;
    }
    const x = Math.floor(worldX - selection.left);
    const y = Math.floor(worldY - selection.top);
    if (x < 0 || y < 0 || x >= selection.width || y >= selection.height) {
        return 0;
    }
    return selection.mask[y * selection.width + x];
};

export const combineSelections = (base, incoming, operation = 'replace') => {
    if (operation === 'replace') {
        return trimSelection(incoming);
    }
    if (!base) {
        return operation === 'add' ? trimSelection(incoming) : null;
    }
    if (!incoming) {
        return base;
    }

    if (operation === 'add') {
        const left = Math.min(base.left, incoming.left);
        const top = Math.min(base.top, incoming.top);
        const right = Math.max(base.left + base.width, incoming.left + incoming.width);
        const bottom = Math.max(base.top + base.height, incoming.top + incoming.height);
        const merged = allocSelection(left, top, right - left, bottom - top);
        merged.feather = base.feather;
        for (let y = 0; y < merged.height; y += 1) {
            const rowOffset = y * merged.width;
            const worldY = top + y;
            for (let x = 0; x < merged.width; x += 1) {
                const worldX = left + x;
                merged.mask[rowOffset + x] = Math.max(
                    sampleSelectionAt(base, worldX, worldY),
                    sampleSelectionAt(incoming, worldX, worldY)
                );
            }
        }
        return merged;
    }

    if (operation === 'subtract') {
        const result = allocSelection(base.left, base.top, base.width, base.height);
        result.feather = base.feather;
        for (let y = 0; y < base.height; y += 1) {
            const rowOffset = y * base.width;
            const worldY = base.top + y;
            for (let x = 0; x < base.width; x += 1) {
                const removed = sampleSelectionAt(incoming, base.left + x, worldY);
                result.mask[rowOffset + x] = Math.max(0, base.mask[rowOffset + x] - removed);
            }
        }
        return trimSelection(result);
    }

    return base;
};

export const invertSelection = (selection, frameBounds) => {
    if (!frameBounds) {
        return null;
    }
    const inverted = allocSelection(
        frameBounds.left,
        frameBounds.top,
        frameBounds.width,
        frameBounds.height
    );
    for (let y = 0; y < inverted.height; y += 1) {
        const rowOffset = y * inverted.width;
        const worldY = inverted.top + y;
        for (let x = 0; x < inverted.width; x += 1) {
            inverted.mask[rowOffset + x] = 255 - sampleSelectionAt(selection, inverted.left + x, worldY);
        }
    }
    return trimSelection(inverted);
};

const boxBlurPass = (source, target, width, height, radius, horizontal) => {
    const lineCount = horizontal ? height : width;
    const lineLength = horizontal ? width : height;
    const stride = horizontal ? 1 : width;
    const window = radius * 2 + 1;

    for (let line = 0; line < lineCount; line += 1) {
        const lineOffset = horizontal ? line * width : line;
        let sum = 0;
        for (let index = -radius; index <= radius; index += 1) {
            const clamped = Math.max(0, Math.min(lineLength - 1, index));
            sum += source[lineOffset + clamped * stride];
        }
        for (let index = 0; index < lineLength; index += 1) {
            target[lineOffset + index * stride] = sum / window;
            const outgoing = Math.max(0, index - radius);
            const incoming = Math.min(lineLength - 1, index + radius + 1);
            sum += source[lineOffset + incoming * stride] - source[lineOffset + outgoing * stride];
        }
    }
};

// Растушёвка: 3 итерации box blur ≈ гауссово размытие с sigma ≈ radius/2.
export const featherSelection = (selection, radius) => {
    if (!selection || !Number.isFinite(radius) || radius <= 0) {
        return selection;
    }

    const boxRadius = Math.max(1, Math.round(radius / 2));
    const pad = boxRadius * 3;
    const expanded = allocSelection(
        selection.left - pad,
        selection.top - pad,
        selection.width + pad * 2,
        selection.height + pad * 2
    );
    expanded.feather = (selection.feather || 0) + radius;

    let buffer = new Float32Array(expanded.width * expanded.height);
    let scratch = new Float32Array(expanded.width * expanded.height);
    for (let y = 0; y < selection.height; y += 1) {
        const sourceOffset = y * selection.width;
        const targetOffset = (y + pad) * expanded.width + pad;
        for (let x = 0; x < selection.width; x += 1) {
            buffer[targetOffset + x] = selection.mask[sourceOffset + x];
        }
    }

    for (let pass = 0; pass < 3; pass += 1) {
        boxBlurPass(buffer, scratch, expanded.width, expanded.height, boxRadius, true);
        boxBlurPass(scratch, buffer, expanded.width, expanded.height, boxRadius, false);
    }

    for (let index = 0; index < buffer.length; index += 1) {
        expanded.mask[index] = buffer[index];
    }
    return trimSelection(expanded);
};

// Локальная пиксельная маска выделения для слоя (в пикселях элемента слоя).
// layer: { left, top, scaleX, scaleY }, размеры берутся из elementWidth/Height.
export const sampleMaskForLayer = (selection, layer, elementWidth, elementHeight) => {
    if (!selection?.mask || elementWidth < 1 || elementHeight < 1) {
        return null;
    }

    const scaleX = layer.scaleX || 1;
    const scaleY = layer.scaleY || 1;
    const layerLeft = layer.left ?? 0;
    const layerTop = layer.top ?? 0;
    const mask = new Uint8ClampedArray(elementWidth * elementHeight);
    let hasCoverage = false;

    for (let y = 0; y < elementHeight; y += 1) {
        const worldY = layerTop + (y + 0.5) * scaleY;
        const rowOffset = y * elementWidth;
        for (let x = 0; x < elementWidth; x += 1) {
            const value = sampleSelectionAt(selection, layerLeft + (x + 0.5) * scaleX, worldY);
            if (value !== 0) {
                mask[rowOffset + x] = value;
                hasCoverage = true;
            }
        }
    }

    return hasCoverage ? mask : null;
};

const DIRECTION_VECTORS = [
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: -1 }
];

// Контур выделения: прямоугольные петли по границам пикселей (порог 128),
// в мировых координатах. Возвращает массив замкнутых петель.
export const traceSelectionOutline = (selection) => {
    if (!selection?.mask) {
        return [];
    }

    const { width, height, mask } = selection;
    const isInside = (x, y) => (
        x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] >= SELECTION_THRESHOLD
    );

    const vertexStride = width + 1;
    // Исходящие направленные рёбра по вершинам пиксельной сетки; интерьер
    // справа по ходу движения.
    const outgoingEdges = new Map();
    const addEdge = (fromX, fromY, direction) => {
        const key = fromY * vertexStride + fromX;
        const existing = outgoingEdges.get(key);
        const edge = { direction, used: false };
        if (existing) {
            existing.push(edge);
        } else {
            outgoingEdges.set(key, [edge]);
        }
    };

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (!isInside(x, y)) {
                continue;
            }
            if (!isInside(x, y - 1)) addEdge(x, y, 0);
            if (!isInside(x + 1, y)) addEdge(x + 1, y, 1);
            if (!isInside(x, y + 1)) addEdge(x + 1, y + 1, 2);
            if (!isInside(x - 1, y)) addEdge(x, y + 1, 3);
        }
    }

    const loops = [];

    outgoingEdges.forEach((edges, startKey) => {
        edges.forEach((startEdge) => {
            if (startEdge.used) {
                return;
            }

            const loop = [];
            let vertexKey = startKey;
            let edge = startEdge;

            while (!edge.used) {
                edge.used = true;
                const x = vertexKey % vertexStride;
                const y = Math.floor(vertexKey / vertexStride);
                const vector = DIRECTION_VECTORS[edge.direction];

                // Схлопываем коллинеарные отрезки.
                const previous = loop[loop.length - 1];
                if (!previous || previous.direction !== edge.direction) {
                    loop.push({ x, y, direction: edge.direction });
                }

                const nextKey = (y + vector.dy) * vertexStride + (x + vector.dx);
                const candidates = outgoingEdges.get(nextKey);
                if (!candidates) {
                    break;
                }

                // На вершинах с 4 рёбрами (диагональное касание) предпочитаем
                // поворот направо — петли не склеиваются.
                const preferenceOrder = [
                    (edge.direction + 1) % 4,
                    edge.direction,
                    (edge.direction + 3) % 4
                ];
                let nextEdge = null;
                for (const preferred of preferenceOrder) {
                    nextEdge = candidates.find((candidate) => !candidate.used && candidate.direction === preferred);
                    if (nextEdge) {
                        break;
                    }
                }
                if (!nextEdge) {
                    break;
                }
                vertexKey = nextKey;
                edge = nextEdge;
            }

            if (loop.length >= 4) {
                loops.push(loop.map((point) => ({
                    x: point.x + selection.left,
                    y: point.y + selection.top
                })));
            }
        });
    });

    return loops;
};

// Заполняет RGBA-буфер (white-on-black) маской выделения в границах bounds.
// Используется для конвертации в маску инпейнта и экспорт.
export const renderSelectionToRGBA = (selection, bounds, rgba) => {
    if (!selection?.mask || !rgba) {
        return;
    }
    for (let y = 0; y < bounds.height; y += 1) {
        const worldY = bounds.top + y;
        const rowOffset = y * bounds.width;
        for (let x = 0; x < bounds.width; x += 1) {
            const value = sampleSelectionAt(selection, bounds.left + x, worldY);
            const offset = (rowOffset + x) * 4;
            rgba[offset] = value;
            rgba[offset + 1] = value;
            rgba[offset + 2] = value;
            rgba[offset + 3] = 255;
        }
    }
};
