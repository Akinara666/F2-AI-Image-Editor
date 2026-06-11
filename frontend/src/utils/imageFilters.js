// Чистые пиксельные операции над { data: Uint8ClampedArray, width, height }.
// Все функции мутируют data на месте и не трогают DOM — модуль тестируем
// под jsdom. Сознательно не используем fabric.Image.filters: они
// неразрушающие (рендер-тайм) и упираются в WebGL textureSize 2048.

const applyLutToRGB = (data, lut) => {
    for (let offset = 0; offset < data.length; offset += 4) {
        data[offset] = lut[data[offset]];
        data[offset + 1] = lut[data[offset + 1]];
        data[offset + 2] = lut[data[offset + 2]];
    }
};

export const applyBrightnessContrast = (image, { brightness = 0, contrast = 0 } = {}) => {
    const lut = new Uint8ClampedArray(256);
    const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    for (let value = 0; value < 256; value += 1) {
        lut[value] = contrastFactor * (value - 128) + 128 + brightness;
    }
    applyLutToRGB(image.data, lut);
};

export const applyInvert = (image) => {
    const { data } = image;
    for (let offset = 0; offset < data.length; offset += 4) {
        data[offset] = 255 - data[offset];
        data[offset + 1] = 255 - data[offset + 1];
        data[offset + 2] = 255 - data[offset + 2];
    }
};

export const applyLevels = (image, {
    inBlack = 0,
    inWhite = 255,
    gamma = 1,
    outBlack = 0,
    outWhite = 255
} = {}) => {
    const lut = new Uint8ClampedArray(256);
    const inputRange = Math.max(1, inWhite - inBlack);
    const safeGamma = Math.max(0.01, gamma);
    for (let value = 0; value < 256; value += 1) {
        let normalized = (value - inBlack) / inputRange;
        normalized = Math.max(0, Math.min(1, normalized));
        normalized = Math.pow(normalized, 1 / safeGamma);
        lut[value] = outBlack + normalized * (outWhite - outBlack);
    }
    applyLutToRGB(image.data, lut);
};

const clamp255 = (value) => Math.max(0, Math.min(255, Number(value) || 0));

// Монотонная кубическая интерполяция (Fritsch–Carlson) по контрольным
// точкам кривой → LUT-256. Гарантирует отсутствие выбросов между точками.
export const buildCurveLut = (rawPoints) => {
    const sorted = (Array.isArray(rawPoints) && rawPoints.length >= 2
        ? [...rawPoints]
        : [{ x: 0, y: 0 }, { x: 255, y: 255 }])
        .map((point) => ({ x: clamp255(point.x), y: clamp255(point.y) }))
        .sort((left, right) => left.x - right.x);

    const xs = [];
    const ys = [];
    sorted.forEach((point) => {
        if (xs.length === 0 || point.x > xs[xs.length - 1]) {
            xs.push(point.x);
            ys.push(point.y);
        }
    });

    const lut = new Uint8ClampedArray(256);
    if (xs.length === 1) {
        lut.fill(ys[0]);
        return lut;
    }

    const segmentCount = xs.length - 1;
    const dx = new Array(segmentCount);
    const slopes = new Array(segmentCount);
    for (let index = 0; index < segmentCount; index += 1) {
        dx[index] = xs[index + 1] - xs[index];
        slopes[index] = (ys[index + 1] - ys[index]) / dx[index];
    }

    const tangents = new Array(xs.length);
    tangents[0] = slopes[0];
    tangents[xs.length - 1] = slopes[segmentCount - 1];
    for (let index = 1; index < xs.length - 1; index += 1) {
        tangents[index] = slopes[index - 1] * slopes[index] <= 0
            ? 0
            : (slopes[index - 1] + slopes[index]) / 2;
    }
    for (let index = 0; index < segmentCount; index += 1) {
        if (slopes[index] === 0) {
            tangents[index] = 0;
            tangents[index + 1] = 0;
            continue;
        }
        const alpha = tangents[index] / slopes[index];
        const beta = tangents[index + 1] / slopes[index];
        const magnitude = alpha * alpha + beta * beta;
        if (magnitude > 9) {
            const scale = 3 / Math.sqrt(magnitude);
            tangents[index] = scale * alpha * slopes[index];
            tangents[index + 1] = scale * beta * slopes[index];
        }
    }

    let segment = 0;
    for (let x = 0; x < 256; x += 1) {
        if (x <= xs[0]) {
            lut[x] = ys[0];
            continue;
        }
        if (x >= xs[xs.length - 1]) {
            lut[x] = ys[ys.length - 1];
            continue;
        }
        while (x > xs[segment + 1]) {
            segment += 1;
        }
        const t = (x - xs[segment]) / dx[segment];
        const t2 = t * t;
        const t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1;
        const h10 = t3 - 2 * t2 + t;
        const h01 = -2 * t3 + 3 * t2;
        const h11 = t3 - t2;
        lut[x] = h00 * ys[segment]
            + h10 * dx[segment] * tangents[segment]
            + h01 * ys[segment + 1]
            + h11 * dx[segment] * tangents[segment + 1];
    }
    return lut;
};

