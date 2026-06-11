export const TOOL_MODES = {
    CURSOR: 'none',
    HAND: 'hand',
    SKETCH: 'sketch',
    MASK: 'mask',
    ERASER: 'eraser',
    QUICK_SELECT: 'quick_select',
    SPOT_HEAL: 'spot_heal',
    CLONE_STAMP: 'clone_stamp',
    MARQUEE_RECT: 'marquee_rect',
    MARQUEE_ELLIPSE: 'marquee_ellipse',
    LASSO: 'lasso',
    MAGIC_WAND: 'magic_wand',
    TEXT: 'text',
    SHAPE: 'shape',
    FILL: 'fill',
    GRADIENT: 'gradient',
    EYEDROPPER: 'eyedropper',
    CROP: 'crop'
};

// Режимы, в которых Fabric рисует PencilBrush. Белый список: любой новый
// инструмент по умолчанию НЕ становится карандашом.
export const DRAWING_TOOL_MODES = [
    TOOL_MODES.SKETCH,
    TOOL_MODES.MASK,
    TOOL_MODES.ERASER
];

export const SELECTION_TOOL_MODES = [
    TOOL_MODES.MARQUEE_RECT,
    TOOL_MODES.MARQUEE_ELLIPSE,
    TOOL_MODES.LASSO,
    TOOL_MODES.MAGIC_WAND
];

// Режимы, где Alt — модификатор инструмента (источник штампа, вычитание
// выделения, фоновый цвет пипетки), а не панорамирование холста.
export const ALT_MODIFIER_TOOL_MODES = [
    TOOL_MODES.CLONE_STAMP,
    TOOL_MODES.EYEDROPPER,
    ...SELECTION_TOOL_MODES
];

const CROSSHAIR_TOOL_MODES = [
    TOOL_MODES.SPOT_HEAL,
    TOOL_MODES.CLONE_STAMP,
    TOOL_MODES.QUICK_SELECT,
    TOOL_MODES.FILL,
    TOOL_MODES.GRADIENT,
    TOOL_MODES.EYEDROPPER,
    TOOL_MODES.CROP,
    ...SELECTION_TOOL_MODES
];

export const isDrawingToolMode = (mode) => DRAWING_TOOL_MODES.includes(mode);

export const isSelectionToolMode = (mode) => SELECTION_TOOL_MODES.includes(mode);

export const isAltModifierToolMode = (mode) => ALT_MODIFIER_TOOL_MODES.includes(mode);

export const getCursorForToolMode = (mode) => {
    if (mode === TOOL_MODES.HAND) {
        return 'grab';
    }
    if (mode === TOOL_MODES.TEXT) {
        return 'text';
    }
    if (CROSSHAIR_TOOL_MODES.includes(mode)) {
        return 'crosshair';
    }
    return 'default';
};

// Горячие клавиши инструментов (event.code → режим). Массив — циклический
// переключатель (M: rect↔ellipse, G: заливка↔градиент, как в Photoshop).
export const TOOL_SHORTCUT_BINDINGS = {
    KeyV: TOOL_MODES.CURSOR,
    KeyH: TOOL_MODES.HAND,
    KeyM: [TOOL_MODES.MARQUEE_RECT, TOOL_MODES.MARQUEE_ELLIPSE],
    KeyL: TOOL_MODES.LASSO,
    KeyA: TOOL_MODES.MAGIC_WAND,
    KeyW: TOOL_MODES.QUICK_SELECT,
    KeyB: TOOL_MODES.SKETCH,
    KeyT: TOOL_MODES.TEXT,
    KeyU: TOOL_MODES.SHAPE,
    KeyG: [TOOL_MODES.FILL, TOOL_MODES.GRADIENT],
    KeyI: TOOL_MODES.EYEDROPPER,
    KeyE: TOOL_MODES.ERASER,
    KeyS: TOOL_MODES.CLONE_STAMP,
    KeyJ: TOOL_MODES.SPOT_HEAL,
    KeyC: TOOL_MODES.CROP
};

export const TOOL_GROUPS = [
    {
        id: 'navigation',
        label: 'Навигация',
        tools: [
            { id: TOOL_MODES.CURSOR, label: 'Курсор', title: 'Курсор (V)', color: 'var(--primary)', shortcut: 'V' },
            { id: TOOL_MODES.HAND, label: 'Рука', title: 'Рука (H)', color: 'var(--accent)', shortcut: 'H' }
        ]
    },
    {
        id: 'selection',
        label: 'Выделение',
        tools: [
            { id: TOOL_MODES.MARQUEE_RECT, label: 'Прямоуг.', title: 'Прямоугольное выделение (M)', color: 'var(--primary)', shortcut: 'M' },
            { id: TOOL_MODES.MARQUEE_ELLIPSE, label: 'Эллипс', title: 'Эллиптическое выделение (M)', color: 'var(--primary)', shortcut: 'M' },
            { id: TOOL_MODES.LASSO, label: 'Лассо', title: 'Лассо (L)', color: 'var(--primary)', shortcut: 'L' },
            { id: TOOL_MODES.MAGIC_WAND, label: 'Палочка', title: 'Волшебная палочка (A)', color: 'var(--primary)', shortcut: 'A' },
            { id: TOOL_MODES.QUICK_SELECT, label: 'Быстрое', title: 'Быстрое выделение (W)', color: 'var(--primary)', shortcut: 'W' }
        ]
    },
    {
        id: 'drawing',
        label: 'Рисование',
        tools: [
            { id: TOOL_MODES.SKETCH, label: 'Скетч', title: 'Кисть-скетч (B)', color: 'var(--primary)', shortcut: 'B' },
            { id: TOOL_MODES.TEXT, label: 'Текст', title: 'Текст (T)', color: 'var(--accent)', shortcut: 'T' },
            { id: TOOL_MODES.SHAPE, label: 'Фигура', title: 'Фигуры: прямоугольник/эллипс/линия (U)', color: 'var(--accent)', shortcut: 'U' },
            { id: TOOL_MODES.FILL, label: 'Заливка', title: 'Заливка (G)', color: 'var(--accent)', shortcut: 'G' },
            { id: TOOL_MODES.GRADIENT, label: 'Градиент', title: 'Градиент (G)', color: 'var(--accent)', shortcut: 'G' },
            { id: TOOL_MODES.EYEDROPPER, label: 'Пипетка', title: 'Пипетка (I)', color: 'var(--accent)', shortcut: 'I' },
            { id: TOOL_MODES.ERASER, label: 'Ластик', title: 'Ластик (E)', color: 'var(--warning)', shortcut: 'E' }
        ]
    },
    {
        id: 'retouch',
        label: 'Ретушь',
        tools: [
            { id: TOOL_MODES.MASK, label: 'Маска', title: 'Маска инпейнта', color: 'var(--danger)', shortcut: null },
            { id: TOOL_MODES.SPOT_HEAL, label: 'Точечная', title: 'Точечная восстановительная кисть (J)', color: 'var(--success)', shortcut: 'J' },
            { id: TOOL_MODES.CLONE_STAMP, label: 'Штамп', title: 'Штамп (S)', color: 'var(--accent)', shortcut: 'S' }
        ]
    },
    {
        id: 'crop',
        label: 'Кадрирование',
        tools: [
            { id: TOOL_MODES.CROP, label: 'Кадр', title: 'Кадрирование (C)', color: 'var(--warning)', shortcut: 'C' }
        ]
    }
];
