import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupEditorKeyboardShortcuts } from './keyboardController';

const buildRefs = (brushMode = 'none') => ({
    fabricCanvas: { isSpacePanning: false, forEachObject: vi.fn() },
    brushModeRef: { current: brushMode },
    setBrushModeRef: { current: vi.fn() },
    copyQuickSelectionRef: { current: vi.fn() },
    pasteQuickSelectionRef: { current: vi.fn() },
    performUndoRef: { current: vi.fn() },
    performDeleteActiveObjectRef: { current: vi.fn() },
    syncCanvasInteractionModeRef: { current: vi.fn() },
    deselectSelectionRef: { current: vi.fn() },
    applyCropActionRef: { current: vi.fn() },
    cancelCropActionRef: { current: vi.fn() }
});

const dispatchKey = (init) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }));
};

describe('editor keyboard shortcuts', () => {
    let cleanup = null;

    afterEach(() => {
        cleanup?.();
        cleanup = null;
    });

    it('буквенные клавиши переключают инструменты', () => {
        const refs = buildRefs();
        cleanup = setupEditorKeyboardShortcuts(refs);

        dispatchKey({ code: 'KeyT' });
        expect(refs.setBrushModeRef.current).toHaveBeenCalledWith('text');

        dispatchKey({ code: 'KeyL' });
        expect(refs.setBrushModeRef.current).toHaveBeenCalledWith('lasso');

        dispatchKey({ code: 'KeyV' });
        expect(refs.setBrushModeRef.current).toHaveBeenCalledWith('none');
    });

    it('M циклически переключает прямоугольное и эллиптическое выделение', () => {
        const refs = buildRefs('marquee_rect');
        cleanup = setupEditorKeyboardShortcuts(refs);

        dispatchKey({ code: 'KeyM' });
        expect(refs.setBrushModeRef.current).toHaveBeenCalledWith('marquee_ellipse');

        refs.brushModeRef.current = 'marquee_ellipse';
        dispatchKey({ code: 'KeyM' });
        expect(refs.setBrushModeRef.current).toHaveBeenLastCalledWith('marquee_rect');
    });

    it('шорткаты не срабатывают с модификаторами', () => {
        const refs = buildRefs();
        cleanup = setupEditorKeyboardShortcuts(refs);

        dispatchKey({ code: 'KeyT', ctrlKey: true });
        expect(refs.setBrushModeRef.current).not.toHaveBeenCalled();
    });

    it('Ctrl+D снимает выделение', () => {
        const refs = buildRefs();
        cleanup = setupEditorKeyboardShortcuts(refs);

        dispatchKey({ code: 'KeyD', ctrlKey: true });
        expect(refs.deselectSelectionRef.current).toHaveBeenCalled();
    });

    it('Enter/Escape управляют кадрированием только в режиме crop', () => {
        const refs = buildRefs('crop');
        cleanup = setupEditorKeyboardShortcuts(refs);

        dispatchKey({ key: 'Enter' });
        expect(refs.applyCropActionRef.current).toHaveBeenCalled();

        dispatchKey({ key: 'Escape' });
        expect(refs.cancelCropActionRef.current).toHaveBeenCalled();

        refs.brushModeRef.current = 'none';
        dispatchKey({ key: 'Enter' });
        expect(refs.applyCropActionRef.current).toHaveBeenCalledTimes(1);
    });

    it('cleanup снимает обработчики', () => {
        const refs = buildRefs();
        cleanup = setupEditorKeyboardShortcuts(refs);
        cleanup();
        cleanup = null;

        dispatchKey({ code: 'KeyT' });
        expect(refs.setBrushModeRef.current).not.toHaveBeenCalled();
    });
});
