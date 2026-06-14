// Явные режимы генерации для пользователя. Заменяют backend-«auto»-угадывание:
// пользователь сам выбирает намерение, а UI транслирует его в режим бэкенда и
// решает, отправлять ли маску.
export const GENERATION_MODES = {
    WHOLE: 'whole',
    INPAINT: 'inpaint',
    OUTPAINT: 'outpaint'
};

const GENERATION_MODE_IDS = new Set(Object.values(GENERATION_MODES));

export const isGenerationMode = (value) => GENERATION_MODE_IDS.has(value);

export const GENERATION_MODE_OPTIONS = [
    {
        id: GENERATION_MODES.WHOLE,
        label: 'Вся картинка',
        hint: 'Перерисует всё изображение по промпту (img2img). Маска игнорируется.'
    },
    {
        id: GENERATION_MODES.INPAINT,
        label: 'Inpaint',
        hint: 'Перерисует только закрашенную маской область, остальное останется как есть.'
    },
    {
        id: GENERATION_MODES.OUTPAINT,
        label: 'Outpaint',
        hint: 'Дорисует продолжение в прозрачных зонах кадра (расширение сцены).'
    }
];

// Пресеты-намерения: один клик выставляет силу правки, размытие и расширение
// маски под типовую задачу, чтобы не крутить числа вручную.
export const INTENT_PRESETS = {
    [GENERATION_MODES.WHOLE]: [
        { id: 'tweak', label: 'Слегка изменить', params: { denoising_strength: 0.35 } },
        { id: 'rework', label: 'Сильно переработать', params: { denoising_strength: 0.7 } }
    ],
    [GENERATION_MODES.INPAINT]: [
        { id: 'replace', label: 'Заменить объект', params: { denoising_strength: 0.7, mask_blur: 8, mask_padding: 32 } },
        { id: 'remove', label: 'Удалить объект', params: { denoising_strength: 0.92, mask_blur: 12, mask_padding: 40 } },
        { id: 'detail', label: 'Добавить деталь', params: { denoising_strength: 0.4, mask_blur: 6, mask_padding: 16 } }
    ],
    [GENERATION_MODES.OUTPAINT]: [
        { id: 'expand', label: 'Расширить сцену', params: { denoising_strength: 0.98, mask_blur: 16, mask_padding: 48 } }
    ]
};

// UI-режим -> режим бэкенда + нужно ли вообще слать маску. В режиме «вся
// картинка» маска не отправляется, даже если нарисована, — это и есть смысл
// явного выбора (никаких сюрпризов «почему перерисовало только пятно»).
export const resolveBackendMode = (uiMode) => {
    switch (uiMode) {
        case GENERATION_MODES.INPAINT:
            return { mode: 'inpainting', sendMask: true };
        case GENERATION_MODES.OUTPAINT:
            // Маску-зону задаёт прозрачность кадра; ручная маска опциональна.
            return { mode: 'inpainting', sendMask: true };
        case GENERATION_MODES.WHOLE:
        default:
            return { mode: 'auto', sendMask: false };
    }
};
