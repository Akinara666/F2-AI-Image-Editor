// Чистая арифметика для outpaint-расширения холста. UI вызывает resizeCanvas
// редактора с этими размерами/якорем; растущие прозрачные поля бэкенд ловит как
// зону дорисовки. Размеры кратны 8 (DIMENSION_MULTIPLE на бэкенде).
export const DIMENSION_MULTIPLE = 8;

export const snapDim = (value) => Math.max(
    DIMENSION_MULTIPLE,
    Math.round(value / DIMENSION_MULTIPLE) * DIMENSION_MULTIPLE
);

// Якорь противоположен направлению роста: тянем вправо — контент якорим слева.
export const EXPAND_DIRECTIONS = {
    left: { anchorX: 1, anchorY: 0.5, axis: 'w', label: 'Влево' },
    right: { anchorX: 0, anchorY: 0.5, axis: 'w', label: 'Вправо' },
    up: { anchorX: 0.5, anchorY: 1, axis: 'h', label: 'Вверх' },
    down: { anchorX: 0.5, anchorY: 0, axis: 'h', label: 'Вниз' },
    all: { anchorX: 0.5, anchorY: 0.5, axis: 'wh', label: 'Все стороны' }
};

// Новый размер холста при расширении в направлении на долю fraction.
export const computeExpand = (size, direction, fraction = 0.25) => {
    const dir = EXPAND_DIRECTIONS[direction];
    if (!dir || !size || !(size.width >= 1) || !(size.height >= 1)) {
        return null;
    }
    const stepW = snapDim(Math.max(64, size.width * fraction));
    const stepH = snapDim(Math.max(64, size.height * fraction));

    let width = size.width;
    let height = size.height;
    if (dir.axis === 'w') {
        width = snapDim(size.width + stepW);
    } else if (dir.axis === 'h') {
        height = snapDim(size.height + stepH);
    } else {
        width = snapDim(size.width + stepW * 2);
        height = snapDim(size.height + stepH * 2);
    }
    return { width, height, anchorX: dir.anchorX, anchorY: dir.anchorY };
};

// Дорастить холст до соотношения ratioW:ratioH (только наружу, центр-якорь).
export const computeAspect = (size, ratioW, ratioH) => {
    if (!size || !(size.width >= 1) || !(size.height >= 1) || !(ratioW > 0) || !(ratioH > 0)) {
        return null;
    }
    const target = ratioW / ratioH;
    let width = size.width;
    let height = size.height;
    const current = width / height;
    if (current < target) {
        width = snapDim(height * target);
    } else if (current > target) {
        height = snapDim(width / target);
    }
    width = Math.max(width, size.width);
    height = Math.max(height, size.height);
    return { width, height, anchorX: 0.5, anchorY: 0.5 };
};

export const ASPECT_PRESETS = [
    { id: '1-1', label: '1:1', w: 1, h: 1 },
    { id: '4-3', label: '4:3', w: 4, h: 3 },
    { id: '3-2', label: '3:2', w: 3, h: 2 },
    { id: '16-9', label: '16:9', w: 16, h: 9 }
];