export const applyCurves = (image, { points } = {}) => {
    applyLutToRGB(image.data, buildCurveLut(points));
};

const rgbToHsl = (r, g, b) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    if (max === min) {
        return [0, 0, lightness];
    }
    const delta = max - min;
    const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    let hue;
    if (max === r) {
        hue = (g - b) / delta + (g < b ? 6 : 0);
    } else if (max === g) {
        hue = (b - r) / delta + 2;
    } else {
        hue = (r - g) / delta + 4;
    }
    return [hue / 6, saturation, lightness];
};

const hueToChannel = (p, q, t) => {
    let h = t;
    if (h < 0) h += 1;
    if (h > 1) h -= 1;
    if (h < 1 / 6) return p + (q - p) * 6 * h;
    if (h < 1 / 2) return q;
    if (h < 2 / 3) return p + (q - p) * (2 / 3 - h) * 6;
    return p;
};

const hslToRgb = (h, s, l) => {
    if (s === 0) {
        return [l, l, l];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
        hueToChannel(p, q, h + 1 / 3),
        hueToChannel(p, q, h),
        hueToChannel(p, q, h - 1 / 3)
    ];
};

export const applyHueSaturation = (image, { hue = 0, saturation = 0, lightness = 0 } = {}) => {
    const { data } = image;
    const hueShift = hue / 360;
    const saturationFactor = saturation / 100;
    const lightnessShift = lightness / 100;

    for (let offset = 0; offset < data.length; offset += 4) {
        let [h, s, l] = rgbToHsl(data[offset] / 255, data[offset + 1] / 255, data[offset + 2] / 255);
        h = (h + hueShift + 1) % 1;
        s = Math.max(0, Math.min(1, saturationFactor >= 0
            ? s + (1 - s) * saturationFactor
            : s * (1 + saturationFactor)));
        l = Math.max(0, Math.min(1, lightnessShift >= 0
            ? l + (1 - l) * lightnessShift
            : l * (1 + lightnessShift)));
        const [r, g, b] = hslToRgb(h, s, l);
        data[offset] = r * 255;
        data[offset + 1] = g * 255;
        data[offset + 2] = b * 255;
    }
};

const boxBlurPlane = (source, target, width, height, radius, horizontal) => {
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

// Гауссово размытие ≈ 3 итерации box blur. Каналы премультиплицируются
// альфой, иначе прозрачные области дают тёмные ореолы.
export const applyGaussianBlur = (image, { radius = 5 } = {}) => {
    const safeRadius = Math.max(0, Number(radius) || 0);
    if (safeRadius < 0.5) {
        return;
    }

    const { data, width, height } = image;
    const pixelCount = width * height;
    const boxRadius = Math.max(1, Math.round(safeRadius / 2));

    const planes = [
        new Float32Array(pixelCount),
        new Float32Array(pixelCount),
        new Float32Array(pixelCount),
        new Float32Array(pixelCount)
    ];
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const offset = pixel * 4;
        const alpha = data[offset + 3] / 255;
        planes[0][pixel] = data[offset] * alpha;
        planes[1][pixel] = data[offset + 1] * alpha;
        planes[2][pixel] = data[offset + 2] * alpha;
        planes[3][pixel] = data[offset + 3];
    }

    const scratch = new Float32Array(pixelCount);
    planes.forEach((plane) => {
        for (let pass = 0; pass < 3; pass += 1) {
            boxBlurPlane(plane, scratch, width, height, boxRadius, true);
            boxBlurPlane(scratch, plane, width, height, boxRadius, false);
        }
    });

    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const offset = pixel * 4;
        const alpha = planes[3][pixel];
        if (alpha < 0.5) {
            data[offset + 3] = 0;
            continue;
        }
        const unpremultiply = 255 / alpha;
        data[offset] = planes[0][pixel] * unpremultiply;
        data[offset + 1] = planes[1][pixel] * unpremultiply;
        data[offset + 2] = planes[2][pixel] * unpremultiply;
        data[offset + 3] = alpha;
    }
};

