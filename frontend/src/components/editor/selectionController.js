import { fabric } from 'fabric';
import { TOOL_MODES, isSelectionToolMode } from './toolModes';
import {
    createSelectionFromEllipse,
    createSelectionFromPolygon,
    createSelectionFromRect,
    magicWandMask
} from './selectionEngine';

const DRAFT_STYLE = {
    fill: 'rgba(0, 212, 255, 0.05)',
    stroke: '#00d4ff',
    strokeWidth: 1,
    strokeUniform: true,
    strokeDashArray: [5, 4],
    selectable: false,
    evented: false,
    hasControls: false,
    hasBorders: false,
    objectCaching: false,
    excludeFromExport: true,
    editorRole: 'selection-overlay'
};

const rectFromPoints = (anchor, pointer) => ({
    left: Math.min(anchor.x, pointer.x),
    top: Math.min(anchor.y, pointer.y),
    width: Math.abs(pointer.x - anchor.x),
    height: Math.abs(pointer.y - anchor.y)
});

// Мышиная логика классических выделений: marquee (rect/ellipse), лассо,
// волшебная палочка. Модификаторы: Shift — добавить, Alt — вычесть.
export const setupSelectionToolHandling = ({
    canvas,
    brushModeRef,
    clampPointToFrame,
    getFrameBounds,
    renderFrameImageData,
    magicWandToleranceRef,
    applySelection
}) => {
    if (!canvas) {
        return () => {};
    }

    let isDragging = false;
    let anchor = null;
    let lassoPoints = null;
    let operation = 'replace';
    let draftObject = null;

    const removeDraft = () => {
        if (draftObject) {
            canvas.remove(draftObject);
            draftObject = null;
        }
    };

    const setDraft = (object) => {
        removeDraft();
        draftObject = object;
        canvas.add(object);
        object.bringToFront();
        canvas.requestRenderAll();
    };

    const handleMagicWandClick = (pointer) => {
        const frameBounds = getFrameBounds();
        const imageData = renderFrameImageData();
        if (!frameBounds || !imageData) {
            return;
        }

        const tolerance = Math.max(0, Math.min(255, Number(magicWandToleranceRef.current ?? 32)));
        const localSelection = magicWandMask(
            imageData,
            pointer.x - frameBounds.left,
            pointer.y - frameBounds.top,
            { tolerance }
        );

        if (localSelection) {
            localSelection.left += frameBounds.left;
            localSelection.top += frameBounds.top;
            applySelection(localSelection, operation);
        } else if (operation === 'replace') {
            applySelection(null, 'replace');
        }
    };

    const handleMouseDown = (event) => {
        const mode = brushModeRef.current;
        if (!isSelectionToolMode(mode) || event.e.button !== 0) {
            return;
        }
        const pointer = clampPointToFrame(canvas.getPointer(event.e));
        if (!pointer) {
            return;
        }

        event.e.preventDefault();
        event.e.stopPropagation();
        operation = event.e.shiftKey ? 'add' : (event.e.altKey ? 'subtract' : 'replace');

        if (mode === TOOL_MODES.MAGIC_WAND) {
            handleMagicWandClick(pointer);
            return;
        }

        isDragging = true;
        anchor = pointer;

        if (mode === TOOL_MODES.LASSO) {
            lassoPoints = [pointer];
            return;
        }

        if (mode === TOOL_MODES.MARQUEE_RECT) {
            setDraft(new fabric.Rect({
                ...DRAFT_STYLE,
                left: pointer.x,
                top: pointer.y,
                width: 1,
                height: 1
            }));
        } else {
            setDraft(new fabric.Ellipse({
                ...DRAFT_STYLE,
                left: pointer.x,
                top: pointer.y,
                rx: 0.5,
                ry: 0.5,
                originX: 'left',
                originY: 'top'
            }));
        }
    };

    const handleMouseMove = (event) => {
        const mode = brushModeRef.current;
        if (!isDragging || !isSelectionToolMode(mode)) {
            return;
        }
        const pointer = clampPointToFrame(canvas.getPointer(event.e));
        if (!pointer) {
            return;
        }

        if (mode === TOOL_MODES.LASSO) {
            lassoPoints.push(pointer);
            // Polyline пересоздаётся: обновление points у живого объекта не
            // пересчитывает pathOffset и драфт уезжает.
            setDraft(new fabric.Polyline(
                lassoPoints.map((point) => ({ x: point.x, y: point.y })),
                { ...DRAFT_STYLE, fill: 'rgba(0, 212, 255, 0.03)' }
            ));
            return;
        }

        const rect = rectFromPoints(anchor, pointer);
        if (!draftObject) {
            return;
        }
        if (mode === TOOL_MODES.MARQUEE_RECT) {
            draftObject.set({
                left: rect.left,
                top: rect.top,
                width: Math.max(1, rect.width),
                height: Math.max(1, rect.height)
            });
        } else {
            draftObject.set({
                left: rect.left,
                top: rect.top,
                rx: Math.max(0.5, rect.width / 2),
                ry: Math.max(0.5, rect.height / 2)
            });
        }
        draftObject.setCoords();
        canvas.requestRenderAll();
    };

    const handleMouseUp = (event) => {
        if (!isDragging) {
            return;
        }
        isDragging = false;
        const mode = brushModeRef.current;
        removeDraft();
        canvas.requestRenderAll();

        if (mode === TOOL_MODES.LASSO) {
            const points = lassoPoints || [];
            lassoPoints = null;
            if (points.length < 3) {
                if (operation === 'replace') {
                    applySelection(null, 'replace');
                }
                return;
            }
            applySelection(createSelectionFromPolygon(points), operation);
            return;
        }

        const pointer = clampPointToFrame(canvas.getPointer(event.e));
        const rect = rectFromPoints(anchor, pointer || anchor);
        if (rect.width < 2 && rect.height < 2) {
            // Клик без протяжки — снять выделение, как в Photoshop.
            if (operation === 'replace') {
                applySelection(null, 'replace');
            }
            return;
        }

        const selection = mode === TOOL_MODES.MARQUEE_RECT
            ? createSelectionFromRect(rect)
            : createSelectionFromEllipse(rect);
        applySelection(selection, operation);
    };

    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:move', handleMouseMove);
    canvas.on('mouse:up', handleMouseUp);

    return () => {
        removeDraft();
        canvas.off('mouse:down', handleMouseDown);
        canvas.off('mouse:move', handleMouseMove);
        canvas.off('mouse:up', handleMouseUp);
    };
};
