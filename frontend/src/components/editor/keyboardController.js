const isTextInputTarget = (target) => {
    if (!target || typeof target.tagName !== 'string') {
        return false;
    }

    const tagName = target.tagName.toUpperCase();
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable === true;
};

export const setupEditorKeyboardShortcuts = ({
    fabricCanvas,
    brushModeRef,
    performUndoRef,
    performDeleteActiveObjectRef,
    syncCanvasInteractionModeRef
}) => {
    if (!fabricCanvas) {
        return () => {};
    }

    const handleKeyDown = (event) => {
        if (isTextInputTarget(event.target)) {
            return;
        }

        if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ') {
            event.preventDefault();
            void performUndoRef.current?.();
            return;
        }

        if (event.code === 'Space' && !event.repeat && brushModeRef.current !== 'hand') {
            event.preventDefault();
            fabricCanvas.isSpacePanning = true;
            fabricCanvas.defaultCursor = 'grab';
            fabricCanvas.isDrawingMode = false;
            fabricCanvas.selection = false;
            fabricCanvas.forEachObject((object) => {
                object.evented = false;
            });
            return;
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            performDeleteActiveObjectRef.current?.();
        }
    };

    const handleKeyUp = (event) => {
        if (event.code !== 'Space' || !fabricCanvas.isSpacePanning) return;

        fabricCanvas.isSpacePanning = false;
        syncCanvasInteractionModeRef.current?.();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
    };
};