// Unsharp mask: orig + amount · (orig − blurred), с порогом по разнице.
export const applyUnsharpMask = (image, { amount = 80, radius = 2, threshold = 0 } = {}) => {
    const safeAmount = Math.max(0, Number(amount) || 0) / 100;
    if (safeAmount === 0) {
        return;
    }

    const blurred = {
        data: new Uint8ClampedArray(image.data),
        width: image.width,
        height: image.height
    };
    applyGaussianBlur(blurred, { radius: Math.max(1, radius) });

    const { data } = image;
    for (let offset = 0; offset < data.length; offset += 4) {
        for (let channel = 0; channel < 3; channel += 1) {
            const difference = data[offset + channel] - blurred.data[offset + channel];
            if (Math.abs(difference) > threshold) {
                data[offset + channel] = data[offset + channel] + difference * safeAmount;
            }
        }
    }
};

export const applyNoise = (image, { amount = 10, monochrome = true, random = Math.random } = {}) => {
    const strength = Math.max(0, Number(amount) || 0) * 2.55;
    if (strength === 0) {
        return;
    }

    const { data } = image;
    for (let offset = 0; offset < data.length; offset += 4) {
        if (data[offset + 3] === 0) {
            continue;
        }
        if (monochrome) {
            const delta = (random() * 2 - 1) * strength;
            data[offset] = data[offset] + delta;
            data[offset + 1] = data[offset + 1] + delta;
            data[offset + 2] = data[offset + 2] + delta;
        } else {
            data[offset] = data[offset] + (random() * 2 - 1) * strength;
            data[offset + 1] = data[offset + 1] + (random() * 2 - 1) * strength;
            data[offset + 2] = data[offset + 2] + (random() * 2 - 1) * strength;
        }
    }
};

export const ADJUSTMENT_TYPES = {
    BRIGHTNESS_CONTRAST: 'brightness_contrast',
    LEVELS: 'levels',
    CURVES: 'curves',
    HUE_SATURATION: 'hue_saturation',
    INVERT: 'invert',
    GAUSSIAN_BLUR: 'gaussian_blur',
    SHARPEN: 'sharpen',
    NOISE: 'noise'
};

// Пространственные фильтры считаются на даунскейле при предпросмотре
// больших слоёв; LUT/попиксельные тянут полный кадр.
export const SPATIAL_ADJUSTMENT_TYPES = [
    ADJUSTMENT_TYPES.GAUSSIAN_BLUR,
    ADJUSTMENT_TYPES.SHARPEN
];

export const applyAdjustment = (image, type, params = {}) => {
    switch (type) {
        case ADJUSTMENT_TYPES.BRIGHTNESS_CONTRAST:
            applyBrightnessContrast(image, params);
            break;
        case ADJUSTMENT_TYPES.LEVELS:
            applyLevels(image, params);
            break;
        case ADJUSTMENT_TYPES.CURVES:
            applyCurves(image, params);
            break;
        case ADJUSTMENT_TYPES.HUE_SATURATION:
            applyHueSaturation(image, params);
            break;
        case ADJUSTMENT_TYPES.INVERT:
            applyInvert(image);
            break;
        case ADJUSTMENT_TYPES.GAUSSIAN_BLUR:
            applyGaussianBlur(image, params);
            break;
        case ADJUSTMENT_TYPES.SHARPEN:
            applyUnsharpMask(image, params);
            break;
        case ADJUSTMENT_TYPES.NOISE:
            applyNoise(image, params);
            break;
        default:
            throw new Error(`Unknown adjustment type: ${type}`);
    }
};

export const buildLuminanceHistogram = (image, stride = 4) => {
    const histogram = new Uint32Array(256);
    const { data } = image;
    const step = Math.max(1, Math.round(stride)) * 4;
    for (let offset = 0; offset < data.length; offset += step) {
        if (data[offset + 3] === 0) {
            continue;
        }
        const luminance = Math.round(
            0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]
        );
        histogram[Math.max(0, Math.min(255, luminance))] += 1;
    }
    return histogram;
};
